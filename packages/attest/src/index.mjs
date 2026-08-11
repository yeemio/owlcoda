import {
  PUBLIC_VERIFIER_LIMITS,
  canonicalJson,
  decodeUtf8Strict,
  hasExactKeys,
  isPlainJsonObject,
  isPlainObject,
  isSha256Ref,
  parseJsonStrict,
  readFileBytesBounded,
  sha256Bytes,
  sha256Canonical,
  verifyBundle,
} from "./formal.mjs";
import {
  SUPPORTED_QUICK_CORE_IDENTITIES,
  attestQuickReceipt,
  attestQuickReceiptDetails,
  attestQuickReceiptDetailsFromBytes,
  validQuickReceiptShape,
} from "./quick.mjs";
import {
  createAttestationRef,
  parseAttestationRef,
  resolveAttestationRef,
} from "./reference.mjs";
import {
  createOfflineAttestationBundle,
  parseOfflineAttestationBundle,
} from "./offline-bundle.mjs";
import { captureWorkspaceSnapshot } from "./workspace-snapshot.mjs";

function readSubject(subjectPath) {
  const { absolutePath, bytes } = readFileBytesBounded(subjectPath);
  return {
    absolutePath,
    bytes,
    value: parseJsonStrict(decodeUtf8Strict(bytes)),
  };
}

export function attestFile({ subjectPath, workspaceRoot }) {
  const subject = readSubject(subjectPath);
  if (subject.value.schemaVersion === "OwlCodaQuickVerificationReceiptV1") {
    const details = attestQuickReceiptDetailsFromBytes({
      receiptPath: subject.absolutePath,
      receiptBytes: subject.bytes,
      workspaceRoot,
    });
    return {
      schemaVersion: "OwlCodaAttestCommandResultV1",
      status: "quick_attestation",
      decision: details.attestation.decision,
      exitCode: details.exitCode,
      receiptPath: subject.absolutePath,
      receiptSha256: sha256Bytes(subject.bytes),
      sourceFingerprint: details.sourceFingerprint,
      attestation: details.attestation,
      nextAllowedAction: details.attestation.decision === "GO"
        ? "consume_attestation"
        : "repair_or_replace_evidence",
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  if (subject.value.schemaVersion === "OwlCodaRunKitPublicVerificationBundleV1") {
    const formalVerification = verifyBundle(subject.value);
    const accepted = formalVerification.valid
      && formalVerification.decision === "accepted";
    return {
      schemaVersion: "OwlCodaAttestCommandResultV1",
      status: "formal_attestation",
      decision: accepted ? "GO" : "NO_GO",
      exitCode: accepted ? 0 : 1,
      subjectPath: subject.absolutePath,
      subjectSha256: sha256Bytes(subject.bytes),
      formalVerification,
      nextAllowedAction: accepted
        ? "consume_attestation"
        : formalVerification.valid
          ? "honor_formal_decision"
          : "repair_or_replace_evidence",
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  const error = new Error("unsupported attestation subject schemaVersion");
  error.code = "receipt_schema_invalid";
  throw error;
}

export {
  PUBLIC_VERIFIER_LIMITS,
  SUPPORTED_QUICK_CORE_IDENTITIES,
  attestQuickReceipt,
  attestQuickReceiptDetails,
  canonicalJson,
  captureWorkspaceSnapshot,
  createAttestationRef,
  createOfflineAttestationBundle,
  hasExactKeys,
  isPlainJsonObject,
  isPlainObject,
  isSha256Ref,
  parseAttestationRef,
  parseOfflineAttestationBundle,
  parseJsonStrict,
  resolveAttestationRef,
  sha256Bytes,
  sha256Canonical,
  validQuickReceiptShape,
  verifyBundle,
};
