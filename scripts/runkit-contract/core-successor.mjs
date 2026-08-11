import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  coreIdentityFromSourceRoot,
  currentCoreIdentity,
  initializeProjectRunKit,
  validateExecutionPin,
  validateProjectConfigV2,
} from "./core-contract.mjs";
import { discoverFleet } from "./fleet-discovery.mjs";
import { withControlTransaction } from "./lease-lifecycle.mjs";
import { inspectProjectControlState } from "./project-control-state.mjs";
import {
  freezeSourceCandidateV2,
  materializeSourceCandidateV2,
  verifySourceCandidatePathClosureV2,
  verifySourceCandidateV2,
} from "./source-candidate.mjs";
import {
  ownerAuthorityArtifactSha256V1,
  verifyTrustedOwnerAuthorityV1,
} from "./owner-authority-trust.mjs";

const SHA256_REF = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ARTIFACT_BYTES = 1_048_576;

const REPOSITORY_ACTIONS = Object.freeze({
  stage: false,
  commit: false,
  push: false,
  publish: false,
  deploy: false,
});

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("core_successor_noncanonical_value");
  }
  return encoded;
}

export function coreSuccessorArtifactSha256V1(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new Error(`core_successor_${label}_not_json`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`core_successor_${label}_invalid`);
  }
}

async function canonicalWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("core_successor_controller_workspace_required");
  }
  const requested = path.resolve(workspaceRoot);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("core_successor_controller_workspace_invalid");
  }
  return realpath(requested);
}

function safeRelativePath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || path.isAbsolute(value)
    || value.includes("\\")
    || value.split("/").some(segment => (
      segment.length === 0 || segment === "." || segment === ".."
    ))
  ) {
    throw new Error(`core_successor_${label}_invalid`);
  }
  return value;
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

async function prepareCreateOnlyPath(root, relativePath, existsCode) {
  const safePath = safeRelativePath(relativePath, "artifact_path");
  const absolutePath = path.resolve(root, safePath);
  if (!within(root, absolutePath)) {
    throw new Error("core_successor_artifact_path_escapes_workspace");
  }
  const parent = path.dirname(absolutePath);
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== path.resolve(parent)) {
    throw new Error("core_successor_artifact_parent_symlink_rejected");
  }
  try {
    await lstat(absolutePath);
    throw new Error(existsCode);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { absolutePath, relativePath: safePath };
}

async function readBoundedJson(root, relativePath, label) {
  const safePath = safeRelativePath(relativePath, label);
  const absolutePath = path.resolve(root, safePath);
  if (!within(root, absolutePath)) {
    throw new Error(`core_successor_${label}_escapes_workspace`);
  }
  const stat = await lstat(absolutePath);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.size > MAX_ARTIFACT_BYTES
    || await realpath(absolutePath) !== path.resolve(absolutePath)
  ) {
    throw new Error(`core_successor_${label}_invalid`);
  }
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch {
    throw new Error(`core_successor_${label}_invalid_json`);
  }
}

async function writeCreateOnlyJson(root, relativePath, value, existsCode) {
  const output = await prepareCreateOnlyPath(root, relativePath, existsCode);
  await writeFile(
    output.absolutePath,
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx" },
  );
  return output.relativePath;
}

function assertCoreIdentity(core, label) {
  const gate = validateProjectConfigV2({
    schemaVersion: "OwlCodaRunKitConfigV2",
    core,
    authorizationPolicy: "external_explicit_authority_required",
  });
  if (!gate.valid) throw new Error(`core_successor_${label}_invalid`);
}

function sameCore(left, right) {
  return validateExecutionPin({ expected: left, actual: right }).status === "valid";
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function readWorkspaceArtifact(workspaceRoot, relativePath, label) {
  const root = await canonicalWorkspaceRoot(workspaceRoot);
  const safePath = safeRelativePath(relativePath, label);
  const absolutePath = path.resolve(root, safePath);
  if (!within(root, absolutePath)) {
    throw new Error(`core_successor_${label}_escapes_workspace`);
  }
  const stat = await lstat(absolutePath);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || stat.size > MAX_ARTIFACT_BYTES
    || await realpath(absolutePath) !== path.resolve(absolutePath)
  ) {
    throw new Error(`core_successor_${label}_invalid`);
  }
  const bytes = await readFile(absolutePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`core_successor_${label}_invalid_json`);
  }
  return {
    relativePath: safePath,
    bytes,
    sha256: sha256Bytes(bytes),
    value,
  };
}

function receiptAttemptPath(basePath, attemptNumber) {
  const extension = path.extname(basePath);
  const stem = extension.length > 0
    ? basePath.slice(0, -extension.length)
    : basePath;
  return attemptNumber === 1
    ? basePath
    : `${stem}-attempt-${String(attemptNumber).padStart(3, "0")}${extension}`;
}

function projectSuccessReceiptPath(basePath, receiptId, workspaceRoot) {
  const extension = path.extname(basePath);
  const stem = path.basename(
    extension.length > 0
      ? basePath.slice(0, -extension.length)
      : basePath,
  );
  const workspaceSha256 = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex");
  return path.join(
    path.dirname(basePath),
    `${stem}-project-success`,
    `${receiptId}-${workspaceSha256}.json`,
  );
}

async function pathExists(absolutePath) {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function coreBindingSetSha256(bindings) {
  return coreSuccessorArtifactSha256V1(bindings);
}

function normalizedFleetCoreBindings(fleetDiscovery, bindings) {
  if (
    !Array.isArray(bindings)
    || bindings.length !== fleetDiscovery.workspaceRoots.length
  ) {
    throw new Error("core_successor_fleet_core_bindings_invalid");
  }
  const byWorkspace = new Map();
  for (const binding of bindings) {
    if (
      !binding
      || typeof binding.workspaceRoot !== "string"
      || byWorkspace.has(binding.workspaceRoot)
    ) {
      throw new Error("core_successor_fleet_core_bindings_invalid");
    }
    assertCoreIdentity(binding.fromCore, "fleet_from_core");
    byWorkspace.set(binding.workspaceRoot, {
      workspaceRoot: binding.workspaceRoot,
      fromCore: cloneJson(binding.fromCore, "fleet_from_core"),
    });
  }
  const ordered = fleetDiscovery.workspaceRoots.map((workspaceRoot) => {
    const binding = byWorkspace.get(workspaceRoot);
    if (!binding) throw new Error("core_successor_fleet_core_bindings_invalid");
    return binding;
  });
  return ordered;
}

function uniformFromCore(bindings) {
  const [first] = bindings;
  return first && bindings.every(binding => sameCore(binding.fromCore, first.fromCore))
    ? cloneJson(first.fromCore, "from_core")
    : null;
}

function assertCompleteFleetDiscovery(discovery) {
  if (
    discovery?.schemaVersion !== "OwlCodaRunKitFleetDiscoveryV1"
    || discovery.authorizationGranted !== false
    || discovery.complete !== true
    || !Array.isArray(discovery.workspaceRoots)
    || discovery.workspaceRoots.length === 0
    || !Array.isArray(discovery.unreachableRoots)
    || discovery.unreachableRoots.length !== 0
    || !SHA256_REF.test(discovery.frozenManifestSha256)
  ) {
    throw new Error("core_successor_fleet_incomplete");
  }
}

function assertSourceCandidateBinding(frozen, verified) {
  if (
    frozen?.status !== "source_candidate_frozen"
    || frozen.authorizationGranted !== false
    || typeof frozen.candidatePath !== "string"
    || !SHA256_REF.test(frozen.candidateSha256)
    || verified?.status !== "valid"
    || verified.authorizationGranted !== false
    || verified.candidatePath !== frozen.candidatePath
    || verified.candidateSha256 !== frozen.candidateSha256
  ) {
    throw new Error("core_successor_source_candidate_invalid");
  }
}

function planBody({
  planId,
  fleetCoreBindings,
  toCore,
  sourceCandidate,
  fleetDiscoveryRequest,
  fleetDiscovery,
}) {
  const fromCore = uniformFromCore(fleetCoreBindings);
  return {
    schemaVersion: "OwlCodaRunKitCoreSuccessorPlanV1",
    planId,
    status: "frozen",
    fromCore,
    fromCoreMode: fromCore === null ? "per_project" : "uniform",
    fromCoreSetSha256: coreBindingSetSha256(fleetCoreBindings),
    fleetCoreBindings: cloneJson(fleetCoreBindings, "fleet_core_bindings"),
    toCore: cloneJson(toCore, "to_core"),
    sourceCandidate: {
      candidatePath: sourceCandidate.candidatePath,
      candidateSha256: sourceCandidate.candidateSha256,
      sourceFingerprint: sourceCandidate.sourceFingerprint,
      ...(sourceCandidate.deliveryPacketPath
        ? { deliveryPacketPath: sourceCandidate.deliveryPacketPath }
        : {}),
      pathClosure: cloneJson(sourceCandidate.pathClosure, "path_closure"),
      materializationProof: cloneJson(
        sourceCandidate.materializationProof,
        "materialization_proof",
      ),
    },
    fleetDiscoveryRequest: cloneJson(
      fleetDiscoveryRequest,
      "fleet_discovery_request",
    ),
    fleetDiscovery: cloneJson(fleetDiscovery, "fleet_discovery"),
    migrationContract: {
      completeFleetRequired: true,
      globalPreflightBeforeWrites: true,
      ownerMigrationAuthorityRequired: true,
      migrationScope: "project_runkit_config_and_local_migration_receipt_only",
      projectOrder: "canonical_workspace_root",
    },
    repositoryActions: { ...REPOSITORY_ACTIONS },
    authorizationGranted: false,
  };
}

function validatePlan(plan) {
  if (
    plan?.schemaVersion !== "OwlCodaRunKitCoreSuccessorPlanV1"
    || plan.status !== "frozen"
    || plan.authorizationGranted !== false
    || !SHA256_REF.test(plan.planSha256)
    || coreSuccessorArtifactSha256V1((({ planSha256, ...body }) => body)(plan))
      !== plan.planSha256
    || plan.migrationContract?.completeFleetRequired !== true
    || plan.migrationContract?.globalPreflightBeforeWrites !== true
    || plan.migrationContract?.ownerMigrationAuthorityRequired !== true
    || JSON.stringify(plan.repositoryActions) !== JSON.stringify(REPOSITORY_ACTIONS)
  ) {
    throw new Error("core_successor_plan_invalid");
  }
  assertIdentifier(plan.planId, "plan_id");
  assertCoreIdentity(plan.toCore, "to_core");
  const bindings = normalizedFleetCoreBindings(
    plan.fleetDiscovery,
    plan.fleetCoreBindings,
  );
  const expectedUniform = uniformFromCore(bindings);
  if (
    plan.fromCoreMode !== (expectedUniform === null ? "per_project" : "uniform")
    || (
      expectedUniform === null
        ? plan.fromCore !== null
        : !sameCore(plan.fromCore, expectedUniform)
    )
    || plan.fromCoreSetSha256 !== coreBindingSetSha256(bindings)
  ) {
    throw new Error("core_successor_fleet_core_bindings_invalid");
  }
  if (bindings.some(binding => sameCore(binding.fromCore, plan.toCore))) {
    throw new Error("core_successor_core_transition_required");
  }
  assertCompleteFleetDiscovery(plan.fleetDiscovery);
  if (
    typeof plan.sourceCandidate?.candidatePath !== "string"
    || !SHA256_REF.test(plan.sourceCandidate?.candidateSha256)
    || plan.sourceCandidate?.pathClosure?.status !== "valid"
    || !SHA256_REF.test(plan.sourceCandidate?.pathClosure?.closureSha256)
    || plan.sourceCandidate?.materializationProof?.matchesToCore !== true
    || !sameCore(
      plan.sourceCandidate?.materializationProof?.materializedCore,
      plan.toCore,
    )
  ) {
    throw new Error("core_successor_plan_source_candidate_invalid");
  }
}

function validateOwnerAuthority(authority, plan) {
  if (authority?.schemaVersion === "OwlCodaRunKitOwnerMigrationAuthorityV1") {
    throw new Error("core_successor_owner_authority_untrusted");
  }
  if (
    authority?.schemaVersion !== "OwlCodaRunKitOwnerMigrationAuthorityV2"
    || typeof authority.authorityId !== "string"
    || authority.authorityId.length === 0
    || authority.decision !== "approved"
    || authority.scope !== "migrate_declared_core_successor_fleet"
    || authority.planSha256 !== plan.planSha256
    || authority.fromCoreSetSha256 !== plan.fromCoreSetSha256
    || authority.toCoreManifestSha256 !== plan.toCore.coreManifestSha256
    || authority.fleetManifestSha256
      !== plan.fleetDiscovery.frozenManifestSha256
    || authority.authorizationGranted !== false
    || typeof authority.signerKeyId !== "string"
    || authority.signerKeyId.length === 0
    || authority.signatureAlgorithm !== "ed25519"
    || typeof authority.signature !== "string"
    || authority.signature.length === 0
    || !SHA256_REF.test(authority.authoritySha256)
    || ownerAuthorityArtifactSha256V1(authority) !== authority.authoritySha256
  ) {
    throw new Error("core_successor_owner_authority_invalid");
  }
}

function defaultDependencies(overrides = {}) {
  return {
    discoverFleet,
    freezeSourceCandidate: freezeSourceCandidateV2,
    verifySourceCandidate: verifySourceCandidateV2,
    verifySourceCandidatePathClosure: verifySourceCandidatePathClosureV2,
    materializeSourceCandidate: materializeSourceCandidateV2,
    materializedCoreIdentity: coreIdentityFromSourceRoot,
    async createMaterializationWorkspace({ sourceRoot }) {
      const scratch = await mkdtemp(path.join(tmpdir(), "owlrunkit-core-successor-"));
      const workspaceRoot = path.join(scratch, "materialized");
      const cloned = spawnSync(
        "git",
        ["clone", "--quiet", "--no-hardlinks", sourceRoot, workspaceRoot],
        { encoding: "utf8" },
      );
      if (cloned.error) throw cloned.error;
      if (cloned.status !== 0) {
        await rm(scratch, { recursive: true, force: true });
        throw new Error("core_successor_materialization_clone_failed");
      }
      return {
        workspaceRoot,
        async cleanup() {
          await rm(scratch, { recursive: true, force: true });
        },
      };
    },
    inspectProjectControlState,
    runtimeCoreIdentity: currentCoreIdentity,
    verifyOwnerAuthority: ({ authority }) => verifyTrustedOwnerAuthorityV1({
      authority,
      expectedScope: "migrate_declared_core_successor_fleet",
      expectedPurpose: "core_successor",
    }),
    migrateWorkspace: ({ workspaceRoot }) => initializeProjectRunKit({
      workspaceRoot,
    }),
    ...overrides,
  };
}

function withFleetControlTransactions(workspaceRoots, operation, index = 0) {
  if (index >= workspaceRoots.length) return operation();
  return withControlTransaction(
    workspaceRoots[index],
    () => withFleetControlTransactions(workspaceRoots, operation, index + 1),
  );
}

async function proveMaterializedSourceCandidate({
  root,
  frozen,
  toCore,
  dependencies,
}) {
  if (
    !Array.isArray(frozen.ownedPaths)
    || frozen.ownedPaths.length === 0
  ) {
    throw new Error("core_successor_source_candidate_owned_paths_missing");
  }
  const pathClosure = await dependencies.verifySourceCandidatePathClosure({
    workspaceRoot: root,
    candidatePath: frozen.candidatePath,
    includedPaths: frozen.ownedPaths,
  });
  if (
    pathClosure?.status !== "valid"
    || pathClosure.authorizationGranted !== false
    || !SHA256_REF.test(pathClosure.closureSha256)
  ) {
    throw new Error("core_successor_source_candidate_path_closure_invalid");
  }
  const scratch = await dependencies.createMaterializationWorkspace({
    sourceRoot: root,
  });
  const materializedRoot = scratch.workspaceRoot;
  try {
    const materialized = await dependencies.materializeSourceCandidate({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      targetWorkspaceRoot: materializedRoot,
    });
    if (
      materialized?.status !== "source_candidate_materialized"
      || materialized.authorizationGranted !== false
      || materialized.candidateSha256 !== frozen.candidateSha256
    ) {
      throw new Error("core_successor_source_candidate_materialization_invalid");
    }
    const materializedCore = await dependencies.materializedCoreIdentity(
      materializedRoot,
    );
    assertCoreIdentity(materializedCore, "materialized_core");
    if (!sameCore(materializedCore, toCore)) {
      throw new Error("core_successor_materialized_core_identity_mismatch");
    }
    return {
      pathClosure: cloneJson(pathClosure, "path_closure"),
      materializationProof: {
        candidateSha256: frozen.candidateSha256,
        payloadSha256: materialized.payloadSha256,
        materializedCore: cloneJson(materializedCore, "materialized_core"),
        matchesToCore: true,
      },
    };
  } finally {
    await scratch.cleanup();
  }
}

export async function createCoreSuccessorPlanV1({
  controllerWorkspaceRoot,
  planId,
  planPath = null,
  fromCore,
  fleetCoreBindings = null,
  toCore,
  sourceCandidateRequest,
  fleetDiscoveryRequest,
  dependencies: dependencyOverrides = {},
} = {}) {
  assertIdentifier(planId, "plan_id");
  if (fleetCoreBindings === null) assertCoreIdentity(fromCore, "from_core");
  assertCoreIdentity(toCore, "to_core");
  if (fleetCoreBindings === null && sameCore(fromCore, toCore)) {
    throw new Error("core_successor_core_transition_required");
  }
  const root = await canonicalWorkspaceRoot(controllerWorkspaceRoot);
  const selectedPlanPath = planPath
    ?? `.owlcoda/runkit/core-successors/${planId}/plan.json`;
  await prepareCreateOnlyPath(
    root,
    selectedPlanPath,
    "core_successor_plan_exists",
  );
  const dependencies = defaultDependencies(dependencyOverrides);
  const discoveryRequest = cloneJson(
    fleetDiscoveryRequest,
    "fleet_discovery_request",
  );
  const fleetDiscovery = await dependencies.discoverFleet(discoveryRequest);
  assertCompleteFleetDiscovery(fleetDiscovery);
  const bindings = normalizedFleetCoreBindings(
    fleetDiscovery,
    fleetCoreBindings ?? fleetDiscovery.workspaceRoots.map(workspaceRoot => ({
      workspaceRoot,
      fromCore,
    })),
  );
  if (bindings.some(binding => sameCore(binding.fromCore, toCore))) {
    throw new Error("core_successor_core_transition_required");
  }
  const frozen = await dependencies.freezeSourceCandidate({
    workspaceRoot: root,
    ...sourceCandidateRequest,
  });
  const verified = await dependencies.verifySourceCandidate({
    workspaceRoot: root,
    candidatePath: frozen.candidatePath,
  });
  assertSourceCandidateBinding(frozen, verified);
  const proof = await proveMaterializedSourceCandidate({
    root,
    frozen,
    toCore,
    dependencies,
  });
  const body = planBody({
    planId,
    fleetCoreBindings: bindings,
    toCore,
    sourceCandidate: {
      ...frozen,
      ...proof,
    },
    fleetDiscoveryRequest: discoveryRequest,
    fleetDiscovery,
  });
  const plan = {
    ...body,
    planSha256: coreSuccessorArtifactSha256V1(body),
  };
  const writtenPath = await writeCreateOnlyJson(
    root,
    selectedPlanPath,
    plan,
    "core_successor_plan_exists",
  );
  return {
    status: "core_successor_plan_created",
    exitCode: 0,
    planId,
    planPath: writtenPath,
    planSha256: plan.planSha256,
    sourceCandidateSha256: frozen.candidateSha256,
    fromCoreMode: body.fromCoreMode,
    fromCoreSetSha256: body.fromCoreSetSha256,
    fleetManifestSha256: fleetDiscovery.frozenManifestSha256,
    fleetSize: fleetDiscovery.workspaceRoots.length,
    authorizationGranted: false,
  };
}

export async function createCoreSuccessorPlanFromFleetV1({
  controllerWorkspaceRoot,
  planId,
  planPath = null,
  sourceCandidateRequest,
  fleetDiscoveryRequest,
  dependencies: dependencyOverrides = {},
} = {}) {
  const dependencies = defaultDependencies(dependencyOverrides);
  const discoveryRequest = cloneJson(
    fleetDiscoveryRequest,
    "fleet_discovery_request",
  );
  const fleetDiscovery = await dependencies.discoverFleet(discoveryRequest);
  assertCompleteFleetDiscovery(fleetDiscovery);
  const fleetCores = [];
  for (const workspaceRoot of fleetDiscovery.workspaceRoots) {
    const config = await readWorkspaceConfig(workspaceRoot);
    const configGate = validateProjectConfigV2(config);
    if (!configGate.valid) {
      throw new Error("core_successor_fleet_config_invalid");
    }
    fleetCores.push({
      workspaceRoot,
      fromCore: config.core,
    });
  }
  if (fleetCores.length === 0) throw new Error("core_successor_fleet_incomplete");
  const toCore = await dependencies.runtimeCoreIdentity();
  assertCoreIdentity(toCore, "to_core");
  const created = await createCoreSuccessorPlanV1({
    controllerWorkspaceRoot,
    planId,
    planPath,
    fleetCoreBindings: fleetCores,
    toCore,
    sourceCandidateRequest,
    fleetDiscoveryRequest: discoveryRequest,
    dependencies: {
      ...dependencyOverrides,
      discoverFleet: async () => cloneJson(
        fleetDiscovery,
        "fleet_discovery",
      ),
    },
  });
  return {
    ...created,
    fromCore: uniformFromCore(fleetCores),
    fromCoreMode: uniformFromCore(fleetCores) === null ? "per_project" : "uniform",
    fromCoreSetSha256: coreBindingSetSha256(fleetCores),
    toCore: cloneJson(toCore, "to_core"),
  };
}

async function readWorkspaceConfig(workspaceRoot) {
  const root = await canonicalWorkspaceRoot(workspaceRoot);
  const configPath = path.join(root, ".owlcoda/runkit/config.json");
  try {
    const stat = await lstat(configPath);
    if (
      stat.isSymbolicLink()
      || !stat.isFile()
      || stat.size > MAX_ARTIFACT_BYTES
      || await realpath(configPath) !== path.resolve(configPath)
    ) {
      throw new Error("invalid");
    }
    return JSON.parse(await readFile(configPath, "utf8"));
  } catch {
    throw new Error("core_successor_project_config_invalid");
  }
}

function discoveryMatchesPlan(current, frozen) {
  return current?.complete === true
    && current.authorizationGranted === false
    && current.frozenManifestSha256 === frozen.frozenManifestSha256
    && JSON.stringify(current.workspaceRoots) === JSON.stringify(frozen.workspaceRoots)
    && JSON.stringify(current.coverageRoots) === JSON.stringify(frozen.coverageRoots)
    && JSON.stringify(current.unreachableRoots) === JSON.stringify(
      frozen.unreachableRoots,
    );
}

async function preflightWorkspace({
  workspaceRoot,
  fromCore,
  toCore,
  successEvidence,
  inspectControl,
}) {
  const issueCodes = [];
  let config;
  let controlCore = fromCore;
  try {
    config = await readWorkspaceConfig(workspaceRoot);
    const configGate = validateProjectConfigV2(config);
    if (!configGate.valid) issueCodes.push("project_config_invalid");
    if (configGate.valid) {
      if (sameCore(config.core, fromCore)) {
        if (successEvidence) {
          issueCodes.push("project_success_receipt_config_drift");
        }
      } else if (sameCore(config.core, toCore)) {
        controlCore = toCore;
        if (!successEvidence) {
          issueCodes.push("project_target_core_without_success_receipt");
        }
      } else {
        issueCodes.push("project_core_drift");
      }
    }
  } catch {
    issueCodes.push("project_config_missing_or_invalid");
  }
  try {
    const control = await inspectControl({
      workspaceRoot,
      currentCore: controlCore,
    });
    if (control?.upgradeSafety?.status !== "safe") {
      issueCodes.push("project_control_unsafe");
    }
  } catch {
    issueCodes.push("project_control_unreadable");
  }
  const uniqueIssues = [...new Set(issueCodes)].sort();
  return {
    workspaceRoot,
    fromCore: cloneJson(fromCore, "project_from_core"),
    status: uniqueIssues.includes("project_core_drift")
      ? "core_drift"
      : uniqueIssues.length > 0
        ? "unsafe"
        : successEvidence
          ? "already_migrated"
          : "safe",
    issueCodes: uniqueIssues,
    migrationAttempted: false,
    ...(successEvidence
      ? {
          projectSuccessReceiptPath: successEvidence.receiptPath,
          projectSuccessReceiptSha256: successEvidence.receiptSha256,
        }
      : {}),
  };
}

function batchReceiptBody({
  plan,
  ownerAuthority,
  trustedAuthority,
  receiptId,
  status,
  projects,
  migrationAttempted,
  attemptNumber,
  receiptBasePath,
  priorAttemptReceiptPath,
  priorAttemptReceiptSha256,
  projectSuccessReceipts,
  orphanRecovery = false,
  orphanSuccessReceiptCount = 0,
}) {
  return {
    schemaVersion: "OwlCodaRunKitCoreSuccessorBatchReceiptV1",
    receiptId,
    attemptNumber,
    receiptBasePath,
    priorAttemptReceiptPath,
    priorAttemptReceiptSha256,
    planId: plan.planId,
    planSha256: plan.planSha256,
    ownerAuthorityId: ownerAuthority.authorityId,
    ownerAuthoritySha256: ownerAuthority.authoritySha256,
    ownerAuthoritySignerKeyId: trustedAuthority.signerKeyId,
    ownerAuthorityTrustStoreSha256: trustedAuthority.trustStoreSha256,
    fromCore: cloneJson(plan.fromCore, "from_core"),
    fromCoreMode: plan.fromCoreMode,
    fromCoreSetSha256: plan.fromCoreSetSha256,
    fleetCoreBindings: cloneJson(
      plan.fleetCoreBindings,
      "fleet_core_bindings",
    ),
    toCore: cloneJson(plan.toCore, "to_core"),
    fleetManifestSha256: plan.fleetDiscovery.frozenManifestSha256,
    sourceCandidateSha256: plan.sourceCandidate.candidateSha256,
    status,
    migrationAttempted,
    migratedCount: projectSuccessReceipts.length,
    projectCount: projects.length,
    orphanRecovery,
    orphanSuccessReceiptCount,
    projects: cloneJson(projects, "project_results"),
    projectSuccessReceipts: cloneJson(
      projectSuccessReceipts,
      "project_success_receipts",
    ),
    repositoryActions: { ...REPOSITORY_ACTIONS },
    authorizationGranted: false,
  };
}

async function persistBatchReceipt({
  root,
  receiptPath,
  plan,
  ownerAuthority,
  trustedAuthority,
  receiptId,
  status,
  projects,
  migrationAttempted,
  attemptNumber,
  receiptBasePath,
  priorAttemptReceiptPath,
  priorAttemptReceiptSha256,
  projectSuccessReceipts,
  orphanRecovery = false,
  orphanSuccessReceiptCount = 0,
}) {
  const body = batchReceiptBody({
    plan,
    ownerAuthority,
    trustedAuthority,
    receiptId,
    status,
    projects,
    migrationAttempted,
    attemptNumber,
    receiptBasePath,
    priorAttemptReceiptPath,
    priorAttemptReceiptSha256,
    projectSuccessReceipts,
    orphanRecovery,
    orphanSuccessReceiptCount,
  });
  const receipt = {
    ...body,
    receiptSha256: coreSuccessorArtifactSha256V1(body),
  };
  const writtenPath = await writeCreateOnlyJson(
    root,
    receiptPath,
    receipt,
    "core_successor_receipt_exists",
  );
  return {
    status,
    exitCode: status === "applied" ? 0 : 2,
    receiptId,
    attemptNumber,
    receiptPath: writtenPath,
    receiptSha256: receipt.receiptSha256,
    projectCount: projects.length,
    migratedCount: receipt.migratedCount,
    authorizationGranted: false,
  };
}

function assertTrustedAuthority(trustedAuthority, ownerAuthority) {
  if (
    trustedAuthority?.status !== "trusted"
    || trustedAuthority.signerKeyId !== ownerAuthority.signerKeyId
    || trustedAuthority.authoritySha256 !== ownerAuthority.authoritySha256
  ) {
    throw new Error("core_successor_owner_authority_untrusted");
  }
}

function assertBatchReceiptSelfHash(receipt) {
  if (
    !SHA256_REF.test(receipt?.receiptSha256)
    || coreSuccessorArtifactSha256V1(
      (({ receiptSha256, ...body }) => body)(receipt),
    ) !== receipt.receiptSha256
  ) {
    throw new Error("core_successor_prior_attempt_receipt_invalid");
  }
}

function validatePriorPartialReceipt({
  receipt,
  receiptPath,
  plan,
  ownerAuthority,
}) {
  assertBatchReceiptSelfHash(receipt);
  if (
    receipt.schemaVersion !== "OwlCodaRunKitCoreSuccessorBatchReceiptV1"
    || receipt.status !== "partial_failure"
    || receipt.planId !== plan.planId
    || receipt.planSha256 !== plan.planSha256
    || receipt.ownerAuthorityId !== ownerAuthority.authorityId
    || receipt.ownerAuthoritySha256 !== ownerAuthority.authoritySha256
    || receipt.fromCoreSetSha256 !== plan.fromCoreSetSha256
    || receipt.fleetManifestSha256
      !== plan.fleetDiscovery.frozenManifestSha256
    || receipt.sourceCandidateSha256
      !== plan.sourceCandidate.candidateSha256
    || !sameCore(receipt.toCore, plan.toCore)
    || !Number.isInteger(receipt.attemptNumber)
    || receipt.attemptNumber < 1
    || typeof receipt.receiptBasePath !== "string"
    || receiptAttemptPath(
      receipt.receiptBasePath,
      receipt.attemptNumber,
    ) !== receiptPath
    || (
      receipt.attemptNumber === 1
        ? receipt.priorAttemptReceiptPath !== null
          || receipt.priorAttemptReceiptSha256 !== null
        : typeof receipt.priorAttemptReceiptPath !== "string"
          || !SHA256_REF.test(receipt.priorAttemptReceiptSha256)
          || receipt.priorAttemptReceiptPath !== receiptAttemptPath(
            receipt.receiptBasePath,
            receipt.attemptNumber - 1,
          )
    )
    || !Array.isArray(receipt.projects)
    || receipt.projects.length !== plan.fleetDiscovery.workspaceRoots.length
    || !Array.isArray(receipt.projectSuccessReceipts)
    || receipt.projectCount !== receipt.projects.length
    || receipt.migratedCount !== receipt.projectSuccessReceipts.length
    || typeof receipt.orphanRecovery !== "boolean"
    || !Number.isInteger(receipt.orphanSuccessReceiptCount)
    || receipt.orphanSuccessReceiptCount < 0
    || receipt.orphanSuccessReceiptCount > receipt.projectSuccessReceipts.length
    || receipt.orphanRecovery !== (receipt.orphanSuccessReceiptCount > 0)
    || receipt.migrationAttempted !== true
    || JSON.stringify(receipt.repositoryActions)
      !== JSON.stringify(REPOSITORY_ACTIONS)
    || receipt.authorizationGranted !== false
  ) {
    throw new Error("core_successor_prior_attempt_receipt_invalid");
  }
  const orderedRoots = receipt.projects.map(row => row.workspaceRoot);
  if (
    JSON.stringify(orderedRoots)
      !== JSON.stringify(plan.fleetDiscovery.workspaceRoots)
  ) {
    throw new Error("core_successor_prior_attempt_project_order_invalid");
  }
  let failureSeen = false;
  const successRoots = [];
  for (const row of receipt.projects) {
    const binding = plan.fleetCoreBindings.find(
      candidate => candidate.workspaceRoot === row.workspaceRoot,
    );
    if (!binding || !sameCore(row.fromCore, binding.fromCore)) {
      throw new Error("core_successor_prior_attempt_receipt_invalid");
    }
    if (
      row.status === "migrated"
      || row.status === "skipped_as_already_migrated"
    ) {
      if (failureSeen) {
        throw new Error("core_successor_prior_attempt_project_order_invalid");
      }
      successRoots.push(row.workspaceRoot);
    } else if (row.status === "migration_failed") {
      if (failureSeen) {
        throw new Error("core_successor_prior_attempt_project_order_invalid");
      }
      failureSeen = true;
    } else if (row.status !== "not_attempted_after_failure" || !failureSeen) {
      throw new Error("core_successor_prior_attempt_project_order_invalid");
    }
  }
  if (!failureSeen) {
    throw new Error("core_successor_prior_attempt_receipt_invalid");
  }
  const successRefRoots = receipt.projectSuccessReceipts.map(
    row => row.workspaceRoot,
  );
  if (
    new Set(successRefRoots).size !== successRefRoots.length
    || JSON.stringify(successRefRoots) !== JSON.stringify(successRoots)
    || receipt.projectSuccessReceipts.some(reference => (
      reference.receiptBasePath !== receipt.receiptBasePath
      || reference.receiptPath !== projectSuccessReceiptPath(
        receipt.receiptBasePath,
        receipt.receiptId,
        reference.workspaceRoot,
      )
    ))
  ) {
    throw new Error("core_successor_prior_attempt_success_set_invalid");
  }
}

async function validatePriorAttemptLineage({
  root,
  receipt,
  receiptPath,
  plan,
  ownerAuthority,
}) {
  let current = receipt;
  let currentPath = receiptPath;
  for (;;) {
    validatePriorPartialReceipt({
      receipt: current,
      receiptPath: currentPath,
      plan,
      ownerAuthority,
    });
    if (current.attemptNumber === 1) return;
    const parent = await readBoundedJson(
      root,
      current.priorAttemptReceiptPath,
      "prior_attempt_receipt_path",
    );
    if (
      parent.receiptSha256 !== current.priorAttemptReceiptSha256
      || parent.attemptNumber !== current.attemptNumber - 1
    ) {
      throw new Error("core_successor_prior_attempt_lineage_invalid");
    }
    current = parent;
    currentPath = current.priorAttemptReceiptPath
      ? receiptAttemptPath(
          current.receiptBasePath,
          current.attemptNumber,
        )
      : current.receiptBasePath;
  }
}

async function assertNoResumeBranch({
  root,
  priorReceipt,
}) {
  const basePath = safeRelativePath(
    priorReceipt.receiptBasePath,
    "receipt_base_path",
  );
  const directoryPath = path.resolve(root, path.dirname(basePath));
  const extension = path.extname(basePath);
  const baseName = path.basename(
    extension.length > 0
      ? basePath.slice(0, -extension.length)
      : basePath,
  );
  const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `^${escapedBase}-attempt-(\\d{3,})${extension.replace(
      /[.*+?^${}()|[\]\\]/gu,
      "\\$&",
    )}$`,
    "u",
  );
  let entries = [];
  try {
    entries = await readdir(directoryPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match && Number(match[1]) > priorReceipt.attemptNumber) {
      throw new Error("core_successor_resume_branch_exists");
    }
  }
}

async function validateProjectSuccessEvidence({
  root,
  reference,
  plan,
  ownerAuthority,
  receiptId,
  receiptBasePath,
  maximumAttemptNumber,
  expectedAttemptNumber = null,
  expectedPriorAttemptReceiptSha256 = undefined,
}) {
  if (
    !reference
    || typeof reference.workspaceRoot !== "string"
    || typeof reference.receiptPath !== "string"
    || !SHA256_REF.test(reference.receiptSha256)
    || reference.receiptBasePath !== receiptBasePath
    || reference.receiptPath !== projectSuccessReceiptPath(
      receiptBasePath,
      receiptId,
      reference.workspaceRoot,
    )
  ) {
    throw new Error("core_successor_project_success_receipt_invalid");
  }
  const receipt = await readBoundedJson(
    root,
    reference.receiptPath,
    "project_success_receipt_path",
  );
  if (
    receipt.receiptSha256 !== reference.receiptSha256
    || !SHA256_REF.test(receipt.receiptSha256)
    || coreSuccessorArtifactSha256V1(
      (({ receiptSha256, ...body }) => body)(receipt),
    ) !== receipt.receiptSha256
    || receipt.schemaVersion
      !== "OwlCodaRunKitCoreSuccessorProjectSuccessReceiptV1"
    || receipt.receiptId !== receiptId
    || receipt.workspaceRoot !== reference.workspaceRoot
    || receipt.planSha256 !== plan.planSha256
    || receipt.ownerAuthoritySha256 !== ownerAuthority.authoritySha256
    || receipt.fleetManifestSha256
      !== plan.fleetDiscovery.frozenManifestSha256
    || !sameCore(receipt.fromCore, plan.fleetCoreBindings.find(
      row => row.workspaceRoot === receipt.workspaceRoot,
    )?.fromCore)
    || !sameCore(receipt.toCore, plan.toCore)
    || !Number.isInteger(receipt.attemptNumber)
    || receipt.attemptNumber < 1
    || receipt.attemptNumber > maximumAttemptNumber
    || (
      expectedAttemptNumber !== null
      && receipt.attemptNumber !== expectedAttemptNumber
    )
    || (
      expectedPriorAttemptReceiptSha256 !== undefined
      && receipt.priorAttemptReceiptSha256
        !== expectedPriorAttemptReceiptSha256
    )
    || (
      receipt.attemptNumber === 1
        ? receipt.priorAttemptReceiptSha256 !== null
        : !SHA256_REF.test(receipt.priorAttemptReceiptSha256)
    )
    || JSON.stringify(receipt.repositoryActions)
      !== JSON.stringify(REPOSITORY_ACTIONS)
    || receipt.authorizationGranted !== false
  ) {
    throw new Error("core_successor_project_success_receipt_invalid");
  }
  const configArtifact = await readWorkspaceArtifact(
    receipt.workspaceRoot,
    ".owlcoda/runkit/config.json",
    "post_config",
  );
  const configGate = validateProjectConfigV2(configArtifact.value);
  const migrationArtifact = await readWorkspaceArtifact(
    receipt.workspaceRoot,
    receipt.migrationReceiptPath,
    "migration_receipt",
  );
  if (
    !configGate.valid
    || !sameCore(configArtifact.value.core, plan.toCore)
    || configArtifact.sha256 !== receipt.postConfigSha256
    || migrationArtifact.sha256 !== receipt.migrationReceiptSha256
    || migrationArtifact.value?.schemaVersion
      !== "OwlCodaRunKitConfigMigrationReceiptV1"
    || !sameCore(migrationArtifact.value.fromCore, receipt.fromCore)
    || !sameCore(migrationArtifact.value.toCore, receipt.toCore)
    || migrationArtifact.value.authorizationGranted !== false
  ) {
    throw new Error("core_successor_project_success_evidence_drift");
  }
  return {
    ...reference,
    receipt,
  };
}

function orderProjectSuccessReferences(plan, references) {
  const byRoot = new Map(
    references.map(reference => [reference.workspaceRoot, reference]),
  );
  return plan.fleetDiscovery.workspaceRoots
    .filter(workspaceRoot => byRoot.has(workspaceRoot))
    .map(workspaceRoot => byRoot.get(workspaceRoot));
}

async function discoverOrphanProjectSuccessEvidence({
  root,
  plan,
  ownerAuthority,
  receiptId,
  receiptBasePath,
  attemptNumber,
  priorAttemptReceiptSha256,
  existingReferences,
}) {
  const referencedRoots = new Set(
    existingReferences.map(reference => reference.workspaceRoot),
  );
  const discovered = [];
  for (const workspaceRoot of plan.fleetDiscovery.workspaceRoots) {
    if (referencedRoots.has(workspaceRoot)) continue;
    const receiptPath = projectSuccessReceiptPath(
      receiptBasePath,
      receiptId,
      workspaceRoot,
    );
    if (!await pathExists(path.resolve(root, receiptPath))) continue;
    const receipt = await readBoundedJson(
      root,
      receiptPath,
      "project_success_receipt_path",
    );
    const reference = {
      workspaceRoot,
      receiptBasePath,
      receiptPath,
      receiptSha256: receipt.receiptSha256,
    };
    const evidence = await validateProjectSuccessEvidence({
      root,
      reference,
      plan,
      ownerAuthority,
      receiptId,
      receiptBasePath,
      maximumAttemptNumber: attemptNumber,
      expectedAttemptNumber: attemptNumber,
      expectedPriorAttemptReceiptSha256: priorAttemptReceiptSha256,
    });
    discovered.push({ reference, evidence });
  }
  return discovered;
}

async function matchingCommittedMigrationReceipt({
  workspaceRoot,
  fromCore,
  toCore,
}) {
  const workspace = await canonicalWorkspaceRoot(workspaceRoot);
  const relativeRoot = ".owlcoda/runkit/config-migration-receipts";
  const absoluteRoot = path.resolve(workspace, relativeRoot);
  let rootStat;
  try {
    rootStat = await lstat(absoluteRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (
    rootStat.isSymbolicLink()
    || !rootStat.isDirectory()
    || await realpath(absoluteRoot) !== absoluteRoot
  ) {
    throw new Error("core_successor_migration_receipts_root_invalid");
  }
  const matches = [];
  for (const entry of (await readdir(absoluteRoot, {
    withFileTypes: true,
  })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (
      entry.isSymbolicLink()
      || !entry.isFile()
      || !entry.name.endsWith(".json")
    ) {
      continue;
    }
    const relativePath = `${relativeRoot}/${entry.name}`;
    const artifact = await readWorkspaceArtifact(
      workspace,
      relativePath,
      "migration_receipt",
    );
    if (
      artifact.value?.schemaVersion
        === "OwlCodaRunKitConfigMigrationReceiptV1"
      && sameCore(artifact.value.fromCore, fromCore)
      && sameCore(artifact.value.toCore, toCore)
      && artifact.value.authorizationGranted === false
    ) {
      matches.push(relativePath);
    }
  }
  return matches[0] ?? null;
}

async function recoverCommittedProjectSuccessEvidence({
  root,
  plan,
  ownerAuthority,
  receiptId,
  receiptBasePath,
  attemptNumber,
  priorAttemptReceiptSha256,
  existingReferences,
}) {
  const referencedRoots = new Set(
    existingReferences.map(reference => reference.workspaceRoot),
  );
  const recovered = [];
  for (const binding of plan.fleetCoreBindings) {
    const workspaceRoot = binding.workspaceRoot;
    if (referencedRoots.has(workspaceRoot)) continue;
    let config;
    try {
      config = await readWorkspaceConfig(workspaceRoot);
    } catch {
      continue;
    }
    if (!sameCore(config.core, plan.toCore)) continue;
    const migrationReceipt = await matchingCommittedMigrationReceipt({
      workspaceRoot,
      fromCore: binding.fromCore,
      toCore: plan.toCore,
    });
    if (migrationReceipt === null) continue;
    const reference = await writeProjectSuccessReceipt({
      root,
      receiptBasePath,
      receiptId,
      attemptNumber,
      priorAttemptReceiptSha256,
      plan,
      ownerAuthority,
      workspaceRoot,
      fromCore: binding.fromCore,
      migrationResult: {
        status: "upgraded",
        migrationReceipt,
      },
    });
    const evidence = await validateProjectSuccessEvidence({
      root,
      reference,
      plan,
      ownerAuthority,
      receiptId,
      receiptBasePath,
      maximumAttemptNumber: attemptNumber,
      expectedAttemptNumber: attemptNumber,
      expectedPriorAttemptReceiptSha256: priorAttemptReceiptSha256,
    });
    recovered.push({ reference, evidence });
  }
  return recovered;
}

async function writeProjectSuccessReceipt({
  root,
  receiptBasePath,
  receiptId,
  attemptNumber,
  priorAttemptReceiptSha256,
  plan,
  ownerAuthority,
  workspaceRoot,
  fromCore,
  migrationResult,
}) {
  const migrationArtifact = await readWorkspaceArtifact(
    workspaceRoot,
    migrationResult.migrationReceipt,
    "migration_receipt",
  );
  const configArtifact = await readWorkspaceArtifact(
    workspaceRoot,
    ".owlcoda/runkit/config.json",
    "post_config",
  );
  const configGate = validateProjectConfigV2(configArtifact.value);
  if (
    migrationArtifact.value?.schemaVersion
      !== "OwlCodaRunKitConfigMigrationReceiptV1"
    || !sameCore(migrationArtifact.value.fromCore, fromCore)
    || !sameCore(migrationArtifact.value.toCore, plan.toCore)
    || migrationArtifact.value.authorizationGranted !== false
    || !configGate.valid
    || !sameCore(configArtifact.value.core, plan.toCore)
  ) {
    throw new Error("core_successor_migration_evidence_invalid");
  }
  const body = {
    schemaVersion: "OwlCodaRunKitCoreSuccessorProjectSuccessReceiptV1",
    receiptId,
    attemptNumber,
    priorAttemptReceiptSha256,
    workspaceRoot,
    fromCore: cloneJson(fromCore, "project_from_core"),
    toCore: cloneJson(plan.toCore, "to_core"),
    planSha256: plan.planSha256,
    ownerAuthoritySha256: ownerAuthority.authoritySha256,
    fleetManifestSha256: plan.fleetDiscovery.frozenManifestSha256,
    migrationStatus: migrationResult.status,
    migrationReceiptPath: migrationArtifact.relativePath,
    migrationReceiptSha256: migrationArtifact.sha256,
    postConfigSha256: configArtifact.sha256,
    repositoryActions: { ...REPOSITORY_ACTIONS },
    authorizationGranted: false,
  };
  const receipt = {
    ...body,
    receiptSha256: coreSuccessorArtifactSha256V1(body),
  };
  const receiptPath = projectSuccessReceiptPath(
    receiptBasePath,
    receiptId,
    workspaceRoot,
  );
  await writeCreateOnlyJson(
    root,
    receiptPath,
    receipt,
    "core_successor_project_success_receipt_exists",
  );
  return {
    workspaceRoot,
    receiptBasePath,
    receiptPath,
    receiptSha256: receipt.receiptSha256,
  };
}

async function performCoreSuccessorAttempt({
  root,
  planPath,
  plan,
  ownerAuthority,
  receiptId,
  receiptBasePath,
  selectedReceiptPath,
  attemptNumber,
  priorAttemptReceiptPath,
  priorAttemptReceiptSha256,
  priorReceipt,
  adoptOrphanSuccessReceipts = false,
  dependencies,
}) {
  return withFleetControlTransactions(
    plan.fleetDiscovery.workspaceRoots,
    async () => {
      const currentPlan = await readBoundedJson(root, planPath, "plan_path");
      validatePlan(currentPlan);
      if (currentPlan.planSha256 !== plan.planSha256) {
        throw new Error("core_successor_plan_drift");
      }
      validateOwnerAuthority(ownerAuthority, currentPlan);
      let trustedAuthority;
      try {
        trustedAuthority = await dependencies.verifyOwnerAuthority({
          authority: ownerAuthority,
          plan: currentPlan,
        });
      } catch {
        throw new Error("core_successor_owner_authority_untrusted");
      }
      assertTrustedAuthority(trustedAuthority, ownerAuthority);

      if (priorReceipt) {
        const currentPrior = await readBoundedJson(
          root,
          priorAttemptReceiptPath,
          "prior_attempt_receipt_path",
        );
        validatePriorPartialReceipt({
          receipt: currentPrior,
          receiptPath: priorAttemptReceiptPath,
          plan: currentPlan,
          ownerAuthority,
        });
        if (currentPrior.receiptSha256 !== priorAttemptReceiptSha256) {
          throw new Error("core_successor_prior_attempt_receipt_drift");
        }
        await validatePriorAttemptLineage({
          root,
          receipt: currentPrior,
          receiptPath: priorAttemptReceiptPath,
          plan: currentPlan,
          ownerAuthority,
        });
        await assertNoResumeBranch({ root, priorReceipt: currentPrior });
      } else if (await pathExists(path.resolve(root, selectedReceiptPath))) {
        const existing = await readBoundedJson(
          root,
          selectedReceiptPath,
          "receipt_path",
        );
        if (
          existing.receiptId === receiptId
          && existing.planSha256 === currentPlan.planSha256
          && existing.ownerAuthoritySha256 === ownerAuthority.authoritySha256
          && existing.status === "partial_failure"
        ) {
          throw new Error("core_successor_resume_required");
        }
        throw new Error("core_successor_receipt_exists");
      }
      await prepareCreateOnlyPath(
        root,
        selectedReceiptPath,
        "core_successor_receipt_exists",
      );

      const inheritedSuccessReferences = priorReceipt
        ? priorReceipt.projectSuccessReceipts
        : [];
      const projectSuccessByRoot = new Map();
      for (const reference of inheritedSuccessReferences) {
        const evidence = await validateProjectSuccessEvidence({
          root,
          reference,
          plan: currentPlan,
          ownerAuthority,
          receiptId,
          receiptBasePath,
          maximumAttemptNumber: attemptNumber - 1,
        });
        projectSuccessByRoot.set(reference.workspaceRoot, evidence);
      }
      if (!priorReceipt && !adoptOrphanSuccessReceipts) {
        for (const workspaceRoot of currentPlan.fleetDiscovery.workspaceRoots) {
          const receiptPath = projectSuccessReceiptPath(
            receiptBasePath,
            receiptId,
            workspaceRoot,
          );
          if (await pathExists(path.resolve(root, receiptPath))) {
            throw new Error("core_successor_orphan_resume_required");
          }
        }
      }
      const orphanSuccessEvidence = (
        priorReceipt || adoptOrphanSuccessReceipts
      )
        ? await discoverOrphanProjectSuccessEvidence({
            root,
            plan: currentPlan,
            ownerAuthority,
            receiptId,
            receiptBasePath,
            attemptNumber,
            priorAttemptReceiptSha256,
            existingReferences: inheritedSuccessReferences,
          })
        : [];
      const recoveredCommittedEvidence = (
        priorReceipt || adoptOrphanSuccessReceipts
      )
        ? await recoverCommittedProjectSuccessEvidence({
            root,
            plan: currentPlan,
            ownerAuthority,
            receiptId,
            receiptBasePath,
            attemptNumber,
            priorAttemptReceiptSha256,
            existingReferences: [
              ...inheritedSuccessReferences,
              ...orphanSuccessEvidence.map(row => row.reference),
            ],
          })
        : [];
      if (
        adoptOrphanSuccessReceipts
        && !priorReceipt
        && orphanSuccessEvidence.length === 0
        && recoveredCommittedEvidence.length === 0
      ) {
        throw new Error("core_successor_orphan_success_receipts_missing");
      }
      for (const { reference, evidence } of [
        ...orphanSuccessEvidence,
        ...recoveredCommittedEvidence,
      ]) {
        projectSuccessByRoot.set(reference.workspaceRoot, evidence);
      }
      const priorSuccessReferences = orderProjectSuccessReferences(
        currentPlan,
        [
          ...inheritedSuccessReferences,
          ...orphanSuccessEvidence.map(row => row.reference),
          ...recoveredCommittedEvidence.map(row => row.reference),
        ],
      );
      const orphanSuccessReceiptCount = (
        orphanSuccessEvidence.length + recoveredCommittedEvidence.length
      );
      const orphanRecovery = orphanSuccessReceiptCount > 0;

      const runtimeGate = validateExecutionPin({
        expected: currentPlan.toCore,
        actual: await dependencies.runtimeCoreIdentity(),
      });
      if (runtimeGate.status !== "valid") {
        const projects = currentPlan.fleetDiscovery.workspaceRoots.map(
          workspaceRoot => ({
            workspaceRoot,
            fromCore: cloneJson(
              currentPlan.fleetCoreBindings.find(
                binding => binding.workspaceRoot === workspaceRoot,
              ).fromCore,
              "project_from_core",
            ),
            status: "core_drift",
            issueCodes: ["runtime_core_drift"],
            migrationAttempted: false,
          }),
        );
        return persistBatchReceipt({
          root,
          receiptPath: selectedReceiptPath,
          plan: currentPlan,
          ownerAuthority,
          trustedAuthority,
          receiptId,
          status: "blocked_preflight",
          projects,
          migrationAttempted: false,
          attemptNumber,
          receiptBasePath,
          priorAttemptReceiptPath,
          priorAttemptReceiptSha256,
          projectSuccessReceipts: priorSuccessReferences,
          orphanRecovery,
          orphanSuccessReceiptCount,
        });
      }

      const candidateGate = await dependencies.verifySourceCandidate({
        workspaceRoot: root,
        candidatePath: currentPlan.sourceCandidate.candidatePath,
      });
      const candidateValid = candidateGate?.status === "valid"
        && candidateGate.authorizationGranted === false
        && candidateGate.candidateSha256
          === currentPlan.sourceCandidate.candidateSha256;
      const currentFleet = await dependencies.discoverFleet(
        cloneJson(
          currentPlan.fleetDiscoveryRequest,
          "fleet_discovery_request",
        ),
      );
      const fleetValid = discoveryMatchesPlan(
        currentFleet,
        currentPlan.fleetDiscovery,
      );
      if (!candidateValid || !fleetValid) {
        const issueCodes = [
          ...(!candidateValid ? ["source_candidate_drift"] : []),
          ...(!fleetValid ? ["fleet_manifest_drift_or_incomplete"] : []),
        ];
        const projects = currentPlan.fleetDiscovery.workspaceRoots.map(
          workspaceRoot => ({
            workspaceRoot,
            fromCore: cloneJson(
              currentPlan.fleetCoreBindings.find(
                binding => binding.workspaceRoot === workspaceRoot,
              ).fromCore,
              "project_from_core",
            ),
            status: "unsafe",
            issueCodes,
            migrationAttempted: false,
          }),
        );
        return persistBatchReceipt({
          root,
          receiptPath: selectedReceiptPath,
          plan: currentPlan,
          ownerAuthority,
          trustedAuthority,
          receiptId,
          status: "blocked_preflight",
          projects,
          migrationAttempted: false,
          attemptNumber,
          receiptBasePath,
          priorAttemptReceiptPath,
          priorAttemptReceiptSha256,
          projectSuccessReceipts: priorSuccessReferences,
          orphanRecovery,
          orphanSuccessReceiptCount,
        });
      }

      const preflight = [];
      for (const workspaceRoot of currentFleet.workspaceRoots) {
        const binding = currentPlan.fleetCoreBindings.find(
          candidate => candidate.workspaceRoot === workspaceRoot,
        );
        const successEvidence = projectSuccessByRoot.get(workspaceRoot) ?? null;
        const row = await preflightWorkspace({
          workspaceRoot,
          fromCore: binding.fromCore,
          toCore: currentPlan.toCore,
          successEvidence,
          inspectControl: dependencies.inspectProjectControlState,
        });
        preflight.push(row);
      }
      if (preflight.some(row => !new Set([
        "safe",
        "already_migrated",
      ]).has(row.status))) {
        return persistBatchReceipt({
          root,
          receiptPath: selectedReceiptPath,
          plan: currentPlan,
          ownerAuthority,
          trustedAuthority,
          receiptId,
          status: "blocked_preflight",
          projects: preflight,
          migrationAttempted: false,
          attemptNumber,
          receiptBasePath,
          priorAttemptReceiptPath,
          priorAttemptReceiptSha256,
          projectSuccessReceipts: priorSuccessReferences,
          orphanRecovery,
          orphanSuccessReceiptCount,
        });
      }

      const projects = [];
      const projectSuccessReceipts = [...priorSuccessReferences];
      let failed = false;
      let migrationAttempted = false;
      for (const row of preflight) {
        if (row.status === "already_migrated") {
          projects.push({
            ...row,
            status: "skipped_as_already_migrated",
          });
          continue;
        }
        if (failed) {
          projects.push({
            ...row,
            status: "not_attempted_after_failure",
          });
          continue;
        }
        migrationAttempted = true;
        try {
          const result = await dependencies.migrateWorkspace({
            workspaceRoot: row.workspaceRoot,
            fromCore: cloneJson(row.fromCore, "from_core"),
            toCore: cloneJson(currentPlan.toCore, "to_core"),
            planSha256: currentPlan.planSha256,
            ownerAuthoritySha256: ownerAuthority.authoritySha256,
          });
          const config = await readWorkspaceConfig(row.workspaceRoot);
          if (
            !new Set(["upgraded", "initialized"]).has(result?.status)
            || typeof result.migrationReceipt !== "string"
            || validateExecutionPin({
              expected: currentPlan.toCore,
              actual: result.core,
            }).status !== "valid"
            || validateExecutionPin({
              expected: currentPlan.toCore,
              actual: config.core,
            }).status !== "valid"
          ) {
            throw new Error("migration_result_invalid");
          }
          const successReference = await writeProjectSuccessReceipt({
            root,
            receiptBasePath,
            receiptId,
            attemptNumber,
            priorAttemptReceiptSha256,
            plan: currentPlan,
            ownerAuthority,
            workspaceRoot: row.workspaceRoot,
            fromCore: row.fromCore,
            migrationResult: result,
          });
          projectSuccessReceipts.push(successReference);
          projects.push({
            workspaceRoot: row.workspaceRoot,
            fromCore: cloneJson(row.fromCore, "project_from_core"),
            status: "migrated",
            issueCodes: [],
            migrationAttempted: true,
            migrationStatus: result.status,
            migrationReceipt: result.migrationReceipt,
            migrationReceiptSha256: (
              await readWorkspaceArtifact(
                row.workspaceRoot,
                result.migrationReceipt,
                "migration_receipt",
              )
            ).sha256,
            projectSuccessReceiptPath: successReference.receiptPath,
            projectSuccessReceiptSha256: successReference.receiptSha256,
          });
        } catch {
          failed = true;
          projects.push({
            workspaceRoot: row.workspaceRoot,
            fromCore: cloneJson(row.fromCore, "project_from_core"),
            status: "migration_failed",
            issueCodes: ["project_migration_failed"],
            migrationAttempted: true,
          });
        }
      }
      return persistBatchReceipt({
        root,
        receiptPath: selectedReceiptPath,
        plan: currentPlan,
        ownerAuthority,
        trustedAuthority,
        receiptId,
        status: failed ? "partial_failure" : "applied",
        projects,
        migrationAttempted,
        attemptNumber,
        receiptBasePath,
        priorAttemptReceiptPath,
        priorAttemptReceiptSha256,
        projectSuccessReceipts,
        orphanRecovery,
        orphanSuccessReceiptCount,
      });
    },
  );
}

export async function applyCoreSuccessorPlanV1({
  controllerWorkspaceRoot,
  planPath,
  receiptId,
  receiptPath = null,
  ownerAuthority,
  dependencies: dependencyOverrides = {},
} = {}) {
  assertIdentifier(receiptId, "receipt_id");
  const root = await canonicalWorkspaceRoot(controllerWorkspaceRoot);
  const plan = await readBoundedJson(root, planPath, "plan_path");
  validatePlan(plan);
  validateOwnerAuthority(ownerAuthority, plan);
  const receiptBasePath = receiptPath
    ?? `${path.dirname(safeRelativePath(planPath, "plan_path"))}`
      + `/apply-receipts/${receiptId}.json`;
  const selectedReceiptPath = safeRelativePath(
    receiptBasePath,
    "receipt_path",
  );
  if (await pathExists(path.resolve(root, selectedReceiptPath))) {
    const existing = await readBoundedJson(
      root,
      selectedReceiptPath,
      "receipt_path",
    );
    assertBatchReceiptSelfHash(existing);
    if (
      existing.receiptId === receiptId
      && existing.planSha256 === plan.planSha256
      && existing.ownerAuthoritySha256 === ownerAuthority.authoritySha256
      && existing.status === "partial_failure"
    ) {
      throw new Error("core_successor_resume_required");
    }
    throw new Error("core_successor_receipt_exists");
  }
  return performCoreSuccessorAttempt({
    root,
    planPath,
    plan,
    ownerAuthority,
    receiptId,
    receiptBasePath: selectedReceiptPath,
    selectedReceiptPath,
    attemptNumber: 1,
    priorAttemptReceiptPath: null,
    priorAttemptReceiptSha256: null,
    priorReceipt: null,
    dependencies: defaultDependencies(dependencyOverrides),
  });
}

export async function resumeCoreSuccessorPlanV1({
  controllerWorkspaceRoot,
  planPath,
  fromReceiptPath = null,
  receiptId = null,
  receiptPath = null,
  adoptOrphanSuccessReceipts = false,
  ownerAuthority,
  dependencies: dependencyOverrides = {},
} = {}) {
  const root = await canonicalWorkspaceRoot(controllerWorkspaceRoot);
  const plan = await readBoundedJson(root, planPath, "plan_path");
  validatePlan(plan);
  validateOwnerAuthority(ownerAuthority, plan);
  if (fromReceiptPath === null) {
    if (!adoptOrphanSuccessReceipts) {
      throw new Error("core_successor_prior_attempt_receipt_required");
    }
    assertIdentifier(receiptId, "receipt_id");
    const receiptBasePath = receiptPath
      ?? `${path.dirname(safeRelativePath(planPath, "plan_path"))}`
        + `/apply-receipts/${receiptId}.json`;
    const selectedReceiptPath = safeRelativePath(
      receiptBasePath,
      "receipt_path",
    );
    if (await pathExists(path.resolve(root, selectedReceiptPath))) {
      const existing = await readBoundedJson(
        root,
        selectedReceiptPath,
        "receipt_path",
      );
      assertBatchReceiptSelfHash(existing);
      if (
        existing.receiptId === receiptId
        && existing.planSha256 === plan.planSha256
        && existing.ownerAuthoritySha256 === ownerAuthority.authoritySha256
        && existing.status === "partial_failure"
      ) {
        throw new Error("core_successor_resume_from_receipt_required");
      }
      throw new Error("core_successor_receipt_exists");
    }
    return performCoreSuccessorAttempt({
      root,
      planPath,
      plan,
      ownerAuthority,
      receiptId,
      receiptBasePath: selectedReceiptPath,
      selectedReceiptPath,
      attemptNumber: 1,
      priorAttemptReceiptPath: null,
      priorAttemptReceiptSha256: null,
      priorReceipt: null,
      adoptOrphanSuccessReceipts: true,
      dependencies: defaultDependencies(dependencyOverrides),
    });
  }
  if (adoptOrphanSuccessReceipts || receiptId !== null || receiptPath !== null) {
    throw new Error("core_successor_resume_mode_ambiguous");
  }
  const selectedPriorPath = safeRelativePath(
    fromReceiptPath,
    "prior_attempt_receipt_path",
  );
  const priorReceipt = await readBoundedJson(
    root,
    selectedPriorPath,
    "prior_attempt_receipt_path",
  );
  validatePriorPartialReceipt({
    receipt: priorReceipt,
    receiptPath: selectedPriorPath,
    plan,
    ownerAuthority,
  });
  await validatePriorAttemptLineage({
    root,
    receipt: priorReceipt,
    receiptPath: selectedPriorPath,
    plan,
    ownerAuthority,
  });
  assertIdentifier(priorReceipt.receiptId, "receipt_id");
  await assertNoResumeBranch({ root, priorReceipt });
  const attemptNumber = priorReceipt.attemptNumber + 1;
  const selectedReceiptPath = receiptAttemptPath(
    priorReceipt.receiptBasePath,
    attemptNumber,
  );
  return performCoreSuccessorAttempt({
    root,
    planPath,
    plan,
    ownerAuthority,
    receiptId: priorReceipt.receiptId,
    receiptBasePath: priorReceipt.receiptBasePath,
    selectedReceiptPath,
    attemptNumber,
    priorAttemptReceiptPath: selectedPriorPath,
    priorAttemptReceiptSha256: priorReceipt.receiptSha256,
    priorReceipt,
    adoptOrphanSuccessReceipts: false,
    dependencies: defaultDependencies(dependencyOverrides),
  });
}
