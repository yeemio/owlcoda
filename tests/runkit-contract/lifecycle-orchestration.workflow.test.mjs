import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { receiptSha256 } from "../../scripts/runkit-contract/receipt-lineage.mjs";
import {
  canonicalSourceFingerprint,
  verifyDeliveryPacket,
} from "../../scripts/runkit-contract/source-fingerprint.mjs";
import { validateVerificationReceiptGate } from "../../scripts/runkit-contract/verification-receipt-gate.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function setupFixture(prefix = "owlcoda-lifecycle-") {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/example.txt"), "baseline\n");
  await writeFile(path.join(root, "package-lock.json"), "fixture-lock\n");
  await writeJson(path.join(root, "goal.json"), { goal: "high-level lifecycle" });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(root, "-c", "user.name=RunKit Test", "-c", "user.email=runkit@example.invalid", "commit", "-qm", "fixture");
  assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
  await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: [{ id: "fixture-stage", paths: ["src/**"] }],
  });
  return root;
}

async function start(root, runId, workItem = "W1", ownedPath = "src/**") {
  return runCli([
    "start", "--workspace", root,
    "--run-id", runId,
    "--goal", path.join(root, "goal.json"),
    "--work-item", workItem,
    "--owned-path", ownedPath,
  ]);
}

async function verify(root, runId, verificationId, source, exitCode = 0) {
  return runCli([
    "verify", "--workspace", root,
    "--run-id", runId,
    "--from-lease", "W1",
    "--verification-id", verificationId,
    "--cwd", ".",
    "--",
    process.execPath,
    "-e",
    `${source};process.exit(${exitCode})`,
  ]);
}

async function waitForPath(filePath, childCompletion = null) {
  let earlyCompletion = null;
  childCompletion?.then((completed) => { earlyCompletion = completed; });
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      await access(filePath);
      return;
    } catch {
      if (earlyCompletion) {
        throw new Error(`Child exited before ${filePath}: ${earlyCompletion.stderr || earlyCompletion.stdout}`);
      }
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function completedChild(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { exitCode, stdout, stderr };
}

test("CLI option values may begin with a double hyphen", async () => {
  const root = await setupFixture();
  try {
    const started = await start(root, "double-hyphen-owned-path", "W1", "--fixture");
    assert.equal(started.status, "started");
    assert.equal(started.exitCode, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start composes plan and lease acquisition and rolls back an overlapping start", async () => {
  const root = await setupFixture();
  try {
    const started = await start(root, "start-owner");
    assert.equal(started.status, "started", JSON.stringify(started));
    assert.equal(started.authorizationGranted, false);
    const lease = JSON.parse(await readFile(path.join(root, started.leasePath), "utf8"));
    assert.equal(lease.state, "active");
    assert.deepEqual(lease.ownedPaths, ["src/**"]);

    const conflict = await start(root, "start-conflict", "W2", "src/example.txt");
    assert.equal(conflict.status, "invalid_input", JSON.stringify(conflict));
    assert.equal(conflict.authorizationGranted, false);
    assert.match(conflict.issues.join("\n"), /overlap.*start-owner.*W1/i);
    await assert.rejects(access(path.join(root, ".owlcoda/runkit/executions/start-conflict")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify derives requests from project truth and preserves exact argv through an accepted receipt", async () => {
  const root = await setupFixture();
  try {
    assert.equal((await start(root, "verify-pass")).status, "started");
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const source = "process.stdout.write('verified\\n')";
    const result = await verify(root, "verify-pass", "attempt-001", source);
    assert.equal(result.status, "verified", JSON.stringify(result));
    assert.equal(result.gateDecision, "accepted_passed");
    assert.equal(result.authorizationGranted, false);

    const snapshotRequest = JSON.parse(await readFile(path.join(root, result.snapshotRequestPath), "utf8"));
    assert.equal(snapshotRequest.executable, process.execPath);
    assert.deepEqual(snapshotRequest.argv, ["-e", `${source};process.exit(0)`]);
    assert.deepEqual(snapshotRequest.selectedPaths, ["src/example.txt"]);
    assert.equal(snapshotRequest.verificationContext.platform.arch, process.arch);
    assert.equal(snapshotRequest.verificationContext.toolchains.some(item => item.name === "git"), true);
    assert.equal(snapshotRequest.verificationContext.toolchains.some(item => item.name === "node"), true);
    assert.deepEqual(snapshotRequest.verificationContext.lockfiles.map(item => item.path), ["package-lock.json"]);

    const finalizeRequest = JSON.parse(await readFile(path.join(root, result.finalizeRequestPath), "utf8"));
    assert.equal(finalizeRequest.receiptId, "attempt-001-receipt");
    assert.deepEqual(finalizeRequest.snapshotPaths, [result.snapshotPath]);
    const receipt = JSON.parse(await readFile(path.join(root, result.receiptPath), "utf8"));
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.commandReceipts[0].evidence.argv[0], process.execPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify preserves zero-argument commands and empty-string argv entries", async () => {
  const noArgRoot = await setupFixture("owlcoda-verify-no-argv-");
  try {
    assert.equal((await start(noArgRoot, "verify-no-argv")).status, "started");
    await writeFile(path.join(noArgRoot, "src/example.txt"), "candidate\n");
    const result = await runCli([
      "verify", "--workspace", noArgRoot,
      "--run-id", "verify-no-argv",
      "--from-lease", "W1",
      "--verification-id", "attempt-001",
      "--cwd", ".",
      "--",
      "/usr/bin/true",
    ]);
    assert.equal(result.status, "verified", JSON.stringify(result));
    const request = JSON.parse(await readFile(path.join(noArgRoot, result.snapshotRequestPath), "utf8"));
    assert.deepEqual(request.argv, []);
  } finally {
    await rm(noArgRoot, { recursive: true, force: true });
  }

  const emptyArgRoot = await setupFixture("owlcoda-verify-empty-argv-");
  try {
    assert.equal((await start(emptyArgRoot, "verify-empty-argv")).status, "started");
    await writeFile(path.join(emptyArgRoot, "src/example.txt"), "candidate\n");
    const result = await runCli([
      "verify", "--workspace", emptyArgRoot,
      "--run-id", "verify-empty-argv",
      "--from-lease", "W1",
      "--verification-id", "attempt-001",
      "--cwd", ".",
      "--",
      process.execPath,
      "-e",
      "if (process.argv[1] !== '') process.exit(7)",
      "",
    ]);
    assert.equal(result.status, "verified", JSON.stringify(result));
    const request = JSON.parse(await readFile(path.join(emptyArgRoot, result.snapshotRequestPath), "utf8"));
    assert.equal(request.argv.at(-1), "");
  } finally {
    await rm(emptyArgRoot, { recursive: true, force: true });
  }
});

test("verify preserves failed evidence and never finalizes a failed command", async () => {
  const root = await setupFixture();
  try {
    assert.equal((await start(root, "verify-fail")).status, "started");
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const result = await verify(root, "verify-fail", "attempt-fail", "process.stderr.write('boom\\n')", 7);
    assert.equal(result.status, "verification_failed", JSON.stringify(result));
    assert.equal(result.commandExitCode, 7);
    assert.equal(result.authorizationGranted, false);
    const snapshot = JSON.parse(await readFile(path.join(root, result.snapshotPath), "utf8"));
    assert.equal(snapshot.status, "snapshot_failed");
    assert.equal(snapshot.command.exitCode, 7);
    await assert.rejects(access(path.join(
      root,
      ".owlcoda/runkit/executions/verify-fail/verification-receipts/receipt-lineage.json",
    )));
    assert.equal("finalizeRequestPath" in result, false);

    const retry = await verify(root, "verify-fail", "attempt-retry", "process.stdout.write('fixed\\n')");
    assert.equal(retry.status, "verified", JSON.stringify(retry));
    assert.equal(retry.deliveryPacketPath, result.deliveryPacketPath);
    const finished = await runCli([
      "finish", "--workspace", root,
      "--run-id", "verify-fail", "--decision", "accepted",
    ]);
    assert.equal(finished.status, "finished", JSON.stringify(finished));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verify preserves a non-accepted finalize result with its request binding", async () => {
  const root = await setupFixture("owlcoda-finalize-attempt-");
  try {
    assert.equal((await start(root, "finalize-attempt", "W1", "uncovered/**")).status, "started");
    await mkdir(path.join(root, "uncovered"), { recursive: true });
    await writeFile(path.join(root, "uncovered/example.txt"), "candidate\n");
    const result = await verify(
      root,
      "finalize-attempt",
      "attempt-full-profile",
      "process.stdout.write('snapshot passed\\n')",
    );
    assert.equal(result.status, "full_profile_required", JSON.stringify(result));
    const artifactPath = path.join(
      root,
      ".owlcoda/runkit/executions/finalize-attempt",
      "verification-requests/attempt-full-profile/finalize-result.json",
    );
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    assert.equal(
      artifact.schemaVersion,
      "OwlCodaRunKitVerificationFinalizeAttemptV1",
    );
    assert.equal(artifact.runId, "finalize-attempt");
    assert.equal(artifact.verificationId, "attempt-full-profile");
    assert.equal(artifact.status, "rejected");
    assert.equal(artifact.gateStatus, "full_profile_required");
    assert.equal(artifact.result.profileImpact.decision, "full_profile_required");
    assert.match(
      artifact.finalizeRequestPath,
      /verification-requests\/attempt-full-profile\/finalize-request\.json$/,
    );
    assert.match(artifact.finalizeRequestSha256, /^[a-f0-9]{64}$/);
    assert.equal(artifact.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finish derives the accepted gate, releases leases, and supports honest blocked closeout", async () => {
  const acceptedRoot = await setupFixture("owlcoda-finish-accepted-");
  try {
    assert.equal((await start(acceptedRoot, "finish-accepted")).status, "started");
    const missingGate = await runCli([
      "finish", "--workspace", acceptedRoot,
      "--run-id", "finish-accepted", "--decision", "accepted",
    ]);
    assert.equal(missingGate.status, "invalid_input");
    assert.match(missingGate.issues.join("\n"), /active verification gate/i);
    const activeLeasePath = path.join(
      acceptedRoot,
      ".owlcoda/runkit/executions/finish-accepted/leases/W1-attempt-001.json",
    );
    assert.equal(JSON.parse(await readFile(activeLeasePath, "utf8")).state, "active");

    await writeFile(path.join(acceptedRoot, "src/example.txt"), "candidate\n");
    const verified = await verify(
      acceptedRoot,
      "finish-accepted",
      "attempt-001",
      "process.stdout.write('ok\\n')",
    );
    assert.equal(verified.status, "verified");
    const gateInputPath = path.join(acceptedRoot, verified.gateInputPath);
    const gateInput = JSON.parse(await readFile(gateInputPath, "utf8"));
    await writeJson(gateInputPath, { ...gateInput, contractVersion: "0.1" });
    const legacyGateFinish = await runCli([
      "finish", "--workspace", acceptedRoot,
      "--run-id", "finish-accepted", "--decision", "accepted",
    ]);
    assert.equal(legacyGateFinish.status, "invalid_input", JSON.stringify(legacyGateFinish));
    assert.match(legacyGateFinish.issues.join("\n"), /Contract v0\.2/i);
    assert.equal(JSON.parse(await readFile(activeLeasePath, "utf8")).state, "active");
    await writeJson(gateInputPath, gateInput);
    await writeFile(path.join(acceptedRoot, "src/example.txt"), "drift after verification\n");
    const staleFinish = await runCli([
      "finish", "--workspace", acceptedRoot,
      "--run-id", "finish-accepted", "--decision", "accepted",
    ]);
    assert.equal(staleFinish.status, "invalid_input", JSON.stringify(staleFinish));
    assert.match(staleFinish.issues.join("\n"), /fresh delivery packet|source.*drift/i);
    assert.equal(JSON.parse(await readFile(activeLeasePath, "utf8")).state, "active");
    await writeFile(path.join(acceptedRoot, "src/example.txt"), "candidate\n");
    const snapshot = JSON.parse(await readFile(path.join(acceptedRoot, verified.snapshotPath), "utf8"));
    const stdoutPath = path.join(acceptedRoot, snapshot.command.stdoutPath);
    await writeFile(stdoutPath, "tampered\n");
    const tamperedFinish = await runCli([
      "finish", "--workspace", acceptedRoot,
      "--run-id", "finish-accepted", "--decision", "accepted",
    ]);
    assert.equal(tamperedFinish.status, "invalid_input", JSON.stringify(tamperedFinish));
    assert.match(tamperedFinish.issues.join("\n"), /snapshot evidence|hash mismatch/i);
    assert.equal(JSON.parse(await readFile(activeLeasePath, "utf8")).state, "active");
    await writeFile(stdoutPath, "ok\n");
    const finished = await runCli([
      "finish", "--workspace", acceptedRoot,
      "--run-id", "finish-accepted", "--decision", "accepted",
    ]);
    assert.equal(finished.status, "finished", JSON.stringify(finished));
    assert.equal(finished.decision, "accepted");
    assert.deepEqual(finished.releasedLeaseIds, ["W1"]);
    assert.equal(finished.authorizationGranted, false);
    assert.equal(JSON.parse(await readFile(activeLeasePath, "utf8")).state, "released");
    const closeout = JSON.parse(await readFile(path.join(
      acceptedRoot,
      ".owlcoda/runkit/executions/finish-accepted/closeout-receipt.json",
    ), "utf8"));
    assert.equal(closeout.artifact.payload.decision, "accepted");
  } finally {
    await rm(acceptedRoot, { recursive: true, force: true });
  }

  const blockedRoot = await setupFixture("owlcoda-finish-blocked-");
  try {
    assert.equal((await start(blockedRoot, "finish-blocked")).status, "started");
    const finished = await runCli([
      "finish", "--workspace", blockedRoot,
      "--run-id", "finish-blocked", "--decision", "blocked",
    ]);
    assert.equal(finished.status, "finished", JSON.stringify(finished));
    assert.equal(finished.decision, "blocked");
    assert.deepEqual(finished.releasedLeaseIds, ["W1"]);
    assert.equal(finished.authorizationGranted, false);
  } finally {
    await rm(blockedRoot, { recursive: true, force: true });
  }
});

test("high-level lifecycle rejects symlinked request and closeout control paths before mutating lease truth", async () => {
  const verifyRoot = await setupFixture("owlcoda-verify-symlink-");
  const foreign = await mkdtemp(path.join(tmpdir(), "owlcoda-lifecycle-foreign-"));
  try {
    assert.equal((await start(verifyRoot, "verify-symlink")).status, "started");
    await writeFile(path.join(verifyRoot, "src/example.txt"), "candidate\n");
    await symlink(
      foreign,
      path.join(verifyRoot, ".owlcoda/runkit/executions/verify-symlink/verification-requests"),
    );
    const result = await verify(verifyRoot, "verify-symlink", "attempt-001", "process.stdout.write('no\\n')");
    assert.equal(result.status, "invalid_input", JSON.stringify(result));
    assert.match(result.issues.join("\n"), /requests root.*symlink/i);
    await assert.rejects(access(path.join(foreign, "attempt-001")));
  } finally {
    await rm(verifyRoot, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }

  const finishRoot = await setupFixture("owlcoda-finish-symlink-");
  try {
    assert.equal((await start(finishRoot, "finish-symlink")).status, "started");
    const missingForeignTarget = path.join(tmpdir(), `missing-closeout-${path.basename(finishRoot)}.json`);
    await symlink(
      missingForeignTarget,
      path.join(finishRoot, ".owlcoda/runkit/executions/finish-symlink/closeout-receipt.json"),
    );
    const result = await runCli([
      "finish", "--workspace", finishRoot,
      "--run-id", "finish-symlink", "--decision", "blocked",
    ]);
    assert.equal(result.status, "invalid_input", JSON.stringify(result));
    assert.match(result.issues.join("\n"), /already closed|closeout.*symlink/i);
    const lease = JSON.parse(await readFile(path.join(
      finishRoot,
      ".owlcoda/runkit/executions/finish-symlink/leases/W1-attempt-001.json",
    ), "utf8"));
    assert.equal(lease.state, "active");
  } finally {
    await rm(finishRoot, { recursive: true, force: true });
  }
});

test("finish rolls released leases back when closeout persistence fails", async () => {
  const root = await setupFixture("owlcoda-finish-rollback-");
  const executionRoot = path.join(root, ".owlcoda/runkit/executions/finish-rollback");
  const leasePath = path.join(executionRoot, "leases/W1-attempt-001.json");
  try {
    assert.equal((await start(root, "finish-rollback")).status, "started");
    await chmod(executionRoot, 0o555);
    const result = await runCli([
      "finish", "--workspace", root,
      "--run-id", "finish-rollback", "--decision", "blocked",
    ]);
    assert.equal(result.status, "invalid_input", JSON.stringify(result));
    assert.equal(JSON.parse(await readFile(leasePath, "utf8")).state, "active");
    await assert.rejects(access(path.join(executionRoot, "closeout-receipt.json")));
  } finally {
    await chmod(executionRoot, 0o755).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("finish cannot race an in-flight high-level verify", async () => {
  const root = await setupFixture("owlcoda-verify-finish-race-");
  try {
    assert.equal((await start(root, "verify-finish-race")).status, "started");
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const cliPath = path.resolve("scripts/runkit-contract/runkit-cli.mjs");
    const child = spawn(process.execPath, [
      cliPath,
      "verify", "--workspace", root,
      "--run-id", "verify-finish-race",
      "--from-lease", "W1",
      "--verification-id", "attempt-race",
      "--cwd", ".",
      "--",
      process.execPath,
      "-e",
      "setTimeout(() => process.exit(0), 1000)",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const childCompletion = completedChild(child);
    await waitForPath(path.join(
      root,
      ".owlcoda/runkit/executions/verify-finish-race/verification-requests/attempt-race/snapshot-request.json",
    ), childCompletion);
    const racedFinish = await runCli([
      "finish", "--workspace", root,
      "--run-id", "verify-finish-race", "--decision", "blocked",
    ]);
    assert.equal(racedFinish.status, "invalid_input", JSON.stringify(racedFinish));
    assert.match(racedFinish.issues.join("\n"), /control transaction/i);
    assert.equal(JSON.parse(await readFile(path.join(
      root,
      ".owlcoda/runkit/executions/verify-finish-race/leases/W1-attempt-001.json",
    ), "utf8")).state, "active");
    await assert.rejects(access(path.join(
      root,
      ".owlcoda/runkit/executions/verify-finish-race/closeout-receipt.json",
    )));

    const completed = await childCompletion;
    assert.equal(completed.exitCode, 0, completed.stderr || completed.stdout);
    assert.equal(JSON.parse(completed.stdout).status, "verified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted finish rejects verification truth routed through a foreign symlink", async () => {
  const root = await setupFixture("owlcoda-finish-foreign-gate-");
  const foreign = await mkdtemp(path.join(tmpdir(), "owlcoda-foreign-gate-"));
  const executionRoot = path.join(root, ".owlcoda/runkit/executions/finish-foreign-gate");
  const receiptsRoot = path.join(executionRoot, "verification-receipts");
  const foreignReceipts = path.join(foreign, "verification-receipts");
  try {
    assert.equal((await start(root, "finish-foreign-gate")).status, "started");
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    assert.equal((await verify(
      root,
      "finish-foreign-gate",
      "attempt-001",
      "process.stdout.write('ok\\n')",
    )).status, "verified");
    await rename(receiptsRoot, foreignReceipts);
    await symlink(foreignReceipts, receiptsRoot);
    const result = await runCli([
      "finish", "--workspace", root,
      "--run-id", "finish-foreign-gate", "--decision", "accepted",
    ]);
    assert.equal(result.status, "invalid_input", JSON.stringify(result));
    assert.match(result.issues.join("\n"), /verification receipts.*symlink|regular directory/i);
    assert.equal(JSON.parse(await readFile(path.join(
      executionRoot,
      "leases/W1-attempt-001.json",
    ), "utf8")).state, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});

test("accepted finish cannot relabel an old snapshot with a fresh delivery fingerprint", async () => {
  const root = await setupFixture("owlcoda-finish-source-binding-");
  const runId = "finish-source-binding";
  try {
    assert.equal((await start(root, runId)).status, "started");
    await writeFile(path.join(root, "src/example.txt"), "candidate A\n");
    const verified = await verify(root, runId, "attempt-001", "process.stdout.write('A\\n')");
    assert.equal(verified.status, "verified", JSON.stringify(verified));

    const sourceB = "candidate B\n";
    await writeFile(path.join(root, "src/example.txt"), sourceB);
    const packetPath = path.join(root, verified.deliveryPacketPath);
    const packet = JSON.parse(await readFile(packetPath, "utf8"));
    packet.changedFiles.wholeFileSha256["src/example.txt"] = createHash("sha256").update(sourceB).digest("hex");
    packet.sourceFingerprint.sha256 = canonicalSourceFingerprint(packet.changedFiles.wholeFileSha256);
    await writeJson(packetPath, packet);

    const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
    const lineagePath = path.join(executionRoot, "verification-receipts/receipt-lineage.json");
    const lineage = JSON.parse(await readFile(lineagePath, "utf8"));
    const forgedReceipt = {
      ...lineage[0].receipt,
      sourceFingerprint: packet.sourceFingerprint.sha256,
      sourceArtifact: {
        ...lineage[0].receipt.sourceArtifact,
        sha256: createHash("sha256")
          .update(await readFile(packetPath))
          .digest("hex"),
        sourceFingerprint: packet.sourceFingerprint.sha256,
      },
    };
    const forgedLineage = [{
      receiptSha256: receiptSha256(forgedReceipt),
      receipt: forgedReceipt,
    }];
    await writeJson(lineagePath, forgedLineage);
    const gateInputPath = path.join(root, verified.gateInputPath);
    const gateInput = JSON.parse(await readFile(gateInputPath, "utf8"));
    const forgedGateInput = {
      ...gateInput,
      receipts: forgedLineage,
      sourceGate: verifyDeliveryPacket({ workspaceRoot: root, packet }),
    };
    assert.equal(validateVerificationReceiptGate(forgedGateInput).accepted, true);
    await writeJson(gateInputPath, forgedGateInput);

    const result = await runCli([
      "finish", "--workspace", root,
      "--run-id", runId, "--decision", "accepted",
    ]);
    assert.equal(result.status, "invalid_input", JSON.stringify(result));
    assert.match(result.issues.join("\n"), /snapshot.*delivery|snapshot.*source|manifest/i);
    assert.equal(JSON.parse(await readFile(path.join(
      executionRoot,
      "leases/W1-attempt-001.json",
    ), "utf8")).state, "active");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("high-level lifecycle rejects a redirected executions ancestor before any foreign write", async () => {
  const verifyRoot = await setupFixture("owlcoda-verify-executions-link-");
  const verifyForeign = await mkdtemp(path.join(tmpdir(), "owlcoda-verify-executions-foreign-"));
  const executionsRoot = path.join(verifyRoot, ".owlcoda/runkit/executions");
  const foreignExecutions = path.join(verifyForeign, "executions");
  try {
    assert.equal((await start(verifyRoot, "verify-executions-link")).status, "started");
    await writeFile(path.join(verifyRoot, "src/example.txt"), "candidate\n");
    await rename(executionsRoot, foreignExecutions);
    await symlink(foreignExecutions, executionsRoot);
    const result = await runCli([
      "verify", "--workspace", verifyRoot,
      "--run-id", "verify-executions-link",
      "--from-lease", "W1",
      "--verification-id", "attempt-001",
      "--cwd", ".",
      "--",
      "/usr/bin/true",
    ]);
    assert.equal(result.status, "invalid_input", JSON.stringify(result));
    assert.match(result.issues.join("\n"), /executions.*symlink|real directory/i);
    await assert.rejects(access(path.join(
      foreignExecutions,
      "verify-executions-link/verification-requests/attempt-001",
    )));
    await assert.rejects(access(path.join(
      foreignExecutions,
      "verify-executions-link/verification-receipts/receipt-lineage.json",
    )));
  } finally {
    await rm(verifyRoot, { recursive: true, force: true });
    await rm(verifyForeign, { recursive: true, force: true });
  }

  const startRoot = await setupFixture("owlcoda-start-executions-link-");
  const startForeign = await mkdtemp(path.join(tmpdir(), "owlcoda-start-executions-foreign-"));
  const startExecutions = path.join(startRoot, ".owlcoda/runkit/executions");
  const foreignStartExecutions = path.join(startForeign, "executions");
  try {
    await rename(startExecutions, foreignStartExecutions);
    await symlink(foreignStartExecutions, startExecutions);
    const result = await start(startRoot, "start-executions-link");
    assert.equal(result.status, "invalid_input", JSON.stringify(result));
    assert.match(result.issues.join("\n"), /executions.*symlink|real directory/i);
    await assert.rejects(access(path.join(foreignStartExecutions, "start-executions-link")));
  } finally {
    await rm(startRoot, { recursive: true, force: true });
    await rm(startForeign, { recursive: true, force: true });
  }
});
