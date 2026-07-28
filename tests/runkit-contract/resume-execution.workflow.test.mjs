import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCoreArtifact } from "../../scripts/runkit-contract/core-contract.mjs";
import { receiptSha256 } from "../../scripts/runkit-contract/receipt-lineage.mjs";
import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { canonicalSourceFingerprint } from "../../scripts/runkit-contract/source-fingerprint.mjs";
import { verificationContextFingerprint } from "../../scripts/runkit-contract/verification-context.mjs";

const emptySha256 = sha256("");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function context(lockHash) {
  return {
    schemaVersion: "OwlCodaRunKitVerificationContextV1",
    reusePolicy: "portable",
    platform: null,
    toolchains: [{ name: "node", version: process.version }],
    lockfiles: [{ path: "package-lock.json", sha256: lockHash }],
    fixtures: [],
    services: [],
    environment: [],
  };
}

function acceptedGate({ runId, sourceHash, lockHash }) {
  const verificationContext = context(lockHash);
  const sourceFingerprint = canonicalSourceFingerprint({ "src/feature.ts": sourceHash });
  const receipt = {
    schemaVersion: "OwlCodaRunKitVerificationReceiptV2",
    runId,
    receiptId: `${runId}-receipt`,
    status: "passed",
    sourceFingerprint,
    verificationContextFingerprint: verificationContextFingerprint(verificationContext),
    selectedProfileIds: ["feature-stage"],
    commandRuns: 1,
    commandReceipts: [{
      id: "feature-snapshot",
      evidence: {
        schemaVersion: "OwlCodaRunKitReplayableEvidenceV1",
        kind: "shell",
        cwd: ".",
        launcher: { executable: "/usr/local/bin/node", version: "fixture-node" },
        argv: ["/usr/local/bin/node", "--test", "tests/feature.test.mjs"],
        toolVersions: [{ name: "node", version: process.version }],
        materialInputs: [{ id: "src/feature.ts", sha256: sourceHash }],
        outputArtifacts: [],
      },
      exitCode: 0,
      stdoutSha256: emptySha256,
      stderrSha256: emptySha256,
    }],
  };
  return {
    contractVersion: "0.2",
    receipts: [{ receiptSha256: receiptSha256(receipt), receipt }],
    sourceGate: {
      status: "valid",
      exitCode: 0,
      declaredFingerprint: sourceFingerprint,
      recomputedFingerprint: sourceFingerprint,
    },
    profileImpact: {
      decision: "targeted_profiles",
      profileIds: ["feature-stage"],
      uncoveredPaths: [],
    },
    verificationContext,
  };
}

async function setupFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-resume-"));
  const sourceOld = "export const feature = false;\n";
  const source = "export const feature = true;\n";
  const lock = "lock\n";
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/feature.ts"), sourceOld);
  await writeFile(path.join(root, "package-lock.json"), lock);
  await writeJson(path.join(root, "goal.json"), { goal: "continue the same bounded delivery" });
  git(root, "init");
  git(root, "add", "src/feature.ts", "package-lock.json", "goal.json");
  git(root, "-c", "user.name=RunKit Test", "-c", "user.email=runkit@example.invalid", "commit", "-m", "fixture");
  assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
  await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: [{
      id: "feature-stage",
      primary: true,
      paths: ["src/feature.ts"],
      commands: [{ id: "feature-test", cwd: ".", executable: "node", argv: ["--test", "tests/feature.test.mjs"] }],
    }],
  });
  await writeFile(path.join(root, "src/feature.ts"), source);
  return {
    root,
    sourceHash: sha256(source),
    lockHash: sha256(lock),
  };
}

async function planRun(fixture, runId) {
  const result = await runCli([
    "plan", "--workspace", fixture.root,
    "--run-id", runId,
    "--goal", path.join(fixture.root, "goal.json"),
  ]);
  assert.equal(result.status, "planned");
  return path.join(fixture.root, ".owlcoda/runkit/executions", runId);
}

async function closeAccepted(fixture, runId) {
  const executionRoot = await planRun(fixture, runId);
  await writeJson(path.join(executionRoot, "leases/W1.json"), {
    schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
    workItemId: "W1",
    attempt: 1,
    ownedPaths: ["src/feature.ts"],
    state: "released",
  });
  const gate = acceptedGate({ runId, sourceHash: fixture.sourceHash, lockHash: fixture.lockHash });
  const gatePath = path.join(executionRoot, "verification-receipts/final/verification-gate-input.json");
  await writeJson(gatePath, gate);
  const closed = await runCli([
    "closeout", "--workspace", fixture.root,
    "--run-id", runId,
    "--decision", "accepted",
    "--gate-input", gatePath,
  ]);
  assert.equal(closed.status, "closed");
  return { executionRoot, gate, gatePath };
}

function coverageSource(fixture, gatePath) {
  return {
    gateInputPath: path.relative(fixture.root, gatePath),
    gateInputSha256: sha256(fixture.gateBytes),
    commandBindings: [{
      receiptCommandId: "feature-snapshot",
      profileId: "feature-stage",
      commandId: "feature-test",
    }],
    dependencyBindings: [{
      dependencyId: "root-lockfile",
      source: { kind: "lockfile", identity: "package-lock.json" },
    }],
  };
}

function resumeRequest({ resumeId, continuationRunId, sources }) {
  return {
    schemaVersion: "OwlCodaRunKitResumeRequestV1",
    resumeId,
    continuationRunId,
    reason: "resume after an explicit evidence review",
    coverage: {
      coverageId: `${resumeId}-coverage`,
      sources,
    },
  };
}

test("resume creates a closed-run continuation without rewriting accepted parent truth", async () => {
  const fixture = await setupFixture();
  try {
    const parentRunId = "accepted-parent";
    const continuationRunId = "accepted-continuation";
    const parent = await closeAccepted(fixture, parentRunId);
    fixture.gateBytes = await readFile(parent.gatePath);
    const parentGoalBefore = await readFile(path.join(parent.executionRoot, "goal-contract.json"));
    const parentCloseoutBefore = await readFile(path.join(parent.executionRoot, "closeout-receipt.json"));
    const requestPath = path.join(fixture.root, "resume-accepted.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-accepted-001",
      continuationRunId,
      sources: [coverageSource(fixture, parent.gatePath)],
    }));

    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "continuation_created", JSON.stringify(result));
    assert.equal(result.runId, continuationRunId);
    assert.equal(result.sourceRunId, parentRunId);
    assert.equal(result.authorizationGranted, false);
    assert.deepEqual(await readFile(path.join(parent.executionRoot, "goal-contract.json")), parentGoalBefore);
    assert.deepEqual(await readFile(path.join(parent.executionRoot, "closeout-receipt.json")), parentCloseoutBefore);

    const continuationRoot = path.join(fixture.root, ".owlcoda/runkit/executions", continuationRunId);
    const attempt = JSON.parse(await readFile(path.join(continuationRoot, "resume-attempts/resume-accepted-001.json"), "utf8"));
    assert.equal(attempt.mode, "continuation");
    assert.equal(attempt.sourceRunId, parentRunId);
    assert.equal(attempt.parentCloseout.decision, "accepted");
    assert.deepEqual(attempt.inheritedEvidence.reusableReceiptIds, [`${parentRunId}-receipt`]);
    assert.equal(attempt.nextAllowedAction, "acquire_writer_lease");
    assert.deepEqual(attempt.requiredWorkflow, [
      "acquire_writer_lease",
      "prepare_or_replace_delivery_packet",
      "verify_plan",
    ]);
    assert.equal(attempt.authorizationGranted, false);
    const plan = JSON.parse(await readFile(path.join(continuationRoot, "execution-plan.json"), "utf8"));
    assert.deepEqual(plan.continuation, {
      parentRunId,
      resumeId: "resume-accepted-001",
      attemptPath: `.owlcoda/runkit/executions/${continuationRunId}/resume-attempts/resume-accepted-001.json`,
    });
    assert.equal(plan.authorizationGranted, false);
    const coverage = JSON.parse(await readFile(path.join(fixture.root, result.coverageIndexPath), "utf8"));
    assert.equal(coverage.runId, continuationRunId);
    assert.deepEqual(coverage.entries.map(entry => entry.receiptId), [`${parentRunId}-receipt`]);
    assert.equal(coverage.authorizationGranted, false);

    await writeJson(path.join(continuationRoot, "leases/W2.json"), {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W2",
      attempt: 1,
      ownedPaths: ["src/feature.ts"],
      state: "active",
    });
    const packetPath = path.join(continuationRoot, "delivery-packets/candidate.json");
    await writeJson(packetPath, {
      schemaVersion: "ExecutionDeliveryPacketV1",
      runId: continuationRunId,
      status: "ready_for_stage_verification",
      changedFiles: { wholeFileSha256: { "src/feature.ts": fixture.sourceHash } },
      sourceFingerprint: {
        sha256: canonicalSourceFingerprint({ "src/feature.ts": fixture.sourceHash }),
      },
    });
    const verifyRequestPath = path.join(continuationRoot, "verify-plan-request.json");
    await writeJson(verifyRequestPath, {
      schemaVersion: "OwlCodaRunKitVerifyPlanRequestV1",
      planId: "resume-reuses-parent-feature",
      deliveryPacketPath: path.relative(fixture.root, packetPath),
      statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
      dependencies: [{
        id: "root-lockfile",
        path: "package-lock.json",
        baselineSha256: fixture.lockHash,
      }],
      verificationContext: parent.gate.verificationContext,
      coverageIndexPath: result.coverageIndexPath,
      coverageIndexSha256: sha256(await readFile(path.join(fixture.root, result.coverageIndexPath))),
      globalGates: [],
    });
    const verificationPlanResult = await runCli([
      "verify-plan", "--workspace", fixture.root,
      "--run-id", continuationRunId,
      "--request", verifyRequestPath,
    ]);
    assert.equal(verificationPlanResult.status, "verification_plan_written", JSON.stringify(verificationPlanResult));
    const verificationPlan = JSON.parse(
      await readFile(path.join(fixture.root, verificationPlanResult.planPath), "utf8"),
    );
    assert.equal(verificationPlan.status, "ready_to_finalize");
    assert.deepEqual(verificationPlan.commands.reusedCommandIds, ["feature-test"]);
    assert.deepEqual(verificationPlan.commands.pendingCommandIds, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume preserves a blocked parent while starting a continuation with empty coverage", async () => {
  const fixture = await setupFixture();
  try {
    const parentRunId = "blocked-parent";
    const executionRoot = await planRun(fixture, parentRunId);
    const closed = await runCli([
      "closeout", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--decision", "blocked",
    ]);
    assert.equal(closed.status, "closed");
    const closeoutBefore = await readFile(path.join(executionRoot, "closeout-receipt.json"));
    const requestPath = path.join(fixture.root, "resume-blocked.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-blocked-001",
      continuationRunId: "blocked-continuation",
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "continuation_created", JSON.stringify(result));
    const attempt = JSON.parse(await readFile(path.join(fixture.root, result.attemptPath), "utf8"));
    assert.equal(attempt.parentCloseout.decision, "blocked");
    assert.deepEqual(attempt.inheritedEvidence.reusableReceiptIds, []);
    assert.deepEqual(await readFile(path.join(executionRoot, "closeout-receipt.json")), closeoutBefore);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume appends an in-place attempt only when no writer lease is active", async () => {
  const fixture = await setupFixture();
  try {
    const runId = "active-parent";
    const executionRoot = await planRun(fixture, runId);
    const requestPath = path.join(fixture.root, "resume-active.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-active-001",
      continuationRunId: null,
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "resume_attempt_appended", JSON.stringify(result));
    assert.equal(result.runId, runId);
    assert.equal(result.authorizationGranted, false);
    const attempt = JSON.parse(await readFile(path.join(fixture.root, result.attemptPath), "utf8"));
    assert.equal(attempt.mode, "same_execution");
    assert.equal(attempt.parentCloseout, null);

    const duplicate = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(duplicate.status, "invalid_input");
    assert.match(duplicate.issues.join("\n"), /already exists/i);

    await writeJson(path.join(executionRoot, "leases/W2.json"), {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W2",
      attempt: 1,
      ownedPaths: ["src/feature.ts"],
      state: "active",
    });
    const leasedRequestPath = path.join(fixture.root, "resume-active-leased.json");
    await writeJson(leasedRequestPath, resumeRequest({
      resumeId: "resume-active-002",
      continuationRunId: null,
      sources: [],
    }));
    const leased = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", leasedRequestPath,
    ]);
    assert.equal(leased.status, "invalid_input");
    assert.match(leased.issues.join("\n"), /active writer lease/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-execution resume rejects an already finalized receipt lineage", async () => {
  const fixture = await setupFixture();
  try {
    const runId = "active-finalized-parent";
    const executionRoot = await planRun(fixture, runId);
    const gate = acceptedGate({
      runId,
      sourceHash: fixture.sourceHash,
      lockHash: fixture.lockHash,
    });
    await writeJson(
      path.join(executionRoot, "verification-receipts/receipt-lineage.json"),
      gate.receipts,
    );
    const requestPath = path.join(fixture.root, "resume-active-finalized.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-active-finalized-001",
      continuationRunId: null,
      sources: [],
    }));

    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /finalized receipt lineage.*close.*continuation/i);
    await assert.rejects(
      readFile(path.join(executionRoot, "resume-attempts/resume-active-finalized-001.json")),
      /ENOENT/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume fails closed on changed gate evidence and hand-authored coverage truth", async () => {
  const fixture = await setupFixture();
  try {
    const parentRunId = "negative-parent";
    const parent = await closeAccepted(fixture, parentRunId);
    fixture.gateBytes = await readFile(parent.gatePath);
    await writeFile(parent.gatePath, Buffer.concat([fixture.gateBytes, Buffer.from("\n")]));
    const changedGateRequestPath = path.join(fixture.root, "resume-changed-gate.json");
    await writeJson(changedGateRequestPath, resumeRequest({
      resumeId: "resume-changed-gate",
      continuationRunId: "changed-gate-continuation",
      sources: [coverageSource(fixture, parent.gatePath)],
    }));
    const changedGate = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", changedGateRequestPath,
    ]);
    assert.equal(changedGate.status, "invalid_input");
    assert.match(
      changedGate.issues.join("\n"),
      /preserved verification gate input|gate input hash mismatch/i,
    );

    const forgedRequestPath = path.join(fixture.root, "resume-forged.json");
    await writeJson(forgedRequestPath, {
      ...resumeRequest({
        resumeId: "resume-forged",
        continuationRunId: "forged-continuation",
        sources: [],
      }),
      coverage: {
        coverageId: "forged-coverage",
        sources: [],
        entries: [{ receiptId: "self-declared-pass" }],
      },
    });
    const forged = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", forgedRequestPath,
    ]);
    assert.equal(forged.status, "invalid_input");
    assert.match(forged.issues.join("\n"), /unsupported field.*entries/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-execution resume rejects a stale engine pin without writing an attempt", async () => {
  const fixture = await setupFixture();
  try {
    const runId = "stale-active-parent";
    const executionRoot = await planRun(fixture, runId);
    const pinPath = path.join(executionRoot, "engine-pin.json");
    const pin = JSON.parse(await readFile(pinPath, "utf8"));
    await writeJson(pinPath, { ...pin, coreVersion: "stale-core" });
    const requestPath = path.join(fixture.root, "resume-stale.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-stale-001",
      continuationRunId: null,
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /engine pin is stale/i);
    await assert.rejects(
      readFile(path.join(executionRoot, "resume-attempts/resume-stale-001.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("closed-run resume rejects a reused continuation id and invalid parent closeout", async () => {
  const reusedFixture = await setupFixture();
  try {
    const parentRunId = "reused-parent";
    await planRun(reusedFixture, parentRunId);
    assert.equal((await runCli([
      "closeout", "--workspace", reusedFixture.root,
      "--run-id", parentRunId,
      "--decision", "blocked",
    ])).status, "closed");
    const continuationRunId = "already-used-continuation";
    await planRun(reusedFixture, continuationRunId);
    assert.equal((await runCli([
      "closeout", "--workspace", reusedFixture.root,
      "--run-id", continuationRunId,
      "--decision", "blocked",
    ])).status, "closed");
    const reusedPath = path.join(reusedFixture.root, "resume-reused.json");
    await writeJson(reusedPath, resumeRequest({
      resumeId: "resume-reused-001",
      continuationRunId,
      sources: [],
    }));
    const reused = await runCli([
      "resume", "--workspace", reusedFixture.root,
      "--run-id", parentRunId,
      "--request", reusedPath,
    ]);
    assert.equal(reused.status, "invalid_input");
    assert.match(reused.issues.join("\n"), /continuation run id already exists/i);
  } finally {
    await rm(reusedFixture.root, { recursive: true, force: true });
  }

  const invalidFixture = await setupFixture();
  try {
    const parentRunId = "invalid-closeout-parent";
    const executionRoot = await planRun(invalidFixture, parentRunId);
    assert.equal((await runCli([
      "closeout", "--workspace", invalidFixture.root,
      "--run-id", parentRunId,
      "--decision", "blocked",
    ])).status, "closed");
    const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
    const closeout = JSON.parse(await readFile(closeoutPath, "utf8"));
    closeout.artifact.payload.decision = "accepted";
    await writeJson(closeoutPath, closeout);
    const invalidPath = path.join(invalidFixture.root, "resume-invalid-closeout.json");
    await writeJson(invalidPath, resumeRequest({
      resumeId: "resume-invalid-closeout-001",
      continuationRunId: "must-not-be-created",
      sources: [],
    }));
    const invalid = await runCli([
      "resume", "--workspace", invalidFixture.root,
      "--run-id", parentRunId,
      "--request", invalidPath,
    ]);
    assert.equal(invalid.status, "invalid_input");
    assert.match(invalid.issues.join("\n"), /parent closeout hashes/i);
    await assert.rejects(
      readFile(path.join(invalidFixture.root, ".owlcoda/runkit/executions/must-not-be-created/execution-plan.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(invalidFixture.root, { recursive: true, force: true });
  }
});

test("resume rejects symlinked output directories without writing outside the workspace", async () => {
  const fixture = await setupFixture();
  const foreignRoot = await mkdtemp(path.join(tmpdir(), "owlcoda-resume-foreign-"));
  try {
    const runId = "symlink-active-parent";
    const executionRoot = await planRun(fixture, runId);
    await symlink(foreignRoot, path.join(executionRoot, "coverage-indexes"));
    await symlink(foreignRoot, path.join(executionRoot, "resume-attempts"));
    const requestPath = path.join(fixture.root, "resume-symlink.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-symlink-001",
      continuationRunId: null,
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /symlink/i);
    assert.deepEqual(await readdir(foreignRoot), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(foreignRoot, { recursive: true, force: true });
  }
});

test("coverage-adopt rejects a symlinked coverage directory without writing outside the workspace", async () => {
  const fixture = await setupFixture();
  const foreignRoot = await mkdtemp(path.join(tmpdir(), "owlcoda-coverage-foreign-"));
  try {
    const runId = "symlink-coverage-parent";
    const executionRoot = await planRun(fixture, runId);
    await symlink(foreignRoot, path.join(executionRoot, "coverage-indexes"));
    const requestPath = path.join(executionRoot, "coverage-symlink-request.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitCoverageAdoptRequestV1",
      coverageId: "must-not-escape",
      sources: [],
    });
    const result = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /coverage.*symlink|symlink.*coverage/i);
    assert.deepEqual(await readdir(foreignRoot), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(foreignRoot, { recursive: true, force: true });
  }
});

test("same-execution resume rejects a symlinked active lease", async () => {
  const fixture = await setupFixture();
  const foreignRoot = await mkdtemp(path.join(tmpdir(), "owlcoda-lease-foreign-"));
  try {
    const runId = "symlink-lease-parent";
    const executionRoot = await planRun(fixture, runId);
    const foreignLease = path.join(foreignRoot, "active-lease.json");
    await writeJson(foreignLease, {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "foreign-active",
      attempt: 1,
      ownedPaths: ["src/feature.ts"],
      state: "active",
    });
    await symlink(foreignLease, path.join(executionRoot, "leases/W-symlink.json"));
    const requestPath = path.join(fixture.root, "resume-symlink-lease.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-symlink-lease-001",
      continuationRunId: null,
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /lease.*symlink|symlink.*lease/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(foreignRoot, { recursive: true, force: true });
  }
});

test("same-execution resume rejects a nested finalized receipt lineage", async () => {
  const fixture = await setupFixture();
  try {
    const runId = "nested-finalized-parent";
    const executionRoot = await planRun(fixture, runId);
    const gate = acceptedGate({
      runId,
      sourceHash: fixture.sourceHash,
      lockHash: fixture.lockHash,
    });
    await writeJson(
      path.join(executionRoot, "verification-receipts/nested/receipt-lineage.json"),
      gate.receipts,
    );
    const requestPath = path.join(fixture.root, "resume-nested-lineage.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-nested-lineage-001",
      continuationRunId: null,
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /finalized receipt lineage.*close.*continuation/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("closed accepted parent rejects a malformed preserved lease artifact", async () => {
  const fixture = await setupFixture();
  try {
    const parentRunId = "malformed-lease-parent";
    const parent = await closeAccepted(fixture, parentRunId);
    await writeJson(path.join(parent.executionRoot, "leases/W1.json"), {
      workItemId: "W1",
      state: "released",
    });
    const requestPath = path.join(fixture.root, "resume-malformed-lease.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-malformed-lease-001",
      continuationRunId: "malformed-lease-continuation",
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /parent lease.*valid lease/i);
    await assert.rejects(
      readFile(path.join(
        fixture.root,
        ".owlcoda/runkit/executions/malformed-lease-continuation/execution-plan.json",
      )),
      { code: "ENOENT" },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("same-execution resume rolls back when its event artifact is invalid", async () => {
  const fixture = await setupFixture();
  try {
    const runId = "event-failure-parent";
    const executionRoot = await planRun(fixture, runId);
    const eventsPath = path.join(executionRoot, "events.jsonl");
    await rm(eventsPath);
    await mkdir(eventsPath);
    const requestPath = path.join(fixture.root, "resume-event-failure.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-event-failure-001",
      continuationRunId: null,
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /events/i);
    await assert.rejects(
      readFile(path.join(executionRoot, "coverage-indexes/resume-event-failure-001-coverage.json")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(path.join(executionRoot, "resume-attempts/resume-event-failure-001.json")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("coverage-adopt rejects a closed execution", async () => {
  const fixture = await setupFixture();
  try {
    const runId = "closed-coverage-parent";
    const executionRoot = await planRun(fixture, runId);
    assert.equal((await runCli([
      "closeout", "--workspace", fixture.root,
      "--run-id", runId,
      "--decision", "blocked",
    ])).status, "closed");
    const requestPath = path.join(executionRoot, "coverage-after-closeout.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitCoverageAdoptRequestV1",
      coverageId: "must-not-write",
      sources: [],
    });
    const result = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /closed execution/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("closed parent rejects the same resume id across continuation run ids", async () => {
  const fixture = await setupFixture();
  try {
    const parentRunId = "duplicate-resume-parent";
    await planRun(fixture, parentRunId);
    assert.equal((await runCli([
      "closeout", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--decision", "blocked",
    ])).status, "closed");
    const firstPath = path.join(fixture.root, "resume-duplicate-first.json");
    await writeJson(firstPath, resumeRequest({
      resumeId: "same-resume-id",
      continuationRunId: "first-continuation",
      sources: [],
    }));
    assert.equal((await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", firstPath,
    ])).status, "continuation_created");
    assert.equal((await runCli([
      "closeout", "--workspace", fixture.root,
      "--run-id", "first-continuation",
      "--decision", "blocked",
    ])).status, "closed");
    const secondPath = path.join(fixture.root, "resume-duplicate-second.json");
    await writeJson(secondPath, resumeRequest({
      resumeId: "same-resume-id",
      continuationRunId: "second-continuation",
      sources: [],
    }));
    const duplicate = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", secondPath,
    ]);
    assert.equal(duplicate.status, "invalid_input");
    assert.match(duplicate.issues.join("\n"), /resume id already exists/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume rejects a self-consistent accepted closeout with malformed verification identity", async () => {
  const fixture = await setupFixture();
  try {
    const parentRunId = "malformed-accepted-parent";
    const parent = await closeAccepted(fixture, parentRunId);
    const closeoutPath = path.join(parent.executionRoot, "closeout-receipt.json");
    const original = JSON.parse(await readFile(closeoutPath, "utf8"));
    const payload = structuredClone(original.artifact.payload);
    payload.verification.selectedProfileIds = ["feature-stage", "feature-stage"];
    const forged = createCoreArtifact({
      core: original.artifact.core,
      producer: original.artifact.producer,
      payload,
      extensions: original.artifact.extensions,
    });
    await writeJson(closeoutPath, forged);
    const requestPath = path.join(fixture.root, "resume-malformed-accepted.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-malformed-accepted",
      continuationRunId: "malformed-accepted-continuation",
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", parentRunId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /accepted closeout lacks complete verification/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("control lock fails closed before a second resume transaction can start", async () => {
  const fixture = await setupFixture();
  try {
    const runId = "locked-active-parent";
    await planRun(fixture, runId);
    await mkdir(path.join(fixture.root, ".owlcoda/runkit/control.lock"));
    const requestPath = path.join(fixture.root, "resume-locked.json");
    await writeJson(requestPath, resumeRequest({
      resumeId: "resume-locked-001",
      continuationRunId: null,
      sources: [],
    }));
    const result = await runCli([
      "resume", "--workspace", fixture.root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /control transaction.*active/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
