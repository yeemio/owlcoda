import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  currentCoreIdentity,
} from "../scripts/runkit-contract/core-contract.mjs";
import {
  applyCoreSuccessorPlanV1,
  coreSuccessorArtifactSha256V1,
  createCoreSuccessorPlanV1,
  createCoreSuccessorPlanFromFleetV1,
} from "../scripts/runkit-contract/core-successor.mjs";
import * as coreSuccessor from "../scripts/runkit-contract/core-successor.mjs";
import {
  ownerAuthorityArtifactSha256V1,
} from "../scripts/runkit-contract/owner-authority-trust.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function oldCoreIdentity() {
  return {
    contractVersion: "0.2",
    coreVersion: "0.14.0",
    coreManifestSha256: `sha256:${"1".repeat(64)}`,
    coreSourceRef: `artifact:sha256:${"1".repeat(64)}`,
  };
}

async function writeProjectConfig(workspaceRoot, core) {
  await mkdir(
    path.join(workspaceRoot, ".owlcoda/runkit/executions"),
    { recursive: true },
  );
  await writeJson(path.join(workspaceRoot, ".owlcoda/runkit/config.json"), {
    schemaVersion: "OwlCodaRunKitConfigV2",
    core,
    authorizationPolicy: "external_explicit_authority_required",
  });
}

function sourceCandidateDependencies(controllerRoot) {
  let freezes = 0;
  let closureChecks = 0;
  let materializations = 0;
  const candidatePath = ".owlcoda/runkit/source-candidate.json";
  const candidateSha256 = `sha256:${"2".repeat(64)}`;
  return {
    get freezes() {
      return freezes;
    },
    get closureChecks() {
      return closureChecks;
    },
    get materializations() {
      return materializations;
    },
    candidatePath,
    candidateSha256,
    async freezeSourceCandidate() {
      freezes += 1;
      await writeJson(path.join(controllerRoot, candidatePath), {
        schemaVersion: "TestFrozenSourceCandidateV1",
        candidateSha256,
      });
      return {
        status: "source_candidate_frozen",
        candidatePath,
        candidateSha256,
        sourceFingerprint: "3".repeat(64),
        payloadSha256: `sha256:${"4".repeat(64)}`,
        ownedPaths: ["scripts/runkit-contract/**"],
        deliveryPacketPath: ".owlcoda/runkit/source-delivery.json",
        authorizationGranted: false,
      };
    },
    verifySourceCandidate({ candidatePath: selectedPath }) {
      assert.equal(selectedPath, candidatePath);
      return {
        status: "valid",
        exitCode: 0,
        candidatePath,
        candidateSha256,
        issueCodes: [],
        authorizationGranted: false,
      };
    },
    verifySourceCandidatePathClosure({ includedPaths }) {
      closureChecks += 1;
      return {
        schemaVersion: "OwlCodaRunKitSourceCandidatePathClosureV1",
        status: "valid",
        exitCode: 0,
        includedPaths,
        issueCodes: [],
        closureSha256: `sha256:${"5".repeat(64)}`,
        authorizationGranted: false,
      };
    },
    materializeSourceCandidate() {
      materializations += 1;
      return {
        status: "source_candidate_materialized",
        exitCode: 0,
        candidateSha256,
        payloadSha256: `sha256:${"4".repeat(64)}`,
        authorizationGranted: false,
      };
    },
    async materializedCoreIdentity() {
      return currentCoreIdentity();
    },
    async createMaterializationWorkspace() {
      return {
        workspaceRoot: controllerRoot,
        async cleanup() {},
      };
    },
  };
}

function sourcePlanDependencies(source) {
  return {
    freezeSourceCandidate: source.freezeSourceCandidate,
    verifySourceCandidate: source.verifySourceCandidate,
    verifySourceCandidatePathClosure: source.verifySourceCandidatePathClosure,
    materializeSourceCandidate: source.materializeSourceCandidate,
    materializedCoreIdentity: source.materializedCoreIdentity,
    createMaterializationWorkspace: source.createMaterializationWorkspace,
  };
}

function ownerAuthority(plan, authorityId = "owner-decision-001") {
  const body = {
    schemaVersion: "OwlCodaRunKitOwnerMigrationAuthorityV2",
    authorityId,
    decision: "approved",
    scope: "migrate_declared_core_successor_fleet",
    planSha256: plan.planSha256,
    fromCoreSetSha256: plan.fromCoreSetSha256,
    toCoreManifestSha256: plan.toCore.coreManifestSha256,
    fleetManifestSha256: plan.fleetDiscovery.frozenManifestSha256,
    signerKeyId: "test-owner-key",
    signatureAlgorithm: "ed25519",
    authorizationGranted: false,
  };
  return {
    ...body,
    authoritySha256: ownerAuthorityArtifactSha256V1(body),
    signature: Buffer.alloc(64, 7).toString("base64"),
  };
}

function trustedOwnerAuthorityDependency() {
  return {
    verifyOwnerAuthority({ authority }) {
      return {
        status: "trusted",
        signerKeyId: authority.signerKeyId,
        authoritySha256: authority.authoritySha256,
        trustStoreSha256: `sha256:${"7".repeat(64)}`,
      };
    },
  };
}

async function setupFleet(prefix) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  const controller = path.join(root, "controller");
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  await mkdir(controller);
  await mkdir(projectA);
  await mkdir(projectB);
  const fromCore = oldCoreIdentity();
  const toCore = currentCoreIdentity();
  await writeProjectConfig(projectA, fromCore);
  await writeProjectConfig(projectB, fromCore);
  return {
    root,
    controller,
    projectA,
    projectB,
    fromCore,
    toCore,
  };
}

async function setupThreeProjectFleet(prefix) {
  const fixture = await setupFleet(prefix);
  const projectC = path.join(fixture.root, "project-c");
  await mkdir(projectC);
  await writeProjectConfig(projectC, fixture.fromCore);
  return {
    ...fixture,
    projectC,
  };
}

async function writeGenericMigrationReceipt({
  workspaceRoot,
  fromCore,
  toCore,
  name,
}) {
  const migrationReceipt = `.owlcoda/runkit/config-migration-receipts/${name}.json`;
  await writeJson(path.join(workspaceRoot, migrationReceipt), {
    schemaVersion: "OwlCodaRunKitConfigMigrationReceiptV1",
    migration: "config-v02-core-refresh",
    fromSchemaVersion: "OwlCodaRunKitConfigV2",
    toSchemaVersion: "OwlCodaRunKitConfigV2",
    fromCore,
    toCore,
    authorizationGranted: false,
  });
  await writeProjectConfig(workspaceRoot, toCore);
  return {
    status: "upgraded",
    exitCode: 0,
    core: toCore,
    migrationReceipt,
  };
}

function testProjectSuccessReceiptPath(
  receiptBasePath,
  receiptId,
  workspaceRoot,
) {
  const extension = path.extname(receiptBasePath);
  const stem = path.basename(
    extension.length > 0
      ? receiptBasePath.slice(0, -extension.length)
      : receiptBasePath,
  );
  const workspaceSha256 = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex");
  return path.join(
    path.dirname(receiptBasePath),
    `${stem}-project-success`,
    `${receiptId}-${workspaceSha256}.json`,
  );
}

async function writeOrphanProjectSuccessReceipt({
  controllerWorkspaceRoot,
  receiptBasePath,
  receiptId,
  workspaceRoot,
  fromCore,
  toCore,
  plan,
  authority,
  attemptNumber = 1,
  priorAttemptReceiptSha256 = null,
  migrationName = "orphan-migration",
}) {
  const migration = await writeGenericMigrationReceipt({
    workspaceRoot,
    fromCore,
    toCore,
    name: migrationName,
  });
  const migrationBytes = await readFile(path.join(
    workspaceRoot,
    migration.migrationReceipt,
  ));
  const configBytes = await readFile(path.join(
    workspaceRoot,
    ".owlcoda/runkit/config.json",
  ));
  const body = {
    schemaVersion: "OwlCodaRunKitCoreSuccessorProjectSuccessReceiptV1",
    receiptId,
    attemptNumber,
    priorAttemptReceiptSha256,
    workspaceRoot,
    fromCore,
    toCore,
    planSha256: plan.planSha256,
    ownerAuthoritySha256: authority.authoritySha256,
    fleetManifestSha256: plan.fleetDiscovery.frozenManifestSha256,
    migrationStatus: migration.status,
    migrationReceiptPath: migration.migrationReceipt,
    migrationReceiptSha256: `sha256:${createHash("sha256")
      .update(migrationBytes)
      .digest("hex")}`,
    postConfigSha256: `sha256:${createHash("sha256")
      .update(configBytes)
      .digest("hex")}`,
    repositoryActions: {
      stage: false,
      commit: false,
      push: false,
      publish: false,
      deploy: false,
    },
    authorizationGranted: false,
  };
  const receipt = {
    ...body,
    receiptSha256: coreSuccessorArtifactSha256V1(body),
  };
  const receiptPath = testProjectSuccessReceiptPath(
    receiptBasePath,
    receiptId,
    workspaceRoot,
  );
  await writeJson(
    path.join(controllerWorkspaceRoot, receiptPath),
    receipt,
  );
  return {
    workspaceRoot,
    receiptBasePath,
    receiptPath,
    receiptSha256: receipt.receiptSha256,
  };
}

async function createPlan(fixture) {
  const source = sourceCandidateDependencies(fixture.controller);
  const created = await createCoreSuccessorPlanV1({
    controllerWorkspaceRoot: fixture.controller,
    planId: "successor-001",
    fromCore: fixture.fromCore,
    toCore: fixture.toCore,
    sourceCandidateRequest: {
      runId: "release-successor",
      workItemId: "release",
      candidateId: "core-016",
    },
    fleetDiscoveryRequest: {
      workspaceRoots: [fixture.projectB, fixture.projectA],
    },
    dependencies: sourcePlanDependencies(source),
  });
  return { ...created, source };
}

async function createThreeProjectPartialAttempt(
  fixture,
  {
    planId = "successor-resume",
    receiptId = "resume-001",
  } = {},
) {
  const source = sourceCandidateDependencies(fixture.controller);
  const created = await createCoreSuccessorPlanV1({
    controllerWorkspaceRoot: fixture.controller,
    planId,
    fromCore: fixture.fromCore,
    toCore: fixture.toCore,
    sourceCandidateRequest: {
      runId: "release-successor",
      workItemId: "release",
      candidateId: "core-016",
    },
    fleetDiscoveryRequest: {
      workspaceRoots: [
        fixture.projectA,
        fixture.projectB,
        fixture.projectC,
      ],
    },
    dependencies: sourcePlanDependencies(source),
  });
  const plan = JSON.parse(await readFile(
    path.join(fixture.controller, created.planPath),
    "utf8",
  ));
  const authority = ownerAuthority(plan);
  const first = await applyCoreSuccessorPlanV1({
    controllerWorkspaceRoot: fixture.controller,
    planPath: created.planPath,
    receiptId,
    ownerAuthority: authority,
    dependencies: {
      ...trustedOwnerAuthorityDependency(),
      verifySourceCandidate: source.verifySourceCandidate,
      async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
        if (workspaceRoot === fixture.projectB) {
          throw new Error("synthetic_project_b_failure");
        }
        return writeGenericMigrationReceipt({
          workspaceRoot,
          fromCore,
          toCore,
          name: `${receiptId}-a`,
        });
      },
    },
  });
  assert.equal(first.status, "partial_failure");
  return {
    created,
    plan,
    authority,
    source,
    first,
  };
}

test("one create-only successor plan freezes source once and binds the complete fleet", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-plan-");
  try {
    const { source, ...created } = await createPlan(fixture);
    assert.equal(created.status, "core_successor_plan_created");
    assert.equal(source.freezes, 1);
    assert.equal(created.authorizationGranted, false);
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    assert.equal(plan.schemaVersion, "OwlCodaRunKitCoreSuccessorPlanV1");
    assert.deepEqual(plan.fromCore, fixture.fromCore);
    assert.deepEqual(plan.toCore, fixture.toCore);
    assert.equal(plan.sourceCandidate.candidateSha256, source.candidateSha256);
    assert.equal(plan.fleetDiscovery.complete, true);
    assert.deepEqual(plan.fleetDiscovery.workspaceRoots, [
      fixture.projectA,
      fixture.projectB,
    ]);
    assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(plan.repositoryActions, {
      stage: false,
      commit: false,
      push: false,
      publish: false,
      deploy: false,
    });

    await assert.rejects(
      createCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planId: "successor-001",
        fromCore: fixture.fromCore,
        toCore: fixture.toCore,
        sourceCandidateRequest: {
          runId: "release-successor",
          workItemId: "release",
          candidateId: "core-016",
        },
        fleetDiscoveryRequest: {
          workspaceRoots: [fixture.projectA, fixture.projectB],
        },
        dependencies: sourcePlanDependencies(source),
      }),
      /core_successor_plan_exists/u,
    );
    assert.equal(source.freezes, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("high-level successor planning derives one common fleet Core and the invoked target Core", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-derived-");
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    const created = await createCoreSuccessorPlanFromFleetV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-derived",
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [fixture.projectB, fixture.projectA],
      },
      dependencies: sourcePlanDependencies(source),
    });

    assert.equal(created.status, "core_successor_plan_created");
    assert.deepEqual(created.fromCore, fixture.fromCore);
    assert.deepEqual(created.toCore, fixture.toCore);
    assert.equal(source.freezes, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("high-level successor planning binds each declared project to its own old Core", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-mixed-");
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    const olderCore = {
      contractVersion: "0.2",
      coreVersion: "0.13.0",
      coreManifestSha256: `sha256:${"9".repeat(64)}`,
      coreSourceRef: `artifact:sha256:${"9".repeat(64)}`,
    };
    await writeProjectConfig(fixture.projectB, olderCore);
    const created = await createCoreSuccessorPlanFromFleetV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-mixed",
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [fixture.projectA, fixture.projectB],
      },
      dependencies: sourcePlanDependencies(source),
    });
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    assert.equal(created.fromCoreMode, "per_project");
    assert.equal(plan.fromCore, null);
    assert.deepEqual(plan.fleetCoreBindings, [
      { workspaceRoot: fixture.projectA, fromCore: fixture.fromCore },
      { workspaceRoot: fixture.projectB, fromCore: olderCore },
    ]);
    assert.match(plan.fromCoreSetSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(source.freezes, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("successor planning proves path closure and a materialized target Core before writing a plan", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-proof-");
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    const created = await createCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-proof",
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [fixture.projectA, fixture.projectB],
      },
      dependencies: sourcePlanDependencies(source),
    });
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    assert.equal(source.closureChecks, 1);
    assert.equal(source.materializations, 1);
    assert.equal(plan.sourceCandidate.pathClosure.status, "valid");
    assert.deepEqual(
      plan.sourceCandidate.materializationProof.materializedCore,
      fixture.toCore,
    );
    assert.equal(plan.sourceCandidate.materializationProof.matchesToCore, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("successor planning rejects a materialized candidate that does not rebuild the target Core", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-proof-drift-");
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    await assert.rejects(
      createCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planId: "successor-proof-drift",
        fromCore: fixture.fromCore,
        toCore: fixture.toCore,
        sourceCandidateRequest: {
          runId: "release-successor",
          workItemId: "release",
          candidateId: "core-016",
        },
        fleetDiscoveryRequest: {
          workspaceRoots: [fixture.projectA, fixture.projectB],
        },
        dependencies: {
          ...sourcePlanDependencies(source),
          materializedCoreIdentity: async () => fixture.fromCore,
        },
      }),
      /materialized_core_identity_mismatch/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an incomplete fleet is rejected before source freezing", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-incomplete-");
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    await assert.rejects(
      createCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planId: "successor-incomplete",
        fromCore: fixture.fromCore,
        toCore: fixture.toCore,
        sourceCandidateRequest: {
          runId: "release-successor",
          workItemId: "release",
          candidateId: "core-016",
        },
        fleetDiscoveryRequest: { fleetRoots: [fixture.root] },
        dependencies: {
          discoverFleet: async () => ({
            schemaVersion: "OwlCodaRunKitFleetDiscoveryV1",
            source: "fleet_roots",
            coverageRoots: [fixture.root],
            unreachableRoots: [path.join(fixture.root, "unreachable")],
            workspaceRoots: [fixture.projectA, fixture.projectB],
            complete: false,
            frozenManifestSha256: `sha256:${"4".repeat(64)}`,
            authorizationGranted: false,
          }),
          freezeSourceCandidate: source.freezeSourceCandidate,
          verifySourceCandidate: source.verifySourceCandidate,
        },
      }),
      /core_successor_fleet_incomplete/u,
    );
    assert.equal(source.freezes, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("one unsafe or core-drifted fleet member blocks all migration writes", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-blocked-");
  try {
    const created = await createPlan(fixture);
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    await writeProjectConfig(fixture.projectB, fixture.toCore);
    let migrations = 0;
    const result = await applyCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "blocked-attempt",
      ownerAuthority: ownerAuthority(plan),
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: created.source.verifySourceCandidate,
        inspectProjectControlState({ workspaceRoot }) {
          return {
            status: workspaceRoot === fixture.projectA ? "active" : "idle",
            upgradeSafety: {
              status: workspaceRoot === fixture.projectA ? "unsafe" : "safe",
              activeRunIds: workspaceRoot === fixture.projectA ? ["live-run"] : [],
              activeLeaseIds: [],
              issues: [],
            },
            authorizationGranted: false,
          };
        },
        async migrateWorkspace() {
          migrations += 1;
        },
      },
    });
    assert.equal(result.status, "blocked_preflight");
    assert.equal(result.exitCode, 2);
    assert.equal(migrations, 0);
    assert.equal(result.authorizationGranted, false);
    const receipt = JSON.parse(await readFile(
      path.join(fixture.controller, result.receiptPath),
      "utf8",
    ));
    assert.equal(receipt.projects.length, 2);
    assert.equal(
      receipt.projects.find(row => row.workspaceRoot === fixture.projectA).status,
      "unsafe",
    );
    assert.equal(
      receipt.projects.find(row => row.workspaceRoot === fixture.projectB).status,
      "unsafe",
    );
    assert.ok(receipt.projects.find(
      row => row.workspaceRoot === fixture.projectB,
    ).issueCodes.includes("project_target_core_without_success_receipt"));
    assert.equal(receipt.migrationAttempted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("independent exact Owner authority is required before any migration", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-authority-");
  try {
    const created = await createPlan(fixture);
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const invalidAuthority = {
      ...ownerAuthority(plan),
      planSha256: `sha256:${"9".repeat(64)}`,
    };
    let migrations = 0;
    await assert.rejects(
      applyCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planPath: created.planPath,
        receiptId: "unauthorized-attempt",
        ownerAuthority: invalidAuthority,
        dependencies: {
          verifySourceCandidate: created.source.verifySourceCandidate,
          async migrateWorkspace() {
            migrations += 1;
          },
        },
      }),
      /core_successor_owner_authority_invalid/u,
    );
    assert.equal(migrations, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a caller-created self-hash V1 authority cannot authorize a Core migration", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-self-authority-");
  try {
    const created = await createPlan(fixture);
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const selfDeclaredBody = {
      schemaVersion: "OwlCodaRunKitOwnerMigrationAuthorityV1",
      authorityId: "self-declared-owner",
      decision: "approved",
      scope: "migrate_declared_core_successor_fleet",
      planSha256: plan.planSha256,
      fromCoreSetSha256: plan.fromCoreSetSha256,
      toCoreManifestSha256: plan.toCore.coreManifestSha256,
      fleetManifestSha256: plan.fleetDiscovery.frozenManifestSha256,
      authorizationGranted: false,
    };
    let migrations = 0;
    await assert.rejects(
      applyCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planPath: created.planPath,
        receiptId: "self-authorized-attempt",
        ownerAuthority: {
          ...selfDeclaredBody,
          authoritySha256:
            coreSuccessorArtifactSha256V1(selfDeclaredBody),
        },
        dependencies: {
          verifySourceCandidate: created.source.verifySourceCandidate,
          async migrateWorkspace() {
            migrations += 1;
          },
        },
      }),
      /core_successor_owner_authority_untrusted/u,
    );
    assert.equal(migrations, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("runtime Core drift blocks the full fleet with one receipt and zero migrations", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-runtime-drift-");
  try {
    const created = await createPlan(fixture);
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    let migrations = 0;
    const result = await applyCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "runtime-drift",
      ownerAuthority: ownerAuthority(plan),
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: created.source.verifySourceCandidate,
        runtimeCoreIdentity: () => fixture.fromCore,
        async migrateWorkspace() {
          migrations += 1;
        },
      },
    });
    assert.equal(result.status, "blocked_preflight");
    assert.equal(migrations, 0);
    const receipt = JSON.parse(await readFile(
      path.join(fixture.controller, result.receiptPath),
      "utf8",
    ));
    assert.equal(receipt.projects.length, 2);
    assert.ok(receipt.projects.every(row => (
      row.status === "core_drift"
      && row.issueCodes.includes("runtime_core_drift")
      && row.migrationAttempted === false
    )));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a safe declared fleet migrates from one plan into one receipt with per-project results", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-apply-");
  try {
    const created = await createPlan(fixture);
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const migrated = [];
    const result = await applyCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "apply-001",
      ownerAuthority: ownerAuthority(plan),
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: created.source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          migrated.push(workspaceRoot);
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: `apply-001-${path.basename(workspaceRoot)}`,
          });
        },
      },
    });
    assert.equal(result.status, "applied");
    assert.equal(result.exitCode, 0);
    assert.deepEqual(migrated, [fixture.projectA, fixture.projectB]);
    assert.equal(result.authorizationGranted, false);

    const receipt = JSON.parse(await readFile(
      path.join(fixture.controller, result.receiptPath),
      "utf8",
    ));
    assert.equal(receipt.schemaVersion, "OwlCodaRunKitCoreSuccessorBatchReceiptV1");
    assert.equal(receipt.status, "applied");
    assert.equal(receipt.projects.length, 2);
    assert.ok(receipt.projects.every(row => row.status === "migrated"));
    assert.equal(receipt.ownerAuthoritySha256, ownerAuthority(plan).authoritySha256);
    assert.equal(receipt.ownerAuthoritySignerKeyId, "test-owner-key");
    assert.equal(
      receipt.ownerAuthorityTrustStoreSha256,
      `sha256:${"7".repeat(64)}`,
    );
    assert.equal(receipt.authorizationGranted, false);
    assert.deepEqual(receipt.repositoryActions, {
      stage: false,
      commit: false,
      push: false,
      publish: false,
      deploy: false,
    });
    assert.match(receipt.receiptSha256, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a successor apply holds every fleet control transaction through preflight and migration", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-fleet-lock-");
  try {
    const created = await createPlan(fixture);
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const migrated = [];
    const result = await applyCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "fleet-lock-001",
      ownerAuthority: ownerAuthority(plan),
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: created.source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          await realpath(path.join(
            fixture.projectA,
            ".owlcoda/runkit/control.lock",
          ));
          await realpath(path.join(
            fixture.projectB,
            ".owlcoda/runkit/control.lock",
          ));
          migrated.push(workspaceRoot);
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: `fleet-lock-${path.basename(workspaceRoot)}`,
          });
        },
      },
    });

    assert.equal(result.status, "applied");
    assert.deepEqual(migrated, [fixture.projectA, fixture.projectB]);
    await assert.rejects(realpath(path.join(
      fixture.projectA,
      ".owlcoda/runkit/control.lock",
    )), /ENOENT/u);
    await assert.rejects(realpath(path.join(
      fixture.projectB,
      ".owlcoda/runkit/control.lock",
    )), /ENOENT/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a mixed old-Core fleet receipt preserves each project's exact migration origin", async () => {
  const fixture = await setupFleet("owlrunkit-core-successor-mixed-apply-");
  const source = sourceCandidateDependencies(fixture.controller);
  const olderCore = {
    contractVersion: "0.2",
    coreVersion: "0.13.0",
    coreManifestSha256: `sha256:${"8".repeat(64)}`,
    coreSourceRef: `artifact:sha256:${"8".repeat(64)}`,
  };
  try {
    await writeProjectConfig(fixture.projectB, olderCore);
    const created = await createCoreSuccessorPlanFromFleetV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-mixed-apply",
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [fixture.projectA, fixture.projectB],
      },
      dependencies: sourcePlanDependencies(source),
    });
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const migrationOrigins = [];
    const result = await applyCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "apply-mixed-001",
      ownerAuthority: ownerAuthority(plan),
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          migrationOrigins.push({ workspaceRoot, fromCore });
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: `mixed-${path.basename(workspaceRoot)}`,
          });
        },
      },
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(migrationOrigins, [
      { workspaceRoot: fixture.projectA, fromCore: fixture.fromCore },
      { workspaceRoot: fixture.projectB, fromCore: olderCore },
    ]);
    const receipt = JSON.parse(await readFile(
      path.join(fixture.controller, result.receiptPath),
      "utf8",
    ));
    assert.equal(receipt.fromCoreMode, "per_project");
    assert.equal(receipt.fromCore, null);
    assert.deepEqual(
      receipt.projects.map(({ workspaceRoot, fromCore }) => ({ workspaceRoot, fromCore })),
      migrationOrigins,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an explicit resume continues one immutable partial attempt without rerunning migrated projects", async () => {
  const fixture = await setupThreeProjectFleet(
    "owlrunkit-core-successor-resume-",
  );
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    assert.equal(
      typeof coreSuccessor.resumeCoreSuccessorPlanV1,
      "function",
      "core successor must expose an explicit resume operation",
    );
    const created = await createCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-resume",
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [
          fixture.projectA,
          fixture.projectB,
          fixture.projectC,
        ],
      },
      dependencies: sourcePlanDependencies(source),
    });
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const authority = ownerAuthority(plan);
    const firstMigrated = [];
    const first = await applyCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "resume-001",
      ownerAuthority: authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          firstMigrated.push(workspaceRoot);
          if (workspaceRoot === fixture.projectB) {
            throw new Error("synthetic_project_b_failure");
          }
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: "resume-001-a",
          });
        },
      },
    });
    assert.equal(first.status, "partial_failure");
    assert.deepEqual(firstMigrated, [fixture.projectA, fixture.projectB]);
    const firstBytes = await readFile(
      path.join(fixture.controller, first.receiptPath),
    );
    const firstReceipt = JSON.parse(firstBytes);
    assert.equal(firstReceipt.attemptNumber, 1);
    assert.equal(firstReceipt.priorAttemptReceiptPath, null);
    assert.equal(firstReceipt.priorAttemptReceiptSha256, null);
    assert.deepEqual(
      firstReceipt.projects.map(row => row.status),
      ["migrated", "migration_failed", "not_attempted_after_failure"],
    );
    assert.equal(firstReceipt.projectSuccessReceipts.length, 1);
    const firstSuccessRef = firstReceipt.projectSuccessReceipts[0];
    const firstSuccess = JSON.parse(await readFile(path.join(
      fixture.controller,
      firstSuccessRef.receiptPath,
    )));
    assert.equal(
      firstSuccess.schemaVersion,
      "OwlCodaRunKitCoreSuccessorProjectSuccessReceiptV1",
    );
    assert.equal(firstSuccess.workspaceRoot, fixture.projectA);
    assert.deepEqual(firstSuccess.fromCore, fixture.fromCore);
    assert.deepEqual(firstSuccess.toCore, fixture.toCore);
    assert.equal(firstSuccess.planSha256, plan.planSha256);
    assert.equal(firstSuccess.ownerAuthoritySha256, authority.authoritySha256);
    assert.equal(
      firstSuccess.fleetManifestSha256,
      plan.fleetDiscovery.frozenManifestSha256,
    );
    assert.match(firstSuccess.migrationReceiptSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.match(firstSuccess.postConfigSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.match(firstSuccess.receiptSha256, /^sha256:[a-f0-9]{64}$/u);

    await assert.rejects(
      applyCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planPath: created.planPath,
        receiptId: "resume-001",
        ownerAuthority: authority,
        dependencies: {
          ...trustedOwnerAuthorityDependency(),
          verifySourceCandidate: source.verifySourceCandidate,
        },
      }),
      /core_successor_resume_required/u,
    );

    const resumedMigrations = [];
    const resumed = await coreSuccessor.resumeCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      fromReceiptPath: first.receiptPath,
      ownerAuthority: authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          resumedMigrations.push(workspaceRoot);
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: `resume-001-${path.basename(workspaceRoot)}`,
          });
        },
      },
    });
    assert.equal(resumed.status, "applied");
    assert.deepEqual(resumedMigrations, [
      fixture.projectB,
      fixture.projectC,
    ]);
    assert.notEqual(resumed.receiptPath, first.receiptPath);
    assert.deepEqual(
      await readFile(path.join(fixture.controller, first.receiptPath)),
      firstBytes,
    );
    const resumedReceipt = JSON.parse(await readFile(
      path.join(fixture.controller, resumed.receiptPath),
      "utf8",
    ));
    assert.equal(resumedReceipt.receiptId, "resume-001");
    assert.equal(resumedReceipt.attemptNumber, 2);
    assert.equal(
      resumedReceipt.priorAttemptReceiptPath,
      first.receiptPath,
    );
    assert.equal(
      resumedReceipt.priorAttemptReceiptSha256,
      firstReceipt.receiptSha256,
    );
    assert.deepEqual(
      resumedReceipt.projects.map(row => row.status),
      [
        "skipped_as_already_migrated",
        "migrated",
        "migrated",
      ],
    );
    assert.equal(resumedReceipt.migratedCount, 3);
    assert.equal(resumedReceipt.projectSuccessReceipts.length, 3);
    assert.deepEqual(
      resumedReceipt.projectSuccessReceipts.map(row => row.workspaceRoot),
      [fixture.projectA, fixture.projectB, fixture.projectC],
    );
    for (const workspaceRoot of [
      fixture.projectA,
      fixture.projectB,
      fixture.projectC,
    ]) {
      await assert.rejects(
        realpath(path.join(workspaceRoot, ".owlcoda/runkit/control.lock")),
        /ENOENT/u,
      );
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume rejects a different signed authority and an append-only lineage branch", async () => {
  const fixture = await setupThreeProjectFleet(
    "owlrunkit-core-successor-resume-lineage-",
  );
  try {
    const partial = await createThreeProjectPartialAttempt(fixture, {
      planId: "successor-resume-lineage",
      receiptId: "resume-lineage-001",
    });
    let migrations = 0;
    await assert.rejects(
      coreSuccessor.resumeCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planPath: partial.created.planPath,
        fromReceiptPath: partial.first.receiptPath,
        ownerAuthority: ownerAuthority(
          partial.plan,
          "different-signed-owner-decision",
        ),
        dependencies: {
          ...trustedOwnerAuthorityDependency(),
          verifySourceCandidate: partial.source.verifySourceCandidate,
          async migrateWorkspace() {
            migrations += 1;
          },
        },
      }),
      /core_successor_prior_attempt_receipt_invalid/u,
    );
    assert.equal(migrations, 0);

    const second = await coreSuccessor.resumeCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: partial.created.planPath,
      fromReceiptPath: partial.first.receiptPath,
      ownerAuthority: partial.authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: partial.source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot }) {
          if (workspaceRoot === fixture.projectB) {
            throw new Error("synthetic_second_attempt_failure");
          }
          migrations += 1;
        },
      },
    });
    assert.equal(second.status, "partial_failure");
    await assert.rejects(
      coreSuccessor.resumeCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planPath: partial.created.planPath,
        fromReceiptPath: partial.first.receiptPath,
        ownerAuthority: partial.authority,
        dependencies: {
          ...trustedOwnerAuthorityDependency(),
          verifySourceCandidate: partial.source.verifySourceCandidate,
          async migrateWorkspace() {
            migrations += 1;
          },
        },
      }),
      /core_successor_resume_branch_exists/u,
    );
    assert.equal(migrations, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume revalidates source, fleet, runtime, and prior project evidence before writes", async (t) => {
  for (const scenario of [
    "source",
    "fleet",
    "runtime",
    "project_evidence",
  ]) {
    await t.test(scenario, async () => {
      const fixture = await setupThreeProjectFleet(
        `owlrunkit-core-successor-resume-${scenario}-`,
      );
      try {
        const partial = await createThreeProjectPartialAttempt(fixture, {
          planId: `successor-resume-${scenario}`,
          receiptId: `resume-${scenario}-001`,
        });
        if (scenario === "project_evidence") {
          const firstReceipt = JSON.parse(await readFile(
            path.join(fixture.controller, partial.first.receiptPath),
            "utf8",
          ));
          const success = JSON.parse(await readFile(path.join(
            fixture.controller,
            firstReceipt.projectSuccessReceipts[0].receiptPath,
          )));
          await writeFile(
            path.join(fixture.projectA, success.migrationReceiptPath),
            '{"tampered":true}\n',
          );
        }
        let migrations = 0;
        const dependencies = {
          ...trustedOwnerAuthorityDependency(),
          verifySourceCandidate: partial.source.verifySourceCandidate,
          async migrateWorkspace() {
            migrations += 1;
          },
        };
        if (scenario === "source") {
          dependencies.verifySourceCandidate = async () => ({
            status: "invalid",
            authorizationGranted: false,
            candidateSha256: partial.source.candidateSha256,
          });
        } else if (scenario === "fleet") {
          dependencies.discoverFleet = async () => ({
            ...partial.plan.fleetDiscovery,
            frozenManifestSha256: `sha256:${"0".repeat(64)}`,
          });
        } else if (scenario === "runtime") {
          dependencies.runtimeCoreIdentity = async () => fixture.fromCore;
        }
        if (scenario === "project_evidence") {
          await assert.rejects(
            coreSuccessor.resumeCoreSuccessorPlanV1({
              controllerWorkspaceRoot: fixture.controller,
              planPath: partial.created.planPath,
              fromReceiptPath: partial.first.receiptPath,
              ownerAuthority: partial.authority,
              dependencies,
            }),
            /core_successor_project_success_evidence_drift/u,
          );
        } else {
          const result = await coreSuccessor.resumeCoreSuccessorPlanV1({
            controllerWorkspaceRoot: fixture.controller,
            planPath: partial.created.planPath,
            fromReceiptPath: partial.first.receiptPath,
            ownerAuthority: partial.authority,
            dependencies,
          });
          assert.equal(result.status, "blocked_preflight");
        }
        assert.equal(migrations, 0);
        for (const workspaceRoot of [
          fixture.projectA,
          fixture.projectB,
          fixture.projectC,
        ]) {
          await assert.rejects(
            realpath(path.join(
              workspaceRoot,
              ".owlcoda/runkit/control.lock",
            )),
            /ENOENT/u,
          );
        }
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("resume blocks the full fleet before writes when target Core lacks exact success evidence", async () => {
  const fixture = await setupThreeProjectFleet(
    "owlrunkit-core-successor-resume-drift-",
  );
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    assert.equal(typeof coreSuccessor.resumeCoreSuccessorPlanV1, "function");
    const created = await createCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-resume-drift",
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [
          fixture.projectA,
          fixture.projectB,
          fixture.projectC,
        ],
      },
      dependencies: sourcePlanDependencies(source),
    });
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const authority = ownerAuthority(plan);
    const first = await applyCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "resume-drift-001",
      ownerAuthority: authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          if (workspaceRoot === fixture.projectB) {
            throw new Error("synthetic_project_b_failure");
          }
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: "resume-drift-a",
          });
        },
      },
    });
    assert.equal(first.status, "partial_failure");
    await writeProjectConfig(fixture.projectC, fixture.toCore);
    let migrations = 0;
    const resumed = await coreSuccessor.resumeCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      fromReceiptPath: first.receiptPath,
      ownerAuthority: authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: source.verifySourceCandidate,
        async migrateWorkspace() {
          migrations += 1;
        },
      },
    });
    assert.equal(resumed.status, "blocked_preflight");
    assert.equal(migrations, 0);
    const receipt = JSON.parse(await readFile(
      path.join(fixture.controller, resumed.receiptPath),
      "utf8",
    ));
    assert.equal(receipt.attemptNumber, 2);
    assert.ok(receipt.projects.find(
      row => row.workspaceRoot === fixture.projectC,
    ).issueCodes.includes("project_target_core_without_success_receipt"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ordinary apply refuses an exact orphan success receipt and explicit orphan adoption resumes crash-safely", async () => {
  const fixture = await setupThreeProjectFleet(
    "owlrunkit-core-successor-orphan-recovery-",
  );
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    const created = await createCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-orphan-recovery",
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [
          fixture.projectA,
          fixture.projectB,
          fixture.projectC,
        ],
      },
      dependencies: sourcePlanDependencies(source),
    });
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const authority = ownerAuthority(plan);
    const receiptId = "orphan-recovery-001";
    const receiptBasePath = `${path.dirname(created.planPath)}`
      + `/apply-receipts/${receiptId}.json`;
    await writeOrphanProjectSuccessReceipt({
      controllerWorkspaceRoot: fixture.controller,
      receiptBasePath,
      receiptId,
      workspaceRoot: fixture.projectA,
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      plan,
      authority,
    });

    let ordinaryMigrations = 0;
    await assert.rejects(
      applyCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planPath: created.planPath,
        receiptId,
        ownerAuthority: authority,
        dependencies: {
          ...trustedOwnerAuthorityDependency(),
          verifySourceCandidate: source.verifySourceCandidate,
          async migrateWorkspace() {
            ordinaryMigrations += 1;
          },
        },
      }),
      /core_successor_orphan_resume_required/u,
    );
    assert.equal(ordinaryMigrations, 0);
    await assert.rejects(
      readFile(path.join(fixture.controller, receiptBasePath)),
      /ENOENT/u,
    );

    const resumedMigrations = [];
    const recovered = await coreSuccessor.resumeCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId,
      adoptOrphanSuccessReceipts: true,
      ownerAuthority: authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          resumedMigrations.push(workspaceRoot);
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: `orphan-recovered-${path.basename(workspaceRoot)}`,
          });
        },
      },
    });
    assert.equal(recovered.status, "applied");
    assert.equal(recovered.attemptNumber, 1);
    assert.deepEqual(resumedMigrations, [
      fixture.projectB,
      fixture.projectC,
    ]);
    const batch = JSON.parse(await readFile(
      path.join(fixture.controller, recovered.receiptPath),
      "utf8",
    ));
    assert.equal(batch.orphanRecovery, true);
    assert.equal(batch.orphanSuccessReceiptCount, 1);
    assert.deepEqual(
      batch.projects.map(row => row.status),
      [
        "skipped_as_already_migrated",
        "migrated",
        "migrated",
      ],
    );
    assert.equal(batch.projectSuccessReceipts.length, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("explicit resume reconstructs exact success evidence after config committed but project receipt did not", async () => {
  const fixture = await setupThreeProjectFleet(
    "owlrunkit-core-successor-post-config-crash-",
  );
  const source = sourceCandidateDependencies(fixture.controller);
  try {
    const created = await createCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planId: "successor-post-config-crash",
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      sourceCandidateRequest: {
        runId: "release-successor",
        workItemId: "release",
        candidateId: "core-016",
      },
      fleetDiscoveryRequest: {
        workspaceRoots: [
          fixture.projectA,
          fixture.projectB,
          fixture.projectC,
        ],
      },
      dependencies: sourcePlanDependencies(source),
    });
    const plan = JSON.parse(await readFile(
      path.join(fixture.controller, created.planPath),
      "utf8",
    ));
    const authority = ownerAuthority(plan);
    await writeGenericMigrationReceipt({
      workspaceRoot: fixture.projectA,
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      name: "post-config-before-project-success",
    });

    const migrated = [];
    const recovered = await coreSuccessor.resumeCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: created.planPath,
      receiptId: "post-config-crash-001",
      adoptOrphanSuccessReceipts: true,
      ownerAuthority: authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          migrated.push(workspaceRoot);
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: `post-config-recovered-${path.basename(workspaceRoot)}`,
          });
        },
      },
    });

    assert.equal(recovered.status, "applied");
    assert.deepEqual(migrated, [fixture.projectB, fixture.projectC]);
    const batch = JSON.parse(await readFile(
      path.join(fixture.controller, recovered.receiptPath),
      "utf8",
    ));
    assert.equal(batch.orphanRecovery, true);
    assert.equal(batch.orphanSuccessReceiptCount, 1);
    assert.deepEqual(
      batch.projects.map(row => row.status),
      [
        "skipped_as_already_migrated",
        "migrated",
        "migrated",
      ],
    );
    assert.equal(batch.projectSuccessReceipts.length, 3);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume adopts a child-attempt orphan only when it binds the exact partial parent", async () => {
  const fixture = await setupThreeProjectFleet(
    "owlrunkit-core-successor-child-orphan-",
  );
  try {
    const partial = await createThreeProjectPartialAttempt(fixture, {
      planId: "successor-child-orphan",
      receiptId: "child-orphan-001",
    });
    const firstReceipt = JSON.parse(await readFile(
      path.join(fixture.controller, partial.first.receiptPath),
      "utf8",
    ));
    await writeOrphanProjectSuccessReceipt({
      controllerWorkspaceRoot: fixture.controller,
      receiptBasePath: firstReceipt.receiptBasePath,
      receiptId: firstReceipt.receiptId,
      workspaceRoot: fixture.projectB,
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      plan: partial.plan,
      authority: partial.authority,
      attemptNumber: 2,
      priorAttemptReceiptSha256: firstReceipt.receiptSha256,
      migrationName: "child-orphan-b",
    });
    const migrations = [];
    const recovered = await coreSuccessor.resumeCoreSuccessorPlanV1({
      controllerWorkspaceRoot: fixture.controller,
      planPath: partial.created.planPath,
      fromReceiptPath: partial.first.receiptPath,
      ownerAuthority: partial.authority,
      dependencies: {
        ...trustedOwnerAuthorityDependency(),
        verifySourceCandidate: partial.source.verifySourceCandidate,
        async migrateWorkspace({ workspaceRoot, fromCore, toCore }) {
          migrations.push(workspaceRoot);
          return writeGenericMigrationReceipt({
            workspaceRoot,
            fromCore,
            toCore,
            name: "child-orphan-c",
          });
        },
      },
    });
    assert.equal(recovered.status, "applied");
    assert.deepEqual(migrations, [fixture.projectC]);
    const batch = JSON.parse(await readFile(
      path.join(fixture.controller, recovered.receiptPath),
      "utf8",
    ));
    assert.equal(batch.attemptNumber, 2);
    assert.equal(batch.orphanRecovery, true);
    assert.equal(batch.orphanSuccessReceiptCount, 1);
    assert.deepEqual(
      batch.projects.map(row => row.status),
      [
        "skipped_as_already_migrated",
        "skipped_as_already_migrated",
        "migrated",
      ],
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume rejects a child-attempt orphan whose parent hash is not exact", async () => {
  const fixture = await setupThreeProjectFleet(
    "owlrunkit-core-successor-child-orphan-drift-",
  );
  try {
    const partial = await createThreeProjectPartialAttempt(fixture, {
      planId: "successor-child-orphan-drift",
      receiptId: "child-orphan-drift-001",
    });
    const firstReceipt = JSON.parse(await readFile(
      path.join(fixture.controller, partial.first.receiptPath),
      "utf8",
    ));
    await writeOrphanProjectSuccessReceipt({
      controllerWorkspaceRoot: fixture.controller,
      receiptBasePath: firstReceipt.receiptBasePath,
      receiptId: firstReceipt.receiptId,
      workspaceRoot: fixture.projectB,
      fromCore: fixture.fromCore,
      toCore: fixture.toCore,
      plan: partial.plan,
      authority: partial.authority,
      attemptNumber: 2,
      priorAttemptReceiptSha256: `sha256:${"9".repeat(64)}`,
      migrationName: "child-orphan-wrong-parent",
    });
    let migrations = 0;
    await assert.rejects(
      coreSuccessor.resumeCoreSuccessorPlanV1({
        controllerWorkspaceRoot: fixture.controller,
        planPath: partial.created.planPath,
        fromReceiptPath: partial.first.receiptPath,
        ownerAuthority: partial.authority,
        dependencies: {
          ...trustedOwnerAuthorityDependency(),
          verifySourceCandidate: partial.source.verifySourceCandidate,
          async migrateWorkspace() {
            migrations += 1;
          },
        },
      }),
      /core_successor_project_success_receipt_invalid/u,
    );
    assert.equal(migrations, 0);
    await assert.rejects(
      readFile(path.join(
        fixture.controller,
        firstReceipt.receiptBasePath.replace(
          /\.json$/u,
          "-attempt-002.json",
        ),
      )),
      /ENOENT/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
