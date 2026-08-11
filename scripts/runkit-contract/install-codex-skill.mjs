#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  initializeProjectRunKit,
  isDirectExecution,
  validateProjectConfigV2,
} from "./core-contract.mjs";
import { discoverFleet } from "./fleet-discovery.mjs";
import { inspectProjectControlState } from "./project-control-state.mjs";

const MANIFEST_FILE = ".owlcoda-install-manifest.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameCoreIdentity(left, right) {
  return [
    "contractVersion",
    "coreVersion",
    "coreManifestSha256",
    "coreSourceRef",
  ].every((field) => (
    typeof left?.[field] === "string"
    && left[field] === right?.[field]
  ));
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWriteBytes(filePath, bytes) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  await rename(temporaryPath, filePath);
}

async function nextAvailablePath(parentRoot, baseName) {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1
      ? ""
      : `-attempt-${String(attempt).padStart(3, "0")}`;
    const candidate = path.join(parentRoot, `${baseName}${suffix}`);
    if (!await exists(candidate)) return candidate;
  }
}

async function writeAppendOnlyReceipt(receiptsRoot, baseName, receipt) {
  await mkdir(receiptsRoot, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1
      ? ""
      : `-attempt-${String(attempt).padStart(3, "0")}`;
    const receiptPath = path.join(receiptsRoot, `${baseName}${suffix}.json`);
    try {
      await writeFile(
        receiptPath,
        `${JSON.stringify(receipt, null, 2)}\n`,
        { flag: "wx" },
      );
      return receiptPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

async function fileMap(root, { excludeManifest = true } = {}) {
  const files = {};
  async function walk(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excludeManifest && relativePath === MANIFEST_FILE) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolutePath, relativePath);
      else if (entry.isFile()) files[relativePath] = sha256(await readFile(absolutePath));
      else throw new Error(`unsupported_skill_entry:${relativePath}`);
    }
  }
  await walk(root);
  return files;
}

function contentSha256(files) {
  const stream = Object.entries(files).map(([name, hash]) => `${name}\tsha256:${hash}\n`).join("");
  return sha256(stream);
}

async function buildManifest(root, repositoryRoot) {
  const wholeFileSha256 = await fileMap(root);
  const manifestSha256 = contentSha256(wholeFileSha256);
  return {
    schemaVersion: "OwlCodaRunKitSkillInstallManifestV1",
    skillName: "owlcoda-runkit",
    manifestSha256: `sha256:${manifestSha256}`,
    sourceRef: `artifact:sha256:${manifestSha256}`,
    sourceRepository: path.resolve(repositoryRoot),
    fileCount: Object.keys(wholeFileSha256).length,
    wholeFileSha256,
  };
}

async function replaceManifestAtomically(targetRoot, manifest) {
  const temporaryRoot = await mkdtemp(path.join(path.dirname(targetRoot), ".owlcoda-runkit.manifest-"));
  try {
    const temporaryManifest = path.join(temporaryRoot, MANIFEST_FILE);
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryManifest, path.join(targetRoot, MANIFEST_FILE));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function assemble({ repositoryRoot, stagingRoot }) {
  const skillSource = path.join(repositoryRoot, "integrations/codex/skills/owlcoda-runkit");
  const coreSource = path.join(repositoryRoot, "scripts/runkit-contract");
  const attestSource = path.join(repositoryRoot, "packages/attest");
  const contractV01Source = path.join(repositoryRoot, "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_1.md");
  const contractV02Source = path.join(repositoryRoot, "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_2.md");
  for (const required of [path.join(skillSource, "SKILL.md"), path.join(skillSource, "agents/openai.yaml"), coreSource, attestSource, contractV01Source, contractV02Source]) {
    if (!await exists(required)) throw new Error(`missing_authoritative_skill_source:${required}`);
  }
  await cp(skillSource, stagingRoot, { recursive: true });
  await mkdir(path.join(stagingRoot, "scripts"), { recursive: true });
  await cp(coreSource, path.join(stagingRoot, "scripts/runkit-contract"), { recursive: true });
  await mkdir(path.join(stagingRoot, "packages"), { recursive: true });
  await cp(attestSource, path.join(stagingRoot, "packages/attest"), { recursive: true });
  await mkdir(path.join(stagingRoot, "references"), { recursive: true });
  await cp(contractV01Source, path.join(stagingRoot, "references/contract-v0.1.md"));
  await cp(contractV02Source, path.join(stagingRoot, "references/contract-v0.2.md"));
  const manifest = await buildManifest(stagingRoot, repositoryRoot);
  await writeFile(path.join(stagingRoot, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export async function inspectInstalledSkill({ targetRoot } = {}) {
  if (typeof targetRoot !== "string" || targetRoot.length === 0) throw new Error("targetRoot is required");
  if (!await exists(targetRoot)) return { status: "missing", valid: false };
  const manifestPath = path.join(targetRoot, MANIFEST_FILE);
  if (!await exists(manifestPath)) {
    const wholeFileSha256 = await fileMap(targetRoot);
    return {
      status: "unmanaged",
      valid: false,
      manifestSha256: `sha256:${contentSha256(wholeFileSha256)}`,
      wholeFileSha256,
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return { status: "drifted", valid: false, issues: ["invalid install manifest"] };
  }
  const actualFiles = await fileMap(targetRoot);
  const actualSha256 = `sha256:${contentSha256(actualFiles)}`;
  const issues = [];
  if (manifest.schemaVersion !== "OwlCodaRunKitSkillInstallManifestV1") issues.push("unsupported install manifest schema");
  if (manifest.manifestSha256 !== actualSha256) issues.push("installed_skill_drift: content fingerprint mismatch");
  if (JSON.stringify(manifest.wholeFileSha256) !== JSON.stringify(actualFiles)) issues.push("installed_skill_drift: file map mismatch");
  return {
    status: issues.length === 0 ? "valid" : "drifted",
    valid: issues.length === 0,
    manifestSha256: actualSha256,
    wholeFileSha256: actualFiles,
    manifest,
    issues,
  };
}

export async function inspectFleetForSkillChange({
  workspaceRoots = null,
  fleetManifestPath = null,
  fleetRoots = null,
  fleetRegistryPath = null,
} = {}) {
  let discovery;
  try {
    discovery = await discoverFleet({
      workspaceRoots,
      fleetManifestPath,
      fleetRoots,
      fleetRegistryPath,
    });
  } catch (error) {
    if (
      workspaceRoots === null
      && fleetManifestPath === null
      && fleetRoots === null
      && error?.message === "fleet_registry_missing"
    ) {
      throw new Error("skill_update_fleet_registry_missing");
    }
    throw error;
  }
  if (!discovery.complete) {
    throw new Error(
      `skill_update_fleet_discovery_incomplete:${discovery.unreachableRoots.join(",")}`,
    );
  }
  const projects = [];
  for (const workspaceRoot of discovery.workspaceRoots) {
    const safety = inspectProjectControlState({ workspaceRoot }).upgradeSafety;
    if (safety.status !== "safe") {
      const blockers = [
        ...safety.activeRunIds,
        ...safety.activeLeaseIds,
        ...safety.issues,
      ].join(",");
      throw new Error(
        `skill_update_blocked_active_execution:${workspaceRoot}:${blockers}`,
      );
    }
    const configPath = path.join(
      workspaceRoot,
      ".owlcoda/runkit/config.json",
    );
    const configBytes = await readFile(configPath);
    let config;
    try {
      config = JSON.parse(configBytes.toString("utf8"));
    } catch {
      throw new Error(`skill_update_fleet_config_invalid:${workspaceRoot}:invalid_json`);
    }
    const configV2 = config?.schemaVersion === "OwlCodaRunKitConfigV2"
      ? validateProjectConfigV2(config)
      : null;
    const supportedV1 = config?.schemaVersion === "OwlCodaRunKitConfigV1"
      && config?.core?.contractVersion === "0.1"
      && config?.authorizationPolicy === "external_explicit_authority_required";
    if (
      (configV2 !== null && !configV2.valid)
      || (configV2 === null && !supportedV1)
    ) {
      const issues = configV2?.issues?.join(",") ?? "unsupported_config";
      throw new Error(
        `skill_update_fleet_config_invalid:${workspaceRoot}:${issues}`,
      );
    }
    projects.push({
      workspaceRoot,
      configPath,
      configBytes,
      configSha256: sha256(configBytes),
    });
  }
  return projects;
}

async function restoreProjectConfigs(projects) {
  for (const project of projects) {
    await atomicWriteBytes(project.configPath, project.configBytes);
  }
}

export async function installCodexSkill({
  repositoryRoot,
  targetRoot,
  archiveRoot,
  expectedUnmanagedManifestSha256 = null,
  workspaceRoots = null,
  fleetManifestPath = null,
  fleetRoots = null,
  fleetRegistryPath = null,
} = {}) {
  if (typeof repositoryRoot !== "string" || typeof targetRoot !== "string" || typeof archiveRoot !== "string") {
    throw new Error("repositoryRoot, targetRoot, and archiveRoot are required");
  }
  const parent = path.dirname(targetRoot);
  await mkdir(parent, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(parent, ".owlcoda-runkit.install-"));
  let stagingPresent = true;
  try {
    const desired = await assemble({ repositoryRoot: path.resolve(repositoryRoot), stagingRoot });
    let prior = await inspectInstalledSkill({ targetRoot });
    if (prior.status === "missing") {
      await rename(stagingRoot, targetRoot);
      stagingPresent = false;
      return { status: "installed", manifestSha256: desired.manifestSha256, previousInstallation: null };
    }
    if (prior.status === "unmanaged") {
      if (prior.manifestSha256 === desired.manifestSha256) {
        await writeFile(path.join(targetRoot, MANIFEST_FILE), `${JSON.stringify(desired, null, 2)}\n`, { flag: "wx" });
        return { status: "adopted", manifestSha256: desired.manifestSha256, previousInstallation: null };
      }
      if (prior.manifestSha256 !== expectedUnmanagedManifestSha256) {
        throw new Error("installed_skill_drift: unmanaged installation differs from authoritative source and expected prior manifest");
      }
      prior = { ...prior, valid: true };
    }
    if (!prior.valid) throw new Error(`installed_skill_drift: ${prior.issues.join("; ")}`);
    if (prior.manifestSha256 === desired.manifestSha256) {
      if (prior.manifest.sourceRepository !== desired.sourceRepository) {
        await replaceManifestAtomically(targetRoot, desired);
        return { status: "provenance_updated", manifestSha256: desired.manifestSha256, previousInstallation: null };
      }
      return { status: "unchanged", manifestSha256: desired.manifestSha256, previousInstallation: null };
    }
    const projects = await inspectFleetForSkillChange({
      workspaceRoots,
      fleetManifestPath,
      fleetRoots,
      fleetRegistryPath,
    });
    await mkdir(archiveRoot, { recursive: true });
    const archivePath = await nextAvailablePath(
      archiveRoot,
      `owlcoda-runkit-${prior.manifestSha256.slice(7)}`,
    );
    await rename(targetRoot, archivePath);
    try {
      await rename(stagingRoot, targetRoot);
      stagingPresent = false;
      const projectMigrations = [];
      for (const project of projects) {
        const initialized = await initializeProjectRunKit({
          workspaceRoot: project.workspaceRoot,
        });
        if (initialized.exitCode !== 0) {
          throw new Error(
            `skill_update_project_migration_blocked:${project.workspaceRoot}:${initialized.status}`,
          );
        }
        const currentConfigBytes = await readFile(project.configPath);
        projectMigrations.push({
          workspaceRoot: project.workspaceRoot,
          configPath: project.configPath,
          fromConfigSha256: project.configSha256,
          fromConfigBase64: project.configBytes.toString("base64"),
          toConfigSha256: sha256(currentConfigBytes),
          migrationReceipt: initialized.migrationReceipt ?? null,
        });
      }
      const receipt = {
        schemaVersion: "OwlCodaRunKitSkillUpgradeReceiptV1",
        operation: "upgrade",
        targetRoot: path.resolve(targetRoot),
        archiveRoot: path.resolve(archiveRoot),
        fromManifestSha256: prior.manifestSha256,
        toManifestSha256: desired.manifestSha256,
        priorArchivePath: archivePath,
        projects: projectMigrations,
        authorizationGranted: false,
      };
      const upgradeReceipt = await writeAppendOnlyReceipt(
        path.join(archiveRoot, "receipts"),
        `skill-upgrade-${prior.manifestSha256.slice(7)}-to-${desired.manifestSha256.slice(7)}`,
        receipt,
      );
      return {
        status: "updated",
        manifestSha256: desired.manifestSha256,
        previousInstallation: {
          manifestSha256: prior.manifestSha256,
          archivePath,
        },
        upgradeReceipt,
        projectMigrations,
      };
    } catch (error) {
      if (await exists(targetRoot)) {
        const failedArchivePath = await nextAvailablePath(
          archiveRoot,
          `owlcoda-runkit-failed-${desired.manifestSha256.slice(7)}`,
        );
        await rename(targetRoot, failedArchivePath);
      }
      await rename(archivePath, targetRoot);
      await restoreProjectConfigs(projects);
      throw error;
    }
  } finally {
    if (stagingPresent) await rm(stagingRoot, { recursive: true, force: true });
  }
}

export async function restoreCodexSkill({
  targetRoot,
  archiveRoot,
  upgradeReceiptPath,
} = {}) {
  if (
    typeof targetRoot !== "string"
    || typeof archiveRoot !== "string"
    || typeof upgradeReceiptPath !== "string"
  ) {
    throw new Error("targetRoot, archiveRoot, and upgradeReceiptPath are required");
  }
  const resolvedTarget = path.resolve(targetRoot);
  const resolvedArchive = path.resolve(archiveRoot);
  const resolvedReceipt = path.resolve(upgradeReceiptPath);
  const receiptRelative = path.relative(
    path.join(resolvedArchive, "receipts"),
    resolvedReceipt,
  );
  if (
    receiptRelative.startsWith("..")
    || path.isAbsolute(receiptRelative)
    || !receiptRelative.endsWith(".json")
  ) {
    throw new Error("skill_rollback_receipt_outside_archive");
  }
  const receiptBytes = await readFile(resolvedReceipt);
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  if (
    receipt.schemaVersion !== "OwlCodaRunKitSkillUpgradeReceiptV1"
    || receipt.operation !== "upgrade"
    || receipt.targetRoot !== resolvedTarget
    || receipt.archiveRoot !== resolvedArchive
    || receipt.authorizationGranted !== false
    || !Array.isArray(receipt.projects)
    || receipt.projects.length === 0
  ) {
    throw new Error("skill_rollback_receipt_invalid");
  }
  const resolvedPriorArchive = path.resolve(receipt.priorArchivePath);
  const priorArchiveRelative = path.relative(
    resolvedArchive,
    resolvedPriorArchive,
  );
  if (
    receipt.priorArchivePath !== resolvedPriorArchive
    || priorArchiveRelative.startsWith("..")
    || path.isAbsolute(priorArchiveRelative)
    || priorArchiveRelative.length === 0
    || priorArchiveRelative === "receipts"
    || priorArchiveRelative.startsWith(`receipts${path.sep}`)
  ) {
    throw new Error("skill_rollback_prior_archive_outside_root");
  }
  const current = await inspectInstalledSkill({ targetRoot: resolvedTarget });
  if (!current.valid || current.manifestSha256 !== receipt.toManifestSha256) {
    throw new Error("skill_rollback_current_identity_mismatch");
  }
  const prior = await inspectInstalledSkill({
    targetRoot: resolvedPriorArchive,
  });
  if (!prior.valid || prior.manifestSha256 !== receipt.fromManifestSha256) {
    throw new Error("skill_rollback_prior_identity_mismatch");
  }
  const workspaceRoots = receipt.projects.map((project) => project.workspaceRoot);
  const currentProjects = await inspectFleetForSkillChange({ workspaceRoots });
  const receiptProjectByRoot = new Map(
    receipt.projects.map((project) => [project.workspaceRoot, project]),
  );
  for (const project of currentProjects) {
    const expected = receiptProjectByRoot.get(project.workspaceRoot);
    if (
      !expected
      || expected.configPath !== project.configPath
      || expected.toConfigSha256 !== project.configSha256
      || typeof expected.fromConfigBase64 !== "string"
      || sha256(Buffer.from(expected.fromConfigBase64, "base64"))
        !== expected.fromConfigSha256
    ) {
      throw new Error(
        `skill_rollback_project_identity_mismatch:${project.workspaceRoot}`,
      );
    }
  }
  const currentArchivePath = await nextAvailablePath(
    resolvedArchive,
    `owlcoda-runkit-${current.manifestSha256.slice(7)}`,
  );
  await rename(resolvedTarget, currentArchivePath);
  try {
    await rename(resolvedPriorArchive, resolvedTarget);
    for (const project of currentProjects) {
      const expected = receiptProjectByRoot.get(project.workspaceRoot);
      await atomicWriteBytes(
        project.configPath,
        Buffer.from(expected.fromConfigBase64, "base64"),
      );
    }
    const rollbackReceipt = await writeAppendOnlyReceipt(
      path.join(resolvedArchive, "receipts"),
      `skill-rollback-${receipt.toManifestSha256.slice(7)}-to-${receipt.fromManifestSha256.slice(7)}`,
      {
        schemaVersion: "OwlCodaRunKitSkillRollbackReceiptV1",
        operation: "rollback",
        sourceUpgradeReceiptPath: resolvedReceipt,
        sourceUpgradeReceiptSha256: sha256(receiptBytes),
        targetRoot: resolvedTarget,
        archiveRoot: resolvedArchive,
        fromManifestSha256: receipt.toManifestSha256,
        toManifestSha256: receipt.fromManifestSha256,
        restoredArchivePath: resolvedPriorArchive,
        replacedInstallationArchivePath: currentArchivePath,
        projects: receipt.projects.map((project) => ({
          workspaceRoot: project.workspaceRoot,
          restoredConfigSha256: project.fromConfigSha256,
        })),
        authorizationGranted: false,
      },
    );
    return {
      status: "restored",
      manifestSha256: receipt.fromManifestSha256,
      rollbackReceipt,
      replacedInstallation: {
        manifestSha256: receipt.toManifestSha256,
        archivePath: currentArchivePath,
      },
      authorizationGranted: false,
    };
  } catch (error) {
    if (await exists(resolvedTarget)) {
      await rename(resolvedTarget, resolvedPriorArchive);
    }
    await rename(currentArchivePath, resolvedTarget);
    await restoreProjectConfigs(currentProjects);
    throw error;
  }
}

export async function recoverCodexSkillForActiveFleet({
  targetRoot,
  archiveRoot,
  archivedInstallationPath,
  workspaceRoots = null,
  fleetManifestPath = null,
  fleetRoots = null,
} = {}) {
  if (
    typeof targetRoot !== "string"
    || typeof archiveRoot !== "string"
    || typeof archivedInstallationPath !== "string"
    || (
      (!Array.isArray(workspaceRoots) || workspaceRoots.length === 0)
      && (typeof fleetManifestPath !== "string" || fleetManifestPath.length === 0)
      && (!Array.isArray(fleetRoots) || fleetRoots.length === 0)
    )
  ) {
    throw new Error(
      "targetRoot, archiveRoot, archivedInstallationPath, and a fleet source are required",
    );
  }
  const resolvedTarget = path.resolve(targetRoot);
  const resolvedArchive = path.resolve(archiveRoot);
  const resolvedPrior = path.resolve(archivedInstallationPath);
  const priorRelative = path.relative(resolvedArchive, resolvedPrior);
  if (
    priorRelative.startsWith("..")
    || path.isAbsolute(priorRelative)
    || priorRelative.length === 0
  ) {
    throw new Error("skill_recovery_archive_outside_root");
  }
  const current = await inspectInstalledSkill({ targetRoot: resolvedTarget });
  const prior = await inspectInstalledSkill({ targetRoot: resolvedPrior });
  if (!current.valid || !prior.valid) {
    throw new Error("skill_recovery_installation_identity_invalid");
  }
  const archivedCoreModule = await import(pathToFileURL(path.join(
    resolvedPrior,
    "scripts/runkit-contract/core-contract.mjs",
  )).href);
  const archivedCore = archivedCoreModule.currentCoreIdentity?.();
  if (!archivedCore || typeof archivedCore.coreManifestSha256 !== "string") {
    throw new Error("skill_recovery_archived_core_identity_missing");
  }
  const discovery = await discoverFleet({
    workspaceRoots,
    fleetManifestPath,
    fleetRoots,
  });
  if (!discovery.complete) {
    throw new Error(
      `skill_recovery_fleet_discovery_incomplete:${discovery.unreachableRoots.join(",")}`,
    );
  }
  const projects = [];
  let activeRunCount = 0;
  for (const workspaceRoot of discovery.workspaceRoots) {
    const configPath = path.join(
      workspaceRoot,
      ".owlcoda/runkit/config.json",
    );
    const configBytes = await readFile(configPath);
    const config = JSON.parse(configBytes.toString("utf8"));
    if (!sameCoreIdentity(config.core, archivedCore)) {
      throw new Error(
        `skill_recovery_config_core_mismatch:${workspaceRoot}`,
      );
    }
    const safety = inspectProjectControlState({
      workspaceRoot,
      currentCore: archivedCore,
    }).upgradeSafety;
    if (safety.issues.length > 0) {
      throw new Error(
        `skill_recovery_control_state_invalid:${workspaceRoot}:${safety.issues.join(",")}`,
      );
    }
    const activeRunSet = new Set(safety.activeRunIds);
    if (safety.activeLeaseIds.some((leaseId) => (
      !activeRunSet.has(leaseId.split(":", 1)[0])
    ))) {
      throw new Error(
        `skill_recovery_lease_without_matching_active_run:${workspaceRoot}`,
      );
    }
    for (const runId of safety.activeRunIds) {
      const enginePinPath = path.join(
        workspaceRoot,
        ".owlcoda/runkit/executions",
        runId,
        "engine-pin.json",
      );
      const pinStat = await lstat(enginePinPath);
      if (pinStat.isSymbolicLink() || !pinStat.isFile()) {
        throw new Error(
          `skill_recovery_engine_pin_invalid:${workspaceRoot}:${runId}`,
        );
      }
      const enginePin = JSON.parse(await readFile(enginePinPath, "utf8"));
      if (!sameCoreIdentity(enginePin, archivedCore)) {
        throw new Error(
          `skill_recovery_active_pin_mismatch:${workspaceRoot}:${runId}`,
        );
      }
      activeRunCount += 1;
    }
    projects.push({
      workspaceRoot,
      configSha256: sha256(configBytes),
      activeRunIds: safety.activeRunIds,
      activeLeaseIds: safety.activeLeaseIds,
    });
  }
  if (activeRunCount === 0) {
    throw new Error("skill_recovery_active_execution_required");
  }
  const replacedInstallationArchivePath = await nextAvailablePath(
    resolvedArchive,
    `owlcoda-runkit-replaced-${current.manifestSha256.slice(7)}`,
  );
  await rename(resolvedTarget, replacedInstallationArchivePath);
  try {
    await rename(resolvedPrior, resolvedTarget);
    const recoveryReceipt = await writeAppendOnlyReceipt(
      path.join(resolvedArchive, "receipts"),
      `skill-active-recovery-${current.manifestSha256.slice(7)}-to-${prior.manifestSha256.slice(7)}`,
      {
        schemaVersion: "OwlCodaRunKitSkillActiveRecoveryReceiptV1",
        operation: "active_execution_recovery",
        targetRoot: resolvedTarget,
        archiveRoot: resolvedArchive,
        fromManifestSha256: current.manifestSha256,
        toManifestSha256: prior.manifestSha256,
        restoredCore: archivedCore,
        restoredArchivePath: resolvedPrior,
        replacedInstallationArchivePath,
        projects,
        authorizationGranted: false,
      },
    );
    return {
      status: "recovered_active_fleet",
      manifestSha256: prior.manifestSha256,
      core: archivedCore,
      recoveryReceipt,
      replacedInstallationArchivePath,
      authorizationGranted: false,
    };
  } catch (error) {
    if (await exists(resolvedTarget)) {
      await rename(resolvedTarget, resolvedPrior);
    }
    await rename(replacedInstallationArchivePath, resolvedTarget);
    throw error;
  }
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("Options must be --name value pairs");
    const name = flag.slice(2);
    if (name === "workspace" || name === "fleet-root") {
      options[name] ??= [];
      options[name].push(value);
    } else {
      options[name] = value;
    }
  }
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    const options = parseOptions(rest);
    if (command === "install") {
      const output = await installCodexSkill({
        repositoryRoot: options.repository,
        targetRoot: options.target,
        archiveRoot: options.archive,
        expectedUnmanagedManifestSha256: options["expected-unmanaged"] ?? null,
        workspaceRoots: options.workspace ?? null,
        fleetManifestPath: options["fleet-manifest"] ?? null,
        fleetRoots: options["fleet-root"] ?? null,
      });
      return { exitCode: 0, ...output };
    }
    if (command === "inspect") {
      const output = await inspectInstalledSkill({ targetRoot: options.target });
      return { exitCode: output.valid ? 0 : 2, ...output };
    }
    if (command === "restore") {
      const output = await restoreCodexSkill({
        targetRoot: options.target,
        archiveRoot: options.archive,
        upgradeReceiptPath: options.receipt,
      });
      return { exitCode: 0, ...output };
    }
    if (command === "recover-active") {
      const output = await recoverCodexSkillForActiveFleet({
        targetRoot: options.target,
        archiveRoot: options.archive,
        archivedInstallationPath: options["archived-installation"],
        workspaceRoots: options.workspace ?? null,
        fleetManifestPath: options["fleet-manifest"] ?? null,
        fleetRoots: options["fleet-root"] ?? null,
      });
      return { exitCode: 0, ...output };
    }
    throw new Error(
      "Usage: install-codex-skill.mjs <install|inspect|restore|recover-active> [options]",
    );
  } catch (error) {
    const issue = error instanceof Error ? error.message : String(error);
    if (issue.startsWith("skill_update_blocked_active_execution:")) {
      return {
        status: "skill_update_blocked_active_execution",
        exitCode: 2,
        issues: [issue],
      };
    }
    return { status: "invalid_input", exitCode: 3, issues: [error instanceof Error ? error.message : String(error)] };
  }
}

if (isDirectExecution(import.meta.url)) {
  const result = await runCli();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
