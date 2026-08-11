import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  RUNTIME_ROOT,
  currentCoreIdentity,
} from "./core-contract.mjs";
import {
  loadActiveExecution,
  relativeToWorkspace,
  safeIdentifier,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";
import {
  listLeaseArtifacts,
  withControlTransaction,
} from "./lease-lifecycle.mjs";
import {
  canonicalSourceFingerprint,
  verifyDeliveryPacket,
} from "./source-fingerprint.mjs";

function git(workspaceRoot, args, label, { trim = true } = {}) {
  const completed = spawnSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) throw new Error(`${label} failed: ${completed.stderr.trim()}`);
  return trim ? completed.stdout.trim() : completed.stdout;
}

function parseStatus(workspaceRoot) {
  const raw = git(workspaceRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).owlcoda/runkit/**",
  ], "Git status", { trim: false });
  if (raw.length === 0) return [];
  const entries = raw.split("\0");
  const records = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Git status emitted a malformed entry.");
    const status = entry.slice(0, 2);
    const currentPath = entry.slice(3);
    const paths = [currentPath];
    if (status.includes("R") || status.includes("C")) {
      const priorPath = entries[index + 1];
      if (!priorPath) throw new Error("Git status rename entry is incomplete.");
      paths.push(priorPath);
      index += 1;
    }
    records.push({ status, currentPath, paths });
  }
  return records;
}

function pathMatches(filePath, ownedPath) {
  if (ownedPath.endsWith("/**")) {
    const prefix = ownedPath.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return filePath === ownedPath;
}

function isOwned(filePath, ownedPaths) {
  return ownedPaths.some(ownedPath => pathMatches(filePath, ownedPath));
}

function ownedStatusSignature(records, ownedPaths) {
  return JSON.stringify(ownedStatusRecords(records, ownedPaths));
}

function ownedStatusRecords(records, ownedPaths) {
  return records
    .filter(record => record.paths.some(filePath => isOwned(filePath, ownedPaths)))
    .map(record => ({ status: record.status, paths: [...record.paths] }))
    .sort((left, right) => JSON.stringify(left.paths).localeCompare(JSON.stringify(right.paths)));
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeOutputDirectory(executionRoot) {
  const rootStat = lstatSync(executionRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Delivery execution root must be a regular directory, not a symlink.");
  }
  const outputRoot = path.join(executionRoot, "delivery-packets");
  const outputStat = lstatSync(outputRoot);
  if (outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    throw new Error("Delivery packet directory must be a regular directory, not a symlink.");
  }
  if (!within(realpathSync(executionRoot), realpathSync(outputRoot))) {
    throw new Error("Delivery packet directory escapes its execution root.");
  }
  return outputRoot;
}

function hashRegularFile(workspaceRoot, filePath) {
  if (filePath === RUNTIME_ROOT || filePath.startsWith(`${RUNTIME_ROOT}/`)) {
    throw new Error(`Delivery candidate uses reserved runtime path: ${filePath}`);
  }
  let candidate = workspaceRoot;
  for (const segment of filePath.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Delivery candidate path is unsafe: ${filePath}`);
    }
    candidate = path.resolve(candidate, segment);
    if (!within(workspaceRoot, candidate)) throw new Error(`Delivery candidate escapes workspace: ${filePath}`);
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`Delivery candidate is a symlink: ${filePath}`);
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile()) throw new Error(`Delivery candidate is not a regular file: ${filePath}`);
  const realCandidate = realpathSync(candidate);
  if (!within(workspaceRoot, realCandidate)) throw new Error(`Delivery candidate escapes workspace: ${filePath}`);
  return createHash("sha256").update(readFileSync(realCandidate)).digest("hex");
}

function repositoryActionsFalse() {
  return {
    worktreeCreated: false,
    branchCreated: false,
    staged: false,
    committed: false,
    pushed: false,
    tagged: false,
    published: false,
    deployed: false,
  };
}

export function createDeliveryFromLeaseWithinControlTransaction({ workspaceRoot, runId, workItemId, packetId }) {
  safeIdentifier(workItemId, "from-lease");
  safeIdentifier(packetId, "packet-id");
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  if (existsSync(path.join(executionRoot, "closeout-receipt.json"))) {
    throw new Error(`Cannot create delivery in closed execution: ${runId}`);
  }
  const matches = listLeaseArtifacts({ workspaceRoot, executionRoot })
    .filter(lease => lease.workItemId === workItemId);
  if (matches.length !== 1 || matches[0].state !== "active") {
    throw new Error(`Delivery creation requires one active lease: ${workItemId}`);
  }
  const [lease] = matches;
  const outputPath = path.join(safeOutputDirectory(executionRoot), `${packetId}.json`);
  if (existsSync(outputPath)) throw new Error(`Delivery packet already exists: ${packetId}`);

  const candidatePaths = new Set();
  const unrelatedDirtyPaths = new Set();
  const deletedOwnedPaths = new Set();
  const renamedOwnedPaths = new Set();
  const statusBefore = parseStatus(workspaceRoot);
  for (const record of statusBefore) {
    const ownedRecordPaths = record.paths.filter(filePath => isOwned(filePath, lease.ownedPaths));
    for (const filePath of record.paths) {
      if (!isOwned(filePath, lease.ownedPaths)) unrelatedDirtyPaths.add(filePath);
    }
    if (ownedRecordPaths.length === 0) continue;
    if (record.status.includes("R") || record.status.includes("C")) {
      for (const filePath of ownedRecordPaths) renamedOwnedPaths.add(filePath);
      continue;
    }
    if (record.status.includes("D")) {
      for (const filePath of ownedRecordPaths) deletedOwnedPaths.add(filePath);
      continue;
    }
    if (isOwned(record.currentPath, lease.ownedPaths)) candidatePaths.add(record.currentPath);
  }
  const deleted = [...deletedOwnedPaths].sort();
  const renamed = [...renamedOwnedPaths].sort();
  if (deleted.length > 0) throw new Error(`Deleted owned paths require an explicit packet protocol: ${deleted.join(", ")}`);
  if (renamed.length > 0) throw new Error(`Renamed owned paths require an explicit packet protocol: ${renamed.join(", ")}`);
  if (candidatePaths.size === 0) throw new Error("No changed regular files are owned by the active lease.");

  const files = {};
  for (const filePath of [...candidatePaths].sort()) {
    files[filePath] = hashRegularFile(workspaceRoot, filePath);
  }
  const statusAfter = parseStatus(workspaceRoot);
  if (ownedStatusSignature(statusBefore, lease.ownedPaths)
    !== ownedStatusSignature(statusAfter, lease.ownedPaths)) {
    throw new Error("Owned workspace status changed during DeliveryPacket creation.");
  }
  const packet = {
    schemaVersion: "ExecutionDeliveryPacketV1",
    status: "ready_for_stage_verification",
    runId,
    revision: 1,
    baseline: {
      branch: git(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], "Git branch"),
      head: git(workspaceRoot, ["rev-parse", "HEAD"], "Git HEAD"),
    },
    changedFiles: { wholeFileSha256: files },
    sourceFingerprint: { sha256: canonicalSourceFingerprint(files) },
    core: currentCoreIdentity(),
    discovery: {
      fromLease: workItemId,
      leasePath: lease.leaseRelativePath,
      ownedPathState: {
        schemaVersion: "OwlCodaRunKitOwnedPathStateV1",
        statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
        ownedPaths: [...lease.ownedPaths],
        records: ownedStatusRecords(statusBefore, lease.ownedPaths),
      },
      unrelatedDirtyPaths: [...unrelatedDirtyPaths].sort(),
      deletedOwnedPaths: [],
      renamedOwnedPaths: [],
    },
    repositoryActions: repositoryActionsFalse(),
    authorizationGranted: false,
  };
  const sourceGate = verifyDeliveryPacket({ workspaceRoot, packet });
  if (sourceGate.status !== "valid") {
    throw new Error(`Delivery source changed during packet creation: ${sourceGate.issues.map(issue => issue.message ?? issue).join("; ")}`);
  }
  writeJsonExclusiveAtomically(outputPath, packet);
  return {
    status: "delivery_packet_created",
    exitCode: 0,
    runId,
    deliveryPacketPath: relativeToWorkspace(workspaceRoot, outputPath),
    sourceFingerprint: packet.sourceFingerprint.sha256,
    unrelatedDirtyPaths: packet.discovery.unrelatedDirtyPaths,
    authorizationGranted: false,
  };
}

export function createDeliveryFromLease(args) {
  return withControlTransaction(
    args.workspaceRoot,
    () => createDeliveryFromLeaseWithinControlTransaction(args),
  );
}
