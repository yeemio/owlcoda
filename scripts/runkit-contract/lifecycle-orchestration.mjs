import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { arch, type } from "node:os";
import path from "node:path";

import { createDeliveryFromLeaseWithinControlTransaction } from "./delivery-create.mjs";
import { collapseByteIdenticalDeliveryCandidates } from "./delivery-selection.mjs";
import { runFinalize } from "./finalize.mjs";
import { withControlTransaction } from "./lease-lifecycle.mjs";
import {
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";
import { validateReceiptLineage } from "./receipt-lineage.mjs";
import {
  runSnapshot,
  verifySnapshotEvidence,
  verifySnapshotSourceBinding,
} from "./snapshot.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import { verifySourceCandidateV2 } from "./source-candidate.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
];

function entryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function sortedFileMap(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function regularFile(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file, not a symlink.`);
  return realpathSync(filePath);
}

function regularDirectory(directoryPath, label) {
  const stat = lstatSync(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular directory, not a symlink.`);
  }
  return realpathSync(directoryPath);
}

function projectTruthDirectory({ workspaceRoot, executionRoot, directoryPath, label }) {
  const real = regularDirectory(directoryPath, label);
  if (real !== path.resolve(directoryPath) || !within(realpathSync(executionRoot), real)) {
    throw new Error(`${label} must remain a real directory inside the execution, without symlinks.`);
  }
  if (!within(realpathSync(workspaceRoot), real)) {
    throw new Error(`${label} escapes the RunKit workspace.`);
  }
  return real;
}

function ensureRegularDirectory(directoryPath, label) {
  if (!entryExists(directoryPath)) mkdirSync(directoryPath);
  return regularDirectory(directoryPath, label);
}

function verificationExecutableGate(executable) {
  if (!path.isAbsolute(executable)) {
    return {
      valid: false,
      issueCode: "verify_executable_absolute_path_required",
      message: "verify executable after -- must be an absolute path.",
    };
  }
  let stat;
  try {
    stat = lstatSync(executable);
  } catch {
    return {
      valid: false,
      issueCode: "verify_executable_missing",
      message: "verify executable must be a regular file, not a symlink.",
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      valid: false,
      issueCode: "verify_executable_symlink_rejected",
      message: "verify executable must be a regular file, not a symlink.",
    };
  }
  if (!stat.isFile()) {
    return {
      valid: false,
      issueCode: "verify_executable_not_regular_file",
      message: "verify executable must be a regular file, not a symlink.",
    };
  }
  return { valid: true };
}

function recordRejectedVerificationPreflight({
  workspaceRoot,
  executionRoot,
  runId,
  verificationId,
  executable,
  commandArgv,
  issueCode,
}) {
  const preflightsRoot = path.join(executionRoot, "verification-preflights");
  const realRoot = ensureRegularDirectory(
    preflightsRoot,
    "Verification preflight directory",
  );
  if (
    realRoot !== path.resolve(preflightsRoot)
    || !within(realpathSync(executionRoot), realRoot)
    || !within(realpathSync(workspaceRoot), realRoot)
  ) {
    throw new Error("Verification preflight directory must remain inside the execution.");
  }
  writeJsonExclusiveAtomically(path.join(realRoot, `${verificationId}.json`), {
    schemaVersion: "OwlCodaRunKitVerificationPreflightV1",
    runId,
    verificationId,
    status: "rejected",
    issueCode,
    executable,
    commandArgvSha256: sha256(JSON.stringify(commandArgv)),
    authorizationGranted: false,
  });
}

function recordRejectedFinalizeAttempt({
  workspaceRoot,
  runId,
  verificationId,
  outputRoot,
  finalizeRequestPath,
  finalized,
}) {
  const relativeRequestPath = relativeToWorkspace(workspaceRoot, finalizeRequestPath);
  const artifactPath = path.join(outputRoot, "finalize-result.json");
  writeJsonExclusiveAtomically(artifactPath, {
    schemaVersion: "OwlCodaRunKitVerificationFinalizeAttemptV1",
    runId,
    verificationId,
    status: "rejected",
    gateStatus: finalized.status,
    finalizeRequestPath: relativeRequestPath,
    finalizeRequestSha256: sha256(readFileSync(finalizeRequestPath)),
    result: finalized,
    authorizationGranted: false,
  });
  return relativeToWorkspace(workspaceRoot, artifactPath);
}

function gitVersion() {
  return execFileSync("git", ["--version"], { encoding: "utf8" })
    .trim()
    .replace(/^git version /, "");
}

export function derivedVerificationContext(workspaceRoot) {
  const lockfiles = LOCKFILES
    .filter(filePath => existsSync(path.join(workspaceRoot, filePath)))
    .map(filePath => ({
      path: filePath,
      sha256: sha256(readFileSync(regularFile(path.join(workspaceRoot, filePath), `Lockfile ${filePath}`))),
    }));
  return {
    schemaVersion: "OwlCodaRunKitVerificationContextV1",
    reusePolicy: "platform_bound",
    platform: { os: type(), arch: arch() },
    toolchains: [
      { name: "git", version: gitVersion() },
      { name: "node", version: process.versions.node },
    ],
    lockfiles,
    fixtures: [],
    services: [],
    environment: [],
  };
}

function requestDirectoryPath(executionRoot, verificationId) {
  const requestsRoot = path.join(executionRoot, "verification-requests");
  if (entryExists(requestsRoot)) {
    const stat = lstatSync(requestsRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Verification requests root must be a regular directory, not a symlink.");
    }
  }
  const outputRoot = path.join(requestsRoot, verificationId);
  if (entryExists(outputRoot)) throw new Error(`verification-id already exists: ${verificationId}`);
  return { requestsRoot, outputRoot };
}

function createRequestDirectory({ requestsRoot, outputRoot }) {
  if (!entryExists(requestsRoot)) mkdirSync(requestsRoot);
  mkdirSync(outputRoot);
}

function reusableDelivery({ workspaceRoot, executionRoot, runId, workItemId }) {
  const deliveryRoot = path.join(executionRoot, "delivery-packets");
  regularDirectory(deliveryRoot, "Delivery packet directory");
  const fresh = [];
  for (const entry of readdirSync(deliveryRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Delivery packet must be a regular file, not a symlink: ${entry.name}`);
    }
    const packetPath = path.join(deliveryRoot, entry.name);
    const packet = readJson(regularFile(packetPath, `Delivery packet ${entry.name}`));
    if (packet.runId !== runId || packet.discovery?.fromLease !== workItemId) continue;
    const sourceGate = verifyDeliveryPacket({ workspaceRoot, packet });
    if (sourceGate.status === "valid") fresh.push({ packetPath, packet, sourceGate });
  }
  const distinct = collapseByteIdenticalDeliveryCandidates(fresh);
  if (distinct.length > 1) {
    throw new Error("Multiple fresh delivery packets require explicit repair before high-level verify.");
  }
  if (distinct.length === 0) return null;
  return {
    status: "delivery_packet_reused",
    exitCode: 0,
    runId,
    deliveryPacketPath: relativeToWorkspace(workspaceRoot, distinct[0].packetPath),
    sourceFingerprint: distinct[0].sourceGate.recomputedFingerprint,
    authorizationGranted: false,
  };
}

function snapshotRequest({ workspaceRoot, packet, verificationId, cwd, commandArgv, context }) {
  const [executable, ...argv] = commandArgv;
  if (!path.isAbsolute(executable)) throw new Error("verify executable after -- must be an absolute path.");
  regularFile(executable, "verify executable");
  const selectedPaths = Object.keys(packet.changedFiles?.wholeFileSha256 ?? {}).sort();
  if (selectedPaths.length === 0) throw new Error("verify requires a non-empty DeliveryPacket.");
  return {
    schemaVersion: "OwlCodaRunKitSnapshotRequestV1",
    snapshotId: `${verificationId}-snapshot`,
    mode: "project",
    targetRoot: workspaceRoot,
    cwd,
    executable,
    argv,
    launcherVersion: "runkit-verify-v1",
    toolVersions: structuredClone(context.toolchains),
    selectedPaths,
    statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
    verificationContext: context,
  };
}

function runHighLevelVerifyWithinControlTransaction({
  workspaceRoot,
  runId,
  workItemId,
  verificationId,
  cwd = ".",
  commandArgv,
}) {
  safeIdentifier(verificationId, "verification-id");
  safeRelativePath(cwd, "verify cwd", { allowDot: true });
  if (!Array.isArray(commandArgv) || commandArgv.length === 0) {
    throw new Error("verify requires an exact command after --.");
  }
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  regularDirectory(executionRoot, "Execution directory");
  const [executable] = commandArgv;
  const executableGate = verificationExecutableGate(executable);
  if (!executableGate.valid) {
    recordRejectedVerificationPreflight({
      workspaceRoot,
      executionRoot,
      runId,
      verificationId,
      executable,
      commandArgv,
      issueCode: executableGate.issueCode,
    });
    throw new Error(executableGate.message);
  }
  for (const [name, label, create] of [
    ["delivery-packets", "Delivery packet directory", false],
    ["snapshots", "Snapshot directory", true],
    ["snapshot-evidence", "Snapshot evidence directory", true],
    ["verification-receipts", "Verification receipts directory", false],
  ]) {
    const directoryPath = path.join(executionRoot, name);
    if (create) ensureRegularDirectory(directoryPath, label);
    else regularDirectory(directoryPath, label);
  }
  const realCwd = realpathSync(cwd === "." ? workspaceRoot : path.join(workspaceRoot, cwd));
  if (!within(workspaceRoot, realCwd)) throw new Error("verify cwd escapes the workspace through a symlink.");
  for (const outputPath of [
    path.join(executionRoot, "snapshots", `${verificationId}-snapshot.json`),
    path.join(executionRoot, "snapshot-evidence", `${verificationId}-snapshot.stdout`),
    path.join(executionRoot, "snapshot-evidence", `${verificationId}-snapshot.stderr`),
    path.join(executionRoot, "verification-receipts", `${verificationId}-receipt`),
  ]) {
    if (entryExists(outputPath)) throw new Error(`verification-id output already exists: ${verificationId}`);
  }
  const requestPaths = requestDirectoryPath(executionRoot, verificationId);
  const delivery = reusableDelivery({ workspaceRoot, executionRoot, runId, workItemId })
    ?? createDeliveryFromLeaseWithinControlTransaction({
      workspaceRoot,
      runId,
      workItemId,
      packetId: `${verificationId}-delivery`,
    });
  if (!new Set(["delivery_packet_created", "delivery_packet_reused"]).has(delivery.status)) return delivery;

  const packet = readJson(path.join(workspaceRoot, delivery.deliveryPacketPath));
  const context = derivedVerificationContext(workspaceRoot);
  createRequestDirectory(requestPaths);
  const { outputRoot } = requestPaths;
  const snapshotRequestPath = path.join(outputRoot, "snapshot-request.json");
  const snapshot = snapshotRequest({ workspaceRoot, packet, verificationId, cwd, commandArgv, context });
  writeJsonExclusiveAtomically(snapshotRequestPath, snapshot);
  const snapshotResult = runSnapshot({ workspaceRoot, runId, request: snapshot });
  if (snapshotResult.status !== "snapshot_passed") {
    const savedSnapshot = readJson(path.join(workspaceRoot, snapshotResult.snapshotPath));
    return {
      status: "verification_failed",
      exitCode: 2,
      runId,
      deliveryPacketPath: delivery.deliveryPacketPath,
      snapshotRequestPath: relativeToWorkspace(workspaceRoot, snapshotRequestPath),
      snapshotPath: snapshotResult.snapshotPath,
      commandExitCode: savedSnapshot.command.exitCode,
      nextAllowedAction: "repair_source_or_command_then_verify_with_new_id",
      authorizationGranted: false,
    };
  }

  const finalizeRequestPath = path.join(outputRoot, "finalize-request.json");
  const finalizeRequest = {
    schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
    receiptId: `${verificationId}-receipt`,
    deliveryPacketPath: delivery.deliveryPacketPath,
    verificationContext: context,
    snapshotPaths: [snapshotResult.snapshotPath],
  };
  writeJsonExclusiveAtomically(finalizeRequestPath, finalizeRequest);
  const finalized = runFinalize({ workspaceRoot, runId, request: finalizeRequest });
  if (finalized.status !== "accepted_passed") {
    return {
      ...finalized,
      finalizeResultPath: recordRejectedFinalizeAttempt({
        workspaceRoot,
        runId,
        verificationId,
        outputRoot,
        finalizeRequestPath,
        finalized,
      }),
    };
  }
  return {
    status: "verified",
    exitCode: 0,
    gateDecision: finalized.status,
    runId,
    deliveryPacketPath: delivery.deliveryPacketPath,
    snapshotRequestPath: relativeToWorkspace(workspaceRoot, snapshotRequestPath),
    snapshotPath: snapshotResult.snapshotPath,
    finalizeRequestPath: relativeToWorkspace(workspaceRoot, finalizeRequestPath),
    receiptPath: finalized.receiptPath,
    gateInputPath: finalized.gateInputPath,
    gateOutputPath: finalized.gateOutputPath,
    activeReceiptSha256: finalized.activeReceiptSha256,
    sourceFingerprint: delivery.sourceFingerprint,
    authorizationGranted: false,
  };
}

export function runHighLevelVerify(options) {
  return withControlTransaction(
    options.workspaceRoot,
    () => runHighLevelVerifyWithinControlTransaction(options),
  );
}

export function activeAcceptedGate({ workspaceRoot, runId }) {
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  projectTruthDirectory({
    workspaceRoot,
    executionRoot,
    directoryPath: executionRoot,
    label: "Execution directory",
  });
  const receiptsRoot = path.join(executionRoot, "verification-receipts");
  projectTruthDirectory({
    workspaceRoot,
    executionRoot,
    directoryPath: receiptsRoot,
    label: "Verification receipts directory",
  });
  const lineagePath = path.join(receiptsRoot, "receipt-lineage.json");
  if (!existsSync(lineagePath)) throw new Error("Accepted finish requires one active verification gate.");
  regularFile(lineagePath, "Receipt lineage");
  const lineage = readJson(lineagePath);
  const validated = validateReceiptLineage(lineage);
  if (!validated.valid || validated.active?.receipt?.status !== "passed") {
    throw new Error("Accepted finish requires one valid passed active verification gate.");
  }
  if (validated.active.receipt.runId !== runId) {
    throw new Error("Active verification gate belongs to another execution.");
  }
  const receiptId = safeIdentifier(validated.active.receipt.receiptId, "active receiptId");
  const gateInputPath = path.join(
    receiptsRoot,
    receiptId,
    "verification-gate-input.json",
  );
  projectTruthDirectory({
    workspaceRoot,
    executionRoot,
    directoryPath: path.dirname(gateInputPath),
    label: "Active receipt directory",
  });
  regularFile(gateInputPath, "Active verification gate input");
  const gateInput = readJson(gateInputPath);
  const gate = validateVerificationReceiptGate(gateInput);
  if (gate.contractVersion !== "0.2" || gateInput.contractVersion !== "0.2") {
    throw new Error("Accepted finish requires a Contract v0.2 verification gate.");
  }
  if (!gate.accepted || gate.activeReceiptSha256 !== validated.active.receiptSha256) {
    throw new Error("Accepted finish requires one valid passed active verification gate.");
  }
  const deliveryRoot = path.join(executionRoot, "delivery-packets");
  projectTruthDirectory({
    workspaceRoot,
    executionRoot,
    directoryPath: deliveryRoot,
    label: "Delivery packet directory",
  });
  const matchingPackets = [];
  for (const entry of readdirSync(deliveryRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Delivery packet must be a regular file, not a symlink: ${entry.name}`);
    }
    const packetPath = path.join(deliveryRoot, entry.name);
    const packet = readJson(regularFile(packetPath, `Delivery packet ${entry.name}`));
    if (packet.runId === runId
      && packet.sourceFingerprint?.sha256 === validated.active.receipt.sourceFingerprint) {
      matchingPackets.push({ packetPath, packet, sourceGate: verifyDeliveryPacket({ workspaceRoot, packet }) });
    }
  }
  const distinctMatchingPackets = collapseByteIdenticalDeliveryCandidates(matchingPackets);
  const declaredSourceArtifact = validated.active.receipt.sourceArtifact;
  let matchingCandidate = null;
  if (distinctMatchingPackets.length === 0) {
    const candidateRoot = path.join(executionRoot, "source-candidates");
    projectTruthDirectory({
      workspaceRoot,
      executionRoot,
      directoryPath: candidateRoot,
      label: "Source candidate directory",
    });
    const candidates = [];
    for (const entry of readdirSync(candidateRoot, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Source candidate must be a regular file: ${entry.name}`);
      }
      const candidatePath = path.join(candidateRoot, entry.name);
      const candidate = readJson(regularFile(
        candidatePath,
        `Source candidate ${entry.name}`,
      ));
      if (
        candidate.runId === runId
        && candidate.sourceFingerprint?.sha256
          === validated.active.receipt.sourceFingerprint
      ) {
        const sourceGate = verifySourceCandidateV2({
          workspaceRoot,
          candidatePath: relativeToWorkspace(workspaceRoot, candidatePath),
        });
        if (sourceGate.status === "valid") {
          candidates.push({ candidatePath, candidate, sourceGate });
        }
      }
    }
    const manifestFingerprints = new Set(
      candidates.map(({ candidate }) => candidate.sourceManifest.sha256),
    );
    if (manifestFingerprints.size === 1) {
      matchingCandidate = candidates.find(({ candidatePath }) => (
        declaredSourceArtifact?.kind === "source_candidate_v2"
        && declaredSourceArtifact.path
          === relativeToWorkspace(workspaceRoot, candidatePath)
        && declaredSourceArtifact.sha256 === sha256(readFileSync(candidatePath))
      )) ?? candidates[0];
    }
  }
  if (
    matchingCandidate === null
    && (
      distinctMatchingPackets.length !== 1
      || distinctMatchingPackets[0].sourceGate.status !== "valid"
    )
  ) {
    throw new Error("Accepted finish requires one fresh source binding matching the active verification gate; source drift remains unresolved.");
  }
  const [matchingPacket] = distinctMatchingPackets;
  if (declaredSourceArtifact !== undefined) {
    const selectedPath = matchingCandidate === null
      ? matchingPacket.packetPath
      : matchingCandidate.candidatePath;
    const expectedSourceArtifact = {
      kind: matchingCandidate === null
        ? "delivery_packet_v1"
        : "source_candidate_v2",
      runId,
      path: relativeToWorkspace(workspaceRoot, selectedPath),
      sha256: sha256(readFileSync(selectedPath)),
      sourceFingerprint: validated.active.receipt.sourceFingerprint,
    };
    if (
      declaredSourceArtifact.kind !== expectedSourceArtifact.kind
      || declaredSourceArtifact.runId !== expectedSourceArtifact.runId
      || declaredSourceArtifact.path !== expectedSourceArtifact.path
      || declaredSourceArtifact.sha256 !== expectedSourceArtifact.sha256
      || declaredSourceArtifact.sourceFingerprint
        !== expectedSourceArtifact.sourceFingerprint
    ) {
      throw new Error(
        "Accepted finish requires the active receipt sourceArtifact to match the selected source bytes.",
      );
    }
  }
  const snapshotsRoot = path.join(executionRoot, "snapshots");
  const evidenceRoot = path.join(executionRoot, "snapshot-evidence");
  projectTruthDirectory({ workspaceRoot, executionRoot, directoryPath: snapshotsRoot, label: "Snapshot directory" });
  projectTruthDirectory({ workspaceRoot, executionRoot, directoryPath: evidenceRoot, label: "Snapshot evidence directory" });
  for (const commandReceipt of validated.active.receipt.commandReceipts) {
    const snapshotId = safeIdentifier(commandReceipt.id, "active snapshot id");
    const snapshotPath = path.join(snapshotsRoot, `${snapshotId}.json`);
    const snapshot = readJson(regularFile(snapshotPath, `Active snapshot ${snapshotId}`));
    if (matchingCandidate !== null) {
      const expectedFiles = Object.fromEntries(
        matchingCandidate.candidate.sourceManifest.entries
          .filter((entry) => entry.operation !== "deleted")
          .map((entry) => [entry.path, entry.sha256])
          .sort(([left], [right]) => left.localeCompare(right)),
      );
      const beforeFiles = sortedFileMap(
        snapshot.repositoryBefore?.selectedFiles ?? {},
      );
      const afterFiles = sortedFileMap(
        snapshot.repositoryAfter?.selectedFiles ?? {},
      );
      const expectedInputs = Object.entries(expectedFiles)
        .map(([id, hash]) => ({ id, sha256: hash }));
      const actualInputs = [
        ...(snapshot.command?.evidence?.materialInputs ?? []),
      ].sort((left, right) => String(left?.id).localeCompare(String(right?.id)));
      if (
        snapshot.repositoryBefore?.head
          !== matchingCandidate.candidate.baseline.head
        || snapshot.repositoryAfter?.head
          !== matchingCandidate.candidate.baseline.head
        || JSON.stringify(beforeFiles) !== JSON.stringify(expectedFiles)
        || JSON.stringify(afterFiles) !== JSON.stringify(expectedFiles)
        || JSON.stringify(actualInputs) !== JSON.stringify(expectedInputs)
      ) {
        throw new Error(`Accepted finish requires snapshot source bound to SourceCandidate V2: ${snapshotId}`);
      }
    } else {
      const sourceBinding = verifySnapshotSourceBinding({
        snapshot,
        expectedFiles: matchingPacket.packet.changedFiles?.files
          ?? matchingPacket.packet.changedFiles?.wholeFileSha256,
        expectedFingerprint: validated.active.receipt.sourceFingerprint,
      });
      if (!sourceBinding.valid) {
        throw new Error(`Accepted finish requires snapshot source bound to the DeliveryPacket: ${snapshotId}; ${sourceBinding.issues.join("; ")}`);
      }
    }
    const expectedStdoutPath = relativeToWorkspace(workspaceRoot, path.join(evidenceRoot, `${snapshotId}.stdout`));
    const expectedStderrPath = relativeToWorkspace(workspaceRoot, path.join(evidenceRoot, `${snapshotId}.stderr`));
    if (snapshot.command?.stdoutPath !== expectedStdoutPath
      || snapshot.command?.stderrPath !== expectedStderrPath) {
      throw new Error(`Accepted finish requires snapshot evidence inside the execution: ${snapshotId}`);
    }
    regularFile(path.join(workspaceRoot, expectedStdoutPath), `Active snapshot stdout ${snapshotId}`);
    regularFile(path.join(workspaceRoot, expectedStderrPath), `Active snapshot stderr ${snapshotId}`);
    const evidence = verifySnapshotEvidence({ workspaceRoot, runId, snapshot });
    const receiptMatchesSnapshot = snapshot.command?.exitCode === commandReceipt.exitCode
      && snapshot.command?.stdoutSha256 === commandReceipt.stdoutSha256
      && snapshot.command?.stderrSha256 === commandReceipt.stderrSha256
      && JSON.stringify(snapshot.command?.evidence) === JSON.stringify(commandReceipt.evidence)
      && snapshot.verificationContextFingerprint === validated.active.receipt.verificationContextFingerprint;
    if (!evidence.valid || !receiptMatchesSnapshot) {
      throw new Error(`Accepted finish requires intact snapshot evidence: ${snapshotId}; ${evidence.issues.join("; ")}`);
    }
  }
  return {
    status: "valid",
    gateInputPath,
    gateInputRelativePath: relativeToWorkspace(workspaceRoot, gateInputPath),
    ...(matchingCandidate === null
      ? {
        deliveryPacketPath: relativeToWorkspace(
          workspaceRoot,
          matchingPacket.packetPath,
        ),
      }
      : {
        sourceCandidatePath: relativeToWorkspace(
          workspaceRoot,
          matchingCandidate.candidatePath,
        ),
      }),
    activeReceiptSha256: gate.activeReceiptSha256,
    authorizationGranted: false,
  };
}
