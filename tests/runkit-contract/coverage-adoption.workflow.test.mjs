import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { receiptSha256 } from "../../scripts/runkit-contract/receipt-lineage.mjs";
import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { canonicalSourceFingerprint } from "../../scripts/runkit-contract/source-fingerprint.mjs";
import { verificationContextFingerprint } from "../../scripts/runkit-contract/verification-context.mjs";
import { validateVerificationReceiptGate } from "../../scripts/runkit-contract/verification-receipt-gate.mjs";

const emptySha256 = sha256("");

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

function verificationContext(lockHash) {
  return {
    schemaVersion: "OwlCodaRunKitVerificationContextV1",
    reusePolicy: "portable",
    platform: null,
    toolchains: [{ name: "node", version: process.version }],
    lockfiles: [{ path: "package-lock.json", sha256: lockHash }],
    fixtures: [],
    services: [],
    environment: [],
  };
}

function profiles(argv = ["--test", "tests/feature.test.mjs"]) {
  return [{
    id: "feature-stage",
    paths: ["src/feature.ts"],
    primary: true,
    commands: [{ id: "feature-test", cwd: ".", executable: "node", argv }],
  }];
}

function gateFixture({ sourceHash, lockHash }) {
  const context = verificationContext(lockHash);
  const sourceFingerprint = canonicalSourceFingerprint({ "src/feature.ts": sourceHash });
  const receipt = {
    schemaVersion: "OwlCodaRunKitVerificationReceiptV2",
    runId: "parent-run",
    receiptId: "parent-feature-receipt",
    status: "passed",
    sourceFingerprint,
    verificationContextFingerprint: verificationContextFingerprint(context),
    selectedProfileIds: ["feature-stage"],
    commandRuns: 1,
    commandReceipts: [{
      id: "feature-snapshot",
      evidence: {
        schemaVersion: "OwlCodaRunKitReplayableEvidenceV1",
        kind: "shell",
        cwd: ".",
        launcher: { executable: "/usr/local/bin/node", version: "fixture-node" },
        argv: ["/usr/local/bin/node", "--test", "tests/feature.test.mjs"],
        toolVersions: [{ name: "node", version: process.version }],
        materialInputs: [{ id: "src/feature.ts", sha256: sourceHash }],
        outputArtifacts: [],
      },
      exitCode: 0,
      stdoutSha256: emptySha256,
      stderrSha256: emptySha256,
    }],
  };
  return {
    contractVersion: "0.2",
    receipts: [{ receiptSha256: receiptSha256(receipt), receipt }],
    sourceGate: {
      status: "valid",
      exitCode: 0,
      declaredFingerprint: sourceFingerprint,
      recomputedFingerprint: sourceFingerprint,
    },
    profileImpact: {
      decision: "targeted_profiles",
      profileIds: ["feature-stage"],
      uncoveredPaths: [],
    },
    verificationContext: context,
  };
}

async function setupFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-coverage-adopt-"));
  const runId = "coverage-adopt-current";
  const sourceOld = "export const value = 'old';\n";
  const sourceNew = "export const value = 'new';\n";
  const lock = "lock-current\n";
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/feature.ts"), sourceOld);
  await writeFile(path.join(root, "package-lock.json"), lock);
  await writeFile(path.join(root, "goal.json"), "{}\n");
  git(root, "init");
  git(root, "add", "src/feature.ts", "package-lock.json", "goal.json");
  git(root, "-c", "user.name=RunKit Test", "-c", "user.email=runkit@example.invalid", "commit", "-m", "fixture");

  assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
  await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: profiles(),
  });
  assert.equal((await runCli([
    "plan", "--workspace", root,
    "--run-id", runId,
    "--goal", path.join(root, "goal.json"),
  ])).status, "planned");

  const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
  await writeJson(path.join(executionRoot, "leases/W1.json"), {
    schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
    workItemId: "W1",
    attempt: 1,
    ownedPaths: ["src/feature.ts"],
    state: "active",
  });
  await writeFile(path.join(root, "src/feature.ts"), sourceNew);
  const sourceHash = sha256(sourceNew);
  const lockHash = sha256(lock);
  const gate = gateFixture({ sourceHash, lockHash });
  assert.equal(validateVerificationReceiptGate(gate).accepted, true);
  const gatePath = path.join(
    root,
    ".owlcoda/runkit/executions/parent-run/verification-receipts/final/verification-gate-input.json",
  );
  await writeJson(gatePath, gate);
  const gateInputSha256 = sha256(await readFile(gatePath));
  const request = {
    schemaVersion: "OwlCodaRunKitCoverageAdoptRequestV1",
    coverageId: "parent-feature-coverage",
    sources: [{
      gateInputPath: path.relative(root, gatePath),
      gateInputSha256,
      commandBindings: [{
        receiptCommandId: "feature-snapshot",
        profileId: "feature-stage",
        commandId: "feature-test",
      }],
      dependencyBindings: [{
        dependencyId: "root-lockfile",
        source: { kind: "lockfile", identity: "package-lock.json" },
      }],
    }],
  };
  const requestPath = path.join(executionRoot, "coverage-adopt-request.json");
  await writeJson(requestPath, request);
  return {
    root,
    runId,
    executionRoot,
    sourceHash,
    lockHash,
    gate,
    gatePath,
    gateInputSha256,
    request,
    requestPath,
  };
}

test("coverage-adopt derives reusable coverage from a hashed accepted gate artifact", async () => {
  const fixture = await setupFixture();
  try {
    const result = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", fixture.requestPath,
    ]);
    assert.equal(result.status, "coverage_index_written");
    assert.equal(result.authorizationGranted, false);
    const coverage = JSON.parse(await readFile(path.join(fixture.root, result.coverageIndexPath), "utf8"));
    const activeReceipt = fixture.gate.receipts[0];
    assert.deepEqual(coverage, {
      schemaVersion: "OwlCodaRunKitEvidenceCoverageIndexV1",
      coverageId: "parent-feature-coverage",
      runId: fixture.runId,
      generatedFrom: [{
        gateInputPath: path.relative(fixture.root, fixture.gatePath),
        gateInputSha256: fixture.gateInputSha256,
        commandBindings: fixture.request.sources[0].commandBindings,
        dependencyBindings: fixture.request.sources[0].dependencyBindings,
        activeReceiptSha256: activeReceipt.receiptSha256,
        sourceRunId: "parent-run",
      }],
      entries: [{
        receiptId: "parent-feature-receipt",
        receiptSha256: activeReceipt.receiptSha256,
        status: "passed",
        sourceFiles: { "src/feature.ts": fixture.sourceHash },
        dependencySha256: { "root-lockfile": fixture.lockHash },
        verificationContextFingerprint: verificationContextFingerprint(
          fixture.gate.verificationContext,
        ),
        profileIds: ["feature-stage"],
        commandIds: ["feature-test"],
      }],
      authorizationGranted: false,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("coverage-adopt can issue an empty project-owned index when no receipts exist", async () => {
  const fixture = await setupFixture();
  try {
    const requestPath = path.join(fixture.executionRoot, "coverage-empty.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitCoverageAdoptRequestV1",
      coverageId: "no-prior-receipts",
      sources: [],
    });
    const result = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "coverage_index_written");
    const coverage = JSON.parse(await readFile(path.join(fixture.root, result.coverageIndexPath), "utf8"));
    assert.deepEqual(coverage.generatedFrom, []);
    assert.deepEqual(coverage.entries, []);
    assert.equal(coverage.authorizationGranted, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("coverage-adopt rejects a changed gate hash and an exact command mismatch", async () => {
  const fixture = await setupFixture();
  try {
    const badHashPath = path.join(fixture.executionRoot, "coverage-bad-hash.json");
    await writeJson(badHashPath, {
      ...fixture.request,
      coverageId: "bad-hash",
      sources: [{ ...fixture.request.sources[0], gateInputSha256: "0".repeat(64) }],
    });
    const badHash = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", badHashPath,
    ]);
    assert.equal(badHash.status, "invalid_input");
    assert.match(badHash.issues.join("\n"), /gate input hash mismatch/i);

    await writeJson(path.join(fixture.root, ".owlcoda/runkit/profiles.json"), {
      schemaVersion: "OwlCodaRunKitProfilesV1",
      profiles: profiles(["--test", "tests/different.test.mjs"]),
    });
    const mismatchPath = path.join(fixture.executionRoot, "coverage-command-mismatch.json");
    await writeJson(mismatchPath, { ...fixture.request, coverageId: "command-mismatch" });
    const mismatch = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", mismatchPath,
    ]);
    assert.equal(mismatch.status, "invalid_input");
    assert.match(mismatch.issues.join("\n"), /exact command evidence mismatch/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("coverage-adopt rejects deferred receipt truth and a dependency absent from evidence", async () => {
  const fixture = await setupFixture();
  try {
    const deferredGate = structuredClone(fixture.gate);
    deferredGate.receipts[0].receipt.status = "ready_for_verification";
    deferredGate.receipts[0].receiptSha256 = receiptSha256(deferredGate.receipts[0].receipt);
    const deferredPath = path.join(
      fixture.root,
      ".owlcoda/runkit/executions/parent-run/verification-receipts/deferred/verification-gate-input.json",
    );
    await writeJson(deferredPath, deferredGate);
    const deferredRequestPath = path.join(fixture.executionRoot, "coverage-deferred.json");
    await writeJson(deferredRequestPath, {
      ...fixture.request,
      coverageId: "deferred",
      sources: [{
        ...fixture.request.sources[0],
        gateInputPath: path.relative(fixture.root, deferredPath),
        gateInputSha256: sha256(await readFile(deferredPath)),
      }],
    });
    const deferred = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", deferredRequestPath,
    ]);
    assert.equal(deferred.status, "invalid_input");
    assert.match(deferred.issues.join("\n"), /not an accepted Contract v0\.2 gate/i);

    const missingDependencyPath = path.join(fixture.executionRoot, "coverage-missing-dependency.json");
    await writeJson(missingDependencyPath, {
      ...fixture.request,
      coverageId: "missing-dependency",
      sources: [{
        ...fixture.request.sources[0],
        dependencyBindings: [{
          dependencyId: "missing-fixture",
          source: { kind: "fixture", identity: "not-recorded" },
        }],
      }],
    });
    const missingDependency = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", missingDependencyPath,
    ]);
    assert.equal(missingDependency.status, "invalid_input");
    assert.match(missingDependency.issues.join("\n"), /dependency evidence is missing/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("verify-plan consumes a hashed project-owned coverage artifact instead of inline claims", async () => {
  const fixture = await setupFixture();
  try {
    const adopted = await runCli([
      "coverage-adopt", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", fixture.requestPath,
    ]);
    assert.equal(adopted.status, "coverage_index_written");
    const coveragePath = path.join(fixture.root, adopted.coverageIndexPath);
    const coverageIndexSha256 = sha256(await readFile(coveragePath));
    const packet = {
      schemaVersion: "ExecutionDeliveryPacketV1",
      runId: fixture.runId,
      status: "ready_for_stage_verification",
      changedFiles: { wholeFileSha256: { "src/feature.ts": fixture.sourceHash } },
      sourceFingerprint: {
        sha256: canonicalSourceFingerprint({ "src/feature.ts": fixture.sourceHash }),
      },
    };
    const packetPath = path.join(fixture.executionRoot, "delivery-packets/candidate.json");
    await writeJson(packetPath, packet);
    const verifyRequestPath = path.join(fixture.executionRoot, "verify-plan-request.json");
    await writeJson(verifyRequestPath, {
      schemaVersion: "OwlCodaRunKitVerifyPlanRequestV1",
      planId: "reuse-parent-feature",
      deliveryPacketPath: path.relative(fixture.root, packetPath),
      statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
      dependencies: [{
        id: "root-lockfile",
        path: "package-lock.json",
        baselineSha256: fixture.lockHash,
      }],
      verificationContext: fixture.gate.verificationContext,
      coverageIndexPath: adopted.coverageIndexPath,
      coverageIndexSha256,
      globalGates: [],
    });

    const result = await runCli([
      "verify-plan", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", verifyRequestPath,
    ]);
    assert.equal(result.status, "verification_plan_written", JSON.stringify(result));
    const plan = JSON.parse(await readFile(path.join(fixture.root, result.planPath), "utf8"));
    assert.equal(plan.status, "ready_to_finalize");
    assert.equal(plan.evidence.coverageIndexPath, adopted.coverageIndexPath);
    assert.equal(plan.evidence.coverageIndexSha256, coverageIndexSha256);
    assert.deepEqual(plan.commands.reusedCommandIds, ["feature-test"]);
    assert.deepEqual(plan.commands.pendingCommandIds, []);

    const misplacedCoveragePath = path.join(fixture.root, ".owlcoda/runkit/misplaced-coverage.json");
    await writeFile(misplacedCoveragePath, await readFile(coveragePath));
    const misplacedRequestPath = path.join(fixture.executionRoot, "verify-plan-misplaced-coverage.json");
    await writeJson(misplacedRequestPath, {
      ...JSON.parse(await readFile(verifyRequestPath, "utf8")),
      planId: "misplaced-coverage-must-fail",
      coverageIndexPath: path.relative(fixture.root, misplacedCoveragePath),
    });
    const misplaced = await runCli([
      "verify-plan", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", misplacedRequestPath,
    ]);
    assert.equal(misplaced.status, "invalid_input");
    assert.match(misplaced.issues.join("\n"), /active execution coverage-indexes/i);

    const originalCoverageBytes = await readFile(coveragePath);
    const forgedCoverage = JSON.parse(originalCoverageBytes.toString("utf8"));
    forgedCoverage.entries[0].sourceFiles["src/feature.ts"] = "f".repeat(64);
    await writeJson(coveragePath, forgedCoverage);
    const forgedRequestPath = path.join(fixture.executionRoot, "verify-plan-forged-coverage.json");
    await writeJson(forgedRequestPath, {
      ...JSON.parse(await readFile(verifyRequestPath, "utf8")),
      planId: "forged-coverage-must-fail",
      coverageIndexSha256: sha256(await readFile(coveragePath)),
    });
    const forged = await runCli([
      "verify-plan", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", forgedRequestPath,
    ]);
    assert.equal(forged.status, "invalid_input");
    assert.match(forged.issues.join("\n"), /no longer matches its receipt-backed source evidence/i);
    await writeFile(coveragePath, originalCoverageBytes);

    const originalGateBytes = await readFile(fixture.gatePath);
    await writeFile(fixture.gatePath, Buffer.concat([originalGateBytes, Buffer.from("\n")]));
    const changedGateRequestPath = path.join(fixture.executionRoot, "verify-plan-changed-gate.json");
    await writeJson(changedGateRequestPath, {
      ...JSON.parse(await readFile(verifyRequestPath, "utf8")),
      planId: "changed-gate-must-fail",
    });
    const changedGate = await runCli([
      "verify-plan", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", changedGateRequestPath,
    ]);
    assert.equal(changedGate.status, "invalid_input");
    assert.match(changedGate.issues.join("\n"), /gate input hash mismatch/i);
    await writeFile(fixture.gatePath, originalGateBytes);

    await writeFile(coveragePath, Buffer.concat([originalCoverageBytes, Buffer.from("\n")]));
    const mutatedRequestPath = path.join(fixture.executionRoot, "verify-plan-mutated-coverage.json");
    await writeJson(mutatedRequestPath, {
      ...JSON.parse(await readFile(verifyRequestPath, "utf8")),
      planId: "mutated-coverage-must-fail",
    });
    const mutated = await runCli([
      "verify-plan", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", mutatedRequestPath,
    ]);
    assert.equal(mutated.status, "invalid_input");
    assert.match(mutated.issues.join("\n"), /coverage index hash mismatch/i);

    const inlinePath = path.join(fixture.executionRoot, "verify-plan-inline.json");
    await writeJson(inlinePath, {
      ...JSON.parse(await readFile(verifyRequestPath, "utf8")),
      planId: "inline-must-fail",
      coverageIndexPath: undefined,
      coverageIndexSha256: undefined,
      coverageIndex: JSON.parse(await readFile(coveragePath, "utf8")),
    });
    const inline = await runCli([
      "verify-plan", "--workspace", fixture.root,
      "--run-id", fixture.runId,
      "--request", inlinePath,
    ]);
    assert.equal(inline.status, "invalid_input");
    assert.match(inline.issues.join("\n"), /coverageIndexPath|unsupported field/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
