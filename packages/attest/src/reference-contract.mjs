import {
  decodeUtf8Strict,
  hasExactKeys,
  isPlainJsonObject,
  isSha256Ref,
  parseJsonStrict,
  readFileBytesBounded,
  sha256Bytes,
} from "./formal.mjs";
import { validQuickReceiptShape } from "./quick-receipt-contract.mjs";

export function referenceError(message) {
  const error = new Error(message);
  error.code = "receipt_schema_invalid";
  return error;
}

export function readQuickReceiptFile(receiptPath) {
  const { absolutePath, bytes } = readFileBytesBounded(receiptPath);
  const receipt = parseJsonStrict(decodeUtf8Strict(bytes));
  if (!isPlainJsonObject(receipt) || !validQuickReceiptShape(receipt)) {
    throw referenceError("receipt does not satisfy Quick Receipt V1");
  }
  return { absolutePath, bytes, receipt };
}

export function createAttestationRef(receiptPath) {
  const { bytes, receipt } = readQuickReceiptFile(receiptPath);
  return {
    schemaVersion: "OwlCodaAttestationRefV1",
    receiptId: receipt.receiptId,
    receiptSha256: sha256Bytes(bytes),
    coreIdentity: {
      contractVersion: receipt.coreIdentity.contractVersion,
      coreManifestSha256: receipt.coreIdentity.coreManifestSha256,
    },
  };
}

export function parseAttestationRef(input) {
  let value;
  try {
    value = typeof input === "string" ? parseJsonStrict(input) : input;
  } catch (error) {
    if (error?.code === "DUPLICATE_OBJECT_KEY") {
      error.code = "receipt_duplicate_key";
    }
    throw error;
  }
  if (
    !hasExactKeys(value, ["schemaVersion", "receiptId", "receiptSha256", "coreIdentity"])
    || value.schemaVersion !== "OwlCodaAttestationRefV1"
    || typeof value.receiptId !== "string"
    || value.receiptId.length === 0
    || !isSha256Ref(value.receiptSha256)
    || !hasExactKeys(value.coreIdentity, ["contractVersion", "coreManifestSha256"])
    || typeof value.coreIdentity.contractVersion !== "string"
    || value.coreIdentity.contractVersion.length === 0
    || !isSha256Ref(value.coreIdentity.coreManifestSha256)
  ) {
    throw referenceError("reference does not satisfy OwlCodaAttestationRefV1");
  }
  return value;
}
