import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectControlState } from "./project-control-parser.mjs";

export const CONTRACT_VERSION = "0.2";
export const CORE_VERSION = "0.18.0";
export const RUNTIME_ROOT = ".owlcoda/runkit";

const CORE_FILES = [
  "acceptance-evidence.mjs",
  "assurance-router.mjs",
  "core-successor.mjs",
  "coverage-adoption.mjs",
  "core-contract.mjs",
  "delivery-create.mjs",
  "delivery-selection.mjs",
  "deployment-workflow.mjs",
  "fleet-discovery.mjs",
  "finalize.mjs",
  "formal-workflow.mjs",
  "human-status.mjs",
  "inspect-presentation.mjs",
  "install-codex-skill.mjs",
  "lease-lifecycle.mjs",
  "lifecycle-orchestration.mjs",
  "offline-store.mjs",
  "onboarding-doctor.mjs",
  "owner-authority-trust.mjs",
  "owner-deployment-decision.mjs",
  "profile-impact.mjs",
  "profile-onboarding.mjs",
  "project-cli-resolver.mjs",
  "project-control-parser.mjs",
  "project-control-state.mjs",
  "provenance-common.mjs",
  "quick-attest.mjs",
  "quick-canonical.mjs",
  "quick-metrics.mjs",
  "quick-receipt.mjs",
  "quick-verify.mjs",
  "quick-workspace-snapshot.mjs",
  "ready-for-commit.mjs",
  "receipt-lineage.mjs",
  "registry-adoption-gate.mjs",
  "registry-adoption.mjs",
  "repair-execution.mjs",
  "resume-execution.mjs",
  "resource-preflight.mjs",
  "remote-deployment.mjs",
  "remote-process-adapter.mjs",
  "ssh-remote-adapter.mjs",
  "runkit-bootstrap.mjs",
  "runkit-cli.mjs",
  "snapshot.mjs",
  "source-candidate.mjs",
  "source-fingerprint.mjs",
  "sync-release-identity.mjs",
  "team-project-successor.mjs",
  "team-project.mjs",
  "verification-envelope.mjs",
  "verification-envelope-check.mjs",
  "verification-receipt-gate.mjs",
  "verification-context.mjs",
  "verification-plan.mjs",
  "visual-smoke.mjs",
  "schemas/assurance-route-v1.schema.json",
  "schemas/closeout-receipt-v2.schema.json",
  "schemas/adoption-evidence-v1.schema.json",
  "schemas/coverage-adopt-request-v1.schema.json",
  "schemas/core-artifact.schema.json",
  "schemas/core-artifact-v2.schema.json",
  "schemas/core-successor-batch-receipt-v1.schema.json",
  "schemas/core-successor-plan-v1.schema.json",
  "schemas/core-successor-project-success-receipt-v1.schema.json",
  "schemas/deployment-execute-request-v1.schema.json",
  "schemas/deployment-lineage-v1.schema.json",
  "schemas/deployment-prepare-receipt-v1.schema.json",
  "schemas/engine-pin.schema.json",
  "schemas/engine-pin-v2.schema.json",
  "schemas/evidence-coverage-index-v1.schema.json",
  "schemas/fleet-discovery-v1.schema.json",
  "schemas/fleet-manifest-v1.schema.json",
  "schemas/fleet-root-registry-v1.schema.json",
  "schemas/human-status-v1.schema.json",
  "schemas/owner-authority-trust-v1.schema.json",
  "schemas/owner-migration-authority-v1.schema.json",
  "schemas/owner-migration-authority-v2.schema.json",
  "schemas/owner-deployment-authority-v1.schema.json",
  "schemas/owner-deployment-authority-v2.schema.json",
  "schemas/owner-deployment-decision-v1.schema.json",
  "schemas/profile-apply-receipt-v1.schema.json",
  "schemas/profile-detection-v2.schema.json",
  "schemas/project-config.schema.json",
  "schemas/project-config-v2.schema.json",
  "schemas/profiles.schema.json",
  "schemas/remote-deployment-manifest-v1.schema.json",
  "schemas/remote-deployment-result-v1.schema.json",
  "schemas/remote-deployment-stage-journal-v1.schema.json",
  "schemas/remote-target-v1.schema.json",
  "schemas/resume-attempt-v1.schema.json",
  "schemas/resume-request-v1.schema.json",
  "schemas/resource-preflight-request-v1.schema.json",
  "schemas/resource-preflight-v1.schema.json",
  "schemas/replayable-evidence-v1.schema.json",
  "schemas/finalize-request-v1.schema.json",
  "schemas/ready-for-commit-v1.schema.json",
  "schemas/ready-for-commit-v2.schema.json",
  "schemas/snapshot-v1.schema.json",
  "schemas/source-candidate-v2.schema.json",
  "schemas/visual-smoke-request-v1.schema.json",
  "schemas/visual-smoke-result-v1.schema.json",
  "schemas/verification-context-v1.schema.json",
  "schemas/team-project-definition-v1.schema.json",
  "schemas/team-project-event-v1.schema.json",
  "schemas/team-project-successor-receipt-v1.schema.json",
  "schemas/team-project-status-v1.schema.json",
  "schemas/verification-envelope-v1.schema.json",
  "schemas/verification-finalize-attempt-v1.schema.json",
  "schemas/verification-preflight-v1.schema.json",
  "schemas/verification-plan-v1.schema.json",
  "schemas/verification-receipt-v2.schema.json",
  "schemas/verify-plan-request-v1.schema.json",
  "templates/goal-contract.json",
  "templates/assurance-request.json",
  "templates/core-successor-owner-authority.json",
  "templates/owner-authority-trust.json",
  "templates/coverage-adopt-request.json",
  "templates/deployment-execute-request.json",
  "templates/deployment-owner-authority.json",
  "templates/deployment-owner-decision.json",
  "templates/fleet-manifest.json",
  "templates/fleet-root-registry.json",
  "templates/finalize-request.json",
  "templates/ready-for-commit-request.json",
  "templates/resume-request.json",
  "templates/resource-preflight-request.json",
  "templates/remote-deployment-manifest.json",
  "templates/snapshot-request.json",
  "templates/visual-smoke-request.json",
  "templates/verify-plan-request.json",
  "templates/worker-lease.json",
  "templates/team-project-definition.json",
  "templates/team-project-event.json",
  "templates/verification-envelope.json",
];

const CORE_DEPENDENCY_FILES = [
  "packages/attest/src/formal.mjs",
  "packages/attest/src/offline-bundle.mjs",
  "packages/attest/src/quick-receipt-contract.mjs",
  "packages/attest/src/reference-contract.mjs",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256Ref(value) {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  rmSync(temporaryPath, { force: true });
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporaryPath, filePath);
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

function canonicalWorkspaceRoot(workspaceRoot) {
  const requested = resolve(workspaceRoot);
  const stat = lstatSync(requested);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
  ) {
    throw new Error("workspaceRoot must be a real directory.");
  }
  return realpathSync(requested);
}

function ensureRealDirectory(root, target, label) {
  const remainder = relative(root, target);
  if (
    remainder === ""
    || remainder === ".."
    || remainder.startsWith(`..${sep}`)
    || isAbsolute(remainder)
  ) {
    throw new Error(`${label} escapes the workspace.`);
  }
  let current = root;
  for (const segment of remainder.split(/[\\/]/u)) {
    current = resolve(current, segment);
    if (!pathEntryExists(current)) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    const stat = lstatSync(current);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || realpathSync(current) !== current
    ) {
      throw new Error(`${label} must be a real directory without symlink ancestors.`);
    }
  }
  return target;
}

function assertRegularRuntimeFile(root, filePath, label) {
  const remainder = relative(root, filePath);
  if (
    remainder === ""
    || remainder === ".."
    || remainder.startsWith(`..${sep}`)
    || isAbsolute(remainder)
  ) {
    throw new Error(`${label} escapes the workspace.`);
  }
  const stat = lstatSync(filePath);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || realpathSync(filePath) !== filePath
  ) {
    throw new Error(`${label} must be a regular file without symlink ancestors.`);
  }
}

function projectConfig(core = currentCoreIdentity()) {
  return {
    schemaVersion: "OwlCodaRunKitConfigV2",
    core,
    authorizationPolicy: "external_explicit_authority_required",
  };
}

function migrationReceiptName(migration, fromCore, toCore) {
  if (migration === "config-v01-to-v02") return "config-v01-to-v02.json";
  const from = fromCore.coreManifestSha256.slice("sha256:".length);
  const to = toCore.coreManifestSha256.slice("sha256:".length);
  return `config-v02-core-refresh-${from}-to-${to}.json`;
}

function writeMigrationReceiptAppendOnly(receiptsRoot, baseName, receipt) {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const stem = baseName.slice(0, -".json".length);
  for (let attempt = 1; ; attempt += 1) {
    const receiptName = attempt === 1
      ? baseName
      : `${stem}-attempt-${String(attempt).padStart(3, "0")}.json`;
    try {
      writeFileSync(resolve(receiptsRoot, receiptName), bytes, { flag: "wx" });
      return receiptName;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function migrateProjectConfig({ runtimeRoot, configPath, config, migration }) {
  validateCoreIdentity(config.core);
  const next = projectConfig();
  const receipt = {
    schemaVersion: "OwlCodaRunKitConfigMigrationReceiptV1",
    migration,
    fromSchemaVersion: config.schemaVersion,
    toSchemaVersion: next.schemaVersion,
    fromCore: config.core,
    toCore: next.core,
    authorizationGranted: false,
  };
  const receiptsRoot = resolve(runtimeRoot, "config-migration-receipts");
  ensureRealDirectory(
    runtimeRoot,
    receiptsRoot,
    "Config migration receipt directory",
  );
  const receiptName = writeMigrationReceiptAppendOnly(
    receiptsRoot,
    migrationReceiptName(migration, config.core, next.core),
    receipt,
  );
  atomicWriteJson(configPath, next);
  return `${RUNTIME_ROOT}/config-migration-receipts/${receiptName}`;
}

function coreDirectory() {
  return resolve(fileURLToPath(new URL(".", import.meta.url)));
}

function coreManifestStreamFromRoots(coreRoot, projectRoot) {
  return [
    ...CORE_FILES.map((name) => `${name}\tsha256:${sha256(readFileSync(resolve(coreRoot, name)))}\n`),
    ...CORE_DEPENDENCY_FILES.map((name) => `${name}\tsha256:${sha256(readFileSync(resolve(projectRoot, name)))}\n`),
  ].join("");
}

export function coreIdentityFromSourceRoot(sourceRoot) {
  const projectRoot = realpathSync(sourceRoot);
  const coreRoot = resolve(projectRoot, "scripts/runkit-contract");
  const manifestSha256 = sha256(coreManifestStreamFromRoots(coreRoot, projectRoot));
  return {
    contractVersion: CONTRACT_VERSION,
    coreVersion: CORE_VERSION,
    coreManifestSha256: `sha256:${manifestSha256}`,
    coreSourceRef: `artifact:sha256:${manifestSha256}`,
  };
}

export function currentCoreIdentity() {
  return coreIdentityFromSourceRoot(resolve(coreDirectory(), "../.."));
}

export function isDirectExecution(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return resolve(argvPath) === fileURLToPath(moduleUrl);
  }
}

export function isReservedRuntimePath(value) {
  return value === RUNTIME_ROOT || value.startsWith(`${RUNTIME_ROOT}/`);
}

function validateRepoRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || win32.isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${label} must be a safe repository-relative path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, dot, or parent segments.`);
  }
  if (isReservedRuntimePath(value)) throw new Error(`${label} uses the reserved runtime path ${RUNTIME_ROOT}.`);
  return value;
}

export function validateLeaseOwnedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("Lease owned paths must be a non-empty array.");
  return [...new Set(paths.map((value) => validateRepoRelativePath(value, "Lease owned path")))].sort();
}

export function validateExecutionPin({ expected, actual } = {}) {
  const fields = ["contractVersion", "coreVersion", "coreManifestSha256", "coreSourceRef"];
  try {
    validateCoreIdentity(expected, { requireSourceBinding: false });
    validateCoreIdentity(actual, { requireSourceBinding: false });
  } catch (error) {
    return {
      status: "invalid_input",
      exitCode: 3,
      issues: [error instanceof Error ? `invalid engine pin: ${error.message}` : String(error)],
    };
  }
  const issues = fields.filter((field) => expected[field] !== actual[field]).map((field) => `${field} changed during execution`);
  return issues.length === 0
    ? { status: "valid", exitCode: 0, issues: [] }
    : { status: "engine_changed_during_execution", exitCode: 2, issues };
}

function validateCoreIdentity(core, { requireSourceBinding = true } = {}) {
  if (!isRecord(core)) throw new Error("Core identity must be an object.");
  const coreKeys = ["contractVersion", "coreManifestSha256", "coreSourceRef", "coreVersion"];
  const unsupportedCoreKeys = Object.keys(core).filter(key => !coreKeys.includes(key));
  if (unsupportedCoreKeys.length > 0) {
    throw new Error(`Core identity contains unsupported field: ${unsupportedCoreKeys[0]}`);
  }
  if (typeof core.contractVersion !== "string" || typeof core.coreVersion !== "string") throw new Error("Core identity requires contractVersion and coreVersion.");
  if (!new Set(["0.1", CONTRACT_VERSION]).has(core.contractVersion)) {
    throw new Error("Core identity contractVersion must be a supported RunKit contract version.");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(core.coreVersion)) {
    throw new Error("Core identity coreVersion must be a three-part semantic version.");
  }
  if (!isSha256Ref(core.coreManifestSha256)) throw new Error("Core identity requires coreManifestSha256.");
  if (typeof core.coreSourceRef !== "string" || core.coreSourceRef.length === 0) {
    throw new Error("Core identity coreSourceRef must be a non-empty string.");
  }
  if (requireSourceBinding && core.coreSourceRef !== `artifact:${core.coreManifestSha256}`) {
    throw new Error("Core identity coreSourceRef must bind coreManifestSha256.");
  }
}

export function validateProjectConfigV2(config) {
  try {
    if (!isRecord(config)) throw new Error("Project config must be an object.");
    const configKeys = ["authorizationPolicy", "core", "schemaVersion"];
    const unsupportedConfigKeys = Object.keys(config).filter(key => !configKeys.includes(key));
    if (unsupportedConfigKeys.length > 0) {
      throw new Error(`Project config contains unsupported field: ${unsupportedConfigKeys[0]}`);
    }
    if (config.schemaVersion !== "OwlCodaRunKitConfigV2") {
      throw new Error("Project config schemaVersion must be OwlCodaRunKitConfigV2.");
    }
    if (config.authorizationPolicy !== "external_explicit_authority_required") {
      throw new Error("Unsupported project config authorizationPolicy.");
    }
    if (!isRecord(config.core)) throw new Error("Project config core must be an object.");
    const coreKeys = ["contractVersion", "coreManifestSha256", "coreSourceRef", "coreVersion"];
    const unsupportedCoreKeys = Object.keys(config.core).filter(key => !coreKeys.includes(key));
    if (unsupportedCoreKeys.length > 0) {
      throw new Error(`Project config core contains unsupported field: ${unsupportedCoreKeys[0]}`);
    }
    validateCoreIdentity(config.core);
    if (config.core.contractVersion !== CONTRACT_VERSION) {
      throw new Error(`Project config core contractVersion must be ${CONTRACT_VERSION}.`);
    }
    return { valid: true, issues: [] };
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

function projectControlParserContract() {
  return {
    runtimeRoot: RUNTIME_ROOT,
    acceptedCloseoutVerificationIssues,
    validateCoreArtifact,
    validateExecutionPin,
    validateLeaseOwnedPaths,
  };
}

export function inspectProjectUpgradeSafety({ workspaceRoot } = {}) {
  return parseProjectControlState({
    workspaceRoot,
    currentCore: currentCoreIdentity(),
    contract: projectControlParserContract(),
  }).upgradeSafety;
}

function validateProducer(producer) {
  if (!isRecord(producer) || typeof producer.adapterKind !== "string" || typeof producer.adapterVersion !== "string") {
    throw new Error("Producer requires adapterKind and adapterVersion.");
  }
  if (producer.adapterKind.length === 0 || producer.adapterVersion.length === 0) {
    throw new Error("Producer adapterKind and adapterVersion must be non-empty strings.");
  }
  const producerKeys = ["adapterKind", "adapterVersion"];
  const unsupportedProducerKeys = Object.keys(producer).filter(key => !producerKeys.includes(key));
  if (unsupportedProducerKeys.length > 0) {
    throw new Error(`Producer contains unsupported field: ${unsupportedProducerKeys[0]}`);
  }
}

function validateExtensions(extensions) {
  if (!isRecord(extensions)) throw new Error("Extensions must be an object.");
  for (const namespace of Object.keys(extensions)) {
    if (!namespace.includes(".")) throw new Error(`Extension namespace must be qualified: ${namespace}`);
  }
}

function artifactHashes(artifact) {
  const acceptance = {
    schemaVersion: artifact.schemaVersion,
    core: artifact.core,
    payload: artifact.payload,
  };
  return {
    acceptanceSha256: `sha256:${sha256(canonicalJson(acceptance))}`,
    artifactSha256: `sha256:${sha256(canonicalJson(artifact))}`,
  };
}

export function createCoreArtifact({ core = currentCoreIdentity(), producer, payload, extensions = {} } = {}) {
  validateCoreIdentity(core);
  validateProducer(producer);
  if (!isRecord(payload)) throw new Error("Core artifact payload must be an object.");
  validateExtensions(extensions);
  const artifact = {
    schemaVersion: "RunKitCoreArtifactV2",
    core: structuredClone(core),
    producer: structuredClone(producer),
    payload: structuredClone(payload),
    extensions: structuredClone(extensions),
  };
  return { artifact, ...artifactHashes(artifact) };
}

export function validateCoreArtifact(artifact) {
  try {
    if (!isRecord(artifact) || !new Set(["RunKitCoreArtifactV1", "RunKitCoreArtifactV2"]).has(artifact.schemaVersion)) throw new Error("Unsupported core artifact schemaVersion.");
    const artifactKeys = ["core", "extensions", "payload", "producer", "schemaVersion"];
    const unsupportedArtifactKeys = Object.keys(artifact).filter(key => !artifactKeys.includes(key));
    if (unsupportedArtifactKeys.length > 0) {
      throw new Error(`Core artifact contains unsupported field: ${unsupportedArtifactKeys[0]}`);
    }
    validateCoreIdentity(artifact.core);
    const expectedContractVersion = artifact.schemaVersion === "RunKitCoreArtifactV1"
      ? "0.1"
      : CONTRACT_VERSION;
    if (artifact.core.contractVersion !== expectedContractVersion) {
      throw new Error(`Core artifact ${artifact.schemaVersion} requires contractVersion ${expectedContractVersion}.`);
    }
    validateProducer(artifact.producer);
    if (!isRecord(artifact.payload)) throw new Error("Core artifact payload must be an object.");
    validateExtensions(artifact.extensions);
    return { valid: true, issues: [], ...artifactHashes(artifact) };
  } catch (error) {
    return { valid: false, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

export function acceptedCloseoutVerificationIssues(artifact) {
  if (artifact?.core?.contractVersion !== "0.2" || artifact?.payload?.decision !== "accepted") return [];
  const verification = artifact.payload.verification;
  const sourceArtifactValid = verification?.sourceArtifact === undefined
    || (
      isRecord(verification.sourceArtifact)
      && new Set(["delivery_packet_v1", "source_candidate_v2"])
        .has(verification.sourceArtifact.kind)
      && verification.sourceArtifact.runId === artifact.payload.runId
      && typeof verification.sourceArtifact.path === "string"
      && verification.sourceArtifact.path.length > 0
      && typeof verification.sourceArtifact.sha256 === "string"
      && /^[a-f0-9]{64}$/.test(verification.sourceArtifact.sha256)
      && verification.sourceArtifact.sourceFingerprint
        === verification.sourceFingerprint
    );
  const validFields = [
    verification?.contractVersion === "0.2",
    verification?.gateDecision === "accepted_passed",
    typeof verification?.gateInputSha256 === "string" && /^[a-f0-9]{64}$/.test(verification.gateInputSha256),
    typeof verification?.activeReceiptSha256 === "string" && /^[a-f0-9]{64}$/.test(verification.activeReceiptSha256),
    typeof verification?.sourceFingerprint === "string" && /^[a-f0-9]{64}$/.test(verification.sourceFingerprint),
    sourceArtifactValid,
    typeof verification?.verificationContextFingerprint === "string" && /^[a-f0-9]{64}$/.test(verification.verificationContextFingerprint),
    verification?.leaseState === "released",
    Array.isArray(verification?.selectedProfileIds)
      && verification.selectedProfileIds.length > 0
      && verification.selectedProfileIds.every(value => typeof value === "string" && value.length > 0),
    Array.isArray(verification?.releasedLeaseIds)
      && verification.releasedLeaseIds.length > 0
      && verification.releasedLeaseIds.every(value => typeof value === "string" && value.length > 0)
      && new Set(verification.releasedLeaseIds).size === verification.releasedLeaseIds.length,
  ];
  return validFields.every(Boolean) ? [] : ["Contract v0.2 accepted closeout requires complete verification evidence"];
}

export async function initializeProjectRunKit({ workspaceRoot } = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new Error("workspaceRoot is required.");
  const root = canonicalWorkspaceRoot(workspaceRoot);
  if (pathEntryExists(resolve(root, ".owlrunkit"))) throw new Error("Legacy .owlrunkit exists; explicit migration is required before initialization.");
  const runtimeRoot = resolve(root, RUNTIME_ROOT);
  ensureRealDirectory(root, resolve(root, ".owlcoda"), "OwlCoda control directory");
  ensureRealDirectory(root, runtimeRoot, "RunKit runtime directory");
  ensureRealDirectory(
    runtimeRoot,
    resolve(runtimeRoot, "executions"),
    "RunKit executions directory",
  );
  const configPath = resolve(runtimeRoot, "config.json");
  const profilesPath = resolve(runtimeRoot, "profiles.json");
  const configExists = pathEntryExists(configPath);
  const profilesExist = pathEntryExists(profilesPath);
  if (configExists) {
    assertRegularRuntimeFile(runtimeRoot, configPath, "Project config");
  }
  if (profilesExist) {
    assertRegularRuntimeFile(runtimeRoot, profilesPath, "Project profiles");
  }
  if (!configExists) {
    atomicWriteJson(configPath, projectConfig());
  } else {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (config.authorizationPolicy !== "external_explicit_authority_required") {
      throw new Error("Unsupported project config authorizationPolicy.");
    }
    const current = currentCoreIdentity();
    const currentGate = validateExecutionPin({ expected: config.core, actual: current });
    if (config.schemaVersion === "OwlCodaRunKitConfigV2" && currentGate.status === "valid") {
      // The project already points at this exact Core identity.
    } else if (config.schemaVersion === "OwlCodaRunKitConfigV1" && config.core?.contractVersion === "0.1") {
      const safety = inspectProjectUpgradeSafety({ workspaceRoot: root });
      if (safety.status !== "safe") {
        return {
          ...safety,
          status: "upgrade_blocked_active_execution",
          exitCode: 2,
          runtimeRoot: RUNTIME_ROOT,
          core: current,
        };
      }
      const migrationReceipt = migrateProjectConfig({
        runtimeRoot,
        configPath,
        config,
        migration: "config-v01-to-v02",
      });
      if (!profilesExist) {
        atomicWriteJson(profilesPath, {
          schemaVersion: "OwlCodaRunKitProfilesV1",
          profiles: [],
        });
      }
      return { status: "upgraded", exitCode: 0, runtimeRoot: RUNTIME_ROOT, core: current, migrationReceipt };
    } else if (config.schemaVersion === "OwlCodaRunKitConfigV2" && config.core?.contractVersion === CONTRACT_VERSION) {
      const safety = inspectProjectUpgradeSafety({ workspaceRoot: root });
      if (safety.status !== "safe") {
        return {
          ...safety,
          status: "upgrade_blocked_active_execution",
          exitCode: 2,
          runtimeRoot: RUNTIME_ROOT,
          core: current,
        };
      }
      const migrationReceipt = migrateProjectConfig({
        runtimeRoot,
        configPath,
        config,
        migration: "config-v02-core-refresh",
      });
      if (!profilesExist) {
        atomicWriteJson(profilesPath, {
          schemaVersion: "OwlCodaRunKitProfilesV1",
          profiles: [],
        });
      }
      return { status: "upgraded", exitCode: 0, runtimeRoot: RUNTIME_ROOT, core: current, migrationReceipt };
    } else {
      throw new Error(`Unsupported project config migration: ${config.schemaVersion ?? "missing schemaVersion"}.`);
    }
  }
  if (!profilesExist) {
    atomicWriteJson(profilesPath, {
      schemaVersion: "OwlCodaRunKitProfilesV1",
      profiles: [],
    });
  }
  return { status: "initialized", exitCode: 0, runtimeRoot: RUNTIME_ROOT, core: currentCoreIdentity() };
}

export function coreManifest() {
  const identity = currentCoreIdentity();
  return {
    schemaVersion: "OwlCodaRunKitCoreManifestV1",
    ...identity,
    files: [...CORE_FILES],
    dependencyFiles: [...CORE_DEPENDENCY_FILES],
  };
}
