import {
  hasExactKeys,
  isSha256Ref,
  sha256Canonical,
} from "./formal.mjs";

const RECEIPT_REQUIRED_KEYS = [
  "schemaVersion",
  "receiptId",
  "assurance",
  "authorizationGranted",
  "coreIdentity",
  "workspaceBefore",
  "exactCommand",
  "verificationContext",
  "startedAt",
  "finishedAt",
  "exitResult",
  "outputArtifacts",
  "workspaceAfter",
  "mutationDecision",
  "issueCodes",
];
const SNAPSHOT_REQUIRED_KEYS = [
  "schemaVersion",
  "repositoryIdentity",
  "headCommit",
  "trackedTreeIdentity",
  "submodules",
  "dirtyOverlay",
  "dependencyLockfiles",
  "excludedRoots",
  "ignoredPathsBound",
  "policyVersion",
  "sourceFingerprint",
];
const KNOWN_RECEIPT_ISSUES = new Set([
  "quick_ignored_artifact_unbound",
  "source_mutated_during_verification",
]);

function validDateTime(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validCoreIdentity(value) {
  return hasExactKeys(value, ["contractVersion", "coreVersion", "coreManifestSha256"])
    && typeof value.contractVersion === "string"
    && value.contractVersion.length > 0
    && typeof value.coreVersion === "string"
    && value.coreVersion.length > 0
    && isSha256Ref(value.coreManifestSha256);
}

function validSnapshot(value) {
  if (!hasExactKeys(value, SNAPSHOT_REQUIRED_KEYS)) return false;
  if (
    value.schemaVersion !== "OwlCodaWorkspaceSnapshotV1"
    || typeof value.repositoryIdentity !== "string"
    || value.repositoryIdentity.length === 0
    || !(value.headCommit === null || /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value.headCommit))
    || !isSha256Ref(value.trackedTreeIdentity)
    || value.ignoredPathsBound !== false
    || value.policyVersion !== "workspace-snapshot-v1"
    || !isSha256Ref(value.sourceFingerprint)
    || !Array.isArray(value.submodules)
    || !Array.isArray(value.dirtyOverlay)
    || !Array.isArray(value.dependencyLockfiles)
    || !Array.isArray(value.excludedRoots)
    || !value.excludedRoots.includes(".owlcoda/runkit")
  ) {
    return false;
  }
  if (!value.submodules.every((entry) =>
    hasExactKeys(entry, ["path", "commit"])
    && typeof entry.path === "string"
    && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.commit))) {
    return false;
  }
  if (!value.dirtyOverlay.every((entry) =>
    hasExactKeys(entry, ["path", "state", "sha256"])
    && typeof entry.path === "string"
    && ["modified", "untracked", "deleted"].includes(entry.state)
    && (entry.sha256 === null || isSha256Ref(entry.sha256)))) {
    return false;
  }
  if (!value.dependencyLockfiles.every((entry) =>
    hasExactKeys(entry, ["path", "sha256"])
    && typeof entry.path === "string"
    && isSha256Ref(entry.sha256))) {
    return false;
  }
  return true;
}

export function quickSnapshotFingerprintValid(value) {
  const { sourceFingerprint, ...payload } = value;
  return sha256Canonical(payload) === sourceFingerprint;
}

function validOutputArtifact(value) {
  return hasExactKeys(value, ["path", "sha256", "sizeBytes"])
    && typeof value.path === "string"
    && value.path.length > 0
    && isSha256Ref(value.sha256)
    && Number.isInteger(value.sizeBytes)
    && value.sizeBytes >= 0;
}

export function validQuickReceiptShape(receipt) {
  if (!hasExactKeys(receipt, RECEIPT_REQUIRED_KEYS, ["signatureRef"])) return false;
  if (
    receipt.schemaVersion !== "OwlCodaQuickVerificationReceiptV1"
    || typeof receipt.receiptId !== "string"
    || receipt.receiptId.length === 0
    || receipt.assurance !== "captured_verification"
    || receipt.authorizationGranted !== false
    || !validCoreIdentity(receipt.coreIdentity)
    || !validSnapshot(receipt.workspaceBefore)
    || !validSnapshot(receipt.workspaceAfter)
    || !hasExactKeys(receipt.exactCommand, ["executable", "argv", "cwd"])
    || typeof receipt.exactCommand.executable !== "string"
    || receipt.exactCommand.executable.length === 0
    || !Array.isArray(receipt.exactCommand.argv)
    || !receipt.exactCommand.argv.every((entry) => typeof entry === "string")
    || typeof receipt.exactCommand.cwd !== "string"
    || receipt.exactCommand.cwd.length === 0
    || !hasExactKeys(receipt.verificationContext, ["platform", "architecture", "runtime"])
    || !Object.values(receipt.verificationContext).every((entry) => typeof entry === "string" && entry.length > 0)
    || !validDateTime(receipt.startedAt)
    || !validDateTime(receipt.finishedAt)
    || Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt)
    || !hasExactKeys(receipt.exitResult, ["exitCode", "signal"])
    || !(receipt.exitResult.exitCode === null || Number.isInteger(receipt.exitResult.exitCode))
    || !(receipt.exitResult.signal === null || typeof receipt.exitResult.signal === "string")
    || !hasExactKeys(receipt.outputArtifacts, ["stdout", "stderr"])
    || !validOutputArtifact(receipt.outputArtifacts.stdout)
    || !validOutputArtifact(receipt.outputArtifacts.stderr)
    || !["source_unchanged", "invalidated_by_command_source_mutation"].includes(receipt.mutationDecision)
    || !Array.isArray(receipt.issueCodes)
    || new Set(receipt.issueCodes).size !== receipt.issueCodes.length
    || !receipt.issueCodes.every((entry) => typeof entry === "string" && KNOWN_RECEIPT_ISSUES.has(entry))
  ) {
    return false;
  }
  if (receipt.signatureRef !== undefined) {
    if (!hasExactKeys(receipt.signatureRef, ["path", "sha256"])
      || typeof receipt.signatureRef.path !== "string"
      || !isSha256Ref(receipt.signatureRef.sha256)) {
      return false;
    }
  }
  return true;
}
