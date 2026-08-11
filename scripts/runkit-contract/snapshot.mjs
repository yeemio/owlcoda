import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalSourceFingerprint } from "./source-fingerprint.mjs";
import {
  assertAllowedKeys,
  isRecord,
  loadActiveExecution,
  relativeToWorkspace,
  resolveWithinRoot,
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonExclusive,
} from "./provenance-common.mjs";
import {
  validateVerificationContext,
  verificationContextFingerprint,
} from "./verification-context.mjs";

const STATUS_MODE = "porcelain-v1-z-untracked-all-runkit-excluded";
const REQUEST_KEYS = [
  "schemaVersion",
  "snapshotId",
  "mode",
  "targetRoot",
  "cwd",
  "executable",
  "argv",
  "launcherVersion",
  "toolVersions",
  "selectedPaths",
  "statusMode",
  "verificationContext",
];

function lineCount(bytes) {
  if (bytes.length === 0) return 0;
  const text = bytes.toString("utf8");
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
}

function git(targetRoot, args) {
  const completed = spawnSync("git", ["-C", targetRoot, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    throw new Error(`Git snapshot command failed: ${completed.stderr.toString("utf8").trim()}`);
  }
  return completed.stdout;
}

function selectedFileMap(targetRoot, selectedPaths) {
  const files = {};
  for (const selectedPath of selectedPaths) {
    const safePath = safeRelativePath(selectedPath, "selectedPaths entry");
    if (safePath === ".owlcoda/runkit" || safePath.startsWith(".owlcoda/runkit/")) {
      throw new Error("selectedPaths must exclude .owlcoda/runkit/**.");
    }
    const absolutePath = resolveWithinRoot(targetRoot, safePath, "selectedPaths entry");
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`selectedPaths entry must be a regular non-symlink file: ${safePath}`);
    }
    files[safePath] = sha256(readFileSync(absolutePath));
  }
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}

export function captureTargetState({ targetRoot, selectedPaths }) {
  const head = git(targetRoot, ["rev-parse", "HEAD"]).toString("utf8").trim();
  const status = git(targetRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude).owlcoda/runkit/**",
  ]);
  const selectedFiles = selectedFileMap(targetRoot, selectedPaths);
  return {
    head,
    statusMode: STATUS_MODE,
    statusSha256: sha256(status),
    statusByteCount: status.length,
    statusEntryCount: status.length === 0 ? 0 : status.toString("utf8").split("\0").filter(Boolean).length,
    selectedFiles,
    manifestFingerprint: canonicalSourceFingerprint(selectedFiles),
  };
}

function stableTarget(before, after) {
  return before.head === after.head
    && before.statusSha256 === after.statusSha256
    && before.manifestFingerprint === after.manifestFingerprint;
}

function normalizedFileMap(value) {
  if (!isRecord(value)
    || Object.values(value).some(hash => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    return null;
  }
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

export function verifySnapshotSourceBinding({ snapshot, expectedFiles, expectedFingerprint }) {
  const issues = [];
  const expected = normalizedFileMap(expectedFiles);
  const before = normalizedFileMap(snapshot?.repositoryBefore?.selectedFiles);
  const after = normalizedFileMap(snapshot?.repositoryAfter?.selectedFiles);
  if (!expected) issues.push("Delivery packet changed-file map is invalid.");
  if (!before || !after) issues.push("Snapshot selected-file maps are invalid.");
  if (expected && canonicalSourceFingerprint(expected) !== expectedFingerprint) {
    issues.push("Delivery packet files do not match its source fingerprint.");
  }
  if (snapshot?.repositoryBefore?.manifestFingerprint !== expectedFingerprint
    || snapshot?.repositoryAfter?.manifestFingerprint !== expectedFingerprint) {
    issues.push("Snapshot manifest does not match the delivery source fingerprint.");
  }
  if (expected && before && JSON.stringify(before) !== JSON.stringify(expected)) {
    issues.push("Snapshot repositoryBefore files do not match the DeliveryPacket.");
  }
  if (expected && after && JSON.stringify(after) !== JSON.stringify(expected)) {
    issues.push("Snapshot repositoryAfter files do not match the DeliveryPacket.");
  }
  const expectedInputs = expected
    ? Object.entries(expected).map(([id, hash]) => ({ id, sha256: hash }))
    : [];
  const actualInputs = Array.isArray(snapshot?.command?.evidence?.materialInputs)
    ? [...snapshot.command.evidence.materialInputs]
      .sort((left, right) => String(left?.id).localeCompare(String(right?.id)))
    : null;
  if (!actualInputs || JSON.stringify(actualInputs) !== JSON.stringify(expectedInputs)) {
    issues.push("Snapshot material inputs do not match the DeliveryPacket.");
  }
  return { valid: issues.length === 0, issues };
}

function validateRequest(request) {
  assertAllowedKeys(request, "Snapshot request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitSnapshotRequestV1") {
    throw new Error("Unsupported snapshot request schemaVersion.");
  }
  safeIdentifier(request.snapshotId, "snapshotId");
  if (!new Set(["project", "foreign_readonly"]).has(request.mode)) {
    throw new Error("Snapshot mode must be project or foreign_readonly.");
  }
  if (typeof request.targetRoot !== "string" || request.targetRoot.length === 0) {
    throw new Error("Snapshot request requires targetRoot.");
  }
  safeRelativePath(request.cwd, "Snapshot cwd", { allowDot: true });
  if (typeof request.executable !== "string" || !path.isAbsolute(request.executable)) {
    throw new Error("Snapshot requires an absolute executable path.");
  }
  if (!Array.isArray(request.argv)
    || request.argv.some((value) => typeof value !== "string")) {
    throw new Error("Snapshot requires an exact string argv array.");
  }
  if (typeof request.launcherVersion !== "string" || request.launcherVersion.length === 0) {
    throw new Error("Snapshot requires launcherVersion.");
  }
  if (!Array.isArray(request.toolVersions)
    || request.toolVersions.some((entry) => !isRecord(entry)
      || typeof entry.name !== "string"
      || typeof entry.version !== "string")) {
    throw new Error("Snapshot toolVersions must contain name and version.");
  }
  if (!Array.isArray(request.selectedPaths)) {
    throw new Error("Snapshot requires selectedPaths.");
  }
  if (request.statusMode !== STATUS_MODE) {
    throw new Error(`Snapshot statusMode must be ${STATUS_MODE}.`);
  }
  const context = validateVerificationContext(request.verificationContext);
  if (!context.valid) throw new Error(`Snapshot verification context is invalid: ${context.issues.join("; ")}`);
}

export function verifySnapshotEvidence({ workspaceRoot, runId, snapshot }) {
  const issues = [];
  if (!isRecord(snapshot) || snapshot.schemaVersion !== "OwlCodaRunKitSnapshotV1") {
    return { valid: false, issues: ["Unsupported snapshot schemaVersion."] };
  }
  if (snapshot.runId !== runId) issues.push("Snapshot runId does not match the execution.");
  if (snapshot.status !== "snapshot_passed") issues.push("Snapshot did not pass.");
  for (const [label, relativePath, expected] of [
    ["stdout", snapshot.command?.stdoutPath, snapshot.command?.stdoutSha256],
    ["stderr", snapshot.command?.stderrPath, snapshot.command?.stderrSha256],
  ]) {
    try {
      const absolutePath = resolveWithinRoot(workspaceRoot, relativePath, `${label} evidence path`);
      const actual = sha256(readFileSync(absolutePath));
      if (actual !== expected) issues.push(`${label} evidence hash mismatch.`);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const artifact of snapshot.command?.evidence?.outputArtifacts ?? []) {
    try {
      const absolutePath = resolveWithinRoot(workspaceRoot, artifact.path, "output artifact path");
      const actual = sha256(readFileSync(absolutePath));
      if (actual !== artifact.sha256) issues.push(`output artifact hash mismatch: ${artifact.path}`);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (snapshot.command?.evidence?.kind === "automation") {
    const manifest = snapshot.command.evidence.outputArtifacts?.find(
      (artifact) => artifact.path === snapshot.visual?.automationManifestPath,
    );
    if (!manifest || manifest.sha256 !== snapshot.command.evidence.automationManifestSha256) {
      issues.push("Automation manifest is not bound to the replayable evidence hash.");
    }
    if (!snapshot.command.evidence.outputArtifacts?.some(
      (artifact) => artifact.path === snapshot.visual?.resultPath,
    )) {
      issues.push("Automation result is not bound as an output artifact.");
    }
  }
  if (!stableTarget(snapshot.repositoryBefore, snapshot.repositoryAfter)) {
    issues.push("Snapshot target changed while the command ran.");
  }
  return { valid: issues.length === 0, issues };
}

export function verifySnapshotFreshness(snapshot) {
  try {
    const current = captureTargetState({
      targetRoot: realpathSync(snapshot.targetRoot),
      selectedPaths: Object.keys(snapshot.repositoryAfter.selectedFiles),
    });
    const valid = current.head === snapshot.repositoryAfter.head
      && current.manifestFingerprint === snapshot.repositoryAfter.manifestFingerprint;
    return {
      valid,
      current,
      issues: valid ? [] : ["Snapshot target HEAD or selected manifest changed."],
    };
  } catch (error) {
    return { valid: false, current: null, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

export function runSnapshot({ workspaceRoot, runId, request }) {
  validateRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  const targetRoot = realpathSync(request.targetRoot);
  if (request.mode === "project" && targetRoot !== workspaceRoot) {
    throw new Error("Project snapshot targetRoot must equal the RunKit workspace.");
  }
  const cwd = request.cwd === "."
    ? targetRoot
    : realpathSync(resolveWithinRoot(targetRoot, request.cwd, "Snapshot cwd"));
  const snapshotRoot = path.join(executionRoot, "snapshots");
  const evidenceRoot = path.join(executionRoot, "snapshot-evidence");
  const snapshotPath = path.join(snapshotRoot, `${request.snapshotId}.json`);
  const stdoutPath = path.join(evidenceRoot, `${request.snapshotId}.stdout`);
  const stderrPath = path.join(evidenceRoot, `${request.snapshotId}.stderr`);
  const before = captureTargetState({ targetRoot, selectedPaths: request.selectedPaths });
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const completed = spawnSync(request.executable, request.argv, {
    cwd,
    encoding: null,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  const endedAt = new Date().toISOString();
  const stdout = completed.stdout ?? Buffer.alloc(0);
  const stderr = completed.stderr ?? Buffer.from(completed.error?.message ?? "", "utf8");
  const after = captureTargetState({ targetRoot, selectedPaths: request.selectedPaths });
  const targetStable = stableTarget(before, after);
  const exitCode = Number.isInteger(completed.status) ? completed.status : 1;
  const status = !targetStable
    ? "invalidated_by_target_write"
    : exitCode === 0
      ? "snapshot_passed"
      : "snapshot_failed";
  const contextFingerprint = verificationContextFingerprint(request.verificationContext);
  const stdoutRelative = relativeToWorkspace(workspaceRoot, stdoutPath);
  const stderrRelative = relativeToWorkspace(workspaceRoot, stderrPath);
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(stdoutPath, stdout, { flag: "wx" });
  writeFileSync(stderrPath, stderr, { flag: "wx" });
  const snapshot = {
    schemaVersion: "OwlCodaRunKitSnapshotV1",
    runId,
    snapshotId: request.snapshotId,
    status,
    mode: request.mode,
    targetRoot,
    verificationContextFingerprint: contextFingerprint,
    repositoryBefore: before,
    repositoryAfter: after,
    command: {
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      exitCode,
      stdoutPath: stdoutRelative,
      stdoutSha256: sha256(stdout),
      stdoutLineCount: lineCount(stdout),
      stderrPath: stderrRelative,
      stderrSha256: sha256(stderr),
      stderrLineCount: lineCount(stderr),
      evidence: {
        schemaVersion: "OwlCodaRunKitReplayableEvidenceV1",
        kind: "shell",
        cwd: request.cwd,
        launcher: { executable: request.executable, version: request.launcherVersion },
        argv: [request.executable, ...request.argv],
        toolVersions: structuredClone(request.toolVersions),
        materialInputs: Object.entries(before.selectedFiles).map(([id, hash]) => ({ id, sha256: hash })),
        outputArtifacts: [
          { path: stdoutRelative, sha256: sha256(stdout) },
          { path: stderrRelative, sha256: sha256(stderr) },
        ],
      },
    },
    authorizationGranted: false,
  };
  writeJsonExclusive(snapshotPath, snapshot);
  return {
    status,
    exitCode: status === "snapshot_passed" ? 0 : 2,
    runId,
    snapshotPath: relativeToWorkspace(workspaceRoot, snapshotPath),
    authorizationGranted: false,
  };
}
