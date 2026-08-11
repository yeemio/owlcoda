import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { createDeliveryFromLeaseWithinControlTransaction } from "./delivery-create.mjs";
import { collapseByteIdenticalDeliveryCandidates } from "./delivery-selection.mjs";
import { runFinalize } from "./finalize.mjs";
import {
  listLeaseArtifacts,
  withControlTransaction,
} from "./lease-lifecycle.mjs";
import { derivedVerificationContext } from "./lifecycle-orchestration.mjs";
import { resolveProfileImpactDetailed } from "./profile-impact.mjs";
import {
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonAtomically,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";
import { validateReceiptLineage } from "./receipt-lineage.mjs";
import { runSnapshot } from "./snapshot.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import { verificationContextFingerprint } from "./verification-context.mjs";

const STATUS_MODE = "porcelain-v1-z-untracked-all-runkit-excluded";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RISK_CATEGORIES = new Set(["migration", "backtest", "release", "funds", "production"]);

function regularFile(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  return realpathSync(filePath);
}

function matchesRule(filePath, rule) {
  return rule.endsWith("/**")
    ? filePath.startsWith(`${rule.slice(0, -3)}/`)
    : filePath === rule;
}

function isOwned(filePath, ownedPaths) {
  return ownedPaths.some(ownedPath => matchesRule(filePath, ownedPath));
}

function gitStatusRecords(workspaceRoot) {
  const completed = spawnSync("git", [
    "-C",
    workspaceRoot,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).owlcoda/runkit/**",
  ], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`Git status failed: ${completed.stderr.trim()}`);
  const entries = completed.stdout.split("\0");
  const records = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Git status emitted malformed porcelain.");
    const status = entry.slice(0, 2);
    const currentPath = safeRelativePath(entry.slice(3), "Git status path");
    const paths = [currentPath];
    if (status.includes("R") || status.includes("C")) {
      const priorPath = entries[index + 1];
      if (!priorPath) throw new Error("Git status rename entry is incomplete.");
      paths.push(safeRelativePath(priorPath, "Git status prior path"));
      index += 1;
    }
    records.push({ status, currentPath, paths });
  }
  return records;
}

function currentOwnedFiles(workspaceRoot, ownedPaths) {
  const files = {};
  const blockers = [];
  for (const record of gitStatusRecords(workspaceRoot)) {
    const owned = record.paths.filter(filePath => isOwned(filePath, ownedPaths));
    if (owned.length === 0) continue;
    if (record.status.includes("R") || record.status.includes("C") || record.status.includes("D")) {
      blockers.push(...owned);
      continue;
    }
    if (!isOwned(record.currentPath, ownedPaths)) continue;
    const absolutePath = regularFile(
      path.join(workspaceRoot, record.currentPath),
      `Owned repair source ${record.currentPath}`,
    );
    files[record.currentPath] = sha256(readFileSync(absolutePath));
  }
  return {
    files: Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))),
    blockers: [...new Set(blockers)].sort(),
  };
}

function packetFiles(packet) {
  return packet?.changedFiles?.files ?? packet?.changedFiles?.wholeFileSha256 ?? null;
}

function matchingCurrentPackets({ workspaceRoot, executionRoot, workItemId, files }) {
  const root = path.join(executionRoot, "delivery-packets");
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })
    .filter(candidate => candidate.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Delivery packet must be a regular file: ${entry.name}`);
    }
    const packetPath = regularFile(path.join(root, entry.name), `Delivery packet ${entry.name}`);
    const packet = readJson(packetPath);
    if (packet.discovery?.fromLease !== workItemId) continue;
    if (JSON.stringify(packetFiles(packet)) !== JSON.stringify(files)) continue;
    const gate = verifyDeliveryPacket({ workspaceRoot, packet });
    if (gate.status !== "valid") continue;
    matches.push({
      packet,
      packetPath,
      sourceFingerprint: gate.recomputedFingerprint,
    });
  }
  return collapseByteIdenticalDeliveryCandidates(matches);
}

function nextRepairSequence(executionRoot) {
  const plansRoot = path.join(executionRoot, "repair-plans");
  if (!existsSync(plansRoot)) return 1;
  const values = readdirSync(plansRoot)
    .map(name => /^repair-(\d+)-plan\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  return values.length === 0 ? 1 : Math.max(...values) + 1;
}

function repairId(sequence) {
  return `repair-${String(sequence).padStart(3, "0")}`;
}

function selectPacket({
  workspaceRoot,
  executionRoot,
  runId,
  lease,
  sequence,
}) {
  const current = currentOwnedFiles(workspaceRoot, lease.ownedPaths);
  if (current.blockers.length > 0) {
    throw new Error(`Repair cannot infer deleted or renamed owned paths: ${current.blockers.join(", ")}`);
  }
  if (Object.keys(current.files).length === 0) {
    throw new Error("Repair requires at least one changed file owned by the active lease.");
  }
  const matching = matchingCurrentPackets({
    workspaceRoot,
    executionRoot,
    workItemId: lease.workItemId,
    files: current.files,
  });
  if (matching.length > 1) {
    return { ...matching.at(-1), ambiguous: true };
  }
  if (matching.length === 1) return { ...matching[0], ambiguous: false };
  const created = createDeliveryFromLeaseWithinControlTransaction({
    workspaceRoot,
    runId,
    workItemId: lease.workItemId,
    packetId: `${repairId(sequence)}-delivery`,
  });
  if (created.status !== "delivery_packet_created") {
    throw new Error(`Repair could not create a current DeliveryPacket: ${created.status}`);
  }
  const packetPath = path.join(workspaceRoot, created.deliveryPacketPath);
  return {
    packet: readJson(packetPath),
    packetPath,
    sourceFingerprint: created.sourceFingerprint,
    ambiguous: false,
  };
}

function activeReceipt(executionRoot) {
  const lineagePath = path.join(executionRoot, "verification-receipts", "receipt-lineage.json");
  if (!existsSync(lineagePath)) throw new Error("Repair requires an existing verification receipt lineage.");
  const lineage = readJson(regularFile(lineagePath, "Receipt lineage"));
  const validation = validateReceiptLineage(lineage);
  if (!validation.valid || !validation.active) {
    throw new Error("Repair requires one unambiguous active verification receipt.");
  }
  return { lineagePath, lineage, active: validation.active };
}

function normalizeRisk(goal) {
  const riskMode = goal.riskMode ?? "standard";
  if (!new Set(["lightweight", "standard", "full"]).has(riskMode)) {
    return {
      riskMode: "full",
      riskCategories: [],
      invalid: true,
    };
  }
  const categories = Array.isArray(goal.riskCategories)
    ? [...new Set(goal.riskCategories)].sort()
    : [];
  const invalid = categories.some(category => !RISK_CATEGORIES.has(category));
  return { riskMode, riskCategories: invalid ? [] : categories, invalid };
}

function normalizeProfileCommand(command, profileId) {
  if (typeof command?.id !== "string"
    || command.id.length === 0
    || typeof command.cwd !== "string"
    || typeof command.executable !== "string"
    || command.executable.length === 0
    || !Array.isArray(command.argv)
    || command.argv.some(value => typeof value !== "string")) {
    throw new Error(`Profile command is invalid: ${profileId}`);
  }
  safeIdentifier(command.id, "profile command id");
  safeRelativePath(command.cwd, "profile command cwd", { allowDot: true });
  return {
    id: command.id,
    cwd: command.cwd,
    executable: command.executable,
    argv: [...command.argv],
  };
}

function legacyReceiptCommandDefinitions({ parentReceipt, selectedProfileIds, files }) {
  const parentProfiles = new Set(parentReceipt.selectedProfileIds ?? []);
  if (selectedProfileIds.some(profileId => !parentProfiles.has(profileId))) return [];
  return (parentReceipt.commandReceipts ?? []).map((commandReceipt, index) => {
    const evidence = commandReceipt?.evidence;
    const executable = evidence?.launcher?.executable;
    if (typeof executable !== "string"
      || !path.isAbsolute(executable)
      || !Array.isArray(evidence.argv)
      || evidence.argv[0] !== executable
      || typeof evidence.cwd !== "string") {
      return {
        id: `legacy-${index + 1}`,
        profileIds: [...selectedProfileIds],
        sourcePaths: Object.keys(files).sort(),
        missing: true,
      };
    }
    return {
      id: `legacy-${index + 1}`,
      cwd: evidence.cwd,
      executable,
      argv: [...evidence.argv.slice(1)],
      profileIds: [...selectedProfileIds],
      sourcePaths: Object.keys(files).sort(),
      missing: false,
    };
  });
}

function commandDefinitions(profiles, selectedProfileIds, files, parentReceipt) {
  const byId = new Map();
  const selectedProfiles = profiles.filter(item => selectedProfileIds.includes(item.id));
  const profilesWithCommands = selectedProfiles.filter(profile =>
    Array.isArray(profile.commands) && profile.commands.length > 0);
  if (profilesWithCommands.length === 0) {
    return legacyReceiptCommandDefinitions({
      parentReceipt,
      selectedProfileIds,
      files,
    });
  }
  for (const profile of selectedProfiles) {
    if (!Array.isArray(profile.commands) || profile.commands.length === 0) {
      byId.set(`__missing__${profile.id}`, {
        id: `__missing__${profile.id}`,
        profileIds: [profile.id],
        sourcePaths: Object.keys(files).filter(filePath =>
          profile.paths.some(rule => matchesRule(filePath, rule))),
        missing: true,
      });
      continue;
    }
    for (const rawCommand of profile.commands) {
      const command = normalizeProfileCommand(rawCommand, profile.id);
      const current = byId.get(command.id);
      if (current
        && JSON.stringify({
          cwd: current.cwd,
          executable: current.executable,
          argv: current.argv,
        }) !== JSON.stringify({
          cwd: command.cwd,
          executable: command.executable,
          argv: command.argv,
        })) {
        throw new Error(`Profile command id has conflicting definitions: ${command.id}`);
      }
      const sourcePaths = Object.keys(files).filter(filePath =>
        profile.paths.some(rule => matchesRule(filePath, rule)));
      byId.set(command.id, {
        ...command,
        profileIds: [...new Set([...(current?.profileIds ?? []), profile.id])].sort(),
        sourcePaths: [...new Set([...(current?.sourcePaths ?? []), ...sourcePaths])].sort(),
        missing: false,
      });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function exactCommandMatches(command, commandReceipt) {
  const evidence = commandReceipt?.evidence;
  const executable = evidence?.launcher?.executable;
  if (typeof executable !== "string"
    || evidence.cwd !== command.cwd
    || !Array.isArray(evidence.argv)
    || evidence.argv[0] !== executable
    || JSON.stringify(evidence.argv.slice(1)) !== JSON.stringify(command.argv)) {
    return false;
  }
  return command.executable.includes("/")
    ? command.executable === executable
    : path.basename(executable) === command.executable
      || path.basename(executable) === path.basename(command.executable);
}

function materialInputsReusable({ workspaceRoot, commandReceipt, sourcePaths, files }) {
  const materials = new Map(
    (commandReceipt.evidence?.materialInputs ?? []).map(item => [item.id, item.sha256]),
  );
  for (const sourcePath of sourcePaths) {
    if (materials.get(sourcePath) !== files[sourcePath]) return false;
  }
  for (const [materialPath, expected] of materials) {
    try {
      const actual = sha256(readFileSync(regularFile(
        path.join(workspaceRoot, materialPath),
        `Reusable command material ${materialPath}`,
      )));
      if (actual !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function resolveExecutable(value) {
  let candidate = value;
  if (!path.isAbsolute(candidate)) {
    candidate = execFileSync("/usr/bin/which", [candidate], { encoding: "utf8" }).trim();
  }
  return regularFile(candidate, `Repair executable ${value}`);
}

function executableBinding(commandId, executable) {
  return {
    commandId,
    executable,
    sha256: sha256(readFileSync(executable)),
  };
}

function classifyCommands({
  workspaceRoot,
  profiles,
  selectedProfileIds,
  files,
  parentReceipt,
  currentContextFingerprint,
}) {
  const definitions = commandDefinitions(profiles, selectedProfileIds, files, parentReceipt);
  const reusable = [];
  const pending = [];
  const blocked = [];
  if (definitions.length === 0) {
    return {
      reusable,
      pending,
      blocked: [{ commandId: "__command_metadata__", issueCode: "repair_plan_incomplete" }],
    };
  }
  const parentSelected = new Set(parentReceipt.selectedProfileIds ?? []);
  for (const command of definitions) {
    if (command.missing) {
      blocked.push({ commandId: command.id, issueCode: "repair_plan_incomplete" });
      continue;
    }
    const selectedPaths = command.sourcePaths.length === 0
      ? Object.keys(files).sort()
      : [...command.sourcePaths];
    let binding;
    try {
      const executable = resolveExecutable(command.executable);
      binding = executableBinding(command.id, executable);
    } catch {
      blocked.push({ commandId: command.id, issueCode: "repair_plan_incomplete" });
      continue;
    }
    const matches = (parentReceipt.commandReceipts ?? [])
      .filter(commandReceipt => exactCommandMatches(command, commandReceipt));
    if (matches.length > 1) {
      blocked.push({ commandId: command.id, issueCode: "repair_plan_incomplete" });
      continue;
    }
    if (matches.length === 1
      && parentReceipt.verificationContextFingerprint === currentContextFingerprint
      && materialInputsReusable({
        workspaceRoot,
        commandReceipt: matches[0],
        sourcePaths: selectedPaths,
        files,
      })) {
      reusable.push({
        commandId: command.id,
        commandReceipt: matches[0],
        ...binding,
      });
      continue;
    }
    if (matches.length === 0
      && command.profileIds.some(profileId => parentSelected.has(profileId))) {
      blocked.push({ commandId: command.id, issueCode: "repair_plan_incomplete" });
      continue;
    }
    pending.push({
      ...binding,
      argv: [...command.argv],
      cwd: command.cwd,
      selectedPaths,
    });
  }
  return { reusable, pending, blocked };
}

function repairPlan({
  workspaceRoot,
  runId,
  selectedPacket,
  selectedPacketPath,
  selectedPacketSha256,
  active,
  invalidReason,
  classification,
  risk,
  packetAmbiguous,
}) {
  const trustBlocked = risk.invalid || risk.riskMode === "full";
  const blockedCommands = [
    ...classification.blocked,
    ...(packetAmbiguous
      ? [{ commandId: "__delivery_packet__", issueCode: "repair_plan_incomplete" }]
      : []),
    ...(trustBlocked
      ? [...classification.reusable, ...classification.pending].map(command => ({
        commandId: command.commandId,
        issueCode: "repair_plan_incomplete",
      }))
      : []),
  ].filter((entry, index, values) =>
    values.findIndex(candidate => candidate.commandId === entry.commandId) === index);
  return {
    schemaVersion: "OwlCodaRepairPlanV1",
    runId,
    selectedPacket: {
      packetId: path.basename(selectedPacketPath, ".json"),
      path: relativeToWorkspace(workspaceRoot, selectedPacketPath),
      sha256: `sha256:${selectedPacketSha256}`,
      sourceFingerprint: `sha256:${selectedPacket.sourceFingerprint.sha256}`,
    },
    currentSourceFingerprint: `sha256:${selectedPacket.sourceFingerprint.sha256}`,
    invalidReceiptRef: {
      receiptId: active.receipt.receiptId,
      sha256: `sha256:${active.receiptSha256}`,
    },
    invalidReason,
    reusableCommandIds: classification.reusable.map(item => item.commandId).sort(),
    pendingReplayCommands: classification.pending.map(command => ({
      commandId: command.commandId,
      executable: command.executable,
      argv: [...command.argv],
      cwd: command.cwd,
    })),
    blockedCommands: blockedCommands.sort((left, right) => left.commandId.localeCompare(right.commandId)),
    requiredTrust: {
      riskMode: risk.riskMode,
      riskCategories: [...risk.riskCategories],
      implementationActor: risk.riskMode === "full",
      independentReviewer: risk.riskMode === "full",
    },
    expectedSupersedes: `sha256:${active.receiptSha256}`,
    sourceStabilityGate: "fail_on_any_source_drift_during_repair",
    planStatus: blockedCommands.length === 0 ? "ready" : "repair_plan_incomplete",
    authorizationGranted: false,
  };
}

function attemptDocument({
  runId,
  id,
  planPath,
  replacementReceiptId,
  repairControl,
}) {
  return {
    schemaVersion: "OwlCodaRepairAttemptV1",
    runId,
    repairId: id,
    repairPlanPath: planPath,
    replacementReceiptId,
    repairControl,
    status: "running",
    commandAttempts: [],
    issueCodes: [],
    authorizationGranted: false,
  };
}

function readControlState(workspaceRoot, executionRoot) {
  const executionPlanPath = regularFile(
    path.join(executionRoot, "execution-plan.json"),
    "Execution plan",
  );
  const goalPath = regularFile(path.join(executionRoot, "goal-contract.json"), "Goal contract");
  const profilesPath = regularFile(
    path.join(workspaceRoot, ".owlcoda/runkit/profiles.json"),
    "RunKit profiles",
  );
  const executionPlan = readJson(executionPlanPath);
  const goalBytes = readFileSync(goalPath);
  const profileBytes = readFileSync(profilesPath);
  const goalContractSha256 = sha256(goalBytes);
  return {
    executionPlan,
    goal: JSON.parse(goalBytes.toString("utf8")),
    profilesDocument: JSON.parse(profileBytes.toString("utf8")),
    goalContractSha256,
    profilesSha256: sha256(profileBytes),
    goalBindingValid: SHA256_PATTERN.test(executionPlan.goalContractSha256 ?? "")
      && executionPlan.goalContractSha256 === goalContractSha256,
  };
}

function repairControlBinding({
  planPath,
  planSha256,
  controlState,
  classification,
}) {
  return {
    repairPlanPath: planPath,
    repairPlanSha256: planSha256,
    parentBindingMode: "receipt",
    goalContractSha256: controlState.goalContractSha256,
    risk: {
      riskMode: classification.risk.riskMode,
      riskCategories: [...classification.risk.riskCategories],
    },
    profilesSha256: controlState.profilesSha256,
    executableBindings: [...classification.reusable, ...classification.pending]
      .map(({ commandId, executable, sha256: executableSha256 }) => ({
        commandId,
        executable,
        sha256: executableSha256,
      }))
      .sort((left, right) => left.commandId.localeCompare(right.commandId)),
  };
}

function repairBindingsValid({
  workspaceRoot,
  executionRoot,
  packet,
  repairControl,
}) {
  if (verifyDeliveryPacket({ workspaceRoot, packet }).status !== "valid") return false;
  try {
    const current = readControlState(workspaceRoot, executionRoot);
    const currentRisk = normalizeRisk(current.goal);
    if (repairControl.parentBindingMode !== "receipt"
      || !current.goalBindingValid
      || current.goalContractSha256 !== repairControl.goalContractSha256
      || currentRisk.invalid
      || currentRisk.riskMode !== repairControl.risk.riskMode
      || JSON.stringify(currentRisk.riskCategories)
        !== JSON.stringify(repairControl.risk.riskCategories)
      || current.profilesSha256 !== repairControl.profilesSha256) {
      return false;
    }
    return repairControl.executableBindings.every(binding => {
      const executable = regularFile(binding.executable, `Repair executable ${binding.commandId}`);
      return executable === binding.executable
        && sha256(readFileSync(executable)) === binding.sha256;
    });
  } catch {
    return false;
  }
}

function resultForAttempt({
  status,
  exitCode,
  runId,
  planPath,
  planSha256,
  attemptPath,
  replacementReceiptId,
  reusable,
  replayed,
  sourceFingerprint,
  issueCodes = [],
  extra = {},
}) {
  return {
    status,
    exitCode,
    runId,
    repairPlanPath: planPath,
    repairPlanSha256: planSha256,
    repairAttemptPath: attemptPath,
    replacementReceiptId,
    reusableCommandIds: reusable.map(item => item.commandId).sort(),
    replayedCommandIds: replayed.map(item => item.commandId),
    sourceFingerprint,
    issueCodes,
    authorizationGranted: false,
    ...extra,
  };
}

function runRepairWithinControlTransaction({
  workspaceRoot,
  runId,
  onPlan,
  onBeforeReceiptPersist,
  onBeforeLineageActivate,
}) {
  safeIdentifier(runId, "run-id");
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const activeLeases = listLeaseArtifacts({ workspaceRoot, executionRoot })
    .filter(lease => lease.state === "active");
  if (activeLeases.length !== 1) {
    throw new Error("Repair requires exactly one active writer lease.");
  }
  const sequence = nextRepairSequence(executionRoot);
  const id = repairId(sequence);
  const selected = selectPacket({
    workspaceRoot,
    executionRoot,
    runId,
    lease: activeLeases[0],
    sequence,
  });
  const selectedPacketBytes = readFileSync(selected.packetPath);
  const files = packetFiles(selected.packet);
  const receipts = activeReceipt(executionRoot);
  const parent = receipts.active.receipt;
  const currentContext = derivedVerificationContext(workspaceRoot);
  const currentContextFingerprint = verificationContextFingerprint(currentContext);
  const controlState = readControlState(workspaceRoot, executionRoot);
  const profilesDocument = controlState.profilesDocument;
  const detailedProfileImpact = resolveProfileImpactDetailed({
    changedPaths: Object.keys(files),
    profiles: profilesDocument.profiles,
  });
  const profileImpact = {
    decision: detailedProfileImpact.decision,
    profileIds: detailedProfileImpact.selectedProfileIds,
    uncoveredPaths: detailedProfileImpact.uncoveredPaths,
  };
  const risk = normalizeRisk(controlState.goal);
  const parentHasGoalBinding = SHA256_PATTERN.test(parent.goalContractSha256 ?? "")
    && parent.risk !== undefined;
  const parentGoalBindingValid = parentHasGoalBinding
    && parent.goalContractSha256 === controlState.goalContractSha256
    && parent.risk?.riskMode === risk.riskMode
    && JSON.stringify(parent.risk?.riskCategories) === JSON.stringify(risk.riskCategories);
  const legacyParentBindingMissing = parent.goalContractSha256 === undefined
    && parent.risk === undefined;
  const invalidReason = parent.sourceFingerprint !== selected.sourceFingerprint
    ? "receipt_source_mismatch"
    : parent.status === "invalidated_by_concurrent_write"
      ? "source_mutated_during_verification"
      : "repair_plan_incomplete";
  const classification = profileImpact.decision === "targeted_profiles"
    ? classifyCommands({
      workspaceRoot,
      profiles: profilesDocument.profiles,
      selectedProfileIds: profileImpact.profileIds,
      files,
      parentReceipt: parent,
      currentContextFingerprint,
    })
    : {
      reusable: [],
      pending: [],
      blocked: [{ commandId: "__profile_impact__", issueCode: "repair_plan_incomplete" }],
    };
  if (invalidReason === "repair_plan_incomplete") {
    classification.blocked.push({
      commandId: "__active_receipt__",
      issueCode: "repair_plan_incomplete",
    });
  }
  if (!controlState.goalBindingValid || !parentGoalBindingValid) {
    classification.blocked.push({
      commandId: "__goal_contract__",
      issueCode: "repair_plan_incomplete",
    });
  }
  const plan = repairPlan({
    workspaceRoot,
    runId,
    selectedPacket: selected.packet,
    selectedPacketPath: selected.packetPath,
    selectedPacketSha256: sha256(selectedPacketBytes),
    active: receipts.active,
    invalidReason,
    classification,
    risk,
    packetAmbiguous: selected.ambiguous,
  });
  const planPath = path.join(executionRoot, "repair-plans", `${id}-plan.json`);
  writeJsonExclusiveAtomically(planPath, plan);
  const planRelative = relativeToWorkspace(workspaceRoot, planPath);
  const planSha256 = sha256(readFileSync(planPath));
  if (typeof onPlan === "function") {
    onPlan({
      plan,
      planPath: planRelative,
      planSha256,
    });
  }
  if (plan.planStatus !== "ready") {
    return {
      status: "repair_plan_incomplete",
      exitCode: 3,
      runId,
      repairPlanPath: planRelative,
      repairPlanSha256: planSha256,
      sourceFingerprint: selected.sourceFingerprint,
      reusableCommandIds: plan.reusableCommandIds,
      replayedCommandIds: [],
      issueCodes: ["repair_plan_incomplete"],
      nextAllowedAction: legacyParentBindingMissing
        ? "run_full_verification_to_bind_goal_and_risk"
        : "repair_plan_inputs_or_trusted_provenance",
      authorizationGranted: false,
    };
  }

  const replacementReceiptId = `${id}-receipt`;
  const repairControl = repairControlBinding({
    planPath: planRelative,
    planSha256,
    controlState,
    classification: { ...classification, risk },
  });
  if (!repairBindingsValid({
    workspaceRoot,
    executionRoot,
    packet: selected.packet,
    repairControl,
  })) {
    return {
      status: "repair_plan_incomplete",
      exitCode: 3,
      runId,
      repairPlanPath: planRelative,
      repairPlanSha256: planSha256,
      sourceFingerprint: selected.sourceFingerprint,
      reusableCommandIds: plan.reusableCommandIds,
      replayedCommandIds: [],
      issueCodes: ["repair_plan_incomplete"],
      nextAllowedAction: "repair_plan_inputs_or_trusted_provenance",
      authorizationGranted: false,
    };
  }
  const attemptPath = path.join(executionRoot, "repair-attempts", `${id}-attempt.json`);
  const attempt = attemptDocument({
    runId,
    id,
    planPath: planRelative,
    replacementReceiptId,
    repairControl,
  });
  writeJsonExclusiveAtomically(attemptPath, attempt);
  const attemptRelative = relativeToWorkspace(workspaceRoot, attemptPath);
  const replayed = [];
  for (const command of classification.pending) {
    if (!repairBindingsValid({
      workspaceRoot,
      executionRoot,
      packet: selected.packet,
      repairControl,
    })) {
      attempt.status = "repair_plan_incomplete";
      attempt.issueCodes = ["repair_plan_incomplete"];
      writeJsonAtomically(attemptPath, attempt);
      return resultForAttempt({
        status: attempt.status,
        exitCode: 3,
        runId,
        planPath: planRelative,
        planSha256,
        attemptPath: attemptRelative,
        replacementReceiptId,
        reusable: classification.reusable,
        replayed,
        sourceFingerprint: selected.sourceFingerprint,
        issueCodes: attempt.issueCodes,
        extra: { nextAllowedAction: "repair_plan_inputs_or_trusted_provenance" },
      });
    }
    const snapshotRequest = {
      schemaVersion: "OwlCodaRunKitSnapshotRequestV1",
      snapshotId: `${id}-${command.commandId}`,
      mode: "project",
      targetRoot: workspaceRoot,
      cwd: command.cwd,
      executable: command.executable,
      argv: [...command.argv],
      launcherVersion: "runkit-repair-v1",
      toolVersions: structuredClone(currentContext.toolchains),
      selectedPaths: [...command.selectedPaths],
      statusMode: STATUS_MODE,
      verificationContext: currentContext,
    };
    const snapshot = runSnapshot({ workspaceRoot, runId, request: snapshotRequest });
    const snapshotDocument = readJson(path.join(workspaceRoot, snapshot.snapshotPath));
    const commandAttempt = {
      commandId: command.commandId,
      snapshotPath: snapshot.snapshotPath,
      status: snapshotDocument.status,
      exitCode: snapshotDocument.command.exitCode,
    };
    attempt.commandAttempts.push(commandAttempt);
    replayed.push(commandAttempt);
    writeJsonAtomically(attemptPath, attempt);
    if (snapshotDocument.status === "snapshot_failed") {
      attempt.status = "repair_replay_failed";
      attempt.issueCodes = ["repair_replay_failed"];
      writeJsonAtomically(attemptPath, attempt);
      return resultForAttempt({
        status: attempt.status,
        exitCode: 1,
        runId,
        planPath: planRelative,
        planSha256,
        attemptPath: attemptRelative,
        replacementReceiptId,
        reusable: classification.reusable,
        replayed,
        sourceFingerprint: selected.sourceFingerprint,
        issueCodes: attempt.issueCodes,
        extra: { nextAllowedAction: "repair_failed_command_then_retry" },
      });
    }
    if (snapshotDocument.status !== "snapshot_passed"
      || verifyDeliveryPacket({ workspaceRoot, packet: selected.packet }).status !== "valid") {
      attempt.status = "repair_source_drift";
      attempt.issueCodes = ["source_mutated_during_verification"];
      writeJsonAtomically(attemptPath, attempt);
      return resultForAttempt({
        status: attempt.status,
        exitCode: 2,
        runId,
        planPath: planRelative,
        planSha256,
        attemptPath: attemptRelative,
        replacementReceiptId,
        reusable: classification.reusable,
        replayed,
        sourceFingerprint: selected.sourceFingerprint,
        issueCodes: attempt.issueCodes,
        extra: { nextAllowedAction: "replace_delivery_packet" },
      });
    }
  }

  const finalizeRequest = {
    schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
    receiptId: replacementReceiptId,
    deliveryPacketPath: relativeToWorkspace(workspaceRoot, selected.packetPath),
    verificationContext: currentContext,
    snapshotPaths: replayed.map(item => item.snapshotPath),
    supersedesReceiptSha256: receipts.active.receiptSha256,
    reusedCommandReceipts: classification.reusable.map(item =>
      structuredClone(item.commandReceipt)),
    repairControl,
  };
  const finalizeRequestPath = path.join(
    executionRoot,
    "repair-finalize-requests",
    `${id}-finalize-request.json`,
  );
  writeJsonExclusiveAtomically(finalizeRequestPath, finalizeRequest);
  let finalized;
  try {
    finalized = runFinalize({
      workspaceRoot,
      runId,
      request: finalizeRequest,
      hooks: {
        beforeReceiptPersist: onBeforeReceiptPersist,
        beforeLineageActivate: onBeforeLineageActivate,
      },
    });
  } catch (error) {
    attempt.status = "repair_finalize_failed";
    attempt.issueCodes = ["repair_plan_incomplete"];
    attempt.finalizeError = error instanceof Error ? error.message : String(error);
    writeJsonAtomically(attemptPath, attempt);
    return resultForAttempt({
      status: attempt.status,
      exitCode: 3,
      runId,
      planPath: planRelative,
      planSha256,
      attemptPath: attemptRelative,
      replacementReceiptId,
      reusable: classification.reusable,
      replayed,
      sourceFingerprint: selected.sourceFingerprint,
      issueCodes: attempt.issueCodes,
      extra: {
        nextAllowedAction: "inspect_repair_finalize_failure",
        finalizeError: attempt.finalizeError,
      },
    });
  }
  if (finalized.status !== "accepted_passed") {
    attempt.status = "repair_finalize_failed";
    attempt.issueCodes = ["repair_plan_incomplete"];
    writeJsonAtomically(attemptPath, attempt);
    return resultForAttempt({
      status: attempt.status,
      exitCode: 3,
      runId,
      planPath: planRelative,
      planSha256,
      attemptPath: attemptRelative,
      replacementReceiptId,
      reusable: classification.reusable,
      replayed,
      sourceFingerprint: selected.sourceFingerprint,
      issueCodes: attempt.issueCodes,
      extra: { nextAllowedAction: "inspect_repair_finalize_failure" },
    });
  }
  attempt.status = "repair_passed";
  attempt.activeReceiptSha256 = finalized.activeReceiptSha256;
  attempt.receiptPath = finalized.receiptPath;
  attempt.issueCodes = [];
  writeJsonAtomically(attemptPath, attempt);
  return resultForAttempt({
    status: "repaired",
    exitCode: 0,
    runId,
    planPath: planRelative,
    planSha256,
    attemptPath: attemptRelative,
    replacementReceiptId,
    reusable: classification.reusable,
    replayed,
    sourceFingerprint: selected.sourceFingerprint,
    extra: {
      receiptPath: finalized.receiptPath,
      activeReceiptSha256: finalized.activeReceiptSha256,
      nextAllowedAction: "independent_review_required",
    },
  });
}

export function runRepairExecution(options) {
  return withControlTransaction(
    options.workspaceRoot,
    () => runRepairWithinControlTransaction(options),
  );
}
