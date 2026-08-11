import assert from "node:assert/strict";
import {
  access,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import * as skillInstaller from "../../scripts/runkit-contract/install-codex-skill.mjs";
import {
  createCoreArtifact,
  currentCoreIdentity,
} from "../../scripts/runkit-contract/core-contract.mjs";

const {
  inspectInstalledSkill,
  installCodexSkill,
} = skillInstaller;

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

test("installs the repository-owned Skill deterministically and makes exact reinstall a no-op", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-install-"));
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  try {
    const first = await installCodexSkill({ repositoryRoot, targetRoot, archiveRoot });
    assert.equal(first.status, "installed");
    assert.equal(first.previousInstallation, null);
    const inspected = await inspectInstalledSkill({ targetRoot });
    assert.equal(inspected.status, "valid");
    assert.equal(inspected.manifestSha256, first.manifestSha256);
    assert.match(
      await readFile(path.join(targetRoot, "references/contract-v0.2.md"), "utf8"),
      /D8: gate-bound accepted closeout/,
    );
    assert.match(
      await readFile(path.join(targetRoot, "references/contract-v0.1.md"), "utf8"),
      /Contract v0\.1/,
    );
    assert.equal(
      JSON.parse(await readFile(path.join(targetRoot, "packages/attest/package.json"), "utf8")).name,
      "@owlcoda/attest",
    );
    const installedSkill = await readFile(path.join(targetRoot, "SKILL.md"), "utf8");
    assert.match(installedSkill, /Choose the smallest assurance lane/);
    assert.match(installedSkill, /ordinary project tools without RunKit/);
    assert.match(installedSkill, /Quick Verification for one low-risk command/);
    assert.match(installedSkill, /Formal Delivery for multi-writer work/);
    assert.match(installedSkill, /never treat a Quick receipt as Formal acceptance/);

    const second = await installCodexSkill({ repositoryRoot, targetRoot, archiveRoot });
    assert.equal(second.status, "unchanged");
    assert.equal(second.manifestSha256, first.manifestSha256);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("atomically updates provenance when identical content moves to a new authoritative repository", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-provenance-"));
  const firstRepository = path.join(sandbox, "repository-one");
  const secondRepository = path.join(sandbox, "repository-two");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  try {
    await makeRepositoryFixture(firstRepository, "same content\n");
    await makeRepositoryFixture(secondRepository, "same content\n");
    const first = await installCodexSkill({ repositoryRoot: firstRepository, targetRoot, archiveRoot });
    const second = await installCodexSkill({ repositoryRoot: secondRepository, targetRoot, archiveRoot });
    const inspected = await inspectInstalledSkill({ targetRoot });

    assert.equal(second.status, "provenance_updated");
    assert.equal(second.manifestSha256, first.manifestSha256);
    assert.equal(second.previousInstallation, null);
    assert.equal(inspected.manifest.sourceRepository, path.resolve(secondRepository));
    await assert.rejects(() => access(archiveRoot), { code: "ENOENT" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("rejects unknown installed drift instead of overwriting it", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-drift-"));
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  try {
    await installCodexSkill({ repositoryRoot, targetRoot, archiveRoot: path.join(sandbox, "archives") });
    await writeFile(path.join(targetRoot, "SKILL.md"), "locally modified\n");
    await assert.rejects(
      () => installCodexSkill({ repositoryRoot, targetRoot, archiveRoot: path.join(sandbox, "archives") }),
      /installed_skill_drift/,
    );
    assert.equal(await readFile(path.join(targetRoot, "SKILL.md"), "utf8"), "locally modified\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("archives a verified prior installation before an atomic source update", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-update-"));
  const fixtureRepository = path.join(sandbox, "repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const workspaceRoot = path.join(sandbox, "project");
  try {
    await makeRepositoryFixture(fixtureRepository, "version one\n");
    const first = await installCodexSkill({ repositoryRoot: fixtureRepository, targetRoot, archiveRoot });
    await makeInactiveWorkspace(workspaceRoot);
    await writeFile(path.join(fixtureRepository, "integrations/codex/skills/owlcoda-runkit/assets/version.txt"), "version two\n");
    const second = await installCodexSkill({
      repositoryRoot: fixtureRepository,
      targetRoot,
      archiveRoot,
      workspaceRoots: [workspaceRoot],
    });

    assert.equal(second.status, "updated");
    assert.notEqual(second.manifestSha256, first.manifestSha256);
    assert.ok(second.previousInstallation?.archivePath);
    assert.equal(await readFile(path.join(second.previousInstallation.archivePath, "assets/version.txt"), "utf8"), "version one\n");
    assert.equal(await readFile(path.join(targetRoot, "assets/version.txt"), "utf8"), "version two\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("refuses a Skill update without a registered fleet before mutating the installation", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-fleet-required-"));
  const fixtureRepository = path.join(sandbox, "repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  try {
    await makeRepositoryFixture(fixtureRepository, "version one\n");
    const first = await installCodexSkill({
      repositoryRoot: fixtureRepository,
      targetRoot,
      archiveRoot,
    });
    const targetBefore = await readFile(path.join(targetRoot, "assets/version.txt"));
    await writeFile(
      path.join(fixtureRepository, "integrations/codex/skills/owlcoda-runkit/assets/version.txt"),
      "version two\n",
    );

    await assert.rejects(
      () => installCodexSkill({
        repositoryRoot: fixtureRepository,
        targetRoot,
        archiveRoot,
        fleetRegistryPath: path.join(sandbox, "missing-fleet-registry.json"),
      }),
      /skill_update_fleet_registry_missing/,
    );

    assert.deepEqual(
      await readFile(path.join(targetRoot, "assets/version.txt")),
      targetBefore,
    );
    assert.equal((await inspectInstalledSkill({ targetRoot })).manifestSha256, first.manifestSha256);
    await assert.rejects(() => access(archiveRoot), { code: "ENOENT" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("refuses the whole Skill update when one fleet workspace has an active execution", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-active-fleet-"));
  const fixtureRepository = path.join(sandbox, "repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const workspaceRoot = path.join(sandbox, "active-project");
  try {
    await makeRepositoryFixture(fixtureRepository, "version one\n");
    const first = await installCodexSkill({
      repositoryRoot: fixtureRepository,
      targetRoot,
      archiveRoot,
    });
    const configPath = path.join(workspaceRoot, ".owlcoda/runkit/config.json");
    await mkdir(path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions/active-run",
    ), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: {
        contractVersion: "0.2",
        coreVersion: "0.14.0",
        coreManifestSha256: `sha256:${"1".repeat(64)}`,
        coreSourceRef: `artifact:sha256:${"1".repeat(64)}`,
      },
      authorizationPolicy: "external_explicit_authority_required",
    }, null, 2)}\n`);
    const configBefore = await readFile(configPath);
    const targetBefore = await readFile(path.join(targetRoot, "assets/version.txt"));
    await writeFile(
      path.join(fixtureRepository, "integrations/codex/skills/owlcoda-runkit/assets/version.txt"),
      "version two\n",
    );

    await assert.rejects(
      () => installCodexSkill({
        repositoryRoot: fixtureRepository,
        targetRoot,
        archiveRoot,
        workspaceRoots: [workspaceRoot],
      }),
      /skill_update_blocked_active_execution/,
    );

    assert.deepEqual(await readFile(configPath), configBefore);
    assert.deepEqual(
      await readFile(path.join(targetRoot, "assets/version.txt")),
      targetBefore,
    );
    assert.equal((await inspectInstalledSkill({ targetRoot })).manifestSha256, first.manifestSha256);
    await assert.rejects(() => access(archiveRoot), { code: "ENOENT" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("refuses an invalid fleet config before archiving or replacing the Skill", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-invalid-fleet-"));
  const fixtureRepository = path.join(sandbox, "repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const workspaceRoot = path.join(sandbox, "invalid-project");
  try {
    await makeRepositoryFixture(fixtureRepository, "version one\n");
    const first = await installCodexSkill({
      repositoryRoot: fixtureRepository,
      targetRoot,
      archiveRoot,
    });
    const configPath = path.join(workspaceRoot, ".owlcoda/runkit/config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{\"schemaVersion\":\"UnknownConfigV9\"}\n");
    const configBefore = await readFile(configPath);
    const targetBefore = await readFile(path.join(targetRoot, "assets/version.txt"));
    await writeFile(
      path.join(fixtureRepository, "integrations/codex/skills/owlcoda-runkit/assets/version.txt"),
      "version two\n",
    );

    await assert.rejects(
      () => installCodexSkill({
        repositoryRoot: fixtureRepository,
        targetRoot,
        archiveRoot,
        workspaceRoots: [workspaceRoot],
      }),
      /skill_update_fleet_config_invalid/,
    );

    assert.deepEqual(await readFile(configPath), configBefore);
    assert.deepEqual(
      await readFile(path.join(targetRoot, "assets/version.txt")),
      targetBefore,
    );
    assert.equal((await inspectInstalledSkill({ targetRoot })).manifestSha256, first.manifestSha256);
    await assert.rejects(() => access(archiveRoot), { code: "ENOENT" });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("restores the exact prior Skill and Config identity from the upgrade receipt", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-exact-rollback-"));
  const priorRepository = path.join(sandbox, "prior-repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const workspaceRoot = path.join(sandbox, "project");
  try {
    await makeRepositoryFixture(priorRepository, "prior exact bytes\n");
    const prior = await installCodexSkill({
      repositoryRoot: priorRepository,
      targetRoot,
      archiveRoot,
    });
    const runtimeRoot = path.join(workspaceRoot, ".owlcoda/runkit");
    const configPath = path.join(runtimeRoot, "config.json");
    const profilesPath = path.join(runtimeRoot, "profiles.json");
    const historicalPath = path.join(
      runtimeRoot,
      "executions/historical/receipt.json",
    );
    const closeoutPath = path.join(
      runtimeRoot,
      "executions/historical/closeout-receipt.json",
    );
    const priorCore = {
      contractVersion: "0.2",
      coreVersion: "0.15.0",
      coreManifestSha256: `sha256:${"1".repeat(64)}`,
      coreSourceRef: `artifact:sha256:${"1".repeat(64)}`,
    };
    await mkdir(path.dirname(historicalPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: priorCore,
      authorizationPolicy: "external_explicit_authority_required",
    }, null, 2)}\n`);
    await writeFile(profilesPath, "{\"schemaVersion\":\"OwlCodaRunKitProfilesV1\",\"profiles\":[]}\n");
    await writeFile(historicalPath, "{\"status\":\"accepted\"}\n");
    await writeFile(
      path.join(runtimeRoot, "executions/historical/engine-pin.json"),
      `${JSON.stringify(priorCore, null, 2)}\n`,
    );
    await writeFile(closeoutPath, `${JSON.stringify(createCoreArtifact({
      core: priorCore,
      producer: {
        adapterKind: "codex",
        adapterVersion: "0.1.0",
      },
      payload: {
        runId: "historical",
        decision: "rejected",
        authorizationGranted: false,
      },
    }))}\n`);
    const configBefore = await readFile(configPath);
    const profilesBefore = await readFile(profilesPath);
    const historicalBefore = await readFile(historicalPath);

    const upgraded = await installCodexSkill({
      repositoryRoot,
      targetRoot,
      archiveRoot,
      workspaceRoots: [workspaceRoot],
    });

    assert.equal(upgraded.status, "updated");
    assert.ok(upgraded.upgradeReceipt);
    assert.deepEqual(
      JSON.parse(await readFile(configPath, "utf8")).core,
      currentCoreIdentity(),
    );
    assert.notEqual(
      (await inspectInstalledSkill({ targetRoot })).manifestSha256,
      prior.manifestSha256,
    );
    const upgradeReceipt = JSON.parse(await readFile(upgraded.upgradeReceipt, "utf8"));
    const outsideArchive = path.join(sandbox, "outside-prior-skill");
    await cp(upgradeReceipt.priorArchivePath, outsideArchive, { recursive: true });
    const tamperedReceiptPath = path.join(
      archiveRoot,
      "receipts/tampered-outside-archive.json",
    );
    await writeFile(tamperedReceiptPath, `${JSON.stringify({
      ...upgradeReceipt,
      priorArchivePath: outsideArchive,
    }, null, 2)}\n`);
    const rejectedOutsideArchive = await skillInstaller.runCli([
      "restore",
      "--target",
      targetRoot,
      "--archive",
      archiveRoot,
      "--receipt",
      tamperedReceiptPath,
    ]);
    assert.equal(rejectedOutsideArchive.status, "invalid_input");
    assert.deepEqual(rejectedOutsideArchive.issues, [
      "skill_rollback_prior_archive_outside_root",
    ]);

    const restored = await skillInstaller.runCli([
      "restore",
      "--target",
      targetRoot,
      "--archive",
      archiveRoot,
      "--receipt",
      upgraded.upgradeReceipt,
    ]);

    assert.equal(restored.status, "restored");
    assert.ok(restored.rollbackReceipt);
    assert.equal(
      (await inspectInstalledSkill({ targetRoot })).manifestSha256,
      prior.manifestSha256,
    );
    assert.deepEqual(await readFile(configPath), configBefore);
    assert.deepEqual(await readFile(profilesPath), profilesBefore);
    assert.deepEqual(await readFile(historicalPath), historicalBefore);
    assert.equal((await readFile(upgraded.upgradeReceipt, "utf8")).length > 0, true);
    assert.equal((await readFile(restored.rollbackReceipt, "utf8")).length > 0, true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("recovers an already-drifted active fleet only to the exact archived Core pin", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-active-recovery-"));
  const priorRepository = path.join(sandbox, "prior-repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const candidateTarget = path.join(sandbox, "skills/candidate-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const archivedInstallationPath = path.join(archiveRoot, "legacy-prior");
  const workspaceRoot = path.join(sandbox, "active-project");
  const priorCore = {
    contractVersion: "0.2",
    coreVersion: "0.14.0",
    coreManifestSha256: `sha256:${"2".repeat(64)}`,
    coreSourceRef: `artifact:sha256:${"2".repeat(64)}`,
  };
  try {
    await makeRepositoryFixture(
      priorRepository,
      "prior active Core\n",
      { coreIdentity: priorCore },
    );
    const prior = await installCodexSkill({
      repositoryRoot: priorRepository,
      targetRoot,
      archiveRoot,
    });
    await installCodexSkill({
      repositoryRoot,
      targetRoot: candidateTarget,
      archiveRoot,
    });
    await mkdir(archiveRoot, { recursive: true });
    await rename(targetRoot, archivedInstallationPath);
    await rename(candidateTarget, targetRoot);

    const runtimeRoot = path.join(workspaceRoot, ".owlcoda/runkit");
    const configPath = path.join(runtimeRoot, "config.json");
    const enginePinPath = path.join(
      runtimeRoot,
      "executions/active-run/engine-pin.json",
    );
    const leasePath = path.join(
      runtimeRoot,
      "executions/active-run/leases/W1-attempt-001.json",
    );
    await mkdir(path.dirname(leasePath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: priorCore,
      authorizationPolicy: "external_explicit_authority_required",
    }, null, 2)}\n`);
    await writeFile(enginePinPath, `${JSON.stringify(priorCore, null, 2)}\n`);
    await writeFile(leasePath, `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/**"],
      state: "active",
    }, null, 2)}\n`);
    const configBefore = await readFile(configPath);
    const pinBefore = await readFile(enginePinPath);
    const leaseBefore = await readFile(leasePath);

    const recovered = await skillInstaller.runCli([
      "recover-active",
      "--target",
      targetRoot,
      "--archive",
      archiveRoot,
      "--archived-installation",
      archivedInstallationPath,
      "--workspace",
      workspaceRoot,
    ]);

    assert.equal(recovered.status, "recovered_active_fleet");
    assert.ok(recovered.recoveryReceipt);
    assert.equal(
      (await inspectInstalledSkill({ targetRoot })).manifestSha256,
      prior.manifestSha256,
    );
    assert.deepEqual(await readFile(configPath), configBefore);
    assert.deepEqual(await readFile(enginePinPath), pinBefore);
    assert.deepEqual(await readFile(leasePath), leaseBefore);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("the installer CLI checks every repeated workspace before a global update", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-cli-fleet-"));
  const fixtureRepository = path.join(sandbox, "repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const activeWorkspace = path.join(sandbox, "active-project");
  const inactiveWorkspace = path.join(sandbox, "inactive-project");
  try {
    await makeRepositoryFixture(fixtureRepository, "version one\n");
    await installCodexSkill({
      repositoryRoot: fixtureRepository,
      targetRoot,
      archiveRoot,
    });
    await makeInactiveWorkspace(activeWorkspace);
    await makeInactiveWorkspace(inactiveWorkspace);
    await mkdir(path.join(
      activeWorkspace,
      ".owlcoda/runkit/executions/active-run",
    ), { recursive: true });
    await writeFile(
      path.join(fixtureRepository, "integrations/codex/skills/owlcoda-runkit/assets/version.txt"),
      "version two\n",
    );

    const blocked = await skillInstaller.runCli([
      "install",
      "--repository",
      fixtureRepository,
      "--target",
      targetRoot,
      "--archive",
      archiveRoot,
      "--workspace",
      activeWorkspace,
      "--workspace",
      inactiveWorkspace,
    ]);

    assert.equal(blocked.status, "skill_update_blocked_active_execution");
    assert.equal(blocked.exitCode, 2);
    assert.match(blocked.issues.join("\n"), /active-run/);
    assert.equal(
      await readFile(path.join(targetRoot, "assets/version.txt"), "utf8"),
      "version one\n",
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("upgrades an older Skill to the canonical assurance-lane guidance", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-lane-upgrade-"));
  const priorRepository = path.join(sandbox, "prior-repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const workspaceRoot = path.join(sandbox, "project");
  try {
    await makeRepositoryFixture(priorRepository, "prior\n");
    const prior = await installCodexSkill({
      repositoryRoot: priorRepository,
      targetRoot,
      archiveRoot,
    });
    await makeInactiveWorkspace(workspaceRoot);
    const upgraded = await installCodexSkill({
      repositoryRoot,
      targetRoot,
      archiveRoot,
      expectedUnmanagedManifestSha256: prior.manifestSha256,
      workspaceRoots: [workspaceRoot],
    });
    assert.equal(upgraded.status, "updated");
    const installedSkill = await readFile(path.join(targetRoot, "SKILL.md"), "utf8");
    assert.match(installedSkill, /Choose the smallest assurance lane/);
    assert.match(installedSkill, /Quick Verification for one low-risk command/);
    assert.match(installedSkill, /Formal Delivery for multi-writer work/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("replaces a known unmanaged installation only when its expected manifest is explicit", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlcoda-skill-adopt-"));
  const fixtureRepository = path.join(sandbox, "repository");
  const targetRoot = path.join(sandbox, "skills/owlcoda-runkit");
  const archiveRoot = path.join(sandbox, "archives");
  const workspaceRoot = path.join(sandbox, "project");
  try {
    await makeRepositoryFixture(fixtureRepository, "known prior\n");
    const first = await installCodexSkill({ repositoryRoot: fixtureRepository, targetRoot, archiveRoot });
    await makeInactiveWorkspace(workspaceRoot);
    await rm(path.join(targetRoot, ".owlcoda-install-manifest.json"));
    await writeFile(path.join(fixtureRepository, "integrations/codex/skills/owlcoda-runkit/assets/version.txt"), "desired next\n");

    const updated = await installCodexSkill({
      repositoryRoot: fixtureRepository,
      targetRoot,
      archiveRoot,
      expectedUnmanagedManifestSha256: first.manifestSha256,
      workspaceRoots: [workspaceRoot],
    });
    assert.equal(updated.status, "updated");
    assert.equal(updated.previousInstallation.manifestSha256, first.manifestSha256);
    assert.equal(await readFile(path.join(targetRoot, "assets/version.txt"), "utf8"), "desired next\n");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

async function makeRepositoryFixture(root, version, {
  coreIdentity = {
    contractVersion: "0.2",
    coreVersion: "0.14.0",
    coreManifestSha256: `sha256:${"1".repeat(64)}`,
    coreSourceRef: `artifact:sha256:${"1".repeat(64)}`,
  },
} = {}) {
  const skillSource = path.join(root, "integrations/codex/skills/owlcoda-runkit");
  const coreSource = path.join(root, "scripts/runkit-contract");
  const attestSource = path.join(root, "packages/attest");
  const contractV01Path = path.join(root, "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_1.md");
  const contractV02Path = path.join(root, "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_2.md");
  await mkdir(path.join(skillSource, "agents"), { recursive: true });
  await mkdir(path.join(skillSource, "assets"), { recursive: true });
  await mkdir(path.join(coreSource, "schemas"), { recursive: true });
  await mkdir(path.join(coreSource, "templates"), { recursive: true });
  await mkdir(path.join(attestSource, "src"), { recursive: true });
  await mkdir(path.dirname(contractV01Path), { recursive: true });
  await writeFile(path.join(skillSource, "SKILL.md"), "---\nname: owlcoda-runkit\ndescription: Fixture.\n---\n");
  await writeFile(path.join(skillSource, "agents/openai.yaml"), "interface:\n  display_name: \"OwlCoda RunKit\"\n");
  await writeFile(path.join(skillSource, "assets/version.txt"), version);
  await writeFile(path.join(coreSource, "fixture.mjs"), "export const fixture = true\n");
  await writeFile(
    path.join(coreSource, "core-contract.mjs"),
    `export function currentCoreIdentity() { return ${JSON.stringify(coreIdentity)}; }\n`,
  );
  await writeFile(path.join(coreSource, "schemas/fixture.json"), "{}\n");
  await writeFile(path.join(coreSource, "templates/fixture.json"), "{}\n");
  await writeFile(path.join(attestSource, "package.json"), JSON.stringify({
    name: "@owlcoda/attest",
    version: "0.0.0-fixture",
    type: "module",
  }));
  await writeFile(path.join(attestSource, "src/index.mjs"), "export const fixture = true\n");
  await writeFile(contractV01Path, "# Contract v0.1 fixture\n");
  await writeFile(contractV02Path, "# Contract v0.2 fixture\n");
}

async function makeInactiveWorkspace(root, coreIdentity = {
  contractVersion: "0.2",
  coreVersion: "0.14.0",
  coreManifestSha256: `sha256:${"1".repeat(64)}`,
  coreSourceRef: `artifact:sha256:${"1".repeat(64)}`,
}) {
  await mkdir(path.join(root, ".owlcoda/runkit/executions"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, ".owlcoda/runkit/config.json"),
    `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: coreIdentity,
      authorizationPolicy: "external_explicit_authority_required",
    }, null, 2)}\n`,
  );
}
