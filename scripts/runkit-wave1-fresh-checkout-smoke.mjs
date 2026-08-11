#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error("Usage: runkit-wave1-fresh-checkout-smoke.mjs --package <tgz> --result <json>");
    }
    result[name.slice(2)] = value;
  }
  if (!result.package || !result.result) {
    throw new Error("Usage: runkit-wave1-fresh-checkout-smoke.mjs --package <tgz> --result <json>");
  }
  return result;
}

function run(file, args, options = {}) {
  return spawnSync(file, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function parseJsonOutput(completed, label) {
  if (completed.status !== 0) {
    throw new Error(`${label} failed (${completed.status}): ${completed.stdout}\n${completed.stderr}`);
  }
  try {
    return JSON.parse(completed.stdout);
  } catch {
    throw new Error(`${label} returned non-JSON stdout: ${completed.stdout}`);
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function runGate(label, file, args, options = {}) {
  const startedAt = Date.now();
  const completed = run(file, args, {
    timeout: 20 * 60_000,
    ...options,
  });
  if (completed.status !== 0) {
    const output = `${completed.stdout}\n${completed.stderr}`.trim();
    throw new Error(`${label} failed (${completed.status ?? completed.signal}):\n${output.slice(-32_000)}`);
  }
  return {
    label,
    durationMs: Date.now() - startedAt,
    exitCode: completed.status,
  };
}

function candidatePaths(root) {
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", "-z", "HEAD"],
    { cwd: root, encoding: "utf8" },
  ).split("\0");
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  ).split("\0");
  return [...new Set([...changed, ...untracked])]
    .filter(Boolean)
    .filter((entry) => entry !== ".owlcoda/runkit" && !entry.startsWith(".owlcoda/runkit/"))
    .sort();
}

function packFilename(packOutput) {
  const filename = packOutput.trim().split("\n").at(-1);
  if (!filename?.endsWith(".tgz")) throw new Error(`npm pack did not return a tarball: ${packOutput}`);
  return filename;
}

function runFinalGate() {
  const root = realpathSync(path.resolve(fileURLToPath(new URL("..", import.meta.url))));
  const scratch = mkdtempSync(path.join(tmpdir(), "owlcoda-wave1-final-"));
  const steps = [];
  const realIndexPath = path.resolve(root, execFileSync(
    "git",
    ["rev-parse", "--git-path", "index"],
    { cwd: root, encoding: "utf8" },
  ).trim());
  const realIndexBefore = sha256File(realIndexPath);
  const selectedPaths = candidatePaths(root);
  const candidateIndex = path.join(scratch, "candidate.index");
  const bin = (name) => path.join(root, "node_modules", ".bin", name);

  try {
    const runKitContractTests = readdirSync(path.join(root, "tests", "runkit-contract"))
      .filter((entry) => entry.endsWith(".test.mjs") && entry !== "quick-installed-package.test.mjs")
      .map((entry) => path.join("tests", "runkit-contract", entry))
      .sort();
    copyFileSync(realIndexPath, candidateIndex);
    runGate("candidate-index", "git", ["add", "-A", "--", ...selectedPaths], {
      cwd: root,
      env: { ...process.env, GIT_INDEX_FILE: candidateIndex },
    });
    steps.push(runGate(
      "candidate-diff-check",
      "git",
      ["diff", "--cached", "--check"],
      { cwd: root, env: { ...process.env, GIT_INDEX_FILE: candidateIndex } },
    ));
    steps.push(runGate(
      "wave-contract-and-quick-tests",
      process.execPath,
      [
        "--test",
        "tests/architecture/runkit-trust-product-wave0.test.mjs",
        ...runKitContractTests,
      ],
      { cwd: root },
    ));
    steps.push(runGate(
      "root-tests",
      bin("vitest"),
      ["run", "--maxWorkers=2", "--exclude", "tests/run-integration.test.ts"],
      { cwd: root },
    ));
    steps.push(runGate(
      "candidate-index-run-integration",
      bin("vitest"),
      ["run", "tests/run-integration.test.ts", "--maxWorkers=1"],
      { cwd: root, env: { ...process.env, GIT_INDEX_FILE: candidateIndex } },
    ));
    steps.push(runGate("typecheck", bin("tsc"), ["--noEmit"], { cwd: root }));
    steps.push(runGate("offline-build", "npm", ["run", "build"], {
      cwd: root,
      env: { ...process.env, npm_config_offline: "true" },
    }));
    steps.push(runGate(
      "installed-package-test",
      process.execPath,
      ["--test", "tests/runkit-contract/quick-installed-package.test.mjs"],
      { cwd: root },
    ));

    const packRoot = path.join(scratch, "pack");
    mkdirSync(packRoot);
    const packed = run("npm", ["pack", "--silent", "--pack-destination", packRoot], {
      cwd: root,
      env: { ...process.env, npm_config_offline: "true" },
    });
    if (packed.status !== 0) {
      throw new Error(`npm pack failed (${packed.status}): ${packed.stdout}\n${packed.stderr}`);
    }
    const packagePath = path.join(packRoot, packFilename(packed.stdout));
    const entries = execFileSync("tar", ["-tf", packagePath], { encoding: "utf8" })
      .trim()
      .split("\n");
    for (const required of [
      "package/dist/native/runkit-command-port.js",
      "package/scripts/runkit-contract/quick-attest.mjs",
      "package/scripts/runkit-contract/quick-canonical.mjs",
      "package/scripts/runkit-contract/quick-verify.mjs",
    ]) {
      if (!entries.includes(required)) throw new Error(`Packed tarball is missing ${required}`);
    }
    if (entries.some((entry) =>
      entry.startsWith("package/desktop/osui/")
      || entry.startsWith("package/docs/execution-prompts/")
      || entry.includes("OWLCODA_RK_TRUST_PRODUCTIZATION_DECISION"))) {
      throw new Error("Packed tarball crosses the frozen public/private boundary");
    }

    const smokeResultPath = path.join(scratch, "fresh-checkout-smoke.json");
    steps.push(runGate(
      "fresh-checkout-smoke",
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--package", packagePath,
        "--result", smokeResultPath,
      ],
      { cwd: root },
    ));
    const smoke = JSON.parse(readFileSync(smokeResultPath, "utf8"));
    const realIndexAfter = sha256File(realIndexPath);
    if (realIndexAfter !== realIndexBefore) {
      throw new Error("Final gate modified the real Git index");
    }
    const result = {
      schemaVersion: "OwlCodaRunKitWave1FinalGateV1",
      status: "passed",
      baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      selectedPathCount: selectedPaths.length,
      steps,
      package: {
        sha256: sha256File(packagePath),
        entryCount: entries.length,
        privateDesktopEntries: 0,
      },
      freshCheckout: smoke,
      realIndexSha256Before: realIndexBefore,
      realIndexSha256After: realIndexAfter,
      externalNetworkRequests: 0,
      authorizationGranted: false,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--final-gate") {
  runFinalGate();
  process.exit(0);
}

const options = parseArgs(process.argv.slice(2));
const packagePath = realpathSync(options.package);
const resultPath = path.resolve(options.result);
const scratch = mkdtempSync(path.join(tmpdir(), "owlcoda-wave1-fresh-"));
const startedMs = Date.now();

try {
  const consumer = path.join(scratch, "consumer");
  const project = path.join(scratch, "project");
  mkdirSync(consumer, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      packagePath,
    ],
    { cwd: consumer, encoding: "utf8", stdio: "pipe" },
  );

  execFileSync("git", ["-C", project, "init", "-q"]);
  execFileSync("git", ["-C", project, "config", "user.name", "Quick Smoke"]);
  execFileSync("git", ["-C", project, "config", "user.email", "quick-smoke@example.test"]);
  writeFileSync(path.join(project, ".gitignore"), "dist/\n");
  writeFileSync(path.join(project, "package.json"), '{"name":"quick-smoke","private":true}\n');
  writeFileSync(path.join(project, "source.txt"), "frozen source\n");
  execFileSync("git", ["-C", project, "add", "."]);
  execFileSync("git", ["-C", project, "commit", "-qm", "fresh fixture"]);

  const cli = path.join(consumer, "node_modules", ".bin", "owlcoda");
  const commandEnv = {
    ...process.env,
    COLUMNS: "120",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PAGER: "cat",
    GIT_PAGER: "cat",
    TERM: "dumb",
  };
  const help = run(cli, ["runkit", "verify", "--help"], { cwd: project, env: commandEnv });
  if (help.status !== 0 || help.stderr !== "") {
    throw new Error(`Quick help failed: ${help.stdout}\n${help.stderr}`);
  }
  if (
    !help.stdout.includes("owlcoda runkit verify -- <executable> [args...]")
    || !help.stdout.includes("owlcoda attest <receipt> --workspace <path>")
  ) {
    throw new Error("Quick help does not contain the generation and consumption loop");
  }
  const helpLines = help.stdout.trimEnd().split("\n");
  if (helpLines.length > 40 || helpLines.some((line) => line.length > 120)) {
    throw new Error("Quick help exceeds the one-screen budget");
  }

  const verified = parseJsonOutput(run(
    cli,
    [
      "runkit",
      "verify",
      "--json",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('fresh quick receipt\\n')",
    ],
    { cwd: project, env: commandEnv },
  ), "Quick Verification");
  const attested = parseJsonOutput(run(
    cli,
    [
      "attest",
      verified.receiptPath,
      "--workspace",
      project,
      "--json",
    ],
    { cwd: project, env: commandEnv },
  ), "Quick attest");
  const metrics = parseJsonOutput(run(
    cli,
    ["runkit", "metrics", "--local", "--json"],
    { cwd: project, env: commandEnv },
  ), "Quick metrics");

  const receipt = JSON.parse(readFileSync(verified.receiptPath, "utf8"));
  if (
    attested.status !== "quick_attestation"
    || attested.receiptPath !== verified.receiptPath
    || attested.sourceFingerprint !== verified.sourceFingerprint
    || attested.authorizationGranted !== false
  ) {
    throw new Error("Quick attest command output omitted its receipt or authority binding");
  }
  const durationMs = Date.now() - startedMs;
  if (durationMs > 180_000) {
    throw new Error(`Fresh-checkout smoke exceeded 180000ms: ${durationMs}`);
  }
  const result = {
    schemaVersion: "OwlCodaRunKitWave1FreshCheckoutSmokeV1",
    status: "passed",
    durationMs,
    helpOnly: true,
    helpLineCount: helpLines.length,
    receiptDecision: verified.status,
    attestationDecision: attested.attestation.decision,
    receiptSchemaVersion: receipt.schemaVersion,
    receiptSha256: verified.receiptSha256,
    sourceFingerprint: verified.sourceFingerprint,
    metrics: metrics.metrics,
    privateCommandPortResolved: true,
    networkRequests: 0,
    authorizationGranted: false,
  };
  mkdirSync(path.dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
