import {
  HASH_PATTERN,
  PUBLIC_VERIFIER_LIMITS,
  canonicalJson,
  hasExactKeys,
  isPlainJsonObject,
  isPlainObject,
  isSha256Ref,
  parseJsonStrict as parsePublicJsonStrict,
  sha256Bytes,
  sha256Canonical,
} from "../../packages/attest/src/formal.mjs";

export const QUICK_INPUT_LIMITS = Object.freeze({
  maxInputBytes: PUBLIC_VERIFIER_LIMITS.maxInputBytes,
  maxNestingDepth: PUBLIC_VERIFIER_LIMITS.maxNestingDepth,
  maxJsonNodes: PUBLIC_VERIFIER_LIMITS.maxJsonNodes,
});

export const SHA256_REF_PATTERN = HASH_PATTERN;

export function parseJsonStrict(text) {
  try {
    return parsePublicJsonStrict(text);
  } catch (error) {
    if (error?.code === "DUPLICATE_OBJECT_KEY") {
      error.code = "receipt_duplicate_key";
    }
    throw error;
  }
}

export {
  canonicalJson,
  hasExactKeys,
  isPlainJsonObject,
  isPlainObject,
  isSha256Ref,
  sha256Bytes,
  sha256Canonical,
};
