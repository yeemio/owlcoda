import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  OFFICIAL_NPM_REGISTRY,
  evaluateRegistryAdoption,
} from "./registry-adoption-gate.mjs";
import { CORE_VERSION } from "./core-contract.mjs";
import {
  readLocalInstallBinding,
  readRegistryExact,
  resolveBoundedWorkspaceRoot,
} from "./onboarding-doctor.mjs";
import { writeJsonExclusiveAtomically } from "./provenance-common.mjs";

const PACKAGE_NAME = "owlrunkit";
const CANDIDATE_VERSION = CORE_VERSION;
const EXACT_SPEC = `${PACKAGE_NAME}@${CANDIDATE_VERSION}`;

const POLICY = Object.freeze({
  schemaVersion: "OwlCodaRunKitRegistryReleasePolicyV1",
  status: "registry_verified",
  packageName: PACKAGE_NAME,
  candidateVersion: CANDIDATE_VERSION,
  registry: OFFICIAL_NPM_REGISTRY,
  registryRequiredBeforeAdoption: true,
  exactVersionRequired: true,
  requiredRegistryBindings: [
    "packageName",
    "version",
    "shasum",
    "integrity",
    "tarballUrl",
  ],
  forbiddenAdoptionSources: [
    "directory",
    "file",
    "git",
    "local_tarball",
    "symlink",
    "workspace",
  ],
  currentPublishedRelease: null,
  registryRelease: null,
  registryEvidenceMustBeExternal: true,
  registryEvidenceSchemaVersion: "OwlCodaRunKitRegistryReleaseEvidenceV1",
  embeddedAttestComponentVersion: "0.2.0",
  standaloneAttestPublicationRequired: false,
  signatureRequired: false,
  githubActionRequired: false,
  foreignProjectWriteAuthorized: false,
  authorizationGranted: false,
});

function ineligible(issueCodes) {
  return {
    schemaVersion: "OwlCodaRunKitRegistryAdoptionResultV1",
    status: "ineligible",
    decision: "INELIGIBLE",
    issueCodes,
    packageName: PACKAGE_NAME,
    version: CANDIDATE_VERSION,
    authorizationGranted: false,
  };
}

function assertRealDirectory(directory, label) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== path.resolve(directory)) {
    throw new Error(`${label} must be a real directory without symlink ancestors.`);
  }
}

function adoptionRoot(workspaceRoot) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  const owlcodaRoot = path.join(root, ".owlcoda");
  const runtimeRoot = path.join(owlcodaRoot, "runkit");
  assertRealDirectory(owlcodaRoot, ".owlcoda");
  assertRealDirectory(runtimeRoot, "RunKit runtime");
  const target = path.join(runtimeRoot, "adoption");
  if (!existsSync(target)) mkdirSync(target);
  assertRealDirectory(target, "RunKit adoption directory");
  return target;
}

export async function runRegistryAdoption({
  workspaceRoot,
  exactSpec,
  registryClient,
  timeoutMs = 1_500,
} = {}) {
  if (exactSpec !== EXACT_SPEC) return ineligible(["exact_registry_spec_required"]);
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  const local = readLocalInstallBinding({ workspaceRoot: root });
  if (local.status !== "bound") {
    return ineligible(local.issueCodes ?? ["registry_install_binding_mismatch"]);
  }
  const observedRelease = registryClient
    ? await registryClient.readExact({
        registry: OFFICIAL_NPM_REGISTRY,
        packageName: PACKAGE_NAME,
        version: CANDIDATE_VERSION,
      })
    : await readRegistryExact({
        registryUrl: OFFICIAL_NPM_REGISTRY,
        packageName: PACKAGE_NAME,
        version: CANDIDATE_VERSION,
        timeoutMs,
      });
  const release = observedRelease.status === "registry_verified"
    ? {
        schemaVersion: "OwlCodaRunKitRegistryReleaseEvidenceV1",
        ...observedRelease,
      }
    : observedRelease;
  if (release.status !== "registry_verified") {
    return ineligible(release.issueCodes ?? ["registry_release_not_verified"]);
  }
  const install = {
    kind: "registry",
    requestedSpec: EXACT_SPEC,
    packageName: local.packageName,
    version: local.version,
    shasum: release.shasum,
    integrity: local.integrity,
    resolved: local.resolved,
  };
  const decision = evaluateRegistryAdoption({
    policy: POLICY,
    releaseEvidence: release,
    install,
  });
  if (decision.decision !== "ELIGIBLE") return ineligible(decision.issueCodes);

  const relativeEvidencePath = `.owlcoda/runkit/adoption/${PACKAGE_NAME}-${CANDIDATE_VERSION}.json`;
  const evidencePath = path.join(adoptionRoot(root), `${PACKAGE_NAME}-${CANDIDATE_VERSION}.json`);
  const evidence = {
    schemaVersion: "OwlCodaRunKitRegistryAdoptionEvidenceV1",
    status: "adopted",
    decision: "ELIGIBLE",
    packageName: PACKAGE_NAME,
    version: CANDIDATE_VERSION,
    exactSpec: EXACT_SPEC,
    registryRelease: {
      registry: release.registry,
      packageName: release.packageName,
      version: release.version,
      shasum: release.shasum,
      integrity: release.integrity,
      tarballUrl: release.tarballUrl,
    },
    installedBinding: {
      requestedSpec: local.requestedSpec,
      packageName: local.packageName,
      version: local.version,
      resolved: local.resolved,
      integrity: local.integrity,
    },
    authority: {
      git: false,
      release: false,
      foreignProjectWrite: false,
    },
    authorizationGranted: false,
  };
  writeJsonExclusiveAtomically(evidencePath, evidence);
  return {
    schemaVersion: "OwlCodaRunKitRegistryAdoptionResultV1",
    status: "adopted",
    decision: "ELIGIBLE",
    evidencePath: relativeEvidencePath,
    issueCodes: [],
    packageName: PACKAGE_NAME,
    version: CANDIDATE_VERSION,
    authorizationGranted: false,
  };
}

export function formatAdoptionHuman(result) {
  if (result.status === "adopted") {
    return [
      `Adopted ${result.packageName}@${result.version}`,
      `Evidence: ${result.evidencePath}`,
      "Git and release authority remain false.",
      "",
    ].join("\n");
  }
  return [
    `Adoption blocked: ${result.issueCodes.join(", ")}`,
    "No adoption evidence was written.",
    "",
  ].join("\n");
}
