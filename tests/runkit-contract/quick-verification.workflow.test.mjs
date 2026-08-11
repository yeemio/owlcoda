import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-workflow-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "quick@example.test");
  git(root, "config", "user.name", "Quick Test");
  writeFileSync(path.join(root, "source.txt"), "stable\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return root;
}

test("quick verify preserves exact argv including empty, spaced, and special arguments", async () => {
  const root = repository();
  const observedPath = path.join(root, ".owlcoda", "runkit", "quick-argv.json");
  const exactArgv = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
    observedPath,
    "",
    "two words",
    "$HOME",
    "semi;colon",
    "quote\"inside",
  ];
  const result = await runCli([
    "quick-verify",
    "--workspace", root,
    "--",
    ...exactArgv,
  ]);

  assert.equal(result.status, "quick_verification_passed");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(readFileSync(observedPath, "utf8")), exactArgv.slice(4));
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.exactCommand.executable, process.execPath);
  assert.deepEqual(receipt.exactCommand.argv, exactArgv.slice(1));
  assert.equal(receipt.assurance, "captured_verification");
  assert.equal(receipt.authorizationGranted, false);
});

test("command failure keeps a receipt and returns deterministic NO-GO", async () => {
  const root = repository();
  const result = await runCli([
    "quick-verify",
    "--workspace", root,
    "--",
    process.execPath,
    "-e",
    "process.stderr.write('expected failure\\n'); process.exit(7)",
  ]);

  assert.equal(result.status, "quick_verification_failed");
  assert.equal(result.exitCode, 1);
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.exitResult.exitCode, 7);
  assert.equal(receipt.mutationDecision, "source_unchanged");
});

test("zero-exit command that mutates source fails closed with exit 2", async () => {
  const root = repository();
  const result = await runCli([
    "quick-verify",
    "--workspace", root,
    "--",
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('source.txt', 'mutated\\n')",
  ]);

  assert.equal(result.status, "quick_verification_source_mutated");
  assert.equal(result.exitCode, 2);
  const receipt = JSON.parse(readFileSync(result.receiptPath, "utf8"));
  assert.equal(receipt.exitResult.exitCode, 0);
  assert.equal(receipt.mutationDecision, "invalidated_by_command_source_mutation");
  assert.ok(receipt.issueCodes.includes("source_mutated_during_verification"));

  const attested = await runCli([
    "quick-attest",
    "--workspace", root,
    "--receipt", result.receiptPath,
  ]);
  assert.equal(attested.attestation.decision, "NO_GO");
  assert.equal(attested.exitCode, 2);
});

test("a command cannot redirect the Quick receipt store outside the workspace", async () => {
  const root = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-outside-"));
  const script = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const receipts = path.join('.owlcoda', 'runkit', 'quick', 'receipts')",
    "const [receiptId] = fs.readdirSync(receipts)",
    "const receiptRoot = path.join(receipts, receiptId)",
    "fs.rmSync(receiptRoot, { recursive: true })",
    `fs.symlinkSync(${JSON.stringify(outside)}, receiptRoot)`,
  ].join(";");

  const result = await runCli([
    "quick-verify",
    "--workspace", root,
    "--",
    process.execPath,
    "-e",
    script,
  ]);

  assert.equal(result.status, "quick_verification_control_invalid");
  assert.equal(result.exitCode, 1);
  assert.equal(result.authorizationGranted, false);
  assert.ok(result.issueCodes.includes("quick_receipt_store_invalid"));
  assert.equal(existsSync(path.join(outside, "receipt.json")), false);
});

test("local metrics read the project receipt store without telemetry", async () => {
  const root = repository();
  await runCli([
    "quick-verify",
    "--workspace", root,
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ]);
  const metrics = await runCli(["quick-metrics", "--workspace", root, "--local"]);

  assert.equal(metrics.status, "local_metrics");
  assert.equal(metrics.exitCode, 0);
  assert.equal(metrics.telemetry, false);
  assert.equal(metrics.inputs.length, 1);
  assert.equal(metrics.quick.total, 1);
  assert.equal(metrics.quick.passed, 1);
});

test("local metrics stop counting a receipt as passed after current source drift", async () => {
  const root = repository();
  await runCli([
    "quick-verify",
    "--workspace", root,
    "--",
    process.execPath,
    "-e",
    "process.exit(0)",
  ]);
  writeFileSync(path.join(root, "source.txt"), "changed after verification\n");

  const metrics = await runCli(["quick-metrics", "--workspace", root, "--local"]);
  assert.equal(metrics.quick.total, 1);
  assert.equal(metrics.quick.passed, 0);
  assert.equal(metrics.quick.sourceMutated, 1);
});

test("local metrics reject a receipt root redirected through a symlink", async () => {
  const root = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-metrics-outside-"));
  const quickRoot = path.join(root, ".owlcoda", "runkit", "quick");
  mkdirSync(quickRoot, { recursive: true });
  symlinkSync(outside, path.join(quickRoot, "receipts"));

  const metrics = await runCli(["quick-metrics", "--workspace", root, "--local"]);

  assert.equal(metrics.status, "quick_receipt_store_invalid");
  assert.equal(metrics.exitCode, 3);
  assert.deepEqual(metrics.issueCodes, ["quick_receipt_store_invalid"]);
  assert.equal(metrics.authorizationGranted, false);
});
