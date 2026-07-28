import { createHash } from "node:crypto";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const REUSE_POLICIES = new Set([
  "portable",
  "platform_bound",
  "environment_bound",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAllowedKeys(value, label, allowedKeys) {
  if (!isRecord(value)) return [];
  const allowed = new Set(allowedKeys);
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${label} contains unsupported field: ${key}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateNamedEntries(values, label, fields) {
  const issues = [];
  if (!Array.isArray(values)) return [`${label} must be an array.`];
  const identities = new Set();
  for (const [index, value] of values.entries()) {
    if (!isRecord(value)) {
      issues.push(`${label}[${index}] must be an object.`);
      continue;
    }
    issues.push(...validateAllowedKeys(value, `${label}[${index}]`, fields));
    for (const field of fields) {
      if (typeof value[field] !== "string" || value[field].length === 0) {
        issues.push(`${label}[${index}].${field} must be a non-empty string.`);
      }
    }
    const identity = value[fields[0]];
    if (typeof identity === "string") {
      if (identities.has(identity)) issues.push(`${label} contains duplicate ${fields[0]}: ${identity}`);
      identities.add(identity);
    }
  }
  return issues;
}

function validateHashEntries(values, label, identityField, hashField) {
  const issues = validateNamedEntries(values, label, [identityField, hashField]);
  if (Array.isArray(values)) {
    for (const [index, value] of values.entries()) {
      if (isRecord(value) && typeof value[hashField] === "string" && !SHA256_PATTERN.test(value[hashField])) {
        issues.push(`${label}[${index}].${hashField} must be a lowercase SHA-256.`);
      }
    }
  }
  return issues;
}

export function validateVerificationContext(context) {
  if (!isRecord(context)) return { valid: false, issues: ["Verification context must be an object."] };
  const issues = validateAllowedKeys(context, "Verification context", [
    "schemaVersion",
    "reusePolicy",
    "platform",
    "toolchains",
    "lockfiles",
    "fixtures",
    "services",
    "environment",
  ]);
  if (context.schemaVersion !== "OwlCodaRunKitVerificationContextV1") {
    issues.push("Unsupported verification context schemaVersion.");
  }
  if (!REUSE_POLICIES.has(context.reusePolicy)) {
    issues.push("reusePolicy must be portable, platform_bound, or environment_bound.");
  }
  if (context.reusePolicy === "portable" && context.platform !== null) {
    issues.push("portable verification context must use platform=null.");
  }
  if (context.reusePolicy !== "portable") {
    if (!isRecord(context.platform)
      || typeof context.platform.os !== "string"
      || typeof context.platform.arch !== "string") {
      issues.push("Bound verification context requires platform.os and platform.arch.");
    } else {
      issues.push(...validateAllowedKeys(context.platform, "platform", ["os", "arch"]));
    }
  }
  issues.push(...validateNamedEntries(context.toolchains, "toolchains", ["name", "version"]));
  issues.push(...validateHashEntries(context.lockfiles, "lockfiles", "path", "sha256"));
  issues.push(...validateHashEntries(context.fixtures, "fixtures", "id", "sha256"));
  issues.push(...validateNamedEntries(context.services, "services", ["id", "identity"]));
  issues.push(...validateHashEntries(context.environment, "environment", "name", "valueSha256"));
  if (
    context.reusePolicy === "environment_bound"
    && Array.isArray(context.fixtures)
    && Array.isArray(context.services)
    && Array.isArray(context.environment)
    && context.fixtures.length + context.services.length + context.environment.length === 0
  ) {
    issues.push("environment_bound verification context requires material fixtures, services, or environment identity.");
  }
  return { valid: issues.length === 0, issues };
}

function sortedEntries(values) {
  return [...values].map((value) => structuredClone(value)).sort((left, right) => {
    const leftCanonical = canonicalJson(left);
    const rightCanonical = canonicalJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
}

export function canonicalVerificationContext(context) {
  const validation = validateVerificationContext(context);
  if (!validation.valid) throw new Error(validation.issues.join("; "));
  return canonicalJson({
    schemaVersion: context.schemaVersion,
    reusePolicy: context.reusePolicy,
    platform: context.platform === null ? null : structuredClone(context.platform),
    toolchains: sortedEntries(context.toolchains),
    lockfiles: sortedEntries(context.lockfiles),
    fixtures: sortedEntries(context.fixtures),
    services: sortedEntries(context.services),
    environment: sortedEntries(context.environment),
  });
}

export function verificationContextFingerprint(context) {
  return createHash("sha256").update(canonicalVerificationContext(context)).digest("hex");
}
