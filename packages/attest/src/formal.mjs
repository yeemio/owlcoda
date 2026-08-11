import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const PUBLIC_VERIFIER_LIMITS = Object.freeze({
  maxInputBytes: 1_048_576,
  maxNestingDepth: 64,
  maxJsonNodes: 50_000,
  maxReceipts: 1_024,
});
export const FORMAL_ISSUE_CODES = Object.freeze([
  "ACCEPTED_AUTHORITY_GRANTED",
  "ACCEPTED_RECEIPT_NOT_PASSED",
  "ACTIVE_RECEIPT_CONTEXT_BINDING_MISMATCH",
  "ACTIVE_RECEIPT_SOURCE_BINDING_MISMATCH",
  "CANONICAL_JSON_INVALID",
  "CLOSEOUT_ACTIVE_RECEIPT_MISMATCH",
  "CLOSEOUT_CONTEXT_BINDING_MISMATCH",
  "CLOSEOUT_SOURCE_BINDING_MISMATCH",
  "DUPLICATE_OBJECT_KEY",
  "EXTERNAL_AUTHORITY_GRANTED",
  "INPUT_FILE_INVALID",
  "INPUT_JSON_INVALID",
  "INPUT_SIZE_LIMIT_EXCEEDED",
  "JSON_NESTING_LIMIT_EXCEEDED",
  "JSON_NODE_LIMIT_EXCEEDED",
  "PUBLIC_BUNDLE_SHAPE_INVALID",
  "RECEIPT_AUTHORITY_GRANTED",
  "RECEIPT_COUNT_LIMIT_EXCEEDED",
  "RECEIPT_ID_DUPLICATE",
  "RECEIPT_LINEAGE_CYCLE",
  "RECEIPT_LINEAGE_MULTIPLE_ACTIVE_LEAVES",
  "RECEIPT_LINEAGE_NO_ACTIVE_LEAF",
  "RECEIPT_LINEAGE_ORPHAN",
  "SOURCE_FINGERPRINT_MISMATCH",
  "VERIFICATION_CONTEXT_FINGERPRINT_MISMATCH",
]);
const FORMAL_ISSUE_CODE_SET = new Set(FORMAL_ISSUE_CODES);
const AUTHORITY_FIELDS = [
  "authorizationGranted",
  "gitAuthorization",
  "releaseAuthorization",
  "artifactMutationAuthorization",
  "businessActionAuthorization",
];

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const isPlainJsonObject = isPlainObject;

export function isSha256Ref(value) {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

export function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function verifierError(code, message) {
  if (!FORMAL_ISSUE_CODE_SET.has(code)) {
    throw new Error(`undeclared Formal issue code: ${code}`);
  }
  const error = new Error(message);
  error.code = code;
  return error;
}

export function resolveRegularFilePath(filePath) {
  const metadata = lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw verifierError("INPUT_FILE_INVALID", "input path must be a regular non-symlink file");
  }
  return realpathSync(filePath);
}

export function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw verifierError("INPUT_JSON_INVALID", "input is not valid UTF-8");
  }
}

export function readFileBytesBounded(filePath) {
  const absolutePath = resolveRegularFilePath(filePath);
  const descriptor = openSync(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw verifierError("INPUT_FILE_INVALID", "input path must be a regular file");
    }
    if (metadata.size > PUBLIC_VERIFIER_LIMITS.maxInputBytes) {
      throw verifierError("INPUT_SIZE_LIMIT_EXCEEDED", "input file exceeds the input-byte limit");
    }

    const buffer = Buffer.allocUnsafe(PUBLIC_VERIFIER_LIMITS.maxInputBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > PUBLIC_VERIFIER_LIMITS.maxInputBytes) {
      throw verifierError("INPUT_SIZE_LIMIT_EXCEEDED", "input file grew beyond the input-byte limit");
    }
    return {
      absolutePath,
      bytes: buffer.subarray(0, offset),
    };
  } finally {
    closeSync(descriptor);
  }
}

function countNode(budget) {
  budget.nodes += 1;
  if (budget.nodes > PUBLIC_VERIFIER_LIMITS.maxJsonNodes) {
    throw verifierError("JSON_NODE_LIMIT_EXCEEDED", "JSON value exceeds the node limit");
  }
}

function enterContainer(depth) {
  const nextDepth = depth + 1;
  if (nextDepth > PUBLIC_VERIFIER_LIMITS.maxNestingDepth) {
    throw verifierError("JSON_NESTING_LIMIT_EXCEEDED", "JSON value exceeds the nesting-depth limit");
  }
  return nextDepth;
}

function canonicalize(value, ancestors, depth, budget) {
  countNode(budget);
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    if (
      typeof value === "string" &&
      Buffer.byteLength(value, "utf8") > PUBLIC_VERIFIER_LIMITS.maxInputBytes
    ) {
      throw verifierError("INPUT_SIZE_LIMIT_EXCEEDED", "JSON string exceeds the input-byte limit");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON does not support cycles");
  }

  const childDepth = enterContainer(depth);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const entries = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("canonical JSON does not support sparse arrays");
        }
        entries.push(canonicalize(value[index], ancestors, childDepth, budget));
      }
      return `[${entries.join(",")}]`;
    }
    if (!isPlainObject(value)) {
      throw new TypeError("canonical JSON supports only plain objects and arrays");
    }
    const members = Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(value[key], ancestors, childDepth, budget)}`,
      );
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value) {
  const result = canonicalize(value, new Set(), 0, { nodes: 0 });
  if (Buffer.byteLength(result, "utf8") > PUBLIC_VERIFIER_LIMITS.maxInputBytes) {
    throw verifierError("INPUT_SIZE_LIMIT_EXCEEDED", "canonical JSON exceeds the input-byte limit");
  }
  return result;
}

export function sha256Canonical(value) {
  return sha256Bytes(canonicalJson(value));
}

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
    this.nodes = 0;
  }

  parse() {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.fail("unexpected trailing content");
    }
    return value;
  }

  parseValue(depth) {
    this.skipWhitespace();
    this.nodes += 1;
    if (this.nodes > PUBLIC_VERIFIER_LIMITS.maxJsonNodes) {
      throw verifierError("JSON_NODE_LIMIT_EXCEEDED", "JSON input exceeds the node limit");
    }

    const character = this.text[this.index];
    if (character === "{") {
      return this.parseObject(depth);
    }
    if (character === "[") {
      return this.parseArray(depth);
    }
    if (character === '"') {
      return this.parseString();
    }
    if (character === "t") {
      return this.parseLiteral("true", true);
    }
    if (character === "f") {
      return this.parseLiteral("false", false);
    }
    if (character === "n") {
      return this.parseLiteral("null", null);
    }
    if (character === "-" || (character >= "0" && character <= "9")) {
      return this.parseNumber();
    }
    this.fail("expected a JSON value");
  }

  parseObject(depth) {
    const childDepth = this.enter(depth);
    this.index += 1;
    this.skipWhitespace();
    const value = {};
    const keys = new Set();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return value;
    }

    while (true) {
      if (this.text[this.index] !== '"') {
        this.fail("expected an object key");
      }
      const key = this.parseString();
      if (keys.has(key)) {
        throw verifierError("DUPLICATE_OBJECT_KEY", `duplicate object key: ${key}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        this.fail("expected ':' after an object key");
      }
      this.index += 1;
      Object.defineProperty(value, key, {
        value: this.parseValue(childDepth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") {
        this.fail("expected ',' or '}' in an object");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseArray(depth) {
    const childDepth = this.enter(depth);
    this.index += 1;
    this.skipWhitespace();
    const value = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return value;
    }

    while (true) {
      value.push(this.parseValue(childDepth));
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") {
        this.fail("expected ',' or ']' in an array");
      }
      this.index += 1;
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.fail("invalid JSON string");
        }
      }
      if (character.charCodeAt(0) < 0x20) {
        this.fail("unescaped control character in JSON string");
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
            this.fail("invalid Unicode escape in JSON string");
          }
          this.index += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) {
          this.fail("invalid escape in JSON string");
        }
      }
      this.index += 1;
    }
    this.fail("unterminated JSON string");
  }

  parseLiteral(token, value) {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      this.fail(`invalid literal: expected ${token}`);
    }
    this.index += token.length;
    return value;
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (!match) {
      this.fail("invalid JSON number");
    }
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) {
      this.fail("JSON number is outside the finite number range");
    }
    return value;
  }

  enter(depth) {
    const nextDepth = depth + 1;
    if (nextDepth > PUBLIC_VERIFIER_LIMITS.maxNestingDepth) {
      throw verifierError("JSON_NESTING_LIMIT_EXCEEDED", "JSON input exceeds the nesting-depth limit");
    }
    return nextDepth;
  }

  skipWhitespace() {
    while (
      [" ", "\t", "\n", "\r"].includes(this.text[this.index]) &&
      this.index < this.text.length
    ) {
      this.index += 1;
    }
  }

  fail(message) {
    throw verifierError("INPUT_JSON_INVALID", `${message} at byte offset ${this.index}`);
  }
}

export function parseJsonStrict(text) {
  if (typeof text !== "string") {
    throw new TypeError("strict JSON input must be a string");
  }
  if (Buffer.byteLength(text, "utf8") > PUBLIC_VERIFIER_LIMITS.maxInputBytes) {
    throw verifierError("INPUT_SIZE_LIMIT_EXCEEDED", "JSON input exceeds the input-byte limit");
  }
  return new StrictJsonParser(text).parse();
}

export function hasExactKeys(value, requiredKeys, optionalKeys = []) {
  if (!isPlainObject(value)) {
    return false;
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(value);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => allowed.has(key));
}

function hasAuthorityShape(value) {
  return AUTHORITY_FIELDS.every((field) => typeof value[field] === "boolean");
}

function validFingerprintEnvelope(value) {
  return (
    hasExactKeys(value, ["fingerprintAlgorithm", "fingerprint", "payload"]) &&
    value.fingerprintAlgorithm === "sha256-canonical-json-v1" &&
    typeof value.fingerprint === "string" &&
    HASH_PATTERN.test(value.fingerprint) &&
    isPlainObject(value.payload)
  );
}

function validReceiptShape(receipt) {
  return (
    hasExactKeys(receipt, [
      "schemaVersion",
      "receiptId",
      "status",
      "replacesReceiptId",
      "sourceFingerprint",
      "verificationContextFingerprint",
      ...AUTHORITY_FIELDS,
    ]) &&
    receipt.schemaVersion === "OwlCodaRunKitPublicVerificationReceiptV1" &&
    typeof receipt.receiptId === "string" &&
    receipt.receiptId.length > 0 &&
    ["passed", "failed", "blocked"].includes(receipt.status) &&
    (receipt.replacesReceiptId === null ||
      (typeof receipt.replacesReceiptId === "string" && receipt.replacesReceiptId.length > 0)) &&
    typeof receipt.sourceFingerprint === "string" &&
    HASH_PATTERN.test(receipt.sourceFingerprint) &&
    typeof receipt.verificationContextFingerprint === "string" &&
    HASH_PATTERN.test(receipt.verificationContextFingerprint) &&
    hasAuthorityShape(receipt)
  );
}

function validCloseoutShape(closeout) {
  return (
    hasExactKeys(closeout, [
      "schemaVersion",
      "decision",
      "activeReceiptId",
      "sourceFingerprint",
      "verificationContextFingerprint",
      ...AUTHORITY_FIELDS,
    ]) &&
    closeout.schemaVersion === "OwlCodaRunKitPublicCloseoutV1" &&
    ["accepted", "blocked", "rejected"].includes(closeout.decision) &&
    typeof closeout.activeReceiptId === "string" &&
    closeout.activeReceiptId.length > 0 &&
    typeof closeout.sourceFingerprint === "string" &&
    HASH_PATTERN.test(closeout.sourceFingerprint) &&
    typeof closeout.verificationContextFingerprint === "string" &&
    HASH_PATTERN.test(closeout.verificationContextFingerprint) &&
    hasAuthorityShape(closeout)
  );
}

function issue(code, pathValue, message) {
  if (!FORMAL_ISSUE_CODE_SET.has(code)) {
    throw new Error(`undeclared Formal issue code: ${code}`);
  }
  return { code, path: pathValue, message };
}

function anyAuthorityGranted(value) {
  return AUTHORITY_FIELDS.some((field) => value[field] !== false);
}

function findLineageCycle(receiptsById) {
  for (const receipt of receiptsById.values()) {
    const visited = new Set();
    let current = receipt;
    while (current && current.replacesReceiptId !== null) {
      if (visited.has(current.receiptId)) {
        return true;
      }
      visited.add(current.receiptId);
      current = receiptsById.get(current.replacesReceiptId);
    }
  }
  return false;
}

function emptyResult(issues) {
  return {
    schemaVersion: "OwlCodaRunKitPublicVerificationResultV1",
    status: "invalid",
    valid: false,
    decision: null,
    activeReceiptId: null,
    activeReceiptStatus: null,
    sourceFingerprint: null,
    verificationContextFingerprint: null,
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
    artifactMutationAuthorization: false,
    businessActionAuthorization: false,
    issues,
  };
}

export function verifyBundle(bundle) {
  const issues = [];
  try {
    canonicalJson(bundle);
  } catch (error) {
    if (
      [
        "INPUT_SIZE_LIMIT_EXCEEDED",
        "JSON_NESTING_LIMIT_EXCEEDED",
        "JSON_NODE_LIMIT_EXCEEDED",
      ].includes(error.code)
    ) {
      return emptyResult([issue(error.code, "$", error.message)]);
    }
    return emptyResult([issue("PUBLIC_BUNDLE_SHAPE_INVALID", "$", error.message)]);
  }
  if (
    isPlainObject(bundle) &&
    Array.isArray(bundle.receipts) &&
    bundle.receipts.length > PUBLIC_VERIFIER_LIMITS.maxReceipts
  ) {
    return emptyResult([
      issue(
        "RECEIPT_COUNT_LIMIT_EXCEEDED",
        "$.receipts",
        `receipt count exceeds ${PUBLIC_VERIFIER_LIMITS.maxReceipts}`,
      ),
    ]);
  }
  const rootShapeValid =
    hasExactKeys(bundle, ["schemaVersion", "source", "verificationContext", "receipts", "closeout"]) &&
    bundle.schemaVersion === "OwlCodaRunKitPublicVerificationBundleV1" &&
    validFingerprintEnvelope(bundle.source) &&
    validFingerprintEnvelope(bundle.verificationContext) &&
    Array.isArray(bundle.receipts) &&
    bundle.receipts.length > 0 &&
    bundle.receipts.every(validReceiptShape) &&
    validCloseoutShape(bundle.closeout);

  if (!rootShapeValid) {
    return emptyResult([
      issue(
        "PUBLIC_BUNDLE_SHAPE_INVALID",
        "$",
        "bundle does not match the strict OwlCodaRunKitPublicVerificationBundleV1 shape",
      ),
    ]);
  }

  try {
    if (sha256Canonical(bundle.source.payload) !== bundle.source.fingerprint) {
      issues.push(
        issue("SOURCE_FINGERPRINT_MISMATCH", "$.source.fingerprint", "source payload fingerprint does not match"),
      );
    }
    if (sha256Canonical(bundle.verificationContext.payload) !== bundle.verificationContext.fingerprint) {
      issues.push(
        issue(
          "VERIFICATION_CONTEXT_FINGERPRINT_MISMATCH",
          "$.verificationContext.fingerprint",
          "verification context payload fingerprint does not match",
        ),
      );
    }
  } catch (error) {
    issues.push(issue(error.code ?? "CANONICAL_JSON_INVALID", "$", error.message));
  }

  const receiptsById = new Map();
  for (const receipt of bundle.receipts) {
    if (receiptsById.has(receipt.receiptId)) {
      issues.push(issue("RECEIPT_ID_DUPLICATE", "$.receipts", `duplicate receipt id: ${receipt.receiptId}`));
    } else {
      receiptsById.set(receipt.receiptId, receipt);
    }
    if (receipt.replacesReceiptId !== null && !bundle.receipts.some(
      (candidate) => candidate.receiptId === receipt.replacesReceiptId,
    )) {
      issues.push(
        issue(
          "RECEIPT_LINEAGE_ORPHAN",
          `$.receipts.${receipt.receiptId}.replacesReceiptId`,
          `replacement target is absent: ${receipt.replacesReceiptId}`,
        ),
      );
    }
    if (anyAuthorityGranted(receipt)) {
      issues.push(
        issue("RECEIPT_AUTHORITY_GRANTED", `$.receipts.${receipt.receiptId}`, "a receipt cannot grant external authority"),
      );
    }
  }

  if (findLineageCycle(receiptsById)) {
    issues.push(issue("RECEIPT_LINEAGE_CYCLE", "$.receipts", "receipt replacement lineage contains a cycle"));
  }

  const replacedReceiptIds = new Set(
    bundle.receipts
      .map((receipt) => receipt.replacesReceiptId)
      .filter((receiptId) => receiptId !== null),
  );
  const activeLeaves = bundle.receipts.filter((receipt) => !replacedReceiptIds.has(receipt.receiptId));
  if (activeLeaves.length === 0) {
    issues.push(issue("RECEIPT_LINEAGE_NO_ACTIVE_LEAF", "$.receipts", "receipt lineage has no active leaf"));
  } else if (activeLeaves.length > 1) {
    issues.push(
      issue(
        "RECEIPT_LINEAGE_MULTIPLE_ACTIVE_LEAVES",
        "$.receipts",
        `receipt lineage has ${activeLeaves.length} active leaves`,
      ),
    );
  }

  const activeReceipt = activeLeaves.length === 1 ? activeLeaves[0] : null;
  if (activeReceipt && bundle.closeout.activeReceiptId !== activeReceipt.receiptId) {
    issues.push(
      issue(
        "CLOSEOUT_ACTIVE_RECEIPT_MISMATCH",
        "$.closeout.activeReceiptId",
        "closeout does not name the unique active receipt",
      ),
    );
  }
  if (activeReceipt && activeReceipt.sourceFingerprint !== bundle.source.fingerprint) {
    issues.push(
      issue(
        "ACTIVE_RECEIPT_SOURCE_BINDING_MISMATCH",
        `$.receipts.${activeReceipt.receiptId}.sourceFingerprint`,
        "active receipt is not bound to the declared source fingerprint",
      ),
    );
  }
  if (
    activeReceipt &&
    activeReceipt.verificationContextFingerprint !== bundle.verificationContext.fingerprint
  ) {
    issues.push(
      issue(
        "ACTIVE_RECEIPT_CONTEXT_BINDING_MISMATCH",
        `$.receipts.${activeReceipt.receiptId}.verificationContextFingerprint`,
        "active receipt is not bound to the declared verification context fingerprint",
      ),
    );
  }
  if (bundle.closeout.sourceFingerprint !== bundle.source.fingerprint) {
    issues.push(
      issue("CLOSEOUT_SOURCE_BINDING_MISMATCH", "$.closeout.sourceFingerprint", "closeout source binding does not match"),
    );
  }
  if (bundle.closeout.verificationContextFingerprint !== bundle.verificationContext.fingerprint) {
    issues.push(
      issue(
        "CLOSEOUT_CONTEXT_BINDING_MISMATCH",
        "$.closeout.verificationContextFingerprint",
        "closeout verification context binding does not match",
      ),
    );
  }

  if (anyAuthorityGranted(bundle.closeout)) {
    issues.push(
      issue(
        bundle.closeout.decision === "accepted" ? "ACCEPTED_AUTHORITY_GRANTED" : "EXTERNAL_AUTHORITY_GRANTED",
        "$.closeout",
        "closeout decisions never grant Git, release, mutation, or business-action authority",
      ),
    );
  }
  if (bundle.closeout.decision === "accepted" && activeReceipt?.status !== "passed") {
    issues.push(
      issue(
        "ACCEPTED_RECEIPT_NOT_PASSED",
        "$.closeout.decision",
        "accepted requires the unique active receipt to have passed",
      ),
    );
  }

  const valid = issues.length === 0;
  return {
    schemaVersion: "OwlCodaRunKitPublicVerificationResultV1",
    status: valid ? "verified" : "invalid",
    valid,
    decision: bundle.closeout.decision,
    activeReceiptId: activeReceipt?.receiptId ?? null,
    activeReceiptStatus: activeReceipt?.status ?? null,
    sourceFingerprint: bundle.source.fingerprint,
    verificationContextFingerprint: bundle.verificationContext.fingerprint,
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
    artifactMutationAuthorization: false,
    businessActionAuthorization: false,
    issues,
  };
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "verify") {
    process.stderr.write("usage: node verifier.mjs verify <bundle.json>\n");
    return 2;
  }

  let bundle;
  try {
    bundle = parseJsonStrict(await readUtf8FileBounded(argv[1]));
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify(emptyResult([issue(error.code ?? "INPUT_JSON_INVALID", "$", error.message)]), null, 2)}\n`,
    );
    return 1;
  }

  const result = verifyBundle(bundle);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.valid ? 0 : 1;
}

export async function readUtf8FileBounded(filePath) {
  return decodeUtf8Strict(readFileBytesBounded(filePath).bytes);
}

const isDirectExecution =
  typeof process.argv[1] === "string" && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  process.exitCode = await main(process.argv.slice(2));
}
