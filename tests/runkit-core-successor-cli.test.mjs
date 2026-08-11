import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  coreSuccessorArtifactSha256V1,
} from "../scripts/runkit-contract/core-successor.mjs";
import {
  coreManifest,
  currentCoreIdentity,
} from "../scripts/runkit-contract/core-contract.mjs";
import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function oldCore() {
  return {
    contractVersion: "0.2",
    coreVersion: "0.14.0",
    coreManifestSha256: `sha256:${"1".repeat(64)}`,
    coreSourceRef: `artifact:sha256:${"1".repeat(64)}`,
  };
}

async function fleetProject(root, name) {
  const workspaceRoot = path.join(root, name);
  await writeJson(path.join(workspaceRoot, ".owlcoda/runkit/config.json"), {
    schemaVersion: "OwlCodaRunKitConfigV2",
    core: oldCore(),
    authorizationPolicy: "external_explicit_authority_required",
  });
  await mkdir(path.join(workspaceRoot, ".owlcoda/runkit/executions"));
  return workspaceRoot;
}

test("Core successor CLI plans an exact fleet migration but rejects unsigned V1 authority", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlrunkit-successor-cli-"));
  try {
    const controller = path.join(sandbox, "controller");
    const repositoryRoot = path.resolve(import.meta.dirname, "..");
    const manifest = coreManifest();
    for (const ref of manifest.files) {
      const target = path.join(controller, "scripts/runkit-contract", ref);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(repositoryRoot, "scripts/runkit-contract", ref), target);
    }
    for (const ref of manifest.dependencyFiles) {
      const target = path.join(controller, ref);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(repositoryRoot, ref), target);
    }
    await writeFile(path.join(controller, "release-marker.txt"), "baseline\n");
    await writeJson(path.join(controller, "goal.json"), {
      objective: "freeze and migrate one Core successor",
      authorization: {
        git: false,
        publish: false,
        deploy: false,
        destructive: false,
      },
    });
    git(controller, "init", "-q");
    git(controller, "add", ".");
    git(
      controller,
      "-c",
      "user.name=RunKit Test",
      "-c",
      "user.email=runkit@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    await runCli(["init", "--workspace", controller]);
    await runCli([
      "start",
      "--workspace",
      controller,
      "--run-id",
      "release-successor",
      "--goal",
      path.join(controller, "goal.json"),
      "--work-item",
      "release",
      "--owned-path", "release-marker.txt",
    ]);
    await writeFile(path.join(controller, "release-marker.txt"), "candidate\n");
    const projectA = await fleetProject(sandbox, "project-a");
    const projectB = await fleetProject(sandbox, "project-b");

    const planned = await runCli([
      "core-successor",
      "plan",
      "--workspace",
      controller,
      "--plan-id",
      "core-016",
      "--run-id",
      "release-successor",
      "--from-lease",
      "release",
      "--candidate-id",
      "candidate",
      "--workspace-root",
      projectB,
      "--workspace-root",
      projectA,
    ]);
    assert.equal(planned.status, "core_successor_plan_created");
    assert.deepEqual(planned.fromCore, oldCore());
    assert.deepEqual(planned.toCore, currentCoreIdentity());
    assert.equal(planned.fleetSize, 2);

    const plan = JSON.parse(await readFile(
      path.join(controller, planned.planPath),
      "utf8",
    ));
    const authorityBody = {
      schemaVersion: "OwlCodaRunKitOwnerMigrationAuthorityV1",
      authorityId: "owner-core-016",
      decision: "approved",
      scope: "migrate_declared_core_successor_fleet",
      planSha256: plan.planSha256,
      fromCoreSetSha256: plan.fromCoreSetSha256,
      toCoreManifestSha256: plan.toCore.coreManifestSha256,
      fleetManifestSha256: plan.fleetDiscovery.frozenManifestSha256,
      authorizationGranted: false,
    };
    const authority = {
      ...authorityBody,
      authoritySha256: coreSuccessorArtifactSha256V1(authorityBody),
    };
    const authorityPath = path.join(controller, "owner-authority.json");
    await writeJson(authorityPath, authority);

    const applied = await runCli([
      "core-successor",
      "apply",
      "--workspace",
      controller,
      "--plan",
      planned.planPath,
      "--receipt-id",
      "apply-001",
      "--owner-authority",
      authorityPath,
    ]);
    assert.equal(applied.status, "invalid_input");
    assert.match(applied.issues.join("\n"), /owner_authority_untrusted/u);
    for (const workspaceRoot of [projectA, projectB]) {
      const config = JSON.parse(await readFile(
        path.join(workspaceRoot, ".owlcoda/runkit/config.json"),
        "utf8",
      ));
      assert.deepEqual(config.core, oldCore());
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Core successor CLI exposes explicit resume and orphan-adoption entrypoints", async () => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "owlrunkit-successor-resume-cli-"));
  try {
    const help = await runCli(["--help"]);
    assert.match(help.humanOutput, /core-successor <plan\|apply\|resume>/u);

    const missingPlan = await runCli([
      "core-successor",
      "resume",
      "--workspace",
      sandbox,
      "--from-receipt",
      "missing-partial.json",
      "--owner-authority",
      "missing-authority.json",
    ]);
    assert.equal(missingPlan.status, "invalid_input");
    assert.match(missingPlan.issues.join("\n"), /--plan is required/u);
    assert.doesNotMatch(
      missingPlan.issues.join("\n"),
      /core-successor <plan\|apply>/u,
    );

    const missingReceiptId = await runCli([
      "core-successor",
      "resume",
      "--workspace",
      sandbox,
      "--plan",
      "missing-plan.json",
      "--owner-authority",
      "missing-authority.json",
      "--adopt-orphan-success-receipts",
    ]);
    assert.equal(missingReceiptId.status, "invalid_input");
    assert.match(missingReceiptId.issues.join("\n"), /--receipt-id is required/u);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
