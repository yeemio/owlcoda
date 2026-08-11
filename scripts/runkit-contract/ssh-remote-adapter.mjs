import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REMOTE_DEPLOYMENT_STAGES,
  SSH_REMOTE_HELPER_PROTOCOL_V1,
  validateSshRemoteHelperBindingV1,
  validateRemoteTarget,
} from "./remote-deployment.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]*\.service$/u;
const SAFE_REMOTE_PATH =
  /^\/(?:[A-Za-z0-9._@%+=,-]+\/)*[A-Za-z0-9._@%+=,-]+$/u;
const SAFE_RELATIVE_PATH =
  /^(?:[A-Za-z0-9._@%+=,-]+\/)*[A-Za-z0-9._@%+=,-]+$/u;
const SAFE_ENV_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SSH_AUTH_SOCK",
  "SystemRoot",
  "TMPDIR",
  "USER",
  "WINDIR",
];
const MODULE_PATH = fileURLToPath(import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, label) {
  if (!isRecord(value)) throw new Error(`${label} must be a structured object.`);
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported field: ${unsupported.join(", ")}`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertAbsoluteLocalPath(value, label) {
  if (
    typeof value !== "string"
    || !path.isAbsolute(value)
    || value.includes("\0")
    || /[\r\n]/u.test(value)
  ) {
    throw new Error(`${label} must be an absolute local path.`);
  }
  return path.normalize(value);
}

function assertRemotePath(value, label) {
  if (
    typeof value !== "string"
    || value === "/"
    || !SAFE_REMOTE_PATH.test(value)
    || path.posix.normalize(value) !== value
  ) {
    throw new Error(`${label} must be an exact remote path.`);
  }
  return value;
}

function assertRelativePath(value, label) {
  if (
    typeof value !== "string"
    || !SAFE_RELATIVE_PATH.test(value)
    || path.posix.normalize(value) !== value
  ) {
    throw new Error(`${label} must be an exact relative path.`);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("SSH adapter value is not canonical JSON.");
  return encoded;
}

function sameValue(left, right) {
  return canonical(left) === canonical(right);
}

function regularFile(filePath, label) {
  const requested = assertAbsoluteLocalPath(filePath, label);
  const requestedStat = lstatSync(requested);
  if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  const resolved = realpathSync(requested);
  const resolvedStat = lstatSync(resolved);
  if (resolvedStat.isSymbolicLink() || !resolvedStat.isFile()) {
    throw new Error(`${label} must resolve to a regular file.`);
  }
  return resolved;
}

function realDirectory(directoryPath, label) {
  const requested = assertAbsoluteLocalPath(directoryPath, label);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory.`);
  }
  return realpathSync(requested);
}

function constrainedEnvironment() {
  return Object.fromEntries(
    SAFE_ENV_KEYS
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
}

function failure(failureCode, evidence = failureCode) {
  return {
    status: "failed",
    failureCode,
    evidenceSha256: sha256(
      typeof evidence === "string" ? evidence : canonical(evidence),
    ),
  };
}

function indeterminate(failureCode, evidence = failureCode) {
  return {
    ...failure(failureCode, evidence),
    status: "indeterminate",
  };
}

function validateCredential(credential) {
  assertExactKeys(
    credential,
    ["ref", "mode", "identityFile"],
    "SSH credential binding",
  );
  if (
    typeof credential.ref !== "string"
    || !/^(?:agent|keychain|vault):[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(
      credential.ref,
    )
  ) {
    throw new Error("SSH credential ref must be an opaque credential reference.");
  }
  if (credential.mode === "agent") {
    if (credential.identityFile !== undefined) {
      throw new Error("Agent SSH credential cannot include an identity file.");
    }
    return {
      ref: credential.ref,
      mode: "agent",
      identityFile: null,
    };
  }
  if (credential.mode === "identity_file") {
    const identityBinding = isRecord(credential.identityFile)
      ? credential.identityFile
      : {
          path: credential.identityFile,
          sha256: null,
        };
    assertExactKeys(
      identityBinding,
      ["path", "sha256"],
      "SSH identity file binding",
    );
    const identityFile = regularFile(
      identityBinding.path,
      "SSH identity file",
    );
    const identityFileSha256 = sha256(readFileSync(identityFile));
    if (
      identityBinding.sha256 !== null
      && (
        !SHA256.test(identityBinding.sha256)
        || identityBinding.sha256 !== identityFileSha256
      )
    ) {
      throw new Error("SSH identity file hash mismatch.");
    }
    return {
      ref: credential.ref,
      mode: "identity_file",
      identityFile: {
        path: identityFile,
        sha256: identityFileSha256,
      },
    };
  }
  throw new Error("SSH credential mode must be agent or identity_file.");
}

function validateInstallContract(contract) {
  assertExactKeys(
    contract,
    ["archiveFormat", "releaseRoot", "currentSymlink"],
    "Install contract",
  );
  if (contract.archiveFormat !== "tar_gzip") {
    throw new Error("Install contract archiveFormat is unsupported.");
  }
  return {
    archiveFormat: contract.archiveFormat,
    releaseRoot: assertRemotePath(contract.releaseRoot, "Release root"),
    currentSymlink: assertRemotePath(
      contract.currentSymlink,
      "Current release symlink",
    ),
  };
}

function validateManagedFile(value, label) {
  assertExactKeys(
    value,
    ["sourcePath", "destinationPath", "sha256"],
    label,
  );
  return {
    sourcePath: assertRelativePath(value.sourcePath, `${label} sourcePath`),
    destinationPath: assertRemotePath(
      value.destinationPath,
      `${label} destinationPath`,
    ),
    sha256: assertHash(value.sha256, `${label} SHA-256`),
  };
}

function validateSystemdContract(contract) {
  assertExactKeys(
    contract,
    [
      "unitName",
      "unitFile",
      "daemonReload",
      "enable",
      "restart",
    ],
    "Systemd contract",
  );
  if (
    typeof contract.unitName !== "string"
    || !SERVICE_NAME.test(contract.unitName)
  ) {
    throw new Error("Systemd unitName is invalid.");
  }
  for (const key of ["daemonReload", "enable", "restart"]) {
    if (typeof contract[key] !== "boolean") {
      throw new Error(`Systemd ${key} must be boolean.`);
    }
  }
  return {
    unitName: contract.unitName,
    unitFile: validateManagedFile(contract.unitFile, "Systemd unit file"),
    daemonReload: contract.daemonReload,
    enable: contract.enable,
    restart: contract.restart,
  };
}

function validateNginxContract(contract) {
  assertExactKeys(
    contract,
    [
      "siteName",
      "configFile",
      "enabledLinkPath",
      "configTest",
      "reload",
    ],
    "Nginx contract",
  );
  assertIdentifier(contract.siteName, "Nginx siteName");
  for (const key of ["configTest", "reload"]) {
    if (typeof contract[key] !== "boolean") {
      throw new Error(`Nginx ${key} must be boolean.`);
    }
  }
  return {
    siteName: contract.siteName,
    configFile: validateManagedFile(contract.configFile, "Nginx config file"),
    enabledLinkPath: assertRemotePath(
      contract.enabledLinkPath,
      "Nginx enabled link path",
    ),
    configTest: contract.configTest,
    reload: contract.reload,
  };
}

function validateSmokeCheck(check) {
  if (check?.kind === "systemd_active") {
    assertExactKeys(
      check,
      ["checkId", "kind", "unitName"],
      "Systemd smoke check",
    );
    assertIdentifier(check.checkId, "Smoke checkId");
    if (
      typeof check.unitName !== "string"
      || !SERVICE_NAME.test(check.unitName)
    ) {
      throw new Error("Systemd smoke unitName is invalid.");
    }
    return structuredClone(check);
  }
  if (check?.kind === "http") {
    assertExactKeys(
      check,
      ["checkId", "kind", "url", "expectedStatus"],
      "HTTP smoke check",
    );
    assertIdentifier(check.checkId, "Smoke checkId");
    let parsed;
    try {
      parsed = new URL(check.url);
    } catch {
      throw new Error("HTTP smoke URL is invalid.");
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
      throw new Error("HTTP smoke check must use a safe loopback URL and status.");
    }
    return structuredClone(check);
  }
  throw new Error("Smoke checks must use a supported structured kind.");
}

function validateSmokeContract(contract) {
  assertExactKeys(contract, ["checks"], "Smoke contract");
  if (!Array.isArray(contract.checks) || contract.checks.length === 0) {
    throw new Error("Smoke contract requires structured checks.");
  }
  const checks = contract.checks.map(validateSmokeCheck);
  if (new Set(checks.map((check) => check.checkId)).size !== checks.length) {
    throw new Error("Smoke checkId values must be unique.");
  }
  return { checks };
}

function validateStageContracts(contracts) {
  assertExactKeys(
    contracts,
    ["install", "systemd", "nginx", "smoke"],
    "SSH stage contracts",
  );
  return {
    install: validateInstallContract(contracts.install),
    systemd: validateSystemdContract(contracts.systemd),
    nginx: validateNginxContract(contracts.nginx),
    smoke: validateSmokeContract(contracts.smoke),
  };
}

function validateRemoteFiles(entries, label, hashKey) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array.`);
  const seen = new Set();
  return entries.map((entry) => {
    const allowed = hashKey === "sha256"
      ? ["path", "sha256"]
      : ["path", "priorSha256"];
    assertExactKeys(entry, allowed, `${label} entry`);
    const remotePath = assertRemotePath(entry.path, `${label} path`);
    if (seen.has(remotePath)) throw new Error(`${label} paths must be unique.`);
    seen.add(remotePath);
    return {
      path: remotePath,
      [hashKey]: assertHash(entry[hashKey], `${label} hash`),
    };
  });
}

function validateStageInput(input, boundTarget, credentialRef) {
  if (!isRecord(input) || !REMOTE_DEPLOYMENT_STAGES.includes(input.stage)) {
    throw new Error("SSH adapter stage input is invalid.");
  }
  const normalizedTarget = validateRemoteTarget(input.target);
  if (!sameValue(normalizedTarget, boundTarget)) {
    throw new Error("SSH adapter target drift is forbidden.");
  }
  if (input.credentialRef !== credentialRef) {
    throw new Error("SSH adapter credential binding drift is forbidden.");
  }
  assertIdentifier(input.deploymentId, "DeploymentId");
  assertHash(input.deploymentLineageSha256, "Deployment lineage");
  if (!new Set(["first", "update"]).has(input.mode)) {
    throw new Error("SSH deployment mode is invalid.");
  }
  assertExactKeys(
    input.artifact,
    ["path", "sha256", "size", "mediaType"],
    "SSH artifact",
  );
  const artifact = {
    path: assertRelativePath(input.artifact.path, "SSH artifact path"),
    sha256: assertHash(input.artifact.sha256, "SSH artifact"),
    size: input.artifact.size,
    mediaType: input.artifact.mediaType,
  };
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) {
    throw new Error("SSH artifact size is invalid.");
  }
  if (
    typeof artifact.mediaType !== "string"
    || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/u.test(artifact.mediaType)
  ) {
    throw new Error("SSH artifact media type is invalid.");
  }
  assertExactKeys(input.upload, ["remotePath", "createOnly"], "SSH upload");
  const upload = {
    remotePath: assertRemotePath(input.upload.remotePath, "SSH upload path"),
    createOnly: input.upload.createOnly,
  };
  if (upload.createOnly !== true) {
    throw new Error("SSH upload must be create-only.");
  }
  const expectedRemoteFiles = validateRemoteFiles(
    input.expectedRemoteFiles,
    "Expected remote files",
    "sha256",
  );
  const deletionAllowlist = validateRemoteFiles(
    input.deletionAllowlist,
    "Deletion allowlist",
    "priorSha256",
  );
  const expectedByPath = new Map(
    expectedRemoteFiles.map((entry) => [entry.path, entry.sha256]),
  );
  for (const deletion of deletionAllowlist) {
    if (expectedByPath.get(deletion.path) !== deletion.priorSha256) {
      throw new Error("Deletion allowlist must match an exact expected prior hash.");
    }
  }
  assertExactKeys(
    input.permissions,
    ["deploy", "destructive"],
    "SSH deployment permissions",
  );
  if (
    input.permissions.deploy !== true
    || typeof input.permissions.destructive !== "boolean"
    || (
      deletionAllowlist.length > 0
      && input.permissions.destructive !== true
    )
  ) {
    throw new Error("SSH deployment permissions do not authorize the stage input.");
  }
  let priorDeployment = null;
  if (input.mode === "first") {
    if (
      input.priorDeployment !== null
      || expectedRemoteFiles.length > 0
      || deletionAllowlist.length > 0
    ) {
      throw new Error("First SSH deployment cannot use prior state or deletions.");
    }
  } else {
    assertExactKeys(
      input.priorDeployment,
      ["receiptSha256", "artifactSha256"],
      "Prior SSH deployment",
    );
    priorDeployment = {
      receiptSha256: assertHash(
        input.priorDeployment.receiptSha256,
        "Prior deployment receipt",
      ),
      artifactSha256: assertHash(
        input.priorDeployment.artifactSha256,
        "Prior deployment artifact",
      ),
    };
    if (expectedRemoteFiles.length === 0) {
      throw new Error("Update SSH deployment requires expected prior files.");
    }
  }
  return {
    stage: input.stage,
    deploymentId: input.deploymentId,
    deploymentLineageSha256: input.deploymentLineageSha256,
    mode: input.mode,
    target: normalizedTarget,
    artifact,
    upload,
    priorDeployment,
    expectedRemoteFiles,
    deletionAllowlist,
    permissions: structuredClone(input.permissions),
  };
}

function verifyKnownHosts(knownHostsPath, target) {
  const bindingFailure = verifyBoundLocalFile({
    filePath: knownHostsPath,
    resolvedPath: knownHostsPath,
    expectedSha256: target.hostKeySha256,
    failurePrefix: "known_hosts",
  });
  if (bindingFailure) return bindingFailure;
  const bytes = readFileSync(knownHostsPath);
  const expectedHost = target.port === 22
    ? new Set([target.host, `[${target.host}]:22`])
    : new Set([`[${target.host}]:${target.port}`]);
  const containsTarget = bytes
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line !== "" && !line.startsWith("#"))
    .some((line) => expectedHost.has(line.split(/\s+/u, 1)[0]));
  if (!containsTarget) return failure("known_hosts_target_missing");
  return null;
}

function verifyBoundLocalFile({
  filePath,
  resolvedPath,
  expectedSha256,
  failurePrefix,
}) {
  let currentResolved;
  let bytes;
  try {
    const requestedStat = lstatSync(filePath);
    if (requestedStat.isSymbolicLink() || !requestedStat.isFile()) {
      return failure(`${failurePrefix}_invalid`);
    }
    currentResolved = realpathSync(filePath);
    const resolvedStat = lstatSync(currentResolved);
    if (resolvedStat.isSymbolicLink() || !resolvedStat.isFile()) {
      return failure(`${failurePrefix}_invalid`);
    }
    bytes = readFileSync(currentResolved);
  } catch {
    return failure(`${failurePrefix}_invalid`);
  }
  if (currentResolved !== resolvedPath) {
    return failure(`${failurePrefix}_realpath_drift`);
  }
  if (sha256(bytes) !== expectedSha256) {
    return failure(`${failurePrefix}_hash_mismatch`);
  }
  return null;
}

function resolveLocalArtifact(workspaceRoot, artifact) {
  const requested = path.resolve(workspaceRoot, artifact.path);
  const relative = path.relative(workspaceRoot, requested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { failed: failure("local_artifact_outside_workspace") };
  }
  let resolved;
  try {
    resolved = regularFile(requested, "Local deployment artifact");
  } catch {
    return { failed: failure("local_artifact_invalid") };
  }
  const resolvedRelative = path.relative(workspaceRoot, resolved);
  if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) {
    return { failed: failure("local_artifact_outside_workspace") };
  }
  const bytes = readFileSync(resolved);
  if (bytes.length !== artifact.size || sha256(bytes) !== artifact.sha256) {
    return { failed: failure("local_artifact_hash_mismatch") };
  }
  return { bytes };
}

function exactArray(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => sameValue(entry, expected[index]));
}

function normalizeRemoteFailure(output) {
  try {
    assertExactKeys(
      output,
      ["status", "failureCode", "evidenceSha256"],
      "Remote helper failure",
    );
    if (output.status !== "failed") throw new Error("not failed");
    assertIdentifier(output.failureCode, "Remote helper failureCode");
    assertHash(output.evidenceSha256, "Remote helper failure evidence");
    return {
      status: "failed",
      failureCode: output.failureCode,
      evidenceSha256: output.evidenceSha256,
    };
  } catch {
    return failure("ssh_output_invalid");
  }
}

function normalizeRemoteOutput(
  stage,
  output,
  context,
  hostKeySha256,
  remoteHelper,
) {
  if (!isRecord(output)) return failure("ssh_output_invalid");
  if (output.status === "failed") return normalizeRemoteFailure(output);
  try {
    if (stage === "identity_preflight") {
      assertExactKeys(
        output,
        ["status", "machineIdentitySha256", "remoteHelper"],
        "Remote identity output",
      );
      if (
        output.status !== "passed"
        || output.machineIdentitySha256
          !== context.target.machineIdentitySha256
      ) {
        return failure("remote_machine_identity_mismatch");
      }
      if (!sameValue(output.remoteHelper, remoteHelper)) {
        return failure("remote_helper_capability_mismatch");
      }
      return {
        status: "passed",
        hostKeySha256,
        machineIdentitySha256: output.machineIdentitySha256,
        remoteHelper: structuredClone(remoteHelper),
      };
    }
    if (stage === "upload") {
      assertExactKeys(
        output,
        ["status", "remotePath", "sha256", "size"],
        "Remote upload output",
      );
      if (
        !new Set(["created", "already_present"]).has(output.status)
        || output.remotePath !== context.upload.remotePath
        || output.sha256 !== context.artifact.sha256
        || output.size !== context.artifact.size
      ) {
        return failure("create_only_upload_conflict");
      }
      return structuredClone(output);
    }
    if (stage === "verify_remote_hashes") {
      assertExactKeys(
        output,
        [
          "status",
          "remotePath",
          "sha256",
          "size",
          "verifiedPriorFiles",
        ],
        "Remote hash output",
      );
      if (
        output.status !== "passed"
        || output.remotePath !== context.upload.remotePath
        || output.sha256 !== context.artifact.sha256
        || output.size !== context.artifact.size
        || !exactArray(
          output.verifiedPriorFiles,
          context.expectedRemoteFiles,
        )
      ) {
        return failure("remote_artifact_or_prior_hash_mismatch");
      }
      return {
        status: "passed",
        remotePath: output.remotePath,
        sha256: output.sha256,
        size: output.size,
      };
    }
    if (stage === "install") {
      assertExactKeys(
        output,
        [
          "status",
          "mode",
          "installedArtifactSha256",
          "deletedFiles",
          "evidenceSha256",
        ],
        "Remote install output",
      );
      if (!exactArray(output.deletedFiles, context.deletionAllowlist)) {
        return failure("remote_deletion_set_mismatch");
      }
      if (
        output.status !== "passed"
        || output.mode !== context.mode
        || output.installedArtifactSha256 !== context.artifact.sha256
      ) {
        return failure("remote_install_mismatch");
      }
      return {
        status: "passed",
        evidenceSha256: assertHash(
          output.evidenceSha256,
          "Remote install evidence",
        ),
      };
    }
    if (stage === "service") {
      assertExactKeys(
        output,
        [
          "status",
          "unitName",
          "unitFileSha256",
          "evidenceSha256",
        ],
        "Remote systemd output",
      );
      if (
        output.status !== "passed"
        || output.unitName !== context.contract.unitName
        || output.unitFileSha256 !== context.contract.unitFile.sha256
      ) {
        return failure("remote_systemd_contract_mismatch");
      }
      return {
        status: "passed",
        evidenceSha256: assertHash(
          output.evidenceSha256,
          "Remote systemd evidence",
        ),
      };
    }
    if (stage === "proxy") {
      assertExactKeys(
        output,
        [
          "status",
          "siteName",
          "configFileSha256",
          "evidenceSha256",
        ],
        "Remote Nginx output",
      );
      if (
        output.status !== "passed"
        || output.siteName !== context.contract.siteName
        || output.configFileSha256 !== context.contract.configFile.sha256
      ) {
        return failure("remote_nginx_contract_mismatch");
      }
      return {
        status: "passed",
        evidenceSha256: assertHash(
          output.evidenceSha256,
          "Remote Nginx evidence",
        ),
      };
    }
    assertExactKeys(
      output,
      ["status", "checks", "evidenceSha256"],
      "Remote smoke output",
    );
    const expectedIds = context.contract.checks.map((check) => check.checkId);
    if (
      output.status !== "passed"
      || !Array.isArray(output.checks)
      || output.checks.length !== expectedIds.length
      || output.checks.some((check, index) => {
        try {
          assertExactKeys(
            check,
            ["checkId", "status", "evidenceSha256"],
            "Remote smoke check output",
          );
          assertHash(check.evidenceSha256, "Remote smoke check evidence");
          return check.checkId !== expectedIds[index]
            || check.status !== "passed";
        } catch {
          return true;
        }
      })
    ) {
      return failure("remote_smoke_contract_mismatch");
    }
    return {
      status: "passed",
      evidenceSha256: assertHash(
        output.evidenceSha256,
        "Remote smoke evidence",
      ),
    };
  } catch {
    return failure("ssh_output_invalid");
  }
}

function buildPayload(
  stage,
  context,
  contracts,
  artifactBytes,
  remoteHelper,
) {
  const common = {
    protocol: SSH_REMOTE_HELPER_PROTOCOL_V1,
    expectedRemoteHelper: structuredClone(remoteHelper),
    stage,
    deploymentId: context.deploymentId,
    deploymentLineageSha256: context.deploymentLineageSha256,
    mode: context.mode,
    target: {
      targetId: context.target.targetId,
      environment: context.target.environment,
    },
  };
  if (stage === "identity_preflight") {
    return {
      ...common,
      expectedMachineIdentitySha256:
        context.target.machineIdentitySha256,
    };
  }
  if (stage === "upload") {
    return {
      ...common,
      remotePath: context.upload.remotePath,
      createOnly: true,
      artifact: context.artifact,
      contentBase64: artifactBytes.toString("base64"),
    };
  }
  if (stage === "verify_remote_hashes") {
    return {
      ...common,
      remotePath: context.upload.remotePath,
      artifact: context.artifact,
      expectedRemoteFiles: context.expectedRemoteFiles,
    };
  }
  if (stage === "install") {
    return {
      ...common,
      remoteArtifactPath: context.upload.remotePath,
      artifact: context.artifact,
      priorDeployment: context.priorDeployment,
      expectedRemoteFiles: context.expectedRemoteFiles,
      deletionAllowlist: context.deletionAllowlist,
      destructive: context.permissions.destructive,
      contract: {
        ...contracts.install,
        releasePath: `${contracts.install.releaseRoot}/${context.deploymentId}`,
      },
    };
  }
  if (stage === "service") {
    return { ...common, contract: contracts.systemd };
  }
  if (stage === "proxy") {
    return { ...common, contract: contracts.nginx };
  }
  return { ...common, contract: contracts.smoke };
}

function buildReconciliationPayload(
  stage,
  context,
  contracts,
  remoteHelper,
) {
  const payload = buildPayload(
    stage,
    context,
    contracts,
    stage === "upload" ? Buffer.alloc(0) : null,
    remoteHelper,
  );
  if (stage === "upload") delete payload.contentBase64;
  return {
    ...payload,
    operation: "reconcile",
  };
}

function defaultExecFile(file, args, options) {
  const stdout = execFileSync(file, args, options);
  return {
    status: 0,
    stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
    stderr: "",
  };
}

function builtInIdentity() {
  return {
    adapterId: "builtin-ssh-v1",
    version: "1.0.0",
    executable: MODULE_PATH,
    sha256: sha256(readFileSync(MODULE_PATH)),
  };
}

export function builtInSshRemoteAdapterIdentityV1() {
  return builtInIdentity();
}

export function createSshRemoteAdapterV1({
  target,
  credential,
  knownHostsPath,
  workspaceRoot,
  remoteHelper,
  stageContracts,
  sshExecutable = "/usr/bin/ssh",
  sshExecutableSha256 = null,
  timeoutMs = 600_000,
  maxOutputBytes = 1_048_576,
  execFile = defaultExecFile,
} = {}) {
  const normalizedTarget = validateRemoteTarget(target);
  const normalizedCredential = validateCredential(credential);
  const normalizedKnownHostsPath = regularFile(
    knownHostsPath,
    "SSH known_hosts file",
  );
  const normalizedWorkspaceRoot = realDirectory(
    workspaceRoot,
    "SSH adapter workspaceRoot",
  );
  const normalizedRemoteHelper = validateSshRemoteHelperBindingV1(
    remoteHelper,
  );
  const normalizedSshExecutable = regularFile(
    sshExecutable,
    "SSH executable",
  );
  if (path.basename(normalizedSshExecutable) !== "ssh") {
    throw new Error("SSH executable must resolve to the ssh binary.");
  }
  const boundSshExecutableSha256 = sha256(
    readFileSync(normalizedSshExecutable),
  );
  if (
    sshExecutableSha256 !== null
    && (
      !SHA256.test(sshExecutableSha256)
      || sshExecutableSha256 !== boundSshExecutableSha256
    )
  ) {
    throw new Error("SSH executable hash mismatch.");
  }
  const normalizedContracts = validateStageContracts(stageContracts);
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 3_600_000
  ) {
    throw new Error("SSH adapter timeoutMs is invalid.");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1_024
    || maxOutputBytes > 16_777_216
  ) {
    throw new Error("SSH adapter maxOutputBytes is invalid.");
  }
  if (typeof execFile !== "function") {
    throw new Error("SSH adapter execFile runner is required.");
  }
  const identity = builtInIdentity();
  const connectionArgs = [
    "-F",
    "none",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${normalizedKnownHostsPath}`,
    ...(normalizedCredential.mode === "identity_file"
      ? ["-i", normalizedCredential.identityFile.path]
      : []),
    "-p",
    String(normalizedTarget.port),
    `${normalizedTarget.user}@${normalizedTarget.host}`,
  ];
  async function invokeStage(input, operation) {
      let context;
      try {
        context = validateStageInput(
          input,
          normalizedTarget,
          normalizedCredential.ref,
        );
      } catch {
        return failure("ssh_stage_input_invalid");
      }
      const knownHostsFailure = verifyKnownHosts(
        normalizedKnownHostsPath,
        normalizedTarget,
      );
      if (knownHostsFailure) return knownHostsFailure;
      const sshExecutableFailure = verifyBoundLocalFile({
        filePath: normalizedSshExecutable,
        resolvedPath: normalizedSshExecutable,
        expectedSha256: boundSshExecutableSha256,
        failurePrefix: "ssh_executable",
      });
      if (sshExecutableFailure) return sshExecutableFailure;
      if (normalizedCredential.mode === "identity_file") {
        const identityFileFailure = verifyBoundLocalFile({
          filePath: normalizedCredential.identityFile.path,
          resolvedPath: normalizedCredential.identityFile.path,
          expectedSha256: normalizedCredential.identityFile.sha256,
          failurePrefix: "identity_file",
        });
        if (identityFileFailure) return identityFileFailure;
      }
      let artifactBytes = null;
      if (context.stage === "upload" && operation === "execute") {
        const artifact = resolveLocalArtifact(
          normalizedWorkspaceRoot,
          context.artifact,
        );
        if (artifact.failed) return artifact.failed;
        artifactBytes = artifact.bytes;
      }
      const payload = operation === "reconcile"
        ? buildReconciliationPayload(
            context.stage,
            context,
            normalizedContracts,
            normalizedRemoteHelper,
          )
        : buildPayload(
            context.stage,
            context,
            normalizedContracts,
            artifactBytes,
            normalizedRemoteHelper,
          );
      let completed;
      try {
        completed = await execFile(
          normalizedSshExecutable,
          [
            ...connectionArgs,
            normalizedRemoteHelper.path,
            "--protocol",
            SSH_REMOTE_HELPER_PROTOCOL_V1,
            "--stage",
            context.stage,
            ...(operation === "reconcile"
              ? ["--operation", "reconcile"]
              : []),
          ],
          {
            encoding: "utf8",
            env: constrainedEnvironment(),
            input: `${JSON.stringify(payload)}\n`,
            maxBuffer: maxOutputBytes,
            shell: false,
            timeout: timeoutMs,
            windowsHide: true,
          },
        );
      } catch (error) {
        return indeterminate(
          error?.code === "ETIMEDOUT"
            ? "ssh_process_timeout"
            : "ssh_process_failed",
          {
            code: typeof error?.code === "string" ? error.code : null,
            stdoutSha256: sha256(String(error?.stdout ?? "")),
            stderrSha256: sha256(String(error?.stderr ?? "")),
          },
        );
      }
      if (
        !isRecord(completed)
        || (
          completed.status !== undefined
          && completed.status !== 0
        )
      ) {
        return indeterminate(
          Number.isInteger(completed?.status)
            ? `ssh_process_exit_${completed.status}`
            : "ssh_process_failed",
          {
            status: completed?.status ?? null,
            stdoutSha256: sha256(String(completed?.stdout ?? "")),
            stderrSha256: sha256(String(completed?.stderr ?? "")),
          },
        );
      }
      const stdout = String(completed.stdout ?? "");
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        return indeterminate("ssh_output_too_large");
      }
      let output;
      try {
        output = JSON.parse(stdout);
      } catch {
        return indeterminate("ssh_output_invalid", {
          stdoutSha256: sha256(stdout),
          stderrSha256: sha256(String(completed.stderr ?? "")),
        });
      }
      return normalizeRemoteOutput(
        context.stage,
        output,
        {
          ...context,
          contract: context.stage === "service"
            ? normalizedContracts.systemd
            : context.stage === "proxy"
              ? normalizedContracts.nginx
              : context.stage === "smoke"
                ? normalizedContracts.smoke
                : null,
        },
        normalizedTarget.hostKeySha256,
        normalizedRemoteHelper,
      );
  }
  return {
    identity,
    async runStage(input) {
      return invokeStage(input, "execute");
    },
    async reconcileStage(input) {
      return invokeStage(input, "reconcile");
    },
  };
}
