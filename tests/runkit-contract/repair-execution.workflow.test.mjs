import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { coreManifest } from "../../scripts/runkit-contract/core-contract.mjs";
import { runFinalize } from "../../scripts/runkit-contract/finalize.mjs";
import { derivedVerificationContext } from "../../scripts/runkit-contract/lifecycle-orchestration.mjs";
import { runRepairExecution } from "../../scripts/runkit-contract/repair-execution.mjs";
import {
  receiptSha256,
  validateReceiptLineage,
} from "../../scripts/runkit-contract/receipt-lineage.mjs";
import { validateVerificationReceiptGate } from "../../scripts/runkit-contract/verification-receipt-gate.mjs";

const repairPlanSchemaPath = fileURLToPath(new URL(
  "../../docs/architecture/runkit-trust-product-v1/schemas/repair-plan-v1.schema.json",
  import.meta.url,
));
const finalizeRequestSchemaPath = fileURLToPath(new URL(
  "../../scripts/runkit-contract/schemas/finalize-request-v1.schema.json",
  import.meta.url,
));
const verificationReceiptSchemaPath = fileURLToPath(new URL(
  "../../scripts/runkit-contract/schemas/verification-receipt-v2.schema.json",
  import.meta.url,
));
const runkitCliPath = fileURLToPath(new URL(
  "../../scripts/runkit-contract/runkit-cli.mjs",
  import.meta.url,
));

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assertRepairPlanSchema(planPath) {
  execFileSync("python3", [
    "-c",
    [
      "import json,sys",
      "from jsonschema import Draft202012Validator",
      "schema=json.load(open(sys.argv[1]))",
      "value=json.load(open(sys.argv[2]))",
      "Draft202012Validator.check_schema(schema)",
      "Draft202012Validator(schema).validate(value)",
    ].join(";"),
    repairPlanSchemaPath,
    planPath,
  ]);
}

function commandSource(fileName, behavior = "pass") {
  if (behavior === "mutate-other") {
    return "require('node:fs').writeFileSync('src/a.txt','mutated-during-repair\\n')";
  }
  return [
    "const fs=require('node:fs')",
    `const value=fs.readFileSync('src/${fileName}','utf8')`,
    behavior === "content-gated"
      ? "if(value.includes('fail')) process.exit(7)"
      : "if(value.length===0) process.exit(7)",
  ].join(";");
}

function profile(id, fileName, behavior = "pass") {
  return {
    id,
    paths: [`src/${fileName}`],
    commands: [{
      id: `verify-${id}`,
      cwd: ".",
      executable: process.execPath,
      argv: ["-e", commandSource(fileName, behavior)],
    }],
  };
}

async function setupFixture({
  prefix = "owlcoda-repair-",
  riskMode = "standard",
  riskCategories = riskMode === "full" ? ["release"] : [],
  secondBehavior = "pass",
  initialProfile = "a",
  firstRequires = [],
  commandMetadata = true,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/a.txt"), "baseline-a\n");
  await writeFile(path.join(root, "src/b.txt"), "baseline-b\n");
  await writeJson(path.join(root, "goal.json"), {
    objective: "repair fixture",
    riskMode,
    riskCategories,
  });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c", "user.name=RunKit Test",
    "-c", "user.email=runkit@example.invalid",
    "commit", "-qm", "fixture",
  );
  assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
  const firstCommand = profile("a", "a.txt");
  firstCommand.requiresProfileIds = [...firstRequires];
  const secondCommand = profile("b", "b.txt", secondBehavior);
  const initialCommand = initialProfile === "a" ? firstCommand : secondCommand;
  const initialFile = initialProfile === "a" ? "a.txt" : "b.txt";
  const storedProfiles = commandMetadata
    ? [firstCommand, secondCommand]
    : [firstCommand, secondCommand].map(({ commands: _commands, ...item }) => item);
  await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: storedProfiles,
  });
  const runId = "repair-fixture";
  const started = await runCli([
    "start", "--workspace", root,
    "--run-id", runId,
    "--goal", path.join(root, "goal.json"),
    "--work-item", "W1",
    "--owned-path", "src/**",
  ]);
  assert.equal(started.status, "started", JSON.stringify(started));
  await writeFile(path.join(root, `src/${initialFile}`), `candidate-${initialProfile}\n`);
  const first = await runCli([
    "verify", "--workspace", root,
    "--run-id", runId,
    "--from-lease", "W1",
    "--verification-id", "initial",
    "--cwd", ".",
    "--",
    process.execPath,
    ...initialCommand.commands[0].argv,
  ]);
  assert.equal(first.status, "verified", JSON.stringify(first));
  const lineagePath = path.join(
    root,
    ".owlcoda/runkit/executions",
    runId,
    "verification-receipts/receipt-lineage.json",
  );
  const originalLineageBytes = await readFile(lineagePath);
  const originalLineage = JSON.parse(originalLineageBytes);
  assert.equal(originalLineage.length, 1);
  return {
    root,
    runId,
    first,
    firstCommand: firstCommand.commands[0],
    secondCommand: secondCommand.commands[0],
    lineagePath,
    originalLineage,
    originalLineageBytes,
  };
}

test("repair reuses stable command coverage, replays only pending exact argv, and appends supersedes lineage", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 0);
    assert.equal(repaired.authorizationGranted, false);
    assert.match(repaired.repairPlanSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(repaired.reusableCommandIds, ["verify-a"]);
    assert.deepEqual(repaired.replayedCommandIds, ["verify-b"]);
    const plan = JSON.parse(await readFile(path.join(fixture.root, repaired.repairPlanPath)));
    assert.equal(plan.schemaVersion, "OwlCodaRepairPlanV1");
    assert.equal(plan.planStatus, "ready");
    assert.deepEqual(plan.reusableCommandIds, ["verify-a"]);
    assert.deepEqual(plan.pendingReplayCommands, [{
      commandId: "verify-b",
      executable: process.execPath,
      argv: fixture.secondCommand.argv,
      cwd: ".",
    }]);
    assert.deepEqual(plan.blockedCommands, []);
    assert.equal(plan.authorizationGranted, false);
    assertRepairPlanSchema(path.join(fixture.root, repaired.repairPlanPath));

    const currentLineage = JSON.parse(await readFile(fixture.lineagePath));
    assert.equal(currentLineage.length, 2);
    assert.deepEqual(currentLineage[0], fixture.originalLineage[0]);
    assert.equal(currentLineage[1].parentReceiptSha256, fixture.originalLineage[0].receiptSha256);
    assert.equal(
      currentLineage[1].receipt.supersedesReceiptSha256,
      fixture.originalLineage[0].receiptSha256,
    );
    assert.equal(currentLineage[1].receipt.sourceFingerprint, repaired.sourceFingerprint);
    assert.match(currentLineage[1].receipt.goalContractSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(currentLineage[1].receipt.risk, {
      riskMode: "standard",
      riskCategories: [],
    });
    assert.equal(currentLineage[1].receipt.commandReceipts.length, 2);
    assert.equal("signatureRef" in currentLineage[1].receipt, false);
    assert.equal(validateReceiptLineage(currentLineage).valid, true);
    assert.equal(repaired.activeReceiptSha256, receiptSha256(currentLineage[1].receipt));
    assert.notEqual(repaired.sourceFingerprint, fixture.first.sourceFingerprint);

    const gateInputPath = path.join(
      path.dirname(path.join(fixture.root, repaired.receiptPath)),
      "verification-gate-input.json",
    );
    const tamperedGateInput = JSON.parse(await readFile(gateInputPath));
    delete tamperedGateInput.receipts.at(-1).receipt.repairControl;
    tamperedGateInput.receipts.at(-1).receiptSha256 = receiptSha256(
      tamperedGateInput.receipts.at(-1).receipt,
    );
    const tamperedGate = validateVerificationReceiptGate(tamperedGateInput);
    assert.equal(tamperedGate.accepted, false);
    assert.equal(
      tamperedGate.issues.some(issue => issue.code === "repair_control_required"),
      true,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair treats byte-identical current DeliveryPacket copies as one logical candidate", async () => {
  const fixture = await setupFixture({ prefix: "owlcoda-repair-duplicate-packet-" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    const created = await runCli([
      "delivery", "create",
      "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--from-lease", "W1",
      "--packet-id", "manual-current",
    ]);
    assert.equal(created.status, "delivery_packet_created", JSON.stringify(created));
    const packetPath = path.join(fixture.root, created.deliveryPacketPath);
    await copyFile(
      packetPath,
      path.join(path.dirname(packetPath), "manual-current-copy.json"),
    );

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);
    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    const plan = JSON.parse(await readFile(path.join(fixture.root, repaired.repairPlanPath)));
    assert.equal(plan.planStatus, "ready");
    assert.equal(
      plan.blockedCommands.some(item => item.commandId === "__delivery_packet__"),
      false,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a repaired accepted chain remains eligible for ready-for-commit", async () => {
  const fixture = await setupFixture({ prefix: "owlcoda-repair-ready-" });
  try {
    await writeFile(path.join(fixture.root, "src/a.txt"), "candidate-a-v2\n");
    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);
    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    const plan = JSON.parse(await readFile(path.join(fixture.root, repaired.repairPlanPath)));
    const finished = await runCli([
      "finish",
      "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--decision", "accepted",
    ]);
    assert.equal(finished.status, "finished", JSON.stringify(finished));

    const candidateSnapshotRequest = path.join(fixture.root, "candidate-snapshot-request.json");
    await writeJson(candidateSnapshotRequest, {
      schemaVersion: "OwlCodaRunKitSnapshotRequestV1",
      snapshotId: "ready-candidate-root",
      mode: "project",
      targetRoot: fixture.root,
      cwd: ".",
      executable: process.execPath,
      argv: ["-e", "process.exit(0)"],
      launcherVersion: process.version,
      toolVersions: [{ name: "node", version: process.version }],
      selectedPaths: ["src/a.txt", "src/b.txt"],
      statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
      verificationContext: derivedVerificationContext(fixture.root),
    });
    const snapped = await runCli([
      "snapshot",
      "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", candidateSnapshotRequest,
    ]);
    assert.equal(snapped.status, "snapshot_passed", JSON.stringify(snapped));
    const readyRequestPath = path.join(fixture.root, "ready-request.json");
    await writeJson(readyRequestPath, {
      schemaVersion: "OwlCodaRunKitReadyForCommitRequestV1",
      deliveryPacketPath: plan.selectedPacket.path,
      verificationGateInputPath: path.relative(
        fixture.root,
        path.join(
          fixture.root,
          `.owlcoda/runkit/executions/${fixture.runId}/verification-receipts`,
          repaired.replacementReceiptId,
          "verification-gate-input.json",
        ),
      ),
      roots: [{
        role: "candidate",
        snapshotPath: snapped.snapshotPath,
      }],
    });
    const ready = await runCli([
      "ready-for-commit",
      "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", readyRequestPath,
    ]);
    assert.equal(ready.status, "ready_for_commit", JSON.stringify(ready));
    assert.equal(ready.authorizationGranted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the Core manifest binds the deterministic repair implementation bytes", () => {
  assert.equal(coreManifest().files.includes("repair-execution.mjs"), true);
});

test("repair schemas encode non-empty evidence, supersedes control, and command ids", async () => {
  const finalizeSchema = JSON.parse(await readFile(finalizeRequestSchemaPath));
  const receiptSchema = JSON.parse(await readFile(verificationReceiptSchemaPath));
  execFileSync("python3", [
    "-c",
    [
      "import json,sys",
      "from jsonschema import Draft202012Validator",
      "[Draft202012Validator.check_schema(json.load(open(name))) for name in sys.argv[1:]]",
    ].join(";"),
    finalizeRequestSchemaPath,
    verificationReceiptSchemaPath,
  ]);

  assert.equal(Array.isArray(finalizeSchema.allOf), true);
  assert.equal(
    finalizeSchema.allOf.some(rule =>
      rule.then?.required?.includes("repairControl")
      && rule.if?.required?.includes("supersedesReceiptSha256")),
    true,
  );
  assert.equal(
    finalizeSchema.allOf.some(rule => Array.isArray(rule.anyOf)),
    true,
  );
  assert.equal(
    receiptSchema.$defs.commandReceipt.required.includes("id"),
    true,
  );
  assert.equal(finalizeSchema.$defs.repairControl.required.includes("risk"), true);
  assert.equal(receiptSchema.$defs.repairControl.required.includes("risk"), true);
  assert.equal(
    finalizeSchema.$defs.repairControl.required.includes("parentBindingMode"),
    true,
  );
});

test("repair exposes the persisted plan before replay starts", async () => {
  const fixture = await setupFixture();
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    let observed = false;
    const repaired = runRepairExecution({
      workspaceRoot: realpathSync(fixture.root),
      runId: fixture.runId,
      onPlan(planEvent) {
        observed = true;
        assert.equal(planEvent.plan.schemaVersion, "OwlCodaRepairPlanV1");
        assert.equal(planEvent.plan.planStatus, "ready");
        assert.match(planEvent.planPath, /repair-001-plan\.json$/);
        assert.match(planEvent.planSha256, /^[a-f0-9]{64}$/);
        assert.equal(
          existsSync(path.join(
            fixture.root,
            `.owlcoda/runkit/executions/${fixture.runId}/snapshots/repair-001-verify-b.json`,
          )),
          false,
        );
      },
    });

    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    assert.equal(observed, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the private CLI emits the persisted plan on stderr before returning the repair result", async () => {
  const fixture = await setupFixture({ prefix: "owlcoda-repair-cli-plan-" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    const completed = spawnSync(process.execPath, [
      runkitCliPath,
      "repair",
      "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

    assert.equal(completed.status, 0, completed.stderr);
    assert.match(completed.stderr, /^RunKit RepairPlan persisted before replay:/);
    assert.match(completed.stderr, /"schemaVersion": "OwlCodaRepairPlanV1"/);
    assert.equal(JSON.parse(completed.stdout).status, "repaired");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair closes required profile dependencies before finalizing coverage", async () => {
  const fixture = await setupFixture({ firstRequires: ["b"] });
  try {
    await writeFile(path.join(fixture.root, "src/a.txt"), "candidate-a-v2\n");
    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    const lineage = JSON.parse(await readFile(fixture.lineagePath));
    assert.deepEqual(lineage.at(-1).receipt.selectedProfileIds, ["a", "b"]);
    assert.equal(lineage.at(-1).receipt.commandReceipts.length, 2);
    assert.deepEqual(repaired.replayedCommandIds, ["verify-a", "verify-b"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair replays exact parent evidence when selected profiles have no commands", async () => {
  const fixture = await setupFixture({ commandMetadata: false });
  try {
    await writeFile(path.join(fixture.root, "src/a.txt"), "candidate-a-v2\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);
    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    assert.deepEqual(repaired.replayedCommandIds, ["legacy-1"]);
    const currentLineage = JSON.parse(await readFile(fixture.lineagePath));
    assert.equal(
      currentLineage.at(-1).receipt.repairControl.parentBindingMode,
      "receipt",
    );
    assert.match(currentLineage.at(-1).receipt.goalContractSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(currentLineage.at(-1).receipt.risk, {
      riskMode: "standard",
      riskCategories: [],
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair leaves an unbound historical parent readable but requires fresh full verification", async () => {
  const fixture = await setupFixture({ commandMetadata: false });
  try {
    const legacyLineage = JSON.parse(await readFile(fixture.lineagePath));
    delete legacyLineage[0].receipt.goalContractSha256;
    delete legacyLineage[0].receipt.risk;
    legacyLineage[0].receiptSha256 = receiptSha256(legacyLineage[0].receipt);
    await writeJson(fixture.lineagePath, legacyLineage);
    await writeFile(path.join(fixture.root, "src/a.txt"), "candidate-a-v2\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);
    assert.equal(repaired.status, "repair_plan_incomplete", JSON.stringify(repaired));
    assert.equal(repaired.nextAllowedAction, "run_full_verification_to_bind_goal_and_risk");
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), legacyLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair rejects a goal risk downgrade relative to the execution plan", async () => {
  const fixture = await setupFixture({ riskMode: "full" });
  try {
    const goalPath = path.join(
      fixture.root,
      `.owlcoda/runkit/executions/${fixture.runId}/goal-contract.json`,
    );
    await writeJson(goalPath, {
      objective: "repair fixture",
      riskMode: "standard",
      riskCategories: [],
    });
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repair_plan_incomplete", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 3);
    const plan = JSON.parse(await readFile(path.join(fixture.root, repaired.repairPlanPath)));
    assert.equal(
      plan.blockedCommands.some(entry => entry.commandId === "__goal_contract__"),
      true,
    );
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair uses the frozen RepairPlan risk-category vocabulary end to end", async () => {
  const fixture = await setupFixture({
    riskCategories: ["production"],
  });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);
    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    const lineage = JSON.parse(await readFile(fixture.lineagePath));
    assert.deepEqual(lineage.at(-1).receipt.risk, {
      riskMode: "standard",
      riskCategories: ["production"],
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair rejects a goal downgrade even when the mutable execution plan is rewritten to match", async () => {
  const fixture = await setupFixture({ riskMode: "full" });
  try {
    const executionRoot = path.join(
      fixture.root,
      `.owlcoda/runkit/executions/${fixture.runId}`,
    );
    const goalPath = path.join(executionRoot, "goal-contract.json");
    const executionPlanPath = path.join(executionRoot, "execution-plan.json");
    await writeJson(goalPath, {
      objective: "repair fixture",
      riskMode: "standard",
      riskCategories: [],
    });
    const executionPlan = JSON.parse(await readFile(executionPlanPath));
    executionPlan.goalContractSha256 = sha256(await readFile(goalPath));
    await writeJson(executionPlanPath, executionPlan);
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repair_plan_incomplete", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 3);
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("direct finalize cannot use a blocked RepairPlan as a repair authorization", async () => {
  const fixture = await setupFixture({ prefix: "owlcoda-repair-direct-finalize-" });
  try {
    const blocked = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);
    assert.equal(blocked.status, "repair_plan_incomplete", JSON.stringify(blocked));
    const plan = JSON.parse(await readFile(path.join(fixture.root, blocked.repairPlanPath)));
    assert.equal(plan.planStatus, "repair_plan_incomplete");
    const executionRoot = path.join(
      fixture.root,
      `.owlcoda/runkit/executions/${fixture.runId}`,
    );
    const profilesPath = path.join(fixture.root, ".owlcoda/runkit/profiles.json");
    const goalContractSha256 = sha256(await readFile(path.join(executionRoot, "goal-contract.json")));
    const profilesSha256 = sha256(await readFile(profilesPath));
    const executableSha256 = sha256(await readFile(process.execPath));

    assert.throws(() => runFinalize({
      workspaceRoot: realpathSync(fixture.root),
      runId: fixture.runId,
      request: {
        schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
        receiptId: "blocked-plan-bypass",
        deliveryPacketPath: plan.selectedPacket.path,
        verificationContext: derivedVerificationContext(fixture.root),
        snapshotPaths: [],
        supersedesReceiptSha256: fixture.originalLineage[0].receiptSha256,
        reusedCommandReceipts: [
          structuredClone(fixture.originalLineage[0].receipt.commandReceipts[0]),
        ],
        repairControl: {
          repairPlanPath: blocked.repairPlanPath,
          repairPlanSha256: blocked.repairPlanSha256,
          parentBindingMode: "receipt",
          goalContractSha256,
          risk: {
            riskMode: "standard",
            riskCategories: [],
          },
          profilesSha256,
          executableBindings: [{
            commandId: "verify-a",
            executable: process.execPath,
            sha256: executableSha256,
          }],
        },
      },
    }), /ready RepairPlan|repair plan/i);
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("direct finalize rejects a hash-stable ready plan whose DeliveryPacket binding was rewritten", async () => {
  const fixture = await setupFixture({ prefix: "owlcoda-repair-plan-binding-" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    let planEvent;
    assert.throws(() => runRepairExecution({
      workspaceRoot: realpathSync(fixture.root),
      runId: fixture.runId,
      onPlan(event) {
        planEvent = event;
        throw new Error("stop after ready plan");
      },
    }), /stop after ready plan/);
    assert.equal(planEvent.plan.planStatus, "ready");
    const planPath = path.join(fixture.root, planEvent.planPath);
    const plan = JSON.parse(await readFile(planPath));
    plan.selectedPacket.sha256 = `sha256:${"0".repeat(64)}`;
    await writeJson(planPath, plan);
    const executionRoot = path.join(
      fixture.root,
      `.owlcoda/runkit/executions/${fixture.runId}`,
    );
    const profilesPath = path.join(fixture.root, ".owlcoda/runkit/profiles.json");
    const executableSha256 = sha256(await readFile(process.execPath));
    const rewrittenPlanSha256 = sha256(await readFile(planPath));
    const goalContractSha256 = sha256(await readFile(path.join(executionRoot, "goal-contract.json")));
    const profilesSha256 = sha256(await readFile(profilesPath));

    assert.throws(() => runFinalize({
      workspaceRoot: realpathSync(fixture.root),
      runId: fixture.runId,
      request: {
        schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
        receiptId: "rewritten-ready-plan",
        deliveryPacketPath: plan.selectedPacket.path,
        verificationContext: derivedVerificationContext(fixture.root),
        snapshotPaths: [],
        supersedesReceiptSha256: fixture.originalLineage[0].receiptSha256,
        reusedCommandReceipts: [
          structuredClone(fixture.originalLineage[0].receipt.commandReceipts[0]),
        ],
        repairControl: {
          repairPlanPath: planEvent.planPath,
          repairPlanSha256: rewrittenPlanSha256,
          parentBindingMode: "receipt",
          goalContractSha256,
          risk: {
            riskMode: "standard",
            riskCategories: [],
          },
          profilesSha256,
          executableBindings: ["verify-a", "verify-b"].map(commandId => ({
            commandId,
            executable: process.execPath,
            sha256: executableSha256,
          })),
        },
      },
    }), /selected DeliveryPacket bytes/);
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair rejects executable replacement after the plan is persisted", async () => {
  const fixture = await setupFixture();
  try {
    const executablePath = path.join(fixture.root, ".owlcoda/repair-check");
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);
    const executableRealPath = realpathSync(executablePath);
    const profilesPath = path.join(fixture.root, ".owlcoda/runkit/profiles.json");
    const profiles = JSON.parse(await readFile(profilesPath));
    profiles.profiles[1].commands[0] = {
      id: "verify-b",
      cwd: ".",
      executable: executableRealPath,
      argv: [],
    };
    await writeJson(profilesPath, profiles);
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");

    const repaired = runRepairExecution({
      workspaceRoot: realpathSync(fixture.root),
      runId: fixture.runId,
      onPlan() {
        execFileSync("/bin/sh", ["-c", `printf '#!/bin/sh\\nexit 9\\n' > \"${executablePath}\"`]);
      },
    });

    assert.equal(repaired.status, "repair_plan_incomplete", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 3);
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair rechecks source and profile truth immediately before receipt persistence", async () => {
  for (const mutation of ["source", "profiles"]) {
    const fixture = await setupFixture({ prefix: `owlcoda-repair-final-${mutation}-` });
    try {
      await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
      const repaired = runRepairExecution({
        workspaceRoot: realpathSync(fixture.root),
        runId: fixture.runId,
        onBeforeReceiptPersist() {
          if (mutation === "source") {
            execFileSync("/bin/sh", ["-c", `printf 'late-drift\\n' > \"${path.join(fixture.root, "src/a.txt")}\"`]);
          } else {
            const profilesPath = path.join(fixture.root, ".owlcoda/runkit/profiles.json");
            const profiles = JSON.parse(execFileSync(process.execPath, [
              "-e",
              `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(profilesPath)},'utf8'))`,
            ], { encoding: "utf8" }));
            profiles.profiles[1].commands[0].argv = ["-e", "process.exit(0)"];
            execFileSync(process.execPath, [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(profilesPath)},${JSON.stringify(`${JSON.stringify(profiles, null, 2)}\n`)})`,
            ]);
          }
        },
      });

      assert.notEqual(repaired.status, "repaired", JSON.stringify(repaired));
      assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("repair rechecks source immediately before replacement lineage activation", async () => {
  const fixture = await setupFixture({ prefix: "owlcoda-repair-lineage-activation-" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    const repaired = runRepairExecution({
      workspaceRoot: realpathSync(fixture.root),
      runId: fixture.runId,
      onBeforeLineageActivate() {
        execFileSync("/bin/sh", [
          "-c",
          `printf 'activation-window-drift\\n' > "${path.join(fixture.root, "src/a.txt")}"`,
        ]);
      },
    });

    assert.equal(repaired.status, "repair_finalize_failed", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 3);
    assert.match(repaired.finalizeError, /Source changed|fingerprint|DeliveryPacket/i);
    assert.equal(existsSync(path.join(
      fixture.root,
      `.owlcoda/runkit/executions/${fixture.runId}/verification-receipts`,
      repaired.replacementReceiptId,
      "verification-receipt.json",
    )), true);
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair never overwrites receipt lineage changed before activation", async () => {
  const fixture = await setupFixture({
    prefix: "owlcoda-repair-lineage-drift-",
  });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    const driftedLineage = [];
    const repaired = runRepairExecution({
      workspaceRoot: realpathSync(fixture.root),
      runId: fixture.runId,
      onBeforeLineageActivate() {
        writeFileSync(
          fixture.lineagePath,
          `${JSON.stringify(driftedLineage, null, 2)}\n`,
        );
      },
    });

    assert.equal(
      repaired.status,
      "repair_finalize_failed",
      JSON.stringify(repaired),
    );
    assert.match(repaired.finalizeError, /lineage.*changed|lineage.*drift/i);
    assert.deepEqual(
      JSON.parse(await readFile(fixture.lineagePath)),
      driftedLineage,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair coverage comparison is order-independent when the reusable command sorts after replay", async () => {
  const fixture = await setupFixture({ initialProfile: "b" });
  try {
    await writeFile(path.join(fixture.root, "src/a.txt"), "candidate-a\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    assert.deepEqual(repaired.reusableCommandIds, ["verify-b"]);
    assert.deepEqual(repaired.replayedCommandIds, ["verify-a"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair retry preserves the failed attempt and succeeds under a new append-only attempt id", async () => {
  const fixture = await setupFixture({ secondBehavior: "content-gated" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "fail\n");
    const failed = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);
    assert.equal(failed.status, "repair_replay_failed", JSON.stringify(failed));
    const failedAttemptBytes = await readFile(path.join(fixture.root, failed.repairAttemptPath));

    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");
    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repaired", JSON.stringify(repaired));
    assert.match(repaired.repairPlanPath, /repair-002-plan\.json$/);
    assert.match(repaired.repairAttemptPath, /repair-002-attempt\.json$/);
    assert.equal(
      Buffer.compare(
        await readFile(path.join(fixture.root, failed.repairAttemptPath)),
        failedAttemptBytes,
      ),
      0,
    );
    assert.equal(validateReceiptLineage(JSON.parse(await readFile(fixture.lineagePath))).valid, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair preserves a failed replay attempt and cannot create a green replacement leaf", async () => {
  const fixture = await setupFixture({ secondBehavior: "content-gated" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "fail\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repair_replay_failed", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 1);
    assert.equal(repaired.issueCodes.includes("repair_replay_failed"), true);
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
    assert.equal(validateReceiptLineage(fixture.originalLineage).valid, true);
    const attempt = JSON.parse(await readFile(path.join(fixture.root, repaired.repairAttemptPath)));
    assert.equal(attempt.status, "repair_replay_failed");
    assert.equal(attempt.commandAttempts[0].exitCode, 7);
    await assert.rejects(access(path.join(
      fixture.root,
      `.owlcoda/runkit/executions/${fixture.runId}/verification-receipts/${repaired.replacementReceiptId}`,
    )));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair fails closed when a replay mutates any packet-bound source path", async () => {
  const fixture = await setupFixture({ secondBehavior: "mutate-other" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repair_source_drift", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 2);
    assert.equal(repaired.issueCodes.includes("source_mutated_during_verification"), true);
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
    const attempt = JSON.parse(await readFile(path.join(fixture.root, repaired.repairAttemptPath)));
    assert.equal(attempt.status, "repair_source_drift");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair emits an incomplete plan and runs nothing for protected risk without trusted provenance", async () => {
  const fixture = await setupFixture({ riskMode: "full" });
  try {
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repair_plan_incomplete", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 3);
    assert.deepEqual(repaired.issueCodes, ["repair_plan_incomplete"]);
    const plan = JSON.parse(await readFile(path.join(fixture.root, repaired.repairPlanPath)));
    assert.equal(plan.planStatus, "repair_plan_incomplete");
    assert.deepEqual(plan.requiredTrust, {
      riskMode: "full",
      riskCategories: ["release"],
      implementationActor: true,
      independentReviewer: true,
    });
    assert.equal(
      plan.blockedCommands.every((entry) => entry.issueCode === "repair_plan_incomplete"),
      true,
    );
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
    await assert.rejects(access(path.join(
      fixture.root,
      `.owlcoda/runkit/executions/${fixture.runId}/snapshots/repair-001-verify-b.json`,
    )));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("repair blocks instead of guessing when current profile command metadata no longer matches exact evidence", async () => {
  const fixture = await setupFixture();
  try {
    const profilesPath = path.join(fixture.root, ".owlcoda/runkit/profiles.json");
    const profiles = JSON.parse(await readFile(profilesPath));
    profiles.profiles[0].commands[0].argv = ["-e", "process.exit(0)"];
    await writeJson(profilesPath, profiles);
    await writeFile(path.join(fixture.root, "src/b.txt"), "candidate-b\n");

    const repaired = await runCli([
      "repair", "--workspace", fixture.root,
      "--run-id", fixture.runId,
    ]);

    assert.equal(repaired.status, "repair_plan_incomplete", JSON.stringify(repaired));
    assert.equal(repaired.exitCode, 3);
    const plan = JSON.parse(await readFile(path.join(fixture.root, repaired.repairPlanPath)));
    assert.equal(
      plan.blockedCommands.some((entry) =>
        entry.commandId === "verify-a" && entry.issueCode === "repair_plan_incomplete"),
      true,
    );
    assert.deepEqual(JSON.parse(await readFile(fixture.lineagePath)), fixture.originalLineage);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
