export const OFFICIAL_NPM_REGISTRY = "https://registry.npmjs.org";

const REQUIRED_INSTALL_FIELDS = Object.freeze([
  "requestedSpec",
  "packageName",
  "version",
  "shasum",
  "integrity",
  "resolved",
]);

const RELEASE_EVIDENCE_FIELDS = Object.freeze([
  "authorizationGranted",
  "integrity",
  "packageName",
  "registry",
  "schemaVersion",
  "shasum",
  "status",
  "tarballUrl",
  "version",
]);

const STORED_EVIDENCE_FIELDS = Object.freeze([
  "authorizationGranted",
  "authority",
  "decision",
  "exactSpec",
  "installedBinding",
  "packageName",
  "registryRelease",
  "schemaVersion",
  "status",
  "version",
]);

const STORED_RELEASE_FIELDS = Object.freeze([
  "integrity",
  "packageName",
  "registry",
  "shasum",
  "tarballUrl",
  "version",
]);

const STORED_INSTALL_FIELDS = Object.freeze([
  "integrity",
  "packageName",
  "requestedSpec",
  "resolved",
  "version",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(value, fields) {
  return isRecord(value)
    && Object.keys(value).sort().join("\n") === [...fields].sort().join("\n");
}

function decision(policy, issueCodes) {
  return {
    schemaVersion: "OwlCodaRunKitRegistryAdoptionDecisionV1",
    decision: issueCodes.length === 0 ? "ELIGIBLE" : "INELIGIBLE",
    issueCodes,
    packageName: policy.packageName,
    version: policy.candidateVersion,
    authorizationGranted: false,
  };
}

export function expectedRegistryTarballUrl(packageName, version) {
  const tarballName = packageName.split("/").at(-1);
  return `${OFFICIAL_NPM_REGISTRY}/${packageName}/-/${tarballName}-${version}.tgz`;
}

export function isCanonicalSha512Integrity(value) {
  if (typeof value !== "string") return false;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.length === 64 && bytes.toString("base64") === match[1];
}

export function validateStoredRegistryAdoptionEvidence({
  evidence,
  packageName,
  version,
  localInstall,
}) {
  const issues = [];
  const exactSpec = `${packageName}@${version}`;
  const expectedTarball = expectedRegistryTarballUrl(packageName, version);
  if (
    !hasExactFields(evidence, STORED_EVIDENCE_FIELDS)
    || evidence.schemaVersion !== "OwlCodaRunKitRegistryAdoptionEvidenceV1"
    || evidence.status !== "adopted"
    || evidence.decision !== "ELIGIBLE"
    || evidence.packageName !== packageName
    || evidence.version !== version
    || evidence.exactSpec !== exactSpec
    || evidence.authorizationGranted !== false
  ) {
    issues.push("adoption_evidence_invalid");
  }
  const release = evidence?.registryRelease;
  if (
    !hasExactFields(release, STORED_RELEASE_FIELDS)
    || release.registry !== OFFICIAL_NPM_REGISTRY
    || release.packageName !== packageName
    || release.version !== version
    || !/^[0-9a-f]{40}$/i.test(release.shasum)
    || !isCanonicalSha512Integrity(release.integrity)
    || release.tarballUrl !== expectedTarball
  ) {
    issues.push("adoption_registry_binding_invalid");
  }
  const installed = evidence?.installedBinding;
  if (
    !hasExactFields(installed, STORED_INSTALL_FIELDS)
    || installed.requestedSpec !== exactSpec
    || installed.packageName !== packageName
    || installed.version !== version
    || installed.integrity !== release?.integrity
    || installed.resolved !== expectedTarball
  ) {
    issues.push("adoption_installed_binding_invalid");
  }
  if (
    !hasExactFields(evidence?.authority, ["foreignProjectWrite", "git", "release"])
    || evidence.authority.git !== false
    || evidence.authority.release !== false
    || evidence.authority.foreignProjectWrite !== false
  ) {
    issues.push("adoption_authority_invalid");
  }
  if (
    localInstall !== undefined
    && (
      localInstall.status !== "bound"
      || localInstall.requestedSpec !== exactSpec
      || localInstall.packageName !== packageName
      || localInstall.version !== version
      || localInstall.integrity !== release?.integrity
      || localInstall.resolved !== expectedTarball
    )
  ) {
    issues.push("adoption_local_install_drift");
  }
  const issueCodes = [...new Set(issues)].sort();
  return {
    valid: issueCodes.length === 0,
    issueCodes,
  };
}

function validReleaseEvidence(policy, release) {
  if (
    policy.registry !== OFFICIAL_NPM_REGISTRY
    || Object.keys(release).sort().join("\n") !== RELEASE_EVIDENCE_FIELDS.join("\n")
    || !/^[0-9a-f]{40}$/i.test(release.shasum)
    || !isCanonicalSha512Integrity(release.integrity)
    || release.tarballUrl !== expectedRegistryTarballUrl(
      policy.packageName,
      policy.candidateVersion,
    )
  ) {
    return false;
  }
  return true;
}

export function evaluateRegistryAdoption({ policy, releaseEvidence, install }) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("Registry release policy must be an object.");
  }
  if (!install || typeof install !== "object" || Array.isArray(install)) {
    return decision(policy, ["registry_install_binding_missing"]);
  }
  if (install.kind !== "registry") {
    return decision(policy, ["registry_source_required"]);
  }
  if (REQUIRED_INSTALL_FIELDS.some((field) =>
    typeof install[field] !== "string" || install[field].length === 0)) {
    return decision(policy, ["registry_install_binding_missing"]);
  }
  if (
    !releaseEvidence
    || typeof releaseEvidence !== "object"
    || Array.isArray(releaseEvidence)
    || releaseEvidence.schemaVersion !== policy.registryEvidenceSchemaVersion
    || releaseEvidence.status !== "registry_verified"
    || releaseEvidence.authorizationGranted !== false
  ) {
    return decision(policy, ["registry_release_not_verified"]);
  }

  const release = releaseEvidence;
  if (!validReleaseEvidence(policy, release)) {
    return decision(policy, ["registry_release_evidence_invalid"]);
  }
  if (
    release.registry !== policy.registry
    || release.packageName !== policy.packageName
    || release.version !== policy.candidateVersion
  ) {
    return decision(policy, ["registry_release_evidence_mismatch"]);
  }
  const expectedSpec = `${policy.packageName}@${release.version}`;
  if (install.requestedSpec !== expectedSpec) {
    return decision(policy, ["registry_exact_version_required"]);
  }
  if (install.packageName !== release.packageName) {
    return decision(policy, ["registry_package_name_mismatch"]);
  }
  if (install.version !== release.version) {
    return decision(policy, ["registry_version_mismatch"]);
  }
  if (install.shasum !== release.shasum) {
    return decision(policy, ["registry_shasum_mismatch"]);
  }
  if (install.integrity !== release.integrity) {
    return decision(policy, ["registry_integrity_mismatch"]);
  }
  if (install.resolved !== release.tarballUrl) {
    return decision(policy, ["registry_tarball_url_mismatch"]);
  }
  return decision(policy, []);
}
