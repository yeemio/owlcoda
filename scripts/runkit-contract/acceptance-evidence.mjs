const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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

function validateVersionEntries(values, label) {
  if (!Array.isArray(values)) return [`${label} must be an array.`];
  const issues = [];
  for (const [index, value] of values.entries()) {
    if (!isRecord(value)
      || typeof value.name !== "string"
      || value.name.length === 0
      || typeof value.version !== "string"
      || value.version.length === 0) {
      issues.push(`${label}[${index}] requires name and version.`);
    } else {
      issues.push(...validateAllowedKeys(value, `${label}[${index}]`, ["name", "version"]));
    }
  }
  return issues;
}

function validateHashEntries(values, label, identityField) {
  if (!Array.isArray(values)) return [`${label} must be an array.`];
  const issues = [];
  for (const [index, value] of values.entries()) {
    if (!isRecord(value)
      || typeof value[identityField] !== "string"
      || value[identityField].length === 0
      || typeof value.sha256 !== "string"
      || !SHA256_PATTERN.test(value.sha256)) {
      issues.push(`${label}[${index}] requires ${identityField} and lowercase sha256.`);
    } else {
      issues.push(...validateAllowedKeys(value, `${label}[${index}]`, [identityField, "sha256"]));
    }
  }
  return issues;
}

export function validateReplayableEvidence(evidence) {
  if (!isRecord(evidence)) {
    return { valid: false, issues: ["Replayable evidence must be an object."] };
  }
  const issues = validateAllowedKeys(evidence, "Replayable evidence", [
    "schemaVersion",
    "kind",
    "cwd",
    "launcher",
    "argv",
    "automationManifestSha256",
    "toolVersions",
    "materialInputs",
    "outputArtifacts",
  ]);
  if (evidence.schemaVersion !== "OwlCodaRunKitReplayableEvidenceV1") {
    issues.push("Unsupported replayable evidence schemaVersion.");
  }
  if (!new Set(["shell", "automation"]).has(evidence.kind)) {
    issues.push("Replayable evidence kind must be shell or automation.");
  }
  if (typeof evidence.cwd !== "string" || evidence.cwd.length === 0) {
    issues.push("Replayable evidence requires cwd.");
  }
  if (!isRecord(evidence.launcher)
    || typeof evidence.launcher.executable !== "string"
    || evidence.launcher.executable.length === 0
    || typeof evidence.launcher.version !== "string"
    || evidence.launcher.version.length === 0) {
    issues.push("Replayable evidence requires launcher executable and version.");
  } else {
    issues.push(...validateAllowedKeys(evidence.launcher, "launcher", ["executable", "version"]));
  }
  issues.push(...validateVersionEntries(evidence.toolVersions, "toolVersions"));
  issues.push(...validateHashEntries(evidence.materialInputs, "materialInputs", "id"));
  issues.push(...validateHashEntries(evidence.outputArtifacts, "outputArtifacts", "path"));
  if (evidence.kind === "shell") {
    if (!Array.isArray(evidence.argv)
      || evidence.argv.length === 0
      || typeof evidence.argv[0] !== "string"
      || evidence.argv[0].length === 0
      || evidence.argv.some((value) => typeof value !== "string")) {
      issues.push("Shell evidence requires exact argv with a non-empty executable.");
    }
  } else if (evidence.kind === "automation") {
    if (typeof evidence.automationManifestSha256 !== "string"
      || !SHA256_PATTERN.test(evidence.automationManifestSha256)) {
      issues.push("Automation evidence requires automationManifestSha256.");
    }
    if (!Array.isArray(evidence.outputArtifacts) || evidence.outputArtifacts.length === 0) {
      issues.push("Automation evidence requires at least one output artifact.");
    }
  }
  return { valid: issues.length === 0, issues };
}
