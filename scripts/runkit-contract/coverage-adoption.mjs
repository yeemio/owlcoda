import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { RUNTIME_ROOT } from "./core-contract.mjs";
import {
  assertAllowedKeys,
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  resolveExistingArtifact,
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonExclusive,
} from "./provenance-common.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = ["schemaVersion", "coverageId", "sources"];
const SOURCE_KEYS = [
  "gateInputPath",
  "gateInputSha256",
  "commandBindings",
  "dependencyBindings",
];
const COMMAND_BINDING_KEYS = ["receiptCommandId", "profileId", "commandId"];
const DEPENDENCY_BINDING_KEYS = ["dependencyId", "source"];
const DEPENDENCY_SOURCE_KEYS = ["kind", "identity"];

function ensureCoverageDirectory(executionRoot) {
  const executionStat = lstatSync(executionRoot);
  if (executionStat.isSymbolicLink() || !executionStat.isDirectory()) {
    throw new Error("Coverage execution root must be a regular directory, not a symlink.");
  }
  const resolvedExecution = realpathSync(executionRoot);
  const coverageRoot = path.join(executionRoot, "coverage-indexes");
  if (!existsSync(coverageRoot)) mkdirSync(coverageRoot);
  const coverageStat = lstatSync(coverageRoot);
  if (coverageStat.isSymbolicLink() || !coverageStat.isDirectory()) {
    throw new Error("Coverage output directory must be a regular directory, not a symlink.");
  }
  const resolvedCoverage = realpathSync(coverageRoot);
  const relative = path.relative(resolvedExecution, resolvedCoverage);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Coverage output directory escapes its execution root.");
  }
  return coverageRoot;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectedSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function sortedUniqueStrings(values) {
  return [...new Set(values)].sort();
}

function validateProfileRule(rule) {
  if (typeof rule !== "string" || rule.length === 0) {
    throw new Error("Profile path rules must be non-empty strings.");
  }
  const wildcardIndex = rule.indexOf("*");
  const prefix = wildcardIndex === -1
    ? rule
    : rule.endsWith("/**") && !rule.slice(0, -3).includes("*")
      ? rule.slice(0, -3)
      : null;
  if (prefix === null) throw new Error(`Unsupported profile path rule: ${rule}`);
  const safePrefix = safeRelativePath(prefix, "Profile path rule");
  if (safePrefix === RUNTIME_ROOT || safePrefix.startsWith(`${RUNTIME_ROOT}/`)) {
    throw new Error("Profile path rule uses the reserved RunKit runtime.");
  }
}

function validateProfileDocument(value) {
  if (!isRecord(value)
    || value.schemaVersion !== "OwlCodaRunKitProfilesV1"
    || !Array.isArray(value.profiles)) {
    throw new Error("Project profiles artifact is invalid.");
  }
  const profiles = new Map();
  for (const profile of value.profiles) {
    if (!isRecord(profile)
      || typeof profile.id !== "string"
      || profile.id.length === 0
      || !Array.isArray(profile.paths)
      || profile.paths.length === 0) {
      throw new Error("Each project profile requires id and paths.");
    }
    if (profiles.has(profile.id)) throw new Error(`Project profile ids must be unique: ${profile.id}`);
    for (const rule of profile.paths) validateProfileRule(rule);
    if (profile.commands !== undefined) {
      if (!Array.isArray(profile.commands)) throw new Error(`Profile commands must be an array: ${profile.id}`);
      const commandIds = new Set();
      for (const command of profile.commands) {
        if (!isRecord(command)
          || typeof command.id !== "string"
          || command.id.length === 0
          || typeof command.executable !== "string"
          || command.executable.length === 0
          || !Array.isArray(command.argv)
          || command.argv.some(argument => typeof argument !== "string" || argument.length === 0)) {
          throw new Error(`Profile command is invalid: ${profile.id}`);
        }
        safeRelativePath(command.cwd, "Profile command cwd", { allowDot: true });
        if (commandIds.has(command.id)) {
          throw new Error(`Profile command ids must be unique: ${profile.id}/${command.id}`);
        }
        commandIds.add(command.id);
      }
    }
    profiles.set(profile.id, profile);
  }
  return profiles;
}

function matchesRule(filePath, rule) {
  if (rule.endsWith("/**")) return filePath.startsWith(`${rule.slice(0, -3)}/`);
  return filePath === rule;
}

function launcherMatches(expected, actual) {
  if (expected === actual) return true;
  if (expected.includes("/") || expected.includes("\\")) return false;
  return path.basename(actual) === expected || path.win32.basename(actual) === expected;
}

function commandForBinding({ binding, receipt, profiles }) {
  const profile = profiles.get(binding.profileId);
  if (!profile) throw new Error(`Coverage profile does not exist: ${binding.profileId}`);
  if (!receipt.selectedProfileIds.includes(binding.profileId)) {
    throw new Error(`Coverage profile was not selected by the accepted receipt: ${binding.profileId}`);
  }
  const commands = Array.isArray(profile.commands) ? profile.commands : [];
  const command = commands.find(candidate => candidate?.id === binding.commandId);
  if (!command) {
    throw new Error(`Coverage command is not owned by profile ${binding.profileId}: ${binding.commandId}`);
  }
  const commandReceipt = receipt.commandReceipts.find(candidate => candidate?.id === binding.receiptCommandId);
  if (!commandReceipt) throw new Error(`Receipt command does not exist: ${binding.receiptCommandId}`);
  if (commandReceipt.exitCode !== 0) {
    throw new Error(`Receipt command did not pass: ${binding.receiptCommandId}`);
  }
  const evidence = commandReceipt.evidence;
  const exactArgv = [evidence?.launcher?.executable, ...(command.argv ?? [])];
  if (evidence?.cwd !== command.cwd
    || !launcherMatches(command.executable, evidence?.launcher?.executable ?? "")
    || JSON.stringify(evidence?.argv) !== JSON.stringify(exactArgv)) {
    throw new Error(`Exact command evidence mismatch: ${binding.receiptCommandId}`);
  }
  return { profile, command, evidence };
}

function materialInputs(boundCommands) {
  const inputs = new Map();
  for (const { evidence } of boundCommands) {
    for (const material of evidence.materialInputs ?? []) {
      const previous = inputs.get(material.id);
      if (previous && previous !== material.sha256) {
        throw new Error(`Material input has conflicting hashes: ${material.id}`);
      }
      inputs.set(material.id, material.sha256);
    }
  }
  return inputs;
}

function sourceFilesForBindings(boundCommands, inputs) {
  const sourceFiles = {};
  for (const [materialId, hash] of [...inputs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const covered = boundCommands.some(({ profile }) => profile.paths.some(rule => matchesRule(materialId, rule)));
    if (!covered) continue;
    const sourcePath = safeRelativePath(materialId, "Receipt material source path");
    if (sourcePath === RUNTIME_ROOT || sourcePath.startsWith(`${RUNTIME_ROOT}/`)) {
      throw new Error("Receipt material source path uses the reserved RunKit runtime.");
    }
    sourceFiles[sourcePath] = expectedSha256(hash, "Receipt material source hash");
  }
  if (Object.keys(sourceFiles).length === 0) {
    throw new Error("Coverage adoption found no profile-owned source material inputs.");
  }
  return sourceFiles;
}

function dependencySha256ForBindings(bindings, context, inputs) {
  const result = {};
  const seen = new Set();
  for (const binding of bindings) {
    assertAllowedKeys(binding, "Dependency binding", DEPENDENCY_BINDING_KEYS);
    safeIdentifier(binding.dependencyId, "dependencyId");
    if (seen.has(binding.dependencyId)) {
      throw new Error(`Dependency bindings must be unique: ${binding.dependencyId}`);
    }
    seen.add(binding.dependencyId);
    if (!isRecord(binding.source)) throw new Error("Dependency binding source must be an object.");
    assertAllowedKeys(binding.source, "Dependency binding source", DEPENDENCY_SOURCE_KEYS);
    if (typeof binding.source.identity !== "string" || binding.source.identity.length === 0) {
      throw new Error("Dependency binding identity is required.");
    }
    let hash = null;
    if (binding.source.kind === "lockfile") {
      hash = context.lockfiles.find(candidate => candidate.path === binding.source.identity)?.sha256 ?? null;
    } else if (binding.source.kind === "fixture") {
      hash = context.fixtures.find(candidate => candidate.id === binding.source.identity)?.sha256 ?? null;
    } else if (binding.source.kind === "material_input") {
      hash = inputs.get(binding.source.identity) ?? null;
    } else {
      throw new Error(`Unsupported dependency source kind: ${binding.source.kind}`);
    }
    if (hash === null) {
      throw new Error(`Declared dependency evidence is missing: ${binding.dependencyId}`);
    }
    result[binding.dependencyId] = expectedSha256(hash, "Declared dependency evidence hash");
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function validateSourceRequest(value) {
  assertAllowedKeys(value, "Coverage source", SOURCE_KEYS);
  if (typeof value.gateInputPath !== "string"
    || value.gateInputPath.length === 0
    || !value.gateInputPath.startsWith(`${RUNTIME_ROOT}/`)) {
    throw new Error("Coverage gateInputPath must reference a project RunKit artifact.");
  }
  expectedSha256(value.gateInputSha256, "gateInputSha256");
  if (!Array.isArray(value.commandBindings) || value.commandBindings.length === 0) {
    throw new Error("Coverage source requires commandBindings.");
  }
  if (!Array.isArray(value.dependencyBindings)) {
    throw new Error("Coverage source requires dependencyBindings.");
  }
}

function adoptSource({ workspaceRoot, source, profiles }) {
  validateSourceRequest(source);
  const gatePath = resolveExistingArtifact(workspaceRoot, source.gateInputPath, "gateInputPath");
  const normalizedGatePath = relativeToWorkspace(workspaceRoot, gatePath);
  const gateBytes = readFileSync(gatePath);
  const actualGateSha256 = sha256(gateBytes);
  if (actualGateSha256 !== source.gateInputSha256) throw new Error("Gate input hash mismatch.");
  const gateInput = JSON.parse(gateBytes.toString("utf8"));
  const gate = validateVerificationReceiptGate(gateInput);
  if (!gate.accepted || gate.contractVersion !== "0.2" || gate.decision !== "accepted_passed") {
    const details = gate.issues.map(issue => issue.message).join("; ");
    throw new Error(`Coverage source gate is not an accepted Contract v0.2 gate: ${details}`);
  }
  const active = gate.lineage.active;
  const receipt = active.receipt;
  if (receipt.status !== "passed") throw new Error("Coverage source active receipt did not pass.");
  const receiptCommandIds = receipt.commandReceipts.map(command => command.id);
  if (receiptCommandIds.some(id => typeof id !== "string" || id.length === 0)
    || new Set(receiptCommandIds).size !== receiptCommandIds.length) {
    throw new Error("Accepted receipt command ids must be unique non-empty strings.");
  }

  const commandBindingIds = new Set();
  const commandIds = new Set();
  const profileIds = new Set();
  const normalizedCommandBindings = [];
  const boundCommands = source.commandBindings.map(binding => {
    assertAllowedKeys(binding, "Command binding", COMMAND_BINDING_KEYS);
    for (const [field, label] of [
      ["receiptCommandId", "receiptCommandId"],
      ["profileId", "profileId"],
      ["commandId", "commandId"],
    ]) safeIdentifier(binding[field], label);
    if (commandBindingIds.has(binding.receiptCommandId)) {
      throw new Error(`Receipt command bindings must be unique: ${binding.receiptCommandId}`);
    }
    if (commandIds.has(binding.commandId)) {
      throw new Error(`Coverage command ids must be unique per receipt: ${binding.commandId}`);
    }
    commandBindingIds.add(binding.receiptCommandId);
    commandIds.add(binding.commandId);
    profileIds.add(binding.profileId);
    normalizedCommandBindings.push({
      receiptCommandId: binding.receiptCommandId,
      profileId: binding.profileId,
      commandId: binding.commandId,
    });
    return commandForBinding({ binding, receipt, profiles });
  });
  const inputs = materialInputs(boundCommands);
  const dependencySha256 = dependencySha256ForBindings(
    source.dependencyBindings,
    gateInput.verificationContext,
    inputs,
  );
  const normalizedDependencyBindings = source.dependencyBindings.map(binding => ({
    dependencyId: binding.dependencyId,
    source: {
      kind: binding.source.kind,
      identity: binding.source.identity,
    },
  }));
  return {
    generatedFrom: {
      gateInputPath: normalizedGatePath,
      gateInputSha256: actualGateSha256,
      commandBindings: normalizedCommandBindings,
      dependencyBindings: normalizedDependencyBindings,
      activeReceiptSha256: active.receiptSha256,
      sourceRunId: receipt.runId,
    },
    entry: {
      receiptId: receipt.receiptId,
      receiptSha256: active.receiptSha256,
      status: "passed",
      sourceFiles: sourceFilesForBindings(boundCommands, inputs),
      dependencySha256,
      verificationContextFingerprint: receipt.verificationContextFingerprint,
      profileIds: sortedUniqueStrings(profileIds),
      commandIds: sortedUniqueStrings(commandIds),
    },
  };
}

function validateRequest(request) {
  assertAllowedKeys(request, "Coverage-adopt request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitCoverageAdoptRequestV1") {
    throw new Error("Unsupported coverage-adopt request schemaVersion.");
  }
  safeIdentifier(request.coverageId, "coverageId");
  if (!Array.isArray(request.sources)) {
    throw new Error("Coverage-adopt request requires sources.");
  }
}

function deriveCoverageIndex({ workspaceRoot, runId, coverageId, sources }) {
  const profiles = validateProfileDocument(readJson(path.join(workspaceRoot, RUNTIME_ROOT, "profiles.json")));
  const adopted = sources.map(source => adoptSource({ workspaceRoot, source, profiles }));
  const receiptIds = adopted.map(item => item.entry.receiptId);
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("Adopted receipt ids must be unique.");
  }
  return {
    schemaVersion: "OwlCodaRunKitEvidenceCoverageIndexV1",
    coverageId,
    runId,
    generatedFrom: adopted.map(item => item.generatedFrom)
      .sort((left, right) => left.activeReceiptSha256.localeCompare(right.activeReceiptSha256)),
    entries: adopted.map(item => item.entry)
      .sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    authorizationGranted: false,
  };
}

export function buildCoverageIndex({ workspaceRoot, runId, request }) {
  validateRequest(request);
  return deriveCoverageIndex({
    workspaceRoot,
    runId,
    coverageId: request.coverageId,
    sources: request.sources,
  });
}

export function validateCoverageIndexArtifact({ workspaceRoot, runId, coverageIndex }) {
  if (!isRecord(coverageIndex)
    || coverageIndex.schemaVersion !== "OwlCodaRunKitEvidenceCoverageIndexV1"
    || coverageIndex.runId !== runId
    || typeof coverageIndex.coverageId !== "string"
    || !Array.isArray(coverageIndex.generatedFrom)) {
    throw new Error("Coverage index cannot be revalidated.");
  }
  const sources = coverageIndex.generatedFrom.map(source => ({
    gateInputPath: source.gateInputPath,
    gateInputSha256: source.gateInputSha256,
    commandBindings: source.commandBindings,
    dependencyBindings: source.dependencyBindings,
  }));
  const derived = deriveCoverageIndex({
    workspaceRoot,
    runId,
    coverageId: coverageIndex.coverageId,
    sources,
  });
  if (JSON.stringify(derived) !== JSON.stringify(coverageIndex)) {
    throw new Error("Coverage index no longer matches its receipt-backed source evidence.");
  }
  return derived;
}

export function runCoverageAdoption({ workspaceRoot, runId, request }) {
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  if (existsSync(path.join(executionRoot, "closeout-receipt.json"))) {
    throw new Error(`Cannot adopt coverage into closed execution: ${runId}`);
  }
  const coverageIndex = buildCoverageIndex({ workspaceRoot, runId, request });
  const outputPath = path.join(ensureCoverageDirectory(executionRoot), `${request.coverageId}.json`);
  writeJsonExclusive(outputPath, coverageIndex);
  return {
    status: "coverage_index_written",
    exitCode: 0,
    runId,
    coverageIndexPath: relativeToWorkspace(workspaceRoot, outputPath),
    coverageIndexSha256: sha256(readFileSync(outputPath)),
    authorizationGranted: false,
  };
}
