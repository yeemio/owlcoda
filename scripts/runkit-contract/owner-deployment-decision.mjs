import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECISION_KEYS = [
  "schemaVersion",
  "decisionId",
  "decisionVersion",
  "provenance",
  "project",
  "supersedesDecisionSha256",
  "deploymentMode",
  "existingProjectAssets",
  "legacyRollbackAllowed",
  "dataAuthority",
  "serviceActivationAuthorized",
  "baselineCutAuthorized",
  "destructiveScope",
  "decisionSha256",
];
const BINDING_KEYS = [
  "decisionId",
  "decisionVersion",
  "decisionSha256",
  "deploymentMode",
  "existingProjectAssets",
  "legacyRollbackAllowed",
  "dataAuthority",
  "serviceActivationAuthorized",
  "baselineCutAuthorized",
  "destructiveScope",
];
const REUSE_FIELDS = [
  "decisionSha256",
  "sourceSha256",
  "targetSha256",
  "artifactSha256",
  "remoteDeploymentIntentSha256",
  "destructive",
  "serviceActivationAuthorized",
  "baselineCutAuthorized",
  "dataAuthoritySha256",
  "rollbackSemanticsSha256",
];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("owner_decision_noncanonical_value");
  return encoded;
}

function hashObject(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function exactKeys(value, expected, code) {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...expected].sort().join(",")
  ) throw new Error(code);
}

function identifier(value, code) {
  if (!ID.test(value ?? "")) throw new Error(code);
  return value;
}

function digest(value, code) {
  if (!SHA256.test(value ?? "")) throw new Error(code);
  return value;
}

function highRisk(condition) {
  if (!condition) throw new Error("owner_decision_high_risk_field_unset");
}

function decisionBody(input) {
  const value = {
    schemaVersion: "OwlCodaRunKitOwnerDeploymentDecisionV1",
    decisionId: input.decisionId,
    decisionVersion: input.decisionVersion,
    provenance: structuredClone(input.provenance),
    project: structuredClone(input.project),
    supersedesDecisionSha256: input.supersedesDecisionSha256,
    deploymentMode: input.deploymentMode,
    existingProjectAssets: input.existingProjectAssets,
    legacyRollbackAllowed: input.legacyRollbackAllowed,
    dataAuthority: structuredClone(input.dataAuthority),
    serviceActivationAuthorized: input.serviceActivationAuthorized,
    baselineCutAuthorized: input.baselineCutAuthorized,
    destructiveScope: Array.isArray(input.destructiveScope)
      ? [...input.destructiveScope]
      : input.destructiveScope,
  };
  identifier(value.decisionId, "owner_decision_id_invalid");
  if (!Number.isInteger(value.decisionVersion) || value.decisionVersion < 1) {
    throw new Error("owner_decision_version_invalid");
  }
  exactKeys(value.provenance, ["kind", "sourceRef", "recordedAt"], "owner_decision_provenance_invalid");
  if (
    value.provenance.kind !== "owner_explicit"
    || typeof value.provenance.sourceRef !== "string"
    || value.provenance.sourceRef.length === 0
    || !Number.isFinite(Date.parse(value.provenance.recordedAt))
  ) throw new Error("owner_decision_provenance_invalid");
  exactKeys(value.project, ["projectId", "scope"], "owner_decision_project_invalid");
  identifier(value.project.projectId, "owner_decision_project_invalid");
  identifier(value.project.scope, "owner_decision_project_invalid");
  if (value.supersedesDecisionSha256 !== null) {
    digest(value.supersedesDecisionSha256, "owner_decision_supersedes_invalid");
  }
  highRisk(new Set(["clean_install", "in_place_update"]).has(value.deploymentMode));
  highRisk(new Set(["preserve", "replace", "remove"]).has(value.existingProjectAssets));
  highRisk(typeof value.legacyRollbackAllowed === "boolean");
  highRisk(value.dataAuthority && typeof value.dataAuthority === "object" && !Array.isArray(value.dataAuthority));
  exactKeys(value.dataAuthority, ["mode", "sourceRef"], "owner_decision_high_risk_field_unset");
  highRisk(new Set([
    "preserve_existing",
    "replace_from_artifact",
    "initialize_new",
  ]).has(value.dataAuthority.mode));
  highRisk(typeof value.dataAuthority.sourceRef === "string" && value.dataAuthority.sourceRef.length > 0);
  highRisk(typeof value.serviceActivationAuthorized === "boolean");
  highRisk(typeof value.baselineCutAuthorized === "boolean");
  highRisk(Array.isArray(value.destructiveScope));
  if (
    value.destructiveScope.some(item => typeof item !== "string" || item.length === 0)
    || new Set(value.destructiveScope).size !== value.destructiveScope.length
  ) throw new Error("owner_decision_destructive_scope_invalid");
  return value;
}

export function createOwnerDeploymentDecisionV1(input) {
  const body = decisionBody(input);
  return { ...body, decisionSha256: hashObject(body) };
}

export function validateOwnerDeploymentDecisionV1(value) {
  exactKeys(value, DECISION_KEYS, "owner_decision_invalid");
  const expected = createOwnerDeploymentDecisionV1(value);
  if (value.decisionSha256 !== expected.decisionSha256) {
    throw new Error("owner_decision_hash_mismatch");
  }
  return expected;
}

export function ownerDeploymentDecisionBindingV1(value) {
  const decision = validateOwnerDeploymentDecisionV1(value);
  return {
    decisionId: decision.decisionId,
    decisionVersion: decision.decisionVersion,
    decisionSha256: decision.decisionSha256,
    deploymentMode: decision.deploymentMode,
    existingProjectAssets: decision.existingProjectAssets,
    legacyRollbackAllowed: decision.legacyRollbackAllowed,
    dataAuthority: structuredClone(decision.dataAuthority),
    serviceActivationAuthorized: decision.serviceActivationAuthorized,
    baselineCutAuthorized: decision.baselineCutAuthorized,
    destructiveScope: [...decision.destructiveScope],
  };
}

export function validateOwnerDeploymentDecisionBindingV1(value) {
  exactKeys(value, BINDING_KEYS, "owner_decision_binding_invalid");
  identifier(value.decisionId, "owner_decision_binding_invalid");
  if (!Number.isInteger(value.decisionVersion) || value.decisionVersion < 1) {
    throw new Error("owner_decision_binding_invalid");
  }
  digest(value.decisionSha256, "owner_decision_binding_invalid");
  highRisk(new Set(["clean_install", "in_place_update"]).has(value.deploymentMode));
  highRisk(new Set(["preserve", "replace", "remove"]).has(value.existingProjectAssets));
  highRisk(typeof value.legacyRollbackAllowed === "boolean");
  highRisk(value.dataAuthority && typeof value.dataAuthority === "object" && !Array.isArray(value.dataAuthority));
  exactKeys(value.dataAuthority, ["mode", "sourceRef"], "owner_decision_binding_invalid");
  highRisk(new Set([
    "preserve_existing",
    "replace_from_artifact",
    "initialize_new",
  ]).has(value.dataAuthority.mode));
  highRisk(typeof value.dataAuthority.sourceRef === "string" && value.dataAuthority.sourceRef.length > 0);
  highRisk(typeof value.serviceActivationAuthorized === "boolean");
  highRisk(typeof value.baselineCutAuthorized === "boolean");
  highRisk(Array.isArray(value.destructiveScope));
  if (
    value.destructiveScope.some(item => typeof item !== "string" || item.length === 0)
    || new Set(value.destructiveScope).size !== value.destructiveScope.length
  ) throw new Error("owner_decision_binding_invalid");
  return structuredClone(value);
}

function compareBinding(conflicts, surface, expected, actual) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    conflicts.push({
      surface,
      field: "ownerDecision",
      decisionValue: expected,
      observedValue: actual ?? null,
    });
    return;
  }
  for (const field of BINDING_KEYS) {
    if (canonicalJson(actual[field]) !== canonicalJson(expected[field])) {
      conflicts.push({
        surface,
        field,
        decisionValue: structuredClone(expected[field]),
        observedValue: actual[field] === undefined
          ? null
          : structuredClone(actual[field]),
      });
    }
  }
}

function conflictError(conflicts) {
  const error = new Error(`owner_decision_conflict:${canonicalJson(conflicts)}`);
  error.code = "owner_decision_conflict";
  error.conflicts = conflicts;
  return error;
}

export function compileOwnerDeploymentDecisionV1(input) {
  const decision = validateOwnerDeploymentDecisionV1(input?.decision);
  const binding = ownerDeploymentDecisionBindingV1(decision);
  const conflicts = [];
  compareBinding(conflicts, "prepareReceipt", binding, input.prepareReceipt?.ownerDecision);
  compareBinding(conflicts, "goal", binding, input.goal?.deployment?.ownerDecision);
  compareBinding(conflicts, "remoteManifest", binding, input.remoteManifest?.ownerDecision);
  const expectedMode = decision.deploymentMode === "clean_install" ? "first" : "update";
  if (input.remoteManifest?.mode !== expectedMode) {
    conflicts.push({
      surface: "remoteManifest",
      field: "deploymentMode",
      decisionValue: decision.deploymentMode,
      observedValue: input.remoteManifest?.mode ?? null,
    });
  }
  for (const [field, decisionValue, observedValue] of [
    [
      "serviceActivationAuthorized",
      decision.serviceActivationAuthorized,
      input.remoteManifest?.serviceActivation,
    ],
    [
      "baselineCutAuthorized",
      decision.baselineCutAuthorized,
      input.remoteManifest?.baselineCut,
    ],
  ]) {
    if (observedValue !== decisionValue) {
      conflicts.push({
        surface: "remoteManifest",
        field,
        decisionValue,
        observedValue: observedValue ?? null,
      });
    }
  }
  const destructive = decision.destructiveScope.length > 0;
  if (input.goal?.authorization?.deploy !== true) {
    conflicts.push({ surface: "goal", field: "deploy", decisionValue: true, observedValue: input.goal?.authorization?.deploy ?? null });
  }
  if (input.goal?.authorization?.destructive !== destructive) {
    conflicts.push({ surface: "goal", field: "destructive", decisionValue: destructive, observedValue: input.goal?.authorization?.destructive ?? null });
  }
  if (input.authority?.permissions?.deploy !== true) {
    conflicts.push({ surface: "authority", field: "deploy", decisionValue: true, observedValue: input.authority?.permissions?.deploy ?? null });
  }
  if (input.authority?.permissions?.destructive !== destructive) {
    conflicts.push({ surface: "authority", field: "destructive", decisionValue: destructive, observedValue: input.authority?.permissions?.destructive ?? null });
  }
  for (const field of ["decisionId", "decisionSha256"]) {
    const authorityField = field === "decisionId" ? "ownerDecisionId" : "ownerDecisionSha256";
    if (input.authority?.[authorityField] !== decision[field]) {
      conflicts.push({ surface: "authority", field, decisionValue: decision[field], observedValue: input.authority?.[authorityField] ?? null });
    }
  }
  for (const [field, observed] of [
    ["targetSha256", input.authority?.targetSha256],
    ["artifactSha256", input.authority?.artifactSha256],
    ["remoteDeploymentIntentSha256", input.authority?.remoteDeploymentIntentSha256],
  ]) {
    if (observed !== input.expected?.[field]) {
      conflicts.push({ surface: "authority", field, decisionValue: input.expected?.[field] ?? null, observedValue: observed ?? null });
    }
  }
  if (input.prepareReceipt?.artifact?.sha256 !== input.expected?.artifactSha256) {
    conflicts.push({ surface: "prepareReceipt", field: "artifactSha256", decisionValue: input.expected?.artifactSha256 ?? null, observedValue: input.prepareReceipt?.artifact?.sha256 ?? null });
  }
  const declaredDestructiveScope = (input.remoteManifest?.deletionAllowlist ?? [])
    .map(entry => entry?.path);
  if (canonicalJson(declaredDestructiveScope) !== canonicalJson(decision.destructiveScope)) {
    conflicts.push({ surface: "remoteManifest", field: "destructiveScope", decisionValue: decision.destructiveScope, observedValue: declaredDestructiveScope });
  }
  if (conflicts.length > 0) throw conflictError(conflicts);
  const body = {
    schemaVersion: "OwlCodaRunKitOwnerDeploymentDecisionCompilationV1",
    status: "compiled",
    decision: binding,
    targetSha256: input.expected.targetSha256,
    artifactSha256: input.expected.artifactSha256,
    remoteDeploymentIntentSha256: input.expected.remoteDeploymentIntentSha256,
    conflicts: [],
    authorizationGranted: false,
  };
  return { ...body, compilationSha256: hashObject(body) };
}

export function classifyOwnerDeploymentAuthorityReuseV1({ existing, requested }) {
  const changedFields = REUSE_FIELDS.filter(field => (
    canonicalJson(existing?.[field]) !== canonicalJson(requested?.[field])
  ));
  return {
    schemaVersion: "OwlCodaRunKitOwnerDeploymentAuthorityReuseV1",
    status: changedFields.length === 0
      ? "reusable_exact"
      : "new_authority_required",
    changedFields,
    authorizationGranted: false,
  };
}

export function classifyDeploymentEvidenceReuseV1({
  fromDecisionSha256,
  toDecisionSha256,
  evidenceKind,
}) {
  digest(fromDecisionSha256, "owner_decision_evidence_source_invalid");
  digest(toDecisionSha256, "owner_decision_evidence_target_invalid");
  const reusable = new Set(["linux_qualification", "source_qualification"]);
  const invalidated = new Set(["rollback_plan", "remote_intent", "owner_authority"]);
  if (!reusable.has(evidenceKind) && !invalidated.has(evidenceKind)) {
    throw new Error("owner_decision_evidence_kind_invalid");
  }
  return {
    schemaVersion: "OwlCodaRunKitDeploymentEvidenceDecisionClassificationV1",
    evidenceKind,
    fromDecisionSha256,
    toDecisionSha256,
    status: fromDecisionSha256 === toDecisionSha256 || reusable.has(evidenceKind)
      ? "reusable_qualification"
      : "invalidated_by_owner_decision",
    authorizationGranted: false,
  };
}

export function createDeploymentSupersessionStatusV1({
  runId,
  priorDecision,
  replacementDecision,
}) {
  identifier(runId, "owner_decision_supersession_run_invalid");
  const prior = priorDecision?.schemaVersion
    === "OwlCodaRunKitOwnerDeploymentDecisionV1"
    ? validateOwnerDeploymentDecisionV1(priorDecision)
    : {
      decisionSha256: digest(
        priorDecision?.decisionSha256,
        "owner_decision_supersession_lineage_invalid",
      ),
    };
  const replacement = validateOwnerDeploymentDecisionV1(replacementDecision);
  if (replacement.supersedesDecisionSha256 !== prior.decisionSha256) {
    throw new Error("owner_decision_supersession_lineage_invalid");
  }
  return {
    schemaVersion: "OwlCodaRunKitDeploymentSupersessionStatusV1",
    runId,
    status: "closed_superseded",
    priorDecisionSha256: prior.decisionSha256,
    replacementDecisionSha256: replacement.decisionSha256,
    businessGoalIncomplete: true,
    replacementPlanRequired: true,
    nextAllowedAction: "plan_replacement_execution",
    authorizationGranted: false,
  };
}
