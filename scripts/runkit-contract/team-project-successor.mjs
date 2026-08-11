import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  assertAllowedKeys,
  isRecord,
  relativeToWorkspace,
  safeIdentifier,
} from "./provenance-common.mjs";
import {
  emptyTeamProjectTruthHashV1,
  normalizeTeamProjectDefinitionV1,
  readTeamProjectStatusV1,
} from "./team-project.mjs";

const RECEIPT_SCHEMA = "OwlCodaRunKitTeamProjectSuccessorReceiptV1";
const LOCK_SCHEMA = "OwlCodaRunKitTeamProjectSuccessorLockV1";
const RUNKIT_ROOT = ".owlcoda/runkit";
const ACTIVE_PROJECT = `${RUNKIT_ROOT}/project`;
const ARCHIVE_ROOT = `${RUNKIT_ROOT}/project-archives`;
const TRANSITION_ROOT = `${RUNKIT_ROOT}/project-successor-transitions`;
const STAGING_ROOT = `${RUNKIT_ROOT}/project-successor-staging`;
const LIFECYCLE_LOCK = `${RUNKIT_ROOT}/project-successor.lock`;
const MANIFEST_ALGORITHM = "sha256-canonical-json-v1";
const ARCHIVE_SEAL_POLICY = Object.freeze({
  policy: "posix-owner-write-denied-v1",
  regularFileMode: "0444",
  directoryMode: "0555",
});
const ARCHIVE_FILE_MODE = 0o444;
const ARCHIVE_DIRECTORY_MODE = 0o555;
const PHASES = new Set(["prepared", "archived", "active_installed", "completed"]);
const REPOSITORY_ACTIONS = Object.freeze({
  staged: false,
  committed: false,
  pushed: false,
  tagged: false,
  published: false,
  deployed: false,
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Team project successor artifact is not canonical JSON.");
  return encoded;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function pathEntryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new Error("Team project successor --at must be an ISO-8601 UTC timestamp.");
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 hash.`);
  }
  return value;
}

function assertWorkspaceRoot(workspaceRoot) {
  const requested = path.resolve(nonEmptyString(workspaceRoot, "workspaceRoot"));
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(requested) !== requested) {
    throw new Error("Team project successor workspace must be a real directory without symlinks.");
  }
  return requested;
}

function assertRealDirectory(directoryPath, label) {
  const stat = lstatSync(directoryPath);
  if (stat.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(directoryPath) !== path.resolve(directoryPath)) {
    throw new Error(`${label} must be a real directory without symlinks.`);
  }
  return directoryPath;
}

function assertWithin(root, candidate, label) {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the RunKit workspace.`);
  }
}

function ensureRealDirectory(root, directoryPath, label) {
  assertWithin(root, directoryPath, label);
  const relative = path.relative(root, directoryPath);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!pathEntryExists(current)) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    assertRealDirectory(current, label);
  }
  return directoryPath;
}

function readRegularBytes(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()
    || !stat.isFile()
    || realpathSync(filePath) !== path.resolve(filePath)) {
    throw new Error(`${label} must be a regular file without symlinks.`);
  }
  return readFileSync(filePath);
}

function fsyncDirectory(directoryPath) {
  const descriptor = openSync(directoryPath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurableFile(filePath, bytes, { exclusive }) {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (exclusive) linkSync(temporaryPath, filePath);
    else renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function renameDirectoryDurably(fromPath, toPath) {
  const fromParent = path.dirname(fromPath);
  const toParent = path.dirname(toPath);
  renameSync(fromPath, toPath);
  fsyncDirectory(fromParent);
  if (toParent !== fromParent) fsyncDirectory(toParent);
}

function removeFileDurably(filePath) {
  unlinkSync(filePath);
  fsyncDirectory(path.dirname(filePath));
}

function parseDefinition(bytes, label) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  return normalizeTeamProjectDefinitionV1(parsed);
}

function definitionSourceExistsWithoutSymlinks(sourcePath, { allowMissing }) {
  const root = path.parse(sourcePath).root;
  const segments = path.relative(root, sourcePath).split(path.sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    if (!pathEntryExists(current)) {
      if (allowMissing) return false;
      throw new Error("Team project successor definition input does not exist.");
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error("Team project successor definition input path must not contain symlinks.");
    }
    const isLeaf = index === segments.length - 1;
    if ((!isLeaf && !stat.isDirectory()) || (isLeaf && !stat.isFile())) {
      throw new Error("Team project successor definition input must be a regular file without symlinks.");
    }
  }
  return true;
}

function readDefinitionSource(definitionPath, { allowMissing = false } = {}) {
  const sourcePath = path.resolve(nonEmptyString(definitionPath, "definitionPath"));
  if (!definitionSourceExistsWithoutSymlinks(sourcePath, { allowMissing })) {
    return { sourcePath, missing: true };
  }
  const bytes = readRegularBytes(
    sourcePath,
    "Team project successor definition input",
  );
  return {
    sourcePath,
    sourceSha256: sha256(bytes),
    definition: parseDefinition(bytes, "Team project successor definition input"),
    missing: false,
  };
}

function manifestForDirectory(directoryPath, label, { excludeRootControlLock = false } = {}) {
  assertRealDirectory(directoryPath, label);
  const directories = [];
  const files = [];
  function walk(current, prefix = "") {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => compareBytes(left.name, right.name));
    for (const entry of entries) {
      if (excludeRootControlLock && prefix === "" && entry.name === "control.lock") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symlink: ${relative}.`);
      }
      if (entry.isDirectory()) {
        assertRealDirectory(absolute, `${label} directory ${relative}`);
        directories.push(relative);
        walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${label} contains a non-regular input: ${relative}.`);
      }
      const bytes = readRegularBytes(absolute, `${label} file ${relative}`);
      files.push({ path: relative, byteLength: bytes.byteLength, sha256: sha256(bytes) });
    }
  }
  walk(directoryPath);
  directories.sort(compareBytes);
  files.sort((left, right) => compareBytes(left.path, right.path));
  const manifestSha256 = sha256(canonical({
    algorithm: MANIFEST_ALGORITHM,
    directories,
    files,
  }));
  return { directories, files, manifestSha256 };
}

function assertManifestMatches(directoryPath, archive, label = "Team project archive") {
  const actual = manifestForDirectory(directoryPath, label);
  if (canonical(actual.directories) !== canonical(archive.directories)
    || canonical(actual.files) !== canonical(archive.files)
    || actual.manifestSha256 !== archive.manifestSha256) {
    throw new Error(`${label} bytes do not match the transition journal.`);
  }
}

function fsyncRegularFile(filePath) {
  const descriptor = openSync(filePath, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function sealArchiveTree(directoryPath) {
  assertRealDirectory(directoryPath, "Team project archive being sealed");
  const directories = [directoryPath];
  const files = [];
  function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error("Team project archive being sealed contains a symlink.");
      }
      if (entry.isDirectory()) {
        assertRealDirectory(absolute, "Team project archive directory being sealed");
        directories.push(absolute);
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("Team project archive being sealed contains a non-regular input.");
      }
      readRegularBytes(absolute, "Team project archive file being sealed");
      files.push(absolute);
    }
  }
  walk(directoryPath);
  for (const filePath of files) {
    chmodSync(filePath, ARCHIVE_FILE_MODE);
    fsyncRegularFile(filePath);
  }
  directories.sort((left, right) => right.length - left.length || compareBytes(right, left));
  for (const archivedDirectory of directories) {
    chmodSync(archivedDirectory, ARCHIVE_DIRECTORY_MODE);
    fsyncDirectory(archivedDirectory);
  }
}

function assertArchiveSealMatches(directoryPath, archive, label = "Team project archive") {
  if (canonical(archive.sealPolicy) !== canonical(ARCHIVE_SEAL_POLICY)) {
    throw new Error(`${label} seal policy is invalid.`);
  }
  const directoryPaths = [directoryPath, ...archive.directories.map(relative => (
    path.join(directoryPath, ...relative.split("/"))
  ))];
  for (const archivedDirectory of directoryPaths) {
    const stat = lstatSync(archivedDirectory);
    if (stat.isSymbolicLink()
      || !stat.isDirectory()
      || realpathSync(archivedDirectory) !== path.resolve(archivedDirectory)
      || (stat.mode & 0o7777) !== ARCHIVE_DIRECTORY_MODE) {
      throw new Error(`${label} seal does not match the transition journal.`);
    }
  }
  for (const row of archive.files) {
    const filePath = path.join(directoryPath, ...row.path.split("/"));
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()
      || !stat.isFile()
      || realpathSync(filePath) !== path.resolve(filePath)
      || (stat.mode & 0o7777) !== ARCHIVE_FILE_MODE) {
      throw new Error(`${label} seal does not match the transition journal.`);
    }
  }
}

function assertArchiveIntegrity(directoryPath, archive, label = "Team project archive") {
  if (!pathEntryExists(directoryPath)) {
    throw new Error(`${label} is missing.`);
  }
  assertManifestMatches(directoryPath, archive, label);
  assertArchiveSealMatches(directoryPath, archive, label);
}

function requestSha256({
  transitionId,
  occurredAt,
  reason,
  definitionSourcePath,
  definitionSourceSha256,
  definition,
}) {
  return sha256(canonical({
    transitionId,
    occurredAt,
    reason,
    definitionSourcePath,
    definitionSourceSha256,
    definition,
  }));
}

function receiptSha256(receipt) {
  const { receiptSha256: ignored, ...unsigned } = receipt;
  return sha256(canonical(unsigned));
}

function withReceiptHash(receipt) {
  return { ...receipt, receiptSha256: receiptSha256(receipt) };
}

function validateManifestRows(archive) {
  if (archive.manifestAlgorithm !== MANIFEST_ALGORITHM
    || !Array.isArray(archive.directories)
    || !Array.isArray(archive.files)) {
    throw new Error("Team project successor archive manifest is invalid.");
  }
  const directories = [...archive.directories].sort(compareBytes);
  if (canonical(directories) !== canonical(archive.directories)
    || new Set(directories).size !== directories.length
    || directories.some(value => (
      typeof value !== "string"
      || value.length === 0
      || path.isAbsolute(value)
      || value.includes("\\")
      || value.split("/").some(segment => !segment || segment === "." || segment === "..")
    ))) {
    throw new Error("Team project successor archive directories are invalid.");
  }
  for (const row of archive.files) {
    assertAllowedKeys(row, "Team project successor archive file", ["path", "byteLength", "sha256"]);
    if (typeof row.path !== "string"
      || row.path.length === 0
      || path.isAbsolute(row.path)
      || row.path.includes("\\")
      || row.path.split("/").some(segment => !segment || segment === "." || segment === "..")
      || !Number.isSafeInteger(row.byteLength)
      || row.byteLength < 0) {
      throw new Error("Team project successor archive file manifest is invalid.");
    }
    assertHash(row.sha256, "Team project successor archive file sha256");
  }
  const files = [...archive.files].sort((left, right) => compareBytes(left.path, right.path));
  if (canonical(files) !== canonical(archive.files)
    || new Set(files.map(row => row.path)).size !== files.length) {
    throw new Error("Team project successor archive files are not uniquely sorted.");
  }
  const expected = sha256(canonical({
    algorithm: MANIFEST_ALGORITHM,
    directories: archive.directories,
    files: archive.files,
  }));
  if (archive.manifestSha256 !== expected) {
    throw new Error("Team project successor archive manifest hash is invalid.");
  }
}

function validateSealPolicy(sealPolicy) {
  if (!isRecord(sealPolicy)) {
    throw new Error("Team project successor archive seal policy is invalid.");
  }
  assertAllowedKeys(sealPolicy, "Team project successor archive seal policy", [
    "policy", "regularFileMode", "directoryMode",
  ]);
  if (canonical(sealPolicy) !== canonical(ARCHIVE_SEAL_POLICY)) {
    throw new Error("Team project successor archive seal policy is invalid.");
  }
}

function validateDefinitionBinding(binding, label) {
  const normalized = normalizeTeamProjectDefinitionV1(binding.definition);
  if (canonical(normalized) !== canonical(binding.definition)) {
    throw new Error(`${label} definition is not normalized.`);
  }
  if (binding.projectId !== normalized.projectId) {
    throw new Error(`${label} projectId does not match its definition.`);
  }
  assertHash(binding.definitionRawSha256, `${label} definitionRawSha256`);
  assertHash(binding.definitionCanonicalSha256, `${label} definitionCanonicalSha256`);
  if (binding.definitionCanonicalSha256 !== sha256(canonical(normalized))) {
    throw new Error(`${label} definition canonical hash is invalid.`);
  }
  assertHash(binding.projectTruthHash, `${label} projectTruthHash`);
  if (!Number.isSafeInteger(binding.eventCount) || binding.eventCount < 0) {
    throw new Error(`${label} eventCount is invalid.`);
  }
  return normalized;
}

function validateJournal(receipt, { expectedPath, expectedTransitionId }) {
  assertAllowedKeys(receipt, "Team project successor receipt", [
    "schemaVersion", "status", "transitionId", "phase", "occurredAt", "reason",
    "requestSha256", "receiptPath", "from", "to", "archive",
    "repositoryActions", "authorizationGranted", "receiptSha256",
  ]);
  if (receipt.schemaVersion !== RECEIPT_SCHEMA
    || receipt.status !== "team_project_successor"
    || !PHASES.has(receipt.phase)
    || receipt.transitionId !== expectedTransitionId) {
    throw new Error("Team project successor receipt identity is invalid.");
  }
  validateTimestamp(receipt.occurredAt);
  nonEmptyString(receipt.reason, "Team project successor reason");
  assertHash(receipt.requestSha256, "Team project successor requestSha256");
  assertHash(receipt.receiptSha256, "Team project successor receiptSha256");
  if (receipt.receiptSha256 !== receiptSha256(receipt)) {
    throw new Error("Team project successor receipt hash is invalid.");
  }
  if (receipt.receiptPath !== expectedPath
    || receipt.authorizationGranted !== false
    || canonical(receipt.repositoryActions) !== canonical(REPOSITORY_ACTIONS)) {
    throw new Error("Team project successor receipt authority or path is invalid.");
  }
  assertAllowedKeys(receipt.from, "Team project successor from binding", [
    "projectId", "definition", "definitionRawSha256", "definitionCanonicalSha256",
    "projectTruthHash", "eventCount",
  ]);
  assertAllowedKeys(receipt.to, "Team project successor to binding", [
    "projectId", "definitionSourcePath", "definitionSourceSha256", "definition",
    "definitionRawSha256", "definitionCanonicalSha256", "projectTruthHash", "eventCount",
  ]);
  const fromDefinition = validateDefinitionBinding(receipt.from, "Team project successor from");
  const toDefinition = validateDefinitionBinding(receipt.to, "Team project successor to");
  if (fromDefinition.projectId === toDefinition.projectId || receipt.to.eventCount !== 0) {
    throw new Error("Team project successor definitions must have different identities and an empty target event set.");
  }
  if (typeof receipt.to.definitionSourcePath !== "string"
    || path.resolve(receipt.to.definitionSourcePath) !== receipt.to.definitionSourcePath) {
    throw new Error("Team project successor definition source path is invalid.");
  }
  assertHash(receipt.to.definitionSourceSha256, "Team project successor definitionSourceSha256");
  if (receipt.to.projectTruthHash !== emptyTeamProjectTruthHashV1(toDefinition)) {
    throw new Error("Team project successor target truth hash is invalid.");
  }
  assertAllowedKeys(receipt.archive, "Team project successor archive binding", [
    "path", "manifestAlgorithm", "manifestSha256", "directories", "files", "sealPolicy",
  ]);
  validateManifestRows(receipt.archive);
  validateSealPolicy(receipt.archive.sealPolicy);
  const expectedArchivePath = `${ARCHIVE_ROOT}/${receipt.from.projectId}-${receipt.from.projectTruthHash}-${receipt.archive.manifestSha256}`;
  if (receipt.archive.path !== expectedArchivePath) {
    throw new Error("Team project successor archive identity is invalid.");
  }
  const definitionEntry = receipt.archive.files.find(row => row.path === "definition.json");
  if (!definitionEntry || definitionEntry.sha256 !== receipt.from.definitionRawSha256) {
    throw new Error("Team project successor archive is not bound to the original definition bytes.");
  }
  const eventCount = receipt.archive.files.filter(row => (
    row.path.startsWith("events/") && row.path.endsWith(".json")
  )).length;
  if (eventCount !== receipt.from.eventCount) {
    throw new Error("Team project successor archive event count is invalid.");
  }
  const expectedRequest = requestSha256({
    transitionId: receipt.transitionId,
    occurredAt: receipt.occurredAt,
    reason: receipt.reason,
    definitionSourcePath: receipt.to.definitionSourcePath,
    definitionSourceSha256: receipt.to.definitionSourceSha256,
    definition: receipt.to.definition,
  });
  if (receipt.requestSha256 !== expectedRequest) {
    throw new Error("Team project successor request hash is invalid.");
  }
  return receipt;
}

function loadJournal(journalPath, root, transitionId) {
  const relativePath = relativeToWorkspace(root, journalPath);
  if (!pathEntryExists(journalPath)) return null;
  const bytes = readRegularBytes(journalPath, "Team project successor receipt/journal");
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Team project successor receipt/journal contains invalid JSON.");
  }
  return validateJournal(receipt, { expectedPath: relativePath, expectedTransitionId: transitionId });
}

function validateCompletedTransitionArchives(root) {
  const transitionRoot = path.join(root, TRANSITION_ROOT);
  if (!pathEntryExists(transitionRoot)) return;
  assertRealDirectory(
    transitionRoot,
    "Team project successor completed-transition namespace",
  );
  const entries = readdirSync(transitionRoot, { withFileTypes: true })
    .sort((left, right) => compareBytes(left.name, right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error("Team project successor transition namespace contains an unexpected input.");
    }
    const historicalTransitionId = entry.name.slice(0, -".json".length);
    safeIdentifier(historicalTransitionId, "historical transitionId");
    const receipt = loadJournal(
      path.join(transitionRoot, entry.name),
      root,
      historicalTransitionId,
    );
    if (receipt.phase !== "completed") continue;
    const label = `Historical team project archive for ${historicalTransitionId}`;
    assertArchiveIntegrity(path.join(root, receipt.archive.path), receipt.archive, label);
  }
}

function writeJournal(journalPath, receipt, { exclusive = false } = {}) {
  const hashed = withReceiptHash(receipt);
  writeDurableFile(
    journalPath,
    Buffer.from(`${JSON.stringify(hashed, null, 2)}\n`),
    { exclusive },
  );
  return hashed;
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLock(lockPath, label) {
  const bytes = readRegularBytes(lockPath, label);
  let lock;
  try {
    lock = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is malformed.`);
  }
  assertAllowedKeys(lock, label, [
    "schemaVersion", "transitionId", "requestSha256", "pid", "nonce", "createdAt",
  ]);
  if (lock.schemaVersion !== LOCK_SCHEMA) throw new Error(`${label} has an unknown schema.`);
  safeIdentifier(lock.transitionId, "transitionId");
  assertHash(lock.requestSha256, `${label} requestSha256`);
  if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0
    || typeof lock.nonce !== "string"
    || !/^[a-f0-9-]{36}$/u.test(lock.nonce)) {
    throw new Error(`${label} owner is invalid.`);
  }
  validateTimestamp(lock.createdAt);
  return lock;
}

function acquireLifecycleLock({ root, transitionId, requestHash, occurredAt }) {
  const lockPath = path.join(root, LIFECYCLE_LOCK);
  const lock = {
    schemaVersion: LOCK_SCHEMA,
    transitionId,
    requestSha256: requestHash,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: occurredAt,
  };
  for (;;) {
    if (!pathEntryExists(lockPath)) {
      try {
        writeDurableFile(
          lockPath,
          Buffer.from(`${JSON.stringify(lock, null, 2)}\n`),
          { exclusive: true },
        );
        return { path: lockPath, value: lock };
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
    }
    const existing = readLock(lockPath, "Team project successor lifecycle lock");
    if (existing.transitionId !== transitionId || existing.requestSha256 !== requestHash) {
      throw new Error("Another team project lifecycle transaction is active.");
    }
    if (isPidAlive(existing.pid)) {
      throw new Error("Another team project lifecycle transaction is active.");
    }
    const stalePath = `${lockPath}.stale-${randomUUID()}`;
    try {
      renameSync(lockPath, stalePath);
      fsyncDirectory(path.dirname(lockPath));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    rmSync(stalePath, { force: true });
    fsyncDirectory(path.dirname(lockPath));
  }
}

function releaseLifecycleLock(lock) {
  if (!lock || !pathEntryExists(lock.path)) return;
  const current = readLock(lock.path, "Team project successor lifecycle lock");
  if (current.nonce !== lock.value.nonce) {
    throw new Error("Team project successor lifecycle lock ownership changed.");
  }
  removeFileDurably(lock.path);
}

function activeControlOwnerPath(projectPath) {
  return path.join(projectPath, "control.lock", "successor-owner.json");
}

function acquireActiveControlLock({ projectPath, transitionId, requestHash, occurredAt }) {
  const lockPath = path.join(projectPath, "control.lock");
  const owner = {
    schemaVersion: LOCK_SCHEMA,
    transitionId,
    requestSha256: requestHash,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: occurredAt,
  };
  for (;;) {
    try {
      mkdirSync(lockPath);
      writeDurableFile(
        activeControlOwnerPath(projectPath),
        Buffer.from(`${JSON.stringify(owner, null, 2)}\n`),
        { exclusive: true },
      );
      fsyncDirectory(projectPath);
      return { projectPath, lockPath, owner };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    assertRealDirectory(lockPath, "Team project control lock");
    const ownerPath = activeControlOwnerPath(projectPath);
    if (!pathEntryExists(ownerPath)) {
      throw new Error("Another team project control transaction is active.");
    }
    const existing = readLock(ownerPath, "Team project successor control lock");
    if (existing.transitionId !== transitionId
      || existing.requestSha256 !== requestHash
      || isPidAlive(existing.pid)) {
      throw new Error("Another team project control transaction is active.");
    }
    const entries = readdirSync(lockPath);
    if (entries.length !== 1 || entries[0] !== "successor-owner.json") {
      throw new Error("Team project successor control lock contains unexpected entries.");
    }
    removeFileDurably(ownerPath);
    rmdirSync(lockPath);
    fsyncDirectory(projectPath);
  }
}

function releaseActiveControlLock(control) {
  if (!control || !pathEntryExists(control.projectPath)) return;
  if (!pathEntryExists(control.lockPath)) return;
  const ownerPath = activeControlOwnerPath(control.projectPath);
  const existing = readLock(ownerPath, "Team project successor control lock");
  if (existing.nonce !== control.owner.nonce) {
    throw new Error("Team project successor control lock ownership changed.");
  }
  removeFileDurably(ownerPath);
  rmdirSync(control.lockPath);
  fsyncDirectory(control.projectPath);
}

function removeArchivedControlLock(projectPath, receipt) {
  const lockPath = path.join(projectPath, "control.lock");
  if (!pathEntryExists(lockPath)) return;
  assertRealDirectory(lockPath, "Archived team project control lock");
  const ownerPath = activeControlOwnerPath(projectPath);
  const existing = readLock(ownerPath, "Archived team project successor control lock");
  if (existing.transitionId !== receipt.transitionId
    || existing.requestSha256 !== receipt.requestSha256) {
    throw new Error("Archived team project control lock is not owned by this transition.");
  }
  const entries = readdirSync(lockPath);
  if (entries.length !== 1 || entries[0] !== "successor-owner.json") {
    throw new Error("Archived team project control lock contains unexpected entries.");
  }
  removeFileDurably(ownerPath);
  rmdirSync(lockPath);
  fsyncDirectory(projectPath);
}

function assertInvocationMatchesJournal(receipt, invocation) {
  if (receipt.transitionId !== invocation.transitionId
    || receipt.occurredAt !== invocation.occurredAt
    || receipt.reason !== invocation.reason
    || receipt.to.definitionSourcePath !== invocation.definitionSourcePath) {
    throw new Error("Team project successor retry does not match the durable transition request.");
  }
  const source = readDefinitionSource(invocation.definitionSourcePath, { allowMissing: true });
  if (!source.missing && (
    source.sourceSha256 !== receipt.to.definitionSourceSha256
    || canonical(source.definition) !== canonical(receipt.to.definition)
  )) {
    throw new Error("Team project successor retry definition differs from the durable transition request.");
  }
}

function createPreparedProject(projectPath, receipt, root) {
  ensureRealDirectory(root, path.dirname(projectPath), "Team project successor staging namespace");
  if (!pathEntryExists(projectPath)) mkdirSync(projectPath);
  assertRealDirectory(projectPath, "Team project successor staged active project");
  const allowed = new Set(["definition.json", "events"]);
  for (const entry of readdirSync(projectPath)) {
    if (!allowed.has(entry)) {
      throw new Error(`Team project successor staged active project contains unexpected entry: ${entry}.`);
    }
  }
  const definitionPath = path.join(projectPath, "definition.json");
  const definitionBytes = Buffer.from(`${JSON.stringify(receipt.to.definition, null, 2)}\n`);
  if (!pathEntryExists(definitionPath)) {
    writeDurableFile(definitionPath, definitionBytes, { exclusive: true });
  } else if (!readRegularBytes(
    definitionPath,
    "Team project successor staged definition",
  ).equals(definitionBytes)) {
    throw new Error("Team project successor staged definition bytes differ.");
  }
  const eventsPath = path.join(projectPath, "events");
  if (!pathEntryExists(eventsPath)) mkdirSync(eventsPath);
  assertRealDirectory(eventsPath, "Team project successor staged event directory");
  if (readdirSync(eventsPath).length !== 0) {
    throw new Error("Team project successor staged event set must be empty.");
  }
  fsyncDirectory(projectPath);
}

function assertFreshActiveProject(root, receipt) {
  const activePath = path.join(root, ACTIVE_PROJECT);
  assertRealDirectory(activePath, "Team project successor active project");
  const entries = readdirSync(activePath).sort(compareBytes);
  if (canonical(entries) !== canonical(["definition.json", "events"])) {
    throw new Error("Team project successor active project contains borrowed or unexpected truth.");
  }
  const expectedDefinitionBytes = Buffer.from(`${JSON.stringify(receipt.to.definition, null, 2)}\n`);
  const actualDefinitionBytes = readRegularBytes(
    path.join(activePath, "definition.json"),
    "Team project successor active definition",
  );
  if (!actualDefinitionBytes.equals(expectedDefinitionBytes)
    || sha256(actualDefinitionBytes) !== receipt.to.definitionRawSha256) {
    throw new Error("Team project successor active definition bytes differ from the transition receipt.");
  }
  const eventsPath = path.join(activePath, "events");
  assertRealDirectory(eventsPath, "Team project successor active event directory");
  if (readdirSync(eventsPath).length !== 0) {
    throw new Error("Team project successor active event set is not empty.");
  }
  const status = readTeamProjectStatusV1({ workspaceRoot: root });
  if (status.projectId !== receipt.to.projectId
    || status.projectTruthHash !== receipt.to.projectTruthHash
    || status.overall !== "planned") {
    throw new Error("Team project successor active project does not match the fresh target truth.");
  }
}

function createInitialJournal({
  root,
  transitionId,
  occurredAt,
  reason,
  definitionSource,
  requestHash,
  journalPath,
  activePath,
}) {
  const status = readTeamProjectStatusV1({ workspaceRoot: root });
  if (status.overall !== "completed") {
    throw new Error("Team project successor requires active project derived status to be completed.");
  }
  const fromDefinitionBytes = readRegularBytes(
    path.join(activePath, "definition.json"),
    "Active team project definition",
  );
  const fromDefinition = parseDefinition(fromDefinitionBytes, "Active team project definition");
  if (fromDefinition.projectId === definitionSource.definition.projectId) {
    throw new Error("Team project successor definition must use a different project identity.");
  }
  const manifest = manifestForDirectory(
    activePath,
    "Active team project",
    { excludeRootControlLock: true },
  );
  const definitionEntry = manifest.files.find(row => row.path === "definition.json");
  if (!definitionEntry) throw new Error("Active team project definition is missing from its raw manifest.");
  const archivePath = `${ARCHIVE_ROOT}/${fromDefinition.projectId}-${status.projectTruthHash}-${manifest.manifestSha256}`;
  const archiveAbsolutePath = path.join(root, archivePath);
  if (pathEntryExists(archiveAbsolutePath)) {
    const stat = lstatSync(archiveAbsolutePath);
    if (stat.isSymbolicLink()) throw new Error("Team project archive collision is a symlink.");
    throw new Error("Team project archive collision already exists before transition preparation.");
  }
  const targetDefinitionBytes = Buffer.from(`${JSON.stringify(definitionSource.definition, null, 2)}\n`);
  const relativeJournalPath = relativeToWorkspace(root, journalPath);
  return {
    schemaVersion: RECEIPT_SCHEMA,
    status: "team_project_successor",
    transitionId,
    phase: "prepared",
    occurredAt,
    reason,
    requestSha256: requestHash,
    receiptPath: relativeJournalPath,
    from: {
      projectId: fromDefinition.projectId,
      definition: fromDefinition,
      definitionRawSha256: definitionEntry.sha256,
      definitionCanonicalSha256: sha256(canonical(fromDefinition)),
      projectTruthHash: status.projectTruthHash,
      eventCount: manifest.files.filter(row => (
        row.path.startsWith("events/") && row.path.endsWith(".json")
      )).length,
    },
    to: {
      projectId: definitionSource.definition.projectId,
      definitionSourcePath: definitionSource.sourcePath,
      definitionSourceSha256: definitionSource.sourceSha256,
      definition: definitionSource.definition,
      definitionRawSha256: sha256(targetDefinitionBytes),
      definitionCanonicalSha256: sha256(canonical(definitionSource.definition)),
      projectTruthHash: emptyTeamProjectTruthHashV1(definitionSource.definition),
      eventCount: 0,
    },
    archive: {
      path: archivePath,
      manifestAlgorithm: MANIFEST_ALGORITHM,
      manifestSha256: manifest.manifestSha256,
      directories: manifest.directories,
      files: manifest.files,
      sealPolicy: { ...ARCHIVE_SEAL_POLICY },
    },
    repositoryActions: { ...REPOSITORY_ACTIONS },
    authorizationGranted: false,
  };
}

function projectLooksLikeTarget(root, receipt) {
  const activePath = path.join(root, ACTIVE_PROJECT);
  if (!pathEntryExists(activePath)) return false;
  try {
    const bytes = readRegularBytes(
      path.join(activePath, "definition.json"),
      "Team project successor active definition",
    );
    return sha256(bytes) === receipt.to.definitionRawSha256;
  } catch {
    return false;
  }
}

function cleanupEmptyStaging(stagePath) {
  if (!pathEntryExists(stagePath)) return;
  assertRealDirectory(stagePath, "Team project successor staging directory");
  if (readdirSync(stagePath).length !== 0) return;
  rmdirSync(stagePath);
  fsyncDirectory(path.dirname(stagePath));
}

function resultFor(receipt, resumed) {
  return {
    status: "team_project_successor",
    phase: receipt.phase,
    transitionId: receipt.transitionId,
    fromProjectId: receipt.from.projectId,
    toProjectId: receipt.to.projectId,
    archivePath: receipt.archive.path,
    receiptPath: receipt.receiptPath,
    receiptSha256: receipt.receiptSha256,
    resumed,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function successorTeamProjectV1({
  workspaceRoot,
  transitionId,
  occurredAt,
  definitionPath,
  reason,
  onDurableStep,
}) {
  const root = assertWorkspaceRoot(workspaceRoot);
  safeIdentifier(transitionId, "transitionId");
  validateTimestamp(occurredAt);
  nonEmptyString(reason, "Team project successor reason");
  const runkitPath = path.join(root, RUNKIT_ROOT);
  assertRealDirectory(path.join(root, ".owlcoda"), "OwlCoda control directory");
  assertRealDirectory(runkitPath, "RunKit control directory");
  const activePath = path.join(root, ACTIVE_PROJECT);
  if (pathEntryExists(activePath)) {
    assertRealDirectory(activePath, "Active project");
  }
  const journalPath = path.join(root, TRANSITION_ROOT, `${transitionId}.json`);
  const invocation = {
    transitionId,
    occurredAt,
    reason,
    definitionSourcePath: path.resolve(nonEmptyString(definitionPath, "definitionPath")),
  };
  const existingBeforeLock = pathEntryExists(path.dirname(journalPath))
    ? loadJournal(journalPath, root, transitionId)
    : null;
  let definitionSource;
  let requestHash;
  if (existingBeforeLock) {
    assertInvocationMatchesJournal(existingBeforeLock, invocation);
    definitionSource = {
      sourcePath: existingBeforeLock.to.definitionSourcePath,
      sourceSha256: existingBeforeLock.to.definitionSourceSha256,
      definition: existingBeforeLock.to.definition,
      missing: false,
    };
    requestHash = existingBeforeLock.requestSha256;
  } else {
    definitionSource = readDefinitionSource(definitionPath);
    requestHash = requestSha256({
      transitionId,
      occurredAt,
      reason,
      definitionSourcePath: definitionSource.sourcePath,
      definitionSourceSha256: definitionSource.sourceSha256,
      definition: definitionSource.definition,
    });
  }

  const lifecycleLock = acquireLifecycleLock({
    root,
    transitionId,
    requestHash,
    occurredAt,
  });
  let activeControl = null;
  let activeControlMoved = false;
  const resumed = existingBeforeLock !== null;
  try {
    let receipt = pathEntryExists(path.dirname(journalPath))
      ? loadJournal(journalPath, root, transitionId)
      : null;
    if (receipt) {
      assertInvocationMatchesJournal(receipt, invocation);
      if (receipt.requestSha256 !== requestHash) {
        throw new Error("Team project successor lifecycle lock does not match the journal request.");
      }
    }
    validateCompletedTransitionArchives(root);
    if (!receipt) {
      if (!pathEntryExists(activePath)) throw new Error("Team project is not initialized.");
      activeControl = acquireActiveControlLock({
        projectPath: activePath,
        transitionId,
        requestHash,
        occurredAt,
      });
      const prepared = createInitialJournal({
        root,
        transitionId,
        occurredAt,
        reason,
        definitionSource,
        requestHash,
        journalPath,
        activePath,
      });
      ensureRealDirectory(root, path.dirname(journalPath), "Team project successor receipt namespace");
      receipt = writeJournal(journalPath, prepared, { exclusive: true });
      onDurableStep?.({ phase: "prepared", receiptPath: receipt.receiptPath });
    }

    const archivePath = path.join(root, receipt.archive.path);
    const stagePath = path.join(root, STAGING_ROOT, transitionId);
    const stagedNextPath = path.join(stagePath, "next-project");
    const stagedArchivePath = path.join(stagePath, "archived-project");

    if (receipt.phase === "completed") {
      assertFreshActiveProject(root, receipt);
      return resultFor(receipt, true);
    }

    if (pathEntryExists(archivePath)) {
      const stat = lstatSync(archivePath);
      if (stat.isSymbolicLink()) throw new Error("Team project archive input must not be a symlink.");
      assertManifestMatches(archivePath, receipt.archive);
      if (receipt.phase === "prepared") sealArchiveTree(archivePath);
      assertArchiveIntegrity(archivePath, receipt.archive);
    }

    if (!pathEntryExists(archivePath)) {
      createPreparedProject(stagedNextPath, receipt, root);
      if (!pathEntryExists(stagedArchivePath)) {
        if (!pathEntryExists(activePath)) {
          throw new Error("Team project successor cannot recover the missing active project or archive.");
        }
        if (projectLooksLikeTarget(root, receipt)) {
          throw new Error("Team project successor target is active without its immutable archive.");
        }
        if (!activeControl) {
          activeControl = acquireActiveControlLock({
            projectPath: activePath,
            transitionId,
            requestHash,
            occurredAt,
          });
        }
        const status = readTeamProjectStatusV1({ workspaceRoot: root });
        const manifest = manifestForDirectory(
          activePath,
          "Active team project",
          { excludeRootControlLock: true },
        );
        if (status.overall !== "completed"
          || status.projectId !== receipt.from.projectId
          || status.projectTruthHash !== receipt.from.projectTruthHash
          || manifest.manifestSha256 !== receipt.archive.manifestSha256
          || canonical(manifest.directories) !== canonical(receipt.archive.directories)
          || canonical(manifest.files) !== canonical(receipt.archive.files)) {
          throw new Error("Active team project changed after successor preparation.");
        }
        ensureRealDirectory(root, stagePath, "Team project successor staging directory");
        renameDirectoryDurably(activePath, stagedArchivePath);
        activeControlMoved = true;
      } else {
        assertRealDirectory(stagedArchivePath, "Staged team project archive");
      }
      removeArchivedControlLock(stagedArchivePath, receipt);
      assertManifestMatches(stagedArchivePath, receipt.archive);
      ensureRealDirectory(root, path.dirname(archivePath), "Team project archive namespace");
      if (pathEntryExists(archivePath)) {
        throw new Error("Team project archive collision appeared during transition.");
      }
      renameDirectoryDurably(stagedArchivePath, archivePath);
      sealArchiveTree(archivePath);
    }
    assertArchiveIntegrity(archivePath, receipt.archive);
    if (receipt.phase === "prepared") {
      receipt = writeJournal(journalPath, { ...receipt, phase: "archived" });
      onDurableStep?.({ phase: "archived", receiptPath: receipt.receiptPath });
    }

    if (pathEntryExists(activePath)) {
      if (pathEntryExists(stagedNextPath)) {
        throw new Error("Team project successor has both an active and staged target project.");
      }
      assertFreshActiveProject(root, receipt);
    } else {
      if (!pathEntryExists(stagedNextPath)) createPreparedProject(stagedNextPath, receipt, root);
      renameDirectoryDurably(stagedNextPath, activePath);
      assertFreshActiveProject(root, receipt);
    }
    if (receipt.phase === "archived") {
      receipt = writeJournal(journalPath, { ...receipt, phase: "active_installed" });
      onDurableStep?.({ phase: "active_installed", receiptPath: receipt.receiptPath });
    }

    if (receipt.phase === "active_installed") {
      receipt = writeJournal(journalPath, { ...receipt, phase: "completed" });
    }
    assertArchiveIntegrity(archivePath, receipt.archive);
    assertFreshActiveProject(root, receipt);
    cleanupEmptyStaging(stagePath);
    return resultFor(receipt, resumed);
  } finally {
    if (!activeControlMoved) releaseActiveControlLock(activeControl);
    releaseLifecycleLock(lifecycleLock);
  }
}

export function formatTeamProjectSuccessorHumanV1(result) {
  return [
    `Archived completed project ${result.fromProjectId}.`,
    `Active project: ${result.toProjectId}`,
    `Archive: ${result.archivePath}`,
    `Receipt: ${result.receiptPath}`,
    `Authorization granted: ${result.authorizationGranted}`,
    "",
  ].join("\n");
}
