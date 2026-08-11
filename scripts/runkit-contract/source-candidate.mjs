import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { isReservedRuntimePath } from "./core-contract.mjs";
import {
  createDeliveryFromLeaseWithinControlTransaction,
} from "./delivery-create.mjs";
import {
  listLeaseArtifacts,
  withControlTransaction,
} from "./lease-lifecycle.mjs";
import {
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  resolveExistingArtifact,
  safeIdentifier,
  sha256,
  writeJsonAtomically,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("source candidate contains a non-canonical value");
  return encoded;
}

function candidateHash(value) {
  return `sha256:${sha256(canonicalJson(value))}`;
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

function compareUnicodeCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function git(workspaceRoot, args, label, { trim = true } = {}) {
  const completed = spawnSync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(`${label} failed: ${completed.stderr.trim()}`);
  }
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
    if (entry.length < 4 || entry[2] !== " ") {
      throw new Error("Git status emitted a malformed entry.");
    }
    const status = entry.slice(0, 2);
    const currentPath = entry.slice(3);
    const paths = [currentPath];
    if (status.includes("R") || status.includes("C")) {
      const previousPath = entries[index + 1];
      if (!previousPath) throw new Error("Git status rename entry is incomplete.");
      paths.push(previousPath);
      index += 1;
    }
    records.push({ status, currentPath, paths });
  }
  return records;
}

function safeManifestPath(filePath) {
  if (
    typeof filePath !== "string"
    || !filePath
    || path.isAbsolute(filePath)
    || path.win32.parse(filePath).root
    || filePath.includes("\\")
    || filePath.includes("\0")
    || isReservedRuntimePath(filePath)
  ) {
    return false;
  }
  const segments = filePath.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function pathMatches(filePath, ownedPath) {
  if (ownedPath.endsWith("/**")) {
    const prefix = ownedPath.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  return filePath === ownedPath;
}

function isOwned(filePath, ownedPaths) {
  return ownedPaths.some((ownedPath) => pathMatches(filePath, ownedPath));
}

function validOwnedPath(ownedPath) {
  if (typeof ownedPath !== "string" || !ownedPath) return false;
  if (!ownedPath.endsWith("/**")) return safeManifestPath(ownedPath);
  return safeManifestPath(ownedPath.slice(0, -3));
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function inspectManifestPath(workspaceRoot, filePath, { mustExist }) {
  if (!safeManifestPath(filePath)) {
    throw new Error(`Source candidate path is unsafe: ${filePath}`);
  }
  let candidate = workspaceRoot;
  const segments = filePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    candidate = path.resolve(candidate, segments[index]);
    if (!within(workspaceRoot, candidate)) {
      throw new Error(`Source candidate path escapes workspace: ${filePath}`);
    }
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if (error?.code === "ENOENT" && !mustExist) return null;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Source candidate path is a symlink: ${filePath}`);
    }
    const leaf = index === segments.length - 1;
    if (!leaf && !stat.isDirectory()) {
      throw new Error(`Source candidate path has a non-directory parent: ${filePath}`);
    }
    if (leaf && mustExist && !stat.isFile()) {
      throw new Error(`Source candidate path is not a regular file: ${filePath}`);
    }
    if (leaf && !mustExist) {
      throw new Error(`Source candidate path expected to be absent: ${filePath}`);
    }
  }
  const realCandidate = realpathSync(candidate);
  if (!within(workspaceRoot, realCandidate)) {
    throw new Error(`Source candidate path resolves outside workspace: ${filePath}`);
  }
  return realCandidate;
}

function hashManifestFile(workspaceRoot, filePath) {
  return sha256(readFileSync(inspectManifestPath(
    workspaceRoot,
    filePath,
    { mustExist: true },
  )));
}

function manifestOperation(status) {
  if (status.includes("R")) return "renamed";
  if (status.includes("C") || status.includes("U")) {
    throw new Error(`Source candidate does not support Git status ${status}.`);
  }
  if (status.includes("D")) return "deleted";
  if (status === "??" || status.includes("A")) return "added";
  if (status.includes("M") || status.includes("T")) return "modified";
  throw new Error(`Source candidate does not support Git status ${status}.`);
}

function sourceManifestV2({ workspaceRoot, ownedPaths }) {
  const records = parseStatus(workspaceRoot);
  const entries = [];
  for (const record of records) {
    const ownedRecordPaths = record.paths.filter((filePath) => isOwned(filePath, ownedPaths));
    if (ownedRecordPaths.length === 0) continue;
    const operation = manifestOperation(record.status);
    if (
      (operation === "renamed" && ownedRecordPaths.length !== 2)
      || (operation !== "renamed" && !isOwned(record.currentPath, ownedPaths))
    ) {
      throw new Error("Source candidate rename crosses its active lease.");
    }
    for (const filePath of record.paths) {
      if (!safeManifestPath(filePath)) {
        throw new Error(`Source candidate path is unsafe: ${filePath}`);
      }
    }
    if (operation === "deleted") {
      inspectManifestPath(workspaceRoot, record.currentPath, { mustExist: false });
      entries.push({
        operation,
        status: record.status,
        path: record.currentPath,
      });
      continue;
    }
    if (operation === "renamed") {
      inspectManifestPath(workspaceRoot, record.paths[1], { mustExist: false });
      entries.push({
        operation,
        status: record.status,
        path: record.currentPath,
        previousPath: record.paths[1],
        sha256: hashManifestFile(workspaceRoot, record.currentPath),
      });
      continue;
    }
    entries.push({
      operation,
      status: record.status,
      path: record.currentPath,
      sha256: hashManifestFile(workspaceRoot, record.currentPath),
    });
  }
  entries.sort((left, right) => (
    compareUnicodeCodeUnits(left.path, right.path)
    || compareUnicodeCodeUnits(left.previousPath ?? "", right.previousPath ?? "")
  ));
  if (entries.length === 0) {
    throw new Error("No dirty source paths are owned by the active lease.");
  }
  const body = {
    schemaVersion: "OwlCodaRunKitDirtySourceManifestV2",
    statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
    ownedPaths: [...ownedPaths],
    entries,
  };
  return {
    ...body,
    sha256: candidateHash(body),
  };
}

function freezePayloadV1({
  workspaceRoot,
  candidateRoot,
  candidateId,
  manifest,
}) {
  const payloadRoot = path.join(candidateRoot, `${candidateId}.payload`);
  mkdirSync(payloadRoot);
  mkdirSync(path.join(payloadRoot, "sha256"));
  const payloadRootRelative = relativeToWorkspace(workspaceRoot, payloadRoot);
  const entries = [];
  const blobs = new Map();
  for (const manifestEntry of manifest.entries) {
    if (manifestEntry.operation === "deleted") continue;
    const sourcePath = inspectManifestPath(
      workspaceRoot,
      manifestEntry.path,
      { mustExist: true },
    );
    const stat = lstatSync(sourcePath);
    const bytes = readFileSync(sourcePath);
    const digest = sha256(bytes);
    if (digest !== manifestEntry.sha256) {
      throw new Error(`Source changed while freezing payload: ${manifestEntry.path}`);
    }
    const payloadPath = path.join(payloadRoot, "sha256", digest);
    if (!blobs.has(digest)) {
      writeFileSync(payloadPath, bytes, { flag: "wx", mode: 0o600 });
      blobs.set(digest, bytes.length);
    } else if (
      lstatSync(payloadPath).isSymbolicLink()
      || sha256(readFileSync(payloadPath)) !== digest
    ) {
      throw new Error(`Source payload blob drifted during freeze: ${digest}`);
    }
    entries.push({
      path: manifestEntry.path,
      payloadPath: relativeToWorkspace(workspaceRoot, payloadPath),
      sha256: digest,
      sizeBytes: bytes.length,
      mode: stat.mode & 0o777,
    });
  }
  const body = {
    schemaVersion: "OwlCodaRunKitSourcePayloadV1",
    storage: "create_only_content_addressed_sha256",
    root: payloadRootRelative,
    blobCount: blobs.size,
    totalBytes: [...blobs.values()].reduce((total, size) => total + size, 0),
    entries,
  };
  return {
    ...body,
    sha256: candidateHash(body),
  };
}

function payloadContractIssues({
  workspaceRoot,
  candidatePath,
  manifest,
  payload,
}) {
  const issues = [];
  const candidateBase = path.basename(candidatePath, ".json");
  const expectedRoot = relativeToWorkspace(
    workspaceRoot,
    path.join(path.dirname(candidatePath), `${candidateBase}.payload`),
  );
  const presentEntries = manifest.entries.filter(
    (entry) => entry.operation !== "deleted",
  );
  if (
    payload?.schemaVersion !== "OwlCodaRunKitSourcePayloadV1"
    || payload.storage !== "create_only_content_addressed_sha256"
    || payload.root !== expectedRoot
    || !Number.isInteger(payload.blobCount)
    || payload.blobCount < 0
    || !Number.isInteger(payload.totalBytes)
    || payload.totalBytes < 0
    || !Array.isArray(payload.entries)
    || payload.entries.length !== presentEntries.length
  ) {
    return ["source_candidate_payload_contract_invalid"];
  }
  const { sha256: payloadSha256, ...body } = payload;
  if (payloadSha256 !== candidateHash(body)) {
    issues.push("source_candidate_payload_contract_invalid");
  }
  const expectedByPath = new Map(presentEntries.map((entry) => [entry.path, entry]));
  const seenPaths = new Set();
  const seenBlobs = new Map();
  for (const entry of payload.entries) {
    const manifestEntry = expectedByPath.get(entry?.path);
    if (
      !manifestEntry
      || seenPaths.has(entry.path)
      || entry.sha256 !== manifestEntry.sha256
      || !Number.isInteger(entry.sizeBytes)
      || entry.sizeBytes < 0
      || !Number.isInteger(entry.mode)
      || entry.mode < 0
      || entry.mode > 0o777
      || entry.payloadPath
        !== `${payload.root}/sha256/${entry.sha256}`
    ) {
      issues.push("source_candidate_payload_contract_invalid");
      continue;
    }
    seenPaths.add(entry.path);
    try {
      const payloadPath = resolveExistingArtifact(
        workspaceRoot,
        entry.payloadPath,
        "payloadPath",
      );
      const stat = lstatSync(payloadPath);
      const bytes = readFileSync(payloadPath);
      if (
        stat.isSymbolicLink()
        || !stat.isFile()
        || bytes.length !== entry.sizeBytes
        || sha256(bytes) !== entry.sha256
      ) {
        issues.push("source_candidate_payload_drift");
        continue;
      }
      seenBlobs.set(entry.sha256, entry.sizeBytes);
    } catch {
      issues.push("source_candidate_payload_unreadable");
    }
  }
  const totalBytes = [...seenBlobs.values()].reduce(
    (total, size) => total + size,
    0,
  );
  if (
    seenPaths.size !== presentEntries.length
    || seenBlobs.size !== payload.blobCount
    || totalBytes !== payload.totalBytes
  ) {
    issues.push("source_candidate_payload_contract_invalid");
  }
  return [...new Set(issues)];
}

function activeLease({ workspaceRoot, executionRoot, workItemId }) {
  const matches = listLeaseArtifacts({ workspaceRoot, executionRoot })
    .filter((lease) => lease.workItemId === workItemId);
  if (matches.length !== 1 || matches[0].state !== "active") {
    throw new Error(`Source candidate requires one active lease: ${workItemId}`);
  }
  return matches[0];
}

function manifestContractValid(manifest) {
  if (
    manifest?.schemaVersion !== "OwlCodaRunKitDirtySourceManifestV2"
    || manifest.statusMode !== "porcelain-v1-z-untracked-all-runkit-excluded"
    || !Array.isArray(manifest.ownedPaths)
    || manifest.ownedPaths.length === 0
    || new Set(manifest.ownedPaths).size !== manifest.ownedPaths.length
    || manifest.ownedPaths.some((ownedPath) => !validOwnedPath(ownedPath))
    || !Array.isArray(manifest.entries)
    || manifest.entries.length === 0
  ) {
    return false;
  }
  for (const entry of manifest.entries) {
    if (
      !entry
      || !["added", "deleted", "modified", "renamed"].includes(entry.operation)
      || typeof entry.status !== "string"
      || entry.status.length !== 2
      || !safeManifestPath(entry.path)
      || !isOwned(entry.path, manifest.ownedPaths)
    ) {
      return false;
    }
    try {
      if (manifestOperation(entry.status) !== entry.operation) return false;
    } catch {
      return false;
    }
    if (entry.operation === "renamed") {
      if (
        !safeManifestPath(entry.previousPath)
        || !isOwned(entry.previousPath, manifest.ownedPaths)
        || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      ) {
        return false;
      }
    } else if (
      entry.previousPath !== undefined
      || (
        entry.operation === "deleted"
          ? entry.sha256 !== undefined
          : !/^[a-f0-9]{64}$/u.test(entry.sha256)
      )
    ) {
      return false;
    }
  }
  const sortedEntries = [...manifest.entries].sort((left, right) => (
    compareUnicodeCodeUnits(left.path, right.path)
    || compareUnicodeCodeUnits(left.previousPath ?? "", right.previousPath ?? "")
  ));
  if (
    canonicalJson(sortedEntries) !== canonicalJson(manifest.entries)
    || new Set(manifest.entries.flatMap((entry) => (
      entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]
    ))).size !== manifest.entries.reduce(
      (count, entry) => count + (entry.previousPath ? 2 : 1),
      0,
    )
  ) {
    return false;
  }
  const { sha256: manifestSha256, ...body } = manifest;
  return manifestSha256 === candidateHash(body);
}

function repositoryActionsAreFalse(actions) {
  const expected = repositoryActionsFalse();
  return actions
    && Object.keys(expected).every((key) => actions[key] === false)
    && Object.keys(actions).length === Object.keys(expected).length;
}

function candidateV2ContractIssues(candidate) {
  const { candidateSha256, ...body } = candidate ?? {};
  if (
    candidate?.schemaVersion !== "OwlCodaRunKitSourceCandidateV2"
    || candidate.status !== "frozen"
    || candidate.sourceMode !== "dirty_worktree_exact_manifest_v2"
    || candidate.authorizationGranted !== false
    || typeof candidateSha256 !== "string"
    || candidateSha256 !== candidateHash(body)
    || typeof candidate.runId !== "string"
    || typeof candidate.candidateId !== "string"
    || typeof candidate.baseline?.branch !== "string"
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(candidate.baseline?.head)
    || typeof candidate.discovery?.fromLease !== "string"
    || typeof candidate.discovery?.leasePath !== "string"
    || !repositoryActionsAreFalse(candidate.repositoryActions)
    || !manifestContractValid(candidate.sourceManifest)
    || candidate.sourceFingerprint?.sha256
      !== candidate.sourceManifest?.sha256?.slice("sha256:".length)
    || candidate.payload?.schemaVersion !== "OwlCodaRunKitSourcePayloadV1"
  ) {
    return ["source_candidate_contract_invalid"];
  }
  return [];
}

function currentBaseline(workspaceRoot) {
  return {
    branch: git(workspaceRoot, ["rev-parse", "--abbrev-ref", "HEAD"], "Git branch"),
    head: git(workspaceRoot, ["rev-parse", "HEAD"], "Git HEAD"),
  };
}

function candidateBody({ runId, candidateId, packetPath, packet, packetBytes }) {
  return {
    schemaVersion: "OwlCodaRunKitSourceCandidateV1",
    runId,
    candidateId,
    status: "frozen",
    sourceMode: "dirty_worktree_exact_manifest",
    baseline: structuredClone(packet.baseline),
    changedFiles: structuredClone(packet.changedFiles),
    sourceFingerprint: structuredClone(packet.sourceFingerprint),
    deliveryPacketPath: packetPath,
    deliveryPacketSha256: `sha256:${sha256(packetBytes)}`,
    repositoryActions: structuredClone(packet.repositoryActions),
    authorizationGranted: false,
  };
}

export function freezeSourceCandidateWithinControlTransactionV1({
  workspaceRoot,
  runId,
  workItemId,
  candidateId,
}) {
  safeIdentifier(candidateId, "candidateId");
  const root = realpathSync(workspaceRoot);
  const { executionRoot, pinGate } = loadActiveExecution(root, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const candidatePath = path.join(
    executionRoot,
    "source-candidates",
    `${candidateId}.json`,
  );
  if (existsSync(candidatePath)) {
    throw new Error(`source candidate already exists: ${candidateId}`);
  }
  const delivery = createDeliveryFromLeaseWithinControlTransaction({
    workspaceRoot: root,
    runId,
    workItemId,
    packetId: `${candidateId}-delivery`,
  });
  if (delivery.status !== "delivery_packet_created") return delivery;
  const absolutePacketPath = path.join(root, delivery.deliveryPacketPath);
  const packetStat = lstatSync(absolutePacketPath);
  if (packetStat.isSymbolicLink() || !packetStat.isFile()) {
    throw new Error("source candidate delivery packet must be a regular file");
  }
  const packetBytes = readFileSync(absolutePacketPath);
  const packet = JSON.parse(packetBytes.toString("utf8"));
  const sourceGate = verifyDeliveryPacket({ workspaceRoot: root, packet });
  if (sourceGate.status !== "valid") {
    throw new Error("source candidate delivery changed before freeze");
  }
  const body = candidateBody({
    runId,
    candidateId,
    packetPath: delivery.deliveryPacketPath,
    packet,
    packetBytes,
  });
  const candidate = {
    ...body,
    candidateSha256: candidateHash(body),
  };
  writeJsonExclusiveAtomically(candidatePath, candidate);
  return {
    status: "source_candidate_frozen",
    exitCode: 0,
    runId,
    candidateId,
    candidatePath: relativeToWorkspace(root, candidatePath),
    candidateSha256: candidate.candidateSha256,
    sourceFingerprint: packet.sourceFingerprint.sha256,
    deliveryPacketPath: delivery.deliveryPacketPath,
    authorizationGranted: false,
  };
}

export function freezeSourceCandidateV1(options) {
  const workspaceRoot = realpathSync(options.workspaceRoot);
  return withControlTransaction(
    workspaceRoot,
    () => freezeSourceCandidateWithinControlTransactionV1({
      ...options,
      workspaceRoot,
    }),
  );
}

export function freezeSourceCandidateWithinControlTransactionV2({
  workspaceRoot,
  runId,
  workItemId,
  candidateId,
}) {
  safeIdentifier(candidateId, "candidateId");
  const root = realpathSync(workspaceRoot);
  const { executionRoot, pinGate } = loadActiveExecution(root, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const candidateRoot = path.join(executionRoot, "source-candidates");
  if (!existsSync(candidateRoot)) mkdirSync(candidateRoot);
  const candidateRootStat = lstatSync(candidateRoot);
  if (candidateRootStat.isSymbolicLink() || !candidateRootStat.isDirectory()) {
    throw new Error("Source candidate directory must be a regular directory.");
  }
  if (!within(realpathSync(executionRoot), realpathSync(candidateRoot))) {
    throw new Error("Source candidate directory escapes its execution root.");
  }
  const candidatePath = path.join(candidateRoot, `${candidateId}.json`);
  if (existsSync(candidatePath)) {
    throw new Error(`source candidate already exists: ${candidateId}`);
  }
  const lease = activeLease({
    workspaceRoot: root,
    executionRoot,
    workItemId,
  });
  const baselineBefore = currentBaseline(root);
  const statusBefore = sourceManifestV2({
    workspaceRoot: root,
    ownedPaths: lease.ownedPaths,
  });
  const payload = freezePayloadV1({
    workspaceRoot: root,
    candidateRoot,
    candidateId,
    manifest: statusBefore,
  });
  const statusAfter = sourceManifestV2({
    workspaceRoot: root,
    ownedPaths: lease.ownedPaths,
  });
  const baselineAfter = currentBaseline(root);
  if (
    statusBefore.sha256 !== statusAfter.sha256
    || canonicalJson(baselineBefore) !== canonicalJson(baselineAfter)
  ) {
    throw new Error("Owned workspace source changed during candidate freeze.");
  }
  const body = {
    schemaVersion: "OwlCodaRunKitSourceCandidateV2",
    runId,
    candidateId,
    status: "frozen",
    sourceMode: "dirty_worktree_exact_manifest_v2",
    baseline: baselineAfter,
    sourceManifest: statusAfter,
    sourceFingerprint: {
      sha256: statusAfter.sha256.slice("sha256:".length),
    },
    payload,
    discovery: {
      fromLease: workItemId,
      leasePath: lease.leaseRelativePath,
    },
    repositoryActions: repositoryActionsFalse(),
    authorizationGranted: false,
  };
  const candidate = {
    ...body,
    candidateSha256: candidateHash(body),
  };
  writeJsonExclusiveAtomically(candidatePath, candidate);
  return {
    status: "source_candidate_frozen",
    exitCode: 0,
    runId,
    candidateId,
    candidatePath: relativeToWorkspace(root, candidatePath),
    candidateSha256: candidate.candidateSha256,
    sourceFingerprint: candidate.sourceFingerprint.sha256,
    manifestEntryCount: candidate.sourceManifest.entries.length,
    payloadSha256: candidate.payload.sha256,
    ownedPaths: [...candidate.sourceManifest.ownedPaths],
    authorizationGranted: false,
  };
}

export function freezeSourceCandidateV2(options) {
  const workspaceRoot = realpathSync(options.workspaceRoot);
  return withControlTransaction(
    workspaceRoot,
    () => freezeSourceCandidateWithinControlTransactionV2({
      ...options,
      workspaceRoot,
    }),
  );
}

export function verifySourceCandidateV2({
  workspaceRoot,
  candidatePath,
}) {
  const root = realpathSync(workspaceRoot);
  const issueCodes = [];
  let absoluteCandidatePath;
  let candidate;
  try {
    absoluteCandidatePath = resolveExistingArtifact(
      root,
      candidatePath,
      "candidatePath",
    );
    const stat = lstatSync(absoluteCandidatePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("candidate is not a regular file");
    }
    candidate = readJson(absoluteCandidatePath);
  } catch {
    return {
      status: "invalid",
      exitCode: 2,
      issueCodes: ["source_candidate_unreadable"],
      authorizationGranted: false,
    };
  }
  const candidateSha256 = candidate.candidateSha256;
  issueCodes.push(...candidateV2ContractIssues(candidate));
  if (issueCodes.length === 0) {
    issueCodes.push(...payloadContractIssues({
      workspaceRoot: root,
      candidatePath: absoluteCandidatePath,
      manifest: candidate.sourceManifest,
      payload: candidate.payload,
    }));
  }
  if (issueCodes.length === 0) {
    try {
      const leasePath = resolveExistingArtifact(
        root,
        candidate.discovery?.leasePath,
        "leasePath",
      );
      const leaseStat = lstatSync(leasePath);
      if (leaseStat.isSymbolicLink() || !leaseStat.isFile()) {
        throw new Error("lease is not a regular file");
      }
      const lease = readJson(leasePath);
      if (
        lease.workItemId !== candidate.discovery?.fromLease
        || JSON.stringify(lease.ownedPaths)
          !== JSON.stringify(candidate.sourceManifest.ownedPaths)
      ) {
        issueCodes.push("source_candidate_lease_mismatch");
      }
    } catch {
      issueCodes.push("source_candidate_lease_unreadable");
    }
  }
  if (issueCodes.length === 0) {
    try {
      const currentManifest = sourceManifestV2({
        workspaceRoot: root,
        ownedPaths: candidate.sourceManifest.ownedPaths,
      });
      if (currentManifest.sha256 !== candidate.sourceManifest.sha256) {
        issueCodes.push("source_candidate_manifest_drift");
      }
    } catch {
      issueCodes.push("source_candidate_manifest_drift");
    }
    try {
      if (canonicalJson(candidate.baseline) !== canonicalJson(currentBaseline(root))) {
        issueCodes.push("source_candidate_baseline_drift");
      }
    } catch {
      issueCodes.push("source_candidate_baseline_drift");
    }
  }
  return {
    status: issueCodes.length === 0 ? "valid" : "invalid",
    exitCode: issueCodes.length === 0 ? 0 : 2,
    candidatePath: relativeToWorkspace(root, absoluteCandidatePath),
    candidateSha256,
    sourceFingerprint: candidate.sourceFingerprint?.sha256,
    issueCodes: [...new Set(issueCodes)].sort(),
    authorizationGranted: false,
  };
}

class SimulatedMaterializationInterruption extends Error {
  constructor(phase) {
    super(`simulated materialization interruption: ${phase}`);
    this.name = "SimulatedMaterializationInterruption";
  }
}

function materializationTransactionPaths(targetWorkspaceRoot) {
  const requestedTarget = path.resolve(targetWorkspaceRoot);
  const parent = realpathSync(path.dirname(requestedTarget));
  const target = path.join(parent, path.basename(requestedTarget));
  const transactionId = sha256(Buffer.from(target)).slice(0, 32);
  const prefix = path.join(
    parent,
    `.owlrunkit-source-materialize-${transactionId}`,
  );
  return {
    target,
    staging: `${prefix}.staging`,
    backup: `${prefix}.backup`,
    journal: `${prefix}.journal.json`,
    lock: `${prefix}.lock`,
  };
}

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function acquireMaterializationLock(paths) {
  const owner = {
    schemaVersion: "OwlCodaRunKitSourceMaterializationLockV1",
    pid: process.pid,
    targetWorkspaceRoot: paths.target,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeJsonExclusiveAtomically(paths.lock, owner);
      return () => rmSync(paths.lock, { force: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let active = true;
      let staleIdentity;
      try {
        const stat = lstatSync(paths.lock);
        const currentOwner = JSON.parse(readFileSync(paths.lock, "utf8"));
        staleIdentity = { dev: stat.dev, ino: stat.ino };
        active = (
          stat.isFile()
          && !stat.isSymbolicLink()
          && currentOwner.schemaVersion
            === "OwlCodaRunKitSourceMaterializationLockV1"
          && currentOwner.targetWorkspaceRoot === paths.target
          && processIsRunning(currentOwner.pid)
        );
      } catch {
        active = true;
      }
      if (active) {
        throw new Error("Source candidate materialization is already active.");
      }
      const latest = lstatSync(paths.lock);
      if (
        latest.dev !== staleIdentity.dev
        || latest.ino !== staleIdentity.ino
      ) {
        continue;
      }
      rmSync(paths.lock, { force: true });
    }
  }
  throw new Error("Source candidate materialization lock could not be acquired.");
}

function readMaterializationJournal(paths) {
  const stat = lstatSync(paths.journal);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Source candidate materialization journal is unsafe.");
  }
  const journal = readJson(paths.journal);
  if (
    journal?.schemaVersion !== "OwlCodaRunKitSourceMaterializationJournalV1"
    || journal.targetWorkspaceRoot !== paths.target
    || journal.stagingPath !== paths.staging
    || journal.backupPath !== paths.backup
    || ![
      "initializing",
      "staged",
      "prepared",
      "target_backed_up",
      "switched",
      "committed",
    ].includes(journal.phase)
    || typeof journal.candidateSha256 !== "string"
  ) {
    throw new Error("Source candidate materialization journal is invalid.");
  }
  return journal;
}

function writeMaterializationPhase(paths, journal, phase) {
  const next = {
    ...journal,
    phase,
  };
  writeJsonAtomically(paths.journal, next);
  return next;
}

function validateMaterializedCandidate(target, candidate) {
  if (
    git(target, ["rev-parse", "HEAD"], "Materialized Git HEAD")
      !== candidate.baseline.head
  ) {
    throw new Error("Materialized source candidate changed the baseline.");
  }
  const expectedDirtyPaths = [...new Set(
    candidate.sourceManifest.entries.flatMap((entry) => (
      entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]
    )),
  )].sort(compareUnicodeCodeUnits);
  const actualDirtyPaths = [...new Set(
    parseStatus(target).flatMap((record) => record.paths),
  )].sort(compareUnicodeCodeUnits);
  if (canonicalJson(actualDirtyPaths) !== canonicalJson(expectedDirtyPaths)) {
    throw new Error(
      "Materialized source candidate contains unexpected Git changes.",
    );
  }
  const payloadEntries = new Map(
    candidate.payload.entries.map((entry) => [entry.path, entry]),
  );
  for (const entry of candidate.sourceManifest.entries) {
    if (entry.operation === "deleted") {
      inspectManifestPath(target, entry.path, { mustExist: false });
      continue;
    }
    if (entry.operation === "renamed") {
      inspectManifestPath(target, entry.previousPath, { mustExist: false });
    }
    const payloadEntry = payloadEntries.get(entry.path);
    const materializedPath = inspectManifestPath(
      target,
      entry.path,
      { mustExist: true },
    );
    const stat = lstatSync(materializedPath);
    if (
      !payloadEntry
      || hashManifestFile(target, entry.path) !== payloadEntry.sha256
      || (stat.mode & 0o777) !== payloadEntry.mode
    ) {
      throw new Error(`Materialized source candidate drifted: ${entry.path}`);
    }
  }
}

function rollbackMaterialization(paths) {
  const targetExists = existsSync(paths.target);
  const stagingExists = existsSync(paths.staging);
  const backupExists = existsSync(paths.backup);
  if (backupExists) {
    if (targetExists && stagingExists) {
      throw new Error("Source candidate materialization state is ambiguous.");
    }
    if (targetExists) renameSync(paths.target, paths.staging);
    renameSync(paths.backup, paths.target);
  } else if (!targetExists) {
    throw new Error("Source candidate materialization baseline cannot be restored.");
  }
  rmSync(paths.staging, { recursive: true, force: true });
  rmSync(paths.journal, { force: true });
}

function recoverMaterialization({
  paths,
  candidate,
}) {
  if (!existsSync(paths.journal)) return { recovered: false, completed: false };
  const journal = readMaterializationJournal(paths);
  if (journal.phase === "committed") {
    let exact = false;
    if (
      journal.candidateSha256 === candidate.candidateSha256
      && existsSync(paths.target)
    ) {
      try {
        validateMaterializedCandidate(paths.target, candidate);
        exact = true;
      } catch {
        exact = false;
      }
    }
    if (exact) {
      rmSync(paths.backup, { recursive: true, force: true });
      rmSync(paths.staging, { recursive: true, force: true });
      rmSync(paths.journal, { force: true });
      return { recovered: true, completed: true };
    }
  }
  rollbackMaterialization(paths);
  return { recovered: true, completed: false };
}

function materializationResult(candidate, {
  resumed = false,
  recovered = false,
} = {}) {
  return {
    status: "source_candidate_materialized",
    exitCode: 0,
    candidateSha256: candidate.candidateSha256,
    payloadSha256: candidate.payload.sha256,
    sourceFingerprint: candidate.sourceFingerprint.sha256,
    baselineHead: candidate.baseline.head,
    materializedEntryCount: candidate.sourceManifest.entries.length,
    resumed,
    recovered,
    repositoryActions: repositoryActionsFalse(),
    authorizationGranted: false,
  };
}

function applyCandidateToStaging({
  root,
  staging,
  candidate,
  hooks,
}) {
  for (const entry of candidate.sourceManifest.entries) {
    if (entry.operation === "deleted") {
      const deletedPath = inspectManifestPath(staging, entry.path, {
        mustExist: true,
      });
      unlinkSync(deletedPath);
    } else if (entry.operation === "renamed") {
      const previousPath = inspectManifestPath(
        staging,
        entry.previousPath,
        { mustExist: true },
      );
      unlinkSync(previousPath);
    }
  }

  const payloadEntries = new Map(
    candidate.payload.entries.map((entry) => [entry.path, entry]),
  );
  for (const entry of candidate.sourceManifest.entries) {
    if (entry.operation === "deleted") continue;
    const payloadEntry = payloadEntries.get(entry.path);
    if (!payloadEntry) {
      throw new Error(`Source candidate payload is missing: ${entry.path}`);
    }
    const targetPath = path.join(staging, entry.path);
    if (entry.operation === "modified") {
      const current = inspectManifestPath(staging, entry.path, {
        mustExist: true,
      });
      unlinkSync(current);
    } else {
      inspectManifestPath(staging, entry.path, { mustExist: false });
    }
    mkdirSync(path.dirname(targetPath), { recursive: true });
    const payloadPath = resolveExistingArtifact(
      root,
      payloadEntry.payloadPath,
      "payloadPath",
    );
    const bytes = readFileSync(payloadPath);
    if (
      bytes.length !== payloadEntry.sizeBytes
      || sha256(bytes) !== payloadEntry.sha256
    ) {
      throw new Error(`Source candidate payload drifted: ${entry.path}`);
    }
    hooks?.beforePayloadWrite?.({ path: entry.path });
    writeFileSync(targetPath, bytes, {
      flag: "wx",
      mode: payloadEntry.mode,
    });
    hooks?.beforePayloadChmod?.({ path: entry.path });
    chmodSync(targetPath, payloadEntry.mode);
  }
  validateMaterializedCandidate(staging, candidate);
}

export function materializeSourceCandidateV2({
  workspaceRoot,
  candidatePath,
  targetWorkspaceRoot,
  hooks,
}) {
  const root = realpathSync(workspaceRoot);
  const absoluteCandidatePath = resolveExistingArtifact(
    root,
    candidatePath,
    "candidatePath",
  );
  const candidateStat = lstatSync(absoluteCandidatePath);
  if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
    throw new Error("Source candidate must be a regular file.");
  }
  const candidate = readJson(absoluteCandidatePath);
  const issues = [
    ...candidateV2ContractIssues(candidate),
    ...payloadContractIssues({
      workspaceRoot: root,
      candidatePath: absoluteCandidatePath,
      manifest: candidate.sourceManifest,
      payload: candidate.payload,
    }),
  ];
  if (issues.length > 0) {
    throw new Error(`Source candidate payload is invalid: ${[...new Set(issues)].join(",")}`);
  }

  const paths = materializationTransactionPaths(targetWorkspaceRoot);
  const releaseLock = acquireMaterializationLock(paths);
  try {
    const recovered = recoverMaterialization({ paths, candidate });
    if (recovered.completed) {
      return materializationResult(candidate, {
        resumed: true,
        recovered: true,
      });
    }
    if (recovered.recovered) hooks?.afterRecovery?.();

    const targetStat = lstatSync(paths.target);
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      throw new Error("Materialization target must be a regular directory.");
    }
    if (realpathSync(paths.target) !== paths.target) {
      throw new Error("Materialization target must not resolve through a symlink.");
    }
    if (
      git(paths.target, ["rev-parse", "HEAD"], "Target Git HEAD")
        !== candidate.baseline.head
    ) {
      throw new Error("Materialization target does not match the candidate baseline.");
    }
    if (parseStatus(paths.target).length !== 0) {
      throw new Error("Materialization target must be a clean baseline checkout.");
    }
    if (
      existsSync(paths.staging)
      || existsSync(paths.backup)
      || existsSync(paths.journal)
    ) {
      throw new Error("Source candidate materialization transaction paths are occupied.");
    }

    let journal = {
      schemaVersion: "OwlCodaRunKitSourceMaterializationJournalV1",
      targetWorkspaceRoot: paths.target,
      stagingPath: paths.staging,
      backupPath: paths.backup,
      candidateSha256: candidate.candidateSha256,
      phase: "initializing",
    };
    writeJsonExclusiveAtomically(paths.journal, journal);
    try {
      cpSync(paths.target, paths.staging, {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        verbatimSymlinks: true,
      });
      journal = writeMaterializationPhase(paths, journal, "staged");
      applyCandidateToStaging({
        root,
        staging: paths.staging,
        candidate,
        hooks,
      });
      journal = writeMaterializationPhase(paths, journal, "prepared");
      renameSync(paths.target, paths.backup);
      journal = writeMaterializationPhase(paths, journal, "target_backed_up");
      hooks?.afterTargetBackup?.();
      if (hooks?.simulateInterruptionAt === "after_target_backup") {
        throw new SimulatedMaterializationInterruption("after_target_backup");
      }
      renameSync(paths.staging, paths.target);
      journal = writeMaterializationPhase(paths, journal, "switched");
      hooks?.afterTargetSwitch?.();
      if (hooks?.simulateInterruptionAt === "after_target_switch") {
        throw new SimulatedMaterializationInterruption("after_target_switch");
      }
      validateMaterializedCandidate(paths.target, candidate);
      journal = writeMaterializationPhase(paths, journal, "committed");
      if (hooks?.simulateInterruptionAt === "after_commit") {
        throw new SimulatedMaterializationInterruption("after_commit");
      }
      rmSync(paths.backup, { recursive: true, force: true });
      rmSync(paths.journal, { force: true });
    } catch (error) {
      if (error instanceof SimulatedMaterializationInterruption) throw error;
      const recovery = recoverMaterialization({ paths, candidate });
      if (recovery.completed) {
        return materializationResult(candidate, {
          resumed: true,
          recovered: true,
        });
      }
      throw error;
    }
    return materializationResult(candidate, {
      recovered: recovered.recovered,
    });
  } finally {
    releaseLock();
  }
}

export function verifySourceCandidatePathClosureV2({
  workspaceRoot,
  candidatePath,
  includedPaths,
}) {
  const root = realpathSync(workspaceRoot);
  if (
    !Array.isArray(includedPaths)
    || includedPaths.length === 0
    || new Set(includedPaths).size !== includedPaths.length
    || includedPaths.some((includedPath) => !validOwnedPath(includedPath))
  ) {
    throw new Error("Source candidate closure paths are invalid.");
  }
  const absoluteCandidatePath = resolveExistingArtifact(
    root,
    candidatePath,
    "candidatePath",
  );
  const candidate = readJson(absoluteCandidatePath);
  const candidateGate = verifySourceCandidateV2({
    workspaceRoot: root,
    candidatePath,
  });
  const candidateCoveredPaths = [...new Set(
    candidate.sourceManifest.entries.flatMap((entry) => (
      entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]
    )),
  )].sort(compareUnicodeCodeUnits);
  const includedDirtyPaths = [...new Set(
    parseStatus(root).flatMap((record) => record.paths)
      .filter((filePath) => isOwned(filePath, includedPaths)),
  )].sort(compareUnicodeCodeUnits);
  const covered = new Set(candidateCoveredPaths);
  const uncoveredDirtyPaths = includedDirtyPaths.filter(
    (filePath) => !covered.has(filePath),
  );
  const issueCodes = [
    ...(candidateGate.status === "valid" ? [] : ["source_candidate_invalid"]),
    ...(uncoveredDirtyPaths.length === 0
      ? []
      : ["source_candidate_path_closure_incomplete"]),
  ];
  const closureBody = {
    schemaVersion: "OwlCodaRunKitSourceCandidatePathClosureV1",
    candidateSha256: candidate.candidateSha256,
    payloadSha256: candidate.payload?.sha256 ?? null,
    includedPaths: [...includedPaths],
    includedDirtyPaths,
    candidateCoveredPaths,
    uncoveredDirtyPaths,
  };
  return {
    ...closureBody,
    status: issueCodes.length === 0 ? "valid" : "invalid",
    exitCode: issueCodes.length === 0 ? 0 : 2,
    issueCodes,
    closureSha256: candidateHash(closureBody),
    authorizationGranted: false,
  };
}

export function verifySourceCandidateV1({
  workspaceRoot,
  candidatePath,
}) {
  const root = realpathSync(workspaceRoot);
  const issueCodes = [];
  let absoluteCandidatePath;
  let candidate;
  try {
    absoluteCandidatePath = resolveExistingArtifact(
      root,
      candidatePath,
      "candidatePath",
    );
    const stat = lstatSync(absoluteCandidatePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("candidate is not a regular file");
    }
    candidate = readJson(absoluteCandidatePath);
  } catch {
    return {
      status: "invalid",
      exitCode: 2,
      issueCodes: ["source_candidate_unreadable"],
      authorizationGranted: false,
    };
  }
  const { candidateSha256, ...body } = candidate;
  if (
    candidate.schemaVersion !== "OwlCodaRunKitSourceCandidateV1"
    || candidate.status !== "frozen"
    || candidate.sourceMode !== "dirty_worktree_exact_manifest"
    || candidate.authorizationGranted !== false
    || typeof candidateSha256 !== "string"
    || candidateSha256 !== candidateHash(body)
  ) {
    issueCodes.push("source_candidate_contract_invalid");
  }
  try {
    const packetPath = resolveExistingArtifact(
      root,
      candidate.deliveryPacketPath,
      "deliveryPacketPath",
    );
    const packetStat = lstatSync(packetPath);
    if (packetStat.isSymbolicLink() || !packetStat.isFile()) {
      throw new Error("delivery packet is not a regular file");
    }
    const packetBytes = readFileSync(packetPath);
    if (`sha256:${sha256(packetBytes)}` !== candidate.deliveryPacketSha256) {
      issueCodes.push("source_candidate_delivery_hash_mismatch");
    }
    const packet = JSON.parse(packetBytes.toString("utf8"));
    const gate = verifyDeliveryPacket({ workspaceRoot: root, packet });
    if (
      gate.status !== "valid"
      || packet.runId !== candidate.runId
      || packet.sourceFingerprint?.sha256 !== candidate.sourceFingerprint?.sha256
    ) {
      issueCodes.push("source_candidate_delivery_drift");
    }
  } catch {
    issueCodes.push("source_candidate_delivery_unreadable");
  }
  return {
    status: issueCodes.length === 0 ? "valid" : "invalid",
    exitCode: issueCodes.length === 0 ? 0 : 2,
    candidatePath: relativeToWorkspace(root, absoluteCandidatePath),
    candidateSha256,
    issueCodes: [...new Set(issueCodes)].sort(),
    authorizationGranted: false,
  };
}
