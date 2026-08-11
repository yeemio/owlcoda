import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";
import {
  finalizeFormalChecksV1,
  recordFormalCheckV1,
} from "../scripts/runkit-contract/formal-workflow.mjs";
import {
  createDeploymentPrepareReceiptFromClosedRun,
} from "../scripts/runkit-contract/deployment-workflow.mjs";
import { receiptSha256 } from "../scripts/runkit-contract/receipt-lineage.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function profileCommand(id, argv) {
  return {
    id,
    cwd: ".",
    executable: argv[0],
    argv: argv.slice(1),
  };
}

function declaredCheck(root, name) {
  return [
    process.execPath,
    "--check",
    path.relative(root, path.join(root, "checks", `${name}.mjs`)),
  ];
}

async function writeProfiles(root, commands) {
  await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: [{
      id: "quality",
      paths: ["src/**"],
      role: "primary",
      primary: true,
      requiresProfileIds: [],
      commands,
    }],
  });
}

async function setup({ workItemId = "delivery" } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-formal-workflow-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "checks"), { recursive: true });
  await writeFile(path.join(root, "src/example.txt"), "baseline\n");
  await writeFile(path.join(root, "checks/good.mjs"), "process.exit(0);\n");
  await writeFile(path.join(root, "checks/bad.mjs"), "export const = ;\n");
  await writeFile(path.join(root, "package-lock.json"), "fixture-lock\n");
  await writeJson(path.join(root, "goal.json"), {
    schemaVersion: "OwlCodaRunKitGoalContractV1",
    objective: "exercise the Formal happy path",
    nonGoals: [],
    authorization: {
      git: false,
      publish: false,
      deploy: false,
      destructive: false,
    },
  });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=RunKit Test",
    "-c",
    "user.email=runkit@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
  await writeProfiles(root, [
    profileCommand("good", declaredCheck(root, "good")),
    profileCommand("bad", declaredCheck(root, "bad")),
  ]);
  assert.equal((await runCli([
    "start",
    "--workspace",
    root,
    "--run-id",
    "formal-happy",
    "--goal",
    path.join(root, "goal.json"),
    "--work-item",
    workItemId,
    "--owned-path",
    "src/**",
  ])).status, "started");
  return root;
}

test("Formal checks accumulate in one execution and finalize only once", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const first = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-001",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const second = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-002",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });

    assert.equal(first.status, "formal_check_passed");
    assert.equal(second.status, "formal_check_passed");
    assert.equal(first.finalized, false);
    assert.equal(second.finalized, false);
    await assert.rejects(access(path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy/verification-receipts/receipt-lineage.json",
    )));

    const finalized = finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "final-001",
    });
    assert.equal(finalized.status, "accepted_passed");
    assert.equal(finalized.snapshotCount, 2);
    assert.equal(finalized.staleCheckCount, 0);

    const lineage = JSON.parse(await readFile(path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy/verification-receipts/receipt-lineage.json",
    ), "utf8"));
    assert.equal(lineage.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal finish selects the active receipt candidate when several checks share one source", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-001",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const active = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-002",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const finished = await runCli([
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--decision",
      "accepted",
    ]);
    assert.equal(finished.status, "formal_finished", JSON.stringify(finished));
    const closeout = JSON.parse(await readFile(path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy/closeout-receipt.json",
    ), "utf8"));
    assert.equal(
      closeout.artifact.payload.verification.sourceArtifact.path,
      active.candidatePath,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same Formal check resumes exact create-only artifacts after every durable stage", async (t) => {
  for (const hookName of [
    "afterCandidatePersist",
    "afterRequestPersist",
    "afterSnapshotPersist",
    "afterReceiptPersist",
  ]) {
    await t.test(hookName, async () => {
      const root = await setup();
      try {
        await writeFile(path.join(root, "src/example.txt"), "candidate\n");
        assert.throws(() => recordFormalCheckV1({
          workspaceRoot: root,
          runId: "formal-happy",
          workItemId: "delivery",
          checkId: "resume-check",
          cwd: ".",
          commandArgv: declaredCheck(root, "good"),
          hooks: {
            [hookName]() {
              throw new Error(`interrupted:${hookName}`);
            },
          },
        }), new RegExp(`interrupted:${hookName}`, "u"));

        const resumed = recordFormalCheckV1({
          workspaceRoot: root,
          runId: "formal-happy",
          workItemId: "delivery",
          checkId: "resume-check",
          cwd: ".",
          commandArgv: declaredCheck(root, "good"),
        });
        assert.equal(resumed.status, "formal_check_passed");
        assert.equal(resumed.checkId, "resume-check");
        assert.equal(resumed.resumed, true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Formal check resume fails closed when an existing request differs", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    assert.throws(() => recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "mismatch-check",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
      hooks: {
        afterRequestPersist() {
          throw new Error("interrupted:request");
        },
      },
    }), /interrupted:request/u);
    const requestPath = path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy/formal-check-requests/mismatch-check.json",
    );
    const request = JSON.parse(await readFile(requestPath, "utf8"));
    request.argv = ["checks/bad.mjs"];
    await writeJson(requestPath, request);

    assert.throws(() => recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "mismatch-check",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    }), /existing Formal check request differs/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal finish resumes an exact partial finalize without rerunning finalize", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "quality",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    assert.throws(() => finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "formal-final",
      hooks: {
        beforeLineageActivate() {
          throw new Error("interrupted:before-lineage");
        },
      },
    }), /interrupted:before-lineage/u);

    const finished = await runCli([
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--decision",
      "accepted",
    ]);
    assert.equal(finished.status, "formal_finished");
    assert.equal(finished.decision, "accepted");
    const lineage = JSON.parse(await readFile(path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy/verification-receipts/receipt-lineage.json",
    ), "utf8"));
    assert.equal(lineage.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal finish with an already active exact finalize only releases and closes", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "quality",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const finalized = finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "formal-final",
    });
    assert.equal(finalized.status, "accepted_passed");

    const finished = await runCli([
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
    ]);
    assert.equal(finished.status, "formal_finished");
    assert.equal(finished.activeReceiptSha256, finalized.activeReceiptSha256);
    const lineage = JSON.parse(await readFile(path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy/verification-receipts/receipt-lineage.json",
    ), "utf8"));
    assert.equal(lineage.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same Formal finish command resumes an already closed exact result", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "quality",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const command = [
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--finalize-id",
      "formal-final",
    ];
    const first = await runCli(command);
    const resumed = await runCli(command);

    assert.equal(first.status, "formal_finished");
    assert.equal(resumed.status, "formal_finished");
    assert.equal(resumed.resumed, true);
    assert.equal(
      resumed.closeoutArtifactSha256,
      first.closeoutArtifactSha256,
    );
    assert.equal(
      resumed.activeReceiptSha256,
      first.activeReceiptSha256,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed Formal finish refuses resume after its sourceArtifact bytes change", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const checked = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "quality",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const command = [
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
    ];
    assert.equal((await runCli(command)).status, "formal_finished");
    const candidatePath = path.join(root, checked.candidatePath);
    const candidateBytes = await readFile(candidatePath, "utf8");
    await writeFile(candidatePath, `${candidateBytes}\n`);

    const resumed = await runCli(command);
    assert.equal(resumed.status, "invalid_input");
    assert.match(
      resumed.issues.join("\n"),
      /sourceArtifact bytes changed/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal finish refuses to resume a mismatched partial finalize artifact", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "quality",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    assert.throws(() => finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "formal-final",
      hooks: {
        beforeLineageActivate() {
          throw new Error("interrupted:before-lineage");
        },
      },
    }), /interrupted:before-lineage/u);
    const receiptPath = path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy/verification-receipts/formal-final-receipt/verification-receipt.json",
    );
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.sourceFingerprint = "0".repeat(64);
    await writeJson(receiptPath, receipt);

    const result = await runCli([
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /existing finalize artifact differs/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal finish rejects a forged sourceArtifact binding even when its lineage hash is recomputed", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "quality",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const finalized = finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "formal-final",
    });
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions/formal-happy",
    );
    const lineagePath = path.join(
      executionRoot,
      "verification-receipts/receipt-lineage.json",
    );
    const gateInputPath = path.join(root, finalized.gateInputPath);
    const lineage = JSON.parse(await readFile(lineagePath, "utf8"));
    const gateInput = JSON.parse(await readFile(gateInputPath, "utf8"));
    for (const entries of [lineage, gateInput.receipts]) {
      entries[0].receipt.sourceArtifact.sha256 = "0".repeat(64);
      entries[0].receiptSha256 = receiptSha256(entries[0].receipt);
    }
    await writeJson(lineagePath, lineage);
    await writeJson(gateInputPath, gateInput);

    const result = await runCli([
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--decision",
      "accepted",
    ]);
    assert.equal(result.status, "invalid_input");
    assert.match(
      result.issues.join("\n"),
      /sourceArtifact to match the selected source bytes/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source changes preserve older checks as stale evidence and finalize the current source only", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate one\n");
    const first = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-001",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    await writeFile(path.join(root, "src/example.txt"), "candidate two\n");
    const second = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-002",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    assert.notEqual(first.sourceFingerprint, second.sourceFingerprint);

    const finalized = finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "final-001",
    });
    assert.equal(finalized.status, "accepted_passed");
    assert.equal(finalized.snapshotCount, 1);
    assert.equal(finalized.staleCheckCount, 1);
    assert.equal(finalized.sourceFingerprint, second.sourceFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal accepts a deletion-only SourceCandidate V2 without a legacy DeliveryPacket", async () => {
  const root = await setup();
  try {
    await rm(path.join(root, "src/example.txt"));
    const checked = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-deletion-only",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });

    assert.equal(checked.status, "formal_check_passed");
    assert.equal(checked.deliveryPacketPath, undefined);
    const candidate = JSON.parse(await readFile(
      path.join(root, checked.candidatePath),
      "utf8",
    ));
    assert.equal(candidate.schemaVersion, "OwlCodaRunKitSourceCandidateV2");
    assert.equal(candidate.payload.blobCount, 0);
    assert.deepEqual(
      candidate.sourceManifest.entries.map((entry) => entry.operation),
      ["deleted"],
    );

    const finalized = finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "final-deletion-only",
    });
    assert.equal(finalized.status, "accepted_passed");
    assert.equal(finalized.snapshotCount, 1);
    assert.equal(finalized.sourceCandidatePath, checked.candidatePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal finalizes SourceCandidate V2 with mixed-case paths deterministically", async () => {
  const root = await setup();
  try {
    await mkdir(path.join(root, "src/assets"), { recursive: true });
    await writeFile(path.join(root, "src/SKILL.md"), "candidate skill\n");
    await writeFile(path.join(root, "src/assets/config.json"), "{}\n");
    const checked = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-mixed-case-paths",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });

    assert.equal(checked.status, "formal_check_passed");
    const finalized = finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "final-mixed-case-paths",
    });
    assert.equal(finalized.status, "accepted_passed");
    const finished = await runCli([
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--decision",
      "accepted",
    ]);
    assert.equal(finished.status, "finished");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("READY V2 preserves a deletion-only Formal SourceCandidate without a DeliveryPacket", async () => {
  const root = await setup();
  try {
    await rm(path.join(root, "src/example.txt"));
    const checked = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "ready-deletion-only",
      cwd: ".",
      commandArgv: declaredCheck(root, "good"),
    });
    const finished = await runCli([
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
    ]);
    assert.equal(finished.status, "formal_finished");

    const requestPath = path.join(root, "ready-v2-request.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitReadyForCommitRequestV2",
      sourceCandidatePath: checked.candidatePath,
      verificationGateInputPath:
        ".owlcoda/runkit/executions/formal-happy/"
        + "verification-receipts/formal-final-receipt/"
        + "verification-gate-input.json",
      roots: [{
        role: "candidate",
        snapshotPath: checked.snapshotPath,
      }],
    });
    const ready = await runCli([
      "ready-for-commit",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--request",
      requestPath,
    ]);
    assert.equal(ready.status, "ready_for_commit");

    const receipt = JSON.parse(await readFile(
      path.join(root, ready.readyReceiptPath),
      "utf8",
    ));
    assert.equal(
      receipt.schemaVersion,
      "OwlCodaRunKitReadyForCommitReceiptV2",
    );
    assert.deepEqual(receipt.sourceArtifact, {
      kind: "source_candidate_v2",
      path: checked.candidatePath,
      sha256: receipt.sourceArtifact.sha256,
      sourceFingerprint: checked.sourceFingerprint,
    });
    assert.equal(receipt.deliveryPacketPath, undefined);
    assert.equal(receipt.deliveryPacketSha256, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted Formal SourceCandidate V2 becomes the deployment prepare source artifact", async (t) => {
  for (const scenario of [
    {
      name: "ordinary modification",
      change: root => writeFile(
        path.join(root, "src/example.txt"),
        "deployable candidate\n",
      ),
      expectedOperations: ["modified"],
    },
    {
      name: "deletion only",
      change: root => rm(path.join(root, "src/example.txt")),
      expectedOperations: ["deleted"],
    },
  ]) {
    await t.test(scenario.name, async () => {
      const root = await setup();
      try {
        await scenario.change(root);
        const checked = recordFormalCheckV1({
          workspaceRoot: root,
          runId: "formal-happy",
          workItemId: "delivery",
          checkId: "deployable",
          cwd: ".",
          commandArgv: declaredCheck(root, "good"),
        });
        const finished = await runCli([
          "formal",
          "finish",
          "--workspace",
          root,
          "--run-id",
          "formal-happy",
        ]);
        assert.equal(finished.status, "formal_finished");
        await mkdir(path.join(root, "dist"), { recursive: true });
        await writeFile(path.join(root, "dist/release.tgz"), "archive");

        const receipt = createDeploymentPrepareReceiptFromClosedRun({
          workspaceRoot: root,
          prepareRunId: "formal-happy",
          artifactPath: "dist/release.tgz",
          mediaType: "application/gzip",
        });
        assert.equal(receipt.deliveryPacket, undefined);
        assert.deepEqual(receipt.sourceArtifact, {
          kind: "source_candidate_v2",
          runId: "formal-happy",
          path: checked.candidatePath,
          sha256: receipt.sourceArtifact.sha256,
          sourceFingerprint: checked.sourceFingerprint,
        });
        assert.match(receipt.sourceArtifact.sha256, /^[a-f0-9]{64}$/u);

        const candidate = JSON.parse(await readFile(
          path.join(root, checked.candidatePath),
          "utf8",
        ));
        assert.deepEqual(
          candidate.sourceManifest.entries.map(entry => entry.operation),
          scenario.expectedOperations,
        );
        const verificationReceipt = JSON.parse(await readFile(path.join(
          root,
          ".owlcoda/runkit/executions/formal-happy/verification-receipts/formal-final-receipt/verification-receipt.json",
        ), "utf8"));
        const closeout = JSON.parse(await readFile(path.join(
          root,
          ".owlcoda/runkit/executions/formal-happy/closeout-receipt.json",
        ), "utf8"));
        assert.deepEqual(
          verificationReceipt.sourceArtifact,
          receipt.sourceArtifact,
        );
        assert.deepEqual(
          closeout.artifact.payload.verification.sourceArtifact,
          receipt.sourceArtifact,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a failed latest check is preserved and cannot be finalized as accepted", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const failed = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "check-failed",
      cwd: ".",
      commandArgv: declaredCheck(root, "bad"),
    });
    assert.equal(failed.status, "formal_check_failed");
    assert.equal(failed.commandExitCode, 1);
    assert.throws(() => finalizeFormalChecksV1({
      workspaceRoot: root,
      runId: "formal-happy",
      finalizeId: "final-001",
    }), /latest source.*passed check/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Formal CLI happy path needs only start, repeatable check, and finish", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-formal-cli-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "checks"), { recursive: true });
    await writeFile(path.join(root, "src/example.txt"), "baseline\n");
    await writeFile(path.join(root, "checks/good.mjs"), "process.exit(0);\n");
    await writeFile(path.join(root, "package-lock.json"), "fixture-lock\n");
    await writeJson(path.join(root, "goal.json"), {
      schemaVersion: "OwlCodaRunKitGoalContractV1",
      objective: "use the Formal CLI happy path",
      nonGoals: [],
      authorization: {
        git: false,
        publish: false,
        deploy: false,
        destructive: false,
      },
    });
    git(root, "init", "-q");
    git(root, "add", ".");
    git(
      root,
      "-c",
      "user.name=RunKit Test",
      "-c",
      "user.email=runkit@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    await runCli(["init", "--workspace", root]);
    await writeProfiles(root, [
      profileCommand("good", declaredCheck(root, "good")),
    ]);

    const started = await runCli([
      "formal",
      "start",
      "--workspace",
      root,
      "--run-id",
      "formal-cli",
      "--goal",
      path.join(root, "goal.json"),
      "--owned-path",
      "src/**",
    ]);
    assert.equal(started.status, "started");
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const checked = await runCli([
      "formal",
      "check",
      "--workspace",
      root,
      "--run-id",
      "formal-cli",
      "--check-id",
      "quality",
      "--",
      ...declaredCheck(root, "good"),
    ]);
    assert.equal(checked.status, "formal_check_passed");
    const finished = await runCli([
      "formal",
      "finish",
      "--workspace",
      root,
      "--run-id",
      "formal-cli",
    ]);
    assert.equal(finished.status, "formal_finished");
    assert.equal(finished.decision, "accepted");
    assert.equal(finished.snapshotCount, 1);
    assert.equal(finished.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal rejects declared external side-effect commands before execution", async (t) => {
  const scenarios = [
    { executable: "npm", argv: ["publish"] },
    { executable: "npm", argv: ["unpublish", "example"] },
    { executable: "npm", argv: ["run", "deploy"] },
    { executable: "npm", argv: ["run", "db:migrate"] },
    { executable: "npm", argv: ["run", "db:reset"] },
    { executable: "npm", argv: ["run", "db:seed"] },
    { executable: "npm", argv: ["run", "prisma:migrate"] },
    { executable: "git", argv: ["-C", ".", "push", "origin", "main"] },
    { executable: "git", argv: ["tag", "v1.0.0"] },
    { executable: "ssh", argv: ["deploy.example.invalid", "true"] },
    { executable: "scp", argv: ["artifact.tgz", "deploy.example.invalid:/tmp/"] },
    { executable: "sftp", argv: ["deploy.example.invalid"] },
    { executable: "rsync", argv: ["artifact.tgz", "deploy.example.invalid:/tmp/"] },
    { executable: "curl", argv: ["https://deploy.example.invalid/hook"] },
    { executable: "wget", argv: ["https://deploy.example.invalid/hook"] },
    { executable: "vercel", argv: ["deploy", "--prod"] },
  ];

  for (const scenario of scenarios) {
    await t.test(`${scenario.executable} ${scenario.argv[0]}`, async () => {
      const root = await setup();
      try {
        const executable = path.join(root, "src", scenario.executable);
        const marker = path.join(root, `.executed-${scenario.executable}`);
        await writeFile(executable, [
          "#!/usr/bin/env node",
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(marker)}, "executed\\n");`,
          "",
        ].join("\n"));
        await chmod(executable, 0o755);
        await writeProfiles(root, [
          profileCommand("forbidden", [executable, ...scenario.argv]),
        ]);

        assert.throws(() => recordFormalCheckV1({
          workspaceRoot: root,
          runId: "formal-happy",
          workItemId: "delivery",
          checkId: `forbidden-${scenario.executable}`,
          cwd: ".",
          commandArgv: [executable, ...scenario.argv],
        }), /Formal (?:verification-only policy forbids|accepted evidence only admits)/i);
        await assert.rejects(access(marker));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("Formal rejects an undeclared executable command before execution", async () => {
  const root = await setup();
  try {
    const marker = path.join(root, ".executed-undeclared");
    const executable = path.join(root, "src", "undeclared.mjs");
    await writeFile(executable, [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(marker)}, "executed\\n");`,
      "",
    ].join("\n"));

    assert.throws(() => recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "undeclared-command",
      cwd: ".",
      commandArgv: [process.execPath, "src/undeclared.mjs"],
    }), /Formal accepted evidence only admits/i);
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal fails closed before an exact profile wrapper can write outside or use the network", async () => {
  const root = await setup();
  const marker = path.join(
    tmpdir(),
    `owlrunkit-formal-external-marker-${process.pid}-${Date.now()}`,
  );
  try {
    const wrapper = path.join(root, "src", "npm");
    await writeFile(wrapper, [
      "#!/usr/bin/env node",
      `import { writeFileSync } from "node:fs";`,
      `import { connect } from "node:net";`,
      `writeFileSync(${JSON.stringify(marker)}, "escaped\\n");`,
      "await new Promise(resolve => {",
      "  const socket = connect({ host: \"127.0.0.1\", port: 9 });",
      "  socket.once(\"connect\", () => { socket.destroy(); resolve(); });",
      "  socket.once(\"error\", resolve);",
      "  setTimeout(() => { socket.destroy(); resolve(); }, 100);",
      "});",
      "",
    ].join("\n"));
    await chmod(wrapper, 0o755);
    await writeProfiles(root, [
      profileCommand("exact-npm-test", [wrapper, "run", "test"]),
    ]);

    assert.throws(() => recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "unsafe-profile-wrapper",
      cwd: ".",
      commandArgv: [wrapper, "run", "test"],
    }), /only admits built-in safe verification/i);
    await assert.rejects(access(marker));
  } finally {
    await rm(marker, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal permits the built-in Node syntax checker without a profile declaration", async () => {
  const root = await setup();
  try {
    await writeProfiles(root, []);
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const checked = recordFormalCheckV1({
      workspaceRoot: root,
      runId: "formal-happy",
      workItemId: "delivery",
      checkId: "safe-node-check",
      cwd: ".",
      commandArgv: [process.execPath, "--check", "checks/good.mjs"],
    });

    assert.equal(checked.status, "formal_check_passed");
    assert.equal(
      checked.verificationCommandPolicy.mode,
      "built_in_safe_verification",
    );
    assert.equal(
      checked.verificationCommandPolicy.riskClassification,
      "built_in_read_only_verification",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the documented Formal happy path uses an actually admissible absolute executable", async () => {
  const readme = await readFile(new URL(
    "../packages/runkit/README.md",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(
    readme,
    /formal check[\s\S]{0,240}-- npm test/u,
  );
  assert.match(readme, /NODE_BIN="\$\(node -p 'process\.execPath'\)"/u);
  assert.match(
    readme,
    /formal start[\s\S]{0,240}--owned-path 'src\/\*\*'/u,
  );
  assert.match(
    readme,
    /formal check[\s\S]{0,320}-- "\$NODE_BIN" --check /u,
  );
});

test("Formal check uses the custom work-item accepted by Formal start", async () => {
  const root = await setup({ workItemId: "analysis" });
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const checked = await runCli([
      "formal",
      "check",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--work-item",
      "analysis",
      "--check-id",
      "custom-work-item",
      "--cwd",
      ".",
      "--",
      process.execPath,
      "--check",
      "checks/good.mjs",
    ]);
    assert.equal(checked.status, "formal_check_passed", JSON.stringify(checked));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy verify rejects known publish and deployment side effects before execution", async (t) => {
  const scenarios = [
    { executable: "npm", argv: ["publish"] },
    { executable: "npm", argv: ["unpublish", "example"] },
    { executable: "npm", argv: ["run", "deploy"] },
    { executable: "git", argv: ["-C", ".", "push", "origin", "main"] },
    { executable: "git", argv: ["tag", "v1.0.0"] },
    { executable: "ssh", argv: ["deploy.example.invalid", "true"] },
    { executable: "scp", argv: ["artifact.tgz", "deploy.example.invalid:/tmp/"] },
    { executable: "sftp", argv: ["deploy.example.invalid"] },
    { executable: "rsync", argv: ["artifact.tgz", "deploy.example.invalid:/tmp/"] },
    { executable: "curl", argv: ["https://deploy.example.invalid/hook"] },
    { executable: "wget", argv: ["https://deploy.example.invalid/hook"] },
    { executable: "vercel", argv: ["deploy", "--prod"] },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(`${scenario.executable} ${scenario.argv.join(" ")}`, async () => {
      const root = await setup();
      try {
        const executable = path.join(root, "src", scenario.executable);
        const marker = path.join(root, `.executed-legacy-${index}`);
        await writeFile(executable, [
          "#!/usr/bin/env node",
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(marker)}, "executed\\n");`,
          "",
        ].join("\n"));
        await chmod(executable, 0o755);
        await writeFile(path.join(root, "src/example.txt"), "candidate\n");

        const verified = await runCli([
          "verify",
          "--workspace",
          root,
          "--run-id",
          "formal-happy",
          "--from-lease",
          "delivery",
          "--verification-id",
          `forbidden-side-effect-${index}`,
          "--cwd",
          ".",
          "--",
          executable,
          ...scenario.argv,
        ]);

        assert.equal(verified.status, "invalid_input");
        assert.match(
          verified.issues.join("\n"),
          /verification command forbids external side effect/i,
        );
        await assert.rejects(access(marker));
        await assert.rejects(access(path.join(
          root,
          ".owlcoda/runkit/executions/formal-happy/verification-receipts/receipt-lineage.json",
        )));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("legacy verify retains ordinary inline verification compatibility", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const verified = await runCli([
      "verify",
      "--workspace",
      root,
      "--run-id",
      "formal-happy",
      "--from-lease",
      "delivery",
      "--verification-id",
      "legacy-inline-check",
      "--cwd",
      ".",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('verified\\n')",
    ]);

    assert.equal(verified.status, "verified", JSON.stringify(verified));
    assert.equal(verified.gateDecision, "accepted_passed");
    assert.equal(verified.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function formalEnvelope(root, checkScript) {
  return {
    schemaVersion: "OwlCodaRunKitVerificationEnvelopeV1",
    envelopeId: "formal-quality-v1",
    cwd: ".",
    lockfiles: ["package-lock.json"],
    paths: {
      immutableSource: ["src/**", "checks/**", "package-lock.json"],
      declaredOutput: ["artifacts/**"],
      disposableScratch: [".scratch/**"],
      forbidden: [".env", ".owlcoda/**"],
    },
    environment: { allowNames: ["PATH"], values: {} },
    network: { mode: "deny" },
    process: {
      allowSubprocesses: false,
      allowedExecutables: [],
      allowBackgroundAfterFinish: false,
    },
    phases: {
      setup: null,
      check: {
        executable: process.execPath,
        argv: [checkScript],
        timeoutMs: 5_000,
      },
      teardown: null,
    },
  };
}

test("Formal check consumes an enforced Verification Envelope and finalizes its receipt", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "checks/envelope-pass.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync("artifacts", { recursive: true });',
      'writeFileSync("artifacts/quality.json", "{}\\n");',
      "",
    ].join("\n"));
    const envelopePath = path.join(root, "formal-envelope.json");
    await writeJson(envelopePath, formalEnvelope(root, "checks/envelope-pass.mjs"));
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");

    const checked = await runCli([
      "formal", "check",
      "--workspace", root,
      "--run-id", "formal-happy",
      "--check-id", "envelope-quality",
      "--envelope", envelopePath,
    ]);
    assert.equal(checked.status, "formal_check_passed", JSON.stringify(checked));
    assert.equal(checked.verificationCommandPolicy.mode, "verification_envelope_v1");
    assert.match(checked.envelopeSha256, /^[a-f0-9]{64}$/u);
    assert.match(checked.envelopeReceiptPath, /verification-envelope-receipt\.json$/u);

    const finished = await runCli([
      "formal", "finish",
      "--workspace", root,
      "--run-id", "formal-happy",
    ]);
    assert.equal(finished.status, "formal_finished", JSON.stringify(finished));
    assert.equal(finished.decision, "accepted");
    assert.equal(finished.snapshotCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal preserves a failed envelope and refuses acceptance", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "checks/envelope-fail.mjs"), "process.exit(9);\n");
    const envelopePath = path.join(root, "formal-envelope.json");
    await writeJson(envelopePath, formalEnvelope(root, "checks/envelope-fail.mjs"));
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");

    const checked = await runCli([
      "formal", "check",
      "--workspace", root,
      "--run-id", "formal-happy",
      "--check-id", "envelope-failed",
      "--envelope", envelopePath,
    ]);
    assert.equal(checked.status, "formal_check_failed");
    assert.equal(checked.commandExitCode, 2);
    assert.equal(checked.envelopeFormalEligible, false);

    const finished = await runCli([
      "formal", "finish",
      "--workspace", root,
      "--run-id", "formal-happy",
    ]);
    assert.equal(finished.status, "invalid_input");
    assert.match(finished.issues.join("\n"), /latest source.*passed check/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Formal finish rejects a drifted Verification Envelope receipt", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "checks/envelope-pass.mjs"), "process.exit(0);\n");
    const envelopePath = path.join(root, "formal-envelope.json");
    await writeJson(envelopePath, formalEnvelope(root, "checks/envelope-pass.mjs"));
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const checked = await runCli([
      "formal", "check",
      "--workspace", root,
      "--run-id", "formal-happy",
      "--check-id", "envelope-drift",
      "--envelope", envelopePath,
    ]);
    assert.equal(checked.status, "formal_check_passed");
    const receiptPath = path.join(root, checked.envelopeReceiptPath);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.formalEligible = false;
    await writeJson(receiptPath, receipt);

    const finished = await runCli([
      "formal", "finish",
      "--workspace", root,
      "--run-id", "formal-happy",
    ]);
    assert.equal(finished.status, "invalid_input");
    assert.match(finished.issues.join("\n"), /envelope receipt hash mismatch/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
