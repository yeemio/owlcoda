import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCoreArtifact,
  currentCoreIdentity,
} from "../../scripts/runkit-contract/core-contract.mjs";
import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { canonicalSourceFingerprint } from "../../scripts/runkit-contract/source-fingerprint.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function setupFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-lease-delivery-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "notes"), { recursive: true });
  await writeFile(path.join(root, "src/a.txt"), "baseline a\n");
  await writeFile(path.join(root, "src/b.txt"), "baseline b\n");
  await writeFile(path.join(root, "notes/unrelated.md"), "baseline note\n");
  await writeJson(path.join(root, "goal.json"), { goal: "bounded delivery" });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=RunKit Test", "-c", "user.email=runkit@example.invalid", "commit", "-qm", "fixture");
  assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
  return root;
}

async function plan(root, runId) {
  const result = await runCli([
    "plan", "--workspace", root,
    "--run-id", runId,
    "--goal", path.join(root, "goal.json"),
  ]);
  assert.equal(result.status, "planned", JSON.stringify(result));
  return path.join(root, ".owlcoda/runkit/executions", runId);
}

async function acquire(root, runId, workItemId, ownedPaths) {
  const args = [
    "lease", "acquire",
    "--workspace", root,
    "--run-id", runId,
    "--work-item", workItemId,
  ];
  for (const ownedPath of ownedPaths) args.push("--owned-path", ownedPath);
  return runCli(args);
}

test("lease acquire, inspect, and release own the WorkerLease lifecycle without hand-authored JSON", async () => {
  const root = await setupFixture();
  try {
    const runId = "lease-lifecycle";
    const executionRoot = await plan(root, runId);
    const acquired = await acquire(root, runId, "W1", ["src/a.txt", "src/generated/**"]);
    assert.equal(acquired.status, "lease_acquired", JSON.stringify(acquired));
    assert.equal(acquired.authorizationGranted, false);
    const leasePath = path.join(root, acquired.leasePath);
    assert.deepEqual(JSON.parse(await readFile(leasePath, "utf8")), {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/a.txt", "src/generated/**"],
      state: "active",
    });

    const inspected = await runCli([
      "lease", "inspect", "--workspace", root, "--run-id", runId,
    ]);
    assert.equal(inspected.status, "leases_inspected");
    assert.deepEqual(inspected.leases, [{
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/a.txt", "src/generated/**"],
      state: "active",
      leasePath: path.relative(root, path.join(executionRoot, "leases/W1-attempt-001.json")),
    }]);
    assert.equal(inspected.authorizationGranted, false);

    const released = await runCli([
      "lease", "release",
      "--workspace", root,
      "--run-id", runId,
      "--work-item", "W1",
    ]);
    assert.equal(released.status, "lease_released", JSON.stringify(released));
    assert.equal(released.authorizationGranted, false);
    assert.equal(JSON.parse(await readFile(leasePath, "utf8")).state, "released");
    const duplicate = await runCli([
      "lease", "release",
      "--workspace", root,
      "--run-id", runId,
      "--work-item", "W1",
    ]);
    assert.equal(duplicate.status, "invalid_input");
    assert.match(duplicate.issues.join("\n"), /already released/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease acquire fails closed on active overlap, reserved runtime, and symlinked lease truth", async () => {
  const root = await setupFixture();
  const foreign = await mkdtemp(path.join(tmpdir(), "owlcoda-lease-foreign-"));
  try {
    const firstRoot = await plan(root, "lease-owner-a");
    await plan(root, "lease-owner-b");
    const controlLock = path.join(root, ".owlcoda/runkit/control.lock");
    await mkdir(controlLock);
    const locked = await acquire(root, "lease-owner-a", "W0", ["notes/**"]);
    assert.equal(locked.status, "invalid_input");
    assert.match(locked.issues.join("\n"), /control transaction/i);
    const lockedCloseout = await runCli([
      "closeout", "--workspace", root,
      "--run-id", "lease-owner-a", "--decision", "blocked",
    ]);
    assert.equal(lockedCloseout.status, "invalid_input");
    assert.match(lockedCloseout.issues.join("\n"), /control transaction/i);
    await assert.rejects(readFile(path.join(firstRoot, "closeout-receipt.json")));
    await rm(controlLock, { recursive: true });
    assert.equal((await acquire(root, "lease-owner-a", "W1", ["src/**"])).status, "lease_acquired");

    const foreignCloseout = path.join(foreign, "closeout.json");
    await writeJson(foreignCloseout, {});
    await symlink(foreignCloseout, path.join(firstRoot, "closeout-receipt.json"));
    const overlap = await acquire(root, "lease-owner-b", "W2", ["src/a.txt"]);
    assert.equal(overlap.status, "invalid_input");
    assert.match(overlap.issues.join("\n"), /overlap.*lease-owner-a.*W1/i);

    const reserved = await acquire(root, "lease-owner-b", "W3", [".owlcoda/runkit/**"]);
    assert.equal(reserved.status, "invalid_input");
    assert.match(reserved.issues.join("\n"), /reserved runtime/i);

    const unsupportedWildcard = await acquire(root, "lease-owner-b", "W4", ["src/*.txt"]);
    assert.equal(unsupportedWildcard.status, "invalid_input");
    assert.match(unsupportedWildcard.issues.join("\n"), /unsupported wildcard/i);

    const foreignLease = path.join(foreign, "lease.json");
    await writeJson(foreignLease, {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "foreign",
      attempt: 1,
      ownedPaths: ["notes/**"],
      state: "active",
    });
    await symlink(foreignLease, path.join(firstRoot, "leases/symlink.json"));
    const inspected = await runCli([
      "lease", "inspect", "--workspace", root, "--run-id", "lease-owner-a",
    ]);
    assert.equal(inspected.status, "invalid_input");
    assert.match(inspected.issues.join("\n"), /symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});

test("a trusted closed execution no longer reserves paths through its preserved active lease", async () => {
  const root = await setupFixture();
  try {
    await plan(root, "closed-lease-owner");
    await plan(root, "next-lease-owner");
    assert.equal(
      (await acquire(root, "closed-lease-owner", "W1", ["src/**"])).status,
      "lease_acquired",
    );
    const closed = await runCli([
      "closeout", "--workspace", root,
      "--run-id", "closed-lease-owner", "--decision", "blocked",
    ]);
    assert.equal(closed.status, "closed", JSON.stringify(closed));

    const acquired = await acquire(root, "next-lease-owner", "W2", ["src/a.txt"]);
    assert.equal(acquired.status, "lease_acquired", JSON.stringify(acquired));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an accepted closeout that inspect rejects cannot hide an active lease", async () => {
  const root = await setupFixture();
  try {
    const ownerRoot = await plan(root, "invalid-accepted-owner");
    await plan(root, "invalid-accepted-next");
    assert.equal(
      (await acquire(root, "invalid-accepted-owner", "W1", ["src/**"])).status,
      "lease_acquired",
    );
    const forged = createCoreArtifact({
      core: currentCoreIdentity(),
      producer: { adapterKind: "codex", adapterVersion: "0.1.0" },
      payload: {
        runId: "invalid-accepted-owner",
        decision: "accepted",
        authorizationGranted: false,
      },
      extensions: { "dev.owlcoda.adapter.codex": {} },
    });
    await writeJson(path.join(ownerRoot, "closeout-receipt.json"), forged);
    const inspected = await runCli(["inspect", "--workspace", root]);
    const owner = inspected.executions.find(item => item.runId === "invalid-accepted-owner");
    assert.equal(owner.closeout.status, "invalid");
    assert.match(owner.closeout.issues.join("\n"), /complete verification evidence/i);

    const acquired = await acquire(root, "invalid-accepted-next", "W2", ["src/a.txt"]);
    assert.equal(acquired.status, "invalid_input", JSON.stringify(acquired));
    assert.match(acquired.issues.join("\n"), /overlap.*invalid-accepted-owner.*W1/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease and delivery failures keep authorization false when the execution pin is stale", async () => {
  const root = await setupFixture();
  try {
    const runId = "stale-lease-delivery";
    const executionRoot = await plan(root, runId);
    assert.equal((await acquire(root, runId, "W1", ["src/**"])).status, "lease_acquired");
    await writeFile(path.join(root, "src/a.txt"), "candidate\n");
    const pinPath = path.join(executionRoot, "engine-pin.json");
    const stalePin = JSON.parse(await readFile(pinPath, "utf8"));
    stalePin.coreVersion = "stale-test-core";
    await writeJson(pinPath, stalePin);

    const results = [
      await acquire(root, runId, "W2", ["notes/**"]),
      await runCli(["lease", "inspect", "--workspace", root, "--run-id", runId]),
      await runCli([
        "lease", "release", "--workspace", root,
        "--run-id", runId, "--work-item", "W1",
      ]),
      await runCli([
        "delivery", "create", "--workspace", root,
        "--run-id", runId, "--from-lease", "W1", "--packet-id", "stale",
      ]),
      await runCli(["lease", "acquire", "--workspace", root, "--run-id", runId]),
    ];
    for (const result of results) assert.equal(result.authorizationGranted, false, JSON.stringify(result));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery create derives a bounded fresh packet from an active lease", async () => {
  const root = await setupFixture();
  try {
    const runId = "delivery-create";
    const executionRoot = await plan(root, runId);
    assert.equal((await acquire(root, runId, "W1", ["src/**"])).status, "lease_acquired");
    await writeFile(path.join(root, "src/a.txt"), "candidate a\n");
    await writeFile(path.join(root, "src/new.txt"), "candidate new\n");
    await writeFile(path.join(root, "src/space name.txt"), "candidate spaced path\n");
    await writeFile(path.join(root, "notes/unrelated.md"), "parallel note\n");

    const created = await runCli([
      "delivery", "create",
      "--workspace", root,
      "--run-id", runId,
      "--from-lease", "W1",
      "--packet-id", "candidate-001",
    ]);
    assert.equal(created.status, "delivery_packet_created", JSON.stringify(created));
    assert.equal(created.authorizationGranted, false);
    const packet = JSON.parse(await readFile(path.join(root, created.deliveryPacketPath), "utf8"));
    const files = {
      "src/a.txt": sha256(await readFile(path.join(root, "src/a.txt"))),
      "src/new.txt": sha256(await readFile(path.join(root, "src/new.txt"))),
      "src/space name.txt": sha256(await readFile(path.join(root, "src/space name.txt"))),
    };
    assert.deepEqual(packet.changedFiles.wholeFileSha256, files);
    assert.equal(packet.sourceFingerprint.sha256, canonicalSourceFingerprint(files));
    assert.deepEqual(packet.baseline, {
      branch: git(root, "branch", "--show-current"),
      head: git(root, "rev-parse", "HEAD"),
    });
    assert.deepEqual(packet.core, currentCoreIdentity());
    assert.deepEqual(packet.discovery, {
      fromLease: "W1",
      leasePath: path.relative(root, path.join(executionRoot, "leases/W1-attempt-001.json")),
      unrelatedDirtyPaths: ["notes/unrelated.md"],
      deletedOwnedPaths: [],
      renamedOwnedPaths: [],
    });
    assert.deepEqual(packet.repositoryActions, {
      worktreeCreated: false,
      branchCreated: false,
      staged: false,
      committed: false,
      pushed: false,
      tagged: false,
      published: false,
      deployed: false,
    });
    assert.equal(packet.authorizationGranted, false);
    assert.equal(packet.status, "ready_for_stage_verification");

    const duplicate = await runCli([
      "delivery", "create",
      "--workspace", root,
      "--run-id", runId,
      "--from-lease", "W1",
      "--packet-id", "candidate-001",
    ]);
    assert.equal(duplicate.status, "invalid_input");
    assert.match(duplicate.issues.join("\n"), /already exists/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("delivery create fails closed on released lease, deletion, symlink, and empty candidate", async () => {
  const releasedRoot = await setupFixture();
  try {
    const runId = "released-delivery";
    await plan(releasedRoot, runId);
    await acquire(releasedRoot, runId, "W1", ["src/**"]);
    await writeFile(path.join(releasedRoot, "src/a.txt"), "candidate\n");
    await runCli([
      "lease", "release", "--workspace", releasedRoot,
      "--run-id", runId, "--work-item", "W1",
    ]);
    const result = await runCli([
      "delivery", "create", "--workspace", releasedRoot,
      "--run-id", runId, "--from-lease", "W1", "--packet-id", "released",
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /active lease/i);
  } finally {
    await rm(releasedRoot, { recursive: true, force: true });
  }

  const deletedRoot = await setupFixture();
  try {
    const runId = "deleted-delivery";
    await plan(deletedRoot, runId);
    await acquire(deletedRoot, runId, "W1", ["src/**"]);
    await unlink(path.join(deletedRoot, "src/a.txt"));
    const result = await runCli([
      "delivery", "create", "--workspace", deletedRoot,
      "--run-id", runId, "--from-lease", "W1", "--packet-id", "deleted",
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /deleted owned paths.*src\/a\.txt/i);
  } finally {
    await rm(deletedRoot, { recursive: true, force: true });
  }

  const symlinkRoot = await setupFixture();
  try {
    const runId = "symlink-delivery";
    await plan(symlinkRoot, runId);
    await acquire(symlinkRoot, runId, "W1", ["src/**"]);
    await symlink(path.join(symlinkRoot, "notes/unrelated.md"), path.join(symlinkRoot, "src/link.txt"));
    const result = await runCli([
      "delivery", "create", "--workspace", symlinkRoot,
      "--run-id", runId, "--from-lease", "W1", "--packet-id", "symlink",
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /symlink.*src\/link\.txt/i);
  } finally {
    await rm(symlinkRoot, { recursive: true, force: true });
  }

  const emptyRoot = await setupFixture();
  try {
    const runId = "empty-delivery";
    await plan(emptyRoot, runId);
    await acquire(emptyRoot, runId, "W1", ["src/**"]);
    const result = await runCli([
      "delivery", "create", "--workspace", emptyRoot,
      "--run-id", runId, "--from-lease", "W1", "--packet-id", "empty",
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /no changed regular files/i);
    assert.deepEqual(await readdir(path.join(
      emptyRoot,
      ".owlcoda/runkit/executions",
      runId,
      "delivery-packets",
    )), []);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
  }

  const outputSymlinkRoot = await setupFixture();
  const foreignOutput = await mkdtemp(path.join(tmpdir(), "owlcoda-delivery-foreign-"));
  try {
    const runId = "output-symlink-delivery";
    const executionRoot = await plan(outputSymlinkRoot, runId);
    await acquire(outputSymlinkRoot, runId, "W1", ["src/**"]);
    await writeFile(path.join(outputSymlinkRoot, "src/a.txt"), "candidate\n");
    await rm(path.join(executionRoot, "delivery-packets"), { recursive: true });
    await symlink(foreignOutput, path.join(executionRoot, "delivery-packets"));
    const result = await runCli([
      "delivery", "create", "--workspace", outputSymlinkRoot,
      "--run-id", runId, "--from-lease", "W1", "--packet-id", "escape",
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /delivery packet directory.*symlink/i);
    assert.deepEqual(await readdir(foreignOutput), []);
  } finally {
    await rm(outputSymlinkRoot, { recursive: true, force: true });
    await rm(foreignOutput, { recursive: true, force: true });
  }
});
