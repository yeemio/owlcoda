import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { receiptSha256 } from "../../scripts/runkit-contract/receipt-lineage.mjs";
import { validateReplayableEvidence } from "../../scripts/runkit-contract/acceptance-evidence.mjs";
import { validateVerificationReceiptGate } from "../../scripts/runkit-contract/verification-receipt-gate.mjs";
import {
  currentCoreIdentity,
  validateCoreArtifact,
} from "../../scripts/runkit-contract/core-contract.mjs";

const cliPath = fileURLToPath(
  new URL("../../scripts/runkit-contract/runkit-cli.mjs", import.meta.url),
);

const legacyCoreIdentity = {
  contractVersion: "0.1",
  coreVersion: "0.1.0",
  coreManifestSha256: `sha256:${"1".repeat(64)}`,
  coreSourceRef: `artifact:sha256:${"1".repeat(64)}`,
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runCli(args) {
  const machineArgs = args[0] === "init" && !args.includes("--json")
    ? [...args, "--json"]
    : args;
  const completed = spawnSync(process.execPath, [cliPath, ...machineArgs], {
    encoding: "utf8",
  });
  return {
    ...completed,
    json: completed.stdout ? JSON.parse(completed.stdout) : null,
  };
}

function legacyCloseoutReceipt(runId) {
  const artifact = {
    schemaVersion: "RunKitCoreArtifactV1",
    core: legacyCoreIdentity,
    producer: { adapterKind: "codex", adapterVersion: "0.1.0" },
    payload: { runId, decision: "accepted", authorizationGranted: false },
    extensions: { "dev.owlcoda.adapter.codex": {} },
  };
  const validated = validateCoreArtifact(artifact);
  assert.equal(validated.valid, true);
  return {
    artifact,
    acceptanceSha256: validated.acceptanceSha256,
    artifactSha256: validated.artifactSha256,
  };
}

async function writeLegacyExecution(root, runId, { closed }) {
  const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
  await mkdir(executionRoot, { recursive: true });
  await writeFile(
    path.join(executionRoot, "engine-pin.json"),
    `${JSON.stringify(legacyCoreIdentity, null, 2)}\n`,
  );
  if (closed) {
    await writeFile(
      path.join(executionRoot, "closeout-receipt.json"),
      `${JSON.stringify(legacyCloseoutReceipt(runId), null, 2)}\n`,
    );
  }
}

async function plannedWorkspace(prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const goalPath = path.join(root, "goal.json");
  await writeFile(goalPath, "{}\n");
  assert.equal(runCli(["init", "--workspace", root]).status, 0);
  assert.equal(runCli([
    "plan",
    "--workspace", root,
    "--run-id", "contract-v02-fixture",
    "--goal", goalPath,
  ]).status, 0);
  return root;
}

async function loadVerificationContext() {
  try {
    return await import("../../scripts/runkit-contract/verification-context.mjs");
  } catch (error) {
    assert.fail(`verification-context module must be importable: ${error.message}`);
  }
}

async function loadJsonFixture(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    assert.fail(`JSON contract fixture must be readable: ${filePath}: ${error.message}`);
  }
}

function portableContext(overrides = {}) {
  return {
    schemaVersion: "OwlCodaRunKitVerificationContextV1",
    reusePolicy: "portable",
    platform: null,
    toolchains: [
      { name: "node", version: "20.20.1" },
      { name: "npm", version: "10.8.2" },
    ],
    lockfiles: [
      { path: "desktop/osui/package-lock.json", sha256: "d".repeat(64) },
      { path: "package-lock.json", sha256: "e".repeat(64) },
    ],
    fixtures: [],
    services: [],
    environment: [],
    ...overrides,
  };
}

function replayableShellCommandReceipt() {
  return {
    evidence: {
      schemaVersion: "OwlCodaRunKitReplayableEvidenceV1",
      kind: "shell",
      cwd: ".",
      launcher: {
        executable: process.execPath,
        version: process.version,
      },
      argv: [process.execPath, "--test", "tests/runkit-contract/contract-v02.conformance.test.mjs"],
      toolVersions: [{ name: "node", version: process.version }],
      materialInputs: [],
      outputArtifacts: [],
    },
    exitCode: 0,
    stdoutSha256: "b".repeat(64),
    stderrSha256: "c".repeat(64),
  };
}

function passingLegacyGateInput() {
  const sourceFingerprint = "a".repeat(64);
  const receipt = {
    receiptId: "contract-v02-gate-fixture",
    status: "passed",
    sourceFingerprint,
    selectedProfileIds: ["contract-v02"],
    commandRuns: 1,
    commandReceipts: [{
      command: "node --test contract-v02",
      exitCode: 0,
      stdoutSha256: "b".repeat(64),
      stderrSha256: "c".repeat(64),
    }],
  };
  return {
    receipts: [{ receiptSha256: receiptSha256(receipt), receipt }],
    sourceGate: {
      status: "valid",
      exitCode: 0,
      declaredFingerprint: sourceFingerprint,
      recomputedFingerprint: sourceFingerprint,
    },
    profileImpact: {
      decision: "targeted_profiles",
      profileIds: ["contract-v02"],
      uncoveredPaths: [],
    },
  };
}

async function passingV02GateInput({
  context = portableContext(),
  receiptContext = context,
} = {}) {
  const { verificationContextFingerprint } = await loadVerificationContext();
  const input = passingLegacyGateInput();
  const receipt = {
    ...input.receipts[0].receipt,
    schemaVersion: "OwlCodaRunKitVerificationReceiptV2",
    runId: "contract-v02-fixture",
    verificationContextFingerprint: verificationContextFingerprint(receiptContext),
    commandReceipts: [replayableShellCommandReceipt()],
  };
  return {
    ...input,
    contractVersion: "0.2",
    verificationContext: context,
    receipts: [{ receiptSha256: receiptSha256(receipt), receipt }],
  };
}

test("Contract v0.2 rejects accepted closeout without a verification gate input", async () => {
  const root = await plannedWorkspace("owlcoda-runkit-v02-closeout-");
  try {
    const completed = runCli([
      "closeout",
      "--workspace", root,
      "--run-id", "contract-v02-fixture",
      "--decision", "accepted",
    ]);

    assert.equal(completed.status, 2, completed.stderr);
    assert.equal(completed.json.status, "closeout_gate_rejected");
    assert.match(completed.json.issues.join("\n"), /gate input.*required/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative Core and new project configuration identify Contract v0.2", async () => {
  assert.equal(currentCoreIdentity().contractVersion, "0.2");
  assert.equal(currentCoreIdentity().coreVersion, "0.18.0");
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-v02-config-"));
  try {
    const initialized = runCli(["init", "--workspace", root]);
    assert.equal(initialized.status, 0, initialized.stderr);
    const config = JSON.parse(await readFile(
      path.join(root, ".owlcoda/runkit/config.json"),
      "utf8",
    ));
    assert.equal(config.schemaVersion, "OwlCodaRunKitConfigV2");
    assert.equal(config.core.contractVersion, "0.2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect keeps a closed Contract v0.1 execution readable under the current Core", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-v01-history-"));
  try {
    assert.equal(runCli(["init", "--workspace", root]).status, 0);
    await writeLegacyExecution(root, "legacy-closed", { closed: true });

    const inspected = runCli(["inspect", "--json", "--workspace", root]);

    assert.equal(inspected.status, 0, inspected.stderr);
    assert.equal(inspected.json.exitCode, 0);
    assert.deepEqual(inspected.json.executions[0], {
      runId: "legacy-closed",
      lifecycle: "closed",
      historical: true,
      enginePin: { status: "valid", exitCode: 0, issues: [] },
      closeout: {
        status: "valid",
        decision: "accepted",
        authorizationGranted: false,
      },
      recovery: {
        lease: {
          status: "none",
          workItemIds: [],
          activeWorkItemIds: [],
          releasedWorkItemIds: [],
          preservedInactiveWorkItemIds: [],
          issues: [],
        },
        delivery: { status: "not_applicable", issues: [] },
        verification: { status: "not_applicable", issues: [] },
        evidenceTrustLevel: "closed_accepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
        resourcePreflight: { status: "none", selected: null, issues: [] },
      },
      controlState: {
        lifecycle: "closed",
        historical: true,
        closeout: {
          decision: "accepted",
          trusted: true,
        },
        lease: {
          status: "none",
          workItemIds: [],
          activeWorkItemIds: [],
          releasedWorkItemIds: [],
          preservedInactiveWorkItemIds: [],
          issues: [],
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspect still rejects an active execution whose engine pin is stale", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-v01-active-"));
  try {
    assert.equal(runCli(["init", "--workspace", root]).status, 0);
    await writeLegacyExecution(root, "legacy-active", { closed: false });

    const inspected = runCli(["inspect", "--json", "--workspace", root]);

    assert.equal(inspected.status, 2, inspected.stderr);
    assert.equal(inspected.json.executions[0].lifecycle, "active");
    assert.equal(
      inspected.json.executions[0].enginePin.status,
      "engine_changed_during_execution",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init atomically migrates ConfigV1 and records authorization-free project truth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-v01-config-"));
  try {
    const runtimeRoot = path.join(root, ".owlcoda/runkit");
    await mkdir(path.join(runtimeRoot, "executions"), { recursive: true });
    await writeFile(
      path.join(runtimeRoot, "config.json"),
      `${JSON.stringify({
        schemaVersion: "OwlCodaRunKitConfigV1",
        core: legacyCoreIdentity,
        authorizationPolicy: "external_explicit_authority_required",
      }, null, 2)}\n`,
    );
    await writeFile(
      path.join(runtimeRoot, "profiles.json"),
      `${JSON.stringify({ schemaVersion: "OwlCodaRunKitProfilesV1", profiles: [] }, null, 2)}\n`,
    );

    const initialized = runCli(["init", "--workspace", root]);

    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(initialized.json.status, "upgraded");
    const config = JSON.parse(await readFile(path.join(runtimeRoot, "config.json"), "utf8"));
    assert.equal(config.schemaVersion, "OwlCodaRunKitConfigV2");
    assert.deepEqual(config.core, currentCoreIdentity());
    const receipt = JSON.parse(await readFile(
      path.join(runtimeRoot, "config-migration-receipts/config-v01-to-v02.json"),
      "utf8",
    ));
    assert.equal(receipt.schemaVersion, "OwlCodaRunKitConfigMigrationReceiptV1");
    assert.equal(receipt.migration, "config-v01-to-v02");
    assert.deepEqual(receipt.fromCore, legacyCoreIdentity);
    assert.deepEqual(receipt.toCore, currentCoreIdentity());
    assert.equal(receipt.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init refreshes a ConfigV2 project when only the Core patch identity changed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-v02-refresh-"));
  try {
    const runtimeRoot = path.join(root, ".owlcoda/runkit");
    await mkdir(path.join(runtimeRoot, "executions"), { recursive: true });
    const previousCore = {
      contractVersion: "0.2",
      coreVersion: "0.2.0",
      coreManifestSha256: `sha256:${"2".repeat(64)}`,
      coreSourceRef: `artifact:sha256:${"2".repeat(64)}`,
    };
    await writeFile(
      path.join(runtimeRoot, "config.json"),
      `${JSON.stringify({
        schemaVersion: "OwlCodaRunKitConfigV2",
        core: previousCore,
        authorizationPolicy: "external_explicit_authority_required",
      }, null, 2)}\n`,
    );

    const initialized = runCli(["init", "--workspace", root]);

    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(initialized.json.status, "upgraded");
    assert.match(initialized.json.migrationReceipt, /config-v02-core-refresh/);
    const config = JSON.parse(await readFile(path.join(runtimeRoot, "config.json"), "utf8"));
    assert.deepEqual(config.core, currentCoreIdentity());
    const receipt = JSON.parse(await readFile(
      path.join(root, initialized.json.migrationReceipt),
      "utf8",
    ));
    assert.equal(receipt.migration, "config-v02-core-refresh");
    assert.deepEqual(receipt.fromCore, previousCore);
    assert.deepEqual(receipt.toCore, currentCoreIdentity());
    assert.equal(receipt.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init fails closed for an unknown project configuration version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-unknown-config-"));
  try {
    const runtimeRoot = path.join(root, ".owlcoda/runkit");
    await mkdir(path.join(runtimeRoot, "executions"), { recursive: true });
    const unknown = {
      schemaVersion: "OwlCodaRunKitConfigV99",
      core: legacyCoreIdentity,
      authorizationPolicy: "external_explicit_authority_required",
    };
    await writeFile(
      path.join(runtimeRoot, "config.json"),
      `${JSON.stringify(unknown, null, 2)}\n`,
    );

    const initialized = runCli(["init", "--workspace", root]);

    assert.equal(initialized.status, 3, initialized.stderr);
    assert.match(initialized.json.issues.join("\n"), /unsupported project config/i);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(runtimeRoot, "config.json"), "utf8")),
      unknown,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Contract v0.2 publishes schemas for context, evidence, receipt, closeout, config, pin, and artifact", async () => {
  const schemaRoot = path.resolve("scripts/runkit-contract/schemas");
  const schemas = Object.fromEntries(await Promise.all([
    "verification-context-v1.schema.json",
    "replayable-evidence-v1.schema.json",
    "snapshot-v1.schema.json",
    "finalize-request-v1.schema.json",
    "ready-for-commit-v1.schema.json",
    "ready-for-commit-v2.schema.json",
    "visual-smoke-request-v1.schema.json",
    "visual-smoke-result-v1.schema.json",
    "evidence-coverage-index-v1.schema.json",
    "coverage-adopt-request-v1.schema.json",
    "resume-request-v1.schema.json",
    "resume-attempt-v1.schema.json",
    "verify-plan-request-v1.schema.json",
    "verification-plan-v1.schema.json",
    "resource-preflight-request-v1.schema.json",
    "resource-preflight-v1.schema.json",
    "profiles.schema.json",
    "verification-receipt-v2.schema.json",
    "closeout-receipt-v2.schema.json",
    "project-config-v2.schema.json",
    "engine-pin-v2.schema.json",
    "core-artifact-v2.schema.json",
    "team-project-status-v1.schema.json",
  ].map(async (name) => [name, await loadJsonFixture(path.join(schemaRoot, name))])));

  assert.equal(
    schemas["engine-pin-v2.schema.json"].properties.contractVersion.const,
    "0.2",
  );
  assert.equal(
    schemas["project-config-v2.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitConfigV2",
  );
  assert.equal(
    schemas["verification-receipt-v2.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitVerificationReceiptV2",
  );
  assert.ok(schemas["verification-receipt-v2.schema.json"].required.includes(
    "verificationContextFingerprint",
  ));
  assert.ok(schemas["closeout-receipt-v2.schema.json"].required.includes(
    "verification",
  ));
  assert.equal(
    schemas["snapshot-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitSnapshotV1",
  );
  assert.equal(
    schemas["finalize-request-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitFinalizeRequestV1",
  );
  assert.equal(
    schemas["ready-for-commit-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitReadyForCommitRequestV1",
  );
  assert.equal(
    schemas["ready-for-commit-v2.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitReadyForCommitRequestV2",
  );
  assert.equal(
    schemas["visual-smoke-request-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitVisualSmokeRequestV1",
  );
  assert.equal(
    schemas["visual-smoke-result-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitVisualSmokeResultV1",
  );
  assert.equal(
    schemas["evidence-coverage-index-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitEvidenceCoverageIndexV1",
  );
  assert.ok(
    schemas["evidence-coverage-index-v1.schema.json"]
      .properties.generatedFrom.items.required.includes("commandBindings"),
  );
  assert.ok(
    schemas["evidence-coverage-index-v1.schema.json"]
      .properties.generatedFrom.items.required.includes("dependencyBindings"),
  );
  assert.equal(
    schemas["coverage-adopt-request-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitCoverageAdoptRequestV1",
  );
  assert.equal(
    schemas["resume-request-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitResumeRequestV1",
  );
  assert.equal(
    schemas["resume-attempt-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitResumeAttemptV1",
  );
  assert.equal(
    schemas["verify-plan-request-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitVerifyPlanRequestV1",
  );
  assert.equal(
    schemas["verification-plan-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitVerificationPlanV1",
  );
  assert.equal(
    schemas["resource-preflight-request-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitResourcePreflightRequestV1",
  );
  assert.equal(
    schemas["resource-preflight-v1.schema.json"].properties.schemaVersion.const,
    "OwlCodaRunKitResourcePreflightV1",
  );
  assert.ok("role" in schemas["profiles.schema.json"].properties.profiles.items.properties);
  assert.ok("requiresProfileIds" in schemas["profiles.schema.json"].properties.profiles.items.properties);
  assert.ok("commands" in schemas["profiles.schema.json"].properties.profiles.items.properties);
  assert.equal(
    schemas["core-artifact-v2.schema.json"].properties.schemaVersion.const,
    "RunKitCoreArtifactV2",
  );
  for (const field of ["headline", "dominantGap", "nextAction", "nextActorId"]) {
    assert.ok(schemas["team-project-status-v1.schema.json"].required.includes(field));
  }
  assert.deepEqual(
    schemas["team-project-status-v1.schema.json"].properties.dominantGap
      .properties.kind.enum,
    ["decision", "failed_work", "work_item", "integration_gate", "none"],
  );
});

test("Contract v0.2 documentation and Codex Skill templates expose the same acceptance boundary", async () => {
  const contract = await readFile(
    "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_2.md",
    "utf8",
  );
  assert.match(contract, /D8.*gate-bound accepted closeout/is);
  assert.match(contract, /D9.*VerificationContextV1/is);
  assert.match(contract, /D10.*replayable evidence/is);
  assert.match(contract, /accepted.*not.*authoriz/is);

  const coreContextTemplate = await loadJsonFixture(
    "scripts/runkit-contract/templates/verification-context.json",
  );
  const skillContextTemplate = await loadJsonFixture(
    "integrations/codex/skills/owlcoda-runkit/assets/templates/verification-context.json",
  );
  assert.deepEqual(skillContextTemplate, coreContextTemplate);
  assert.equal(
    coreContextTemplate.schemaVersion,
    "OwlCodaRunKitVerificationContextV1",
  );

  const configTemplate = await loadJsonFixture(
    "integrations/codex/skills/owlcoda-runkit/assets/templates/config.json",
  );
  const receiptTemplate = await loadJsonFixture(
    "integrations/codex/skills/owlcoda-runkit/assets/templates/verification-receipt.json",
  );
  assert.equal(configTemplate.schemaVersion, "OwlCodaRunKitConfigV2");
  assert.equal(configTemplate.core.coreVersion, "0.18.0");
  assert.equal(receiptTemplate.schemaVersion, "OwlCodaRunKitVerificationReceiptV2");
  assert.ok("verificationContextFingerprint" in receiptTemplate);

  for (const name of [
    "snapshot-request.json",
    "finalize-request.json",
    "ready-for-commit-request.json",
    "visual-smoke-request.json",
    "verify-plan-request.json",
    "coverage-adopt-request.json",
    "resume-request.json",
    "resource-preflight-request.json",
  ]) {
    assert.deepEqual(
      await loadJsonFixture(`integrations/codex/skills/owlcoda-runkit/assets/templates/${name}`),
      await loadJsonFixture(`scripts/runkit-contract/templates/${name}`),
    );
  }

  const skill = await readFile(
    "integrations/codex/skills/owlcoda-runkit/SKILL.md",
    "utf8",
  );
  assert.match(skill, /contract-v0\.2\.md/);
  assert.match(skill, /--gate-input/);
  assert.match(skill, /owlrunkit snapshot/);
  assert.match(skill, /owlrunkit finalize/);
  assert.match(skill, /owlrunkit ready-for-commit/);
  assert.match(skill, /owlrunkit visual-smoke/);
  assert.match(skill, /owlrunkit verify-plan/);
  assert.match(skill, /owlrunkit coverage-adopt/);
  assert.match(skill, /owlrunkit resume/);
  assert.match(skill, /owlrunkit resource-preflight/);
  assert.match(skill, /owlrunkit lease acquire/);
  assert.match(skill, /owlrunkit delivery create/);
  assert.match(skill, /owlrunkit formal start/);
  assert.match(skill, /owlrunkit formal check/);
  assert.match(skill, /owlrunkit formal finish/);
  assert.match(skill, /owlrunkit project status/);
  assert.match(skill, /owlrunkit project takeover/);
  assert.match(skill, /guessed percentage/i);
  assert.match(skill, /Verification Envelope/);
  assert.match(skill, /leased source drift/i);
  assert.match(skill, /unrelated dirty-tree drift/i);
  assert.match(skill, /verification_mapping_required/);
  assert.match(skill, /pendingCommands/);
  assert.match(contract, /Core v0\.6 dependency-aware verification planning/i);
  assert.match(contract, /Core v0\.7 receipt-backed coverage adoption/i);
  assert.match(contract, /Core v0\.8 append-only native resume/i);
  assert.match(contract, /Core v0\.9 CLI-managed lease and delivery/i);
  assert.match(contract, /Core v0\.10 high-level lifecycle composition/i);
  assert.match(contract, /Core v0\.12 typed model resource preflight/i);
  assert.match(contract, /re-derives it from the current gate bytes/i);
  assert.match(skill, /re-derives the coverage\s+index/i);
});

test("Contract v0.2 rejects accepted closeout while a writer lease is active", async () => {
  const root = await plannedWorkspace("owlcoda-runkit-v02-lease-");
  try {
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions/contract-v02-fixture",
    );
    const gateInputPath = path.join(root, "gate-input.json");
    await writeFile(
      gateInputPath,
      `${JSON.stringify(await passingV02GateInput(), null, 2)}\n`,
    );
    await mkdir(path.join(executionRoot, "leases"), { recursive: true });
    await writeFile(
      path.join(executionRoot, "leases/W1.json"),
      `${JSON.stringify({
        schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
        workItemId: "W1",
        attempt: 1,
        ownedPaths: ["src/example.ts"],
        state: "active",
      }, null, 2)}\n`,
    );

    const completed = runCli([
      "closeout",
      "--workspace", root,
      "--run-id", "contract-v02-fixture",
      "--decision", "accepted",
      "--gate-input", gateInputPath,
    ]);

    assert.equal(completed.status, 2, completed.stderr);
    assert.equal(completed.json.status, "closeout_gate_rejected");
    assert.match(completed.json.issues.join("\n"), /active lease/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Contract v0.2 rejects accepted closeout when a symlinked lease could hide an active writer", async () => {
  const root = await plannedWorkspace("owlcoda-runkit-v02-symlink-lease-");
  const foreign = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-v02-foreign-lease-"));
  try {
    const runId = "contract-v02-fixture";
    const acquired = runCli([
      "lease", "acquire", "--workspace", root,
      "--run-id", runId, "--work-item", "W1", "--owned-path", "src/example.ts",
    ]);
    assert.equal(acquired.json.status, "lease_acquired", acquired.stderr);
    const released = runCli([
      "lease", "release", "--workspace", root,
      "--run-id", runId, "--work-item", "W1",
    ]);
    assert.equal(released.json.status, "lease_released", released.stderr);

    const foreignLeasePath = path.join(foreign, "W2.json");
    await writeFile(foreignLeasePath, `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W2",
      attempt: 1,
      ownedPaths: ["src/other.ts"],
      state: "active",
    }, null, 2)}\n`);
    await symlink(
      foreignLeasePath,
      path.join(root, ".owlcoda/runkit/executions", runId, "leases/W2.json"),
    );
    const gateInputPath = path.join(root, "gate-input.json");
    await writeFile(gateInputPath, `${JSON.stringify(await passingV02GateInput(), null, 2)}\n`);

    const completed = runCli([
      "closeout", "--workspace", root,
      "--run-id", runId, "--decision", "accepted", "--gate-input", gateInputPath,
    ]);
    assert.equal(completed.json.status, "invalid_input", completed.stderr);
    assert.equal(completed.json.authorizationGranted, false);
    assert.match(completed.json.issues.join("\n"), /symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(foreign, { recursive: true, force: true });
  }
});

test("VerificationContextV1 fingerprint is canonical across object and collection order", async () => {
  const {
    validateVerificationContext,
    verificationContextFingerprint,
  } = await loadVerificationContext();
  const first = portableContext();
  const second = {
    services: [],
    fixtures: [],
    toolchains: [...first.toolchains].reverse(),
    schemaVersion: first.schemaVersion,
    environment: [],
    platform: null,
    reusePolicy: first.reusePolicy,
    lockfiles: [...first.lockfiles].reverse(),
  };

  assert.deepEqual(validateVerificationContext(first), {
    valid: true,
    issues: [],
  });
  assert.equal(
    verificationContextFingerprint(first),
    verificationContextFingerprint(second),
  );
  assert.match(verificationContextFingerprint(first), /^[a-f0-9]{64}$/);
});

test("Contract v0.2 gate rejects a receipt without a recomputable verification context", async () => {
  const { verificationContextFingerprint } = await loadVerificationContext();
  const input = passingLegacyGateInput();
  const receipt = {
    ...input.receipts[0].receipt,
    schemaVersion: "OwlCodaRunKitVerificationReceiptV2",
    runId: "contract-v02-fixture",
    verificationContextFingerprint: verificationContextFingerprint(portableContext()),
    commandReceipts: [replayableShellCommandReceipt()],
  };
  input.contractVersion = "0.2";
  input.receipts = [{ receiptSha256: receiptSha256(receipt), receipt }];

  const result = validateVerificationReceiptGate(input);

  assert.equal(result.accepted, false);
  assert.equal(result.decision, "rejected");
  assert.ok(result.issues.some((item) => item.code === "verification_context_required"));
});

test("Contract v0.2 gate rejects a receipt bound to a different verification context", async () => {
  const input = await passingV02GateInput({
    context: portableContext(),
    receiptContext: portableContext({
      toolchains: [{ name: "node", version: "22.0.0" }],
    }),
  });

  const result = validateVerificationReceiptGate(input);

  assert.equal(result.accepted, false);
  assert.equal(result.decision, "rejected");
  assert.ok(result.issues.some(
    (item) => item.code === "verification_context_fingerprint_mismatch",
  ));
});

test("environment_bound context requires material environment identity", async () => {
  const { validateVerificationContext } = await loadVerificationContext();
  const result = validateVerificationContext(portableContext({
    reusePolicy: "environment_bound",
    platform: { os: "darwin", arch: "arm64" },
  }));

  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /environment_bound.*material/i);
});

test("VerificationContextV1 rejects undeclared fields that could persist raw secrets", async () => {
  const { validateVerificationContext } = await loadVerificationContext();
  const result = validateVerificationContext({
    ...portableContext(),
    environment: [{
      name: "PROVIDER_TOKEN",
      valueSha256: "a".repeat(64),
      value: "must-not-enter-project-truth",
    }],
  });

  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /unsupported.*value/i);
});

test("ReplayableEvidenceV1 rejects undeclared fields that could persist raw secrets", () => {
  const evidence = {
    ...replayableShellCommandReceipt().evidence,
    token: "must-not-enter-project-truth",
  };

  const result = validateReplayableEvidence(evidence);

  assert.equal(result.valid, false);
  assert.match(result.issues.join("\n"), /unsupported.*token/i);
});

test("Contract v0.2 rejects descriptive command labels without replayable evidence", async () => {
  const input = await passingV02GateInput();
  const receipt = {
    ...input.receipts[0].receipt,
    commandReceipts: [passingLegacyGateInput().receipts[0].receipt.commandReceipts[0]],
  };
  input.receipts = [{ receiptSha256: receiptSha256(receipt), receipt }];

  const result = validateVerificationReceiptGate(input);

  assert.equal(result.accepted, false);
  assert.equal(result.malformed, true);
  assert.equal(result.decision, "malformed_input");
  assert.ok(result.issues.some(
    (item) => item.code === "non_replayable_command_evidence",
  ));
});

test("Contract v0.2 rejects automation evidence without a manifest hash", async () => {
  const input = await passingV02GateInput();
  const automationReceipt = {
    evidence: {
      schemaVersion: "OwlCodaRunKitReplayableEvidenceV1",
      kind: "automation",
      cwd: ".",
      launcher: {
        executable: "computer-use",
        version: "1.0.0",
      },
      toolVersions: [{ name: "computer-use", version: "1.0.0" }],
      materialInputs: [],
      outputArtifacts: [{ path: "verification/window.png", sha256: "f".repeat(64) }],
    },
    exitCode: 0,
    stdoutSha256: "b".repeat(64),
    stderrSha256: "c".repeat(64),
  };
  const receipt = {
    ...input.receipts[0].receipt,
    commandReceipts: [automationReceipt],
  };
  input.receipts = [{ receiptSha256: receiptSha256(receipt), receipt }];

  const result = validateVerificationReceiptGate(input);

  assert.equal(result.accepted, false);
  assert.equal(result.malformed, true);
  assert.ok(result.issues.some(
    (item) => item.code === "non_replayable_command_evidence"
      && /manifest/i.test(item.message),
  ));
});

test("accepted closeout binds the current v0.2 gate and released lease state", async () => {
  const root = await plannedWorkspace("owlcoda-runkit-v02-accepted-");
  try {
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions/contract-v02-fixture",
    );
    const lease = {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: "W1",
      attempt: 1,
      ownedPaths: ["src/example.ts"],
      state: "released",
    };
    await writeFile(
      path.join(executionRoot, "leases/W1.json"),
      `${JSON.stringify(lease, null, 2)}\n`,
    );
    const gateInput = await passingV02GateInput();
    const gateInputPath = path.join(root, "gate-input.json");
    await writeFile(gateInputPath, `${JSON.stringify(gateInput, null, 2)}\n`);
    const gate = validateVerificationReceiptGate(gateInput);
    assert.equal(gate.accepted, true);

    const completed = runCli([
      "closeout",
      "--workspace", root,
      "--run-id", "contract-v02-fixture",
      "--decision", "accepted",
      "--gate-input", gateInputPath,
    ]);

    assert.equal(completed.status, 0, completed.stderr);
    const closeout = JSON.parse(await readFile(
      path.join(executionRoot, "closeout-receipt.json"),
      "utf8",
    ));
    assert.deepEqual(closeout.artifact.payload.verification, {
      contractVersion: "0.2",
      gateDecision: "accepted_passed",
      gateInputSha256: sha256(await readFile(gateInputPath)),
      activeReceiptSha256: gate.activeReceiptSha256,
      sourceFingerprint: gate.sourceFingerprint,
      verificationContextFingerprint: gate.verificationContextFingerprint,
      selectedProfileIds: gate.selectedProfileIds,
      leaseState: "released",
      releasedLeaseIds: ["W1"],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted closeout rejects a gate receipt owned by another run", async () => {
  const root = await plannedWorkspace("owlcoda-runkit-v02-run-binding-");
  try {
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions/contract-v02-fixture",
    );
    await writeFile(
      path.join(executionRoot, "leases/W1.json"),
      `${JSON.stringify({
        schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
        workItemId: "W1",
        attempt: 1,
        ownedPaths: ["src/example.ts"],
        state: "released",
      }, null, 2)}\n`,
    );
    const gateInput = await passingV02GateInput();
    const receipt = { ...gateInput.receipts[0].receipt, runId: "another-run" };
    gateInput.receipts = [{ receiptSha256: receiptSha256(receipt), receipt }];
    const gateInputPath = path.join(root, "other-run-gate-input.json");
    await writeFile(gateInputPath, `${JSON.stringify(gateInput, null, 2)}\n`);

    const completed = runCli([
      "closeout",
      "--workspace", root,
      "--run-id", "contract-v02-fixture",
      "--decision", "accepted",
      "--gate-input", gateInputPath,
    ]);

    assert.equal(completed.status, 2, completed.stderr);
    assert.match(completed.json.issues.join("\n"), /runId.*current execution/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepted closeout requires at least one released lease", async () => {
  const root = await plannedWorkspace("owlcoda-runkit-v02-no-lease-");
  try {
    const gateInputPath = path.join(root, "gate-input.json");
    await writeFile(
      gateInputPath,
      `${JSON.stringify(await passingV02GateInput(), null, 2)}\n`,
    );

    const completed = runCli([
      "closeout",
      "--workspace", root,
      "--run-id", "contract-v02-fixture",
      "--decision", "accepted",
      "--gate-input", gateInputPath,
    ]);

    assert.equal(completed.status, 2, completed.stderr);
    assert.match(completed.json.issues.join("\n"), /released lease.*required/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Contract v0.2 accepted closeout rejects a legacy v0.1 gate", async () => {
  const root = await plannedWorkspace("owlcoda-runkit-v02-legacy-gate-");
  try {
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions/contract-v02-fixture",
    );
    await writeFile(
      path.join(executionRoot, "leases/W1.json"),
      `${JSON.stringify({
        schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
        workItemId: "W1",
        attempt: 1,
        ownedPaths: ["src/example.ts"],
        state: "released",
      }, null, 2)}\n`,
    );
    const gateInputPath = path.join(root, "legacy-gate-input.json");
    await writeFile(
      gateInputPath,
      `${JSON.stringify(passingLegacyGateInput(), null, 2)}\n`,
    );

    const completed = runCli([
      "closeout",
      "--workspace", root,
      "--run-id", "contract-v02-fixture",
      "--decision", "accepted",
      "--gate-input", gateInputPath,
    ]);

    assert.equal(completed.status, 2, completed.stderr);
    assert.match(completed.json.issues.join("\n"), /Contract v0\.2 gate/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
