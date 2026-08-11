import { isIP } from "node:net";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  assertAllowedKeys,
  isRecord,
  safeIdentifier,
  safeRelativePath,
  sha256,
} from "./provenance-common.mjs";
import {
  validateOwnerDeploymentDecisionBindingV1,
} from "./owner-deployment-decision.mjs";

export const REMOTE_DEPLOYMENT_STAGES = Object.freeze([
  "identity_preflight",
  "upload",
  "verify_remote_hashes",
  "install",
  "service",
  "proxy",
  "smoke",
]);

export const SSH_REMOTE_HELPER_PROTOCOL_V1 =
  "OwlCodaRunKitSshRemoteHelperV1";
export const SSH_REMOTE_HELPER_CAPABILITIES_V1 = Object.freeze([
  "execute",
  "reconcile",
]);

const MANIFEST_KEYS = [
  "schemaVersion",
  "deploymentId",
  "deploymentLineageSha256",
  "mode",
  "ownerDecision",
  "serviceActivation",
  "baselineCut",
  "target",
  "adapter",
  "credentialRef",
  "artifact",
  "upload",
  "priorDeployment",
  "expectedRemoteFiles",
  "deletionAllowlist",
];
const TARGET_KEYS = [
  "schemaVersion",
  "targetId",
  "environment",
  "host",
  "port",
  "user",
  "hostKeySha256",
  "machineIdentitySha256",
];
const PROCESS_ADAPTER_KEYS = [
  "kind",
  "adapterId",
  "version",
  "executable",
  "sha256",
];
const BUILTIN_SSH_ADAPTER_KEYS = [
  "kind",
  "adapterId",
  "version",
  "executable",
  "sha256",
  "knownHostsPath",
  "sshExecutable",
  "sshExecutableSha256",
  "remoteHelper",
  "authentication",
  "stageContracts",
];
const REMOTE_HELPER_KEYS = [
  "path",
  "protocol",
  "version",
  "capabilities",
];
const AUTHENTICATION_KEYS = ["mode", "identityFile"];
const IDENTITY_FILE_KEYS = ["path", "sha256"];
const STAGE_CONTRACT_KEYS = ["install", "systemd", "nginx", "smoke"];
const INSTALL_CONTRACT_KEYS = [
  "archiveFormat",
  "releaseRoot",
  "currentSymlink",
];
const SYSTEMD_CONTRACT_KEYS = [
  "unitName",
  "unitFile",
  "daemonReload",
  "enable",
  "restart",
];
const NGINX_CONTRACT_KEYS = [
  "siteName",
  "configFile",
  "enabledLinkPath",
  "configTest",
  "reload",
];
const MANAGED_FILE_KEYS = ["sourcePath", "destinationPath", "sha256"];
const ARTIFACT_KEYS = ["path", "sha256", "size", "mediaType"];
const UPLOAD_KEYS = ["remotePath", "createOnly"];
const PRIOR_KEYS = ["receiptSha256", "artifactSha256"];
const EXPECTED_FILE_KEYS = ["path", "sha256"];
const DELETION_KEYS = ["path", "priorSha256"];
const SHA256 = /^[a-f0-9]{64}$/;
const SECRET_KEY = /(?:password|passwd|secret|token|private[_-]?key|credential)/i;
const CREDENTIAL_REF = /^(?:agent|keychain|vault):[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_HOSTNAME =
  /^(?=.{1,253}\.?$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.?$/u;
const SAFE_REMOTE_PATH =
  /^\/(?:[A-Za-z0-9._@%+=,-]+\/)*[A-Za-z0-9._@%+=,-]+$/u;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/u;
const IDEMPOTENT_REMOTE_STAGES = new Set([
  "identity_preflight",
  "upload",
  "verify_remote_hashes",
  "smoke",
]);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Remote deployment value is not canonical JSON.");
  return encoded;
}

function hashObject(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertExactRemotePath(value, label) {
  if (typeof value !== "string"
    || !value.startsWith("/")
    || value === "/"
    || value.includes("\0")
    || !SAFE_REMOTE_PATH.test(value)
    || path.posix.normalize(value) !== value) {
    throw new Error(
      `${label} must be an exact remote path without shell metacharacters, globs, or traversal.`,
    );
  }
  return value;
}

function hasSecretShapedField(value, { allowCredentialRef = false } = {}) {
  if (Array.isArray(value)) {
    return value.some(item => hasSecretShapedField(item, { allowCredentialRef }));
  }
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    if (allowCredentialRef && key === "credentialRef") return false;
    return SECRET_KEY.test(key)
      || hasSecretShapedField(nested, { allowCredentialRef });
  });
}

export function validateRemoteTarget(target) {
  assertAllowedKeys(target, "Remote target", TARGET_KEYS);
  if (target.schemaVersion !== "OwlCodaRunKitRemoteTargetV1") {
    throw new Error("Unsupported remote target schemaVersion.");
  }
  safeIdentifier(target.targetId, "Remote targetId");
  safeIdentifier(target.environment, "Remote environment");
  if (typeof target.host !== "string"
    || target.host.length === 0
    || (isIP(target.host) === 0 && !SAFE_HOSTNAME.test(target.host))) {
    throw new Error("Remote target host must be an exact host name or address.");
  }
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
    throw new Error("Remote target port must be an integer from 1 to 65535.");
  }
  if (typeof target.user !== "string"
    || !/^[A-Za-z_][A-Za-z0-9._-]*$/.test(target.user)) {
    throw new Error("Remote target user is invalid.");
  }
  assertHash(target.hostKeySha256, "Remote host key");
  assertHash(target.machineIdentitySha256, "Remote machine identity");
  return structuredClone(target);
}

export function validateSshRemoteHelperBindingV1(binding) {
  if (binding === undefined || binding === null) {
    throw new Error("SSH remote helper binding is required.");
  }
  assertAllowedKeys(
    binding,
    "SSH remote helper binding",
    REMOTE_HELPER_KEYS,
  );
  const helperPath = assertExactRemotePath(
    binding.path,
    "SSH remote helper path",
  );
  if (path.posix.basename(helperPath) !== "owlrunkit-remote-helper") {
    throw new Error(
      "SSH remote helper executable name must be owlrunkit-remote-helper.",
    );
  }
  if (binding.protocol !== SSH_REMOTE_HELPER_PROTOCOL_V1) {
    throw new Error("SSH remote helper protocol is unsupported.");
  }
  if (
    typeof binding.version !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(binding.version)
  ) {
    throw new Error("SSH remote helper version must be an exact semantic version.");
  }
  if (
    !Array.isArray(binding.capabilities)
    || binding.capabilities.length
      !== SSH_REMOTE_HELPER_CAPABILITIES_V1.length
    || binding.capabilities.some(
      (capability, index) => (
        capability !== SSH_REMOTE_HELPER_CAPABILITIES_V1[index]
      ),
    )
  ) {
    throw new Error(
      "SSH remote helper capabilities must be exactly execute and reconcile.",
    );
  }
  return {
    path: helperPath,
    protocol: binding.protocol,
    version: binding.version,
    capabilities: [...binding.capabilities],
  };
}

function validateAdapterIdentityFields(adapter) {
  safeIdentifier(adapter.adapterId, "Remote adapterId");
  if (typeof adapter.version !== "string" || adapter.version.length === 0) {
    throw new Error("Remote adapter version is required.");
  }
  if (typeof adapter.executable !== "string" || !path.isAbsolute(adapter.executable)) {
    throw new Error("Remote adapter executable must be absolute.");
  }
  assertHash(adapter.sha256, "Remote adapter");
  return {
    adapterId: adapter.adapterId,
    version: adapter.version,
    executable: adapter.executable,
    sha256: adapter.sha256,
  };
}

function assertAbsoluteLocalPath(value, label) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value.includes("\0")
    || /[\r\n]/u.test(value)
    || path.normalize(value) !== value
  ) {
    throw new Error(`${label} must be an exact absolute local path.`);
  }
  return value;
}

function validateManagedFile(value, label) {
  assertAllowedKeys(value, label, MANAGED_FILE_KEYS);
  return {
    sourcePath: safeRelativePath(value.sourcePath, `${label} sourcePath`),
    destinationPath: assertExactRemotePath(
      value.destinationPath,
      `${label} destinationPath`,
    ),
    sha256: assertHash(value.sha256, `${label} SHA-256`),
  };
}

function validateSshStageContracts(contracts) {
  assertAllowedKeys(contracts, "Built-in SSH stage contracts", STAGE_CONTRACT_KEYS);
  assertAllowedKeys(
    contracts.install,
    "Built-in SSH install contract",
    INSTALL_CONTRACT_KEYS,
  );
  if (contracts.install.archiveFormat !== "tar_gzip") {
    throw new Error("Built-in SSH archiveFormat must be tar_gzip.");
  }
  const install = {
    archiveFormat: "tar_gzip",
    releaseRoot: assertExactRemotePath(
      contracts.install.releaseRoot,
      "Built-in SSH releaseRoot",
    ),
    currentSymlink: assertExactRemotePath(
      contracts.install.currentSymlink,
      "Built-in SSH currentSymlink",
    ),
  };
  assertAllowedKeys(
    contracts.systemd,
    "Built-in SSH systemd contract",
    SYSTEMD_CONTRACT_KEYS,
  );
  if (
    typeof contracts.systemd.unitName !== "string"
    || !SERVICE_NAME.test(contracts.systemd.unitName)
  ) {
    throw new Error("Built-in SSH systemd unitName is invalid.");
  }
  for (const key of ["daemonReload", "enable", "restart"]) {
    if (typeof contracts.systemd[key] !== "boolean") {
      throw new Error(`Built-in SSH systemd ${key} must be boolean.`);
    }
  }
  const systemd = {
    unitName: contracts.systemd.unitName,
    unitFile: validateManagedFile(
      contracts.systemd.unitFile,
      "Built-in SSH systemd unit file",
    ),
    daemonReload: contracts.systemd.daemonReload,
    enable: contracts.systemd.enable,
    restart: contracts.systemd.restart,
  };
  assertAllowedKeys(
    contracts.nginx,
    "Built-in SSH Nginx contract",
    NGINX_CONTRACT_KEYS,
  );
  safeIdentifier(contracts.nginx.siteName, "Built-in SSH Nginx siteName");
  for (const key of ["configTest", "reload"]) {
    if (typeof contracts.nginx[key] !== "boolean") {
      throw new Error(`Built-in SSH Nginx ${key} must be boolean.`);
    }
  }
  const nginx = {
    siteName: contracts.nginx.siteName,
    configFile: validateManagedFile(
      contracts.nginx.configFile,
      "Built-in SSH Nginx config file",
    ),
    enabledLinkPath: assertExactRemotePath(
      contracts.nginx.enabledLinkPath,
      "Built-in SSH Nginx enabledLinkPath",
    ),
    configTest: contracts.nginx.configTest,
    reload: contracts.nginx.reload,
  };
  assertAllowedKeys(contracts.smoke, "Built-in SSH smoke contract", ["checks"]);
  if (!Array.isArray(contracts.smoke.checks)
    || contracts.smoke.checks.length === 0) {
    throw new Error("Built-in SSH smoke contract requires checks.");
  }
  const checks = contracts.smoke.checks.map((check) => {
    if (check?.kind === "systemd_active") {
      assertAllowedKeys(check, "Built-in SSH systemd smoke check", [
        "checkId",
        "kind",
        "unitName",
      ]);
      safeIdentifier(check.checkId, "Built-in SSH smoke checkId");
      if (typeof check.unitName !== "string" || !SERVICE_NAME.test(check.unitName)) {
        throw new Error("Built-in SSH smoke unitName is invalid.");
      }
      return structuredClone(check);
    }
    if (check?.kind === "http") {
      assertAllowedKeys(check, "Built-in SSH HTTP smoke check", [
        "checkId",
        "kind",
        "url",
        "expectedStatus",
      ]);
      safeIdentifier(check.checkId, "Built-in SSH smoke checkId");
      let parsed;
      try {
        parsed = new URL(check.url);
      } catch {
        throw new Error("Built-in SSH smoke URL is invalid.");
      }
      if (
        parsed.protocol !== "http:"
        || !new Set(["127.0.0.1", "[::1]", "localhost"]).has(parsed.hostname)
        || parsed.username !== ""
        || parsed.password !== ""
        || parsed.search !== ""
        || parsed.hash !== ""
        || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(parsed.pathname)
        || !Number.isInteger(check.expectedStatus)
        || check.expectedStatus < 100
        || check.expectedStatus > 599
      ) {
        throw new Error("Built-in SSH HTTP smoke check is invalid.");
      }
      return structuredClone(check);
    }
    throw new Error("Built-in SSH smoke check kind is unsupported.");
  });
  if (new Set(checks.map(check => check.checkId)).size !== checks.length) {
    throw new Error("Built-in SSH smoke checkId values must be unique.");
  }
  return {
    install,
    systemd,
    nginx,
    smoke: { checks },
  };
}

function validateBuiltinSshAdapter(adapter) {
  assertAllowedKeys(
    adapter,
    "Built-in SSH adapter declaration",
    BUILTIN_SSH_ADAPTER_KEYS,
  );
  const identity = validateAdapterIdentityFields(adapter);
  if (
    adapter.kind !== "builtin_ssh"
    || identity.adapterId !== "builtin-ssh-v1"
    || identity.version !== "1.0.0"
  ) {
    throw new Error("Built-in SSH adapter identity is invalid.");
  }
  assertAllowedKeys(
    adapter.authentication,
    "Built-in SSH authentication binding",
    AUTHENTICATION_KEYS,
  );
  let identityFile = null;
  if (adapter.authentication.mode === "agent") {
    if (adapter.authentication.identityFile !== null) {
      throw new Error("Agent SSH authentication cannot declare an identity file.");
    }
  } else if (adapter.authentication.mode === "identity_file") {
    assertAllowedKeys(
      adapter.authentication.identityFile,
      "Built-in SSH identity file binding",
      IDENTITY_FILE_KEYS,
    );
    identityFile = {
      path: assertAbsoluteLocalPath(
        adapter.authentication.identityFile.path,
        "Built-in SSH identity file",
      ),
      sha256: assertHash(
        adapter.authentication.identityFile.sha256,
        "Built-in SSH identity file",
      ),
    };
  } else {
    throw new Error("Built-in SSH authentication mode is invalid.");
  }
  return {
    ...identity,
    kind: "builtin_ssh",
    knownHostsPath: assertAbsoluteLocalPath(
      adapter.knownHostsPath,
      "Built-in SSH known_hosts",
    ),
    sshExecutable: assertAbsoluteLocalPath(
      adapter.sshExecutable,
      "Built-in SSH executable",
    ),
    sshExecutableSha256: assertHash(
      adapter.sshExecutableSha256,
      "Built-in SSH executable",
    ),
    remoteHelper: validateSshRemoteHelperBindingV1(adapter.remoteHelper),
    authentication: {
      mode: adapter.authentication.mode,
      identityFile,
    },
    stageContracts: validateSshStageContracts(adapter.stageContracts),
  };
}

function validateAdapterDeclaration(adapter) {
  if (adapter?.kind === "builtin_ssh") {
    return validateBuiltinSshAdapter(adapter);
  }
  const allowed = adapter?.kind === "process"
    ? PROCESS_ADAPTER_KEYS
    : PROCESS_ADAPTER_KEYS.filter(key => key !== "kind");
  assertAllowedKeys(adapter, "Remote process adapter identity", allowed);
  if (adapter.kind !== undefined && adapter.kind !== "process") {
    throw new Error("Remote adapter kind is unsupported.");
  }
  const identity = validateAdapterIdentityFields(adapter);
  return adapter.kind === "process"
    ? { kind: "process", ...identity }
    : identity;
}

function adapterRuntimeIdentity(adapter) {
  return validateAdapterIdentityFields(adapter);
}

function validateArtifact(artifact) {
  assertAllowedKeys(artifact, "Remote artifact", ARTIFACT_KEYS);
  safeRelativePath(artifact.path, "Remote artifact path");
  assertHash(artifact.sha256, "Remote artifact");
  if (!Number.isInteger(artifact.size) || artifact.size < 0) {
    throw new Error("Remote artifact size must be a non-negative integer.");
  }
  if (typeof artifact.mediaType !== "string"
    || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(artifact.mediaType)) {
    throw new Error("Remote artifact mediaType is invalid.");
  }
  return structuredClone(artifact);
}

function validateExpectedFiles(entries) {
  if (!Array.isArray(entries)) throw new Error("expectedRemoteFiles must be an array.");
  const paths = new Set();
  return entries.map((entry) => {
    assertAllowedKeys(entry, "Expected remote file", EXPECTED_FILE_KEYS);
    const remotePath = assertExactRemotePath(entry.path, "Expected remote file path");
    if (paths.has(remotePath)) throw new Error(`Duplicate expected remote file: ${remotePath}`);
    paths.add(remotePath);
    return { path: remotePath, sha256: assertHash(entry.sha256, "Expected remote file") };
  });
}

function validateDeletionAllowlist(entries, expectedRemoteFiles) {
  if (!Array.isArray(entries)) throw new Error("deletionAllowlist must be an array.");
  const expected = new Map(expectedRemoteFiles.map(entry => [entry.path, entry.sha256]));
  const paths = new Set();
  return entries.map((entry) => {
    assertAllowedKeys(entry, "Deletion allowlist entry", DELETION_KEYS);
    const remotePath = assertExactRemotePath(entry.path, "Deletion allowlist path");
    if (paths.has(remotePath)) throw new Error(`Duplicate deletion allowlist path: ${remotePath}`);
    paths.add(remotePath);
    const priorSha256 = assertHash(entry.priorSha256, "Deletion prior hash");
    if (expected.get(remotePath) !== priorSha256) {
      throw new Error(`Deletion allowlist entry does not match the expected prior hash: ${remotePath}`);
    }
    return { path: remotePath, priorSha256 };
  });
}

function normalizeRemoteDeploymentManifest(
  manifest,
  { allowUnboundLineage = false } = {},
) {
  if (hasSecretShapedField(manifest, { allowCredentialRef: true })) {
    throw new Error("Remote deployment manifest contains secret material.");
  }
  assertAllowedKeys(manifest, "Remote deployment manifest", MANIFEST_KEYS);
  if (manifest.schemaVersion !== "OwlCodaRunKitRemoteDeploymentManifestV1") {
    throw new Error("Unsupported remote deployment manifest schemaVersion.");
  }
  safeIdentifier(manifest.deploymentId, "Remote deploymentId");
  const deploymentLineageSha256 = allowUnboundLineage
    && manifest.deploymentLineageSha256 === null
    ? null
    : assertHash(manifest.deploymentLineageSha256, "Deployment lineage");
  if (!new Set(["first", "update"]).has(manifest.mode)) {
    throw new Error("Remote deployment mode must be first or update.");
  }
  const target = validateRemoteTarget(manifest.target);
  const adapter = validateAdapterDeclaration(manifest.adapter);
  if (typeof manifest.credentialRef !== "string"
    || !CREDENTIAL_REF.test(manifest.credentialRef)) {
    throw new Error("Remote deployment credentialRef must be an opaque credential reference.");
  }
  const artifact = validateArtifact(manifest.artifact);
  assertAllowedKeys(manifest.upload, "Remote upload", UPLOAD_KEYS);
  const upload = {
    remotePath: assertExactRemotePath(manifest.upload.remotePath, "Remote upload path"),
    createOnly: manifest.upload.createOnly,
  };
  if (upload.createOnly !== true) {
    throw new Error("Remote deployment upload must be create-only.");
  }
  const expectedRemoteFiles = validateExpectedFiles(manifest.expectedRemoteFiles);
  let priorDeployment = null;
  if (manifest.mode === "first") {
    if (manifest.priorDeployment !== null) {
      throw new Error("First deployment priorDeployment must be null.");
    }
    if (expectedRemoteFiles.length > 0 || manifest.deletionAllowlist.length > 0) {
      throw new Error("First deployment cannot declare prior files or deletions.");
    }
  } else {
    if (!isRecord(manifest.priorDeployment)) {
      throw new Error("Update deployment priorDeployment must be an object.");
    }
    assertAllowedKeys(manifest.priorDeployment, "Prior deployment", PRIOR_KEYS);
    priorDeployment = {
      receiptSha256: assertHash(
        manifest.priorDeployment.receiptSha256,
        "Prior deployment receipt",
      ),
      artifactSha256: assertHash(
        manifest.priorDeployment.artifactSha256,
        "Prior deployment artifact",
      ),
    };
    if (expectedRemoteFiles.length === 0) {
      throw new Error("Update deployment requires expected prior remote file hashes.");
    }
  }
  const deletionAllowlist = validateDeletionAllowlist(
    manifest.deletionAllowlist,
    expectedRemoteFiles,
  );
  const ownerDecision = manifest.ownerDecision === undefined
    ? null
    : validateOwnerDeploymentDecisionBindingV1(manifest.ownerDecision);
  for (const field of ["serviceActivation", "baselineCut"]) {
    if (manifest[field] !== undefined && typeof manifest[field] !== "boolean") {
      throw new Error(`Remote deployment ${field} must be boolean when declared.`);
    }
  }
  return {
    status: "valid",
    normalized: {
      schemaVersion: manifest.schemaVersion,
      deploymentId: manifest.deploymentId,
      deploymentLineageSha256,
      mode: manifest.mode,
      ...(ownerDecision === null ? {} : { ownerDecision }),
      ...(manifest.serviceActivation === undefined
        ? {}
        : { serviceActivation: manifest.serviceActivation }),
      ...(manifest.baselineCut === undefined
        ? {}
        : { baselineCut: manifest.baselineCut }),
      target,
      adapter,
      credentialRef: manifest.credentialRef,
      artifact,
      upload,
      priorDeployment,
      expectedRemoteFiles,
      deletionAllowlist,
    },
  };
}

export function validateRemoteDeploymentManifest(manifest) {
  return normalizeRemoteDeploymentManifest(manifest);
}

export function canonicalRemoteDeploymentIntentSha256(manifest) {
  const { normalized } = normalizeRemoteDeploymentManifest(
    manifest,
    { allowUnboundLineage: true },
  );
  if (normalized.deploymentLineageSha256 !== null) {
    throw new Error(
      "Remote deployment intent must leave deploymentLineageSha256 unbound.",
    );
  }
  const {
    deploymentLineageSha256: _derivedLineage,
    ...intent
  } = normalized;
  return hashObject(intent);
}

function identitiesEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function writeCreateOnlyJson(filePath, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, bytes, { flag: "wx" });
  return sha256(Buffer.from(bytes, "utf8"));
}

function readJournalArtifact(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular create-only artifact.`);
  }
  const bytes = readFileSync(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  return { value, bytes, sha256: sha256(bytes) };
}

function journalFileName(stage, operation, attempt, phase) {
  const ordinal = String(REMOTE_DEPLOYMENT_STAGES.indexOf(stage) + 1)
    .padStart(2, "0");
  return `${ordinal}-${stage}-${operation}-attempt-${String(attempt)
    .padStart(3, "0")}-${phase}.json`;
}

function assertJournalBinding(binding) {
  assertAllowedKeys(binding, "Remote deployment journal binding", [
    "deploymentId",
    "deploymentLineageSha256",
    "remoteManifestSha256",
    "executeRequestSha256",
    "adapterIdentity",
  ]);
  safeIdentifier(binding.deploymentId, "Remote deployment journal deploymentId");
  assertHash(
    binding.deploymentLineageSha256,
    "Remote deployment journal lineage",
  );
  assertHash(
    binding.remoteManifestSha256,
    "Remote deployment journal manifest",
  );
  assertHash(
    binding.executeRequestSha256,
    "Remote deployment journal execute request",
  );
  const adapterIdentity = validateAdapterIdentityFields(binding.adapterIdentity);
  const body = {
    schemaVersion: "OwlCodaRunKitRemoteDeploymentJournalBindingV1",
    deploymentId: binding.deploymentId,
    deploymentLineageSha256: binding.deploymentLineageSha256,
    remoteManifestSha256: binding.remoteManifestSha256,
    executeRequestSha256: binding.executeRequestSha256,
    adapterIdentity,
    adapterIdentitySha256: hashObject(adapterIdentity),
    authorizationGranted: false,
  };
  return { ...body, bindingSha256: hashObject(body) };
}

function invocationFiles(root, stage, operation) {
  const prefix = `${String(REMOTE_DEPLOYMENT_STAGES.indexOf(stage) + 1)
    .padStart(2, "0")}-${stage}-${operation}-attempt-`;
  const names = readdirSync(root);
  const beforeNames = names
    .filter(name => name.startsWith(prefix) && name.endsWith("-before.json"));
  const beforeNameSet = new Set(beforeNames);
  for (const afterName of names.filter(
    name => name.startsWith(prefix) && name.endsWith("-after.json"),
  )) {
    const beforeName = afterName.replace(/-after\.json$/u, "-before.json");
    if (!beforeNameSet.has(beforeName)) {
      throw new Error("Remote deployment stage journal has an orphan after artifact.");
    }
  }
  const files = beforeNames
    .sort()
    .map((name) => {
      const match = name.match(/-attempt-(\d{3})-before\.json$/u);
      if (!match) throw new Error("Remote deployment journal filename is invalid.");
      const attempt = Number.parseInt(match[1], 10);
      const beforePath = path.join(root, name);
      const afterPath = path.join(
        root,
        journalFileName(stage, operation, attempt, "after"),
      );
      return { attempt, beforePath, afterPath };
    });
  if (files.some((entry, index) => entry.attempt !== index + 1)) {
    throw new Error("Remote deployment stage journal attempts are not contiguous.");
  }
  return files;
}

export function createRemoteDeploymentStageJournalV1({
  journalRoot,
  binding,
}) {
  if (typeof journalRoot !== "string" || !path.isAbsolute(journalRoot)) {
    throw new Error("Remote deployment journal root must be absolute.");
  }
  mkdirSync(journalRoot, { recursive: true });
  const rootStat = lstatSync(journalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Remote deployment journal root must be a real directory.");
  }
  const root = realpathSync(journalRoot);
  const normalizedBinding = assertJournalBinding(binding);
  const bindingPath = path.join(root, "journal-binding.json");
  if (existsSync(bindingPath)) {
    const existing = readJournalArtifact(
      bindingPath,
      "Remote deployment journal binding",
    ).value;
    if (!identitiesEqual(existing, normalizedBinding)) {
      throw new Error("Remote deployment journal binding drifted.");
    }
  } else {
    writeCreateOnlyJson(bindingPath, normalizedBinding);
  }

  function validateBefore(value, stage, operation) {
    assertAllowedKeys(value, "Remote deployment stage before journal", [
      "schemaVersion",
      "bindingSha256",
      "deploymentId",
      "deploymentLineageSha256",
      "remoteManifestSha256",
      "executeRequestSha256",
      "adapterIdentitySha256",
      "stage",
      "stageOrdinal",
      "operation",
      "attempt",
      "status",
      "authorizationGranted",
      "journalSha256",
    ]);
    if (
      value?.schemaVersion !== "OwlCodaRunKitRemoteStageInvocationBeforeV1"
      || value.bindingSha256 !== normalizedBinding.bindingSha256
      || value.deploymentId !== normalizedBinding.deploymentId
      || value.deploymentLineageSha256
        !== normalizedBinding.deploymentLineageSha256
      || value.remoteManifestSha256
        !== normalizedBinding.remoteManifestSha256
      || value.executeRequestSha256
        !== normalizedBinding.executeRequestSha256
      || value.adapterIdentitySha256
        !== normalizedBinding.adapterIdentitySha256
      || value.stage !== stage
      || value.stageOrdinal !== REMOTE_DEPLOYMENT_STAGES.indexOf(stage) + 1
      || value.operation !== operation
      || !Number.isSafeInteger(value.attempt)
      || value.attempt < 1
      || value.status !== "invocation_started"
      || value.authorizationGranted !== false
    ) {
      throw new Error("Remote deployment stage before journal is invalid.");
    }
    const { journalSha256, ...body } = value;
    if (journalSha256 !== hashObject(body)) {
      throw new Error("Remote deployment stage before journal hash drifted.");
    }
  }

  function validateAfter(value, before, stage, operation) {
    assertAllowedKeys(value, "Remote deployment stage after journal", [
      "schemaVersion",
      "bindingSha256",
      "beforeJournalSha256",
      "stage",
      "operation",
      "attempt",
      "outcome",
      "stageReceipt",
      "recoveredByJournalSha256",
      "authorizationGranted",
      "journalSha256",
    ]);
    const { journalSha256, ...afterBody } = value;
    if (
      value?.schemaVersion !== "OwlCodaRunKitRemoteStageInvocationAfterV1"
      || value.bindingSha256 !== normalizedBinding.bindingSha256
      || value.beforeJournalSha256 !== before.journalSha256
      || value.stage !== stage
      || value.operation !== operation
      || value.attempt !== before.attempt
      || !new Set(["completed", "indeterminate"]).has(value.outcome)
      || value.authorizationGranted !== false
      || journalSha256 !== hashObject(afterBody)
    ) {
      throw new Error("Remote deployment stage after journal is invalid.");
    }
  }

  function readValidatedInvocationHistory(stage, operation) {
    const files = invocationFiles(root, stage, operation);
    return files.map((entry) => {
      const before = readJournalArtifact(
        entry.beforePath,
        "Remote deployment stage before journal",
      ).value;
      validateBefore(before, stage, operation);
      let after = null;
      if (existsSync(entry.afterPath)) {
        after = readJournalArtifact(
          entry.afterPath,
          "Remote deployment stage after journal",
        ).value;
        validateAfter(after, before, stage, operation);
      }
      return { ...entry, before, after };
    });
  }

  function readState(stage, operation = "execute") {
    const validated = readValidatedInvocationHistory(stage, operation);
    if (operation === "execute") {
      readValidatedInvocationHistory(stage, "reconcile");
    }
    if (validated.length === 0) return { status: "none" };
    const latest = validated.at(-1);
    const before = latest.before;
    if (operation === "execute") {
      const recoveryPrefix = `${String(
        REMOTE_DEPLOYMENT_STAGES.indexOf(stage) + 1,
      ).padStart(2, "0")}-${stage}-recovery-attempt-`;
      const recoveryNames = readdirSync(root)
        .filter(name => (
          name.startsWith(recoveryPrefix)
          && name.endsWith(".json")
        ))
        .sort();
      if (recoveryNames.length > 0) {
        const recovery = readJournalArtifact(
          path.join(root, recoveryNames.at(-1)),
          "Remote deployment stage recovery journal",
        ).value;
        assertAllowedKeys(
          recovery,
          "Remote deployment stage recovery journal",
          [
            "schemaVersion",
            "bindingSha256",
            "stage",
            "attempt",
            "executeBeforeJournalSha256",
            "reconciliationAfterJournalSha256",
            "status",
            "stageReceipt",
            "authorizationGranted",
            "journalSha256",
          ],
        );
        const { journalSha256, ...recoveryBody } = recovery;
        if (
          recovery?.schemaVersion
            !== "OwlCodaRunKitRemoteStageRecoveryV1"
          || recovery.bindingSha256 !== normalizedBinding.bindingSha256
          || recovery.stage !== stage
          || recovery.executeBeforeJournalSha256 !== before.journalSha256
          || !SHA256.test(recovery.reconciliationAfterJournalSha256)
          || recovery.status !== "state_proven_consistent"
          || recovery.authorizationGranted !== false
          || journalSha256 !== hashObject(recoveryBody)
        ) {
          throw new Error("Remote deployment stage recovery journal is invalid.");
        }
        return {
          status: "completed",
          operation,
          before,
          recovery,
          stageReceipt: structuredClone(recovery.stageReceipt),
        };
      }
    }
    if (latest.after === null) {
      return {
        status: "interrupted",
        operation,
        before,
      };
    }
    const after = latest.after;
    return {
      status: after.outcome === "completed"
        ? "completed"
        : "indeterminate",
      operation,
      before,
      after,
      stageReceipt: structuredClone(after.stageReceipt),
    };
  }

  return {
    binding: structuredClone(normalizedBinding),
    journalRoot: root,
    readStageState(stage) {
      if (!REMOTE_DEPLOYMENT_STAGES.includes(stage)) {
        throw new Error("Remote deployment journal stage is invalid.");
      }
      return readState(stage, "execute");
    },
    beginInvocation({ stage, operation }) {
      if (
        !REMOTE_DEPLOYMENT_STAGES.includes(stage)
        || !new Set(["execute", "reconcile"]).has(operation)
      ) {
        throw new Error("Remote deployment journal invocation is invalid.");
      }
      const attempt = invocationFiles(root, stage, operation).length + 1;
      const body = {
        schemaVersion: "OwlCodaRunKitRemoteStageInvocationBeforeV1",
        bindingSha256: normalizedBinding.bindingSha256,
        deploymentId: normalizedBinding.deploymentId,
        deploymentLineageSha256:
          normalizedBinding.deploymentLineageSha256,
        remoteManifestSha256: normalizedBinding.remoteManifestSha256,
        executeRequestSha256: normalizedBinding.executeRequestSha256,
        adapterIdentitySha256: normalizedBinding.adapterIdentitySha256,
        stage,
        stageOrdinal: REMOTE_DEPLOYMENT_STAGES.indexOf(stage) + 1,
        operation,
        attempt,
        status: "invocation_started",
        authorizationGranted: false,
      };
      const before = { ...body, journalSha256: hashObject(body) };
      writeCreateOnlyJson(
        path.join(root, journalFileName(stage, operation, attempt, "before")),
        before,
      );
      return before;
    },
    completeInvocation({
      stage,
      operation,
      before,
      outcome,
      stageReceipt,
      recoveredByJournalSha256 = null,
    }) {
      validateBefore(before, stage, operation);
      if (!new Set(["completed", "indeterminate"]).has(outcome)) {
        throw new Error("Remote deployment journal outcome is invalid.");
      }
      const body = {
        schemaVersion: "OwlCodaRunKitRemoteStageInvocationAfterV1",
        bindingSha256: normalizedBinding.bindingSha256,
        beforeJournalSha256: before.journalSha256,
        stage,
        operation,
        attempt: before.attempt,
        outcome,
        stageReceipt: structuredClone(stageReceipt),
        ...(recoveredByJournalSha256
          ? { recoveredByJournalSha256 }
          : {}),
        authorizationGranted: false,
      };
      const after = { ...body, journalSha256: hashObject(body) };
      writeCreateOnlyJson(
        path.join(
          root,
          journalFileName(stage, operation, before.attempt, "after"),
        ),
        after,
      );
      return after;
    },
    recoverInvocation({
      stage,
      executeBefore,
      reconciliationAfter,
      stageReceipt,
    }) {
      validateBefore(executeBefore, stage, "execute");
      if (
        reconciliationAfter?.schemaVersion
          !== "OwlCodaRunKitRemoteStageInvocationAfterV1"
        || reconciliationAfter.stage !== stage
        || reconciliationAfter.operation !== "reconcile"
        || reconciliationAfter.outcome !== "completed"
        || !SHA256.test(reconciliationAfter.journalSha256)
      ) {
        throw new Error(
          "Remote deployment recovery requires an exact completed reconciliation journal.",
        );
      }
      const recoveryPrefix = `${String(
        REMOTE_DEPLOYMENT_STAGES.indexOf(stage) + 1,
      ).padStart(2, "0")}-${stage}-recovery-attempt-`;
      const attempt = readdirSync(root)
        .filter(name => name.startsWith(recoveryPrefix))
        .length + 1;
      const body = {
        schemaVersion: "OwlCodaRunKitRemoteStageRecoveryV1",
        bindingSha256: normalizedBinding.bindingSha256,
        stage,
        attempt,
        executeBeforeJournalSha256: executeBefore.journalSha256,
        reconciliationAfterJournalSha256:
          reconciliationAfter.journalSha256,
        status: "state_proven_consistent",
        stageReceipt: structuredClone(stageReceipt),
        authorizationGranted: false,
      };
      const recovery = { ...body, journalSha256: hashObject(body) };
      writeCreateOnlyJson(
        path.join(
          root,
          `${recoveryPrefix}${String(attempt).padStart(3, "0")}.json`,
        ),
        recovery,
      );
      return recovery;
    },
  };
}

function failure(stage, failureCode, evidenceSha256 = null) {
  return {
    ok: false,
    stageReceipt: {
      stage,
      status: "failed",
      failureCode,
      ...(evidenceSha256 ? { evidenceSha256 } : {}),
    },
  };
}

function normalizeStageResult(stage, result, manifest) {
  if (!isRecord(result)) return failure(stage, "stage_result_invalid");
  if (hasSecretShapedField(result)) return failure(stage, "secret_material_forbidden");
  if (result.status === "indeterminate") {
    try {
      assertAllowedKeys(result, `${stage} indeterminate result`, [
        "status",
        "failureCode",
        "evidenceSha256",
      ]);
      safeIdentifier(result.failureCode, `${stage} failureCode`);
      if (result.evidenceSha256 !== undefined) {
        assertHash(result.evidenceSha256, `${stage} failure evidence`);
      }
      return {
        ...failure(stage, result.failureCode, result.evidenceSha256),
        indeterminate: true,
      };
    } catch {
      return failure(stage, "stage_result_invalid");
    }
  }
  if (result.status === "failed") {
    try {
      assertAllowedKeys(result, `${stage} result`, [
        "status",
        "failureCode",
        "evidenceSha256",
      ]);
      safeIdentifier(result.failureCode, `${stage} failureCode`);
      if (result.evidenceSha256 !== undefined) {
        assertHash(result.evidenceSha256, `${stage} failure evidence`);
      }
      return failure(stage, result.failureCode, result.evidenceSha256);
    } catch {
      return failure(stage, "stage_result_invalid");
    }
  }
  try {
    if (stage === "identity_preflight") {
      assertAllowedKeys(result, "identity_preflight result", [
        "status",
        "hostKeySha256",
        "machineIdentitySha256",
        "remoteHelper",
      ]);
      if (result.status !== "passed") return failure(stage, "target_identity_preflight_failed");
      assertHash(result.hostKeySha256, "Observed remote host key");
      assertHash(result.machineIdentitySha256, "Observed remote machine identity");
      if (result.hostKeySha256 !== manifest.target.hostKeySha256
        || result.machineIdentitySha256 !== manifest.target.machineIdentitySha256) {
        return failure(stage, "target_identity_mismatch");
      }
      const expectedRemoteHelper = manifest.adapter.kind === "builtin_ssh"
        ? manifest.adapter.remoteHelper
        : null;
      if (
        expectedRemoteHelper !== null
        && (
          !isRecord(result.remoteHelper)
          || canonicalJson(result.remoteHelper)
            !== canonicalJson(expectedRemoteHelper)
        )
      ) {
        return failure(stage, "remote_helper_capability_mismatch");
      }
      if (
        expectedRemoteHelper === null
        && result.remoteHelper !== undefined
      ) {
        return failure(stage, "stage_result_invalid");
      }
      return {
        ok: true,
        stageReceipt: {
          stage,
          status: "passed",
          hostKeySha256: result.hostKeySha256,
          machineIdentitySha256: result.machineIdentitySha256,
          ...(expectedRemoteHelper
            ? { remoteHelper: structuredClone(expectedRemoteHelper) }
            : {}),
        },
      };
    }
    if (stage === "upload") {
      assertAllowedKeys(result, "upload result", [
        "status",
        "remotePath",
        "sha256",
        "size",
      ]);
      if (!new Set(["created", "already_present"]).has(result.status)
        || result.remotePath !== manifest.upload.remotePath
        || result.sha256 !== manifest.artifact.sha256
        || result.size !== manifest.artifact.size) {
        return failure(stage, "create_only_upload_conflict");
      }
      return {
        ok: true,
        stageReceipt: {
          stage,
          status: result.status,
          remotePath: result.remotePath,
          sha256: result.sha256,
          size: result.size,
        },
      };
    }
    if (stage === "verify_remote_hashes") {
      assertAllowedKeys(result, "verify_remote_hashes result", [
        "status",
        "remotePath",
        "sha256",
        "size",
      ]);
      if (result.status !== "passed"
        || result.remotePath !== manifest.upload.remotePath
        || result.sha256 !== manifest.artifact.sha256
        || result.size !== manifest.artifact.size) {
        return failure(stage, "remote_artifact_hash_mismatch");
      }
      return {
        ok: true,
        stageReceipt: {
          stage,
          status: "passed",
          remotePath: result.remotePath,
          sha256: result.sha256,
          size: result.size,
        },
      };
    }
    assertAllowedKeys(result, `${stage} result`, ["status", "evidenceSha256"]);
    if (result.status !== "passed") return failure(stage, `${stage}_failed`);
    assertHash(result.evidenceSha256, `${stage} evidence`);
    return {
      ok: true,
      stageReceipt: {
        stage,
        status: "passed",
        evidenceSha256: result.evidenceSha256,
      },
    };
  } catch {
    return failure(stage, "stage_result_invalid");
  }
}

function resultArtifact(manifest, adapterIdentity, state) {
  const status = state.reconciliationRequired
    ? "reconciliation_required"
    : state.failureCode
      ? "failed"
      : "deployed";
  const body = {
    schemaVersion: "OwlCodaRunKitRemoteDeploymentResultV1",
    deploymentId: manifest.deploymentId,
    deploymentLineageSha256: manifest.deploymentLineageSha256,
    mode: manifest.mode,
    target: manifest.target,
    adapter: adapterIdentity,
    artifact: manifest.artifact,
    status,
    completedStages: state.completedStages,
    stoppedAtStage: state.stoppedAtStage,
    ...(state.failureCode ? { failureCode: state.failureCode } : {}),
    stageReceipts: state.stageReceipts,
    deletionAllowlistSha256: hashObject(manifest.deletionAllowlist),
    authorizationGranted: false,
  };
  return { ...body, resultSha256: hashObject(body) };
}

function remoteStageInput(stage, manifest, permissions) {
  return {
    stage,
    deploymentId: manifest.deploymentId,
    deploymentLineageSha256: manifest.deploymentLineageSha256,
    mode: manifest.mode,
    ...(manifest.ownerDecision === undefined
      ? {}
      : { ownerDecision: structuredClone(manifest.ownerDecision) }),
    ...(manifest.serviceActivation === undefined
      ? {}
      : { serviceActivation: manifest.serviceActivation }),
    ...(manifest.baselineCut === undefined
      ? {}
      : { baselineCut: manifest.baselineCut }),
    target: structuredClone(manifest.target),
    artifact: structuredClone(manifest.artifact),
    upload: structuredClone(manifest.upload),
    priorDeployment: structuredClone(manifest.priorDeployment),
    expectedRemoteFiles: structuredClone(manifest.expectedRemoteFiles),
    deletionAllowlist: structuredClone(manifest.deletionAllowlist),
    permissions: structuredClone(permissions),
    credentialRef: manifest.credentialRef,
  };
}

function normalizePersistedStageReceipt(stage, receipt, manifest) {
  if (!isRecord(receipt) || receipt.stage !== stage) {
    return failure(stage, "stage_journal_receipt_invalid");
  }
  const { stage: _stage, ...rawResult } = receipt;
  return normalizeStageResult(stage, rawResult, manifest);
}

function reconciliationRequiredArtifact({
  manifest,
  adapterIdentity,
  completedStages,
  stageReceipts,
  stage,
}) {
  return resultArtifact(manifest, adapterIdentity, {
    completedStages,
    stoppedAtStage: stage,
    failureCode: "remote_stage_reconciliation_required",
    reconciliationRequired: true,
    stageReceipts: [
      ...stageReceipts,
      {
        stage,
        status: "failed",
        failureCode: "remote_stage_reconciliation_required",
      },
    ],
  });
}

export async function executeRemoteDeployment({
  manifest,
  adapter,
  permissions,
  beforeStageGuard,
  stageJournal = null,
}) {
  const validation = validateRemoteDeploymentManifest(manifest);
  const normalized = validation.normalized;
  assertAllowedKeys(permissions, "Deployment permissions", [
    "deploy",
    "destructive",
  ]);
  if (
    permissions.deploy !== true
    || typeof permissions.destructive !== "boolean"
  ) {
    throw new Error("Deployment permissions must explicitly grant deploy and state destructive permission.");
  }
  if (
    permissions.destructive === false
    && normalized.deletionAllowlist.length > 0
  ) {
    throw new Error("destructive=false forbids every declared remote deletion.");
  }
  if (!isRecord(adapter) || typeof adapter.runStage !== "function") {
    throw new Error("Remote deployment requires an injected typed adapter.");
  }
  if (typeof beforeStageGuard !== "function") {
    throw new Error("Remote deployment requires a control guard.");
  }
  const adapterIdentity = validateAdapterIdentityFields(adapter.identity);
  if (!identitiesEqual(adapterIdentity, adapterRuntimeIdentity(normalized.adapter))) {
    throw new Error("Injected remote adapter identity does not match the manifest.");
  }
  if (stageJournal !== null) {
    if (
      !isRecord(stageJournal)
      || typeof stageJournal.readStageState !== "function"
      || typeof stageJournal.beginInvocation !== "function"
      || typeof stageJournal.completeInvocation !== "function"
      || typeof stageJournal.recoverInvocation !== "function"
      || stageJournal.binding?.deploymentId !== normalized.deploymentId
      || stageJournal.binding?.deploymentLineageSha256
        !== normalized.deploymentLineageSha256
      || !identitiesEqual(
        stageJournal.binding?.adapterIdentity,
        adapterIdentity,
      )
    ) {
      throw new Error(
        "Remote deployment stage journal does not bind the exact deployment and adapter.",
      );
    }
  }
  const completedStages = [];
  const stageReceipts = [];
  for (const stage of REMOTE_DEPLOYMENT_STAGES) {
    try {
      await beforeStageGuard({ stage });
    } catch (error) {
      const failureCode = error?.code === "owner_decision_superseded"
        ? "owner_decision_superseded"
        : "deployment_control_guard_failed";
      return resultArtifact(normalized, adapterIdentity, {
        completedStages,
        stoppedAtStage: stage,
        failureCode,
        stageReceipts: [
          ...stageReceipts,
          {
            stage,
            status: "failed",
            failureCode,
          },
        ],
      });
    }

    const priorState = stageJournal?.readStageState(stage) ?? {
      status: "none",
    };
    if (priorState.status === "completed") {
      const persisted = normalizePersistedStageReceipt(
        stage,
        priorState.stageReceipt,
        normalized,
      );
      stageReceipts.push(persisted.stageReceipt);
      if (!persisted.ok) {
        return resultArtifact(normalized, adapterIdentity, {
          completedStages,
          stoppedAtStage: stage,
          failureCode: persisted.stageReceipt.failureCode,
          stageReceipts,
        });
      }
      completedStages.push(stage);
      continue;
    }

    const stageInput = remoteStageInput(stage, normalized, permissions);
    if (
      priorState.status === "interrupted"
      || priorState.status === "indeterminate"
    ) {
      let reconciliation = null;
      let reconciliationAfter = null;
      if (typeof adapter.reconcileStage === "function") {
        const reconciliationBefore = stageJournal.beginInvocation({
          stage,
          operation: "reconcile",
        });
        try {
          const rawReconciliation = await adapter.reconcileStage(stageInput);
          reconciliation = normalizeStageResult(
            stage,
            rawReconciliation,
            normalized,
          );
          reconciliationAfter = stageJournal.completeInvocation({
            stage,
            operation: "reconcile",
            before: reconciliationBefore,
            outcome: "completed",
            stageReceipt: reconciliation.stageReceipt,
          });
        } catch {
          reconciliation = null;
          reconciliationAfter = stageJournal.completeInvocation({
            stage,
            operation: "reconcile",
            before: reconciliationBefore,
            outcome: "indeterminate",
            stageReceipt: {
              stage,
              status: "failed",
              failureCode: "reconciliation_probe_threw",
            },
          });
        }
      }
      if (reconciliation?.ok) {
        stageJournal.recoverInvocation({
          stage,
          executeBefore: priorState.before,
          reconciliationAfter,
          stageReceipt: reconciliation.stageReceipt,
        });
        stageReceipts.push(reconciliation.stageReceipt);
        completedStages.push(stage);
        continue;
      }
      if (!IDEMPOTENT_REMOTE_STAGES.has(stage)) {
        return reconciliationRequiredArtifact({
          manifest: normalized,
          adapterIdentity,
          completedStages,
          stageReceipts,
          stage,
        });
      }
    }

    const executionBefore = stageJournal?.beginInvocation({
      stage,
      operation: "execute",
    }) ?? null;
    let rawResult;
    try {
      rawResult = await adapter.runStage(stageInput);
    } catch {
      if (stageJournal) {
        stageJournal.completeInvocation({
          stage,
          operation: "execute",
          before: executionBefore,
          outcome: "indeterminate",
          stageReceipt: {
            stage,
            status: "failed",
            failureCode: "adapter_stage_threw",
          },
        });
        return reconciliationRequiredArtifact({
          manifest: normalized,
          adapterIdentity,
          completedStages,
          stageReceipts,
          stage,
        });
      }
      return resultArtifact(normalized, adapterIdentity, {
        completedStages,
        stoppedAtStage: stage,
        failureCode: "adapter_stage_threw",
        stageReceipts: [
          ...stageReceipts,
          { stage, status: "failed", failureCode: "adapter_stage_threw" },
        ],
      });
    }
    const checked = normalizeStageResult(stage, rawResult, normalized);
    if (stageJournal) {
      stageJournal.completeInvocation({
        stage,
        operation: "execute",
        before: executionBefore,
        outcome: checked.indeterminate ? "indeterminate" : "completed",
        stageReceipt: checked.stageReceipt,
      });
    }
    if (checked.indeterminate && stageJournal) {
      return reconciliationRequiredArtifact({
        manifest: normalized,
        adapterIdentity,
        completedStages,
        stageReceipts,
        stage,
      });
    }
    stageReceipts.push(checked.stageReceipt);
    if (!checked.ok) {
      return resultArtifact(normalized, adapterIdentity, {
        completedStages,
        stoppedAtStage: stage,
        failureCode: checked.stageReceipt.failureCode,
        stageReceipts,
      });
    }
    completedStages.push(stage);
  }
  return resultArtifact(normalized, adapterIdentity, {
    completedStages,
    stoppedAtStage: null,
    failureCode: null,
    stageReceipts,
  });
}
