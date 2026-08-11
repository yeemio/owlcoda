import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";

const MAX_FLEET_MANIFEST_BYTES = 1_048_576;
const MAX_FLEET_WORKSPACES = 256;
const MAX_FLEET_ROOTS = 32;
const MAX_SCAN_DIRECTORIES = 10_000;
const MAX_SCAN_DEPTH = 16;
const FLEET_REGISTRY_SCHEMA =
  "OwlCodaRunKitFleetRootRegistryV1";
const FLEET_REGISTRY_SCHEMA_V2 =
  "OwlCodaRunKitFleetRootRegistryV2";
const FLEET_MEMBERSHIP_SCHEMA =
  "OwlCodaRunKitFleetMembershipV1";
const SKIPPED_DIRECTORIES = new Set([
  ".cache",
  ".git",
  ".hg",
  ".owlcoda",
  ".svn",
  "node_modules",
]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function canonicalWorkspace(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("fleet_workspace_invalid");
  }
  const requested = path.resolve(workspaceRoot);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink()) throw new Error("fleet_workspace_symlink_rejected");
  if (!stat.isDirectory()) throw new Error("fleet_workspace_invalid");
  return realpath(requested);
}

function frozenManifestSha256({
  coverageRoots,
  workspaceRoots,
  classifications = emptyClassifications(),
}) {
  const frozen = {
    schemaVersion: "OwlCodaRunKitFrozenFleetManifestV1",
    skillName: "owlcoda-runkit",
    coverageRoots,
    workspaceRoots,
    classifications,
    authorizationGranted: false,
  };
  return `sha256:${createHash("sha256")
    .update(`${JSON.stringify(frozen)}\n`)
    .digest("hex")}`;
}

function sha256Json(value) {
  return `sha256:${createHash("sha256")
    .update(`${JSON.stringify(value)}\n`)
    .digest("hex")}`;
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function emptyClassifications() {
  return {
    active: [],
    retired: [],
    excluded: [],
    invalid: [],
  };
}

export function defaultFleetRegistryPath() {
  const owlcodaHome = process.env.OWLCODA_HOME
    ? path.resolve(process.env.OWLCODA_HOME)
    : path.join(userInfo().homedir, ".owlcoda");
  return path.join(owlcodaHome, "runkit-fleet-root-registry-v1.json");
}

async function inspectRunKitMarker(directory) {
  const owlRoot = path.join(directory, ".owlcoda");
  const runkitRoot = path.join(owlRoot, "runkit");
  const configPath = path.join(runkitRoot, "config.json");

  let owlStat;
  try {
    owlStat = await lstat(owlRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "none" };
    throw error;
  }
  if (
    owlStat.isSymbolicLink()
    || !owlStat.isDirectory()
    || await realpath(owlRoot) !== path.resolve(owlRoot)
  ) {
    return { status: "issue", code: "fleet_project_marker_invalid" };
  }

  let runkitStat;
  try {
    runkitStat = await lstat(runkitRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "none" };
    throw error;
  }
  if (
    runkitStat.isSymbolicLink()
    || !runkitStat.isDirectory()
    || await realpath(runkitRoot) !== path.resolve(runkitRoot)
  ) {
    return { status: "issue", code: "fleet_project_marker_invalid" };
  }

  let configStat;
  try {
    configStat = await lstat(configPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "issue", code: "fleet_project_marker_incomplete" };
    }
    throw error;
  }
  if (
    configStat.isSymbolicLink()
    || !configStat.isFile()
    || await realpath(configPath) !== path.resolve(configPath)
  ) {
    return { status: "issue", code: "fleet_project_marker_invalid" };
  }
  return { status: "project" };
}

async function inspectRepositoryBoundary(directory) {
  const markerPath = path.join(directory, ".git");
  let marker;
  try {
    marker = await lstat(markerPath);
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "none" };
    throw error;
  }
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    return { status: "issue", code: "fleet_repository_marker_invalid" };
  }
  return { status: "repository" };
}

async function scanFleetRoot(fleetRoot) {
  const requested = path.resolve(fleetRoot);
  const canonicalRoot = await canonicalWorkspace(requested);
  const projects = [];
  const issues = [];
  let visitedDirectories = 0;
  let scanStopped = false;
  async function visit(directory, depth) {
    if (scanStopped) return;
    if (depth > MAX_SCAN_DEPTH) {
      issues.push({
        code: "fleet_scan_depth_exceeded",
        path: directory,
        coverageRoot: canonicalRoot,
      });
      return;
    }
    visitedDirectories += 1;
    if (visitedDirectories > MAX_SCAN_DIRECTORIES) {
      scanStopped = true;
      issues.push({
        code: "fleet_scan_directory_limit_exceeded",
        path: directory,
        coverageRoot: canonicalRoot,
      });
      return;
    }
    const marker = await inspectRunKitMarker(directory);
    if (marker.status === "project") {
      projects.push(directory);
      return;
    }
    if (marker.status === "issue") {
      issues.push({
        code: marker.code,
        path: directory,
        coverageRoot: canonicalRoot,
      });
      return;
    }
    const repository = await inspectRepositoryBoundary(directory);
    if (repository.status === "repository") return;
    if (repository.status === "issue") {
      issues.push({
        code: repository.code,
        path: directory,
        coverageRoot: canonicalRoot,
      });
      return;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
      if (!entry.isDirectory()) continue;
      await visit(path.join(directory, entry.name), depth + 1);
    }
  }
  await visit(canonicalRoot, 0);
  return {
    coverageRoot: canonicalRoot,
    workspaceRoots: projects,
    issues,
  };
}

async function discoverFromFleetRoots(
  fleetRoots,
  {
    source = "fleet_roots",
    registryPath = null,
    registrySha256 = null,
  } = {},
) {
  if (
    !Array.isArray(fleetRoots)
    || fleetRoots.length === 0
    || fleetRoots.length > MAX_FLEET_ROOTS
  ) {
    throw new Error("fleet_roots_required");
  }
  const coverageRoots = [];
  const unreachableRoots = [];
  const workspaceRoots = [];
  const issues = [];
  for (const fleetRoot of fleetRoots) {
    if (typeof fleetRoot !== "string" || fleetRoot.length === 0) {
      throw new Error("fleet_root_invalid");
    }
    try {
      const scanned = await scanFleetRoot(fleetRoot);
      coverageRoots.push(scanned.coverageRoot);
      workspaceRoots.push(...scanned.workspaceRoots);
      issues.push(...scanned.issues);
    } catch (error) {
      unreachableRoots.push(path.resolve(fleetRoot));
      issues.push({
        code: error instanceof Error ? error.message : "fleet_root_unreachable",
        path: path.resolve(fleetRoot),
        coverageRoot: path.resolve(fleetRoot),
      });
    }
  }
  const normalizedCoverage = [...new Set(coverageRoots)].sort(compareCodeUnits);
  const normalizedUnreachable = [...new Set(unreachableRoots)].sort(compareCodeUnits);
  const normalizedWorkspaces = [...new Set(workspaceRoots)].sort(compareCodeUnits);
  issues.sort((left, right) => (
    compareCodeUnits(left.path, right.path)
    || compareCodeUnits(left.code, right.code)
  ));
  const classifications = emptyClassifications();
  classifications.active = normalizedWorkspaces;
  if (normalizedWorkspaces.length > MAX_FLEET_WORKSPACES) {
    throw new Error("fleet_workspace_limit_exceeded");
  }
  return {
    schemaVersion: "OwlCodaRunKitFleetDiscoveryV1",
    source,
    ...(registryPath === null
      ? {}
      : { registryPath, registrySha256 }),
    coverageRoots: normalizedCoverage,
    unreachableRoots: normalizedUnreachable,
    workspaceRoots: normalizedWorkspaces,
    classifications,
    issues,
    complete: normalizedUnreachable.length === 0 && issues.length === 0,
    frozenManifestSha256: frozenManifestSha256({
      coverageRoots: normalizedCoverage,
      workspaceRoots: normalizedWorkspaces,
      classifications,
    }),
    authorizationGranted: false,
  };
}

function expectedMembershipEntryKeys(classification) {
  if (classification === "active") return ["classification", "path"];
  return ["classification", "evidence", "path", "reasonCode"];
}

async function validateMembership(
  membership,
  coverageRoots,
  { verifyEvidence = false } = {},
) {
  if (
    membership === null
    || typeof membership !== "object"
    || Array.isArray(membership)
    || Object.keys(membership).some(key => ![
      "authorizationGranted",
      "entries",
      "manifestSha256",
      "schemaVersion",
    ].includes(key))
    || membership.schemaVersion !== FLEET_MEMBERSHIP_SCHEMA
    || membership.authorizationGranted !== false
    || !Array.isArray(membership.entries)
    || membership.entries.length === 0
    || membership.entries.length > MAX_FLEET_WORKSPACES
  ) throw new Error("fleet_membership_invalid");

  const normalizedEntries = [];
  const issues = [];
  for (const entry of membership.entries) {
    if (
      entry === null
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !["active", "retired", "excluded", "invalid"].includes(
        entry.classification,
      )
      || Object.keys(entry).sort().join(",") !== expectedMembershipEntryKeys(
        entry.classification,
      ).sort().join(",")
      || typeof entry.path !== "string"
      || entry.path.length === 0
      || !path.isAbsolute(entry.path)
    ) throw new Error("fleet_membership_entry_invalid");
    const normalizedPath = path.resolve(entry.path);
    if (!coverageRoots.some(root => within(root, normalizedPath))) {
      throw new Error("fleet_membership_entry_outside_coverage");
    }
    if (entry.classification !== "active") {
      if (
        typeof entry.reasonCode !== "string"
        || entry.reasonCode.length === 0
        || entry.evidence === null
        || typeof entry.evidence !== "object"
        || Array.isArray(entry.evidence)
        || Object.keys(entry.evidence).sort().join(",") !== "path,sha256"
        || typeof entry.evidence.path !== "string"
        || !path.isAbsolute(entry.evidence.path)
        || !/^sha256:[a-f0-9]{64}$/u.test(entry.evidence.sha256 ?? "")
      ) throw new Error("fleet_membership_evidence_invalid");
    }
    normalizedEntries.push({
      ...entry,
      path: normalizedPath,
      ...(entry.evidence === undefined
        ? {}
        : {
          evidence: {
            path: path.resolve(entry.evidence.path),
            sha256: entry.evidence.sha256,
          },
        }),
    });
  }
  normalizedEntries.sort((left, right) => compareCodeUnits(left.path, right.path));
  if (new Set(normalizedEntries.map(entry => entry.path)).size !== normalizedEntries.length) {
    throw new Error("fleet_membership_path_duplicate");
  }
  const body = {
    schemaVersion: FLEET_MEMBERSHIP_SCHEMA,
    entries: normalizedEntries,
    authorizationGranted: false,
  };
  const manifestSha256 = sha256Json(body);
  if (
    membership.manifestSha256 !== undefined
    && membership.manifestSha256 !== manifestSha256
  ) throw new Error("fleet_membership_hash_mismatch");

  if (verifyEvidence) {
    for (const entry of normalizedEntries) {
      if (entry.classification === "active") {
        try {
          const canonical = await canonicalWorkspace(entry.path);
          const marker = await inspectRunKitMarker(canonical);
          if (marker.status !== "project") {
            issues.push({
              code: marker.code ?? "fleet_active_project_marker_missing",
              path: entry.path,
              coverageRoot: coverageRoots.find(root => within(root, entry.path)),
            });
          } else {
            entry.path = canonical;
          }
        } catch (error) {
          issues.push({
            code: error instanceof Error
              ? error.message
              : "fleet_active_project_unreadable",
            path: entry.path,
            coverageRoot: coverageRoots.find(root => within(root, entry.path)),
          });
        }
        continue;
      }
      let evidence;
      try {
        evidence = await readManifestBounded(entry.evidence.path);
        if (evidence.fileSha256 !== entry.evidence.sha256) {
          throw new Error("fleet_membership_evidence_hash_mismatch");
        }
      } catch (error) {
        issues.push({
          code: error instanceof Error
            ? error.message
            : "fleet_membership_evidence_invalid",
          path: entry.path,
          coverageRoot: coverageRoots.find(root => within(root, entry.path)),
        });
        continue;
      }
      if (entry.classification === "retired") {
        const receipt = evidence.manifest;
        if (
          receipt?.status !== "retired"
          || path.resolve(receipt.sourceProjectPath ?? "") !== entry.path
          || receipt.sourceRemoval?.sourcePathAbsent !== true
          || receipt.revokedControlFacts?.execution?.disposition
            !== "explicitly_voided"
          || receipt.revokedControlFacts?.lease?.disposition
            !== "explicitly_voided"
          || receipt.archive?.manifestsIdentical !== true
          || receipt.retirementAuthorization !== "explicit_user_authorization"
          || receipt.authorizationGranted !== false
          || await pathExists(path.join(entry.path, ".owlcoda/runkit"))
        ) {
          issues.push({
            code: "fleet_retirement_evidence_invalid",
            path: entry.path,
            coverageRoot: coverageRoots.find(root => within(root, entry.path)),
          });
        }
      } else {
        const matched = evidence.manifest?.schemaVersion
          === "OwlCodaRunKitFleetClassificationEvidenceV1"
          && evidence.manifest.authorizationGranted === false
          && Array.isArray(evidence.manifest.entries)
          && evidence.manifest.entries.some(candidate => (
            path.resolve(candidate?.path ?? "") === entry.path
            && candidate.classification === entry.classification
            && candidate.reasonCode === entry.reasonCode
          ));
        if (!matched) {
          issues.push({
            code: "fleet_classification_evidence_invalid",
            path: entry.path,
            coverageRoot: coverageRoots.find(root => within(root, entry.path)),
          });
        }
      }
    }
  }

  return {
    ...body,
    manifestSha256,
    issues,
  };
}

async function readFleetRegistry(fleetRegistryPath) {
  const selected = path.resolve(
    fleetRegistryPath ?? defaultFleetRegistryPath(),
  );
  let loaded;
  try {
    loaded = await readManifestBounded(selected);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("fleet_registry_missing");
    throw error;
  }
  const registry = loaded.manifest;
  const commonInvalid = (
    registry === null
    || typeof registry !== "object"
    || Array.isArray(registry)
    || registry.authorizationGranted !== false
    || !Array.isArray(registry.coverageRoots)
    || registry.coverageRoots.length === 0
    || registry.coverageRoots.length > MAX_FLEET_ROOTS
  );
  if (commonInvalid) throw new Error("fleet_registry_invalid");
  const v1 = registry.schemaVersion === FLEET_REGISTRY_SCHEMA
    && Object.keys(registry).sort().join(",")
      === "authorizationGranted,coverageRoots,registrySha256,schemaVersion";
  const v2 = registry.schemaVersion === FLEET_REGISTRY_SCHEMA_V2
    && Object.keys(registry).sort().join(",")
      === "authorizationGranted,coverageRoots,membership,registrySha256,schemaVersion";
  if (!v1 && !v2) throw new Error("fleet_registry_invalid");
  const membership = v2
    ? await validateMembership(registry.membership, registry.coverageRoots)
    : null;
  const body = v1
    ? {
      schemaVersion: registry.schemaVersion,
      coverageRoots: registry.coverageRoots,
      authorizationGranted: false,
    }
    : {
      schemaVersion: registry.schemaVersion,
      coverageRoots: registry.coverageRoots,
      membership: {
        schemaVersion: membership.schemaVersion,
        entries: membership.entries,
        authorizationGranted: false,
        manifestSha256: membership.manifestSha256,
      },
      authorizationGranted: false,
    };
  if (registry.registrySha256 !== sha256Json(body)) {
    throw new Error("fleet_registry_hash_mismatch");
  }
  return {
    registryPath: loaded.manifestPath,
    schemaVersion: registry.schemaVersion,
    registrySha256: registry.registrySha256,
    fileSha256: loaded.fileSha256,
    fileBytes: loaded.bytes,
    coverageRoots: [...registry.coverageRoots],
    membership: membership === null
      ? null
      : {
        schemaVersion: membership.schemaVersion,
        entries: membership.entries,
        authorizationGranted: false,
        manifestSha256: membership.manifestSha256,
      },
  };
}

export async function inspectFleetRegistry({
  fleetRegistryPath = defaultFleetRegistryPath(),
} = {}) {
  const registry = await readFleetRegistry(fleetRegistryPath);
  return {
    status: "fleet_registry_inspected",
    schemaVersion: registry.schemaVersion,
    registryPath: registry.registryPath,
    registrySha256: registry.registrySha256,
    fileSha256: registry.fileSha256,
    coverageRoots: registry.coverageRoots,
    membership: registry.membership,
    authorizationGranted: false,
  };
}

export async function registerFleetCoverageRoot({
  fleetRoot,
  fleetRegistryPath = defaultFleetRegistryPath(),
} = {}) {
  const coverageRoot = await canonicalWorkspace(fleetRoot);
  const registryPath = path.resolve(fleetRegistryPath);
  const parent = path.dirname(registryPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const lockPath = `${registryPath}.lock`;
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("fleet_registry_transaction_active");
    throw error;
  }
  try {
    let coverageRoots = [];
    try {
      coverageRoots = (await readFleetRegistry(registryPath)).coverageRoots;
    } catch (error) {
      if (error?.message !== "fleet_registry_missing") throw error;
    }
    const alreadyRegistered = coverageRoots.includes(coverageRoot);
    const normalized = [...new Set([
      ...coverageRoots,
      coverageRoot,
    ])].sort(compareCodeUnits);
    if (normalized.length > MAX_FLEET_ROOTS) {
      throw new Error("fleet_registry_root_limit_exceeded");
    }
    const body = {
      schemaVersion: FLEET_REGISTRY_SCHEMA,
      coverageRoots: normalized,
      authorizationGranted: false,
    };
    const registry = {
      ...body,
      registrySha256: sha256Json(body),
    };
    if (!alreadyRegistered) {
      const temporaryPath = `${registryPath}.tmp-${process.pid}`;
      try {
        await writeFile(
          temporaryPath,
          `${JSON.stringify(registry, null, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        await rename(temporaryPath, registryPath);
      } finally {
        await rm(temporaryPath, { force: true });
      }
    }
    return {
      status: alreadyRegistered
        ? "fleet_root_already_registered"
        : "fleet_root_registered",
      registryPath,
      registrySha256: registry.registrySha256,
      coverageRoots: normalized,
      authorizationGranted: false,
    };
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function pathExists(selected) {
  try {
    await lstat(selected);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function validateRemovedCoverageEvidence(removedRoots, entries) {
  if (!Array.isArray(entries)) {
    throw new Error("fleet_registry_removed_coverage_evidence_invalid");
  }
  const byRoot = new Map();
  for (const entry of entries) {
    if (
      entry === null
      || typeof entry !== "object"
      || Array.isArray(entry)
      || Object.keys(entry).sort().join(",") !== "coverageRoot,evidence"
      || typeof entry.coverageRoot !== "string"
      || !path.isAbsolute(entry.coverageRoot)
      || entry.evidence === null
      || typeof entry.evidence !== "object"
      || Array.isArray(entry.evidence)
      || Object.keys(entry.evidence).sort().join(",") !== "path,sha256"
      || typeof entry.evidence.path !== "string"
      || !path.isAbsolute(entry.evidence.path)
      || !/^sha256:[a-f0-9]{64}$/u.test(entry.evidence.sha256 ?? "")
    ) throw new Error("fleet_registry_removed_coverage_evidence_invalid");
    const coverageRoot = path.resolve(entry.coverageRoot);
    if (byRoot.has(coverageRoot)) {
      throw new Error("fleet_registry_removed_coverage_evidence_invalid");
    }
    const loaded = await readManifestBounded(entry.evidence.path);
    if (
      loaded.fileSha256 !== entry.evidence.sha256
      || loaded.manifest?.schemaVersion
        !== "OwlCodaRunKitFleetCoverageExclusionEvidenceV1"
      || path.resolve(loaded.manifest.coverageRoot ?? "") !== coverageRoot
      || typeof loaded.manifest.reasonCode !== "string"
      || loaded.manifest.reasonCode.length === 0
      || loaded.manifest.authorizationGranted !== false
    ) throw new Error("fleet_registry_removed_coverage_evidence_invalid");
    byRoot.set(coverageRoot, {
      coverageRoot,
      evidence: {
        path: loaded.manifestPath,
        sha256: loaded.fileSha256,
      },
    });
  }
  if (
    removedRoots.length !== byRoot.size
    || removedRoots.some(root => !byRoot.has(root))
  ) throw new Error("fleet_registry_coverage_reduction_evidence_required");
  return [...byRoot.values()].sort((left, right) => (
    compareCodeUnits(left.coverageRoot, right.coverageRoot)
  ));
}

function registryReplacementResult({
  status,
  registryPath,
  before,
  afterRegistry,
  afterBytes,
  coverageDelta,
  receiptPath = null,
}) {
  return {
    status,
    registryPath,
    beforeRegistrySha256: before.registrySha256,
    afterRegistrySha256: afterRegistry.registrySha256,
    beforeFileSha256: before.fileSha256,
    afterFileSha256: sha256Bytes(afterBytes),
    coverageDelta,
    ...(receiptPath === null ? {} : { receiptPath }),
    authorizationGranted: false,
  };
}

export async function replaceFleetRegistry({
  replacementRequestPath,
  receiptPath,
  dryRun = false,
  fleetRegistryPath = defaultFleetRegistryPath(),
} = {}) {
  const request = await readManifestBounded(replacementRequestPath);
  if (
    request.manifest === null
    || typeof request.manifest !== "object"
    || Array.isArray(request.manifest)
    || Object.keys(request.manifest).sort().join(",")
      !== "authorizationGranted,coverageRoots,expectedRegistrySha256,membership,removedCoverageEvidence,schemaVersion"
    || request.manifest.schemaVersion
      !== "OwlCodaRunKitFleetRegistryReplacementRequestV1"
    || request.manifest.authorizationGranted !== false
    || !/^sha256:[a-f0-9]{64}$/u.test(
      request.manifest.expectedRegistrySha256 ?? "",
    )
    || !Array.isArray(request.manifest.coverageRoots)
    || request.manifest.coverageRoots.length === 0
    || request.manifest.coverageRoots.length > MAX_FLEET_ROOTS
  ) throw new Error("fleet_registry_replacement_request_invalid");

  const before = await readFleetRegistry(fleetRegistryPath);
  if (before.registrySha256 !== request.manifest.expectedRegistrySha256) {
    throw new Error("fleet_registry_replacement_preimage_mismatch");
  }
  const coverageRoots = [];
  for (const fleetRoot of request.manifest.coverageRoots) {
    coverageRoots.push(await canonicalWorkspace(fleetRoot));
  }
  const normalizedCoverage = [...new Set(coverageRoots)].sort(compareCodeUnits);
  if (normalizedCoverage.length !== request.manifest.coverageRoots.length) {
    throw new Error("fleet_registry_replacement_coverage_duplicate");
  }
  const removed = before.coverageRoots
    .filter(root => !normalizedCoverage.includes(root))
    .sort(compareCodeUnits);
  const added = normalizedCoverage
    .filter(root => !before.coverageRoots.includes(root))
    .sort(compareCodeUnits);
  await validateRemovedCoverageEvidence(
    removed,
    request.manifest.removedCoverageEvidence,
  );
  const membership = await validateMembership(
    request.manifest.membership,
    normalizedCoverage,
    { verifyEvidence: true },
  );
  if (membership.issues.length > 0) {
    throw new Error(`fleet_registry_membership_invalid:${membership.issues
      .map(issue => `${issue.code}:${issue.path}`)
      .join(",")}`);
  }
  const membershipBody = {
    schemaVersion: membership.schemaVersion,
    entries: membership.entries,
    authorizationGranted: false,
    manifestSha256: membership.manifestSha256,
  };
  const body = {
    schemaVersion: FLEET_REGISTRY_SCHEMA_V2,
    coverageRoots: normalizedCoverage,
    membership: membershipBody,
    authorizationGranted: false,
  };
  const afterRegistry = {
    ...body,
    registrySha256: sha256Json(body),
  };
  const afterBytes = Buffer.from(`${JSON.stringify(afterRegistry, null, 2)}\n`);
  const coverageDelta = { added, removed };
  if (dryRun) {
    return registryReplacementResult({
      status: "fleet_registry_replacement_dry_run",
      registryPath: before.registryPath,
      before,
      afterRegistry,
      afterBytes,
      coverageDelta,
    });
  }
  if (typeof receiptPath !== "string" || receiptPath.length === 0) {
    throw new Error("fleet_registry_replacement_receipt_required");
  }
  const resolvedReceipt = path.resolve(receiptPath);
  if (await pathExists(resolvedReceipt)) {
    throw new Error("fleet_registry_replacement_receipt_exists");
  }
  const registryPath = before.registryPath;
  const lockPath = `${registryPath}.lock`;
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("fleet_registry_transaction_active");
    throw error;
  }
  const registryTemporary = `${registryPath}.tmp-${process.pid}`;
  const receiptTemporary = `${resolvedReceipt}.tmp-${process.pid}`;
  let registryReplaced = false;
  try {
    const current = await readFleetRegistry(registryPath);
    if (
      current.registrySha256 !== before.registrySha256
      || current.fileSha256 !== before.fileSha256
    ) throw new Error("fleet_registry_changed_during_replacement");
    await mkdir(path.dirname(resolvedReceipt), { recursive: true, mode: 0o700 });
    const receipt = {
      schemaVersion: "OwlCodaRunKitFleetRegistryReplacementReceiptV1",
      requestPath: request.manifestPath,
      requestSha256: request.fileSha256,
      registryPath,
      beforeRegistrySha256: before.registrySha256,
      afterRegistrySha256: afterRegistry.registrySha256,
      beforeFileSha256: before.fileSha256,
      afterFileSha256: sha256Bytes(afterBytes),
      previousRegistryBytesBase64: Buffer.from(before.fileBytes).toString("base64"),
      coverageDelta,
      rollbackAvailable: true,
      authorizationGranted: false,
    };
    await writeFile(registryTemporary, afterBytes, { flag: "wx", mode: 0o600 });
    await writeFile(
      receiptTemporary,
      `${JSON.stringify(receipt, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(registryTemporary, registryPath);
    registryReplaced = true;
    await rename(receiptTemporary, resolvedReceipt);
  } catch (error) {
    if (registryReplaced) {
      const rollbackTemporary = `${registryPath}.rollback-${process.pid}`;
      await writeFile(rollbackTemporary, before.fileBytes, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(rollbackTemporary, registryPath);
    }
    throw error;
  } finally {
    await rm(registryTemporary, { force: true });
    await rm(receiptTemporary, { force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
  return registryReplacementResult({
    status: "fleet_registry_replaced",
    registryPath,
    before,
    afterRegistry,
    afterBytes,
    coverageDelta,
    receiptPath: resolvedReceipt,
  });
}

export async function rollbackFleetRegistry({
  replacementReceiptPath,
  rollbackReceiptPath,
  fleetRegistryPath = defaultFleetRegistryPath(),
} = {}) {
  const replacement = await readManifestBounded(replacementReceiptPath);
  const receipt = replacement.manifest;
  if (
    receipt?.schemaVersion
      !== "OwlCodaRunKitFleetRegistryReplacementReceiptV1"
    || receipt.authorizationGranted !== false
    || receipt.rollbackAvailable !== true
    || typeof receipt.previousRegistryBytesBase64 !== "string"
  ) throw new Error("fleet_registry_rollback_receipt_invalid");
  const current = await readFleetRegistry(fleetRegistryPath);
  if (
    current.registryPath !== path.resolve(receipt.registryPath)
    || current.registrySha256 !== receipt.afterRegistrySha256
    || current.fileSha256 !== receipt.afterFileSha256
  ) throw new Error("fleet_registry_rollback_current_mismatch");
  const previousBytes = Buffer.from(receipt.previousRegistryBytesBase64, "base64");
  if (sha256Bytes(previousBytes) !== receipt.beforeFileSha256) {
    throw new Error("fleet_registry_rollback_preimage_hash_mismatch");
  }
  const rollbackPath = path.resolve(rollbackReceiptPath);
  if (await pathExists(rollbackPath)) throw new Error("fleet_registry_rollback_receipt_exists");
  const lockPath = `${current.registryPath}.lock`;
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("fleet_registry_transaction_active");
    throw error;
  }
  const registryTemporary = `${current.registryPath}.rollback-${process.pid}`;
  const receiptTemporary = `${rollbackPath}.tmp-${process.pid}`;
  let registryRestored = false;
  try {
    const lockedCurrent = await readFleetRegistry(current.registryPath);
    if (
      lockedCurrent.registrySha256 !== current.registrySha256
      || lockedCurrent.fileSha256 !== current.fileSha256
    ) throw new Error("fleet_registry_changed_during_rollback");
    await mkdir(path.dirname(rollbackPath), { recursive: true, mode: 0o700 });
    const rollbackReceipt = {
      schemaVersion: "OwlCodaRunKitFleetRegistryRollbackReceiptV1",
      replacementReceiptPath: replacement.manifestPath,
      replacementReceiptSha256: replacement.fileSha256,
      registryPath: current.registryPath,
      restoredRegistrySha256: receipt.beforeRegistrySha256,
      restoredFileSha256: receipt.beforeFileSha256,
      authorizationGranted: false,
    };
    await writeFile(registryTemporary, previousBytes, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      receiptTemporary,
      `${JSON.stringify(rollbackReceipt, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await rename(registryTemporary, current.registryPath);
    registryRestored = true;
    const restored = await readFleetRegistry(current.registryPath);
    if (
      restored.registrySha256 !== receipt.beforeRegistrySha256
      || restored.fileSha256 !== receipt.beforeFileSha256
    ) throw new Error("fleet_registry_rollback_verification_failed");
    await rename(receiptTemporary, rollbackPath);
    return {
      status: "fleet_registry_rolled_back",
      registryPath: restored.registryPath,
      registrySha256: restored.registrySha256,
      fileSha256: restored.fileSha256,
      rollbackReceiptPath: rollbackPath,
      authorizationGranted: false,
    };
  } catch (error) {
    if (registryRestored) {
      const restoreCurrentTemporary = `${current.registryPath}.restore-${process.pid}`;
      await writeFile(restoreCurrentTemporary, current.fileBytes, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(restoreCurrentTemporary, current.registryPath);
    }
    throw error;
  } finally {
    await rm(registryTemporary, { force: true });
    await rm(receiptTemporary, { force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function readManifestBounded(fleetManifestPath) {
  if (typeof fleetManifestPath !== "string" || fleetManifestPath.length === 0) {
    throw new Error("fleet_manifest_path_invalid");
  }
  const requested = path.resolve(fleetManifestPath);
  const stat = await lstat(requested);
  if (stat.isSymbolicLink()) throw new Error("fleet_manifest_symlink_rejected");
  if (!stat.isFile()) throw new Error("fleet_manifest_path_invalid");
  if (stat.size > MAX_FLEET_MANIFEST_BYTES) {
    throw new Error("fleet_manifest_too_large");
  }
  const canonicalPath = await realpath(requested);
  const handle = await open(canonicalPath, "r");
  try {
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const current = await lstat(canonicalPath);
    if (
      current.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.dev !== current.dev
      || after.ino !== current.ino
      || after.size !== current.size
      || bytes.length !== current.size
    ) {
      throw new Error("fleet_manifest_changed_during_read");
    }
    try {
      return {
        manifest: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        manifestPath: canonicalPath,
        bytes,
        fileSha256: sha256Bytes(bytes),
      };
    } catch {
      throw new Error("fleet_manifest_invalid_json");
    }
  } finally {
    await handle.close();
  }
}

function validateManifest(manifest) {
  if (
    manifest === null
    || typeof manifest !== "object"
    || Array.isArray(manifest)
    || Object.keys(manifest).some(key => ![
      "authorizationGranted",
      "schemaVersion",
      "skillName",
      "workspaceRoots",
    ].includes(key))
    || manifest.schemaVersion !== "OwlCodaRunKitFleetManifestV1"
    || manifest.skillName !== "owlcoda-runkit"
    || manifest.authorizationGranted !== false
    || !Array.isArray(manifest.workspaceRoots)
    || manifest.workspaceRoots.length === 0
    || manifest.workspaceRoots.length > MAX_FLEET_WORKSPACES
  ) {
    throw new Error("fleet_manifest_invalid");
  }
}

async function canonicalizeRoots(workspaceRoots, { rejectDuplicates }) {
  if (
    !Array.isArray(workspaceRoots)
    || workspaceRoots.length === 0
    || workspaceRoots.length > MAX_FLEET_WORKSPACES
  ) {
    throw new Error("fleet_workspaces_required");
  }
  const roots = [];
  for (const workspaceRoot of workspaceRoots) {
    roots.push(await canonicalWorkspace(workspaceRoot));
  }
  if (rejectDuplicates && new Set(roots).size !== roots.length) {
    throw new Error("fleet_workspace_duplicate");
  }
  return [...new Set(roots)].sort(compareCodeUnits);
}

async function discoverFromRegisteredMembership(registry) {
  const coverageRoots = [];
  const unreachableRoots = [];
  const coverageIssues = [];
  for (const fleetRoot of registry.coverageRoots) {
    try {
      coverageRoots.push(await canonicalWorkspace(fleetRoot));
    } catch (error) {
      const resolved = path.resolve(fleetRoot);
      unreachableRoots.push(resolved);
      coverageIssues.push({
        code: error instanceof Error
          ? error.message
          : "fleet_root_unreachable",
        path: resolved,
        coverageRoot: resolved,
      });
    }
  }
  const normalizedCoverage = [...new Set(coverageRoots)].sort(compareCodeUnits);
  const normalizedUnreachable = [...new Set(unreachableRoots)].sort(
    compareCodeUnits,
  );
  const declaredCoverage = [...new Set(registry.coverageRoots.map(root => (
    path.resolve(root)
  )))].sort(compareCodeUnits);
  const membership = await validateMembership(
    registry.membership,
    declaredCoverage,
    { verifyEvidence: true },
  );
  const classifications = emptyClassifications();
  for (const entry of membership.entries) {
    classifications[entry.classification].push(entry.path);
  }
  for (const values of Object.values(classifications)) {
    values.sort(compareCodeUnits);
  }
  const issues = [...coverageIssues, ...membership.issues].sort(
    (left, right) => (
      compareCodeUnits(left.path, right.path)
      || compareCodeUnits(left.code, right.code)
    ),
  );
  return {
    schemaVersion: "OwlCodaRunKitFleetDiscoveryV1",
    source: "fleet_registry_membership",
    registryPath: registry.registryPath,
    registrySha256: registry.registrySha256,
    coverageRoots: normalizedCoverage,
    unreachableRoots: normalizedUnreachable,
    workspaceRoots: classifications.active,
    classifications,
    issues,
    complete: normalizedUnreachable.length === 0 && issues.length === 0,
    frozenManifestSha256: frozenManifestSha256({
      coverageRoots: normalizedCoverage,
      workspaceRoots: classifications.active,
      classifications,
    }),
    authorizationGranted: false,
  };
}

export async function discoverFleet({
  workspaceRoots = null,
  fleetManifestPath = null,
  fleetRoots = null,
  fleetRegistryPath = null,
} = {}) {
  const sources = [workspaceRoots, fleetManifestPath, fleetRoots]
    .filter(source => source !== null);
  if (sources.length > 1) {
    throw new Error("fleet_source_ambiguous");
  }
  if (fleetRoots !== null) return discoverFromFleetRoots(fleetRoots);
  if (fleetManifestPath !== null) {
    const { manifest, manifestPath } = await readManifestBounded(fleetManifestPath);
    validateManifest(manifest);
    const normalizedWorkspaces = await canonicalizeRoots(
      manifest.workspaceRoots,
      { rejectDuplicates: true },
    );
    const classifications = emptyClassifications();
    classifications.active = normalizedWorkspaces;
    return {
      schemaVersion: "OwlCodaRunKitFleetDiscoveryV1",
      source: "fleet_manifest",
      manifestPath,
      coverageRoots: [],
      unreachableRoots: [],
      workspaceRoots: normalizedWorkspaces,
      classifications,
      issues: [],
      complete: true,
      frozenManifestSha256: frozenManifestSha256({
        coverageRoots: [],
        workspaceRoots: normalizedWorkspaces,
        classifications,
      }),
      authorizationGranted: false,
    };
  }
  if (workspaceRoots === null) {
    const registry = await readFleetRegistry(fleetRegistryPath);
    if (registry.schemaVersion === FLEET_REGISTRY_SCHEMA_V2) {
      return discoverFromRegisteredMembership(registry);
    }
    return discoverFromFleetRoots(registry.coverageRoots, {
      source: "fleet_registry",
      registryPath: registry.registryPath,
      registrySha256: registry.registrySha256,
    });
  }
  const normalizedWorkspaces = await canonicalizeRoots(workspaceRoots, {
    rejectDuplicates: false,
  });
  const classifications = emptyClassifications();
  classifications.active = normalizedWorkspaces;
  return {
    schemaVersion: "OwlCodaRunKitFleetDiscoveryV1",
    source: "explicit_workspaces",
    coverageRoots: [],
    unreachableRoots: [],
    workspaceRoots: normalizedWorkspaces,
    classifications,
    issues: [],
    complete: true,
    frozenManifestSha256: frozenManifestSha256({
      coverageRoots: [],
      workspaceRoots: normalizedWorkspaces,
      classifications,
    }),
    authorizationGranted: false,
  };
}
