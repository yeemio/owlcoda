import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildResourcePreflight,
  summarizeResourcePreflight,
} from "../../scripts/runkit-contract/resource-preflight.mjs";
import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";

const roots = [];

test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("available known resources produce a deterministic ready estimate", () => {
  const artifact = buildResourcePreflight({
    runId: "resource-run",
    request: requestFixture(),
    verificationPlan: verificationPlanFixture(),
    requestSha256: "a".repeat(64),
  });

  assert.deepEqual(artifact.estimate, {
    plannedWorkloads: 1,
    reusedWorkloads: 0,
    pendingWorkloads: 1,
    calls: 99,
    inputTokens: 990_000,
    outputTokens: 99_000,
    totalTokens: 1_089_000,
    elapsedMs: 99_000,
    cost: { status: "known", valueUsd: 1.188 },
  });
  assert.deepEqual(artifact.receiptReuse, {
    verificationPlanId: "verify-plan-1",
    reusableReceiptIds: ["receipt-reusable"],
    appliedReceiptIds: [],
  });
  assert.deepEqual(artifact.decision, {
    status: "ready_for_model_execution",
    blockers: [],
    warnings: [],
    nextAllowedAction: "begin_model_execution",
  });
  assert.equal(artifact.authorizationGranted, false);
  assert.equal(artifact.gitAuthorization, false);
  assert.equal(artifact.releaseAuthorization, false);
});

test("known insufficient quota blocks before model execution and preserves reset truth", () => {
  const request = requestFixture();
  request.observations[0].quota.remainingCalls = { status: "known", value: 98 };
  const artifact = buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "b".repeat(64),
  });

  assert.equal(artifact.decision.status, "blocked_by_resource");
  assert.equal(artifact.decision.nextAllowedAction, "pause_at_deterministic_stage");
  assert.deepEqual(artifact.decision.blockers, ["insufficient_call_quota:kimi/k2.5"]);
  assert.deepEqual(artifact.resources[0].quota.resetAt, {
    status: "known",
    value: "2026-07-18T00:00:00.000Z",
  });
});

test("unknown evidence obeys explicit fail-closed and fail-open policy", () => {
  const request = requestFixture();
  request.observations[0] = unknownObservation();
  const blocked = buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "c".repeat(64),
  });
  assert.equal(blocked.decision.status, "blocked_by_resource");
  assert.equal(blocked.estimate.cost.status, "unknown");
  assert.deepEqual(blocked.decision.blockers, [
    "availability_unknown:kimi/k2.5",
    "pricing_unknown:kimi/k2.5",
    "quota_calls_unknown:kimi/k2.5",
    "quota_tokens_unknown:kimi/k2.5",
    "reset_time_unknown:kimi/k2.5",
  ]);

  request.policy.unknownHandling = {
    availability: "fail_open",
    quota: "fail_open",
    resetTime: "fail_open",
    pricing: "fail_open",
  };
  const allowed = buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "d".repeat(64),
  });
  assert.equal(allowed.decision.status, "ready_for_model_execution");
  assert.deepEqual(allowed.decision.blockers, []);
  assert.deepEqual(allowed.decision.warnings, blocked.decision.blockers);
});

test("only reusable receipts in the hash-bound verification plan exclude workload", () => {
  const request = requestFixture();
  request.workloads.push({
    id: "covered-eval",
    providerId: "kimi",
    modelId: "k2.5",
    calls: 10,
    inputTokens: 100_000,
    outputTokens: 10_000,
    elapsedMs: 10_000,
    coveredByReceiptId: "receipt-reusable",
  });
  const artifact = buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "e".repeat(64),
  });
  assert.equal(artifact.estimate.reusedWorkloads, 1);
  assert.equal(artifact.estimate.calls, 99);
  assert.deepEqual(artifact.receiptReuse.appliedReceiptIds, ["receipt-reusable"]);

  request.workloads[1].coveredByReceiptId = "receipt-invalidated";
  assert.throws(() => buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "f".repeat(64),
  }), /not reusable/);
});

test("optional model gates skip model execution instead of inventing a fallback", () => {
  const request = requestFixture();
  request.policy.gateMode = "model_optional";
  request.observations[0].availability = { status: "unavailable", reason: "quota exhausted" };
  const artifact = buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "1".repeat(64),
  });
  assert.deepEqual(artifact.decision, {
    status: "ready_without_model_execution",
    blockers: [],
    warnings: ["model_unavailable:kimi/k2.5"],
    nextAllowedAction: "continue_without_model_calls",
  });
});

test("hard cost limits block and credential-shaped evidence references are rejected", () => {
  const request = requestFixture();
  request.policy.limits.maxCostUsd = 1;
  const artifact = buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "2".repeat(64),
  });
  assert.deepEqual(artifact.decision.blockers, ["policy_limit_exceeded:cost_usd"]);

  request.observations[0].adapter.evidenceRef = "https://provider.example/quota?api_key=secret";
  assert.throws(() => buildResourcePreflight({
    runId: "resource-run",
    request,
    verificationPlan: verificationPlanFixture(),
    requestSha256: "3".repeat(64),
  }), /must not contain credentials/);
});

test("stale observations block a required model workload and remain inspectable", () => {
  const artifact = buildResourcePreflight({
    runId: "resource-run",
    request: requestFixture(),
    verificationPlan: verificationPlanFixture(),
    requestSha256: "4".repeat(64),
    evaluatedAt: "2026-07-17T10:10:00.000Z",
  });
  assert.equal(artifact.validUntil, "2026-07-17T10:05:00.000Z");
  assert.deepEqual(artifact.decision.blockers, ["observation_stale:kimi/k2.5"]);
  assert.equal(summarizeResourcePreflight(artifact, "resource-run").status, "blocked_by_resource");
});

test("resource artifact inspection rejects forged reuse, cost, and decision projections", () => {
  const artifact = buildResourcePreflight({
    runId: "resource-run",
    request: requestFixture(),
    verificationPlan: verificationPlanFixture(),
    requestSha256: "5".repeat(64),
  });

  const forgedReuse = structuredClone(artifact);
  forgedReuse.receiptReuse.verificationPlanId = "different-plan";
  assert.throws(() => summarizeResourcePreflight(forgedReuse, "resource-run"), /verification plan/i);

  const forgedCost = structuredClone(artifact);
  forgedCost.estimate.cost.valueUsd = 0;
  assert.throws(() => summarizeResourcePreflight(forgedCost, "resource-run"), /cost/i);

  const forgedDecision = structuredClone(artifact);
  forgedDecision.decision.nextAllowedAction = "pause_at_deterministic_stage";
  assert.throws(() => summarizeResourcePreflight(forgedDecision, "resource-run"), /decision/i);
});

test("resource-preflight writes one append-only artifact and rejects plan hash drift", async () => {
  const root = await activeProject();
  const executionRoot = path.join(
    root,
    ".owlcoda/runkit/executions/runkit-resource-workflow",
  );
  const plan = verificationPlanFixture({ runId: "runkit-resource-workflow" });
  const planPath = path.join(executionRoot, "verification-plans", "verify-plan-1.json");
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeJson(planPath, plan);
  const request = requestFixture({
    verificationPlanPath: relative(root, planPath),
    verificationPlanSha256: sha256(readFileSync(planPath)),
  });
  request.observations[0].adapter.observedAt = new Date().toISOString();
  const requestPath = path.join(root, "resource-request.json");
  writeJson(requestPath, request);

  const first = await runCli([
    "resource-preflight",
    "--workspace", root,
    "--run-id", "runkit-resource-workflow",
    "--request", requestPath,
  ]);
  assert.equal(first.status, "resource_preflight_written");
  assert.equal(first.decision, "ready_for_model_execution");
  assert.equal(first.authorizationGranted, false);
  const saved = JSON.parse(readFileSync(path.join(root, first.preflightPath), "utf8"));
  assert.equal(saved.schemaVersion, "OwlCodaRunKitResourcePreflightV1");
  assert.equal(saved.requestSha256, sha256(readFileSync(requestPath)));

  const duplicate = await runCli([
    "resource-preflight",
    "--workspace", root,
    "--run-id", "runkit-resource-workflow",
    "--request", requestPath,
  ]);
  assert.equal(duplicate.status, "invalid_input");
  assert.match(duplicate.issues[0], /already exists|EEXIST/);

  request.preflightId = "resource-preflight-2";
  writeJson(requestPath, request);
  const second = await runCli([
    "resource-preflight",
    "--workspace", root,
    "--run-id", "runkit-resource-workflow",
    "--request", requestPath,
  ]);
  assert.equal(second.status, "resource_preflight_written");
  assert.equal(JSON.parse(readFileSync(path.join(root, second.preflightPath), "utf8")).sequence, 2);
  const inspected = await runCli(["inspect", "--json", "--workspace", root]);
  assert.deepEqual(inspected.summary.resourcePreflight, {
    status: "current",
    preflightId: "resource-preflight-2",
    sequence: 2,
    evaluatedAt: inspected.summary.resourcePreflight.evaluatedAt,
    validUntil: inspected.summary.resourcePreflight.validUntil,
    decision: "ready_for_model_execution",
    nextAllowedAction: "begin_model_execution",
    blockers: [],
    warnings: [],
    receiptReuse: { reusableCount: 1, appliedCount: 0 },
    estimate: {
      calls: 99,
      inputTokens: 990_000,
      outputTokens: 99_000,
      totalTokens: 1_089_000,
      elapsedMs: 99_000,
      cost: { status: "known", valueUsd: 1.188 },
    },
    resources: [inspected.summary.resourcePreflight.resources[0]],
  });
  assert.equal(inspected.summary.nextAllowedAction, "begin_model_execution");

  request.preflightId = "resource-preflight-3";
  request.verificationPlanSha256 = "0".repeat(64);
  writeJson(requestPath, request);
  const drifted = await runCli([
    "resource-preflight",
    "--workspace", root,
    "--run-id", "runkit-resource-workflow",
    "--request", requestPath,
  ]);
  assert.equal(drifted.status, "invalid_input");
  assert.match(drifted.issues[0], /hash mismatch/);
});

test("inspect fails closed when the hash-bound verification plan changes", async () => {
  const { root, planPath } = await projectWithResourcePreflight();
  writeJson(planPath, verificationPlanFixture({
    runId: "runkit-resource-workflow",
    planId: "changed-plan",
  }));

  const inspected = await runCli(["inspect", "--json", "--workspace", root]);

  assert.equal(inspected.exitCode, 2);
  assert.equal(inspected.summary.resourcePreflight.status, "invalid");
  assert.equal(inspected.summary.nextAllowedAction, "repair_execution_artifacts");
  assert.match(inspected.summary.dominantGap.reasons.join("\n"), /verification plan.*hash/i);
});

test("inspect rejects a symlinked resource preflight directory", async () => {
  const { root, executionRoot } = await projectWithResourcePreflight();
  const resourceRoot = path.join(executionRoot, "resource-preflights");
  const movedRoot = path.join(root, "redirected-resource-preflights");
  renameSync(resourceRoot, movedRoot);
  symlinkSync(movedRoot, resourceRoot, "dir");

  const inspected = await runCli(["inspect", "--json", "--workspace", root]);

  assert.equal(inspected.exitCode, 2);
  assert.equal(inspected.summary.resourcePreflight.status, "invalid");
  assert.match(inspected.summary.dominantGap.reasons.join("\n"), /real directory|symlink/i);
});

test("expired resource evidence asks for a new preflight before model execution", async () => {
  const root = await activeProject();
  const executionRoot = path.join(root, ".owlcoda/runkit/executions/runkit-resource-workflow");
  const plan = verificationPlanFixture({ runId: "runkit-resource-workflow" });
  const planPath = path.join(executionRoot, "verification-plans", "verify-plan-1.json");
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeJson(planPath, plan);
  const request = requestFixture({
    verificationPlanPath: relative(root, planPath),
    verificationPlanSha256: sha256(readFileSync(planPath)),
  });
  request.observations[0].adapter.observedAt = new Date(Date.now() - 600_000).toISOString();
  const requestPath = path.join(root, "expired-resource-request.json");
  writeJson(requestPath, request);
  assert.equal((await runCli([
    "resource-preflight",
    "--workspace", root,
    "--run-id", "runkit-resource-workflow",
    "--request", requestPath,
  ])).exitCode, 0);

  const inspected = await runCli(["inspect", "--json", "--workspace", root]);

  assert.equal(inspected.summary.resourcePreflight.status, "expired");
  assert.equal(inspected.summary.resourcePreflight.decision, "blocked_by_resource");
  assert.equal(inspected.summary.nextAllowedAction, "run_resource_preflight");
  assert.equal(inspected.summary.releaseAuthorization, false);
});

function requestFixture(overrides = {}) {
  return {
    schemaVersion: "OwlCodaRunKitResourcePreflightRequestV1",
    preflightId: "resource-preflight-1",
    verificationPlanPath: ".owlcoda/runkit/executions/resource-run/verification-plans/verify-plan-1.json",
    verificationPlanSha256: "9".repeat(64),
    policy: {
      gateMode: "model_required",
      maxObservationAgeMs: 300_000,
      unknownHandling: {
        availability: "fail_closed",
        quota: "fail_closed",
        resetTime: "fail_closed",
        pricing: "fail_closed",
      },
      limits: {
        maxCalls: 100,
        maxTotalTokens: 1_200_000,
        maxElapsedMs: 120_000,
        maxCostUsd: 2,
      },
    },
    observations: [knownObservation()],
    workloads: [{
      id: "remaining-eval",
      providerId: "kimi",
      modelId: "k2.5",
      calls: 99,
      inputTokens: 990_000,
      outputTokens: 99_000,
      elapsedMs: 99_000,
    }],
    ...overrides,
  };
}

function knownObservation() {
  return {
    providerId: "kimi",
    modelId: "k2.5",
    adapter: {
      id: "owlcoda-model-resource-adapter",
      kind: "provider_api",
      evidenceRef: "artifact:sha256:resource-observation",
      evidenceSha256: "8".repeat(64),
      observedAt: "2026-07-17T10:00:00.000Z",
    },
    availability: { status: "available" },
    quota: {
      remainingCalls: { status: "known", value: 120 },
      remainingTokens: { status: "known", value: 1_500_000 },
      resetAt: { status: "known", value: "2026-07-18T00:00:00.000Z" },
    },
    pricing: {
      status: "known",
      currency: "USD",
      inputPerMillion: 1,
      outputPerMillion: 2,
    },
  };
}

function unknownObservation() {
  const unknown = { status: "unknown", reason: "provider_not_exposed" };
  return {
    ...knownObservation(),
    availability: { status: "unknown", reason: "adapter_has_no_live_probe" },
    quota: {
      remainingCalls: { ...unknown },
      remainingTokens: { ...unknown },
      resetAt: { ...unknown },
    },
    pricing: { ...unknown },
  };
}

function verificationPlanFixture(overrides = {}) {
  return {
    schemaVersion: "OwlCodaRunKitVerificationPlanV1",
    runId: "resource-run",
    planId: "verify-plan-1",
    verificationContextFingerprint: "7".repeat(64),
    status: "verification_required",
    drift: {
      leasedSourceDrift: [],
      declaredDependencyDrift: [],
      unrelatedDirtyTreeDrift: [],
      globalGateFailures: [],
    },
    profileImpact: {
      decision: "targeted_profiles",
      primaryProfileId: "profile-1",
      directProfileIds: ["profile-1"],
      transitiveProfileIds: [],
      supportingProfileIds: [],
      selectedProfileIds: ["profile-1"],
      uncoveredPaths: [],
      warnings: [],
    },
    evidence: {
      reusableReceiptIds: ["receipt-reusable"],
      invalidatedReceipts: [{ receiptId: "receipt-invalidated", reasons: ["leased_source_drift:file.ts"] }],
    },
    commands: {
      requiredCommandIds: ["verify-model-output"],
      reusedCommandIds: [],
      pendingCommandIds: ["verify-model-output"],
      unmappedProfileIds: [],
      pendingCommands: [{
        id: "verify-model-output",
        cwd: ".",
        executable: "/usr/bin/true",
        argv: [],
        profileIds: ["profile-1"],
      }],
    },
    acceptance: { blocked: false, reasons: [] },
    authorizationGranted: false,
    ...overrides,
  };
}

async function activeProject() {
  const root = mkdtempSync(path.join(tmpdir(), "owlcoda-resource-preflight-"));
  roots.push(root);
  assert.equal((await runCli(["init", "--workspace", root])).exitCode, 0);
  const goalPath = path.join(root, "goal.json");
  writeJson(goalPath, { title: "resource preflight test" });
  assert.equal((await runCli([
    "plan",
    "--workspace", root,
    "--run-id", "runkit-resource-workflow",
    "--goal", goalPath,
  ])).exitCode, 0);
  return root;
}

async function projectWithResourcePreflight() {
  const root = await activeProject();
  const executionRoot = path.join(root, ".owlcoda/runkit/executions/runkit-resource-workflow");
  const plan = verificationPlanFixture({ runId: "runkit-resource-workflow" });
  const planPath = path.join(executionRoot, "verification-plans", "verify-plan-1.json");
  mkdirSync(path.dirname(planPath), { recursive: true });
  writeJson(planPath, plan);
  const request = requestFixture({
    verificationPlanPath: relative(root, planPath),
    verificationPlanSha256: sha256(readFileSync(planPath)),
  });
  request.observations[0].adapter.observedAt = new Date().toISOString();
  const requestPath = path.join(root, "resource-request.json");
  writeJson(requestPath, request);
  assert.equal((await runCli([
    "resource-preflight",
    "--workspace", root,
    "--run-id", "runkit-resource-workflow",
    "--request", requestPath,
  ])).exitCode, 0);
  return { root, executionRoot, planPath };
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}
