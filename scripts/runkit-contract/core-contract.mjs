import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT_VERSION = "0.2";
export const CORE_VERSION = "0.12.0";
export const RUNTIME_ROOT = ".owlcoda/runkit";

const CORE_FILES = [
  "acceptance-evidence.mjs",
  "coverage-adoption.mjs",
  "core-contract.mjs",
  "delivery-create.mjs",
  "finalize.mjs",
  "inspect-presentation.mjs",
  "lease-lifecycle.mjs",
  "lifecycle-orchestration.mjs",
  "profile-impact.mjs",
  "provenance-common.mjs",
  "ready-for-commit.mjs",
  "receipt-lineage.mjs",
  "resume-execution.mjs",
  "resource-preflight.mjs",
  "runkit-cli.mjs",
  "snapshot.mjs",
  "source-fingerprint.mjs",
  "verification-receipt-gate.mjs",
  "verification-context.mjs",
  "verification-plan.mjs",
  "visual-smoke.mjs",
  "schemas/closeout-receipt-v2.schema.json",
  "schemas/coverage-adopt-request-v1.schema.json",
  "schemas/core-artifact.schema.json",
  "schemas/core-artifact-v2.schema.json",
  "schemas/engine-pin.schema.json",
  "schemas/engine-pin-v2.schema.json",
  "schemas/evidence-coverage-index-v1.schema.json",
  "schemas/project-config.schema.json",
  "schemas/project-config-v2.schema.json",
  "schemas/profiles.schema.json",
  "schemas/resume-attempt-v1.schema.json",
  "schemas/resume-request-v1.schema.json",
  "schemas/resource-preflight-request-v1.schema.json",
  "schemas/resource-preflight-v1.schema.json",
  "schemas/replayable-evidence-v1.schema.json",
  "schemas/finalize-request-v1.schema.json",
  "schemas/ready-for-commit-v1.schema.json",
  "schemas/snapshot-v1.schema.json",
  "schemas/visual-smoke-request-v1.schema.json",
  "schemas/visual-smoke-result-v1.schema.json",
  "schemas/verification-context-v1.schema.json",
  "schemas/verification-plan-v1.schema.json",
  "schemas/verification-receipt-v2.schema.json",
  "schemas/verify-plan-request-v1.schema.json",
  "templates/goal-contract.json",
  "templates/coverage-adopt-request.json",
  "templates/finalize-request.json",
  "templates/ready-for-commit-request.json",
  "templates/resume-request.json",
  "templates/resource-preflight-request.json",
  "templates/snapshot-request.json",
  "templates/visual-smoke-request.json",
  "templates/verify-plan-request.json",
  "templates/worker-lease.json",
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
  mkdirSync(receiptsRoot, { recursive: true });
  const receiptName = migrationReceiptName(migration, config.core, next.core);
  atomicWriteJson(resolve(receiptsRoot, receiptName), receipt);
  atomicWriteJson(configPath, next);
  return `${RUNTIME_ROOT}/config-migration-receipts/${receiptName}`;
}

function coreDirectory() {
  return resolve(fileURLToPath(new URL(".", import.meta.url)));
}

function coreManifestStream() {
  const root = coreDirectory();
  return CORE_FILES.map((name) => `${name}\tsha256:${sha256(readFileSync(resolve(root, name)))}\n`).join("");
}

export function currentCoreIdentity() {
  const manifestSha256 = sha256(coreManifestStream());
  return {
    contractVersion: CONTRACT_VERSION,
    coreVersion: CORE_VERSION,
    coreManifestSha256: `sha256:${manifestSha256}`,
    coreSourceRef: `artifact:sha256:${manifestSha256}`,
  };
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
  const malformed = fields.filter((field) => typeof expected?.[field] !== "string" || typeof actual?.[field] !== "string");
  if (malformed.length > 0) {
    return { status: "invalid_input", exitCode: 3, issues: malformed.map((field) => `missing engine pin field: ${field}`) };
  }
  const issues = fields.filter((field) => expected[field] !== actual[field]).map((field) => `${field} changed during execution`);
  return issues.length === 0
    ? { status: "valid", exitCode: 0, issues: [] }
    : { status: "engine_changed_during_execution", exitCode: 2, issues };
}

function validateCoreIdentity(core) {
  if (!isRecord(core)) throw new Error("Core identity must be an object.");
  if (typeof core.contractVersion !== "string" || typeof core.coreVersion !== "string") throw new Error("Core identity requires contractVersion and coreVersion.");
  if (!isSha256Ref(core.coreManifestSha256)) throw new Error("Core identity requires coreManifestSha256.");
  if (typeof core.coreSourceRef !== "string" || core.coreSourceRef.length === 0) throw new Error("Core identity requires coreSourceRef.");
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

function validateProducer(producer) {
  if (!isRecord(producer) || typeof producer.adapterKind !== "string" || typeof producer.adapterVersion !== "string") {
    throw new Error("Producer requires adapterKind and adapterVersion.");
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
    validateCoreIdentity(artifact.core);
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
  const validFields = [
    verification?.contractVersion === "0.2",
    verification?.gateDecision === "accepted_passed",
    typeof verification?.gateInputSha256 === "string" && /^[a-f0-9]{64}$/.test(verification.gateInputSha256),
    typeof verification?.activeReceiptSha256 === "string" && /^[a-f0-9]{64}$/.test(verification.activeReceiptSha256),
    typeof verification?.sourceFingerprint === "string" && /^[a-f0-9]{64}$/.test(verification.sourceFingerprint),
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
  const root = realpathSync(workspaceRoot);
  if (existsSync(resolve(root, ".owlrunkit"))) throw new Error("Legacy .owlrunkit exists; explicit migration is required before initialization.");
  const runtimeRoot = resolve(root, RUNTIME_ROOT);
  const remainder = relative(root, runtimeRoot);
  if (remainder.startsWith("..") || isAbsolute(remainder)) throw new Error("Runtime root escapes the workspace.");
  mkdirSync(resolve(runtimeRoot, "executions"), { recursive: true });
  const configPath = resolve(runtimeRoot, "config.json");
  const profilesPath = resolve(runtimeRoot, "profiles.json");
  if (!existsSync(configPath)) {
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
      const migrationReceipt = migrateProjectConfig({
        runtimeRoot,
        configPath,
        config,
        migration: "config-v01-to-v02",
      });
      if (!existsSync(profilesPath)) {
        writeFileSync(profilesPath, `${JSON.stringify({ schemaVersion: "OwlCodaRunKitProfilesV1", profiles: [] }, null, 2)}\n`);
      }
      return { status: "upgraded", exitCode: 0, runtimeRoot: RUNTIME_ROOT, core: current, migrationReceipt };
    } else if (config.schemaVersion === "OwlCodaRunKitConfigV2" && config.core?.contractVersion === CONTRACT_VERSION) {
      const migrationReceipt = migrateProjectConfig({
        runtimeRoot,
        configPath,
        config,
        migration: "config-v02-core-refresh",
      });
      if (!existsSync(profilesPath)) {
        writeFileSync(profilesPath, `${JSON.stringify({ schemaVersion: "OwlCodaRunKitProfilesV1", profiles: [] }, null, 2)}\n`);
      }
      return { status: "upgraded", exitCode: 0, runtimeRoot: RUNTIME_ROOT, core: current, migrationReceipt };
    } else {
      throw new Error(`Unsupported project config migration: ${config.schemaVersion ?? "missing schemaVersion"}.`);
    }
  }
  if (!existsSync(profilesPath)) {
    writeFileSync(profilesPath, `${JSON.stringify({ schemaVersion: "OwlCodaRunKitProfilesV1", profiles: [] }, null, 2)}\n`);
  }
  return { status: "initialized", exitCode: 0, runtimeRoot: RUNTIME_ROOT, core: currentCoreIdentity() };
}

export function coreManifest() {
  const identity = currentCoreIdentity();
  return {
    schemaVersion: "OwlCodaRunKitCoreManifestV1",
    ...identity,
    files: [...CORE_FILES],
  };
}
