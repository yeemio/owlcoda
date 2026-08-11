import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { validateReplayableEvidence } from "./acceptance-evidence.mjs";
import {
  resolveProfileImpactProjection,
} from "./profile-impact.mjs";
import {
  assertAllowedKeys,
  isRecord,
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  resolveExistingArtifact,
  safeIdentifier,
  sha256,
  writeJsonAtomically,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";
import { receiptSha256, validateReceiptLineage } from "./receipt-lineage.mjs";
import { verifySnapshotEvidence, verifySnapshotSourceBinding } from "./snapshot.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import { verifySourceCandidateV2 } from "./source-candidate.mjs";
import {
  validateVerificationContext,
  verificationContextFingerprint,
} from "./verification-context.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";
import { assertExecutionUnclosed } from "./lease-lifecycle.mjs";

const REQUEST_KEYS = [
  "schemaVersion",
  "receiptId",
  "deliveryPacketPath",
  "sourceCandidatePath",
  "verificationContext",
  "snapshotPaths",
  "supersedesReceiptSha256",
  "reusedCommandReceipts",
  "repairControl",
];
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RISK_MODES = new Set(["lightweight", "standard", "full"]);
const RISK_CATEGORIES = new Set([
  "backtest",
  "funds",
  "migration",
  "production",
  "release",
]);
const REPAIRABLE_INVALID_REASONS = new Set([
  "receipt_source_mismatch",
  "source_mutated_during_verification",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Finalize artifact is not canonical JSON.");
  }
  return encoded;
}

function writeFinalizeArtifactExact(filePath, value, label) {
  if (!existsSync(filePath)) {
    writeJsonExclusiveAtomically(filePath, value);
    return;
  }
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Existing finalize artifact differs: ${label}.`);
  }
  const existing = readJson(realpathSync(filePath));
  if (canonicalJson(existing) !== canonicalJson(value)) {
    throw new Error(`Existing finalize artifact differs: ${label}.`);
  }
}

function writeFinalizeLineageExact(
  filePath,
  { expectedEntries, nextEntries },
) {
  const validation = validateReceiptLineage(nextEntries);
  if (!validation.valid || !validation.active) {
    throw new Error("Replacement receipt lineage is invalid.");
  }
  if (!existsSync(filePath)) {
    if (expectedEntries.length !== 0 || nextEntries.length !== 1) {
      throw new Error("Receipt lineage changed before activation.");
    }
    writeJsonExclusiveAtomically(filePath, nextEntries);
    return;
  }
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Receipt lineage changed before activation.");
  }
  const document = readJson(realpathSync(filePath));
  const currentEntries = Array.isArray(document)
    ? document
    : document?.receipts;
  if (!Array.isArray(currentEntries)) {
    throw new Error("Receipt lineage changed before activation.");
  }
  if (canonicalJson(currentEntries) === canonicalJson(nextEntries)) {
    return;
  }
  if (
    canonicalJson(currentEntries) !== canonicalJson(expectedEntries)
    || nextEntries.length !== expectedEntries.length + 1
    || canonicalJson(nextEntries.slice(0, -1))
      !== canonicalJson(expectedEntries)
  ) {
    throw new Error("Receipt lineage changed before activation.");
  }
  writeJsonAtomically(filePath, nextEntries);
}

function changedPaths(packet) {
  const files = packet?.changedFiles?.files ?? packet?.changedFiles?.wholeFileSha256;
  if (!isRecord(files) || Object.keys(files).length === 0) {
    throw new Error("Delivery packet does not declare changed files.");
  }
  return Object.keys(files).sort();
}

function candidateChangedPaths(candidate) {
  return [...new Set(candidate.sourceManifest.entries.flatMap((entry) => (
    entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]
  )))].sort();
}

function candidatePresentFiles(candidate) {
  return Object.fromEntries(candidate.sourceManifest.entries
    .filter((entry) => entry.operation !== "deleted")
    .map((entry) => [entry.path, entry.sha256])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function loadFinalizeSource({ workspaceRoot, runId, request }) {
  if (request.deliveryPacketPath !== undefined) {
    const sourcePath = resolveExistingArtifact(
      workspaceRoot,
      request.deliveryPacketPath,
      "deliveryPacketPath",
    );
    const source = readJson(sourcePath);
    if (source.runId !== runId) {
      throw new Error("Delivery packet runId does not match the execution.");
    }
    const sourceGate = verifyDeliveryPacket({ workspaceRoot, packet: source });
    return {
      kind: "delivery_packet_v1",
      sourcePath,
      source,
      sourceGate,
      changedPaths: changedPaths(source),
      expectedFiles:
        source.changedFiles?.files ?? source.changedFiles?.wholeFileSha256,
      verifyCurrent: () => verifyDeliveryPacket({
        workspaceRoot,
        packet: source,
      }),
    };
  }

  const sourcePath = resolveExistingArtifact(
    workspaceRoot,
    request.sourceCandidatePath,
    "sourceCandidatePath",
  );
  const source = readJson(sourcePath);
  if (source.runId !== runId) {
    throw new Error("Source candidate runId does not match the execution.");
  }
  const candidateGate = verifySourceCandidateV2({
    workspaceRoot,
    candidatePath: request.sourceCandidatePath,
  });
  const fingerprint = source.sourceFingerprint?.sha256;
  const sourceGate = {
    status: candidateGate.status,
    exitCode: candidateGate.exitCode,
    declaredFingerprint: fingerprint,
    recomputedFingerprint: candidateGate.status === "valid"
      ? candidateGate.sourceFingerprint
      : fingerprint,
    issues: candidateGate.issueCodes ?? [],
  };
  return {
    kind: "source_candidate_v2",
    sourcePath,
    source,
    sourceGate,
    changedPaths: candidateChangedPaths(source),
    expectedFiles: candidatePresentFiles(source),
    verifyCurrent: () => {
      const gate = verifySourceCandidateV2({
        workspaceRoot,
        candidatePath: request.sourceCandidatePath,
      });
      return {
        status: gate.status,
        exitCode: gate.exitCode,
        declaredFingerprint: fingerprint,
        recomputedFingerprint: gate.status === "valid"
          ? gate.sourceFingerprint
          : fingerprint,
        issues: gate.issueCodes ?? [],
      };
    },
  };
}

function validateRequest(request) {
  assertAllowedKeys(request, "Finalize request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitFinalizeRequestV1") {
    throw new Error("Unsupported finalize request schemaVersion.");
  }
  safeIdentifier(request.receiptId, "receiptId");
  const hasDeliveryPacket = typeof request.deliveryPacketPath === "string"
    && request.deliveryPacketPath.length > 0;
  const hasSourceCandidate = typeof request.sourceCandidatePath === "string"
    && request.sourceCandidatePath.length > 0;
  if (hasDeliveryPacket === hasSourceCandidate) {
    throw new Error("Finalize requires exactly one deliveryPacketPath or sourceCandidatePath.");
  }
  if (!Array.isArray(request.snapshotPaths)
    || request.snapshotPaths.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Finalize request requires snapshotPaths.");
  }
  if (request.supersedesReceiptSha256 !== undefined
    && (typeof request.supersedesReceiptSha256 !== "string"
      || !SHA256_PATTERN.test(request.supersedesReceiptSha256))) {
    throw new Error("Finalize supersedesReceiptSha256 must be a lowercase SHA-256.");
  }
  if (request.reusedCommandReceipts !== undefined
    && !Array.isArray(request.reusedCommandReceipts)) {
    throw new Error("Finalize reusedCommandReceipts must be an array.");
  }
  if (request.snapshotPaths.length === 0
    && (request.reusedCommandReceipts?.length ?? 0) === 0) {
    throw new Error("Finalize requires snapshotPaths or reusedCommandReceipts.");
  }
  if (request.reusedCommandReceipts !== undefined
    && request.supersedesReceiptSha256 === undefined) {
    throw new Error("Reused command receipts require supersedesReceiptSha256.");
  }
  if (request.supersedesReceiptSha256 !== undefined && request.repairControl === undefined) {
    throw new Error("Repair finalize requires repairControl.");
  }
  if (request.supersedesReceiptSha256 === undefined && request.repairControl !== undefined) {
    throw new Error("repairControl is only valid for repair finalize.");
  }
  if (hasSourceCandidate && request.supersedesReceiptSha256 !== undefined) {
    throw new Error("SourceCandidate V2 finalize does not support receipt repair.");
  }
  if (request.repairControl !== undefined) validateRepairControl(request.repairControl);
  const context = validateVerificationContext(request.verificationContext);
  if (!context.valid) throw new Error(`Finalize verification context is invalid: ${context.issues.join("; ")}`);
}

function validateRepairControl(value) {
  assertAllowedKeys(value, "Finalize repairControl", [
    "repairPlanPath",
    "repairPlanSha256",
    "parentBindingMode",
    "goalContractSha256",
    "risk",
    "profilesSha256",
    "executableBindings",
  ]);
  if (typeof value.repairPlanPath !== "string" || value.repairPlanPath.length === 0) {
    throw new Error("Finalize repairControl requires repairPlanPath.");
  }
  if (value.parentBindingMode !== "receipt") {
    throw new Error("Finalize repairControl parentBindingMode is invalid.");
  }
  for (const field of ["repairPlanSha256", "goalContractSha256", "profilesSha256"]) {
    if (typeof value[field] !== "string" || !SHA256_PATTERN.test(value[field])) {
      throw new Error(`Finalize repairControl ${field} must be a lowercase SHA-256.`);
    }
  }
  validateRisk(value.risk, "Finalize repairControl risk");
  if (!Array.isArray(value.executableBindings) || value.executableBindings.length === 0) {
    throw new Error("Finalize repairControl requires executableBindings.");
  }
  const commandIds = [];
  for (const binding of value.executableBindings) {
    assertAllowedKeys(binding, "Finalize executable binding", [
      "commandId",
      "executable",
      "sha256",
    ]);
    safeIdentifier(binding.commandId, "repair executable commandId");
    if (typeof binding.executable !== "string" || !path.isAbsolute(binding.executable)) {
      throw new Error("Finalize repair executable must be an absolute path.");
    }
    if (typeof binding.sha256 !== "string" || !SHA256_PATTERN.test(binding.sha256)) {
      throw new Error("Finalize repair executable sha256 must be a lowercase SHA-256.");
    }
    commandIds.push(binding.commandId);
  }
  if (new Set(commandIds).size !== commandIds.length) {
    throw new Error("Finalize repair executable commandIds must be unique.");
  }
}

function validateRisk(value, label) {
  if (!isRecord(value)
    || !RISK_MODES.has(value.riskMode)
    || !Array.isArray(value.riskCategories)
    || value.riskCategories.some(category => !RISK_CATEGORIES.has(category))
    || new Set(value.riskCategories).size !== value.riskCategories.length
    || value.riskCategories.some((category, index) =>
      index > 0 && value.riskCategories[index - 1] >= category)) {
    throw new Error(`${label} must contain a valid riskMode and sorted unique riskCategories.`);
  }
  return {
    riskMode: value.riskMode,
    riskCategories: [...value.riskCategories],
  };
}

function goalBinding(executionRoot) {
  const goalPath = assertRegularFile(
    path.join(executionRoot, "goal-contract.json"),
    "Repair goal contract",
  );
  const goalBytes = readFileSync(goalPath);
  const goal = JSON.parse(goalBytes.toString("utf8"));
  const executionPlan = readJson(assertRegularFile(
    path.join(executionRoot, "execution-plan.json"),
    "Repair execution plan",
  ));
  const risk = validateRisk({
    riskMode: goal.riskMode ?? "standard",
    riskCategories: [...new Set(goal.riskCategories ?? [])].sort(),
  }, "Goal contract risk");
  return {
    goalContractSha256: sha256(goalBytes),
    risk,
    executionPlanGoalBindingValid: executionPlan.goalContractSha256 === sha256(goalBytes),
  };
}

function sameRisk(left, right) {
  return left?.riskMode === right?.riskMode
    && JSON.stringify(left?.riskCategories) === JSON.stringify(right?.riskCategories);
}

function assertRegularFile(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  return realpathSync(filePath);
}

function assertRepairControlCurrent({
  workspaceRoot,
  executionRoot,
  packetPath,
  packet,
  repairControl,
  request,
  profilesDocument,
  selectedProfileIds,
  activeParent,
}) {
  const sourceGate = verifyDeliveryPacket({ workspaceRoot, packet });
  if (sourceGate.status !== "valid") {
    throw new Error("Repair source changed before receipt persistence.");
  }
  const planPath = resolveExistingArtifact(
    workspaceRoot,
    repairControl.repairPlanPath,
    "repairControl.repairPlanPath",
  );
  const planBytes = readFileSync(planPath);
  if (sha256(planBytes) !== repairControl.repairPlanSha256) {
    throw new Error("Repair plan changed before receipt persistence.");
  }
  const plan = JSON.parse(planBytes.toString("utf8"));
  const currentGoal = goalBinding(executionRoot);
  if (currentGoal.goalContractSha256 !== repairControl.goalContractSha256) {
    throw new Error("Repair goal contract changed before receipt persistence.");
  }
  if (!sameRisk(currentGoal.risk, repairControl.risk)) {
    throw new Error("Repair risk binding changed before receipt persistence.");
  }
  const parentBindingValid = SHA256_PATTERN.test(activeParent?.receipt?.goalContractSha256 ?? "")
    && activeParent.receipt.goalContractSha256 === currentGoal.goalContractSha256
    && sameRisk(validateRisk(activeParent.receipt.risk, "Active parent receipt risk"), currentGoal.risk);
  if (!parentBindingValid) {
    throw new Error("Repair cannot cross parent receipt goal or risk drift.");
  }
  const profilesPath = assertRegularFile(
    path.join(workspaceRoot, ".owlcoda/runkit/profiles.json"),
    "Repair profiles",
  );
  if (sha256(readFileSync(profilesPath)) !== repairControl.profilesSha256) {
    throw new Error("Repair profiles changed before receipt persistence.");
  }
  for (const binding of repairControl.executableBindings) {
    const executable = assertRegularFile(
      binding.executable,
      `Repair executable ${binding.commandId}`,
    );
    if (executable !== binding.executable
      || sha256(readFileSync(executable)) !== binding.sha256) {
      throw new Error(`Repair executable changed before receipt persistence: ${binding.commandId}`);
    }
  }
  assertRepairPlanSemantics({
    workspaceRoot,
    packetPath,
    packet,
    plan,
    request,
    repairControl,
    profilesDocument,
    selectedProfileIds,
    activeParent,
    currentGoal,
  });
  return { sourceGate, plan, currentGoal };
}

function snapshotCommandReceipt({
  workspaceRoot,
  runId,
  snapshotPath,
  contextFingerprint,
  expectedFiles,
  expectedFingerprint,
  partialSourceBinding = false,
  sourceCandidate = null,
}) {
  const absolutePath = resolveExistingArtifact(workspaceRoot, snapshotPath, "snapshotPaths entry");
  const snapshot = readJson(absolutePath);
  if (snapshot.verificationContextFingerprint !== contextFingerprint) {
    throw new Error("Snapshot verification context does not match the finalize request.");
  }
  const validation = verifySnapshotEvidence({ workspaceRoot, runId, snapshot });
  if (!validation.valid) throw new Error(validation.issues.join("; "));
  if (sourceCandidate !== null) {
    const expected = JSON.stringify(sortedFileMap(expectedFiles));
    const before = JSON.stringify(sortedFileMap(
      snapshot.repositoryBefore?.selectedFiles ?? {},
    ));
    const after = JSON.stringify(sortedFileMap(
      snapshot.repositoryAfter?.selectedFiles ?? {},
    ));
    const materialInputs = Object.entries(sortedFileMap(expectedFiles))
      .map(([id, hash]) => ({ id, sha256: hash }));
    const actualMaterialInputs = [
      ...(snapshot.command?.evidence?.materialInputs ?? []),
    ].sort((left, right) => String(left?.id).localeCompare(String(right?.id)));
    if (
      snapshot.repositoryBefore?.head !== sourceCandidate.baseline.head
      || snapshot.repositoryAfter?.head !== sourceCandidate.baseline.head
      || before !== expected
      || after !== expected
      || JSON.stringify(actualMaterialInputs) !== JSON.stringify(materialInputs)
    ) {
      throw new Error("Snapshot source does not match SourceCandidate V2.");
    }
  } else if (!partialSourceBinding) {
    const sourceBinding = verifySnapshotSourceBinding({ snapshot, expectedFiles, expectedFingerprint });
    if (!sourceBinding.valid) throw new Error(sourceBinding.issues.join("; "));
  }
  const evidenceValidation = validateReplayableEvidence(snapshot.command.evidence);
  if (!evidenceValidation.valid) throw new Error(evidenceValidation.issues.join("; "));
  return {
    id: snapshot.snapshotId,
    evidence: snapshot.command.evidence,
    exitCode: snapshot.command.exitCode,
    stdoutSha256: snapshot.command.stdoutSha256,
    stderrSha256: snapshot.command.stderrSha256,
  };
}

function activeLineage(lineagePath) {
  if (!existsSync(lineagePath)) return { entries: [], active: null };
  const existing = readJson(lineagePath);
  const entries = Array.isArray(existing) ? existing : existing.receipts;
  const validation = validateReceiptLineage(entries);
  if (!validation.valid || !validation.active) {
    throw new Error("Existing receipt lineage is invalid.");
  }
  return { entries, active: validation.active };
}

function nextLineage({ lineagePath, receipt, supersedesReceiptSha256 }) {
  const nextHash = receiptSha256(receipt);
  const existing = activeLineage(lineagePath);
  if (existing.active === null) {
    if (supersedesReceiptSha256 !== undefined) {
      throw new Error("A repair supersedes receipt requires an existing active receipt.");
    }
    return [{ receiptSha256: nextHash, receipt }];
  }
  if (
    supersedesReceiptSha256 === undefined
    && existing.active.receiptSha256 === nextHash
    && canonicalJson(existing.active.receipt) === canonicalJson(receipt)
  ) {
    return existing.entries;
  }
  if (supersedesReceiptSha256 !== undefined) {
    if (existing.active.receiptSha256 !== supersedesReceiptSha256) {
      throw new Error("Repair supersedesReceiptSha256 does not match the active receipt.");
    }
  } else if (existing.active.receipt.status !== "invalidated_by_concurrent_write") {
    throw new Error("A new receipt may only replace an invalidated active receipt.");
  }
  return [
    ...existing.entries,
    {
      receiptSha256: nextHash,
      parentReceiptSha256: existing.active.receiptSha256,
      receipt,
    },
  ];
}

function outputArtifactsValid(workspaceRoot, commandReceipt) {
  const evidenceValidation = validateReplayableEvidence(commandReceipt?.evidence);
  if (!evidenceValidation.valid) throw new Error(evidenceValidation.issues.join("; "));
  if (commandReceipt.exitCode !== 0) throw new Error("Reused command receipt did not pass.");
  const outputByPath = new Map();
  for (const artifact of commandReceipt.evidence.outputArtifacts ?? []) {
    const absolutePath = resolveExistingArtifact(workspaceRoot, artifact.path, "reused output artifact");
    const actual = sha256(readFileSync(absolutePath));
    if (actual !== artifact.sha256) {
      throw new Error(`Reused output artifact hash mismatch: ${artifact.path}`);
    }
    outputByPath.set(artifact.path, artifact.sha256);
  }
  const outputHashes = [...outputByPath.values()];
  if (!outputHashes.includes(commandReceipt.stdoutSha256)
    || !outputHashes.includes(commandReceipt.stderrSha256)) {
    throw new Error("Reused command receipt stdout/stderr hashes are not bound output artifacts.");
  }
}

function commandMaterialMap({ workspaceRoot, commandReceipt, expectedFiles }) {
  outputArtifactsValid(workspaceRoot, commandReceipt);
  const materials = {};
  for (const material of commandReceipt.evidence.materialInputs ?? []) {
    const absolutePath = resolveExistingArtifact(workspaceRoot, material.id, "command material input");
    const actual = sha256(readFileSync(absolutePath));
    if (actual !== material.sha256) {
      throw new Error(`Command material input hash mismatch: ${material.id}`);
    }
    if (expectedFiles[material.id] !== undefined) {
      if (expectedFiles[material.id] !== material.sha256) {
        throw new Error(`Command material input does not match the current DeliveryPacket: ${material.id}`);
      }
      materials[material.id] = material.sha256;
    }
  }
  return materials;
}

function sortedFileMap(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function exactCommandMatches(profileCommand, commandReceipt) {
  const evidence = commandReceipt.evidence;
  const executable = evidence?.launcher?.executable;
  const exactArgv = evidence?.argv;
  if (typeof executable !== "string"
    || !Array.isArray(exactArgv)
    || exactArgv[0] !== executable
    || evidence.cwd !== profileCommand.cwd
    || JSON.stringify(exactArgv.slice(1)) !== JSON.stringify(profileCommand.argv)) {
    return false;
  }
  return profileCommand.executable.includes("/")
    ? profileCommand.executable === executable
    : path.basename(executable) === profileCommand.executable
      || path.basename(executable) === path.basename(profileCommand.executable);
}

function profileCommandMap(profilesDocument, selectedProfileIds, parentReceipt) {
  const required = new Map();
  const selected = profilesDocument.profiles.filter(profile => selectedProfileIds.includes(profile.id));
  const withCommands = selected.filter(profile =>
    Array.isArray(profile.commands) && profile.commands.length > 0);
  if (withCommands.length === 0 && parentReceipt !== undefined) {
    const parentProfiles = new Set(parentReceipt.selectedProfileIds ?? []);
    if (selectedProfileIds.some(profileId => !parentProfiles.has(profileId))) {
      throw new Error("Legacy repair command evidence does not cover selected profiles.");
    }
    for (const [index, receipt] of (parentReceipt.commandReceipts ?? []).entries()) {
      const evidence = receipt?.evidence;
      const executable = evidence?.launcher?.executable;
      if (typeof executable !== "string"
        || !path.isAbsolute(executable)
        || !Array.isArray(evidence.argv)
        || evidence.argv[0] !== executable
        || typeof evidence.cwd !== "string") {
        throw new Error("Legacy repair command evidence is not exactly replayable.");
      }
      required.set(`legacy-${index + 1}`, {
        id: `legacy-${index + 1}`,
        cwd: evidence.cwd,
        executable,
        argv: [...evidence.argv.slice(1)],
      });
    }
    if (required.size === 0) throw new Error("Repair requires exact legacy command evidence.");
    return required;
  }
  if (withCommands.length !== selected.length) {
    throw new Error("Repair profile command metadata is incomplete.");
  }
  for (const command of selected.flatMap(profile => profile.commands ?? [])) {
    safeIdentifier(command.id, "repair profile command id");
    if (typeof command.cwd !== "string"
      || typeof command.executable !== "string"
      || command.executable.length === 0
      || !Array.isArray(command.argv)
      || command.argv.some(value => typeof value !== "string")) {
      throw new Error(`Repair profile command is invalid: ${command.id}`);
    }
    const normalized = {
      id: command.id,
      cwd: command.cwd,
      executable: command.executable,
      argv: [...command.argv],
    };
    const existing = required.get(command.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error(`Repair profile command id has conflicting definitions: ${command.id}`);
    }
    required.set(command.id, normalized);
  }
  if (required.size === 0) throw new Error("Repair requires profile-owned exact command metadata.");
  return required;
}

function exactSortedIds(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertRepairPlanSemantics({
  workspaceRoot,
  packetPath,
  packet,
  plan,
  request,
  repairControl,
  profilesDocument,
  selectedProfileIds,
  activeParent,
  currentGoal,
}) {
  if (!isRecord(plan)
    || plan.schemaVersion !== "OwlCodaRepairPlanV1"
    || plan.runId !== packet.runId
    || plan.planStatus !== "ready"
    || !Array.isArray(plan.blockedCommands)
    || plan.blockedCommands.length !== 0
    || plan.authorizationGranted !== false) {
    throw new Error("Repair finalize requires a ready RepairPlan with no blocked commands.");
  }
  const relativePacketPath = relativeToWorkspace(workspaceRoot, packetPath);
  const packetSha256 = sha256(readFileSync(packetPath));
  const fingerprint = packet.sourceFingerprint?.sha256;
  if (!isRecord(plan.selectedPacket)
    || plan.selectedPacket.path !== relativePacketPath
    || request.deliveryPacketPath !== relativePacketPath
    || plan.selectedPacket.packetId !== path.basename(packetPath, ".json")
    || plan.selectedPacket.sha256 !== `sha256:${packetSha256}`
    || plan.selectedPacket.sourceFingerprint !== `sha256:${fingerprint}`
    || plan.currentSourceFingerprint !== `sha256:${fingerprint}`) {
    throw new Error("Repair plan is not bound to the selected DeliveryPacket bytes.");
  }
  if (!isRecord(plan.invalidReceiptRef)
    || plan.invalidReceiptRef.receiptId !== activeParent.receipt.receiptId
    || plan.invalidReceiptRef.sha256 !== `sha256:${activeParent.receiptSha256}`
    || plan.expectedSupersedes !== `sha256:${request.supersedesReceiptSha256}`
    || request.supersedesReceiptSha256 !== activeParent.receiptSha256
    || !REPAIRABLE_INVALID_REASONS.has(plan.invalidReason)) {
    throw new Error("Repair plan is not bound to the active invalid receipt.");
  }
  if (plan.sourceStabilityGate !== "fail_on_any_source_drift_during_repair"
    || !isRecord(plan.requiredTrust)
    || plan.requiredTrust.riskMode !== currentGoal.risk.riskMode
    || JSON.stringify(plan.requiredTrust.riskCategories) !== JSON.stringify(currentGoal.risk.riskCategories)
    || plan.requiredTrust.implementationActor !== false
    || plan.requiredTrust.independentReviewer !== false
    || currentGoal.risk.riskMode === "full") {
    throw new Error("Repair plan trust requirements do not match the bound standard/lightweight risk.");
  }

  const commands = profileCommandMap(
    profilesDocument,
    selectedProfileIds,
    activeParent.receipt,
  );
  const reusableIds = plan.reusableCommandIds;
  const pending = plan.pendingReplayCommands;
  if (!Array.isArray(reusableIds)
    || reusableIds.some(id => typeof id !== "string")
    || new Set(reusableIds).size !== reusableIds.length
    || !Array.isArray(pending)
    || pending.some(command => !isRecord(command))) {
    throw new Error("Repair plan command classification is malformed.");
  }
  const pendingIds = pending.map(command => command.commandId);
  const allPlannedIds = [...reusableIds, ...pendingIds];
  if (new Set(allPlannedIds).size !== allPlannedIds.length
    || JSON.stringify(exactSortedIds(allPlannedIds))
      !== JSON.stringify(exactSortedIds(commands.keys()))) {
    throw new Error("Repair plan command classification does not exactly cover selected profiles.");
  }
  const bindings = new Map(repairControl.executableBindings.map(binding => [binding.commandId, binding]));
  if (JSON.stringify(exactSortedIds(bindings.keys()))
    !== JSON.stringify(exactSortedIds(commands.keys()))) {
    throw new Error("Repair executable bindings do not exactly cover the plan.");
  }
  for (const command of pending) {
    const configured = commands.get(command.commandId);
    const binding = bindings.get(command.commandId);
    if (!configured
      || command.executable !== binding.executable
      || command.cwd !== configured.cwd
      || JSON.stringify(command.argv) !== JSON.stringify(configured.argv)
      || !(configured.executable.includes("/")
        ? configured.executable === command.executable
        : path.basename(command.executable) === configured.executable
          || path.basename(command.executable) === path.basename(configured.executable))) {
      throw new Error(`Repair plan pending command does not match profile metadata: ${command.commandId}`);
    }
  }
  return { reusableIds: exactSortedIds(reusableIds), pendingIds: exactSortedIds(pendingIds) };
}

function assertRepairCommandCoverage({
  profilesDocument,
  selectedProfileIds,
  commandReceipts,
  reusedCommandReceipts,
  replayedCommandReceipts,
  plan,
  parentReceipt,
}) {
  const required = [...profileCommandMap(
    profilesDocument,
    selectedProfileIds,
    parentReceipt,
  ).values()];
  const matchedReceipts = new Set();
  for (const command of required) {
    const matches = commandReceipts.filter(receipt => exactCommandMatches(command, receipt));
    if (matches.length !== 1) {
      throw new Error(`Repair command coverage is incomplete or ambiguous: ${command.id}`);
    }
    matchedReceipts.add(matches[0]);
  }
  if (matchedReceipts.size !== commandReceipts.length) {
    throw new Error("Repair receipt contains command evidence outside selected profile commands.");
  }
  const matchedCommandIds = receipts => receipts.map((receipt) => {
    const matches = required.filter(command => exactCommandMatches(command, receipt));
    if (matches.length !== 1) {
      throw new Error(`Repair receipt command classification is ambiguous: ${receipt.id}`);
    }
    return matches[0].id;
  });
  if (JSON.stringify(exactSortedIds(matchedCommandIds(reusedCommandReceipts)))
      !== JSON.stringify(exactSortedIds(plan.reusableCommandIds))
    || JSON.stringify(exactSortedIds(matchedCommandIds(replayedCommandReceipts)))
      !== JSON.stringify(exactSortedIds(plan.pendingReplayCommands.map(command => command.commandId)))) {
    throw new Error("Repair receipt reuse/replay classes do not match the ready RepairPlan.");
  }
}

export function runFinalize({ workspaceRoot, runId, request, hooks = {} }) {
  validateRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  assertExecutionUnclosed(executionRoot, runId);
  const sourceBinding = loadFinalizeSource({ workspaceRoot, runId, request });
  const packetPath = sourceBinding.sourcePath;
  const packet = sourceBinding.source;
  const sourceGate = sourceBinding.sourceGate;
  if (sourceGate.status !== "valid") {
    return {
      status: sourceGate.status,
      exitCode: sourceGate.exitCode,
      runId,
      issues: sourceGate.issues,
      authorizationGranted: false,
    };
  }
  const profilesDocument = readJson(path.join(workspaceRoot, ".owlcoda/runkit/profiles.json"));
  const profileImpact = resolveProfileImpactProjection({
    changedPaths: sourceBinding.changedPaths,
    profiles: profilesDocument.profiles,
    detailed: request.supersedesReceiptSha256 !== undefined,
  });
  if (profileImpact.decision !== "targeted_profiles") {
    return {
      status: "full_profile_required",
      exitCode: 2,
      runId,
      profileImpact,
      authorizationGranted: false,
    };
  }
  const contextFingerprint = verificationContextFingerprint(request.verificationContext);
  const expectedFiles = sourceBinding.expectedFiles;
  const receiptsRoot = path.join(executionRoot, "verification-receipts");
  const lineagePath = path.join(receiptsRoot, "receipt-lineage.json");
  const existing = activeLineage(lineagePath);
  const currentGoal = goalBinding(executionRoot);
  if (!currentGoal.executionPlanGoalBindingValid) {
    throw new Error("Execution plan does not bind the current goal contract.");
  }
  const reusedCommandReceipts = structuredClone(request.reusedCommandReceipts ?? []);
  let repairPlan = null;
  if (request.supersedesReceiptSha256 !== undefined) {
    if (existing.active?.receiptSha256 !== request.supersedesReceiptSha256) {
      throw new Error("Repair supersedesReceiptSha256 does not match the active receipt.");
    }
    const parentCommands = existing.active.receipt.commandReceipts ?? [];
    for (const reused of reusedCommandReceipts) {
      if (!parentCommands.some(candidate => JSON.stringify(candidate) === JSON.stringify(reused))) {
        throw new Error("Reused command receipt is not an exact command receipt from the active parent.");
      }
    }
    if (existing.active.receipt.verificationContextFingerprint !== contextFingerprint) {
      throw new Error("Repair cannot reuse command receipts across verification-context drift.");
    }
    repairPlan = assertRepairControlCurrent({
      workspaceRoot,
      executionRoot,
      packetPath,
      packet,
      repairControl: request.repairControl,
      request,
      profilesDocument,
      selectedProfileIds: profileImpact.profileIds,
      activeParent: existing.active,
    }).plan;
  }
  const replayedCommandReceipts = request.snapshotPaths.map((snapshotPath) => snapshotCommandReceipt({
    workspaceRoot,
    runId,
    snapshotPath,
    contextFingerprint,
    expectedFiles,
    expectedFingerprint: sourceGate.recomputedFingerprint,
    partialSourceBinding: request.supersedesReceiptSha256 !== undefined,
    sourceCandidate: sourceBinding.kind === "source_candidate_v2"
      ? sourceBinding.source
      : null,
  }));
  const commandReceipts = [...reusedCommandReceipts, ...replayedCommandReceipts];
  const commandIds = commandReceipts.map(receipt => receipt.id);
  if (commandIds.some(id => typeof id !== "string" || id.length === 0)
    || new Set(commandIds).size !== commandIds.length) {
    throw new Error("Finalize command receipt ids must be unique non-empty strings.");
  }
  if (request.supersedesReceiptSha256 !== undefined) {
    const coveredFiles = {};
    for (const commandReceipt of commandReceipts) {
      Object.assign(
        coveredFiles,
        commandMaterialMap({ workspaceRoot, commandReceipt, expectedFiles }),
      );
    }
    if (JSON.stringify(sortedFileMap(coveredFiles))
      !== JSON.stringify(sortedFileMap(expectedFiles))) {
      throw new Error("Repair command material coverage does not exactly match the current DeliveryPacket.");
    }
    assertRepairCommandCoverage({
      profilesDocument,
      selectedProfileIds: profileImpact.profileIds,
      commandReceipts,
      reusedCommandReceipts,
      replayedCommandReceipts,
      plan: repairPlan,
      parentReceipt: existing.active.receipt,
    });
  }
  const receipt = {
    schemaVersion: "OwlCodaRunKitVerificationReceiptV2",
    runId,
    receiptId: request.receiptId,
    status: "passed",
    sourceFingerprint: sourceGate.recomputedFingerprint,
    sourceArtifact: {
      kind: sourceBinding.kind,
      runId,
      path: relativeToWorkspace(workspaceRoot, sourceBinding.sourcePath),
      sha256: sha256(readFileSync(sourceBinding.sourcePath)),
      sourceFingerprint: sourceGate.recomputedFingerprint,
    },
    verificationContextFingerprint: contextFingerprint,
    goalContractSha256: currentGoal.goalContractSha256,
    risk: structuredClone(currentGoal.risk),
    selectedProfileIds: [...profileImpact.profileIds],
    commandRuns: commandReceipts.length,
    commandReceipts,
    ...(request.supersedesReceiptSha256 === undefined
      ? {}
      : {
        supersedesReceiptSha256: request.supersedesReceiptSha256,
        repairControl: structuredClone(request.repairControl),
      }),
  };
  const outputRoot = path.join(receiptsRoot, request.receiptId);
  const receiptPath = path.join(outputRoot, "verification-receipt.json");
  const lineage = nextLineage({
    lineagePath,
    receipt,
    supersedesReceiptSha256: request.supersedesReceiptSha256,
  });
  const gateInput = {
    contractVersion: "0.2",
    receipts: lineage,
    sourceGate,
    profileImpact,
    verificationContext: request.verificationContext,
  };
  const gate = validateVerificationReceiptGate(gateInput);
  if (!gate.accepted) {
    throw new Error(`Generated verification gate was not accepted: ${gate.issues.map((item) => item.message).join("; ")}`);
  }
  const assertCurrentBindings = () => {
    if (request.repairControl !== undefined) {
      assertRepairControlCurrent({
        workspaceRoot,
        executionRoot,
        packetPath,
        packet,
        repairControl: request.repairControl,
        request,
        profilesDocument,
        selectedProfileIds: profileImpact.profileIds,
        activeParent: existing.active,
      });
    } else if (sourceBinding.verifyCurrent().status !== "valid") {
      throw new Error("Source changed before receipt persistence.");
    }
  };
  if (typeof hooks.beforeReceiptPersist === "function") hooks.beforeReceiptPersist();
  assertCurrentBindings();
  const sourceGatePath = path.join(outputRoot, "source-gate.json");
  const profileImpactPath = path.join(outputRoot, "profile-impact.json");
  const gateInputPath = path.join(outputRoot, "verification-gate-input.json");
  const gateOutputPath = path.join(outputRoot, "verification-gate-output.json");
  writeFinalizeArtifactExact(
    receiptPath,
    receipt,
    "verification receipt",
  );
  writeFinalizeArtifactExact(sourceGatePath, sourceGate, "source gate");
  writeFinalizeArtifactExact(
    profileImpactPath,
    profileImpact,
    "profile impact",
  );
  writeFinalizeArtifactExact(
    gateInputPath,
    gateInput,
    "verification gate input",
  );
  writeFinalizeArtifactExact(
    gateOutputPath,
    gate,
    "verification gate output",
  );
  if (typeof hooks.beforeLineageActivate === "function") hooks.beforeLineageActivate();
  assertCurrentBindings();
  writeFinalizeLineageExact(lineagePath, {
    expectedEntries: existing.entries,
    nextEntries: lineage,
  });
  return {
    status: gate.decision,
    exitCode: 0,
    runId,
    receiptPath: relativeToWorkspace(workspaceRoot, receiptPath),
    lineagePath: relativeToWorkspace(workspaceRoot, lineagePath),
    gateInputPath: relativeToWorkspace(workspaceRoot, gateInputPath),
    gateOutputPath: relativeToWorkspace(workspaceRoot, gateOutputPath),
    activeReceiptSha256: gate.activeReceiptSha256,
    authorizationGranted: false,
  };
}
