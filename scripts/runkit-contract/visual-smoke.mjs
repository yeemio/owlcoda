import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { captureTargetState } from "./snapshot.mjs";
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
  "smokeId",
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
  "resultPath",
  "automationManifest",
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function lineCount(bytes) {
  if (bytes.length === 0) return 0;
  const text = bytes.toString("utf8");
  return text.endsWith("\n") ? text.slice(0, -1).split("\n").length : text.split("\n").length;
}

function targetStable(before, after) {
  return before.head === after.head
    && before.statusSha256 === after.statusSha256
    && before.manifestFingerprint === after.manifestFingerprint;
}

function withinRoot(root, candidate) {
  const remainder = path.relative(root, candidate);
  return remainder === ""
    || (!remainder.startsWith(`..${path.sep}`) && remainder !== ".." && !path.isAbsolute(remainder));
}

function validateNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
}

function validateAutomationManifest(manifest) {
  assertAllowedKeys(manifest, "automationManifest", [
    "schemaVersion",
    "surface",
    "viewport",
    "assertionIds",
    "consolePolicy",
    "externalNavigationPolicy",
  ]);
  if (manifest.schemaVersion !== "OwlCodaRunKitVisualAutomationManifestV1") {
    throw new Error("Unsupported automationManifest schemaVersion.");
  }
  safeIdentifier(manifest.surface, "automationManifest surface");
  assertAllowedKeys(manifest.viewport, "automationManifest viewport", ["width", "height"]);
  if (!Number.isInteger(manifest.viewport.width) || manifest.viewport.width < 1
    || !Number.isInteger(manifest.viewport.height) || manifest.viewport.height < 1) {
    throw new Error("automationManifest viewport requires positive integer width and height.");
  }
  if (!Array.isArray(manifest.assertionIds) || manifest.assertionIds.length === 0) {
    throw new Error("automationManifest requires assertionIds.");
  }
  const assertionIds = manifest.assertionIds.map((value) => safeIdentifier(value, "assertion id"));
  if (new Set(assertionIds).size !== assertionIds.length) {
    throw new Error("automationManifest assertionIds must be unique.");
  }
  assertAllowedKeys(manifest.consolePolicy, "automationManifest consolePolicy", [
    "maxErrors",
    "maxWarnings",
    "maxExceptions",
  ]);
  validateNonNegativeInteger(manifest.consolePolicy.maxErrors, "consolePolicy maxErrors");
  validateNonNegativeInteger(manifest.consolePolicy.maxWarnings, "consolePolicy maxWarnings");
  validateNonNegativeInteger(manifest.consolePolicy.maxExceptions, "consolePolicy maxExceptions");
  if (manifest.externalNavigationPolicy !== "deny") {
    throw new Error("visual-smoke MVP requires externalNavigationPolicy deny.");
  }
}

function validateRequest(request) {
  assertAllowedKeys(request, "Visual smoke request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitVisualSmokeRequestV1") {
    throw new Error("Unsupported visual smoke request schemaVersion.");
  }
  safeIdentifier(request.smokeId, "smokeId");
  if (!new Set(["project", "foreign_readonly"]).has(request.mode)) {
    throw new Error("Visual smoke mode must be project or foreign_readonly.");
  }
  if (typeof request.targetRoot !== "string" || request.targetRoot.length === 0) {
    throw new Error("Visual smoke request requires targetRoot.");
  }
  safeRelativePath(request.cwd, "Visual smoke cwd", { allowDot: true });
  if (typeof request.executable !== "string" || !path.isAbsolute(request.executable)) {
    throw new Error("Visual smoke requires an absolute executable path.");
  }
  if (!Array.isArray(request.argv)
    || request.argv.length === 0
    || request.argv.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Visual smoke requires exact non-empty argv.");
  }
  if (typeof request.launcherVersion !== "string" || request.launcherVersion.length === 0) {
    throw new Error("Visual smoke requires launcherVersion.");
  }
  if (!Array.isArray(request.toolVersions)
    || request.toolVersions.some((entry) => !isRecord(entry)
      || typeof entry.name !== "string"
      || typeof entry.version !== "string")) {
    throw new Error("Visual smoke toolVersions must contain name and version.");
  }
  if (!Array.isArray(request.selectedPaths) || request.selectedPaths.length === 0) {
    throw new Error("Visual smoke requires selectedPaths.");
  }
  if (request.statusMode !== STATUS_MODE) {
    throw new Error(`Visual smoke statusMode must be ${STATUS_MODE}.`);
  }
  safeRelativePath(request.resultPath, "Visual smoke resultPath");
  const context = validateVerificationContext(request.verificationContext);
  if (!context.valid) throw new Error(`Visual smoke verification context is invalid: ${context.issues.join("; ")}`);
  validateAutomationManifest(request.automationManifest);
}

function resultIssues(result, manifest) {
  const issues = [];
  try {
    assertAllowedKeys(result, "Visual smoke result", [
      "schemaVersion",
      "status",
      "viewport",
      "assertions",
      "console",
      "navigations",
      "outputArtifacts",
    ]);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (result.schemaVersion !== "OwlCodaRunKitVisualSmokeResultV1") {
    issues.push("Unsupported visual smoke result schemaVersion.");
  }
  if (!new Set(["passed", "failed"]).has(result.status)) issues.push("Visual smoke result status must be passed or failed.");
  if (!isRecord(result.viewport)
    || result.viewport.width !== manifest.viewport.width
    || result.viewport.height !== manifest.viewport.height) {
    issues.push("Visual smoke viewport does not match the automation manifest.");
  }
  if (!Array.isArray(result.assertions)) {
    issues.push("Visual smoke result requires assertions.");
  } else {
    const actualIds = [];
    for (const assertion of result.assertions) {
      if (!isRecord(assertion)
        || typeof assertion.id !== "string"
        || typeof assertion.passed !== "boolean"
        || Object.keys(assertion).some((key) => !new Set(["id", "passed"]).has(key))) {
        issues.push("Visual smoke assertions require only id and passed.");
        continue;
      }
      actualIds.push(assertion.id);
      if (!assertion.passed) issues.push(`Visual assertion failed: ${assertion.id}`);
    }
    if (JSON.stringify([...actualIds].sort()) !== JSON.stringify([...manifest.assertionIds].sort())) {
      issues.push("Visual smoke assertion ids do not match the automation manifest.");
    }
  }
  if (!isRecord(result.console)) {
    issues.push("Visual smoke result requires console counts.");
  } else {
    for (const [field, policyField] of [
      ["errors", "maxErrors"],
      ["warnings", "maxWarnings"],
      ["exceptions", "maxExceptions"],
    ]) {
      if (!Number.isInteger(result.console[field]) || result.console[field] < 0) {
        issues.push(`Visual smoke console ${field} must be a non-negative integer.`);
      } else if (result.console[field] > manifest.consolePolicy[policyField]) {
        issues.push(`Visual smoke console ${field} exceeded policy.`);
      }
    }
  }
  if (!Array.isArray(result.navigations)) {
    issues.push("Visual smoke result requires navigations.");
  } else {
    for (const navigation of result.navigations) {
      if (!isRecord(navigation)
        || typeof navigation.protocol !== "string"
        || typeof navigation.external !== "boolean"
        || Object.keys(navigation).some((key) => !new Set(["protocol", "external"]).has(key))) {
        issues.push("Visual smoke navigations require only protocol and external.");
      } else if (navigation.external) {
        issues.push("External navigation is forbidden by the automation manifest.");
      }
    }
  }
  if (!Array.isArray(result.outputArtifacts) || result.outputArtifacts.length === 0) {
    issues.push("Visual smoke result requires output artifacts.");
  }
  if (result.status !== "passed") issues.push("Visual smoke runner reported failed status.");
  return issues;
}

function collectRunnerArtifacts({ workspaceRoot, evidenceRoot, result }) {
  const issues = [];
  const artifacts = [];
  const seen = new Set();
  if (!Array.isArray(result?.outputArtifacts)) return { artifacts, issues };
  for (const entry of result.outputArtifacts) {
    if (!isRecord(entry)
      || typeof entry.path !== "string"
      || typeof entry.mediaType !== "string"
      || entry.mediaType.length === 0
      || Object.keys(entry).some((key) => !new Set(["path", "mediaType"]).has(key))) {
      issues.push("Visual smoke output artifacts require only path and mediaType.");
      continue;
    }
    try {
      const safePath = safeRelativePath(entry.path, "Visual smoke output artifact path");
      if (seen.has(safePath)) throw new Error(`Duplicate visual smoke output artifact: ${safePath}`);
      seen.add(safePath);
      const absolutePath = path.resolve(workspaceRoot, safePath);
      if (!withinRoot(evidenceRoot, absolutePath)) {
        throw new Error(`Visual smoke output artifact escapes the evidence root: ${safePath}`);
      }
      const stat = lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Visual smoke output artifact must be a regular non-symlink file: ${safePath}`);
      }
      artifacts.push({ path: safePath, sha256: sha256(readFileSync(absolutePath)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(`Visual smoke output artifact is invalid: ${message}`);
    }
  }
  return { artifacts, issues };
}

function artifactEntry(workspaceRoot, absolutePath) {
  return {
    path: relativeToWorkspace(workspaceRoot, absolutePath),
    sha256: sha256(readFileSync(absolutePath)),
  };
}

export function runVisualSmoke({ workspaceRoot, runId, request }) {
  validateRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  const targetRoot = realpathSync(request.targetRoot);
  if (request.mode === "project" && targetRoot !== workspaceRoot) {
    throw new Error("Project visual smoke targetRoot must equal the RunKit workspace.");
  }
  const cwd = request.cwd === "."
    ? targetRoot
    : realpathSync(resolveWithinRoot(targetRoot, request.cwd, "Visual smoke cwd"));
  const smokeRoot = path.join(executionRoot, "visual-smoke-evidence", request.smokeId);
  if (existsSync(smokeRoot)) throw new Error(`Visual smoke evidence already exists: ${request.smokeId}`);
  const resultPath = resolveWithinRoot(workspaceRoot, request.resultPath, "Visual smoke resultPath");
  const expectedResultPath = path.join(smokeRoot, "result.json");
  if (resultPath !== expectedResultPath) {
    throw new Error(`Visual smoke resultPath must be ${relativeToWorkspace(workspaceRoot, expectedResultPath)}.`);
  }
  mkdirSync(smokeRoot, { recursive: true });
  const manifestPath = path.join(smokeRoot, "automation-manifest.json");
  const stdoutPath = path.join(smokeRoot, "runner.stdout");
  const stderrPath = path.join(smokeRoot, "runner.stderr");
  const manifestBytes = Buffer.from(canonicalJson(request.automationManifest), "utf8");
  writeFileSync(manifestPath, manifestBytes, { flag: "wx" });
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
  writeFileSync(stdoutPath, stdout, { flag: "wx" });
  writeFileSync(stderrPath, stderr, { flag: "wx" });
  const after = captureTargetState({ targetRoot, selectedPaths: request.selectedPaths });
  const stable = targetStable(before, after);
  const issues = [];
  let result = null;
  let resultIsRegularFile = false;
  if (!existsSync(resultPath)) {
    issues.push("Visual smoke result JSON is missing.");
  } else {
    const resultStat = lstatSync(resultPath);
    if (!resultStat.isFile() || resultStat.isSymbolicLink()) {
      issues.push("Visual smoke result must be a regular non-symlink file.");
    } else {
      resultIsRegularFile = true;
      try {
        result = JSON.parse(readFileSync(resultPath, "utf8"));
        issues.push(...resultIssues(result, request.automationManifest));
      } catch {
        issues.push("Visual smoke result must contain valid JSON.");
      }
    }
  }
  const runnerArtifacts = collectRunnerArtifacts({ workspaceRoot, evidenceRoot: smokeRoot, result });
  issues.push(...runnerArtifacts.issues);
  if (sha256(readFileSync(manifestPath)) !== sha256(manifestBytes)) {
    issues.push("Automation manifest changed while the runner executed.");
  }
  const runnerExitCode = Number.isInteger(completed.status) ? completed.status : 1;
  if (runnerExitCode !== 0) issues.push(`Visual smoke runner exited with code ${runnerExitCode}.`);
  const snapshotStatus = !stable
    ? "invalidated_by_target_write"
    : issues.length === 0
      ? "snapshot_passed"
      : "snapshot_failed";
  const coreArtifacts = [manifestPath, stdoutPath, stderrPath];
  if (resultIsRegularFile) coreArtifacts.push(resultPath);
  const outputArtifacts = [
    ...coreArtifacts.map((absolutePath) => artifactEntry(workspaceRoot, absolutePath)),
    ...runnerArtifacts.artifacts,
  ].sort((left, right) => left.path.localeCompare(right.path));
  const snapshotPath = path.join(executionRoot, "snapshots", `${request.smokeId}.json`);
  const snapshot = {
    schemaVersion: "OwlCodaRunKitSnapshotV1",
    runId,
    snapshotId: request.smokeId,
    status: snapshotStatus,
    mode: request.mode,
    targetRoot,
    verificationContextFingerprint: verificationContextFingerprint(request.verificationContext),
    repositoryBefore: before,
    repositoryAfter: after,
    command: {
      startedAt,
      endedAt,
      durationMs: Date.now() - startedMs,
      exitCode: runnerExitCode,
      stdoutPath: relativeToWorkspace(workspaceRoot, stdoutPath),
      stdoutSha256: sha256(stdout),
      stdoutLineCount: lineCount(stdout),
      stderrPath: relativeToWorkspace(workspaceRoot, stderrPath),
      stderrSha256: sha256(stderr),
      stderrLineCount: lineCount(stderr),
      evidence: {
        schemaVersion: "OwlCodaRunKitReplayableEvidenceV1",
        kind: "automation",
        cwd: request.cwd,
        launcher: { executable: request.executable, version: request.launcherVersion },
        argv: [request.executable, ...request.argv],
        automationManifestSha256: sha256(manifestBytes),
        toolVersions: structuredClone(request.toolVersions),
        materialInputs: Object.entries(before.selectedFiles).map(([id, hash]) => ({ id, sha256: hash })),
        outputArtifacts,
      },
    },
    visual: {
      automationManifestPath: relativeToWorkspace(workspaceRoot, manifestPath),
      resultPath: relativeToWorkspace(workspaceRoot, resultPath),
      result,
      issues,
    },
    authorizationGranted: false,
  };
  writeJsonExclusive(snapshotPath, snapshot);
  return {
    status: snapshotStatus === "snapshot_passed"
      ? "visual_smoke_passed"
      : snapshotStatus === "invalidated_by_target_write"
        ? "invalidated_by_target_write"
        : "visual_smoke_failed",
    exitCode: snapshotStatus === "snapshot_passed" ? 0 : 2,
    runId,
    snapshotPath: relativeToWorkspace(workspaceRoot, snapshotPath),
    issues,
    authorizationGranted: false,
  };
}
