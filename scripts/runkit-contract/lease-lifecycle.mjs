import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import {
  RUNTIME_ROOT,
  acceptedCloseoutVerificationIssues,
  validateCoreArtifact,
  validateExecutionPin,
  validateLeaseOwnedPaths,
} from "./core-contract.mjs";
import {
  assertAllowedKeys,
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  safeIdentifier,
  writeJsonAtomically,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";

const LEASE_KEYS = ["schemaVersion", "workItemId", "attempt", "ownedPaths", "state"];

function validateOwnedPatterns(paths) {
  for (const ownedPath of paths) {
    if (ownedPath.includes("*")
      && (!ownedPath.endsWith("/**") || ownedPath.slice(0, -3).includes("*"))) {
      throw new Error(`Lease owned path uses an unsupported wildcard: ${ownedPath}`);
    }
  }
  return paths;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeDirectory(root, candidate, label) {
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`${label} root must be a regular directory, not a symlink.`);
  }
  const candidateStat = lstatSync(candidate);
  if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
    throw new Error(`${label} must be a regular directory, not a symlink.`);
  }
  const realRoot = realpathSync(root);
  const realCandidate = realpathSync(candidate);
  if (realCandidate !== path.resolve(candidate)) {
    throw new Error(`${label} must be a real directory without symlink ancestors.`);
  }
  if (!within(realRoot, realCandidate)) {
    throw new Error(`${label} escapes its artifact root.`);
  }
  return candidate;
}

function validateLease(value, label) {
  assertAllowedKeys(value, label, LEASE_KEYS);
  if (value.schemaVersion !== "OwlCodaRunKitWorkerLeaseV1") {
    throw new Error(`${label} schemaVersion is invalid.`);
  }
  safeIdentifier(value.workItemId, `${label} workItemId`);
  if (!Number.isInteger(value.attempt) || value.attempt < 1) {
    throw new Error(`${label} attempt must be a positive integer.`);
  }
  const ownedPaths = validateOwnedPatterns(validateLeaseOwnedPaths(value.ownedPaths));
  if (!new Set(["active", "released"]).has(value.state)) {
    throw new Error(`${label} state must be active or released.`);
  }
  return { ...value, ownedPaths };
}

export function listLeaseArtifacts({ workspaceRoot, executionRoot }) {
  const leasesRoot = safeDirectory(executionRoot, path.join(executionRoot, "leases"), "Lease directory");
  const leases = [];
  for (const entry of readdirSync(leasesRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink()) throw new Error(`Lease artifact must not be a symlink: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Lease artifact must be a regular file: ${entry.name}`);
    const leasePath = path.join(leasesRoot, entry.name);
    const stat = lstatSync(leasePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Lease artifact must be a regular file: ${entry.name}`);
    leases.push({
      ...validateLease(JSON.parse(readFileSync(realpathSync(leasePath), "utf8")), `Lease ${entry.name}`),
      leasePath,
      leaseRelativePath: relativeToWorkspace(workspaceRoot, leasePath),
    });
  }
  const workItems = leases.map(lease => lease.workItemId);
  if (new Set(workItems).size !== workItems.length) {
    throw new Error("Lease workItemId values must be unique inside an execution.");
  }
  return leases;
}

function executionRoots(workspaceRoot) {
  const executionsRoot = path.join(workspaceRoot, RUNTIME_ROOT, "executions");
  safeDirectory(path.join(workspaceRoot, RUNTIME_ROOT), executionsRoot, "Executions directory");
  const executions = [];
  for (const entry of readdirSync(executionsRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Execution directory must not be a symlink: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const executionRoot = path.join(executionsRoot, entry.name);
    executions.push({ runId: entry.name, executionRoot });
  }
  return executions;
}

function hasTrustedCloseout(executionRoot, runId) {
  const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
  if (!existsSync(closeoutPath)) return false;
  try {
    const closeoutStat = lstatSync(closeoutPath);
    if (closeoutStat.isSymbolicLink() || !closeoutStat.isFile()) return false;
    if (!within(realpathSync(executionRoot), realpathSync(closeoutPath))) return false;
    const closeout = readJson(closeoutPath);
    const artifactGate = validateCoreArtifact(closeout.artifact);
    if (!artifactGate.valid
      || closeout.acceptanceSha256 !== artifactGate.acceptanceSha256
      || closeout.artifactSha256 !== artifactGate.artifactSha256) {
      return false;
    }
    const payload = closeout.artifact.payload;
    if (payload.runId !== runId
      || !new Set(["accepted", "rejected", "blocked"]).has(payload.decision)
      || payload.authorizationGranted !== false) {
      return false;
    }
    if (acceptedCloseoutVerificationIssues(closeout.artifact).length > 0) return false;
    const pinPath = path.join(executionRoot, "engine-pin.json");
    const pinStat = lstatSync(pinPath);
    if (pinStat.isSymbolicLink() || !pinStat.isFile()) return false;
    return validateExecutionPin({
      expected: readJson(pinPath),
      actual: closeout.artifact.core,
    }).status === "valid";
  } catch {
    return false;
  }
}

function patternPrefix(value) {
  return value.endsWith("/**") ? value.slice(0, -3) : null;
}

function covers(owner, candidate) {
  if (owner === candidate) return true;
  const prefix = patternPrefix(owner);
  if (prefix === null) return false;
  const candidatePrefix = patternPrefix(candidate) ?? candidate;
  return candidatePrefix === prefix || candidatePrefix.startsWith(`${prefix}/`);
}

function overlappingPaths(left, right) {
  const overlaps = [];
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (covers(leftPath, rightPath) || covers(rightPath, leftPath)) {
        overlaps.push(`${leftPath} <> ${rightPath}`);
      }
    }
  }
  return overlaps.sort();
}

export function assertExecutionUnclosed(executionRoot, runId) {
  if (existsSync(path.join(executionRoot, "closeout-receipt.json"))) {
    throw new Error(`Cannot manage leases in closed execution: ${runId}`);
  }
}

function acquireControlLock(workspaceRoot) {
  const runtimeRoot = path.join(workspaceRoot, RUNTIME_ROOT);
  safeDirectory(workspaceRoot, runtimeRoot, "RunKit runtime directory");
  safeDirectory(runtimeRoot, path.join(runtimeRoot, "executions"), "Executions directory");
  const lockPath = path.join(runtimeRoot, "control.lock");
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another RunKit control transaction is already active.");
    throw error;
  }
  return () => rmSync(lockPath, { recursive: true, force: true });
}

export function withControlTransaction(workspaceRoot, operation) {
  const release = acquireControlLock(workspaceRoot);
  try {
    return operation();
  } finally {
    release();
  }
}

export function acquireLeaseWithinControlTransaction({ workspaceRoot, runId, workItemId, ownedPaths }) {
  safeIdentifier(workItemId, "work-item");
  const normalizedPaths = validateOwnedPatterns(validateLeaseOwnedPaths(ownedPaths));
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  assertExecutionUnclosed(executionRoot, runId);
  safeDirectory(path.join(workspaceRoot, RUNTIME_ROOT, "executions"), executionRoot, "Execution directory");
  const currentLeases = listLeaseArtifacts({ workspaceRoot, executionRoot });
  if (currentLeases.some(lease => lease.workItemId === workItemId)) {
    throw new Error(`Lease work item already exists in execution: ${workItemId}`);
  }
  for (const execution of executionRoots(workspaceRoot)) {
    if (hasTrustedCloseout(execution.executionRoot, execution.runId)) continue;
    for (const lease of listLeaseArtifacts({ workspaceRoot, executionRoot: execution.executionRoot })) {
      if (lease.state !== "active") continue;
      const overlaps = overlappingPaths(normalizedPaths, lease.ownedPaths);
      if (overlaps.length > 0) {
        throw new Error(
          `Owned paths overlap active lease ${execution.runId}/${lease.workItemId}: ${overlaps.join(", ")}`,
        );
      }
    }
  }
  const lease = {
    schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
    workItemId,
    attempt: 1,
    ownedPaths: normalizedPaths,
    state: "active",
  };
  const leasePath = path.join(executionRoot, "leases", `${workItemId}-attempt-001.json`);
  writeJsonExclusiveAtomically(leasePath, lease);
  return {
    status: "lease_acquired",
    exitCode: 0,
    runId,
    leasePath: relativeToWorkspace(workspaceRoot, leasePath),
    lease,
    authorizationGranted: false,
  };
}

export function acquireLease(args) {
  return withControlTransaction(args.workspaceRoot, () => acquireLeaseWithinControlTransaction(args));
}

export function inspectLeases({ workspaceRoot, runId }) {
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const leases = listLeaseArtifacts({ workspaceRoot, executionRoot }).map(lease => ({
    workItemId: lease.workItemId,
    attempt: lease.attempt,
    ownedPaths: lease.ownedPaths,
    state: lease.state,
    leasePath: lease.leaseRelativePath,
  }));
  return {
    status: "leases_inspected",
    exitCode: 0,
    runId,
    leases,
    authorizationGranted: false,
  };
}

export function releaseLeaseWithinControlTransaction({ workspaceRoot, runId, workItemId }) {
  safeIdentifier(workItemId, "work-item");
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  assertExecutionUnclosed(executionRoot, runId);
  const matches = listLeaseArtifacts({ workspaceRoot, executionRoot })
    .filter(lease => lease.workItemId === workItemId);
  if (matches.length !== 1) throw new Error(`Lease work item was not found: ${workItemId}`);
  const [lease] = matches;
  if (lease.state === "released") throw new Error(`Lease is already released: ${workItemId}`);
  writeJsonAtomically(lease.leasePath, {
    schemaVersion: lease.schemaVersion,
    workItemId: lease.workItemId,
    attempt: lease.attempt,
    ownedPaths: lease.ownedPaths,
    state: "released",
  });
  return {
    status: "lease_released",
    exitCode: 0,
    runId,
    leasePath: lease.leaseRelativePath,
    authorizationGranted: false,
  };
}

export function releaseLease(args) {
  return withControlTransaction(args.workspaceRoot, () => releaseLeaseWithinControlTransaction(args));
}

export function restoreLeaseWithinControlTransaction({ workspaceRoot, runId, workItemId }) {
  safeIdentifier(workItemId, "work-item");
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  assertExecutionUnclosed(executionRoot, runId);
  const matches = listLeaseArtifacts({ workspaceRoot, executionRoot })
    .filter(lease => lease.workItemId === workItemId);
  if (matches.length !== 1) throw new Error(`Lease work item was not found: ${workItemId}`);
  const [lease] = matches;
  if (lease.state !== "released") throw new Error(`Lease is not released: ${workItemId}`);
  writeJsonAtomically(lease.leasePath, {
    schemaVersion: lease.schemaVersion,
    workItemId: lease.workItemId,
    attempt: lease.attempt,
    ownedPaths: lease.ownedPaths,
    state: "active",
  });
  return {
    status: "lease_restored",
    exitCode: 0,
    runId,
    leasePath: lease.leaseRelativePath,
    authorizationGranted: false,
  };
}
