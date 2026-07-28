import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalSourceFingerprint } from "../../scripts/runkit-contract/source-fingerprint.mjs";

const cliPath = fileURLToPath(new URL("../../scripts/runkit-contract/runkit-cli.mjs", import.meta.url));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runCli(args) {
  const completed = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  return { ...completed, json: completed.stdout ? JSON.parse(completed.stdout) : null };
}

function git(root, args) {
  const completed = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
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

async function plannedWorkspace() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-visual-")));
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
    "--run-id", "visual-fixture",
    "--goal", goalPath,
  ]).status, 0);
  await writeJson(path.join(root, ".owlcoda/runkit/executions/visual-fixture/leases/W1.json"), {
    schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
    workItemId: "W1",
    attempt: 1,
    ownedPaths: ["src/example.txt"],
    state: "active",
  });
  await writeFile(path.join(root, "src/example.txt"), "candidate\n");
  const files = { "src/example.txt": sha256(await readFile(path.join(root, "src/example.txt"))) };
  const packetPath = path.join(root, ".owlcoda/runkit/executions/visual-fixture/delivery-packets/delivery.json");
  await writeJson(packetPath, {
    schemaVersion: "ExecutionDeliveryPacketV1",
    runId: "visual-fixture",
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
  const runnerPath = path.join(root, "runner.mjs");
  await writeFile(runnerPath, `
import { appendFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
const [mode, resultPath, artifactPath, targetPath] = process.argv.slice(2);
mkdirSync(path.dirname(resultPath), { recursive: true });
if (mode === "malformed") {
  writeFileSync(resultPath, "{not-json");
  process.exit(0);
}
if (mode === "drift") appendFileSync(targetPath, "drift\\n");
if (mode !== "missing-artifact") writeFileSync(artifactPath, "visual-bytes\\n");
const assertionPassed = mode !== "assertion-failed";
const external = mode === "external-navigation";
const result = JSON.stringify({
  schemaVersion: "OwlCodaRunKitVisualSmokeResultV1",
  status: assertionPassed && !external && mode !== "missing-artifact" ? "passed" : "failed",
  viewport: { width: 1280, height: 720 },
  assertions: [
    { id: "page-no-overflow", passed: assertionPassed },
    { id: "console-clean", passed: true }
  ],
  console: { errors: 0, warnings: 0, exceptions: 0 },
  navigations: [{ protocol: "https:", external }],
  outputArtifacts: [{
    path: path.relative(process.cwd(), artifactPath),
    mediaType: mode === "empty-media-type" ? "" : "image/png"
  }]
}, null, 2) + "\\n";
if (mode === "symlink-result") {
  writeFileSync(path.join(path.dirname(resultPath), "real-result.json"), result);
  symlinkSync("real-result.json", resultPath);
} else {
  writeFileSync(resultPath, result);
}
process.stdout.write("visual runner complete\\n");
`);
  return { root, packetPath, runnerPath };
}

function visualRequest(root, runnerPath, mode = "pass", overrides = {}) {
  const evidenceRoot = path.join(root, ".owlcoda/runkit/executions/visual-fixture/visual-smoke-evidence/main");
  return {
    schemaVersion: "OwlCodaRunKitVisualSmokeRequestV1",
    smokeId: "main",
    mode: "project",
    targetRoot: root,
    cwd: ".",
    executable: process.execPath,
    argv: [
      runnerPath,
      mode,
      path.join(evidenceRoot, "result.json"),
      path.join(evidenceRoot, "screenshot.png"),
      path.join(root, "src/example.txt"),
    ],
    launcherVersion: process.version,
    toolVersions: [{ name: "node", version: process.version }],
    selectedPaths: ["src/example.txt"],
    statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
    verificationContext: verificationContext(),
    resultPath: ".owlcoda/runkit/executions/visual-fixture/visual-smoke-evidence/main/result.json",
    automationManifest: {
      schemaVersion: "OwlCodaRunKitVisualAutomationManifestV1",
      surface: "browser",
      viewport: { width: 1280, height: 720 },
      assertionIds: ["page-no-overflow", "console-clean"],
      consolePolicy: { maxErrors: 0, maxWarnings: 0, maxExceptions: 0 },
      externalNavigationPolicy: "deny",
    },
    ...overrides,
  };
}

async function runVisual(root, runnerPath, mode = "pass", overrides = {}) {
  const requestPath = path.join(root, `visual-${mode}.json`);
  await writeJson(requestPath, visualRequest(root, runnerPath, mode, overrides));
  return runCli([
    "visual-smoke", "--workspace", root,
    "--run-id", "visual-fixture",
    "--request", requestPath,
  ]);
}

test("visual-smoke emits replayable automation evidence accepted by finalize", async () => {
  const { root, packetPath, runnerPath } = await plannedWorkspace();
  try {
    const visual = await runVisual(root, runnerPath);
    assert.equal(visual.status, 0, JSON.stringify(visual.json));
    assert.equal(visual.json.status, "visual_smoke_passed");
    const snapshot = JSON.parse(await readFile(path.join(root, visual.json.snapshotPath), "utf8"));
    assert.equal(snapshot.status, "snapshot_passed");
    assert.equal(snapshot.command.evidence.kind, "automation");
    assert.deepEqual(snapshot.command.evidence.argv, [process.execPath, ...visualRequest(root, runnerPath).argv]);
    assert.match(snapshot.command.evidence.automationManifestSha256, /^[a-f0-9]{64}$/);
    assert.ok(snapshot.command.evidence.outputArtifacts.some((item) => item.path.endsWith("screenshot.png")));
    assert.equal(snapshot.visual.result.status, "passed");

    const finalizePath = path.join(root, "finalize.json");
    await writeJson(finalizePath, {
      schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
      receiptId: "visual-verification",
      deliveryPacketPath: path.relative(root, packetPath),
      verificationContext: verificationContext(),
      snapshotPaths: [visual.json.snapshotPath],
    });
    const finalized = runCli([
      "finalize", "--workspace", root,
      "--run-id", "visual-fixture",
      "--request", finalizePath,
    ]);
    assert.equal(finalized.status, 0, finalized.stderr);
    assert.equal(finalized.json.status, "accepted_passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("visual-smoke fails closed on assertions and external navigation", async () => {
  for (const mode of ["assertion-failed", "external-navigation"]) {
    const { root, runnerPath } = await plannedWorkspace();
    try {
      const completed = await runVisual(root, runnerPath, mode);
      assert.equal(completed.status, 2, completed.stderr);
      assert.equal(completed.json.status, "visual_smoke_failed");
      assert.match(completed.json.issues.join("\n"), mode === "assertion-failed" ? /assertion/i : /external navigation/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("visual-smoke rejects missing artifacts, malformed results, and raw environment input", async () => {
  for (const [mode, overrides, expectedStatus, pattern] of [
    ["missing-artifact", {}, 2, /artifact/i],
    ["malformed", {}, 2, /result.*json/i],
    ["symlink-result", {}, 2, /result.*symlink|regular.*result/i],
    ["empty-media-type", {}, 2, /mediaType/i],
    ["pass", { environmentValues: { TOKEN: "secret" } }, 3, /unsupported field/i],
  ]) {
    const { root, runnerPath } = await plannedWorkspace();
    try {
      const completed = await runVisual(root, runnerPath, mode, overrides);
      assert.equal(completed.status, expectedStatus, completed.stderr);
      assert.match(completed.json.issues.join("\n"), pattern);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("visual-smoke invalidates evidence when selected source changes", async () => {
  const { root, runnerPath } = await plannedWorkspace();
  try {
    const completed = await runVisual(root, runnerPath, "drift");
    assert.equal(completed.status, 2, completed.stderr);
    assert.equal(completed.json.status, "invalidated_by_target_write");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finalize rejects visual artifacts changed after the smoke passed", async () => {
  const { root, packetPath, runnerPath } = await plannedWorkspace();
  try {
    const visual = await runVisual(root, runnerPath);
    assert.equal(visual.status, 0, JSON.stringify(visual.json));
    const screenshotPath = path.join(root, ".owlcoda/runkit/executions/visual-fixture/visual-smoke-evidence/main/screenshot.png");
    await writeFile(screenshotPath, "tampered\n");
    const finalizePath = path.join(root, "finalize-tampered.json");
    await writeJson(finalizePath, {
      schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
      receiptId: "visual-tampered",
      deliveryPacketPath: path.relative(root, packetPath),
      verificationContext: verificationContext(),
      snapshotPaths: [visual.json.snapshotPath],
    });
    const finalized = runCli([
      "finalize", "--workspace", root,
      "--run-id", "visual-fixture",
      "--request", finalizePath,
    ]);
    assert.equal(finalized.status, 3, finalized.stderr);
    assert.match(finalized.json.issues.join("\n"), /output artifact hash mismatch/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
