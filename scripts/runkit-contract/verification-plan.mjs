import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path, { isAbsolute, win32 } from "node:path";

import { RUNTIME_ROOT } from "./core-contract.mjs";
import { validateCoverageIndexArtifact } from "./coverage-adoption.mjs";
import { resolveProfileImpactDetailed } from "./profile-impact.mjs";
import {
  assertAllowedKeys,
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  resolveExistingArtifact,
  safeIdentifier,
  safeRelativePath,
  sha256 as hashBytes,
  writeJsonExclusive,
} from "./provenance-common.mjs";
import {
  validateVerificationContext,
  verificationContextFingerprint,
} from "./verification-context.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_MODE = "porcelain-v1-z-untracked-all-runkit-excluded";
const REQUEST_KEYS = [
  "schemaVersion",
  "planId",
  "deliveryPacketPath",
  "statusMode",
  "dependencies",
  "verificationContext",
  "coverageIndexPath",
  "coverageIndexSha256",
  "globalGates",
];
const COVERAGE_INDEX_KEYS = [
  "schemaVersion",
  "coverageId",
  "runId",
  "generatedFrom",
  "entries",
  "authorizationGranted",
];
const COVERAGE_SOURCE_KEYS = [
  "gateInputPath",
  "gateInputSha256",
  "commandBindings",
  "dependencyBindings",
  "activeReceiptSha256",
  "sourceRunId",
];
const COVERAGE_ENTRY_KEYS = [
  "receiptId",
  "receiptSha256",
  "status",
  "sourceFiles",
  "dependencySha256",
  "verificationContextFingerprint",
  "profileIds",
  "commandIds",
];
const COMMAND_BINDING_KEYS = ["receiptCommandId", "profileId", "commandId"];
const DEPENDENCY_BINDING_KEYS = ["dependencyId", "source"];
const DEPENDENCY_SOURCE_KEYS = ["kind", "identity"];

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must contain non-empty strings.`);
  }
  return [...new Set(values)].sort();
}

function safePath(value, label) {
  if (typeof value !== "string"
    || value.length === 0
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
  const segments = value.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, dot, or parent segments.`);
  }
  if (value === ".owlcoda/runkit" || value.startsWith(".owlcoda/runkit/")) {
    throw new Error(`${label} uses the reserved runtime path .owlcoda/runkit.`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function normalizeFileMap(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const normalized = {};
  for (const [filePath, hash] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    normalized[safePath(filePath, `${label} path`)] = sha256(hash, `${label} hash`);
  }
  return normalized;
}

function normalizeDependencies(values) {
  if (!Array.isArray(values)) throw new Error("dependencies must be an array.");
  const seen = new Set();
  return values.map(value => {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
      throw new Error("Each dependency requires an id.");
    }
    if (seen.has(value.id)) throw new Error(`Dependency ids must be unique: ${value.id}`);
    seen.add(value.id);
    return {
      id: value.id,
      path: safePath(value.path, "Dependency path"),
      baselineSha256: sha256(value.baselineSha256, "Dependency baselineSha256"),
      currentSha256: value.currentSha256 === null
        ? null
        : sha256(value.currentSha256, "Dependency currentSha256"),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeGlobalGates(values) {
  if (!Array.isArray(values)) throw new Error("globalGates must be an array.");
  const seen = new Set();
  return values.map(value => {
    if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
      throw new Error("Each global gate requires an id.");
    }
    if (seen.has(value.id)) throw new Error(`Global gate ids must be unique: ${value.id}`);
    seen.add(value.id);
    if (!new Set(["passed", "failed"]).has(value.status)) {
      throw new Error("Global gate status must be passed or failed.");
    }
    if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length === 0)) {
      throw new Error("Global gate reason must be a non-empty string when provided.");
    }
    return { id: value.id, status: value.status, reason: value.reason ?? null };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeCoverageIndex(value) {
  if (!isRecord(value)
    || value.schemaVersion !== "OwlCodaRunKitEvidenceCoverageIndexV1"
    || typeof value.coverageId !== "string"
    || value.coverageId.length === 0
    || typeof value.runId !== "string"
    || value.runId.length === 0
    || !Array.isArray(value.generatedFrom)
    || !Array.isArray(value.entries)
    || value.authorizationGranted !== false) {
    throw new Error("coverageIndex must be OwlCodaRunKitEvidenceCoverageIndexV1.");
  }
  assertAllowedKeys(value, "Coverage index", COVERAGE_INDEX_KEYS);
  const generatedReceiptHashes = new Set();
  for (const source of value.generatedFrom) {
    if (!isRecord(source)
      || typeof source.gateInputPath !== "string"
      || source.gateInputPath.length === 0
      || typeof source.sourceRunId !== "string"
      || source.sourceRunId.length === 0) {
      throw new Error("Coverage generatedFrom entries are invalid.");
    }
    assertAllowedKeys(source, "Coverage generatedFrom entry", COVERAGE_SOURCE_KEYS);
    const gateInputPath = safeRelativePath(source.gateInputPath, "Coverage gateInputPath");
    if (!gateInputPath.startsWith(`${RUNTIME_ROOT}/`)) {
      throw new Error("Coverage gateInputPath must reference a project RunKit artifact.");
    }
    sha256(source.gateInputSha256, "Coverage gateInputSha256");
    sha256(source.activeReceiptSha256, "Coverage activeReceiptSha256");
    if (!Array.isArray(source.commandBindings) || source.commandBindings.length === 0) {
      throw new Error("Coverage generatedFrom entry requires commandBindings.");
    }
    for (const binding of source.commandBindings) {
      assertAllowedKeys(binding, "Coverage command binding", COMMAND_BINDING_KEYS);
      safeIdentifier(binding.receiptCommandId, "Coverage receiptCommandId");
      safeIdentifier(binding.profileId, "Coverage profileId");
      safeIdentifier(binding.commandId, "Coverage commandId");
    }
    if (!Array.isArray(source.dependencyBindings)) {
      throw new Error("Coverage generatedFrom entry requires dependencyBindings.");
    }
    for (const binding of source.dependencyBindings) {
      assertAllowedKeys(binding, "Coverage dependency binding", DEPENDENCY_BINDING_KEYS);
      safeIdentifier(binding.dependencyId, "Coverage dependencyId");
      if (!isRecord(binding.source)) throw new Error("Coverage dependency source must be an object.");
      assertAllowedKeys(binding.source, "Coverage dependency source", DEPENDENCY_SOURCE_KEYS);
      if (!new Set(["lockfile", "fixture", "material_input"]).has(binding.source.kind)
        || typeof binding.source.identity !== "string"
        || binding.source.identity.length === 0) {
        throw new Error("Coverage dependency source is invalid.");
      }
    }
    if (generatedReceiptHashes.has(source.activeReceiptSha256)) {
      throw new Error(`Coverage generated receipt hashes must be unique: ${source.activeReceiptSha256}`);
    }
    generatedReceiptHashes.add(source.activeReceiptSha256);
  }
  const seen = new Set();
  const entries = value.entries.map(entry => {
    if (!isRecord(entry) || typeof entry.receiptId !== "string" || entry.receiptId.length === 0) {
      throw new Error("Each coverage entry requires receiptId.");
    }
    assertAllowedKeys(entry, "Coverage entry", COVERAGE_ENTRY_KEYS);
    if (seen.has(entry.receiptId)) throw new Error(`Coverage receipt ids must be unique: ${entry.receiptId}`);
    seen.add(entry.receiptId);
    if (!new Set(["passed", "ready_for_verification", "shadow_validated", "invalidated_by_concurrent_write"]).has(entry.status)) {
      throw new Error("Coverage entry status is invalid.");
    }
    if (!isRecord(entry.dependencySha256)) throw new Error("dependencySha256 must be an object.");
    const dependencySha256 = {};
    for (const [id, hash] of Object.entries(entry.dependencySha256).sort(([left], [right]) => left.localeCompare(right))) {
      if (!id) throw new Error("Coverage dependency id must be non-empty.");
      dependencySha256[id] = sha256(hash, "Coverage dependency hash");
    }
    return {
      receiptId: entry.receiptId,
      receiptSha256: sha256(entry.receiptSha256, "Coverage receiptSha256"),
      status: entry.status,
      sourceFiles: normalizeFileMap(entry.sourceFiles, "Coverage sourceFiles"),
      dependencySha256,
      verificationContextFingerprint: sha256(
        entry.verificationContextFingerprint,
        "Coverage verificationContextFingerprint",
      ),
      profileIds: sortedUniqueStrings(entry.profileIds, "Coverage profileIds"),
      commandIds: sortedUniqueStrings(entry.commandIds, "Coverage commandIds"),
    };
  }).sort((left, right) => left.receiptId.localeCompare(right.receiptId));
  const entryReceiptHashes = new Set(entries.map(entry => entry.receiptSha256));
  if (generatedReceiptHashes.size !== entryReceiptHashes.size
    || [...generatedReceiptHashes].some(hash => !entryReceiptHashes.has(hash))) {
    throw new Error("Coverage generatedFrom hashes must match entry receipt hashes.");
  }
  return entries;
}

function normalizeCommands(profiles) {
  const commands = new Map();
  for (const profile of profiles) {
    if (profile.commands === undefined) continue;
    if (!Array.isArray(profile.commands)) throw new Error("Profile commands must be an array.");
    for (const command of profile.commands) {
      if (!isRecord(command) || typeof command.id !== "string" || command.id.length === 0) {
        throw new Error("Each profile command requires an id.");
      }
      const normalized = {
        id: command.id,
        cwd: command.cwd,
        executable: command.executable,
        argv: command.argv,
      };
      if (command.cwd !== ".") safePath(command.cwd, "Profile command cwd");
      if (typeof command.executable !== "string" || command.executable.length === 0) {
        throw new Error("Profile command executable is required.");
      }
      sortedUniqueStrings(command.argv, "Profile command argv");
      const previous = commands.get(command.id);
      if (previous && JSON.stringify(previous.definition) !== JSON.stringify(normalized)) {
        throw new Error(`Profile command id has conflicting definitions: ${command.id}`);
      }
      if (previous) previous.profileIds.add(profile.id);
      else commands.set(command.id, { definition: normalized, profileIds: new Set([profile.id]) });
    }
  }
  return commands;
}

function matchesOwnedPath(filePath, ownedPath) {
  if (ownedPath.endsWith("/**")) return filePath.startsWith(`${ownedPath.slice(0, -3)}/`);
  return filePath === ownedPath;
}

export function buildVerificationPlan(input) {
  if (!isRecord(input) || input.schemaVersion !== "OwlCodaRunKitVerifyPlanRequestV1") {
    throw new Error("Unsupported verify-plan request schemaVersion.");
  }
  if (typeof input.runId !== "string" || input.runId.length === 0) throw new Error("runId is required.");
  if (typeof input.planId !== "string" || input.planId.length === 0) throw new Error("planId is required.");

  const ownedPaths = sortedUniqueStrings(input.ownedPaths, "ownedPaths");
  for (const ownedPath of ownedPaths) {
    const prefix = ownedPath.endsWith("/**") ? ownedPath.slice(0, -3) : ownedPath;
    safePath(prefix, "ownedPaths entry");
  }
  const changedPaths = sortedUniqueStrings(input.changedPaths, "changedPaths");
  for (const changedPath of changedPaths) safePath(changedPath, "changedPaths entry");
  const currentSourceFiles = normalizeFileMap(input.currentSourceFiles, "currentSourceFiles");
  const dependencies = normalizeDependencies(input.dependencies);
  const dependencyByPath = new Map(dependencies.map(dependency => [dependency.path, dependency]));
  const dependencyById = new Map(dependencies.map(dependency => [dependency.id, dependency]));
  const contextFingerprint = sha256(
    input.verificationContextFingerprint,
    "verificationContextFingerprint",
  );
  if (!Array.isArray(input.profiles)) throw new Error("profiles must be an array.");
  const commandById = normalizeCommands(input.profiles);
  const coverage = normalizeCoverageIndex(input.coverageIndex);
  if (input.coverageIndex.runId !== input.runId) {
    throw new Error("Coverage index runId does not match the verification plan run.");
  }
  const profileIds = new Set(input.profiles.map(profile => profile.id));
  for (const entry of coverage) {
    for (const profileId of entry.profileIds) {
      if (!profileIds.has(profileId)) throw new Error(`Coverage profile does not exist: ${profileId}`);
    }
    for (const commandId of entry.commandIds) {
      const command = commandById.get(commandId);
      if (!command) throw new Error(`Coverage command does not exist: ${commandId}`);
      if (!entry.profileIds.some(profileId => command.profileIds.has(profileId))) {
        throw new Error(`Coverage command ${commandId} is not owned by its declared profiles.`);
      }
    }
  }
  const globalGates = normalizeGlobalGates(input.globalGates);

  const leasedSourceDrift = [];
  const unrelatedDirtyTreeDrift = [];
  for (const changedPath of changedPaths) {
    if (dependencyByPath.has(changedPath)) continue;
    if (ownedPaths.some(ownedPath => matchesOwnedPath(changedPath, ownedPath))) leasedSourceDrift.push(changedPath);
    else unrelatedDirtyTreeDrift.push(changedPath);
  }
  const declaredDependencyDrift = dependencies
    .filter(dependency => dependency.baselineSha256 !== dependency.currentSha256)
    .map(dependency => dependency.id);
  const globalGateFailures = globalGates
    .filter(gate => gate.status === "failed")
    .map(gate => gate.id);

  const affectedPaths = [
    ...leasedSourceDrift,
    ...dependencies
      .filter(dependency => declaredDependencyDrift.includes(dependency.id))
      .map(dependency => dependency.path),
  ];
  const profileImpact = resolveProfileImpactDetailed({
    changedPaths: affectedPaths,
    profiles: input.profiles,
  });

  const reusableReceiptIds = [];
  const invalidatedReceipts = [];
  const reusableCommandIds = new Set();
  for (const entry of coverage) {
    const reasons = [];
    if (entry.status !== "passed") reasons.push(`receipt_status:${entry.status}`);
    for (const [filePath, expectedHash] of Object.entries(entry.sourceFiles)) {
      if (currentSourceFiles[filePath] !== expectedHash) reasons.push(`leased_source_drift:${filePath}`);
    }
    for (const [dependencyId, expectedHash] of Object.entries(entry.dependencySha256)) {
      const current = dependencyById.get(dependencyId)?.currentSha256;
      if (current !== expectedHash) reasons.push(`declared_dependency_drift:${dependencyId}`);
    }
    if (entry.verificationContextFingerprint !== contextFingerprint) reasons.push("verification_context_drift");
    const normalizedReasons = [...new Set(reasons)].sort();
    if (normalizedReasons.length > 0) {
      invalidatedReceipts.push({ receiptId: entry.receiptId, reasons: normalizedReasons });
      continue;
    }
    reusableReceiptIds.push(entry.receiptId);
    for (const commandId of entry.commandIds) reusableCommandIds.add(commandId);
  }

  const requiredCommandIds = [];
  const unmappedProfileIds = [];
  for (const profileId of profileImpact.selectedProfileIds) {
    const profile = input.profiles.find(candidate => candidate.id === profileId);
    if (!Array.isArray(profile?.commands) || profile.commands.length === 0) {
      unmappedProfileIds.push(profileId);
      continue;
    }
    for (const command of profile?.commands ?? []) requiredCommandIds.push(command.id);
  }
  const required = [...new Set(requiredCommandIds)].sort();
  for (const commandId of required) {
    if (!commandById.has(commandId)) throw new Error(`Selected profile command is not defined: ${commandId}`);
  }
  const reused = required.filter(commandId => reusableCommandIds.has(commandId));
  const pending = required.filter(commandId => !reusableCommandIds.has(commandId));
  const pendingCommands = pending.map(commandId => {
    const command = commandById.get(commandId);
    return {
      ...command.definition,
      argv: [...command.definition.argv],
      profileIds: [...command.profileIds].sort(),
    };
  });

  const acceptanceReasons = [
    ...globalGateFailures.map(gateId => `global_gate_failure:${gateId}`),
    ...(profileImpact.decision === "full_profile_required" ? ["full_profile_required"] : []),
    ...unmappedProfileIds.map(profileId => `verification_command_mapping_missing:${profileId}`),
  ].sort();
  const status = profileImpact.decision === "full_profile_required"
    ? "full_profile_required"
    : globalGateFailures.length > 0
      ? "blocked_by_global_gate"
      : unmappedProfileIds.length > 0
        ? "verification_mapping_required"
      : pending.length > 0
        ? "verification_required"
        : "ready_to_finalize";

  return {
    schemaVersion: "OwlCodaRunKitVerificationPlanV1",
    runId: input.runId,
    planId: input.planId,
    verificationContextFingerprint: contextFingerprint,
    status,
    drift: {
      leasedSourceDrift,
      declaredDependencyDrift,
      unrelatedDirtyTreeDrift,
      globalGateFailures,
    },
    profileImpact,
    evidence: {
      ...(input.coverageIndexPath === undefined ? {} : {
        coverageIndexPath: safeRelativePath(input.coverageIndexPath, "coverageIndexPath"),
        coverageIndexSha256: sha256(input.coverageIndexSha256, "coverageIndexSha256"),
      }),
      reusableReceiptIds,
      invalidatedReceipts,
    },
    commands: {
      requiredCommandIds: required,
      reusedCommandIds: reused,
      pendingCommandIds: pending,
      unmappedProfileIds,
      pendingCommands,
    },
    acceptance: {
      blocked: acceptanceReasons.length > 0,
      reasons: acceptanceReasons,
    },
    authorizationGranted: false,
  };
}

function gitStatusPaths(workspaceRoot) {
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
  const paths = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Git status emitted a malformed porcelain entry.");
    const status = entry.slice(0, 2);
    paths.push(safePath(entry.slice(3), "Git status path"));
    if (status.includes("R") || status.includes("C")) {
      const priorPath = entries[index + 1];
      if (!priorPath) throw new Error("Git status rename entry is incomplete.");
      paths.push(safePath(priorPath, "Git status prior path"));
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function deliveryFiles(packet) {
  const files = packet?.changedFiles?.files ?? packet?.changedFiles?.wholeFileSha256;
  if (!isRecord(files) || Object.keys(files).length === 0) {
    throw new Error("Delivery packet must declare changed files.");
  }
  return normalizeFileMap(files, "Delivery packet changed files");
}

function workspaceFileSha256(workspaceRoot, filePath, label) {
  const safe = safeRelativePath(filePath, label);
  const absolutePath = path.resolve(workspaceRoot, safe);
  if (!existsSync(absolutePath)) return null;
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file.`);
  return hashBytes(readFileSync(realpathSync(absolutePath)));
}

function loadOwnedPaths(executionRoot) {
  const leasesRoot = path.join(executionRoot, "leases");
  if (!existsSync(leasesRoot)) return [];
  const ownedPaths = [];
  for (const entry of readdirSync(leasesRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const lease = readJson(path.join(leasesRoot, entry.name));
    if (!Array.isArray(lease.ownedPaths)) throw new Error(`Lease ownedPaths are invalid: ${entry.name}`);
    for (const ownedPath of lease.ownedPaths) ownedPaths.push(ownedPath);
  }
  return sortedUniqueStrings(ownedPaths, "Lease ownedPaths");
}

function validateRunRequest(request) {
  assertAllowedKeys(request, "Verify-plan request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitVerifyPlanRequestV1") {
    throw new Error("Unsupported verify-plan request schemaVersion.");
  }
  safeIdentifier(request.planId, "planId");
  if (typeof request.deliveryPacketPath !== "string" || request.deliveryPacketPath.length === 0) {
    throw new Error("Verify-plan request requires deliveryPacketPath.");
  }
  if (request.statusMode !== STATUS_MODE) {
    throw new Error(`Verify-plan statusMode must be ${STATUS_MODE}.`);
  }
  const context = validateVerificationContext(request.verificationContext);
  if (!context.valid) throw new Error(`Verify-plan verification context is invalid: ${context.issues.join("; ")}`);
  if (typeof request.coverageIndexPath !== "string" || request.coverageIndexPath.length === 0) {
    throw new Error("Verify-plan request requires coverageIndexPath.");
  }
  sha256(request.coverageIndexSha256, "coverageIndexSha256");
  normalizeGlobalGates(request.globalGates);
  if (!Array.isArray(request.dependencies)) throw new Error("Verify-plan dependencies must be an array.");
}

export function runVerifyPlan({ workspaceRoot, runId, request }) {
  validateRunRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  const packetPath = resolveExistingArtifact(workspaceRoot, request.deliveryPacketPath, "deliveryPacketPath");
  const packet = readJson(packetPath);
  if (packet.runId !== runId) throw new Error("Delivery packet runId does not match the execution.");
  const packetFiles = deliveryFiles(packet);
  const coveragePath = resolveExistingArtifact(
    workspaceRoot,
    request.coverageIndexPath,
    "coverageIndexPath",
  );
  const coverageRoot = path.join(executionRoot, "coverage-indexes");
  const coverageRemainder = path.relative(coverageRoot, coveragePath);
  if (coverageRemainder === ""
    || coverageRemainder === ".."
    || coverageRemainder.startsWith(`..${path.sep}`)
    || path.isAbsolute(coverageRemainder)) {
    throw new Error("Coverage index must be inside the active execution coverage-indexes directory.");
  }
  const normalizedCoveragePath = relativeToWorkspace(workspaceRoot, coveragePath);
  const coverageBytes = readFileSync(coveragePath);
  const actualCoverageSha256 = hashBytes(coverageBytes);
  if (actualCoverageSha256 !== request.coverageIndexSha256) {
    throw new Error("Coverage index hash mismatch.");
  }
  const coverageIndex = JSON.parse(coverageBytes.toString("utf8"));
  const coverage = normalizeCoverageIndex(coverageIndex);
  if (coverageIndex.runId !== runId) throw new Error("Coverage index runId does not match the execution.");
  validateCoverageIndexArtifact({ workspaceRoot, runId, coverageIndex });
  const sourcePaths = new Set(Object.keys(packetFiles));
  for (const entry of coverage) {
    for (const filePath of Object.keys(entry.sourceFiles)) sourcePaths.add(filePath);
  }
  const currentSourceFiles = {};
  for (const filePath of [...sourcePaths].sort()) {
    const current = workspaceFileSha256(workspaceRoot, filePath, "Verification source path");
    if (current !== null) currentSourceFiles[filePath] = current;
  }
  const dependencies = request.dependencies.map(dependency => ({
    ...dependency,
    currentSha256: workspaceFileSha256(workspaceRoot, dependency.path, "Dependency path"),
  }));
  const profiles = readJson(path.join(workspaceRoot, RUNTIME_ROOT, "profiles.json"));
  if (profiles.schemaVersion !== "OwlCodaRunKitProfilesV1" || !Array.isArray(profiles.profiles)) {
    throw new Error("Project profiles artifact is invalid.");
  }
  const contextFingerprint = verificationContextFingerprint(request.verificationContext);
  const plan = buildVerificationPlan({
    schemaVersion: request.schemaVersion,
    runId,
    planId: request.planId,
    ownedPaths: loadOwnedPaths(executionRoot),
    changedPaths: gitStatusPaths(workspaceRoot),
    currentSourceFiles,
    dependencies,
    verificationContextFingerprint: contextFingerprint,
    profiles: profiles.profiles,
    coverageIndex: coverageIndex,
    coverageIndexPath: normalizedCoveragePath,
    coverageIndexSha256: actualCoverageSha256,
    globalGates: request.globalGates,
  });
  const planPath = path.join(executionRoot, "verification-plans", `${request.planId}.json`);
  writeJsonExclusive(planPath, plan);
  return {
    status: "verification_plan_written",
    exitCode: 0,
    runId,
    planPath: relativeToWorkspace(workspaceRoot, planPath),
    authorizationGranted: false,
  };
}
