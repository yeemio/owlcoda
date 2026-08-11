import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCoreArtifact,
  currentCoreIdentity,
} from "../scripts/runkit-contract/core-contract.mjs";
import {
  registerFleetCoverageRoot,
  replaceFleetRegistry,
} from "../scripts/runkit-contract/fleet-discovery.mjs";

async function loadSkillInstaller() {
  const module = await import("../scripts/runkit-contract/install-codex-skill.mjs");
  assert.equal(
    typeof module.inspectFleetForSkillChange,
    "function",
    "Skill installer must export the shared fleet preflight",
  );
  return module;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function makeProject(root) {
  await writeJson(path.join(root, ".owlcoda/runkit/config.json"), {
    schemaVersion: "OwlCodaRunKitConfigV2",
    core: currentCoreIdentity(),
    authorizationPolicy: "external_explicit_authority_required",
  });
}

async function writeHistoricalBlocked(root) {
  const runId = "blocked-history";
  const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
  const created = createCoreArtifact({
    producer: { adapterKind: "test", adapterVersion: "1.0.0" },
    payload: {
      runId,
      decision: "blocked",
      authorizationGranted: false,
    },
  });
  await writeJson(path.join(executionRoot, "engine-pin.json"), currentCoreIdentity());
  await writeJson(path.join(executionRoot, "closeout-receipt.json"), created);
  await writeJson(path.join(executionRoot, "leases", "old-work.json"), {
    schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
    workItemId: "old-work",
    attempt: 1,
    ownedPaths: ["src/old.mjs"],
    state: "active",
  });
}

test("Skill fleet preflight consumes manifest discovery and shared control state", async () => {
  const { inspectFleetForSkillChange } = await loadSkillInstaller();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-skill-shared-")));
  try {
    const first = path.join(sandbox, "project-a");
    const second = path.join(sandbox, "project-b");
    await makeProject(first);
    await makeProject(second);
    await writeHistoricalBlocked(first);
    const manifestPath = path.join(sandbox, "fleet.json");
    await writeJson(manifestPath, {
      schemaVersion: "OwlCodaRunKitFleetManifestV1",
      skillName: "owlcoda-runkit",
      workspaceRoots: [second, first],
      authorizationGranted: false,
    });

    const projects = await inspectFleetForSkillChange({
      fleetManifestPath: manifestPath,
    });
    assert.deepEqual(
      projects.map((project) => project.workspaceRoot),
      [first, second],
    );

    const activeRoot = path.join(
      second,
      ".owlcoda/runkit/executions/active-run",
    );
    await writeJson(path.join(activeRoot, "engine-pin.json"), currentCoreIdentity());
    await assert.rejects(
      inspectFleetForSkillChange({ fleetManifestPath: manifestPath }),
      /skill_update_blocked_active_execution:.*active-run/,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Skill fleet preflight retains direct workspaceRoots compatibility", async () => {
  const { inspectFleetForSkillChange } = await loadSkillInstaller();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-skill-explicit-")));
  try {
    const project = path.join(sandbox, "project");
    await makeProject(project);
    const projects = await inspectFleetForSkillChange({
      workspaceRoots: [project],
    });
    assert.equal(projects.length, 1);
    assert.equal(projects[0].workspaceRoot, project);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Skill fleet preflight refuses incomplete fleet-root discovery", async () => {
  const { inspectFleetForSkillChange } = await loadSkillInstaller();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-skill-roots-")));
  try {
    const fleetRoot = path.join(sandbox, "projects");
    const project = path.join(fleetRoot, "project");
    await makeProject(project);
    await assert.rejects(
      inspectFleetForSkillChange({
        fleetRoots: [fleetRoot, path.join(sandbox, "missing")],
      }),
      /skill_update_fleet_discovery_incomplete/,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Skill fleet preflight automatically consumes the persistent root registry", async () => {
  const { inspectFleetForSkillChange } = await loadSkillInstaller();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-skill-registry-")));
  try {
    const registryPath = path.join(sandbox, "home", "fleet-registry.json");
    const fleetRoot = path.join(sandbox, "projects");
    const first = path.join(fleetRoot, "first");
    const second = path.join(fleetRoot, "nested", "second");
    await makeProject(first);
    await makeProject(second);
    await registerFleetCoverageRoot({
      fleetRoot,
      fleetRegistryPath: registryPath,
    });

    const projects = await inspectFleetForSkillChange({
      fleetRegistryPath: registryPath,
    });
    assert.deepEqual(
      projects.map((project) => project.workspaceRoot),
      [first, second].sort(),
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("Skill fleet preflight excludes evidence-bound retired archive writers", async () => {
  const { inspectFleetForSkillChange } = await loadSkillInstaller();
  const sandbox = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-skill-retired-registry-",
  )));
  try {
    const registryPath = path.join(sandbox, "home", "fleet-registry.json");
    const fleetRoot = path.join(sandbox, "projects");
    const active = path.join(fleetRoot, "active");
    const retiredSource = path.join(fleetRoot, "retired");
    const archive = path.join(fleetRoot, "archive", "retired");
    const retirementReceipt = path.join(archive, "RETIREMENT_RECEIPT.json");
    await makeProject(active);
    await makeProject(archive);
    await writeJson(path.join(
      archive,
      ".owlcoda/runkit/executions/voided-run/engine-pin.json",
    ), currentCoreIdentity());
    await writeJson(path.join(
      archive,
      ".owlcoda/runkit/executions/voided-run/leases/voided-work.json",
    ), {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "voided-work",
      attempt: 1,
      ownedPaths: ["src/voided.mjs"],
      state: "active",
    });
    await writeJson(retirementReceipt, {
      schemaVersion: "ExampleRunKitRetirementReceiptV1",
      status: "retired",
      sourceProjectPath: retiredSource,
      sourceRunKitPath: path.join(retiredSource, ".owlcoda/runkit"),
      revokedControlFacts: {
        execution: { disposition: "explicitly_voided" },
        lease: { disposition: "explicitly_voided" },
      },
      archive: { manifestsIdentical: true },
      sourceRemoval: { sourcePathAbsent: true },
      retirementAuthorization: "explicit_user_authorization",
      authorizationGranted: false,
    });
    await registerFleetCoverageRoot({
      fleetRoot,
      fleetRegistryPath: registryPath,
    });
    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    const evidenceSha256 = `sha256:${createHash("sha256")
      .update(await readFile(retirementReceipt)).digest("hex")}`;
    const requestPath = path.join(sandbox, "replacement-request.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitFleetRegistryReplacementRequestV1",
      expectedRegistrySha256: registry.registrySha256,
      coverageRoots: [fleetRoot],
      membership: {
        schemaVersion: "OwlCodaRunKitFleetMembershipV1",
        entries: [
          { path: active, classification: "active" },
          {
            path: retiredSource,
            classification: "retired",
            reasonCode: "verified_retirement",
            evidence: { path: retirementReceipt, sha256: evidenceSha256 },
          },
        ],
        authorizationGranted: false,
      },
      removedCoverageEvidence: [],
      authorizationGranted: false,
    });
    await replaceFleetRegistry({
      fleetRegistryPath: registryPath,
      replacementRequestPath: requestPath,
      receiptPath: path.join(sandbox, "replacement-receipt.json"),
    });

    const projects = await inspectFleetForSkillChange({
      fleetRegistryPath: registryPath,
    });
    assert.deepEqual(
      projects.map(project => project.workspaceRoot),
      [active],
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
