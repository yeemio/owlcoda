import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  RUNTIME_ROOT,
  currentCoreIdentity,
  validateCoreArtifact,
  validateExecutionPin,
  validateLeaseOwnedPaths,
} from "./core-contract.mjs";
import { buildCoverageIndex } from "./coverage-adoption.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";
import {
  assertAllowedKeys,
  readJson,
  relativeToWorkspace,
  safeIdentifier,
  sha256,
  writeJsonExclusive,
} from "./provenance-common.mjs";

const REQUEST_KEYS = [
  "schemaVersion",
  "resumeId",
  "continuationRunId",
  "reason",
  "coverage",
];
const COVERAGE_KEYS = ["coverageId", "sources"];

function validateRequest(request) {
  assertAllowedKeys(request, "Resume request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitResumeRequestV1") {
    throw new Error("Unsupported resume request schemaVersion.");
  }
  safeIdentifier(request.resumeId, "resumeId");
  if (request.continuationRunId !== null) {
    safeIdentifier(request.continuationRunId, "continuationRunId");
  }
  if (typeof request.reason !== "string" || request.reason.length === 0) {
    throw new Error("Resume request requires a non-empty reason.");
  }
  assertAllowedKeys(request.coverage, "Resume coverage", COVERAGE_KEYS);
  safeIdentifier(request.coverage.coverageId, "coverageId");
  if (!Array.isArray(request.coverage.sources)) {
    throw new Error("Resume coverage requires sources.");
  }
}

function executionRoot(workspaceRoot, runId) {
  return path.join(workspaceRoot, RUNTIME_ROOT, "executions", runId);
}

function isWithin(root, candidate) {
  const remainder = path.relative(root, candidate);
  return remainder === ""
    || (remainder !== ".." && !remainder.startsWith(`..${path.sep}`) && !path.isAbsolute(remainder));
}

function assertSafeDirectory(root, candidate, label, { create = false } = {}) {
  const resolvedRoot = realpathSync(root);
  if (!existsSync(candidate)) {
    if (!create) throw new Error(`${label} does not exist.`);
    const parent = path.dirname(candidate);
    assertSafeDirectory(root, parent, `${label} parent`);
    mkdirSync(candidate);
  }
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  if (!stat.isDirectory()) throw new Error(`${label} must be a directory.`);
  const resolved = realpathSync(candidate);
  if (resolved !== path.resolve(candidate)) {
    throw new Error(`${label} must not use symlink ancestors.`);
  }
  if (!isWithin(resolvedRoot, resolved)) throw new Error(`${label} escapes its artifact root.`);
  return resolved;
}

function assertRegularArtifact(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file.`);
}

function readRegularJsonArtifact(filePath, label) {
  assertRegularArtifact(filePath, label);
  return readJson(filePath);
}

function acquireResumeLock(workspaceRoot) {
  const runtimeRoot = path.join(workspaceRoot, RUNTIME_ROOT);
  assertSafeDirectory(workspaceRoot, runtimeRoot, "RunKit runtime root");
  assertSafeDirectory(runtimeRoot, path.join(runtimeRoot, "executions"), "Executions directory");
  const lockPath = path.join(runtimeRoot, "control.lock");
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("Another RunKit control transaction is already active.");
    throw error;
  }
  return () => rmSync(lockPath, { recursive: true, force: true });
}

function activeRunIds(workspaceRoot) {
  const root = path.join(workspaceRoot, RUNTIME_ROOT, "executions");
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(runId => !existsSync(path.join(root, runId, "closeout-receipt.json")))
    .sort();
}

function assertSoleActiveRun(workspaceRoot, sourceRunId) {
  const active = activeRunIds(workspaceRoot);
  if (active.length !== 1 || active[0] !== sourceRunId) {
    throw new Error("Same-execution resume requires the source to be the only active execution.");
  }
}

function assertNoOtherActiveRun(workspaceRoot) {
  const active = activeRunIds(workspaceRoot);
  if (active.length > 0) {
    throw new Error(`Closed-run continuation requires no active execution: ${active.join(", ")}`);
  }
}

function assertNoActiveWriterLease(sourceRoot) {
  const leasesRoot = path.join(sourceRoot, "leases");
  if (!existsSync(leasesRoot)) return;
  for (const entry of readdirSync(leasesRoot, { withFileTypes: true })) {
    if (!entry.name.endsWith(".json")) continue;
    if (entry.isSymbolicLink()) throw new Error(`Resume lease must not be a symlink: ${entry.name}`);
    if (!entry.isFile()) throw new Error(`Resume lease must be a regular file: ${entry.name}`);
    const leasePath = path.join(leasesRoot, entry.name);
    assertRegularArtifact(leasePath, `Resume lease ${entry.name}`);
    const lease = readJson(leasePath);
    validateLeaseArtifact(lease, `Resume lease ${entry.name}`);
    if (lease.state === "active") throw new Error(`Resume is not allowed while an active writer lease remains: ${lease.workItemId ?? entry.name}`);
  }
}

function validateLeaseArtifact(lease, label) {
  try {
    if (lease?.schemaVersion !== "OwlCodaRunKitWorkerLeaseV1") {
      throw new Error("schemaVersion is invalid");
    }
    if (typeof lease.workItemId !== "string" || lease.workItemId.length === 0) {
      throw new Error("workItemId is required");
    }
    if (!Number.isInteger(lease.attempt) || lease.attempt < 1) {
      throw new Error("attempt must be a positive integer");
    }
    validateLeaseOwnedPaths(lease.ownedPaths);
    if (!new Set(["active", "released"]).has(lease.state)) {
      throw new Error("state is invalid");
    }
  } catch (error) {
    throw new Error(`${label} is not a valid lease: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findNamedArtifacts(sourceRoot, searchRoot, name, label) {
  if (!existsSync(searchRoot)) return [];
  const found = [];
  function visit(directory) {
    assertSafeDirectory(sourceRoot, directory, label);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symlinks.`);
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile() && entry.name === name) {
        assertRegularArtifact(candidate, `${label} artifact`);
        found.push(candidate);
      }
    }
  }
  visit(searchRoot);
  return found.sort();
}

function resumeIdOwners(workspaceRoot, resumeId) {
  const executionsRoot = path.join(workspaceRoot, RUNTIME_ROOT, "executions");
  const owners = [];
  for (const entry of readdirSync(executionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const attemptPath = path.join(executionsRoot, entry.name, "resume-attempts", `${resumeId}.json`);
    if (!existsSync(attemptPath)) continue;
    assertRegularArtifact(attemptPath, `Resume attempt ${entry.name}/${resumeId}`);
    owners.push(readJson(attemptPath));
  }
  return owners;
}

function assertResumeIdUnused(workspaceRoot, sourceRunId, resumeId) {
  if (resumeIdOwners(workspaceRoot, resumeId).some(attempt => attempt.sourceRunId === sourceRunId)) {
    throw new Error(`Resume id already exists for source execution: ${resumeId}`);
  }
}

function acceptedVerificationIsComplete(verification) {
  const selectedProfileIds = verification?.selectedProfileIds;
  const releasedLeaseIds = verification?.releasedLeaseIds;
  return verification?.contractVersion === "0.2"
    && verification.gateDecision === "accepted_passed"
    && /^[a-f0-9]{64}$/.test(verification.gateInputSha256 ?? "")
    && /^[a-f0-9]{64}$/.test(verification.activeReceiptSha256 ?? "")
    && /^[a-f0-9]{64}$/.test(verification.sourceFingerprint ?? "")
    && /^[a-f0-9]{64}$/.test(verification.verificationContextFingerprint ?? "")
    && verification.leaseState === "released"
    && Array.isArray(selectedProfileIds)
    && selectedProfileIds.length > 0
    && selectedProfileIds.every(value => typeof value === "string" && value.length > 0)
    && new Set(selectedProfileIds).size === selectedProfileIds.length
    && Array.isArray(releasedLeaseIds)
    && releasedLeaseIds.length > 0
    && releasedLeaseIds.every(value => typeof value === "string" && value.length > 0)
    && new Set(releasedLeaseIds).size === releasedLeaseIds.length;
}

function matchingGateInputs(sourceRoot, expectedSha256) {
  const root = path.join(sourceRoot, "verification-receipts");
  const matches = [];
  for (const candidate of findNamedArtifacts(
    sourceRoot,
    root,
    "verification-gate-input.json",
    "Parent verification receipts directory",
  )) {
    const bytes = readFileSync(candidate);
    if (sha256(bytes) === expectedSha256) matches.push({ path: candidate, bytes });
  }
  return matches;
}

function validateAcceptedParentEvidence(sourceRoot, sourceRunId, verification) {
  if (!acceptedVerificationIsComplete(verification)) {
    throw new Error("Parent accepted closeout lacks complete verification evidence.");
  }
  const gateMatches = matchingGateInputs(sourceRoot, verification.gateInputSha256);
  if (gateMatches.length !== 1) {
    throw new Error("Parent accepted closeout must bind exactly one preserved verification gate input.");
  }
  const gateInput = JSON.parse(gateMatches[0].bytes.toString("utf8"));
  const gate = validateVerificationReceiptGate(gateInput);
  if (!gate.accepted
    || gate.contractVersion !== "0.2"
    || gate.lineage.active.receipt.runId !== sourceRunId
    || gate.activeReceiptSha256 !== verification.activeReceiptSha256
    || gate.sourceFingerprint !== verification.sourceFingerprint
    || gate.verificationContextFingerprint !== verification.verificationContextFingerprint
    || JSON.stringify([...gate.selectedProfileIds].sort()) !== JSON.stringify([...verification.selectedProfileIds].sort())) {
    throw new Error("Parent accepted closeout does not match its preserved verification gate.");
  }
  const leasesRoot = path.join(sourceRoot, "leases");
  assertSafeDirectory(sourceRoot, leasesRoot, "Parent leases directory");
  const leaseIds = readdirSync(leasesRoot, { withFileTypes: true })
    .filter(entry => entry.name.endsWith(".json"))
    .map(entry => {
      if (entry.isSymbolicLink()) throw new Error(`Parent lease must not be a symlink: ${entry.name}`);
      if (!entry.isFile()) throw new Error(`Parent lease must be a regular file: ${entry.name}`);
      const leasePath = path.join(leasesRoot, entry.name);
      assertRegularArtifact(leasePath, `Parent lease ${entry.name}`);
      const lease = readJson(leasePath);
      validateLeaseArtifact(lease, `Parent lease ${entry.name}`);
      if (lease.state !== "released") {
        throw new Error(`Parent lease is not a valid released lease: ${entry.name}`);
      }
      return lease.workItemId;
    })
    .sort();
  if (new Set(leaseIds).size !== leaseIds.length
    || JSON.stringify(leaseIds) !== JSON.stringify([...verification.releasedLeaseIds].sort())) {
    throw new Error("Parent accepted closeout released leases do not match preserved lease artifacts.");
  }
}

function validatedParentCloseout(workspaceRoot, sourceRoot, sourceRunId) {
  const closeoutPath = path.join(sourceRoot, "closeout-receipt.json");
  assertRegularArtifact(closeoutPath, "Parent closeout");
  const closeoutBytes = readFileSync(closeoutPath);
  const closeout = JSON.parse(closeoutBytes.toString("utf8"));
  const artifactGate = validateCoreArtifact(closeout.artifact);
  if (!artifactGate.valid) throw new Error(`Parent closeout is invalid: ${artifactGate.issues.join("; ")}`);
  if (closeout.acceptanceSha256 !== artifactGate.acceptanceSha256
    || closeout.artifactSha256 !== artifactGate.artifactSha256) {
    throw new Error("Parent closeout hashes do not match its artifact.");
  }
  const payload = closeout.artifact.payload;
  if (payload.runId !== sourceRunId
    || !new Set(["accepted", "rejected", "blocked"]).has(payload.decision)
    || payload.authorizationGranted !== false) {
    throw new Error("Parent closeout payload is invalid.");
  }
  if (payload.decision === "accepted") validateAcceptedParentEvidence(sourceRoot, sourceRunId, payload.verification);
  const pin = readRegularJsonArtifact(path.join(sourceRoot, "engine-pin.json"), "Parent engine pin");
  const pinGate = validateExecutionPin({ expected: pin, actual: closeout.artifact.core });
  if (pinGate.status !== "valid") throw new Error(`Parent closeout does not match its engine pin: ${pinGate.issues.join("; ")}`);
  return {
    decision: payload.decision,
    path: relativeToWorkspace(workspaceRoot, closeoutPath),
    sha256: sha256(closeoutBytes),
  };
}

function sourceGoal(workspaceRoot, sourceRoot) {
  const goalPath = path.join(sourceRoot, "goal-contract.json");
  assertRegularArtifact(goalPath, "Source goal contract");
  const bytes = readFileSync(goalPath);
  return {
    bytes,
    descriptor: {
      path: relativeToWorkspace(workspaceRoot, goalPath),
      sha256: sha256(bytes),
    },
  };
}

function coverageRequest(request) {
  return {
    schemaVersion: "OwlCodaRunKitCoverageAdoptRequestV1",
    coverageId: request.coverage.coverageId,
    sources: request.coverage.sources,
  };
}

function coverageDescriptor(workspaceRoot, targetRoot, targetRunId, request, coverageIndex) {
  const outputPath = path.join(targetRoot, "coverage-indexes", `${request.coverage.coverageId}.json`);
  const bytes = Buffer.from(`${JSON.stringify(coverageIndex, null, 2)}\n`);
  return {
    outputPath,
    relativePath: `.owlcoda/runkit/executions/${targetRunId}/coverage-indexes/${request.coverage.coverageId}.json`,
    sha256: sha256(bytes),
    bytes,
  };
}

function attemptArtifact({
  request,
  mode,
  sourceRunId,
  targetRunId,
  parentGoal,
  parentCloseout,
  coverage,
  coverageIndex,
}) {
  return {
    schemaVersion: "OwlCodaRunKitResumeAttemptV1",
    resumeId: request.resumeId,
    mode,
    runId: targetRunId,
    sourceRunId,
    reason: request.reason,
    parentGoal,
    parentCloseout,
    inheritedEvidence: {
      coverageIndexPath: coverage.relativePath,
      coverageIndexSha256: coverage.sha256,
      reusableReceiptIds: coverageIndex.entries.map(entry => entry.receiptId).sort(),
    },
    nextAllowedAction: "acquire_writer_lease",
    requiredWorkflow: [
      "acquire_writer_lease",
      "prepare_or_replace_delivery_packet",
      "verify_plan",
    ],
    authorizationGranted: false,
  };
}

function appendResumeEvent(targetRoot, event) {
  const eventsPath = path.join(targetRoot, "events.jsonl");
  assertRegularArtifact(eventsPath, "Execution events artifact");
  const existing = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  appendFileSync(eventsPath, `${JSON.stringify({
    sequence: existing.length + 1,
    type: "execution_resumed",
    ...event,
    authorizationGranted: false,
  })}\n`);
}

function appendSameExecution({ workspaceRoot, sourceRunId, sourceRoot, request, goal }) {
  if (request.continuationRunId !== null) {
    throw new Error("Unclosed execution resume requires continuationRunId=null.");
  }
  assertSoleActiveRun(workspaceRoot, sourceRunId);
  const pin = readRegularJsonArtifact(path.join(sourceRoot, "engine-pin.json"), "Resume engine pin");
  const pinGate = validateExecutionPin({ expected: pin, actual: currentCoreIdentity() });
  if (pinGate.status !== "valid") throw new Error(`Resume engine pin is stale: ${pinGate.issues.join("; ")}`);
  assertNoActiveWriterLease(sourceRoot);
  if (findNamedArtifacts(
    sourceRoot,
    path.join(sourceRoot, "verification-receipts"),
    "receipt-lineage.json",
    "Resume verification receipts directory",
  ).length > 0) {
    throw new Error(
      "An execution with a finalized receipt lineage must close before resuming as a continuation.",
    );
  }
  const eventsPath = path.join(sourceRoot, "events.jsonl");
  assertRegularArtifact(eventsPath, "Execution events artifact");
  const originalEvents = readFileSync(eventsPath);
  const coverageRoot = path.join(sourceRoot, "coverage-indexes");
  const attemptsRoot = path.join(sourceRoot, "resume-attempts");
  assertSafeDirectory(sourceRoot, coverageRoot, "Resume coverage directory", { create: true });
  assertSafeDirectory(sourceRoot, attemptsRoot, "Resume attempts directory", { create: true });
  const attemptPath = path.join(sourceRoot, "resume-attempts", `${request.resumeId}.json`);
  const coverageIndex = buildCoverageIndex({
    workspaceRoot,
    runId: sourceRunId,
    request: coverageRequest(request),
  });
  const coverage = coverageDescriptor(workspaceRoot, sourceRoot, sourceRunId, request, coverageIndex);
  if (existsSync(attemptPath)) throw new Error(`Resume attempt already exists: ${request.resumeId}`);
  if (existsSync(coverage.outputPath)) throw new Error(`Resume coverage index already exists: ${request.coverage.coverageId}`);
  const attempt = attemptArtifact({
    request,
    mode: "same_execution",
    sourceRunId,
    targetRunId: sourceRunId,
    parentGoal: goal.descriptor,
    parentCloseout: null,
    coverage,
    coverageIndex,
  });
  let coverageWritten = false;
  let attemptWritten = false;
  try {
    writeJsonExclusive(coverage.outputPath, coverageIndex);
    coverageWritten = true;
    writeJsonExclusive(attemptPath, attempt);
    attemptWritten = true;
    assertNoActiveWriterLease(sourceRoot);
    appendResumeEvent(sourceRoot, { runId: sourceRunId, sourceRunId, resumeId: request.resumeId });
  } catch (error) {
    if (attemptWritten) rmSync(attemptPath, { force: true });
    if (coverageWritten) rmSync(coverage.outputPath, { force: true });
    if (existsSync(eventsPath) && lstatSync(eventsPath).isFile()) {
      writeFileSync(eventsPath, originalEvents);
    }
    throw new Error(`Resume transaction failed while updating execution events or artifacts: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    status: "resume_attempt_appended",
    exitCode: 0,
    runId: sourceRunId,
    sourceRunId,
    attemptPath: relativeToWorkspace(workspaceRoot, attemptPath),
    coverageIndexPath: coverage.relativePath,
    coverageIndexSha256: coverage.sha256,
    authorizationGranted: false,
  };
}

function createContinuation({ workspaceRoot, sourceRunId, sourceRoot, request, goal }) {
  if (request.continuationRunId === null) {
    throw new Error("Closed execution resume requires continuationRunId.");
  }
  const targetRunId = request.continuationRunId;
  if (targetRunId === sourceRunId) throw new Error("Continuation run id must differ from the source run id.");
  assertNoOtherActiveRun(workspaceRoot);
  const targetRoot = executionRoot(workspaceRoot, targetRunId);
  if (existsSync(targetRoot)) throw new Error(`Continuation run id already exists: ${targetRunId}`);
  const parentCloseout = validatedParentCloseout(workspaceRoot, sourceRoot, sourceRunId);
  const coverageIndex = buildCoverageIndex({
    workspaceRoot,
    runId: targetRunId,
    request: coverageRequest(request),
  });
  const coverage = coverageDescriptor(workspaceRoot, targetRoot, targetRunId, request, coverageIndex);
  const attemptRelativePath = `.owlcoda/runkit/executions/${targetRunId}/resume-attempts/${request.resumeId}.json`;
  const attempt = attemptArtifact({
    request,
    mode: "continuation",
    sourceRunId,
    targetRunId,
    parentGoal: goal.descriptor,
    parentCloseout,
    coverage,
    coverageIndex,
  });
  const enginePin = currentCoreIdentity();
  const runtimeRoot = path.join(workspaceRoot, RUNTIME_ROOT);
  const executionsRoot = path.join(runtimeRoot, "executions");
  assertSafeDirectory(runtimeRoot, executionsRoot, "RunKit executions directory");
  const stagingParent = path.join(runtimeRoot, "resume-staging");
  assertSafeDirectory(runtimeRoot, stagingParent, "Resume staging directory", { create: true });
  const stagingRoot = mkdtempSync(path.join(stagingParent, `${targetRunId}-`));
  let stagingPresent = true;
  try {
    mkdirSync(path.join(stagingRoot, "leases"));
    mkdirSync(path.join(stagingRoot, "delivery-packets"));
    mkdirSync(path.join(stagingRoot, "verification-receipts"));
    writeJsonExclusive(path.join(stagingRoot, "engine-pin.json"), enginePin);
    writeFileSync(path.join(stagingRoot, "goal-contract.json"), goal.bytes, { flag: "wx" });
    writeJsonExclusive(path.join(stagingRoot, "execution-plan.json"), {
      schemaVersion: "OwlCodaRunKitExecutionPlanV1",
      runId: targetRunId,
      state: "planned",
      enginePin,
      goalContractSha256: sha256(goal.bytes),
      continuation: {
        parentRunId: sourceRunId,
        resumeId: request.resumeId,
        attemptPath: attemptRelativePath,
      },
      authorizationGranted: false,
    });
    writeJsonExclusive(
      path.join(stagingRoot, "coverage-indexes", `${request.coverage.coverageId}.json`),
      coverageIndex,
    );
    writeJsonExclusive(path.join(stagingRoot, "resume-attempts", `${request.resumeId}.json`), attempt);
    writeFileSync(path.join(stagingRoot, "events.jsonl"), [
      JSON.stringify({ sequence: 1, type: "execution_planned", runId: targetRunId, authorizationGranted: false }),
      JSON.stringify({
        sequence: 2,
        type: "execution_resumed",
        runId: targetRunId,
        sourceRunId,
        resumeId: request.resumeId,
        authorizationGranted: false,
      }),
      "",
    ].join("\n"), { flag: "wx" });
    renameSync(stagingRoot, targetRoot);
    stagingPresent = false;
  } finally {
    if (stagingPresent) rmSync(stagingRoot, { recursive: true, force: true });
  }
  return {
    status: "continuation_created",
    exitCode: 0,
    runId: targetRunId,
    sourceRunId,
    attemptPath: attemptRelativePath,
    coverageIndexPath: coverage.relativePath,
    coverageIndexSha256: coverage.sha256,
    authorizationGranted: false,
  };
}

export function runResumeExecution({ workspaceRoot, sourceRunId, request }) {
  safeIdentifier(sourceRunId, "sourceRunId");
  validateRequest(request);
  const releaseLock = acquireResumeLock(workspaceRoot);
  try {
    const executionsRoot = path.join(workspaceRoot, RUNTIME_ROOT, "executions");
    assertSafeDirectory(path.join(workspaceRoot, RUNTIME_ROOT), executionsRoot, "RunKit executions directory");
    const sourceRoot = executionRoot(workspaceRoot, sourceRunId);
    if (!existsSync(sourceRoot)) throw new Error(`Source execution does not exist: ${sourceRunId}`);
    assertSafeDirectory(executionsRoot, sourceRoot, "Source execution directory");
    assertResumeIdUnused(workspaceRoot, sourceRunId, request.resumeId);
    const goal = sourceGoal(workspaceRoot, sourceRoot);
    return existsSync(path.join(sourceRoot, "closeout-receipt.json"))
      ? createContinuation({ workspaceRoot, sourceRunId, sourceRoot, request, goal })
      : appendSameExecution({ workspaceRoot, sourceRunId, sourceRoot, request, goal });
  } finally {
    releaseLock();
  }
}
