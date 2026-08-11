import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCoreArtifact, currentCoreIdentity } from "../../scripts/runkit-contract/core-contract.mjs";
import { canonicalSourceFingerprint } from "../../scripts/runkit-contract/source-fingerprint.mjs";

const cliPath = fileURLToPath(new URL("../../scripts/runkit-contract/runkit-cli.mjs", import.meta.url));

function runCli(args) {
  const completed = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  return { ...completed, json: completed.stdout ? JSON.parse(completed.stdout) : null };
}

function git(root, args) {
  const completed = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(completed.status, 0, completed.stderr);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function verificationContext() {
  return {
    schemaVersion: "OwlCodaRunKitVerificationContextV1",
    reusePolicy: "portable",
    platform: null,
    toolchains: [{ name: "node", version: process.version }],
    lockfiles: [],
    fixtures: [],
    services: [],
    environment: [],
  };
}

async function createWorkspace({ runIds = [] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-inspect-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "runkit@example.invalid"]);
  git(root, ["config", "user.name", "RunKit Test"]);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/example.txt"), "baseline\n");
  git(root, ["add", "src/example.txt"]);
  git(root, ["commit", "-qm", "fixture baseline"]);
  assert.equal(runCli(["init", "--workspace", root]).status, 0);
  await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: [{ id: "fixture-profile", paths: ["src/**"] }],
  });
  const goalPath = path.join(root, "goal.json");
  await writeJson(goalPath, {});
  for (const runId of runIds) {
    const planned = runCli(["plan", "--workspace", root, "--run-id", runId, "--goal", goalPath]);
    assert.equal(planned.status, 0, planned.stderr);
  }
  return root;
}

function executionRoot(root, runId) {
  return path.join(root, ".owlcoda/runkit/executions", runId);
}

async function writeLease(root, runId, value) {
  await writeJson(path.join(executionRoot(root, runId), "leases/W1.json"), value);
}

function inspect(root) {
  return runCli(["inspect", "--json", "--workspace", root]);
}

test("inspect gives a new session one honest next action for a single active run", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    const planned = inspect(root);
    assert.equal(planned.status, 0, planned.stderr);
    assert.deepEqual(planned.json.recovery, {
      state: "single_active_execution",
      activeRunIds: ["active-run"],
      selectedRunId: "active-run",
      nextAllowedAction: "acquire_writer_lease",
      authorizationGranted: false,
    });
    assert.equal(planned.json.executions[0].recovery.lease.status, "none");
    assert.equal(planned.json.executions[0].recovery.evidenceTrustLevel, "planned");

    await writeLease(root, "active-run", {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/example.txt"],
      state: "active",
    });
    const working = inspect(root);
    assert.equal(working.status, 0, working.stderr);
    assert.equal(working.json.recovery.nextAllowedAction, "continue_feature_work");
    assert.deepEqual(working.json.executions[0].recovery.lease.activeWorkItemIds, ["W1"]);
    assert.equal(working.json.executions[0].recovery.evidenceTrustLevel, "work_in_progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect distinguishes no active execution and refuses to select between multiple active runs", async () => {
  const empty = await createWorkspace();
  const multiple = await createWorkspace({ runIds: ["run-a", "run-b"] });
  try {
    const none = inspect(empty);
    assert.equal(none.status, 0, none.stderr);
    assert.deepEqual(none.json.recovery, {
      state: "no_active_execution",
      activeRunIds: [],
      selectedRunId: null,
      nextAllowedAction: "plan_new_execution",
      authorizationGranted: false,
    });

    const ambiguous = inspect(multiple);
    assert.equal(ambiguous.status, 2, ambiguous.stderr);
    assert.deepEqual(ambiguous.json.recovery, {
      state: "multiple_active_executions",
      activeRunIds: ["run-a", "run-b"],
      selectedRunId: null,
      nextAllowedAction: "select_active_execution",
      authorizationGranted: false,
    });
  } finally {
    await rm(empty, { recursive: true, force: true });
    await rm(multiple, { recursive: true, force: true });
  }
});

test("inspect validates a fresh delivery and accepted verification chain before recommending closeout", async () => {
  const root = await createWorkspace({ runIds: ["verified-run"] });
  try {
    await writeLease(root, "verified-run", {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/example.txt"],
      state: "active",
    });
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const fileHash = sha256(await readFile(path.join(root, "src/example.txt")));
    const files = { "src/example.txt": fileHash };
    const packetPath = path.join(executionRoot(root, "verified-run"), "delivery-packets/delivery.json");
    await writeJson(packetPath, {
      schemaVersion: "ExecutionDeliveryPacketV1",
      runId: "verified-run",
      status: "ready_for_stage_verification",
      changedFiles: { wholeFileSha256: files },
      sourceFingerprint: { sha256: canonicalSourceFingerprint(files) },
      repositoryActions: {
        staged: false,
        committed: false,
        pushed: false,
        tagged: false,
        published: false,
        deployed: false,
      },
    });
    const snapshotRequestPath = path.join(root, "snapshot-request.json");
    await writeJson(snapshotRequestPath, {
      schemaVersion: "OwlCodaRunKitSnapshotRequestV1",
      snapshotId: "verify-node",
      mode: "project",
      targetRoot: root,
      cwd: ".",
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('verified\\n')"],
      launcherVersion: process.version,
      toolVersions: [{ name: "node", version: process.version }],
      selectedPaths: ["src/example.txt"],
      statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
      verificationContext: verificationContext(),
    });
    const snapped = runCli([
      "snapshot", "--workspace", root,
      "--run-id", "verified-run",
      "--request", snapshotRequestPath,
    ]);
    assert.equal(snapped.status, 0, snapped.stderr);
    const finalizeRequestPath = path.join(root, "finalize-request.json");
    await writeJson(finalizeRequestPath, {
      schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
      receiptId: "verification-001",
      deliveryPacketPath: path.relative(root, packetPath),
      verificationContext: verificationContext(),
      snapshotPaths: [snapped.json.snapshotPath],
    });
    const finalized = runCli([
      "finalize", "--workspace", root,
      "--run-id", "verified-run",
      "--request", finalizeRequestPath,
    ]);
    assert.equal(finalized.status, 0, finalized.stderr);

    const inspected = inspect(root);
    assert.equal(inspected.status, 0, inspected.stderr);
    const recovery = inspected.json.executions[0].recovery;
    assert.equal(recovery.delivery.status, "fresh");
    assert.equal(recovery.delivery.selectedPacketPath.endsWith("delivery.json"), true);
    assert.equal(recovery.verification.status, "passed");
    assert.equal(recovery.verification.decision, "accepted_passed");
    assert.equal(recovery.evidenceTrustLevel, "verification_passed");
    assert.equal(recovery.nextAllowedAction, "release_writer_lease");

    await rm(path.join(executionRoot(root, "verified-run"), "leases/W1.json"));
    const missingLease = inspect(root);
    assert.equal(missingLease.status, 2, missingLease.stderr);
    assert.equal(missingLease.json.executions[0].recovery.evidenceTrustLevel, "invalid");
    assert.equal(missingLease.json.executions[0].recovery.nextAllowedAction, "repair_execution_artifacts");
    assert.match(missingLease.json.executions[0].recovery.issues.join("\n"), /passed verification.*lease/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("byte-identical delivery packet copies remain one logical candidate across inspect, verify, and finish", async () => {
  const root = await createWorkspace({ runIds: ["duplicate-packet-run"] });
  try {
    const runId = "duplicate-packet-run";
    const acquired = runCli([
      "lease", "acquire",
      "--workspace", root,
      "--run-id", runId,
      "--work-item", "W1",
      "--owned-path", "src/example.txt",
    ]);
    assert.equal(acquired.status, 0, acquired.stderr);
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    for (const packetId of ["candidate-a", "candidate-b"]) {
      const created = runCli([
        "delivery", "create",
        "--workspace", root,
        "--run-id", runId,
        "--from-lease", "W1",
        "--packet-id", packetId,
      ]);
      assert.equal(created.status, 0, created.stderr);
    }

    const beforeVerify = inspect(root);
    const execution = beforeVerify.json.executions.find(item => item.runId === runId);
    assert.equal(execution.recovery.delivery.status, "fresh", JSON.stringify(execution));

    const verified = runCli([
      "verify",
      "--workspace", root,
      "--run-id", runId,
      "--from-lease", "W1",
      "--verification-id", "duplicate-logical-candidate",
      "--cwd", ".",
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ]);
    assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
    assert.equal(verified.json.status, "verified");

    const finished = runCli([
      "finish",
      "--workspace", root,
      "--run-id", runId,
      "--decision", "accepted",
    ]);
    assert.equal(finished.status, 0, `${finished.stdout}\n${finished.stderr}`);
    assert.equal(finished.json.status, "finished");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect fails closed with actionable issues for malformed active artifacts", async () => {
  const root = await createWorkspace({ runIds: ["broken-run"] });
  try {
    await mkdir(path.join(executionRoot(root, "broken-run"), "leases"), { recursive: true });
    await writeFile(path.join(executionRoot(root, "broken-run"), "leases/W1.json"), "{not-json\n");

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.status, "inspected");
    assert.equal(inspected.json.executions[0].recovery.evidenceTrustLevel, "invalid");
    assert.equal(inspected.json.executions[0].recovery.nextAllowedAction, "repair_execution_artifacts");
    assert.match(inspected.json.executions[0].recovery.issues.join("\n"), /lease.*valid JSON/i);
    assert.equal(inspected.json.executions[0].recovery.issues.some((issue) => issue.includes(root)), false);

    await writeLease(root, "broken-run", {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: [".owlcoda/runkit/executions/broken-run"],
      state: "active",
    });
    const reservedPath = inspect(root);
    assert.equal(reservedPath.status, 2, reservedPath.stderr);
    assert.equal(reservedPath.json.executions[0].recovery.nextAllowedAction, "repair_execution_artifacts");
    assert.match(reservedPath.json.executions[0].recovery.issues.join("\n"), /reserved.*runtime path/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect contains malformed accepted closeout evidence without crashing the recovery entrypoint", async () => {
  const root = await createWorkspace({ runIds: ["broken-closeout"] });
  try {
    const malformed = createCoreArtifact({
      core: currentCoreIdentity(),
      producer: { adapterKind: "codex", adapterVersion: "0.1.0" },
      payload: {
        runId: "broken-closeout",
        decision: "accepted",
        authorizationGranted: false,
        verification: {},
      },
      extensions: { "dev.owlcoda.adapter.codex": {} },
    });
    await writeJson(path.join(executionRoot(root, "broken-closeout"), "closeout-receipt.json"), malformed);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.status, "inspected");
    assert.equal(inspected.json.executions[0].closeout.status, "invalid");
    assert.equal(inspected.json.executions[0].recovery.evidenceTrustLevel, "invalid");
    assert.match(inspected.json.executions[0].recovery.issues.join("\n"), /accepted.*verification/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect keeps an unclosed execution with a malformed engine pin visible and repairable", async () => {
  const root = await createWorkspace({ runIds: ["broken-pin"] });
  try {
    await writeFile(path.join(executionRoot(root, "broken-pin"), "engine-pin.json"), "{not-json\n");

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.executions[0].lifecycle, "unknown");
    assert.deepEqual(inspected.json.recovery, {
      state: "invalid_control_truth",
      activeRunIds: ["broken-pin"],
      selectedRunId: null,
      nextAllowedAction: "repair_execution_artifacts",
      authorizationGranted: false,
    });
    assert.equal(inspected.json.summary.currentExecution.openCount, 1);
    assert.equal(inspected.json.summary.evidence.trustLevel, "none");
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");

    const human = spawnSync(process.execPath, [
      cliPath, "inspect", "--workspace", root,
    ], { encoding: "utf8" });
    assert.equal(human.status, 2, human.stderr);
    assert.match(human.stdout, /Current execution:\s+none/i);
    assert.match(human.stdout, /Open executions:\s+1/i);
    assert.match(human.stdout, /Dominant gap:\s+repair_execution_artifacts/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("multiple active executions never inherit source or evidence from closed history", async () => {
  const root = await createWorkspace({ runIds: ["closed-run", "open-a", "open-b"] });
  try {
    const closed = runCli([
      "closeout", "--workspace", root,
      "--run-id", "closed-run", "--decision", "blocked",
    ]);
    assert.equal(closed.status, 0, closed.stderr);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.recovery.state, "multiple_active_executions");
    assert.equal(inspected.json.summary.currentExecution.selectedRunId, null);
    assert.deepEqual(inspected.json.summary.source, { status: "none", sourceFingerprint: null });
    assert.deepEqual(inspected.json.summary.evidence, {
      status: "none",
      decision: null,
      activeReceiptSha256: null,
      trustLevel: "none",
    });
    assert.deepEqual(inspected.json.summary.dominantGap, {
      code: "select_active_execution",
      reasons: ["Multiple active executions require explicit selection."],
    });
    assert.equal(inspected.json.summary.latestIndexedCloseout.runId, "closed-run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect treats --json as data when it is the workspace option value", async () => {
  const created = await createWorkspace({ runIds: ["active-run"] });
  const root = path.join(path.dirname(created), "--json");
  await rename(created, root);
  try {
    const inspected = spawnSync(process.execPath, [
      cliPath, "inspect", "--workspace", "--json",
    ], { cwd: path.dirname(root), encoding: "utf8" });
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.match(inspected.stdout, /Current execution:\s+active-run/i);
    assert.throws(() => JSON.parse(inspected.stdout));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect exposes a symlinked execution as invalid open truth", async () => {
  const root = await createWorkspace({ runIds: ["redirected-run"] });
  try {
    const executionPath = executionRoot(root, "redirected-run");
    const externalPath = path.join(root, "redirected-execution-target");
    await rename(executionPath, externalPath);
    await symlink(externalPath, executionPath);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.deepEqual(inspected.json.runIds, ["redirected-run"]);
    assert.equal(inspected.json.executions[0].lifecycle, "unknown");
    assert.equal(inspected.json.executions[0].recovery.evidenceTrustLevel, "invalid");
    assert.match(inspected.json.executions[0].recovery.issues.join("\n"), /execution.*symlink/i);
    assert.equal(inspected.json.summary.currentExecution.selectedRunId, null);
    assert.equal(inspected.json.summary.currentExecution.openCount, 1);
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects a symlinked active lease instead of treating it as absent", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    const externalLease = path.join(root, "external-active-lease.json");
    await writeJson(externalLease, {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/example.txt"],
      state: "active",
    });
    const leasesRoot = path.join(executionRoot(root, "active-run"), "leases");
    await mkdir(leasesRoot, { recursive: true });
    await symlink(externalLease, path.join(leasesRoot, "W1.json"));

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.executions[0].recovery.lease.status, "invalid");
    assert.match(inspected.json.executions[0].recovery.lease.issues.join("\n"), /lease.*symlink/i);
    assert.equal(inspected.json.executions[0].recovery.evidenceTrustLevel, "invalid");
    assert.equal(inspected.json.executions[0].recovery.nextAllowedAction, "repair_execution_artifacts");
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects symlinked delivery truth instead of treating it as missing", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    await writeLease(root, "active-run", {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/example.txt"],
      state: "active",
    });
    const externalPacket = path.join(root, "external-delivery.json");
    await writeJson(externalPacket, {});
    const packetsRoot = path.join(executionRoot(root, "active-run"), "delivery-packets");
    await mkdir(packetsRoot, { recursive: true });
    await symlink(externalPacket, path.join(packetsRoot, "delivery.json"));

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.executions[0].recovery.delivery.status, "invalid");
    assert.match(inspected.json.executions[0].recovery.delivery.issues.join("\n"), /delivery.*symlink/i);
    assert.equal(inspected.json.executions[0].recovery.nextAllowedAction, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects a symlinked verification receipt directory", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    const externalReceipts = path.join(root, "external-verification-receipts");
    await mkdir(externalReceipts, { recursive: true });
    const receiptsRoot = path.join(executionRoot(root, "active-run"), "verification-receipts");
    await rm(receiptsRoot, { recursive: true, force: true });
    await symlink(externalReceipts, receiptsRoot);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.executions[0].recovery.verification.status, "invalid");
    assert.match(inspected.json.executions[0].recovery.verification.issues.join("\n"), /verification receipt.*symlink/i);
    assert.equal(inspected.json.executions[0].recovery.nextAllowedAction, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect reports a redirected executions root as invalid control truth", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    const executionsRoot = path.join(root, ".owlcoda/runkit/executions");
    const externalExecutions = path.join(root, "redirected-executions-target");
    await rename(executionsRoot, externalExecutions);
    await symlink(externalExecutions, executionsRoot);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.deepEqual(inspected.json.recovery, {
      state: "invalid_control_truth",
      activeRunIds: [],
      selectedRunId: null,
      nextAllowedAction: "repair_execution_artifacts",
      authorizationGranted: false,
    });
    assert.match(inspected.json.controlIssues.join("\n"), /executions directory.*symlink/i);
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects an engine pin routed through a symlink", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    const pinPath = path.join(executionRoot(root, "active-run"), "engine-pin.json");
    const externalPin = path.join(root, "external-engine-pin.json");
    await rename(pinPath, externalPin);
    await symlink(externalPin, pinPath);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.executions[0].lifecycle, "unknown");
    assert.match(inspected.json.executions[0].enginePin.issues.join("\n"), /engine pin.*symlink/i);
    assert.equal(inspected.json.summary.currentExecution.selectedRunId, null);
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects a closeout receipt routed through a symlink", async () => {
  const root = await createWorkspace({ runIds: ["closed-run"] });
  try {
    const closed = runCli([
      "closeout", "--workspace", root,
      "--run-id", "closed-run", "--decision", "blocked",
    ]);
    assert.equal(closed.status, 0, closed.stderr);
    const closeoutPath = path.join(executionRoot(root, "closed-run"), "closeout-receipt.json");
    const externalCloseout = path.join(root, "external-closeout.json");
    await rename(closeoutPath, externalCloseout);
    await symlink(externalCloseout, closeoutPath);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.executions[0].lifecycle, "unknown");
    assert.equal(inspected.json.executions[0].closeout.status, "invalid");
    assert.match(inspected.json.executions[0].closeout.issues.join("\n"), /closeout receipt.*symlink/i);
    assert.equal(inspected.json.recovery.state, "invalid_control_truth");
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of [
  { name: "lease", directory: "leases", recoveryKey: "lease" },
  { name: "delivery", directory: "delivery-packets", recoveryKey: "delivery" },
  { name: "verification receipt", directory: "verification-receipts", recoveryKey: "verification" },
]) {
  test(`inspect rejects a dangling ${scenario.name} directory symlink`, async () => {
    const root = await createWorkspace({ runIds: ["active-run"] });
    try {
      const truthRoot = path.join(executionRoot(root, "active-run"), scenario.directory);
      await rm(truthRoot, { recursive: true, force: true });
      await symlink(path.join(root, `missing-${scenario.directory}`), truthRoot);

      const inspected = inspect(root);
      assert.equal(inspected.status, 2, inspected.stderr);
      assert.equal(inspected.json.executions[0].recovery[scenario.recoveryKey].status, "invalid");
      assert.match(
        inspected.json.executions[0].recovery[scenario.recoveryKey].issues.join("\n"),
        /symlink/i,
      );
      assert.equal(inspected.json.executions[0].recovery.nextAllowedAction, "repair_execution_artifacts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("inspect rejects a dangling executions root symlink", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    const executionsRoot = path.join(root, ".owlcoda/runkit/executions");
    await rm(executionsRoot, { recursive: true, force: true });
    await symlink(path.join(root, "missing-executions"), executionsRoot);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.recovery.state, "invalid_control_truth");
    assert.match(inspected.json.controlIssues.join("\n"), /executions directory.*symlink/i);
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects a project config routed through a symlink", async () => {
  const root = await createWorkspace();
  try {
    const configPath = path.join(root, ".owlcoda/runkit/config.json");
    const externalConfig = path.join(root, "external-config.json");
    await rename(configPath, externalConfig);
    await symlink(externalConfig, configPath);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.config, null);
    assert.equal(inspected.json.configCore.status, "invalid_config");
    assert.equal(inspected.json.recovery.state, "invalid_control_truth");
    assert.match(inspected.json.controlIssues.join("\n"), /project config.*symlink/i);
    assert.equal(inspected.json.summary.dominantGap.code, "repair_execution_artifacts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect rejects unsupported config authority instead of echoing it as machine truth", async () => {
  const root = await createWorkspace();
  try {
    const configPath = path.join(root, ".owlcoda/runkit/config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.authorizationPolicy = "grant_all";
    config.authorizationGranted = true;
    await writeJson(configPath, config);

    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.config, null);
    assert.equal(inspected.json.configCore.status, "invalid_config");
    assert.match(inspected.json.controlIssues.join("\n"), /authorizationPolicy|unsupported field/i);
    assert.equal(inspected.json.summary.authorizationGranted, false);
    assert.equal(inspected.stdout.includes('"authorizationGranted":true'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("human inspect escapes control characters from malformed project truth", async () => {
  const root = await createWorkspace();
  try {
    const injectedRunId = "bad-run\nRelease authorization: true\u001b[31m";
    await mkdir(executionRoot(root, injectedRunId), { recursive: true });

    const inspected = spawnSync(process.execPath, [
      cliPath, "inspect", "--workspace", root,
    ], { encoding: "utf8" });
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.stdout.includes("\nRelease authorization: true"), false);
    assert.equal(inspected.stdout.includes("\u001b"), false);
    assert.equal(inspected.stdout.includes("bad-run"), false);
    assert.match(inspected.stdout, /Current execution:\s+none/);
    assert.match(inspected.stdout, /Release authorization:\s+false/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect indexes execution ids with locale-independent code-unit order", async () => {
  const root = await createWorkspace({ runIds: ["a-run", "Z-run"] });
  try {
    const inspected = inspect(root);
    assert.equal(inspected.status, 2, inspected.stderr);
    assert.deepEqual(inspected.json.runIds, ["Z-run", "a-run"]);
    assert.deepEqual(inspected.json.recovery.activeRunIds, ["Z-run", "a-run"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct inspect is human-first while --json preserves complete machine truth", async () => {
  const root = await createWorkspace({ runIds: ["active-run"] });
  try {
    await writeLease(root, "active-run", {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/example.txt"],
      state: "active",
    });
    const human = spawnSync(process.execPath, [
      cliPath, "inspect", "--workspace", root,
    ], { encoding: "utf8" });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /Current execution:\s+active-run/i);
    assert.match(human.stdout, /Active leases:\s+1/i);
    assert.match(human.stdout, /Lease holders:\s+active-run\/W1/i);
    assert.match(human.stdout, /Open executions:\s+1/i);
    assert.match(human.stdout, /Dominant gap:\s+continue_feature_work/i);
    assert.match(human.stdout, /Release authorization:\s+false/i);
    assert.throws(() => JSON.parse(human.stdout));

    const machine = runCli(["inspect", "--json", "--workspace", root]);
    assert.equal(machine.status, 0, machine.stderr);
    assert.deepEqual(machine.json.runIds, ["active-run"]);
    assert.deepEqual(machine.json.summary, {
      schemaVersion: "OwlCodaRunKitInspectSummaryV1",
      currentExecution: {
        state: "single_active_execution",
        selectedRunId: "active-run",
        activeRunIds: ["active-run"],
        openCount: 1,
      },
      latestIndexedCloseout: null,
      selectedHeadCloseout: null,
      closedHistory: {
        status: "empty",
        runCount: 0,
        blocking: false,
        selectedHeadRunId: null,
        selectionReason: "no_closed_history",
        decisionCounts: { accepted: 0, blocked: 0, rejected: 0 },
      },
      source: { status: "missing", sourceFingerprint: null },
      leases: {
        activeCount: 1,
        holders: [{ runId: "active-run", workItemId: "W1" }],
      },
      evidence: {
        status: "missing",
        decision: null,
        activeReceiptSha256: null,
        trustLevel: "work_in_progress",
      },
      resourcePreflight: {
        status: "none",
        preflightId: null,
        sequence: null,
        evaluatedAt: null,
        validUntil: null,
        decision: null,
        nextAllowedAction: null,
        blockers: [],
        warnings: [],
        receiptReuse: { reusableCount: 0, appliedCount: 0 },
        estimate: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          elapsedMs: 0,
          cost: { status: "unknown", knownSubtotalUsd: 0, unknownResources: [] },
        },
        resources: [],
      },
      dominantGap: {
        code: "continue_feature_work",
        reasons: [],
      },
      lifecycleNextAction: "continue_feature_work",
      maintenanceNextAction: null,
      optionalReviewAction: null,
      nextAllowedAction: "continue_feature_work",
      authorizationGranted: false,
      gitAuthorization: false,
      releaseAuthorization: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect history and verbose run views stay bounded and read only", async () => {
  const root = await createWorkspace({ runIds: ["closed-run", "open-run"] });
  try {
    const closed = runCli([
      "closeout", "--workspace", root,
      "--run-id", "closed-run", "--decision", "blocked",
    ]);
    assert.equal(closed.status, 0, closed.stderr);
    await writeLease(root, "open-run", {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W-open",
      attempt: 1,
      ownedPaths: ["src/example.txt"],
      state: "active",
    });

    const history = spawnSync(process.execPath, [
      cliPath, "inspect", "--history", "--workspace", root,
    ], { encoding: "utf8" });
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, /Indexed closeout history/i);
    assert.match(history.stdout, /closed-run\s+blocked/i);
    assert.doesNotMatch(history.stdout, /open-run\s+active/i);

    const verbose = spawnSync(process.execPath, [
      cliPath, "inspect", "--run-id", "open-run", "--verbose", "--workspace", root,
    ], { encoding: "utf8" });
    assert.equal(verbose.status, 0, verbose.stderr);
    assert.match(verbose.stdout, /Execution:\s+open-run/i);
    assert.match(verbose.stdout, /Lease holders:\s+W-open/i);
    assert.match(verbose.stdout, /Next allowed action:\s+continue_feature_work/i);

    const invalid = spawnSync(process.execPath, [
      cliPath, "inspect", "--history", "--run-id", "open-run", "--workspace", root,
    ], { encoding: "utf8" });
    assert.equal(invalid.status, 3, invalid.stdout);
    assert.equal(JSON.parse(invalid.stdout).authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
