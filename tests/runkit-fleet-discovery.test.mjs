import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadFleetDiscovery() {
  try {
    return await import("../scripts/runkit-contract/fleet-discovery.mjs");
  } catch (error) {
    assert.fail(`fleet discovery contract must be available: ${error.code ?? error.message}`);
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

test("fleet discovery preserves explicit workspace compatibility with canonical deterministic roots", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-fleet-explicit-")));
  try {
    const first = path.join(sandbox, "z-project");
    const second = path.join(sandbox, "a-project");
    await mkdir(first);
    await mkdir(second);
    const result = await discoverFleet({
      workspaceRoots: [first, second, first],
    });
    assert.equal(result.schemaVersion, "OwlCodaRunKitFleetDiscoveryV1");
    assert.equal(result.source, "explicit_workspaces");
    assert.deepEqual(result.workspaceRoots, [second, first]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("a frozen fleet manifest remains an explicit deterministic source", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-fleet-manifest-")));
  try {
    const first = path.join(sandbox, "project-a");
    const second = path.join(sandbox, "project-b");
    await mkdir(first);
    await mkdir(second);
    const manifestPath = path.join(sandbox, "fleet.json");
    await writeJson(manifestPath, {
      schemaVersion: "OwlCodaRunKitFleetManifestV1",
      skillName: "owlcoda-runkit",
      workspaceRoots: [second, first],
      authorizationGranted: false,
    });
    const result = await discoverFleet({ fleetManifestPath: manifestPath });
    assert.equal(result.source, "fleet_manifest");
    assert.equal(result.manifestPath, manifestPath);
    assert.deepEqual(result.workspaceRoots, [first, second]);

    await assert.rejects(
      discoverFleet({
        fleetManifestPath: manifestPath,
        workspaceRoots: [first],
      }),
      /fleet_source_ambiguous/,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("fleet manifest rejects duplicate, symlinked, and oversized control input", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-fleet-invalid-")));
  try {
    const project = path.join(sandbox, "project");
    const projectAlias = path.join(sandbox, "project-alias");
    await mkdir(project);
    await symlink(project, projectAlias);
    const manifestPath = path.join(sandbox, "fleet.json");

    await writeJson(manifestPath, {
      schemaVersion: "OwlCodaRunKitFleetManifestV1",
      skillName: "owlcoda-runkit",
      workspaceRoots: [project, project],
      authorizationGranted: false,
    });
    await assert.rejects(
      discoverFleet({ fleetManifestPath: manifestPath }),
      /fleet_workspace_duplicate/,
    );

    await writeJson(manifestPath, {
      schemaVersion: "OwlCodaRunKitFleetManifestV1",
      skillName: "owlcoda-runkit",
      workspaceRoots: [projectAlias],
      authorizationGranted: false,
    });
    await assert.rejects(
      discoverFleet({ fleetManifestPath: manifestPath }),
      /fleet_workspace_symlink_rejected/,
    );

    await writeFile(manifestPath, " ".repeat(1_048_577));
    await assert.rejects(
      discoverFleet({ fleetManifestPath: manifestPath }),
      /fleet_manifest_too_large/,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("explicit fleet roots are scanned recursively with bounded coverage and a frozen manifest hash", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-fleet-roots-")));
  try {
    const coverageRoot = path.join(sandbox, "projects");
    const first = path.join(coverageRoot, "team-a", "project-a");
    const second = path.join(coverageRoot, "project-b");
    const ignored = path.join(coverageRoot, "node_modules", "not-a-project");
    await writeJson(path.join(first, ".owlcoda/runkit/config.json"), {});
    await writeJson(path.join(second, ".owlcoda/runkit/config.json"), {});
    await writeJson(path.join(ignored, ".owlcoda/runkit/config.json"), {});
    await symlink(first, path.join(coverageRoot, "project-alias"));
    const missingRoot = path.join(sandbox, "missing-root");

    const result = await discoverFleet({
      fleetRoots: [coverageRoot, missingRoot],
    });
    assert.equal(result.source, "fleet_roots");
    assert.deepEqual(result.coverageRoots, [coverageRoot]);
    assert.deepEqual(result.unreachableRoots, [missingRoot]);
    assert.deepEqual(result.workspaceRoots, [second, first]);
    assert.match(result.frozenManifestSha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.complete, false);

    const complete = await discoverFleet({ fleetRoots: [coverageRoot] });
    assert.equal(complete.complete, true);
    assert.equal(
      complete.frozenManifestSha256,
      (await discoverFleet({ fleetRoots: [coverageRoot] })).frozenManifestSha256,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("registered coverage roots become the automatic complete fleet source", async () => {
  const {
    discoverFleet,
    registerFleetCoverageRoot,
  } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(
    path.join(tmpdir(), "owlrunkit-fleet-registry-"),
  ));
  try {
    const registryPath = path.join(sandbox, "fleet-root-registry.json");
    const coverageRoot = path.join(sandbox, "projects");
    const first = path.join(coverageRoot, "project-a");
    const second = path.join(coverageRoot, "nested", "project-b");
    await writeJson(path.join(first, ".owlcoda/runkit/config.json"), {});
    await writeJson(path.join(second, ".owlcoda/runkit/config.json"), {});

    const registered = await registerFleetCoverageRoot({
      fleetRoot: coverageRoot,
      fleetRegistryPath: registryPath,
    });
    assert.equal(registered.status, "fleet_root_registered");
    assert.deepEqual(registered.coverageRoots, [coverageRoot]);

    const repeated = await registerFleetCoverageRoot({
      fleetRoot: coverageRoot,
      fleetRegistryPath: registryPath,
    });
    assert.equal(repeated.status, "fleet_root_already_registered");
    assert.deepEqual(repeated.coverageRoots, [coverageRoot]);

    const discovered = await discoverFleet({
      fleetRegistryPath: registryPath,
    });
    assert.equal(discovered.source, "fleet_registry");
    assert.equal(discovered.complete, true);
    assert.deepEqual(discovered.coverageRoots, [coverageRoot]);
    assert.deepEqual(discovered.workspaceRoots, [second, first]);
    assert.match(discovered.registrySha256, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("automatic fleet discovery fails closed when any registered coverage root is unreachable", async () => {
  const {
    discoverFleet,
    registerFleetCoverageRoot,
  } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(
    path.join(tmpdir(), "owlrunkit-fleet-registry-missing-"),
  ));
  try {
    const registryPath = path.join(sandbox, "fleet-root-registry.json");
    const coverageRoot = path.join(sandbox, "projects");
    await mkdir(coverageRoot);
    await registerFleetCoverageRoot({
      fleetRoot: coverageRoot,
      fleetRegistryPath: registryPath,
    });
    await rm(coverageRoot, { recursive: true, force: true });

    const discovered = await discoverFleet({
      fleetRegistryPath: registryPath,
    });
    assert.equal(discovered.complete, false);
    assert.deepEqual(discovered.workspaceRoots, []);
    assert.deepEqual(discovered.unreachableRoots, [coverageRoot]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("registered fleet discovery fails closed on a symlinked RunKit project marker", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(
    path.join(tmpdir(), "owlrunkit-fleet-invalid-marker-"),
  ));
  try {
    const coverageRoot = path.join(sandbox, "projects");
    const project = path.join(coverageRoot, "project-a");
    const externalMarker = path.join(sandbox, "external-owlcoda");
    await mkdir(project, { recursive: true });
    await writeJson(path.join(
      externalMarker,
      "runkit/config.json",
    ), {});
    await symlink(externalMarker, path.join(project, ".owlcoda"));

    const discovered = await discoverFleet({
      fleetRoots: [coverageRoot],
    });
    assert.equal(discovered.complete, false);
    assert.deepEqual(discovered.coverageRoots, [coverageRoot]);
    assert.deepEqual(discovered.workspaceRoots, []);
    assert.deepEqual(discovered.unreachableRoots, []);
    assert.deepEqual(discovered.issues, [{
      code: "fleet_project_marker_invalid",
      path: project,
      coverageRoot,
    }]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("automatic fleet discovery fails closed instead of truncating an oversized fleet", async () => {
  const {
    discoverFleet,
    registerFleetCoverageRoot,
  } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(
    path.join(tmpdir(), "owlrunkit-fleet-registry-limit-"),
  ));
  try {
    const registryPath = path.join(sandbox, "fleet-root-registry.json");
    const coverageRoot = path.join(sandbox, "projects");
    for (let index = 0; index < 257; index += 1) {
      await writeJson(path.join(
        coverageRoot,
        `project-${String(index).padStart(3, "0")}`,
        ".owlcoda/runkit/config.json",
      ), {});
    }
    await registerFleetCoverageRoot({
      fleetRoot: coverageRoot,
      fleetRegistryPath: registryPath,
    });

    await assert.rejects(
      discoverFleet({ fleetRegistryPath: registryPath }),
      /fleet_workspace_limit_exceeded/u,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("fleet discovery stops at a project boundary and requires nested projects to be declared explicitly", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-fleet-project-boundary-",
  )));
  try {
    const coverageRoot = path.join(sandbox, "projects");
    const project = path.join(coverageRoot, "project-a");
    const nested = path.join(project, "fixtures", "nested-project");
    await writeJson(path.join(project, ".owlcoda/runkit/config.json"), {});
    await writeJson(path.join(nested, ".owlcoda/runkit/config.json"), {});
    for (let index = 0; index < 10_050; index += 1) {
      await mkdir(path.join(
        project,
        "generated",
        `directory-${String(index).padStart(5, "0")}`,
      ), { recursive: true });
    }

    const discovered = await discoverFleet({ fleetRoots: [coverageRoot] });
    assert.equal(discovered.complete, true);
    assert.deepEqual(discovered.workspaceRoots, [project]);
    assert.deepEqual(discovered.issues, []);

    const explicitlyNested = await discoverFleet({
      fleetRoots: [coverageRoot, nested],
    });
    assert.deepEqual(explicitlyNested.workspaceRoots, [nested, project].sort());
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("fleet discovery treats an unconfigured repository as a nested boundary", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-fleet-repository-boundary-",
  )));
  try {
    const coverageRoot = path.join(sandbox, "projects");
    const repository = path.join(coverageRoot, "unconfigured-repository");
    const nested = path.join(repository, "fixtures", "nested-project");
    await mkdir(repository, { recursive: true });
    await writeFile(path.join(repository, ".git"), "gitdir: /tmp/example\n");
    await writeJson(path.join(nested, ".owlcoda/runkit/config.json"), {});

    const discovered = await discoverFleet({ fleetRoots: [coverageRoot] });
    assert.equal(discovered.complete, true);
    assert.deepEqual(discovered.workspaceRoots, []);
    assert.deepEqual(discovered.issues, []);

    const explicitlyNested = await discoverFleet({ fleetRoots: [nested] });
    assert.deepEqual(explicitlyNested.workspaceRoots, [nested]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("fleet discovery reports typed path-level marker issues without mislabeling the coverage root unreachable", async () => {
  const { discoverFleet } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-fleet-marker-issues-",
  )));
  try {
    const coverageRoot = path.join(sandbox, "projects");
    const incomplete = path.join(coverageRoot, "incomplete-project");
    const symlinked = path.join(coverageRoot, "symlinked-project");
    const externalMarker = path.join(sandbox, "external-owlcoda");
    await mkdir(path.join(incomplete, ".owlcoda/runkit"), { recursive: true });
    await writeJson(path.join(externalMarker, "runkit/config.json"), {});
    await mkdir(symlinked, { recursive: true });
    await symlink(externalMarker, path.join(symlinked, ".owlcoda"));

    const discovered = await discoverFleet({ fleetRoots: [coverageRoot] });
    assert.equal(discovered.complete, false);
    assert.deepEqual(discovered.coverageRoots, [coverageRoot]);
    assert.deepEqual(discovered.unreachableRoots, []);
    assert.deepEqual(discovered.workspaceRoots, []);
    assert.deepEqual(discovered.issues, [
      {
        code: "fleet_project_marker_incomplete",
        path: incomplete,
        coverageRoot,
      },
      {
        code: "fleet_project_marker_invalid",
        path: symlinked,
        coverageRoot,
      },
    ]);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("registry replacement is dry-runnable, atomic and separates retired archives from active fleet truth", async () => {
  const {
    discoverFleet,
    inspectFleetRegistry,
    registerFleetCoverageRoot,
    replaceFleetRegistry,
    rollbackFleetRegistry,
  } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-fleet-registry-replace-",
  )));
  try {
    const registryPath = path.join(sandbox, "fleet-registry.json");
    const coverageRoot = path.join(sandbox, "projects");
    const active = path.join(coverageRoot, "active-project");
    const retiredSource = path.join(coverageRoot, "retired-project");
    const archiveRoot = path.join(coverageRoot, "archives", "retired-project");
    const excluded = path.join(coverageRoot, "discarded-worktree");
    const retirementReceipt = path.join(archiveRoot, "RETIREMENT_RECEIPT.json");
    const exclusionEvidence = path.join(sandbox, "exclusion-evidence.json");
    await writeJson(path.join(active, ".owlcoda/runkit/config.json"), {});
    await writeJson(path.join(
      archiveRoot,
      ".owlcoda/runkit/config.json",
    ), {});
    await writeJson(path.join(
      archiveRoot,
      ".owlcoda/runkit/executions/voided-run/engine-pin.json",
    ), {});
    await writeJson(retirementReceipt, {
      schemaVersion: "ExampleRunKitRetirementReceiptV1",
      status: "retired",
      sourceProjectPath: retiredSource,
      sourceRunKitPath: path.join(retiredSource, ".owlcoda/runkit"),
      revokedControlFacts: {
        execution: { disposition: "explicitly_voided" },
        lease: { disposition: "explicitly_voided" },
      },
      archive: {
        archiveRoot,
        archivePath: path.join(archiveRoot, ".owlcoda/runkit"),
        manifestsIdentical: true,
      },
      sourceRemoval: { sourcePathAbsent: true },
      retirementAuthorization: "explicit_user_authorization",
      authorizationGranted: false,
    });
    await writeJson(exclusionEvidence, {
      schemaVersion: "OwlCodaRunKitFleetClassificationEvidenceV1",
      entries: [{
        path: excluded,
        classification: "excluded",
        reasonCode: "discarded_worktree_incomplete_marker",
      }],
      authorizationGranted: false,
    });
    await registerFleetCoverageRoot({
      fleetRoot: coverageRoot,
      fleetRegistryPath: registryPath,
    });
    const beforeBytes = await readFile(registryPath);
    const fileSha256 = filePath => readFile(filePath).then(bytes => (
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    ));
    const requestPath = path.join(sandbox, "replacement-request.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitFleetRegistryReplacementRequestV1",
      expectedRegistrySha256: (await inspectFleetRegistry({
        fleetRegistryPath: registryPath,
      })).registrySha256,
      coverageRoots: [coverageRoot],
      membership: {
        schemaVersion: "OwlCodaRunKitFleetMembershipV1",
        entries: [
          { path: active, classification: "active" },
          {
            path: retiredSource,
            classification: "retired",
            reasonCode: "verified_retirement",
            evidence: {
              path: retirementReceipt,
              sha256: await fileSha256(retirementReceipt),
            },
          },
          {
            path: excluded,
            classification: "excluded",
            reasonCode: "discarded_worktree_incomplete_marker",
            evidence: {
              path: exclusionEvidence,
              sha256: await fileSha256(exclusionEvidence),
            },
          },
        ],
        authorizationGranted: false,
      },
      removedCoverageEvidence: [],
      authorizationGranted: false,
    });
    const receiptPath = path.join(sandbox, "replacement-receipt.json");
    const dryRun = await replaceFleetRegistry({
      fleetRegistryPath: registryPath,
      replacementRequestPath: requestPath,
      receiptPath,
      dryRun: true,
    });
    assert.equal(dryRun.status, "fleet_registry_replacement_dry_run");
    assert.equal(dryRun.authorizationGranted, false);
    assert.deepEqual(await readFile(registryPath), beforeBytes);
    await assert.rejects(readFile(receiptPath), /ENOENT/u);

    const applied = await replaceFleetRegistry({
      fleetRegistryPath: registryPath,
      replacementRequestPath: requestPath,
      receiptPath,
    });
    assert.equal(applied.status, "fleet_registry_replaced");
    assert.match(applied.beforeFileSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.match(applied.afterFileSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(applied.coverageDelta, { added: [], removed: [] });
    assert.equal(applied.authorizationGranted, false);
    assert.equal((await inspectFleetRegistry({
      fleetRegistryPath: registryPath,
    })).schemaVersion, "OwlCodaRunKitFleetRootRegistryV2");

    const discovered = await discoverFleet({
      fleetRegistryPath: registryPath,
    });
    assert.equal(discovered.complete, true);
    assert.deepEqual(discovered.workspaceRoots, [active]);
    assert.deepEqual(discovered.classifications, {
      active: [active],
      retired: [retiredSource],
      excluded: [excluded],
      invalid: [],
    });
    assert.deepEqual(discovered.issues, []);
    assert.equal((await readFile(receiptPath, "utf8")).includes(
      Buffer.from(beforeBytes).toString("base64"),
    ), true);

    const rollbackReceiptPath = path.join(sandbox, "rollback-receipt.json");
    const rolledBack = await rollbackFleetRegistry({
      fleetRegistryPath: registryPath,
      replacementReceiptPath: receiptPath,
      rollbackReceiptPath,
    });
    assert.equal(rolledBack.status, "fleet_registry_rolled_back");
    assert.deepEqual(await readFile(registryPath), beforeBytes);
    assert.equal((await inspectFleetRegistry({
      fleetRegistryPath: registryPath,
    })).schemaVersion, "OwlCodaRunKitFleetRootRegistryV1");
    assert.equal(JSON.parse(await readFile(
      rollbackReceiptPath,
      "utf8",
    )).authorizationGranted, false);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("registry replacement refuses coverage reduction without exact exclusion evidence", async () => {
  const {
    inspectFleetRegistry,
    registerFleetCoverageRoot,
    replaceFleetRegistry,
  } = await loadFleetDiscovery();
  const sandbox = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-fleet-registry-shrink-",
  )));
  try {
    const registryPath = path.join(sandbox, "fleet-registry.json");
    const first = path.join(sandbox, "first");
    const second = path.join(sandbox, "second");
    const active = path.join(first, "active-project");
    await writeJson(path.join(active, ".owlcoda/runkit/config.json"), {});
    await mkdir(second, { recursive: true });
    await registerFleetCoverageRoot({
      fleetRoot: first,
      fleetRegistryPath: registryPath,
    });
    await registerFleetCoverageRoot({
      fleetRoot: second,
      fleetRegistryPath: registryPath,
    });
    const requestPath = path.join(sandbox, "replacement-request.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitFleetRegistryReplacementRequestV1",
      expectedRegistrySha256: (await inspectFleetRegistry({
        fleetRegistryPath: registryPath,
      })).registrySha256,
      coverageRoots: [first],
      membership: {
        schemaVersion: "OwlCodaRunKitFleetMembershipV1",
        entries: [{ path: active, classification: "active" }],
        authorizationGranted: false,
      },
      removedCoverageEvidence: [],
      authorizationGranted: false,
    });
    await assert.rejects(
      replaceFleetRegistry({
        fleetRegistryPath: registryPath,
        replacementRequestPath: requestPath,
        receiptPath: path.join(sandbox, "receipt.json"),
        dryRun: true,
      }),
      /fleet_registry_coverage_reduction_evidence_required/u,
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
