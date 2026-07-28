import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalSourceFingerprint } from "../../scripts/runkit-contract/source-fingerprint.mjs";

const cliPath = fileURLToPath(new URL("../../scripts/runkit-contract/runkit-cli.mjs", import.meta.url));
const sourceFingerprintPath = fileURLToPath(new URL("../../scripts/runkit-contract/source-fingerprint.mjs", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function run(executable, args, options = {}) {
  return spawnSync(executable, args, { encoding: "utf8", ...options });
}

function runCli(args) {
  const completed = run(process.execPath, [cliPath, ...args]);
  return { ...completed, json: completed.stdout ? JSON.parse(completed.stdout) : null };
}

function git(root, args) {
  const completed = run("git", ["-C", root, ...args]);
  assert.equal(completed.status, 0, completed.stderr);
  return completed.stdout.trim();
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

async function plannedWorkspace(prefix = "owlcoda-runkit-provenance-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
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
  assert.equal(runCli([
    "plan", "--workspace", root,
    "--run-id", "provenance-fixture",
    "--goal", goalPath,
  ]).status, 0);
  await writeJson(
    path.join(root, ".owlcoda/runkit/executions/provenance-fixture/leases/W1.json"),
    {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/example.txt"],
      state: "active",
    },
  );
  await writeFile(path.join(root, "src/example.txt"), "candidate\n");
  const hash = sha256(await readFile(path.join(root, "src/example.txt")));
  const files = { "src/example.txt": hash };
  const packetPath = path.join(
    root,
    ".owlcoda/runkit/executions/provenance-fixture/delivery-packets/delivery.json",
  );
  await writeJson(packetPath, {
    schemaVersion: "ExecutionDeliveryPacketV1",
    runId: "provenance-fixture",
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
  return { root, packetPath };
}

function snapshotRequest(root, overrides = {}) {
  return {
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
    ...overrides,
  };
}

test("snapshot records exact replayable command and stable project truth", async () => {
  const { root } = await plannedWorkspace();
  try {
    const requestPath = path.join(root, "snapshot-request.json");
    await writeJson(requestPath, snapshotRequest(root));

    const completed = runCli([
      "snapshot", "--workspace", root,
      "--run-id", "provenance-fixture",
      "--request", requestPath,
    ]);

    assert.equal(completed.status, 0, completed.stderr);
    assert.equal(completed.json.status, "snapshot_passed");
    const snapshot = JSON.parse(await readFile(path.join(root, completed.json.snapshotPath), "utf8"));
    assert.equal(snapshot.schemaVersion, "OwlCodaRunKitSnapshotV1");
    assert.deepEqual(snapshot.command.evidence.argv, [
      process.execPath,
      "-e",
      "process.stdout.write('verified\\n')",
    ]);
    assert.equal(snapshot.command.exitCode, 0);
    assert.equal(snapshot.command.stdoutLineCount, 1);
    assert.equal(snapshot.repositoryBefore.manifestFingerprint,
      snapshot.repositoryAfter.manifestFingerprint);
    assert.equal(snapshot.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot rejects incomplete command/context data and raw environment values", async () => {
  const { root } = await plannedWorkspace();
  try {
    for (const [name, request, pattern] of [
      ["invalid-argv", snapshotRequest(root, { argv: [null] }), /exact.*argv/i],
      ["missing-context", snapshotRequest(root, { verificationContext: null }), /verification context/i],
      ["raw-env", { ...snapshotRequest(root), environmentValues: { TOKEN: "secret" } }, /unsupported field/i],
    ]) {
      const requestPath = path.join(root, `${name}.json`);
      await writeJson(requestPath, request);
      const completed = runCli([
        "snapshot", "--workspace", root,
        "--run-id", "provenance-fixture",
        "--request", requestPath,
      ]);
      assert.equal(completed.status, 3, completed.stderr);
      assert.match(completed.json.issues.join("\n"), pattern);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("foreign snapshot proves zero write and reports target drift", async () => {
  const controller = await plannedWorkspace("owlcoda-runkit-controller-");
  const foreign = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-foreign-"));
  try {
    git(foreign, ["init", "-q"]);
    git(foreign, ["config", "user.email", "runkit@example.invalid"]);
    git(foreign, ["config", "user.name", "RunKit Test"]);
    await writeFile(path.join(foreign, "data.txt"), "foreign\n");
    git(foreign, ["add", "data.txt"]);
    git(foreign, ["commit", "-qm", "foreign baseline"]);
    const before = git(foreign, ["status", "--porcelain=v1"]);
    const requestPath = path.join(controller.root, "foreign-snapshot.json");
    await writeJson(requestPath, snapshotRequest(controller.root, {
      snapshotId: "foreign-read",
      mode: "foreign_readonly",
      targetRoot: foreign,
      executable: process.execPath,
      argv: ["-e", "process.stdout.write(require('fs').readFileSync('data.txt'))"],
      selectedPaths: ["data.txt"],
    }));
    const passing = runCli([
      "snapshot", "--workspace", controller.root,
      "--run-id", "provenance-fixture",
      "--request", requestPath,
    ]);
    assert.equal(passing.status, 0, passing.stderr);
    assert.equal(git(foreign, ["status", "--porcelain=v1"]), before);

    const driftingPath = path.join(controller.root, "foreign-drift.json");
    await writeJson(driftingPath, snapshotRequest(controller.root, {
      snapshotId: "foreign-drift",
      mode: "foreign_readonly",
      targetRoot: foreign,
      executable: process.execPath,
      argv: ["-e", "require('fs').appendFileSync('data.txt', 'changed\\n')"],
      selectedPaths: ["data.txt"],
    }));
    const drifting = runCli([
      "snapshot", "--workspace", controller.root,
      "--run-id", "provenance-fixture",
      "--request", driftingPath,
    ]);
    assert.equal(drifting.status, 2, drifting.stderr);
    assert.equal(drifting.json.status, "invalidated_by_target_write");
  } finally {
    await rm(controller.root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});

test("finalize and ready-for-commit produce the accepted authorization-free chain", async () => {
  const { root, packetPath } = await plannedWorkspace();
  try {
    const snapshotRequestPath = path.join(root, "snapshot-request.json");
    await writeJson(snapshotRequestPath, snapshotRequest(root));
    const snapped = runCli([
      "snapshot", "--workspace", root,
      "--run-id", "provenance-fixture",
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
      "--run-id", "provenance-fixture",
      "--request", finalizeRequestPath,
    ]);
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(finalized.json.status, "accepted_passed");

    const leasePath = path.join(root, ".owlcoda/runkit/executions/provenance-fixture/leases/W1.json");
    const lease = JSON.parse(await readFile(leasePath, "utf8"));
    await writeJson(leasePath, { ...lease, state: "released" });
    const closed = runCli([
      "closeout", "--workspace", root,
      "--run-id", "provenance-fixture",
      "--decision", "accepted",
      "--gate-input", path.join(root, finalized.json.gateInputPath),
    ]);
    assert.equal(closed.status, 0, closed.stderr);

    const rootRequestPath = path.join(root, "root-snapshot-request.json");
    await writeJson(rootRequestPath, snapshotRequest(root, { snapshotId: "candidate-root" }));
    const rootSnapshot = runCli([
      "snapshot", "--workspace", root,
      "--run-id", "provenance-fixture",
      "--request", rootRequestPath,
    ]);
    assert.equal(rootSnapshot.status, 0, rootSnapshot.stderr);

    const readyRequestPath = path.join(root, "ready-request.json");
    await writeJson(readyRequestPath, {
      schemaVersion: "OwlCodaRunKitReadyForCommitRequestV1",
      deliveryPacketPath: path.relative(root, packetPath),
      verificationGateInputPath: finalized.json.gateInputPath,
      roots: [{ role: "candidate", snapshotPath: rootSnapshot.json.snapshotPath }],
    });
    const ready = runCli([
      "ready-for-commit", "--workspace", root,
      "--run-id", "provenance-fixture",
      "--request", readyRequestPath,
    ]);

    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.json.status, "ready_for_commit");
    const receipt = JSON.parse(await readFile(path.join(root, ready.json.readyReceiptPath), "utf8"));
    assert.equal(receipt.authorizationGranted, false);
    assert.deepEqual(receipt.repositoryActions, {
      staged: false,
      committed: false,
      pushed: false,
      tagged: false,
      published: false,
      deployed: false,
    });
    assert.equal(receipt.roots[0].role, "candidate");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalize stops before command acceptance when the source packet is stale", async () => {
  const { root, packetPath } = await plannedWorkspace();
  try {
    const snapshotRequestPath = path.join(root, "snapshot-request.json");
    await writeJson(snapshotRequestPath, snapshotRequest(root));
    const snapped = runCli([
      "snapshot", "--workspace", root,
      "--run-id", "provenance-fixture",
      "--request", snapshotRequestPath,
    ]);
    assert.equal(snapped.status, 0, snapped.stderr);
    await writeFile(path.join(root, "src/example.txt"), "stale\n");
    const requestPath = path.join(root, "finalize-stale.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
      receiptId: "stale-001",
      deliveryPacketPath: path.relative(root, packetPath),
      verificationContext: verificationContext(),
      snapshotPaths: [snapped.json.snapshotPath],
    });

    const finalized = runCli([
      "finalize", "--workspace", root,
      "--run-id", "provenance-fixture",
      "--request", requestPath,
    ]);

    assert.equal(finalized.status, 2, finalized.stderr);
    assert.equal(finalized.json.status, "invalidated_by_concurrent_write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed CLI entry points execute through a symlinked or canonicalized path", async () => {
  const { root, packetPath } = await plannedWorkspace();
  const aliases = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-entry-alias-"));
  try {
    const cliAlias = path.join(aliases, "runkit-cli.mjs");
    const sourceAlias = path.join(aliases, "source-fingerprint.mjs");
    await symlink(cliPath, cliAlias);
    await symlink(sourceFingerprintPath, sourceAlias);

    const inspected = run(process.execPath, [cliAlias, "inspect", "--json", "--workspace", root]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).status, "inspected");

    const source = run(process.execPath, [
      sourceAlias,
      "--workspace", root,
      "--packet", packetPath,
    ]);
    assert.equal(source.status, 0, source.stderr);
    assert.equal(JSON.parse(source.stdout).status, "valid");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(aliases, { recursive: true, force: true });
  }
});
