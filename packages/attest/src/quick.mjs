import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

import {
  isPlainJsonObject,
  decodeUtf8Strict,
  parseJsonStrict,
  readFileBytesBounded,
  resolveRegularFilePath,
  sha256Bytes,
} from "./formal.mjs";
import {
  quickSnapshotFingerprintValid,
  validQuickReceiptShape,
} from "./quick-receipt-contract.mjs";
import { captureWorkspaceSnapshot } from "./workspace-snapshot.mjs";

export { validQuickReceiptShape } from "./quick-receipt-contract.mjs";

export const SUPPORTED_QUICK_CORE_IDENTITIES = Object.freeze([
  {
    contractVersion: "0.2",
    coreVersion: "0.18.0",
    coreManifestSha256: "sha256:2cafa3b76a6b267888b116edfb04d9d6b455db0a7dcd289b30a265d418b7abec",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.17.2",
    coreManifestSha256: "sha256:67b883b8a763253b873fb6047c7e7e01c81123aa5250a0db5feaabd13cc4d860",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.17.1",
    coreManifestSha256: "sha256:5376f3736dd17c07598df8b655a6bbceb3b64b44f3e6630e69f966e420d82e26",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.17.0",
    coreManifestSha256: "sha256:0c0c52e7f6299bdd3d3ea49005c8ceef0b28831d60af25d77da65a4e4de714c9",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.16.1",
    coreManifestSha256: "sha256:38ac9110e328c38a81db05f1359734ca810b991c9f4de77647f9719f5e6af78b",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.16.0",
    coreManifestSha256: "sha256:320fb1d97b4459d1a14b0b67807dcf2bc6b03970492cb9fb2c6245b17912c81e",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.15.1",
    coreManifestSha256: "sha256:e8ca57522a8e473da356ceb3768bb650267894638d450d5e49463ab6f51c752b",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.15.0",
    coreManifestSha256: "sha256:06d7616c369b4b3ece3aca32f05c505d4b30781d3ca87a13bd8d7293c1491f64",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.14.0",
    coreManifestSha256: "sha256:d3b498562bebb2fa180d6861cb834ce3551288bf499ce0d769ee6c64b2663231",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.12.0",
    coreManifestSha256: "sha256:c415b10cb00d2a7891744b7257774fa501ddf40f8ec2f290356505a17fefb40f",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.12.0",
    coreManifestSha256: "sha256:be4b079fb0bc29e71858af03a1e579f864d4414c815ac612c3b514d8d663d07b",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.13.0",
    coreManifestSha256: "sha256:0e3233a417365afb4e2ce22db5260608a9c697a819cd5c02897276d6454dde1f",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.13.0",
    coreManifestSha256: "sha256:037c012751b32abbbb48ce8a8d2cd8faa4fc2c38d6797db391205477e667065f",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.13.0",
    coreManifestSha256: "sha256:2f840d1884b34656902f8f23af3bd8052dde3212aa516dac2cbb0e0b29627ea1",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.13.0",
    coreManifestSha256: "sha256:febf2551317fce9e4bb412b833a392a20376d702dda09c57d6116e8a3ca4f857",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.13.0",
    coreManifestSha256: "sha256:4b72f572b6964f149c4a6fe5c2c9da85f73b8060c88023dc96ba5ca50a036972",
  },
  {
    contractVersion: "0.2",
    coreVersion: "0.13.0",
    coreManifestSha256: "sha256:0455c847bf2df77703583c6f19c20cf103206bafc4f122795bf34d3f85f0263d",
  },
]);

function resolveBoundMaterial(root, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("material path must be workspace-relative");
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("material path contains unsafe segments");
  }
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("material path traverses a symlink");
  }
  const resolved = realpathSync(current);
  const remainder = path.relative(root, resolved);
  if (remainder === "" || remainder === ".." || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder)) {
    throw new Error("material path escapes the workspace");
  }
  if (!statSync(resolved).isFile()) throw new Error("material must be a regular file");
  return resolved;
}

function check(status, issueCode) {
  return issueCode === undefined ? { status } : { status, issueCode };
}

function resultTemplate({ receipt, receiptPath, receiptSha256, decision, issues, checks, materials }) {
  return {
    schemaVersion: "OwlCodaAttestationResultV1",
    decision,
    subjectRef: {
      schemaVersion: "OwlCodaAttestationRefV1",
      receiptId: receipt.receiptId,
      receiptSha256,
      coreIdentity: {
        contractVersion: receipt.coreIdentity.contractVersion,
        coreManifestSha256: receipt.coreIdentity.coreManifestSha256,
      },
    },
    verifiedAt: new Date().toISOString(),
    policy: {
      id: "owlcoda-quick-minimum",
      version: "1.0.0",
    },
    checks,
    authorizationBoundary: {
      authorizationGranted: false,
      statement: "attestation_never_grants_repository_or_business_authority",
    },
    issueCodes: [...new Set(issues)].sort(),
    verifiedMaterials: [
      { path: receiptPath, sha256: receiptSha256 },
      ...materials,
    ],
  };
}

export function attestQuickReceiptDetailsFromBytes({
  receiptPath,
  receiptBytes,
  workspaceRoot,
}) {
  const absoluteReceiptPath = resolveRegularFilePath(receiptPath);
  let receipt;
  try {
    receipt = parseJsonStrict(decodeUtf8Strict(receiptBytes));
  } catch (error) {
    if (error?.code === "DUPLICATE_OBJECT_KEY") {
      error.code = "receipt_duplicate_key";
    }
    throw error;
  }
  if (!isPlainJsonObject(receipt) || !validQuickReceiptShape(receipt)) {
    const error = new Error("Quick receipt does not satisfy the strict Wave 1 shape");
    error.code = "receipt_schema_invalid";
    throw error;
  }

  const issues = [...receipt.issueCodes, "signature_absent", "anchor_absent"];
  const materials = [];
  let materialMissing = false;
  let materialMismatch = false;

  const coreValid = SUPPORTED_QUICK_CORE_IDENTITIES.some((core) =>
    receipt.coreIdentity.contractVersion === core.contractVersion
    && receipt.coreIdentity.coreVersion === core.coreVersion
    && receipt.coreIdentity.coreManifestSha256 === core.coreManifestSha256);
  if (!coreValid) issues.push("core_identity_mismatch");
  const contextValid = receipt.verificationContext.platform === process.platform
    && receipt.verificationContext.architecture === process.arch
    && receipt.verificationContext.runtime === process.version;
  if (!contextValid) issues.push("verification_context_mismatch");

  const snapshotBindingsValid = quickSnapshotFingerprintValid(receipt.workspaceBefore)
    && quickSnapshotFingerprintValid(receipt.workspaceAfter);
  const sourceUnchanged = receipt.workspaceBefore.sourceFingerprint
    === receipt.workspaceAfter.sourceFingerprint;
  const receiptSourceValid = receipt.mutationDecision === "source_unchanged"
    ? snapshotBindingsValid && sourceUnchanged && !receipt.issueCodes.includes("source_mutated_during_verification")
    : snapshotBindingsValid && !sourceUnchanged && receipt.issueCodes.includes("source_mutated_during_verification");
  const selectedWorkspaceRoot = workspaceRoot === undefined
    ? undefined
    : realpathSync(workspaceRoot);
  if (selectedWorkspaceRoot === undefined) {
    issues.push("current_workspace_not_checked");
  }
  let receiptWorkspaceRoot;
  if (selectedWorkspaceRoot !== undefined) {
    try {
      receiptWorkspaceRoot = realpathSync(receipt.exactCommand.cwd);
    } catch {
      receiptWorkspaceRoot = undefined;
    }
  }
  const commandWorkspaceMatches = selectedWorkspaceRoot !== undefined
    && receiptWorkspaceRoot === selectedWorkspaceRoot;
  if (commandWorkspaceMatches) {
    for (const artifact of [receipt.outputArtifacts.stdout, receipt.outputArtifacts.stderr]) {
      try {
        const materialPath = resolveBoundMaterial(receiptWorkspaceRoot, artifact.path);
        const { bytes } = readFileBytesBounded(materialPath);
        const actualSha256 = sha256Bytes(bytes);
        materials.push({ path: materialPath, sha256: actualSha256 });
        if (actualSha256 !== artifact.sha256 || bytes.byteLength !== artifact.sizeBytes) {
          materialMismatch = true;
        }
      } catch (error) {
        if (error && typeof error === "object" && error.code === "ENOENT") {
          materialMissing = true;
        } else {
          materialMismatch = true;
        }
      }
    }
  }
  if (materialMissing) issues.push("attestation_material_missing");
  if (materialMismatch) issues.push("receipt_material_hash_mismatch");
  const currentSourceValid = selectedWorkspaceRoot === undefined
    || commandWorkspaceMatches
      && captureWorkspaceSnapshot(selectedWorkspaceRoot).sourceFingerprint
        === receipt.workspaceAfter.sourceFingerprint;
  const sourceValid = receiptSourceValid && currentSourceValid;
  if (!sourceValid || receipt.mutationDecision !== "source_unchanged") {
    issues.push("receipt_source_mismatch");
  }
  const commandPassed = receipt.exitResult.exitCode === 0 && receipt.exitResult.signal === null;
  if (!commandPassed) issues.push("verification_command_failed");
  const deterministicFailure = !coreValid
    || !contextValid
    || materialMismatch
    || !sourceValid
    || receipt.mutationDecision !== "source_unchanged"
    || !commandPassed;
  const decision = deterministicFailure
    ? "NO_GO"
    : selectedWorkspaceRoot === undefined || materialMissing
      ? "INDETERMINATE"
      : "GO";
  const receiptSha256 = sha256Bytes(receiptBytes);

  const attestation = resultTemplate({
    receipt,
    receiptPath: absoluteReceiptPath,
    receiptSha256,
    decision,
    issues,
    materials,
    checks: {
      schema: check("passed"),
      canonicalization: check("passed"),
      lineage: check("passed"),
      source: selectedWorkspaceRoot === undefined
        ? check("not_checked", "current_workspace_not_checked")
        : sourceValid && receipt.mutationDecision === "source_unchanged"
          ? check("passed")
          : check("failed", "receipt_source_mismatch"),
      context: !coreValid
        ? check("failed", "core_identity_mismatch")
        : contextValid
          ? check("passed")
          : check("failed", "verification_context_mismatch"),
      signature: check("not_checked", "signature_absent"),
      key: check("not_checked", "signature_absent"),
      anchor: check("not_checked", "anchor_absent"),
    },
  });
  return {
    attestation,
    sourceFingerprint: receipt.workspaceAfter.sourceFingerprint,
    exitCode: decision === "GO"
      ? 0
      : !sourceValid || receipt.mutationDecision !== "source_unchanged"
        ? 2
        : decision === "INDETERMINATE"
          ? 3
          : 1,
  };
}

export function attestQuickReceiptDetails({ receiptPath, workspaceRoot }) {
  const { absolutePath, bytes } = readFileBytesBounded(receiptPath);
  return attestQuickReceiptDetailsFromBytes({
    receiptPath: absolutePath,
    receiptBytes: bytes,
    workspaceRoot,
  });
}

export function attestQuickReceipt(options) {
  return attestQuickReceiptDetails(options).attestation;
}
