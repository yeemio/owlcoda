import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { canonicalSourceFingerprint } from "../../scripts/runkit-contract/source-fingerprint.mjs";
import { verificationContextFingerprint } from "../../scripts/runkit-contract/verification-context.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const plannerUrl = pathToFileURL(
  path.join(repositoryRoot, "scripts/runkit-contract/verification-plan.mjs"),
).href;
const profileImpactUrl = pathToFileURL(
  path.join(repositoryRoot, "scripts/runkit-contract/profile-impact.mjs"),
).href;

const hashes = {
  sourceOld: "1".repeat(64),
  sourceNew: "2".repeat(64),
  stable: "3".repeat(64),
  dependencyOld: "4".repeat(64),
  dependencyNew: "5".repeat(64),
  context: "6".repeat(64),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptBackedCoverage(runId, entries) {
  const normalizedEntries = entries.map(entry => ({
    ...entry,
    receiptSha256: sha256(`receipt:${entry.receiptId}`),
  }));
  return {
    schemaVersion: "OwlCodaRunKitEvidenceCoverageIndexV1",
    coverageId: `${runId}-coverage`,
    runId,
    generatedFrom: normalizedEntries.map(entry => ({
      gateInputPath: `.owlcoda/runkit/executions/source-run/verification-receipts/${entry.receiptId}/verification-gate-input.json`,
      gateInputSha256: sha256(`gate:${entry.receiptId}`),
      commandBindings: entry.commandIds.map(commandId => ({
        receiptCommandId: `receipt-${commandId}`,
        profileId: entry.profileIds[0],
        commandId,
      })),
      dependencyBindings: Object.keys(entry.dependencySha256).map(dependencyId => ({
        dependencyId,
        source: { kind: "material_input", identity: dependencyId },
      })),
      activeReceiptSha256: entry.receiptSha256,
      sourceRunId: "source-run",
    })),
    entries: normalizedEntries,
    authorizationGranted: false,
  };
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

const profiles = [
  {
    id: "feature-stage",
    paths: ["src/feature.ts"],
    primary: true,
    requiresProfileIds: ["shared-audit"],
    commands: [
      { id: "feature-test", cwd: ".", executable: "node", argv: ["--test", "tests/feature.test.mjs"] },
    ],
  },
  {
    id: "lockfile-stage",
    paths: ["package-lock.json"],
    commands: [
      { id: "lockfile-test", cwd: ".", executable: "npm", argv: ["test"] },
    ],
  },
  {
    id: "shared-audit",
    paths: ["tools/shared/**"],
    commands: [
      { id: "shared-audit", cwd: ".", executable: "node", argv: ["scripts/shared-audit.mjs"] },
    ],
  },
  {
    id: "historical-broad-profile",
    role: "supporting",
    paths: ["src/**"],
    commands: [
      { id: "historical-full", cwd: ".", executable: "npm", argv: ["test"] },
    ],
  },
];

async function loadPlanner() {
  try {
    return await import(plannerUrl);
  } catch {
    return null;
  }
}

test("profile impact separates direct, transitive, and supporting matches with one primary profile", async () => {
  const profileImpact = await import(profileImpactUrl);
  assert.equal(
    typeof profileImpact.resolveProfileImpactDetailed,
    "function",
    "resolveProfileImpactDetailed must be implemented",
  );

  assert.deepEqual(profileImpact.resolveProfileImpactDetailed({
    changedPaths: ["package-lock.json", "src/feature.ts"],
    profiles,
  }), {
    decision: "targeted_profiles",
    primaryProfileId: "feature-stage",
    directProfileIds: ["feature-stage", "lockfile-stage"],
    transitiveProfileIds: ["shared-audit"],
    supportingProfileIds: ["historical-broad-profile"],
    selectedProfileIds: ["feature-stage", "lockfile-stage", "shared-audit"],
    uncoveredPaths: [],
    warnings: [],
  });
});

test("verification plan preserves reusable receipts while classifying all four drift types", async () => {
  const planner = await loadPlanner();
  assert.equal(typeof planner?.buildVerificationPlan, "function", "buildVerificationPlan must be implemented");

  const result = planner.buildVerificationPlan({
    schemaVersion: "OwlCodaRunKitVerifyPlanRequestV1",
    runId: "run-economics-fixture",
    planId: "minimum-stage",
    ownedPaths: ["src/feature.ts"],
    changedPaths: ["notes/local.md", "package-lock.json", "src/feature.ts"],
    currentSourceFiles: {
      "src/feature.ts": hashes.sourceNew,
      "src/stable.ts": hashes.stable,
    },
    dependencies: [
      {
        id: "root-lockfile",
        path: "package-lock.json",
        baselineSha256: hashes.dependencyOld,
        currentSha256: hashes.dependencyNew,
      },
    ],
    verificationContextFingerprint: hashes.context,
    profiles,
    coverageIndex: receiptBackedCoverage("run-economics-fixture", [
        {
          receiptId: "receipt-feature-old",
          status: "passed",
          sourceFiles: { "src/feature.ts": hashes.sourceOld },
          dependencySha256: { "root-lockfile": hashes.dependencyOld },
          verificationContextFingerprint: hashes.context,
          profileIds: ["feature-stage"],
          commandIds: ["feature-test"],
        },
        {
          receiptId: "receipt-lock-current",
          status: "passed",
          sourceFiles: { "src/stable.ts": hashes.stable },
          dependencySha256: { "root-lockfile": hashes.dependencyNew },
          verificationContextFingerprint: hashes.context,
          profileIds: ["lockfile-stage"],
          commandIds: ["lockfile-test"],
        },
        {
          receiptId: "receipt-shared-current",
          status: "passed",
          sourceFiles: { "src/stable.ts": hashes.stable },
          dependencySha256: {},
          verificationContextFingerprint: hashes.context,
          profileIds: ["shared-audit"],
          commandIds: ["shared-audit"],
        },
    ]),
    globalGates: [
      { id: "clean-tree", status: "failed", reason: "unrelated local notes remain" },
    ],
  });

  assert.deepEqual(result, {
    schemaVersion: "OwlCodaRunKitVerificationPlanV1",
    runId: "run-economics-fixture",
    planId: "minimum-stage",
    verificationContextFingerprint: hashes.context,
    status: "blocked_by_global_gate",
    drift: {
      leasedSourceDrift: ["src/feature.ts"],
      declaredDependencyDrift: ["root-lockfile"],
      unrelatedDirtyTreeDrift: ["notes/local.md"],
      globalGateFailures: ["clean-tree"],
    },
    profileImpact: {
      decision: "targeted_profiles",
      primaryProfileId: "feature-stage",
      directProfileIds: ["feature-stage", "lockfile-stage"],
      transitiveProfileIds: ["shared-audit"],
      supportingProfileIds: ["historical-broad-profile"],
      selectedProfileIds: ["feature-stage", "lockfile-stage", "shared-audit"],
      uncoveredPaths: [],
      warnings: [],
    },
    evidence: {
      reusableReceiptIds: ["receipt-lock-current", "receipt-shared-current"],
      invalidatedReceipts: [
        {
          receiptId: "receipt-feature-old",
          reasons: [
            "declared_dependency_drift:root-lockfile",
            "leased_source_drift:src/feature.ts",
          ],
        },
      ],
    },
    commands: {
      requiredCommandIds: ["feature-test", "lockfile-test", "shared-audit"],
      reusedCommandIds: ["lockfile-test", "shared-audit"],
      pendingCommandIds: ["feature-test"],
      unmappedProfileIds: [],
      pendingCommands: [
        {
          id: "feature-test",
          cwd: ".",
          executable: "node",
          argv: ["--test", "tests/feature.test.mjs"],
          profileIds: ["feature-stage"],
        },
      ],
    },
    acceptance: {
      blocked: true,
      reasons: ["global_gate_failure:clean-tree"],
    },
    authorizationGranted: false,
  });
});

test("supporting-only profile matches fail closed and ambiguous primary declarations remain explicit", async () => {
  const profileImpact = await import(profileImpactUrl);
  assert.equal(
    typeof profileImpact.resolveProfileImpactDetailed,
    "function",
    "resolveProfileImpactDetailed must be implemented",
  );

  const supportingOnly = profileImpact.resolveProfileImpactDetailed({
    changedPaths: ["docs/shared.md"],
    profiles: [
      { id: "history", role: "supporting", paths: ["docs/**"] },
    ],
  });
  assert.deepEqual(supportingOnly, {
    decision: "full_profile_required",
    primaryProfileId: null,
    directProfileIds: [],
    transitiveProfileIds: [],
    supportingProfileIds: ["history"],
    selectedProfileIds: [],
    uncoveredPaths: ["docs/shared.md"],
    warnings: ["supporting_only_match:docs/shared.md"],
  });

  const ambiguous = profileImpact.resolveProfileImpactDetailed({
    changedPaths: ["src/feature.ts"],
    profiles: [
      { id: "a", primary: true, paths: ["src/**"] },
      { id: "b", primary: true, paths: ["src/feature.ts"] },
    ],
  });
  assert.equal(ambiguous.primaryProfileId, null);
  assert.deepEqual(ambiguous.warnings, ["ambiguous_primary_profile:a,b"]);
});

test("runkit verify-plan recomputes workspace drift and writes a project-owned plan artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-verify-plan-"));
  const runId = "verify-plan-fixture";
  const sourceOld = "export const value = 'old';\n";
  const sourceNew = "export const value = 'new';\n";
  const lockOld = "lock-old\n";
  const lockNew = "lock-new\n";
  const context = {
    schemaVersion: "OwlCodaRunKitVerificationContextV1",
    reusePolicy: "portable",
    platform: null,
    toolchains: [{ name: "node", version: process.version }],
    lockfiles: [],
    fixtures: [],
    services: [],
    environment: [],
  };

  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/feature.ts"), sourceOld);
    await writeFile(path.join(root, "package-lock.json"), lockOld);
    await writeFile(path.join(root, "goal.json"), "{}\n");
    git(root, "init");
    git(root, "add", "src/feature.ts", "package-lock.json", "goal.json");
    git(root, "-c", "user.name=RunKit Test", "-c", "user.email=runkit@example.invalid", "commit", "-m", "fixture");

    const initialized = await runCli(["init", "--workspace", root]);
    assert.equal(initialized.status, "initialized");
    await writeFile(path.join(root, ".owlcoda/runkit/profiles.json"), `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitProfilesV1",
      profiles,
    }, null, 2)}\n`);
    const planned = await runCli([
      "plan", "--workspace", root,
      "--run-id", runId,
      "--goal", path.join(root, "goal.json"),
    ]);
    assert.equal(planned.status, "planned");

    const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
    await writeFile(path.join(executionRoot, "leases/W1.json"), `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/feature.ts"],
      state: "active",
    }, null, 2)}\n`);
    const sourceFiles = { "src/feature.ts": sha256(sourceOld) };
    const packet = {
      schemaVersion: "ExecutionDeliveryPacketV1",
      runId,
      status: "ready_for_stage_verification",
      changedFiles: { wholeFileSha256: sourceFiles },
      sourceFingerprint: { sha256: canonicalSourceFingerprint(sourceFiles) },
    };
    const packetPath = path.join(executionRoot, "delivery-packets/candidate.json");
    await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

    await writeFile(path.join(root, "src/feature.ts"), sourceNew);
    await writeFile(path.join(root, "package-lock.json"), lockNew);
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(root, "notes/local.md"), "local only\n");

    const coveragePath = path.join(executionRoot, "coverage-indexes/empty.json");
    await mkdir(path.dirname(coveragePath), { recursive: true });
    await writeFile(
      coveragePath,
      `${JSON.stringify(receiptBackedCoverage(runId, []), null, 2)}\n`,
    );
    const requestPath = path.join(executionRoot, "verify-plan-request.json");
    await writeFile(requestPath, `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitVerifyPlanRequestV1",
      planId: "minimum-stage",
      deliveryPacketPath: path.relative(root, packetPath),
      statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
      dependencies: [
        {
          id: "root-lockfile",
          path: "package-lock.json",
          baselineSha256: sha256(lockOld),
        },
      ],
      verificationContext: context,
      coverageIndexPath: path.relative(root, coveragePath),
      coverageIndexSha256: sha256(await readFile(coveragePath)),
      globalGates: [{ id: "clean-tree", status: "passed" }],
    }, null, 2)}\n`);

    const result = await runCli([
      "verify-plan", "--workspace", root,
      "--run-id", runId,
      "--request", requestPath,
    ]);
    assert.equal(result.status, "verification_plan_written");
    assert.equal(result.exitCode, 0);
    assert.equal(result.authorizationGranted, false);

    const plan = JSON.parse(await readFile(path.join(root, result.planPath), "utf8"));
    assert.equal(plan.status, "verification_required");
    assert.deepEqual(plan.drift, {
      leasedSourceDrift: ["src/feature.ts"],
      declaredDependencyDrift: ["root-lockfile"],
      unrelatedDirtyTreeDrift: ["notes/local.md"],
      globalGateFailures: [],
    });
    assert.deepEqual(plan.commands.pendingCommandIds, [
      "feature-test",
      "lockfile-test",
      "shared-audit",
    ]);
    assert.equal(plan.authorizationGranted, false);
    assert.equal(
      verificationContextFingerprint(context),
      plan.verificationContextFingerprint,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing declared dependency is recorded as drift instead of rejected as invalid input", async () => {
  const planner = await loadPlanner();
  const result = planner.buildVerificationPlan({
    schemaVersion: "OwlCodaRunKitVerifyPlanRequestV1",
    runId: "missing-dependency-fixture",
    planId: "minimum-stage",
    ownedPaths: ["src/feature.ts"],
    changedPaths: ["package-lock.json"],
    currentSourceFiles: { "src/stable.ts": hashes.stable },
    dependencies: [
      {
        id: "root-lockfile",
        path: "package-lock.json",
        baselineSha256: hashes.dependencyOld,
        currentSha256: null,
      },
    ],
    verificationContextFingerprint: hashes.context,
    profiles,
    coverageIndex: receiptBackedCoverage("missing-dependency-fixture", [
        {
          receiptId: "receipt-lock-old",
          status: "passed",
          sourceFiles: { "src/stable.ts": hashes.stable },
          dependencySha256: { "root-lockfile": hashes.dependencyOld },
          verificationContextFingerprint: hashes.context,
          profileIds: ["lockfile-stage"],
          commandIds: ["lockfile-test"],
        },
    ]),
    globalGates: [],
  });

  assert.deepEqual(result.drift.declaredDependencyDrift, ["root-lockfile"]);
  assert.deepEqual(result.evidence.invalidatedReceipts, [
    {
      receiptId: "receipt-lock-old",
      reasons: ["declared_dependency_drift:root-lockfile"],
    },
  ]);
  assert.equal(result.status, "verification_required");
});

test("coverage cannot reuse a command owned by a different profile", async () => {
  const planner = await loadPlanner();
  assert.throws(
    () => planner.buildVerificationPlan({
      schemaVersion: "OwlCodaRunKitVerifyPlanRequestV1",
      runId: "forged-coverage-fixture",
      planId: "minimum-stage",
      ownedPaths: ["src/feature.ts"],
      changedPaths: ["src/feature.ts"],
      currentSourceFiles: { "src/feature.ts": hashes.sourceNew },
      dependencies: [],
      verificationContextFingerprint: hashes.context,
      profiles,
      coverageIndex: receiptBackedCoverage("forged-coverage-fixture", [
          {
            receiptId: "receipt-forged",
            status: "passed",
            sourceFiles: { "src/feature.ts": hashes.sourceNew },
            dependencySha256: {},
            verificationContextFingerprint: hashes.context,
            profileIds: ["feature-stage"],
            commandIds: ["lockfile-test"],
          },
      ]),
      globalGates: [],
    }),
    /Coverage command lockfile-test is not owned by its declared profiles/,
  );
});

test("a selected profile without command metadata blocks instead of reporting ready to finalize", async () => {
  const planner = await loadPlanner();
  const result = planner.buildVerificationPlan({
    schemaVersion: "OwlCodaRunKitVerifyPlanRequestV1",
    runId: "unmapped-profile-fixture",
    planId: "minimum-stage",
    ownedPaths: ["src/feature.ts"],
    changedPaths: ["src/feature.ts"],
    currentSourceFiles: { "src/feature.ts": hashes.sourceNew },
    dependencies: [],
    verificationContextFingerprint: hashes.context,
    profiles: [{ id: "unmapped-stage", paths: ["src/**"] }],
    coverageIndex: receiptBackedCoverage("unmapped-profile-fixture", []),
    globalGates: [],
  });

  assert.equal(result.status, "verification_mapping_required");
  assert.deepEqual(result.commands, {
    requiredCommandIds: [],
    reusedCommandIds: [],
    pendingCommandIds: [],
    unmappedProfileIds: ["unmapped-stage"],
    pendingCommands: [],
  });
  assert.deepEqual(result.acceptance, {
    blocked: true,
    reasons: ["verification_command_mapping_missing:unmapped-stage"],
  });
});

test("more than ten direct profile matches emit a machine-readable breadth warning", async () => {
  const profileImpact = await import(profileImpactUrl);
  const broadProfiles = Array.from({ length: 11 }, (_, index) => ({
    id: `profile-${String(index).padStart(2, "0")}`,
    primary: index === 0,
    paths: ["src/**"],
  }));
  const result = profileImpact.resolveProfileImpactDetailed({
    changedPaths: ["src/feature.ts"],
    profiles: broadProfiles,
  });

  assert.equal(result.primaryProfileId, "profile-00");
  assert.ok(result.warnings.includes("broad_profile_match:11"));
});
