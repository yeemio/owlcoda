import {
  decodeUtf8Strict,
  hasExactKeys,
  parseJsonStrict,
  readFileBytesBounded,
  sha256Bytes,
} from "./formal.mjs";
import {
  createAttestationRef,
  parseAttestationRef,
} from "./reference-contract.mjs";
import { validQuickReceiptShape } from "./quick-receipt-contract.mjs";

const REQUIRED_KEYS = [
  "schemaVersion",
  "reference",
  "receiptByteLength",
  "receiptBytesBase64",
];

function bundleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function decodeBase64Strict(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw bundleError("offline_bundle_invalid", "offline receipt bytes must use canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw bundleError("offline_bundle_invalid", "offline receipt bytes must use canonical base64");
  }
  return bytes;
}

function validateReceiptBinding(reference, receiptBytes) {
  if (sha256Bytes(receiptBytes) !== reference.receiptSha256) {
    throw bundleError("offline_bundle_hash_mismatch", "offline receipt bytes do not match the reference hash");
  }
  let receipt;
  try {
    receipt = parseJsonStrict(decodeUtf8Strict(receiptBytes));
  } catch (error) {
    if (error?.code === "DUPLICATE_OBJECT_KEY") error.code = "receipt_duplicate_key";
    throw error;
  }
  if (
    !validQuickReceiptShape(receipt)
    || receipt.receiptId !== reference.receiptId
    || receipt.coreIdentity.contractVersion !== reference.coreIdentity.contractVersion
    || receipt.coreIdentity.coreManifestSha256 !== reference.coreIdentity.coreManifestSha256
  ) {
    throw bundleError("offline_bundle_reference_mismatch", "offline receipt identity does not match its reference");
  }
}

export function createOfflineAttestationBundle(receiptPath) {
  const reference = createAttestationRef(receiptPath);
  const { bytes } = readFileBytesBounded(receiptPath);
  validateReceiptBinding(reference, bytes);
  return {
    schemaVersion: "OwlCodaOfflineAttestationBundleV1",
    reference,
    receiptByteLength: bytes.byteLength,
    receiptBytesBase64: bytes.toString("base64"),
  };
}

export function parseOfflineAttestationBundle(input) {
  let value;
  try {
    value = typeof input === "string" ? parseJsonStrict(input) : input;
  } catch (error) {
    if (error?.code === "DUPLICATE_OBJECT_KEY") error.code = "receipt_duplicate_key";
    throw error;
  }
  if (
    !hasExactKeys(value, REQUIRED_KEYS)
    || value.schemaVersion !== "OwlCodaOfflineAttestationBundleV1"
    || !Number.isSafeInteger(value.receiptByteLength)
    || value.receiptByteLength < 1
  ) {
    throw bundleError("offline_bundle_invalid", "bundle does not satisfy OwlCodaOfflineAttestationBundleV1");
  }
  let reference;
  try {
    reference = parseAttestationRef(value.reference);
  } catch {
    throw bundleError("offline_bundle_invalid", "bundle contains an invalid AttestationRefV1");
  }
  const receiptBytes = decodeBase64Strict(value.receiptBytesBase64);
  if (receiptBytes.byteLength !== value.receiptByteLength) {
    throw bundleError("offline_bundle_size_mismatch", "offline receipt byte length does not match");
  }
  validateReceiptBinding(reference, receiptBytes);
  return {
    bundle: value,
    reference,
    receiptBytes,
  };
}
