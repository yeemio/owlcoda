import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  assertAllowedKeys,
  isRecord,
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  resolveExistingArtifact,
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REQUEST_KEYS = [
  "schemaVersion",
  "preflightId",
  "verificationPlanPath",
  "verificationPlanSha256",
  "policy",
  "observations",
  "workloads",
];
const POLICY_KEYS = ["gateMode", "maxObservationAgeMs", "unknownHandling", "limits"];
const UNKNOWN_HANDLING_KEYS = ["availability", "quota", "resetTime", "pricing"];
const LIMIT_KEYS = ["maxCalls", "maxTotalTokens", "maxElapsedMs", "maxCostUsd"];
const OBSERVATION_KEYS = ["providerId", "modelId", "adapter", "availability", "quota", "pricing"];
const ADAPTER_KEYS = ["id", "kind", "evidenceRef", "evidenceSha256", "observedAt"];
const AVAILABILITY_KEYS = ["status", "reason"];
const QUOTA_KEYS = ["remainingCalls", "remainingTokens", "resetAt"];
const TYPED_VALUE_KEYS = ["status", "value", "reason"];
const PRICING_KEYS = ["status", "currency", "inputPerMillion", "outputPerMillion", "reason"];
const WORKLOAD_KEYS = [
  "id",
  "providerId",
  "modelId",
  "calls",
  "inputTokens",
  "outputTokens",
  "elapsedMs",
  "coveredByReceiptId",
];
const ARTIFACT_KEYS = [
  "schemaVersion",
  "runId",
  "preflightId",
  "sequence",
  "evaluatedAt",
  "validUntil",
  "requestSha256",
  "verificationPlan",
  "policy",
  "receiptReuse",
  "estimate",
  "resources",
  "decision",
  "authorizationGranted",
  "gitAuthorization",
  "releaseAuthorization",
];

export function buildResourcePreflight({
  runId,
  request,
  verificationPlan,
  requestSha256,
  sequence = 1,
  evaluatedAt,
}) {
  safeIdentifier(runId, "runId");
  const normalizedSequence = positiveInteger(sequence, "resource preflight sequence");
  const normalized = normalizeRequest(request);
  const plan = normalizeVerificationPlan(verificationPlan, runId);
  const normalizedRequestSha256 = requiredSha256(requestSha256, "requestSha256");
  const reusableReceiptIds = plan.reusableReceiptIds;
  const reusableSet = new Set(reusableReceiptIds);
  const appliedReceiptIds = new Set();
  const pending = [];
  for (const workload of normalized.workloads) {
    if (workload.coveredByReceiptId !== null) {
      if (!reusableSet.has(workload.coveredByReceiptId)) {
        throw new Error(`Workload ${workload.id} receipt is not reusable: ${workload.coveredByReceiptId}`);
      }
      appliedReceiptIds.add(workload.coveredByReceiptId);
      continue;
    }
    pending.push(workload);
  }
  const effectiveEvaluatedAt = isoTimestamp(
    evaluatedAt ?? latestObservedAt(normalized.observations),
    "resource evaluatedAt",
  );

  const demandByResource = new Map();
  for (const workload of pending) {
    const key = resourceKey(workload.providerId, workload.modelId);
    const current = demandByResource.get(key) ?? emptyDemand();
    current.calls += workload.calls;
    current.inputTokens += workload.inputTokens;
    current.outputTokens += workload.outputTokens;
    current.totalTokens += workload.inputTokens + workload.outputTokens;
    current.elapsedMs += workload.elapsedMs;
    demandByResource.set(key, current);
  }

  const blockers = [];
  const warnings = [];
  const resourceAssessments = normalized.observations.map(observation => {
    const key = resourceKey(observation.providerId, observation.modelId);
    const demand = demandByResource.get(key) ?? emptyDemand();
    if (demand.calls > 0) {
      assessObservation({
        observation,
        demand,
        policy: normalized.policy,
        evaluatedAt: effectiveEvaluatedAt,
        blockers,
        warnings,
      });
    }
    return { ...observation, demand };
  });

  const totals = pending.reduce((result, workload) => {
    result.calls += workload.calls;
    result.inputTokens += workload.inputTokens;
    result.outputTokens += workload.outputTokens;
    result.totalTokens += workload.inputTokens + workload.outputTokens;
    result.elapsedMs += workload.elapsedMs;
    return result;
  }, emptyDemand());
  const cost = costEstimateFromResources(resourceAssessments);
  assessLimits({ totals, cost, policy: normalized.policy, blockers });
  const validUntil = pending.length === 0
    ? null
    : earliestResourceExpiry(resourceAssessments, normalized.policy.maxObservationAgeMs);
  const decision = resourceDecision({
    pendingCount: pending.length,
    blockers,
    warnings,
    gateMode: normalized.policy.gateMode,
  });

  return {
    schemaVersion: "OwlCodaRunKitResourcePreflightV1",
    runId,
    preflightId: normalized.preflightId,
    sequence: normalizedSequence,
    evaluatedAt: effectiveEvaluatedAt,
    validUntil,
    requestSha256: normalizedRequestSha256,
    verificationPlan: {
      path: normalized.verificationPlanPath,
      sha256: normalized.verificationPlanSha256,
      planId: plan.planId,
    },
    policy: normalized.policy,
    receiptReuse: {
      verificationPlanId: plan.planId,
      reusableReceiptIds,
      appliedReceiptIds: [...appliedReceiptIds].sort(),
    },
    estimate: {
      plannedWorkloads: normalized.workloads.length,
      reusedWorkloads: normalized.workloads.length - pending.length,
      pendingWorkloads: pending.length,
      ...totals,
      cost,
    },
    resources: resourceAssessments,
    decision,
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
  };
}

export function runResourcePreflight({ workspaceRoot, runId, request, requestSha256 }) {
  const normalized = normalizeRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const planPath = resolveExistingArtifact(
    workspaceRoot,
    normalized.verificationPlanPath,
    "verificationPlanPath",
  );
  const expectedPlanRoot = path.join(executionRoot, "verification-plans");
  const relativePlanPath = path.relative(expectedPlanRoot, planPath);
  if (relativePlanPath === ""
    || relativePlanPath === ".."
    || relativePlanPath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePlanPath)
    || realpathSync(planPath) !== path.resolve(workspaceRoot, normalized.verificationPlanPath)) {
    throw new Error("verificationPlanPath must be a real file inside the active execution verification-plans directory.");
  }
  const planStat = lstatSync(planPath);
  if (planStat.isSymbolicLink() || !planStat.isFile()) {
    throw new Error("verificationPlanPath must be a regular file, not a symlink.");
  }
  const planBytes = readFileSync(planPath);
  if (sha256(planBytes) !== normalized.verificationPlanSha256) {
    throw new Error("Verification plan hash mismatch.");
  }
  const artifact = buildResourcePreflight({
    runId,
    request,
    verificationPlan: JSON.parse(planBytes.toString("utf8")),
    requestSha256,
    sequence: nextResourceSequence(executionRoot, runId),
    evaluatedAt: new Date().toISOString(),
  });
  const outputPath = path.join(executionRoot, "resource-preflights", `${normalized.preflightId}.json`);
  writeJsonExclusiveAtomically(outputPath, artifact);
  return {
    status: "resource_preflight_written",
    exitCode: 0,
    runId,
    preflightPath: relativeToWorkspace(workspaceRoot, outputPath),
    decision: artifact.decision.status,
    nextAllowedAction: artifact.decision.nextAllowedAction,
    authorizationGranted: false,
  };
}

export function summarizeResourcePreflight(value, expectedRunId) {
  assertAllowedKeys(value, "Resource preflight artifact", ARTIFACT_KEYS);
  if (value.schemaVersion !== "OwlCodaRunKitResourcePreflightV1"
    || value.runId !== expectedRunId
    || value.authorizationGranted !== false
    || value.gitAuthorization !== false
    || value.releaseAuthorization !== false) {
    throw new Error("Resource preflight artifact identity or authorization boundary is invalid.");
  }
  const preflightId = safeIdentifier(value.preflightId, "resource preflightId");
  const sequence = positiveInteger(value.sequence, "resource preflight sequence");
  const evaluatedAt = isoTimestamp(value.evaluatedAt, "resource evaluatedAt");
  const validUntil = value.validUntil === null ? null : isoTimestamp(value.validUntil, "resource validUntil");
  requiredSha256(value.requestSha256, "resource requestSha256");
  if (!isRecord(value.verificationPlan)) throw new Error("Resource verificationPlan is invalid.");
  assertAllowedKeys(value.verificationPlan, "Resource verificationPlan", ["path", "sha256", "planId"]);
  safeRelativePath(value.verificationPlan.path, "Resource verificationPlan path");
  requiredSha256(value.verificationPlan.sha256, "Resource verificationPlan sha256");
  safeIdentifier(value.verificationPlan.planId, "Resource verificationPlan planId");
  const policy = normalizePolicy(value.policy);
  if (!isRecord(value.receiptReuse)) throw new Error("Resource receiptReuse is invalid.");
  assertAllowedKeys(value.receiptReuse, "Resource receiptReuse", [
    "verificationPlanId",
    "reusableReceiptIds",
    "appliedReceiptIds",
  ]);
  const verificationPlanId = safeIdentifier(value.receiptReuse.verificationPlanId, "Resource verificationPlanId");
  const reusableReceiptIds = sortedUniqueIdentifiers(value.receiptReuse.reusableReceiptIds, "Resource reusableReceiptIds");
  const appliedReceiptIds = sortedUniqueIdentifiers(value.receiptReuse.appliedReceiptIds, "Resource appliedReceiptIds");
  if (verificationPlanId !== value.verificationPlan.planId) {
    throw new Error("Resource receipt reuse verification plan does not match the bound verification plan.");
  }
  if (appliedReceiptIds.some(receiptId => !reusableReceiptIds.includes(receiptId))) {
    throw new Error("Resource applied receipt ids must be a subset of reusable receipt ids.");
  }
  if (!isRecord(value.estimate)) throw new Error("Resource estimate is invalid.");
  assertAllowedKeys(value.estimate, "Resource estimate", [
    "plannedWorkloads",
    "reusedWorkloads",
    "pendingWorkloads",
    "calls",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "elapsedMs",
    "cost",
  ]);
  for (const key of [
    "plannedWorkloads",
    "reusedWorkloads",
    "pendingWorkloads",
    "calls",
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "elapsedMs",
  ]) nonNegativeInteger(value.estimate[key], `Resource estimate ${key}`);
  if (value.estimate.totalTokens !== value.estimate.inputTokens + value.estimate.outputTokens
    || value.estimate.plannedWorkloads !== value.estimate.reusedWorkloads + value.estimate.pendingWorkloads) {
    throw new Error("Resource estimate totals are inconsistent.");
  }
  const cost = normalizeCost(value.estimate.cost);
  if ((value.estimate.pendingWorkloads === 0) !== (value.estimate.calls === 0)
    || appliedReceiptIds.length > value.estimate.reusedWorkloads) {
    throw new Error("Resource workload and receipt reuse counts are inconsistent.");
  }
  if (!Array.isArray(value.resources)) throw new Error("Resource assessments must be an array.");
  const normalizedResources = value.resources.map(resource => {
    if (!isRecord(resource)) throw new Error("Resource assessment must be an object.");
    assertAllowedKeys(resource, "Resource assessment", [...OBSERVATION_KEYS, "demand"]);
    const observation = normalizeObservation(Object.fromEntries(
      OBSERVATION_KEYS.map(key => [key, resource[key]]),
    ));
    if (!isRecord(resource.demand)) throw new Error("Resource demand is invalid.");
    assertAllowedKeys(resource.demand, "Resource demand", ["calls", "inputTokens", "outputTokens", "totalTokens", "elapsedMs"]);
    for (const key of ["calls", "inputTokens", "outputTokens", "totalTokens", "elapsedMs"]) {
      nonNegativeInteger(resource.demand[key], `Resource demand ${key}`);
    }
    if (resource.demand.totalTokens !== resource.demand.inputTokens + resource.demand.outputTokens) {
      throw new Error("Resource demand token totals are inconsistent.");
    }
    return { ...observation, demand: { ...resource.demand } };
  }).sort((left, right) => resourceKey(left.providerId, left.modelId).localeCompare(resourceKey(right.providerId, right.modelId)));
  const resourceKeys = normalizedResources.map(resource => resourceKey(resource.providerId, resource.modelId));
  if (new Set(resourceKeys).size !== resourceKeys.length) throw new Error("Resource assessments must be unique.");
  const demandTotals = normalizedResources.reduce((total, resource) => {
    for (const key of ["calls", "inputTokens", "outputTokens", "totalTokens", "elapsedMs"]) {
      total[key] += resource.demand[key];
    }
    return total;
  }, emptyDemand());
  for (const key of ["calls", "inputTokens", "outputTokens", "totalTokens", "elapsedMs"]) {
    if (demandTotals[key] !== value.estimate[key]) throw new Error(`Resource estimate ${key} does not match resource demand.`);
  }
  const recomputedCost = costEstimateFromResources(normalizedResources);
  if (JSON.stringify(recomputedCost) !== JSON.stringify(cost)) {
    throw new Error("Resource cost does not match the declared resource demand and pricing.");
  }
  const expectedValidUntil = value.estimate.pendingWorkloads === 0
    ? null
    : earliestResourceExpiry(normalizedResources, policy.maxObservationAgeMs);
  if (validUntil !== expectedValidUntil) {
    throw new Error("Resource validUntil does not match observation freshness policy.");
  }
  if (!isRecord(value.decision)) throw new Error("Resource decision is invalid.");
  assertAllowedKeys(value.decision, "Resource decision", ["status", "blockers", "warnings", "nextAllowedAction"]);
  const status = enumValue(value.decision.status, [
    "ready_for_model_execution",
    "ready_without_model_execution",
    "blocked_by_resource",
  ], "resource decision status");
  const blockers = sortedUniqueStrings(value.decision.blockers, "resource blockers");
  const warnings = sortedUniqueStrings(value.decision.warnings, "resource warnings");
  const nextAllowedAction = enumValue(value.decision.nextAllowedAction, [
    "begin_model_execution",
    "continue_without_model_calls",
    "pause_at_deterministic_stage",
  ], "resource nextAllowedAction");
  const recomputedBlockers = [];
  const recomputedWarnings = [];
  for (const resource of normalizedResources) {
    if (resource.demand.calls > 0) {
      assessObservation({
        observation: resource,
        demand: resource.demand,
        policy,
        evaluatedAt,
        blockers: recomputedBlockers,
        warnings: recomputedWarnings,
      });
    }
  }
  assessLimits({ totals: demandTotals, cost: recomputedCost, policy, blockers: recomputedBlockers });
  const expectedDecision = resourceDecision({
    pendingCount: value.estimate.pendingWorkloads,
    blockers: recomputedBlockers,
    warnings: recomputedWarnings,
    gateMode: policy.gateMode,
  });
  if (status !== expectedDecision.status
    || nextAllowedAction !== expectedDecision.nextAllowedAction
    || JSON.stringify(blockers) !== JSON.stringify(expectedDecision.blockers)
    || JSON.stringify(warnings) !== JSON.stringify(expectedDecision.warnings)) {
    throw new Error("Resource decision does not match the declared evidence, demand, and policy.");
  }
  const resources = normalizedResources.map(resource => ({
    providerId: resource.providerId,
    modelId: resource.modelId,
    availability: resource.availability,
    quota: resource.quota,
    demand: resource.demand,
  }));
  return {
    preflightId,
    sequence,
    evaluatedAt,
    validUntil,
    status,
    nextAllowedAction,
    blockers,
    warnings,
    receiptReuse: {
      reusableCount: reusableReceiptIds.length,
      appliedCount: appliedReceiptIds.length,
    },
    estimate: {
      calls: value.estimate.calls,
      inputTokens: value.estimate.inputTokens,
      outputTokens: value.estimate.outputTokens,
      totalTokens: value.estimate.totalTokens,
      elapsedMs: value.estimate.elapsedMs,
      cost,
    },
    resources,
  };
}

function nextResourceSequence(executionRoot, runId) {
  const resourceRoot = path.join(executionRoot, "resource-preflights");
  if (!existsSync(resourceRoot)) return 1;
  const stat = lstatSync(resourceRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(resourceRoot) !== path.resolve(resourceRoot)) {
    throw new Error("Resource preflight directory must be a real directory, not a symlink.");
  }
  const sequences = [];
  for (const entry of readdirSync(resourceRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(".json")) {
      throw new Error(`Resource preflight must be a regular JSON file: ${entry.name}`);
    }
    const artifactPath = path.join(resourceRoot, entry.name);
    sequences.push(summarizeResourcePreflight(readJson(artifactPath), runId).sequence);
  }
  if (new Set(sequences).size !== sequences.length) throw new Error("Resource preflight sequences must be unique.");
  return sequences.length === 0 ? 1 : Math.max(...sequences) + 1;
}

function normalizeRequest(value) {
  assertAllowedKeys(value, "Resource preflight request", REQUEST_KEYS);
  if (value.schemaVersion !== "OwlCodaRunKitResourcePreflightRequestV1") {
    throw new Error("Unsupported resource preflight request schemaVersion.");
  }
  const preflightId = safeIdentifier(value.preflightId, "preflightId");
  const verificationPlanPath = safeRelativePath(value.verificationPlanPath, "verificationPlanPath");
  const verificationPlanSha256 = requiredSha256(value.verificationPlanSha256, "verificationPlanSha256");
  const policy = normalizePolicy(value.policy);
  if (!Array.isArray(value.observations) || value.observations.length === 0) {
    throw new Error("observations must contain at least one resource observation.");
  }
  const observationByKey = new Map();
  const observations = value.observations.map(normalizeObservation)
    .sort((left, right) => resourceKey(left.providerId, left.modelId).localeCompare(resourceKey(right.providerId, right.modelId)));
  for (const observation of observations) {
    const key = resourceKey(observation.providerId, observation.modelId);
    if (observationByKey.has(key)) throw new Error(`Resource observations must be unique: ${key}`);
    observationByKey.set(key, observation);
  }
  if (!Array.isArray(value.workloads)) throw new Error("workloads must be an array.");
  const workloadIds = new Set();
  const workloads = value.workloads.map(workload => {
    const normalized = normalizeWorkload(workload);
    if (workloadIds.has(normalized.id)) throw new Error(`Workload ids must be unique: ${normalized.id}`);
    workloadIds.add(normalized.id);
    const key = resourceKey(normalized.providerId, normalized.modelId);
    if (!observationByKey.has(key)) throw new Error(`Workload has no resource observation: ${key}`);
    return normalized;
  }).sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: value.schemaVersion,
    preflightId,
    verificationPlanPath,
    verificationPlanSha256,
    policy,
    observations,
    observationByKey,
    workloads,
  };
}

function normalizePolicy(value) {
  assertAllowedKeys(value, "Resource policy", POLICY_KEYS);
  if (!new Set(["model_required", "model_optional"]).has(value.gateMode)) {
    throw new Error("Resource policy gateMode must be model_required or model_optional.");
  }
  const maxObservationAgeMs = positiveInteger(value.maxObservationAgeMs, "Resource policy maxObservationAgeMs");
  assertAllowedKeys(value.unknownHandling, "Resource unknownHandling", UNKNOWN_HANDLING_KEYS);
  const unknownHandling = {};
  for (const key of UNKNOWN_HANDLING_KEYS) {
    if (!new Set(["fail_open", "fail_closed"]).has(value.unknownHandling[key])) {
      throw new Error(`Resource unknownHandling ${key} must be fail_open or fail_closed.`);
    }
    unknownHandling[key] = value.unknownHandling[key];
  }
  assertAllowedKeys(value.limits, "Resource limits", LIMIT_KEYS);
  const limits = {};
  for (const key of LIMIT_KEYS) {
    if (value.limits[key] === undefined) continue;
    limits[key] = nonNegativeNumber(value.limits[key], `Resource limit ${key}`, key !== "maxCostUsd");
  }
  return { gateMode: value.gateMode, maxObservationAgeMs, unknownHandling, limits };
}

function normalizeObservation(value) {
  assertAllowedKeys(value, "Resource observation", OBSERVATION_KEYS);
  const providerId = safeIdentifier(value.providerId, "providerId");
  const modelId = safeIdentifier(value.modelId, "modelId");
  assertAllowedKeys(value.adapter, "Resource adapter", ADAPTER_KEYS);
  const adapter = {
    id: safeIdentifier(value.adapter.id, "adapter id"),
    kind: enumValue(value.adapter.kind, ["owlcoda_runtime", "provider_api", "project_declared"], "adapter kind"),
    evidenceRef: evidenceReference(value.adapter.evidenceRef),
    evidenceSha256: requiredSha256(value.adapter.evidenceSha256, "adapter evidenceSha256"),
    observedAt: isoTimestamp(value.adapter.observedAt, "adapter observedAt"),
  };
  assertAllowedKeys(value.availability, "Resource availability", AVAILABILITY_KEYS);
  const availabilityStatus = enumValue(
    value.availability.status,
    ["available", "unavailable", "unknown"],
    "availability status",
  );
  const availability = availabilityStatus === "available"
    ? noUnexpectedReason(value.availability, "available availability")
    : { status: availabilityStatus, reason: nonEmptyString(value.availability.reason, "availability reason") };
  assertAllowedKeys(value.quota, "Resource quota", QUOTA_KEYS);
  const quota = {
    remainingCalls: typedNumber(value.quota.remainingCalls, "remainingCalls", true),
    remainingTokens: typedNumber(value.quota.remainingTokens, "remainingTokens", true),
    resetAt: typedTimestamp(value.quota.resetAt, "resetAt"),
  };
  const pricing = normalizePricing(value.pricing);
  return { providerId, modelId, adapter, availability, quota, pricing };
}

function normalizePricing(value) {
  assertAllowedKeys(value, "Resource pricing", PRICING_KEYS);
  if (value.status === "unknown") {
    return { status: "unknown", reason: nonEmptyString(value.reason, "pricing reason") };
  }
  if (value.status !== "known" || value.currency !== "USD") {
    throw new Error("Known resource pricing must use USD.");
  }
  if (value.reason !== undefined) throw new Error("Known pricing must not include reason.");
  return {
    status: "known",
    currency: "USD",
    inputPerMillion: nonNegativeNumber(value.inputPerMillion, "inputPerMillion", false),
    outputPerMillion: nonNegativeNumber(value.outputPerMillion, "outputPerMillion", false),
  };
}

function normalizeWorkload(value) {
  assertAllowedKeys(value, "Resource workload", WORKLOAD_KEYS);
  return {
    id: safeIdentifier(value.id, "workload id"),
    providerId: safeIdentifier(value.providerId, "workload providerId"),
    modelId: safeIdentifier(value.modelId, "workload modelId"),
    calls: positiveInteger(value.calls, "workload calls"),
    inputTokens: nonNegativeInteger(value.inputTokens, "workload inputTokens"),
    outputTokens: nonNegativeInteger(value.outputTokens, "workload outputTokens"),
    elapsedMs: nonNegativeInteger(value.elapsedMs, "workload elapsedMs"),
    coveredByReceiptId: value.coveredByReceiptId === undefined
      ? null
      : safeIdentifier(value.coveredByReceiptId, "coveredByReceiptId"),
  };
}

function normalizeVerificationPlan(value, runId) {
  if (!isRecord(value)
    || value.schemaVersion !== "OwlCodaRunKitVerificationPlanV1"
    || value.runId !== runId
    || typeof value.planId !== "string"
    || !isRecord(value.evidence)
    || !Array.isArray(value.evidence.reusableReceiptIds)
    || value.authorizationGranted !== false) {
    throw new Error("verificationPlan must be a valid OwlCodaRunKitVerificationPlanV1 for this execution.");
  }
  const planId = safeIdentifier(value.planId, "verification planId");
  const reusableReceiptIds = sortedUniqueIdentifiers(value.evidence.reusableReceiptIds, "reusableReceiptIds");
  return { planId, reusableReceiptIds };
}

function assessObservation({ observation, demand, policy, evaluatedAt, blockers, warnings }) {
  const key = resourceKey(observation.providerId, observation.modelId);
  const observedAtMs = new Date(observation.adapter.observedAt).getTime();
  const evaluatedAtMs = new Date(evaluatedAt).getTime();
  if (observedAtMs > evaluatedAtMs) throw new Error(`Resource observation is from the future: ${key}`);
  if (evaluatedAtMs - observedAtMs > policy.maxObservationAgeMs) {
    blockers.push(`observation_stale:${key}`);
    return;
  }
  if (observation.availability.status === "unavailable") {
    blockers.push(`model_unavailable:${key}`);
    return;
  }
  unknownIssue({
    unknown: observation.availability.status === "unknown",
    policy: policy.unknownHandling.availability,
    code: `availability_unknown:${key}`,
    blockers,
    warnings,
  });
  if (observation.quota.remainingCalls.status === "known") {
    if (observation.quota.remainingCalls.value < demand.calls) blockers.push(`insufficient_call_quota:${key}`);
  } else {
    unknownIssue({ unknown: true, policy: policy.unknownHandling.quota, code: `quota_calls_unknown:${key}`, blockers, warnings });
  }
  if (observation.quota.remainingTokens.status === "known") {
    if (observation.quota.remainingTokens.value < demand.totalTokens) blockers.push(`insufficient_token_quota:${key}`);
  } else {
    unknownIssue({ unknown: true, policy: policy.unknownHandling.quota, code: `quota_tokens_unknown:${key}`, blockers, warnings });
  }
  unknownIssue({
    unknown: observation.quota.resetAt.status === "unknown",
    policy: policy.unknownHandling.resetTime,
    code: `reset_time_unknown:${key}`,
    blockers,
    warnings,
  });
  unknownIssue({
    unknown: observation.pricing.status === "unknown",
    policy: policy.unknownHandling.pricing,
    code: `pricing_unknown:${key}`,
    blockers,
    warnings,
  });
}

function assessLimits({ totals, cost, policy, blockers }) {
  const limits = policy.limits;
  if (limits.maxCalls !== undefined && totals.calls > limits.maxCalls) blockers.push("policy_limit_exceeded:calls");
  if (limits.maxTotalTokens !== undefined && totals.totalTokens > limits.maxTotalTokens) {
    blockers.push("policy_limit_exceeded:total_tokens");
  }
  if (limits.maxElapsedMs !== undefined && totals.elapsedMs > limits.maxElapsedMs) {
    blockers.push("policy_limit_exceeded:elapsed_ms");
  }
  if (limits.maxCostUsd !== undefined && cost.status === "known" && cost.valueUsd > limits.maxCostUsd) {
    blockers.push("policy_limit_exceeded:cost_usd");
  }
}

function resourceDecision({ pendingCount, blockers, warnings, gateMode }) {
  const uniqueBlockers = sortedUnique(blockers);
  const uniqueWarnings = sortedUnique(warnings);
  if (pendingCount === 0) {
    return {
      status: "ready_without_model_execution",
      blockers: [],
      warnings: uniqueWarnings,
      nextAllowedAction: "continue_without_model_calls",
    };
  }
  if (uniqueBlockers.length > 0 && gateMode === "model_optional") {
    return {
      status: "ready_without_model_execution",
      blockers: [],
      warnings: sortedUnique([...uniqueWarnings, ...uniqueBlockers]),
      nextAllowedAction: "continue_without_model_calls",
    };
  }
  if (uniqueBlockers.length > 0) {
    return {
      status: "blocked_by_resource",
      blockers: uniqueBlockers,
      warnings: uniqueWarnings,
      nextAllowedAction: "pause_at_deterministic_stage",
    };
  }
  return {
    status: "ready_for_model_execution",
    blockers: [],
    warnings: uniqueWarnings,
    nextAllowedAction: "begin_model_execution",
  };
}

function costEstimateFromResources(resources) {
  let knownSubtotalUsd = 0;
  const unknownResources = new Set();
  for (const resource of resources) {
    if (resource.demand.calls === 0) continue;
    const key = resourceKey(resource.providerId, resource.modelId);
    const pricing = resource.pricing;
    if (pricing.status === "unknown") {
      unknownResources.add(key);
      continue;
    }
    knownSubtotalUsd += (resource.demand.inputTokens / 1_000_000) * pricing.inputPerMillion;
    knownSubtotalUsd += (resource.demand.outputTokens / 1_000_000) * pricing.outputPerMillion;
  }
  const subtotal = roundUsd(knownSubtotalUsd);
  return unknownResources.size === 0
    ? { status: "known", valueUsd: subtotal }
    : { status: "unknown", knownSubtotalUsd: subtotal, unknownResources: [...unknownResources].sort() };
}

function normalizeCost(value) {
  if (!isRecord(value)) throw new Error("Resource cost must be an object.");
  if (value.status === "known") {
    assertAllowedKeys(value, "Known resource cost", ["status", "valueUsd"]);
    return { status: "known", valueUsd: nonNegativeNumber(value.valueUsd, "Resource cost valueUsd", false) };
  }
  if (value.status === "unknown") {
    assertAllowedKeys(value, "Unknown resource cost", ["status", "knownSubtotalUsd", "unknownResources"]);
    return {
      status: "unknown",
      knownSubtotalUsd: nonNegativeNumber(value.knownSubtotalUsd, "Resource cost knownSubtotalUsd", false),
      unknownResources: sortedUniqueStrings(value.unknownResources, "Resource cost unknownResources"),
    };
  }
  throw new Error("Resource cost status must be known or unknown.");
}

function typedNumber(value, label, integer) {
  assertAllowedKeys(value, label, TYPED_VALUE_KEYS);
  if (value.status === "unknown") return unknownValue(value, label);
  if (value.status !== "known" || value.reason !== undefined) throw new Error(`${label} must be typed known or unknown.`);
  return {
    status: "known",
    value: nonNegativeNumber(value.value, `${label} value`, integer),
  };
}

function typedTimestamp(value, label) {
  assertAllowedKeys(value, label, TYPED_VALUE_KEYS);
  if (value.status === "unknown") return unknownValue(value, label);
  if (value.status !== "known" || value.reason !== undefined) throw new Error(`${label} must be typed known or unknown.`);
  return { status: "known", value: isoTimestamp(value.value, `${label} value`) };
}

function unknownValue(value, label) {
  if (value.value !== undefined) throw new Error(`${label} unknown value must not include value.`);
  return { status: "unknown", reason: nonEmptyString(value.reason, `${label} reason`) };
}

function noUnexpectedReason(value, label) {
  if (value.reason !== undefined) throw new Error(`${label} must not include reason.`);
  return { status: "available" };
}

function unknownIssue({ unknown, policy, code, blockers, warnings }) {
  if (!unknown) return;
  (policy === "fail_closed" ? blockers : warnings).push(code);
}

function emptyDemand() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, elapsedMs: 0 };
}

function resourceKey(providerId, modelId) {
  return `${providerId}/${modelId}`;
}

function latestObservedAt(observations) {
  return observations.map(observation => observation.adapter.observedAt).sort().at(-1);
}

function earliestResourceExpiry(resources, maxObservationAgeMs) {
  const expiries = resources
    .filter(resource => resource.demand.calls > 0)
    .map(resource => new Date(
      new Date(resource.adapter.observedAt).getTime() + maxObservationAgeMs,
    ).toISOString());
  if (expiries.length === 0) throw new Error("Pending resource workloads require non-zero resource demand.");
  return expiries.sort()[0];
}

function requiredSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256.`);
  }
  return value;
}

function nonNegativeNumber(value, label, integer) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
    throw new Error(`${label} must be a non-negative ${integer ? "integer" : "number"}.`);
  }
  return value;
}

function nonNegativeInteger(value, label) {
  return nonNegativeNumber(value, label, true);
}

function positiveInteger(value, label) {
  const normalized = nonNegativeInteger(value, label);
  if (normalized < 1) throw new Error(`${label} must be positive.`);
  return normalized;
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} is invalid.`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty control-free string.`);
  }
  return value;
}

function evidenceReference(value) {
  const reference = nonEmptyString(value, "adapter evidenceRef");
  if (/[?&](?:api[_-]?key|token|secret|signature)=/i.test(reference)) {
    throw new Error("adapter evidenceRef must not contain credentials.");
  }
  return reference;
}

function isoTimestamp(value, label) {
  const timestamp = nonEmptyString(value, label);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return timestamp;
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sortedUniqueIdentifiers(values, label) {
  const normalized = values.map(value => safeIdentifier(value, label));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${label} must be unique.`);
  return [...normalized].sort();
}

function sortedUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || value.length === 0)) {
    throw new Error(`${label} must contain non-empty strings.`);
  }
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique.`);
  const sorted = [...values].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(values)) throw new Error(`${label} must be sorted.`);
  return sorted;
}

function roundUsd(value) {
  return Number(value.toFixed(12));
}
