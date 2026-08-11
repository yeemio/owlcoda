import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
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

import {
  coreIdentityFromSourceRoot,
  createCoreArtifact,
  currentCoreIdentity,
  inspectProjectUpgradeSafety,
} from "../scripts/runkit-contract/core-contract.mjs";
import { runDoctor } from "../scripts/runkit-contract/onboarding-doctor.mjs";
import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const HISTORICAL_CORE = {
  contractVersion: "0.2",
  coreVersion: "0.14.9",
  coreManifestSha256: `sha256:${"9".repeat(64)}`,
  coreSourceRef: `artifact:sha256:${"9".repeat(64)}`,
};
const LEGACY_CONTRACT_CORE = {
  contractVersion: "0.1",
  coreVersion: "0.1.0",
  coreManifestSha256:
    "sha256:e80dca782519f5e6c4373841f1c0dcc0c011d3cfeeb3010a665a6c3829a1b426",
  coreSourceRef:
    "artifact:sha256:e80dca782519f5e6c4373841f1c0dcc0c011d3cfeeb3010a665a6c3829a1b426",
};

async function loadControlState() {
  try {
    return await import("../scripts/runkit-contract/project-control-state.mjs");
  } catch (error) {
    assert.fail(`project control-state contract must be available: ${error.code ?? error.message}`);
  }
}

async function loadCliResolver() {
  try {
    return await import("../scripts/runkit-contract/project-cli-resolver.mjs");
  } catch (error) {
    assert.fail(`project CLI resolver must be available: ${error.code ?? error.message}`);
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function acceptedVerification(workItemId) {
  return {
    contractVersion: "0.2",
    gateDecision: "accepted_passed",
    gateInputSha256: "1".repeat(64),
    activeReceiptSha256: "2".repeat(64),
    sourceFingerprint: "3".repeat(64),
    verificationContextFingerprint: "4".repeat(64),
    leaseState: "released",
    selectedProfileIds: ["unit"],
    releasedLeaseIds: [workItemId],
  };
}

async function writeClosedExecution(
  root,
  runId,
  decision,
  workItemId,
  {
    core = currentCoreIdentity(),
    leaseState = "active",
  } = {},
) {
  const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
  const created = createCoreArtifact({
    core,
    producer: {
      adapterKind: "test",
      adapterVersion: "1.0.0",
    },
    payload: {
      runId,
      decision,
      ...(decision === "accepted"
        ? { verification: acceptedVerification(workItemId) }
        : {}),
      authorizationGranted: false,
    },
  });
  await writeJson(path.join(executionRoot, "engine-pin.json"), core);
  await writeJson(path.join(executionRoot, "closeout-receipt.json"), created);
  await writeJson(path.join(executionRoot, "leases", `${workItemId}.json`), {
    schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
    workItemId,
    attempt: 1,
    ownedPaths: [`src/${workItemId}.mjs`],
    state: leaseState,
  });
  return created;
}

async function bindContinuation(root, parentRunId, childRunId, resumeId) {
  const runtimeRoot = ".owlcoda/runkit";
  const childRoot = path.join(root, runtimeRoot, "executions", childRunId);
  const parentCloseoutPath = path.join(
    root,
    runtimeRoot,
    "executions",
    parentRunId,
    "closeout-receipt.json",
  );
  const attemptPath = `${runtimeRoot}/executions/${childRunId}/resume-attempts/${resumeId}.json`;
  const parentCloseoutBytes = await readFile(parentCloseoutPath);
  const parentCloseout = JSON.parse(parentCloseoutBytes.toString("utf8"));
  await writeJson(path.join(childRoot, "execution-plan.json"), {
    schemaVersion: "OwlCodaRunKitExecutionPlanV1",
    runId: childRunId,
    state: "planned",
    enginePin: currentCoreIdentity(),
    goalContractSha256: "8".repeat(64),
    continuation: {
      parentRunId,
      resumeId,
      attemptPath,
    },
    authorizationGranted: false,
  });
  await writeJson(path.join(root, attemptPath), {
    schemaVersion: "OwlCodaRunKitResumeAttemptV1",
    resumeId,
    mode: "continuation",
    runId: childRunId,
    sourceRunId: parentRunId,
    reason: "continue exact closed work",
    parentGoal: {
      path: `${runtimeRoot}/executions/${parentRunId}/goal-contract.json`,
      sha256: "7".repeat(64),
    },
    parentCloseout: {
      decision: parentCloseout.artifact.payload.decision,
      path: `${runtimeRoot}/executions/${parentRunId}/closeout-receipt.json`,
      sha256: createHash("sha256").update(parentCloseoutBytes).digest("hex"),
    },
    inheritedEvidence: {
      coverageIndexPath: `${runtimeRoot}/executions/${childRunId}/coverage-indexes/continued.json`,
      coverageIndexSha256: "6".repeat(64),
      reusableReceiptIds: [],
    },
    nextAllowedAction: "acquire_writer_lease",
    requiredWorkflow: [
      "acquire_writer_lease",
      "prepare_or_replace_delivery_packet",
      "verify_plan",
    ],
    authorizationGranted: false,
  });
  await writeFile(path.join(childRoot, "events.jsonl"), [
    JSON.stringify({
      sequence: 1,
      type: "execution_planned",
      runId: childRunId,
      authorizationGranted: false,
    }),
    JSON.stringify({
      sequence: 2,
      type: "execution_resumed",
      runId: childRunId,
      sourceRunId: parentRunId,
      resumeId,
      authorizationGranted: false,
    }),
    JSON.stringify({
      sequence: 3,
      type: "execution_closed",
      runId: childRunId,
      authorizationGranted: false,
    }),
    "",
  ].join("\n"));
}

async function writeActiveExecution(
  root,
  runId,
  workItemId,
  core = currentCoreIdentity(),
) {
  const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
  await writeJson(path.join(executionRoot, "engine-pin.json"), core);
  await writeJson(path.join(executionRoot, "leases", `${workItemId}.json`), {
    schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
    workItemId,
    attempt: 1,
    ownedPaths: [`src/${workItemId}.mjs`],
    state: "active",
  });
}

test("Core upgrade safety is an exact projection of the shared control-state parser", async (t) => {
  const { inspectProjectControlState } = await loadControlState();
  const cases = [
    {
      name: "active current Core",
      setup: root => writeActiveExecution(root, "active-current", "active-work"),
    },
    {
      name: "accepted closed with released lease",
      setup: root => writeClosedExecution(
        root,
        "accepted-closed",
        "accepted",
        "accepted-work",
        { leaseState: "released" },
      ),
    },
    {
      name: "accepted closed with inconsistent legacy active lease",
      setup: root => writeClosedExecution(
        root,
        "accepted-inconsistent",
        "accepted",
        "accepted-work",
      ),
    },
    {
      name: "rejected closed with legacy active lease",
      setup: root => writeClosedExecution(
        root,
        "rejected-closed",
        "rejected",
        "rejected-work",
      ),
    },
    {
      name: "blocked closed with legacy active lease",
      setup: root => writeClosedExecution(
        root,
        "blocked-closed",
        "blocked",
        "blocked-work",
      ),
    },
    {
      name: "closed historical Core drift",
      setup: root => writeClosedExecution(
        root,
        "historical-closed",
        "blocked",
        "historical-work",
        { core: HISTORICAL_CORE },
      ),
    },
    {
      name: "active Core drift",
      setup: root => writeActiveExecution(
        root,
        "active-drift",
        "drift-work",
        HISTORICAL_CORE,
      ),
    },
    {
      name: "invalid closeout artifact",
      setup: async root => {
        const closeout = await writeClosedExecution(
          root,
          "invalid-closeout",
          "rejected",
          "invalid-work",
        );
        await writeJson(
          path.join(
            root,
            ".owlcoda/runkit/executions/invalid-closeout/closeout-receipt.json",
          ),
          {
            ...closeout,
            artifactSha256: `sha256:${"f".repeat(64)}`,
          },
        );
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const root = await realpath(await mkdtemp(
        path.join(tmpdir(), "owlrunkit-control-parity-"),
      ));
      try {
        await scenario.setup(root);
        const shared = inspectProjectControlState({ workspaceRoot: root });
        assert.deepEqual(
          inspectProjectUpgradeSafety({ workspaceRoot: root }),
          shared.upgradeSafety,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

async function writeInstalledPackage(root) {
  const version = currentCoreIdentity().coreVersion;
  const resolved = `https://registry.npmjs.org/owlrunkit/-/owlrunkit-${version}.tgz`;
  const integrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  await writeJson(path.join(root, "package.json"), {
    dependencies: { owlrunkit: version },
  });
  await writeJson(path.join(root, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { owlrunkit: version } },
      "node_modules/owlrunkit": { version, resolved, integrity },
    },
  });
  await writeJson(path.join(root, "node_modules/owlrunkit/package.json"), {
    name: "owlrunkit",
    version,
    type: "module",
    bin: { owlrunkit: "scripts/runkit-contract/runkit-bootstrap.mjs" },
  });
  const packageRoot = path.join(root, "node_modules/owlrunkit");
  await cp(
    path.join(repositoryRoot, "scripts/runkit-contract"),
    path.join(packageRoot, "scripts/runkit-contract"),
    { recursive: true },
  );
  await cp(
    path.join(repositoryRoot, "packages/attest"),
    path.join(packageRoot, "packages/attest"),
    { recursive: true },
  );
  const cliPath = path.join(
    packageRoot,
    "scripts/runkit-contract/runkit-bootstrap.mjs",
  );
  return {
    cliPath,
    integrity,
    resolved,
    coreManifestSha256:
      coreIdentityFromSourceRoot(packageRoot).coreManifestSha256,
  };
}

test("shared control state ignores trusted nonaccepted historical leases but blocks live and inconsistent accepted writers", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-control-state-"));
  try {
    await writeClosedExecution(root, "blocked-history", "blocked", "blocked-work");
    await writeClosedExecution(root, "rejected-history", "rejected", "rejected-work");

    const historicalOnly = inspectProjectControlState({ workspaceRoot: root });
    assert.equal(historicalOnly.schemaVersion, "OwlCodaRunKitProjectControlStateV1");
    assert.equal(historicalOnly.upgradeSafety.status, "safe");
    assert.deepEqual(historicalOnly.activeRunIds, []);
    assert.deepEqual(historicalOnly.activeLeaseIds, []);
    for (const [runId, workItemId] of [
      ["blocked-history", "blocked-work"],
      ["rejected-history", "rejected-work"],
    ]) {
      const execution = historicalOnly.executions.find(
        row => row.runId === runId,
      );
      assert.equal(execution.lease.status, "preserved_inactive");
      assert.deepEqual(execution.lease.workItemIds, [workItemId]);
      assert.deepEqual(execution.lease.activeWorkItemIds, []);
      assert.deepEqual(
        execution.lease.preservedInactiveWorkItemIds,
        [workItemId],
      );
    }

    await writeClosedExecution(root, "accepted-history", "accepted", "accepted-work");
    await writeActiveExecution(root, "live-run", "live-work");
    const unsafe = inspectProjectControlState({ workspaceRoot: root });
    assert.equal(unsafe.upgradeSafety.status, "unsafe");
    assert.deepEqual(unsafe.activeRunIds, ["live-run"]);
    assert.deepEqual(unsafe.activeLeaseIds, [
      "accepted-history:accepted-work",
      "live-run:live-work",
    ]);
    assert.match(unsafe.issues.join("\n"), /accepted.*active lease/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted accepted historical released leases retain their historical owned-path semantics", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const historicalRoot = await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-control-historical-owned-path-",
  ));
  const currentRoot = await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-control-current-owned-path-",
  ));
  try {
    for (const [root, core] of [
      [historicalRoot, HISTORICAL_CORE],
      [currentRoot, currentCoreIdentity()],
    ]) {
      await writeClosedExecution(
        root,
        "accepted-released",
        "accepted",
        "accepted-work",
        { core, leaseState: "released" },
      );
      await writeJson(path.join(
        root,
        ".owlcoda/runkit/executions/accepted-released/leases/accepted-work.json",
      ), {
        schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
        workItemId: "accepted-work",
        attempt: 1,
        ownedPaths: [
          ".owlcoda/runkit/profiles.json",
          "src/historical-work.mjs",
        ],
        state: "released",
      });
    }

    const historical = inspectProjectControlState({
      workspaceRoot: historicalRoot,
    });
    assert.equal(historical.status, "idle");
    assert.equal(historical.upgradeSafety.status, "safe");
    assert.deepEqual(historical.activeRunIds, []);
    assert.deepEqual(historical.activeLeaseIds, []);
    assert.equal(historical.executions[0].historical, true);
    assert.equal(historical.executions[0].lease.status, "released");

    const current = inspectProjectControlState({ workspaceRoot: currentRoot });
    assert.equal(current.status, "invalid");
    assert.equal(current.upgradeSafety.status, "unsafe");
    assert.match(current.issues.join("\n"), /ownedPaths are invalid/u);
  } finally {
    await rm(historicalRoot, { recursive: true, force: true });
    await rm(currentRoot, { recursive: true, force: true });
  }
});

test("trusted Contract 0.1 accepted history does not require a later released-lease binding", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const releasedRoot = await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-control-legacy-accepted-released-",
  ));
  const activeRoot = await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-control-legacy-accepted-active-",
  ));
  try {
    for (const [root, leaseState] of [
      [releasedRoot, "released"],
      [activeRoot, "active"],
    ]) {
      const runId = "run007-canonical-self-host-001";
      const executionRoot = path.join(
        root,
        ".owlcoda/runkit/executions",
        runId,
      );
      const closeout = {
        artifact: {
          schemaVersion: "RunKitCoreArtifactV1",
          core: LEGACY_CONTRACT_CORE,
          producer: { adapterKind: "codex", adapterVersion: "0.1.0" },
          payload: {
            runId,
            decision: "accepted",
            authorizationGranted: false,
          },
          extensions: { "dev.owlcoda.adapter.codex": {} },
        },
        acceptanceSha256:
          "sha256:37f8918af98d5c2718dfc56ec0acb0f38466dfb2c57a3dae4accf8d1bbd5a4c9",
        artifactSha256:
          "sha256:8d2a0dbdf444c466dbe0969a85bb17cadca0e5d0f9105b6c9a86513904331ecc",
      };
      await writeJson(path.join(executionRoot, "engine-pin.json"), LEGACY_CONTRACT_CORE);
      await writeJson(path.join(executionRoot, "closeout-receipt.json"), closeout);
      await writeJson(path.join(executionRoot, "leases/legacy-work.json"), {
        schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
        workItemId: "legacy-work",
        attempt: 1,
        ownedPaths: ["src/legacy-work.mjs"],
        state: leaseState,
      });
    }

    const released = inspectProjectControlState({ workspaceRoot: releasedRoot });
    assert.equal(released.status, "idle");
    assert.equal(released.upgradeSafety.status, "safe");
    assert.deepEqual(released.activeLeaseIds, []);

    const active = inspectProjectControlState({ workspaceRoot: activeRoot });
    assert.equal(active.status, "invalid");
    assert.equal(active.upgradeSafety.status, "unsafe");
    assert.deepEqual(active.activeLeaseIds, [
      "run007-canonical-self-host-001:legacy-work",
    ]);
    assert.match(active.issues.join("\n"), /accepted closeout retains active lease/i);
  } finally {
    await rm(releasedRoot, { recursive: true, force: true });
    await rm(activeRoot, { recursive: true, force: true });
  }
});

test("shared control state proves one continuation head without using runId order as chronology", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-control-chronology-"));
  try {
    await writeClosedExecution(
      root,
      "z-parent-accepted",
      "accepted",
      "parent-work",
      { leaseState: "released" },
    );
    await writeClosedExecution(
      root,
      "a-child-rejected",
      "rejected",
      "child-work",
      { leaseState: "released" },
    );
    await bindContinuation(
      root,
      "z-parent-accepted",
      "a-child-rejected",
      "resume-child",
    );

    const shared = inspectProjectControlState({ workspaceRoot: root });

    assert.deepEqual(shared.closedHistory, {
      status: "unique_head",
      runIds: ["a-child-rejected", "z-parent-accepted"],
      headRunId: "a-child-rejected",
      decision: "rejected",
      lineageVerified: true,
      issues: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuation metadata without its ordered event sequence cannot establish chronology", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-control-forged-chronology-"));
  try {
    await writeClosedExecution(
      root,
      "z-parent-accepted",
      "accepted",
      "parent-work",
      { leaseState: "released" },
    );
    await writeClosedExecution(
      root,
      "a-child-rejected",
      "rejected",
      "child-work",
      { leaseState: "released" },
    );
    await bindContinuation(
      root,
      "z-parent-accepted",
      "a-child-rejected",
      "resume-child",
    );
    await writeFile(
      path.join(
        root,
        ".owlcoda/runkit/executions/a-child-rejected/events.jsonl",
      ),
      `${JSON.stringify({
        sequence: 1,
        type: "execution_planned",
        runId: "a-child-rejected",
        authorizationGranted: false,
      })}\n`,
    );

    const shared = inspectProjectControlState({ workspaceRoot: root });

    assert.equal(shared.closedHistory.status, "ambiguous_history");
    assert.equal(shared.closedHistory.headRunId, null);
    assert.equal(shared.closedHistory.lineageVerified, false);
    assert.match(
      shared.closedHistory.issues.join("\n"),
      /continuation event sequence/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared control state marks mixed unlinked closeouts ambiguous and same-decision history consistent", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const mixedRoot = await mkdtemp(path.join(tmpdir(), "owlrunkit-control-mixed-history-"));
  const consistentRoot = await mkdtemp(path.join(tmpdir(), "owlrunkit-control-consistent-history-"));
  try {
    await writeClosedExecution(
      mixedRoot,
      "a-rejected",
      "rejected",
      "rejected-work",
      { leaseState: "released" },
    );
    await writeClosedExecution(
      mixedRoot,
      "z-accepted",
      "accepted",
      "accepted-work",
      { leaseState: "released" },
    );
    const mixed = inspectProjectControlState({ workspaceRoot: mixedRoot });
    assert.equal(
      mixed.closedHistory.status,
      "multiple_independent_closed_histories",
    );
    assert.equal(mixed.closedHistory.headRunId, null);
    assert.equal(mixed.closedHistory.decision, null);
    assert.equal(mixed.closedHistory.lineageVerified, false);
    assert.equal(mixed.closedHistory.blocking, false);
    assert.deepEqual(mixed.closedHistory.decisionCounts, {
      accepted: 1,
      blocked: 0,
      rejected: 1,
    });

    await writeClosedExecution(
      consistentRoot,
      "a-accepted",
      "accepted",
      "accepted-a-work",
      { leaseState: "released" },
    );
    await writeClosedExecution(
      consistentRoot,
      "z-accepted",
      "accepted",
      "accepted-z-work",
      { leaseState: "released" },
    );
    const consistent = inspectProjectControlState({ workspaceRoot: consistentRoot });
    assert.equal(consistent.closedHistory.status, "consistent_unordered");
    assert.equal(consistent.closedHistory.headRunId, null);
    assert.equal(consistent.closedHistory.decision, "accepted");
    assert.equal(consistent.closedHistory.lineageVerified, false);
  } finally {
    await rm(mixedRoot, { recursive: true, force: true });
    await rm(consistentRoot, { recursive: true, force: true });
  }
});

test("inspect exposes the exact shared lifecycle projection used by doctor and upgrade preflight", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-control-inspect-"));
  try {
    await writeJson(path.join(root, ".owlcoda/runkit/config.json"), {
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: currentCoreIdentity(),
      authorizationPolicy: "external_explicit_authority_required",
    });
    await writeClosedExecution(root, "blocked-history", "blocked", "blocked-work");
    await writeActiveExecution(root, "live-run", "live-work");

    const shared = inspectProjectControlState({ workspaceRoot: root });
    const inspected = await runCli([
      "inspect",
      "--workspace",
      root,
      "--json",
    ]);

    assert.deepEqual(inspected.controlState, shared);
    assert.deepEqual(inspected.recovery.activeRunIds, shared.activeRunIds);
    assert.deepEqual(
      inspected.executions.find((row) => row.runId === "live-run")
        .controlState.lease,
      shared.executions.find((row) => row.runId === "live-run").lease,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed closeout remains unknown active control truth instead of becoming closed history", async () => {
  const { inspectProjectControlState } = await loadControlState();
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-control-invalid-"));
  try {
    const executionRoot = path.join(root, ".owlcoda/runkit/executions/broken-run");
    await writeJson(path.join(executionRoot, "engine-pin.json"), currentCoreIdentity());
    await mkdir(executionRoot, { recursive: true });
    await writeFile(path.join(executionRoot, "closeout-receipt.json"), "{not-json\n");

    const result = inspectProjectControlState({ workspaceRoot: root });
    assert.equal(result.status, "invalid");
    assert.deepEqual(result.activeRunIds, ["broken-run"]);
    assert.equal(result.executions[0].lifecycle, "unknown");
    assert.equal(result.recovery.nextAllowedAction, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared control state rejects dangling control-directory symlinks", async (t) => {
  const { inspectProjectControlState } = await loadControlState();

  await t.test("dangling executions root", async () => {
    const root = await realpath(await mkdtemp(
      path.join(tmpdir(), "owlrunkit-control-dangling-executions-"),
    ));
    try {
      const runtimeRoot = path.join(root, ".owlcoda/runkit");
      await mkdir(runtimeRoot, { recursive: true });
      await symlink(
        path.join(root, "missing-executions"),
        path.join(runtimeRoot, "executions"),
        "dir",
      );

      const shared = inspectProjectControlState({ workspaceRoot: root });
      assert.equal(shared.status, "invalid");
      assert.equal(shared.upgradeSafety.status, "unsafe");
      assert.equal(shared.recovery.nextAllowedAction, "repair_execution_artifacts");
      assert.match(shared.issues.join("\n"), /executions directory.*regular directory/i);
      assert.deepEqual(
        inspectProjectUpgradeSafety({ workspaceRoot: root }),
        shared.upgradeSafety,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("dangling leases root under an accepted closeout", async () => {
    const root = await realpath(await mkdtemp(
      path.join(tmpdir(), "owlrunkit-control-dangling-leases-"),
    ));
    try {
      await writeClosedExecution(
        root,
        "accepted-dangling-lease",
        "accepted",
        "accepted-work",
        { leaseState: "released" },
      );
      const leasesRoot = path.join(
        root,
        ".owlcoda/runkit/executions/accepted-dangling-lease/leases",
      );
      await rm(leasesRoot, { recursive: true, force: true });
      await symlink(path.join(root, "missing-leases"), leasesRoot, "dir");

      const shared = inspectProjectControlState({ workspaceRoot: root });
      assert.equal(shared.status, "invalid");
      assert.equal(shared.upgradeSafety.status, "unsafe");
      assert.equal(shared.recovery.nextAllowedAction, "repair_execution_artifacts");
      assert.match(shared.issues.join("\n"), /lease directory.*regular directory/i);
      assert.deepEqual(
        inspectProjectUpgradeSafety({ workspaceRoot: root }),
        shared.upgradeSafety,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("project CLI resolver returns only a canonical exact package entrypoint", async () => {
  const { resolveProjectCli } = await loadCliResolver();
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-local-cli-")));
  try {
    const installed = await writeInstalledPackage(root);
    await writeJson(path.join(root, ".owlcoda/runkit/config.json"), {
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: {
        contractVersion: "0.2",
        coreVersion: currentCoreIdentity().coreVersion,
        coreManifestSha256: installed.coreManifestSha256,
        coreSourceRef: `artifact:${installed.coreManifestSha256}`,
      },
      authorizationPolicy: "external_explicit_authority_required",
    });
    const bound = resolveProjectCli({ workspaceRoot: root });
    assert.equal(bound.status, "bound");
    assert.equal(bound.version, currentCoreIdentity().coreVersion);
    assert.equal(bound.cliPath, installed.cliPath);
    assert.deepEqual(bound.argvPrefix, [process.execPath, installed.cliPath]);

    const wrongVersion = resolveProjectCli({
      workspaceRoot: root,
      expectedVersion: "0.15.1",
    });
    assert.equal(wrongVersion.status, "mismatch");
    assert.deepEqual(wrongVersion.issueCodes, ["project_cli_version_mismatch"]);

    await rm(installed.cliPath);
    await symlink(repositoryRoot, installed.cliPath);
    const symlinked = resolveProjectCli({ workspaceRoot: root });
    assert.equal(symlinked.status, "mismatch");
    assert.ok(symlinked.issueCodes.includes("project_cli_symlink_rejected"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor consumes shared lifecycle truth before suggesting a new execution", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "owlrunkit-doctor-control-")));
  try {
    const installed = await writeInstalledPackage(root);
    await writeJson(path.join(root, ".owlcoda/runkit/config.json"), {
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: currentCoreIdentity(),
      authorizationPolicy: "external_explicit_authority_required",
    });
    await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
      schemaVersion: "OwlCodaRunKitProfilesV1",
      profiles: [],
    });
    await writeActiveExecution(root, "doctor-active", "doctor-work");
    const report = await runDoctor({
      workspaceRoot: root,
      registryClient: {
        async readExact() {
          return {
            status: "registry_verified",
            packageName: "owlrunkit",
            version: currentCoreIdentity().coreVersion,
            tarballUrl: installed.resolved,
            integrity: installed.integrity,
          };
        },
      },
    });
    assert.equal(report.checks.lifecycle.status, "active");
    assert.deepEqual(report.checks.lifecycle.activeRunIds, ["doctor-active"]);
    assert.equal(report.nextAllowedAction, "inspect_active_execution");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
