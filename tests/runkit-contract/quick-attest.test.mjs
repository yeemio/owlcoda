import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalJson,
  parseJsonStrict,
  sha256Bytes,
  sha256Canonical,
} from "../../scripts/runkit-contract/quick-canonical.mjs";
import { currentCoreIdentity } from "../../scripts/runkit-contract/core-contract.mjs";
import { attestQuickReceipt } from "../../scripts/runkit-contract/quick-attest.mjs";
import { runQuickVerification } from "../../scripts/runkit-contract/quick-verify.mjs";
import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { receiptSha256 } from "../../scripts/runkit-contract/receipt-lineage.mjs";
import { validateVerificationReceiptGate } from "../../scripts/runkit-contract/verification-receipt-gate.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function snapshot() {
  const value = {
    schemaVersion: "OwlCodaWorkspaceSnapshotV1",
    repositoryIdentity: "https://example.test/repository.git",
    headCommit: "a".repeat(40),
    trackedTreeIdentity: `sha256:${"b".repeat(64)}`,
    submodules: [],
    dirtyOverlay: [],
    dependencyLockfiles: [],
    excludedRoots: [".owlcoda/runkit"],
    ignoredPathsBound: false,
    policyVersion: "workspace-snapshot-v1",
  };
  return { ...value, sourceFingerprint: sha256Canonical(value) };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-attest-"));
  const receiptRoot = path.join(root, ".owlcoda", "runkit", "quick", "receipts", "quick-1");
  mkdirSync(receiptRoot, { recursive: true });
  const stdoutPath = path.join(receiptRoot, "stdout.log");
  const stderrPath = path.join(receiptRoot, "stderr.log");
  writeFileSync(stdoutPath, "ok\n");
  writeFileSync(stderrPath, "");
  const before = snapshot();
  const core = currentCoreIdentity();
  const receipt = {
    schemaVersion: "OwlCodaQuickVerificationReceiptV1",
    receiptId: "quick-1",
    assurance: "captured_verification",
    authorizationGranted: false,
    coreIdentity: {
      contractVersion: core.contractVersion,
      coreVersion: core.coreVersion,
      coreManifestSha256: core.coreManifestSha256,
    },
    workspaceBefore: before,
    exactCommand: {
      executable: process.execPath,
      argv: ["-e", "process.stdout.write('ok\\n')"],
      cwd: root,
    },
    verificationContext: {
      platform: process.platform,
      architecture: process.arch,
      runtime: process.version,
    },
    startedAt: "2026-07-28T00:00:00.000Z",
    finishedAt: "2026-07-28T00:00:01.000Z",
    exitResult: { exitCode: 0, signal: null },
    outputArtifacts: {
      stdout: {
        path: path.relative(root, stdoutPath),
        sha256: sha256Bytes(readFileSync(stdoutPath)),
        sizeBytes: 3,
      },
      stderr: {
        path: path.relative(root, stderrPath),
        sha256: sha256Bytes(readFileSync(stderrPath)),
        sizeBytes: 0,
      },
    },
    workspaceAfter: before,
    mutationDecision: "source_unchanged",
    issueCodes: ["quick_ignored_artifact_unbound"],
  };
  const receiptPath = path.join(receiptRoot, "receipt.json");
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { root, receipt, receiptPath };
}

test("canonicalization matches the frozen Wave 0 vectors", () => {
  const vectors = JSON.parse(readFileSync(
    new URL("../../docs/architecture/runkit-trust-product-v1/canonicalization-vectors-v1.json", import.meta.url),
    "utf8",
  ));
  for (const vector of vectors.vectors) {
    assert.equal(canonicalJson(vector.value), vector.canonicalJson, vector.id);
    assert.equal(sha256Canonical(vector.value), `sha256:${vector.sha256}`, vector.id);
  }
});

test("strict JSON rejects duplicate keys before last-wins collapse", () => {
  assert.throws(
    () => parseJsonStrict('{"schemaVersion":"one","schemaVersion":"two"}'),
    (error) => error.code === "receipt_duplicate_key",
  );
});

test("strict receipt parsing cannot hide an unknown __proto__ field", () => {
  const { receiptPath } = fixture();
  const receiptText = readFileSync(receiptPath, "utf8");
  writeFileSync(receiptPath, receiptText.replace("{", '{"__proto__":null,'));

  assert.throws(
    () => attestQuickReceipt({ receiptPath }),
    (error) => error.code === "receipt_schema_invalid",
  );
});

test("minimum attest without a selected workspace remains read-only and indeterminate", () => {
  const { receiptPath } = fixture();
  const result = attestQuickReceipt({ receiptPath });

  assert.equal(result.decision, "INDETERMINATE");
  assert.equal(result.authorizationBoundary.authorizationGranted, false);
  assert.equal(result.subjectRef.schemaVersion, "OwlCodaAttestationRefV1");
  assert.deepEqual(result.issueCodes, [
    "anchor_absent",
    "current_workspace_not_checked",
    "quick_ignored_artifact_unbound",
    "signature_absent",
  ]);
  assert.deepEqual(result.checks.source, {
    status: "not_checked",
    issueCode: "current_workspace_not_checked",
  });
  assert.equal(result.verifiedMaterials.length, 1);
  assert.ok(result.verifiedMaterials.some((entry) => entry.path === realpathSync(receiptPath)));
});

test("minimum attest fails closed when output bytes or source binding are changed", () => {
  const outputMutation = fixture();
  writeFileSync(path.join(path.dirname(outputMutation.receiptPath), "stdout.log"), "tampered\n");
  const outputResult = attestQuickReceipt({ receiptPath: outputMutation.receiptPath });
  assert.equal(outputResult.decision, "INDETERMINATE");
  assert.equal(outputResult.issueCodes.includes("receipt_material_hash_mismatch"), false);

  const sourceMutation = fixture();
  sourceMutation.receipt.workspaceAfter.sourceFingerprint = `sha256:${"d".repeat(64)}`;
  writeFileSync(sourceMutation.receiptPath, `${JSON.stringify(sourceMutation.receipt, null, 2)}\n`);
  const sourceResult = attestQuickReceipt({ receiptPath: sourceMutation.receiptPath });
  assert.equal(sourceResult.decision, "NO_GO");
  assert.ok(sourceResult.issueCodes.includes("receipt_source_mismatch"));
});

test("minimum attest rejects a receipt produced under another Core manifest", () => {
  const forged = fixture();
  forged.receipt.coreIdentity.coreManifestSha256 = `sha256:${"c".repeat(64)}`;
  writeFileSync(forged.receiptPath, `${JSON.stringify(forged.receipt, null, 2)}\n`);

  const result = attestQuickReceipt({ receiptPath: forged.receiptPath });
  assert.equal(result.decision, "NO_GO");
  assert.ok(result.issueCodes.includes("core_identity_mismatch"));
  assert.deepEqual(result.checks.context, {
    status: "failed",
    issueCode: "core_identity_mismatch",
  });
});

test("minimum attest compares the Quick verification context", () => {
  const forged = fixture();
  forged.receipt.verificationContext = {
    platform: "forged",
    architecture: "forged",
    runtime: "forged",
  };
  writeFileSync(forged.receiptPath, `${JSON.stringify(forged.receipt, null, 2)}\n`);

  const result = attestQuickReceipt({ receiptPath: forged.receiptPath });
  assert.equal(result.decision, "NO_GO");
  assert.ok(result.issueCodes.includes("verification_context_mismatch"));
  assert.deepEqual(result.checks.context, {
    status: "failed",
    issueCode: "verification_context_mismatch",
  });
});

test("minimum attest recomputes an explicitly selected current workspace", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-current-source-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "quick@example.test");
  git(root, "config", "user.name", "Quick Test");
  writeFileSync(path.join(root, "source.txt"), "stable\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");

  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  assert.equal(attestQuickReceipt({
    receiptPath: verification.receiptPath,
    workspaceRoot: root,
  }).decision, "GO");

  writeFileSync(path.join(root, "source.txt"), "changed after verification\n");
  const result = attestQuickReceipt({
    receiptPath: verification.receiptPath,
    workspaceRoot: root,
  });
  assert.equal(result.decision, "NO_GO");
  assert.ok(result.issueCodes.includes("receipt_source_mismatch"));
  assert.equal(result.checks.source.status, "failed");
});

test("attest uses exit 2 for current source drift and exit 3 for missing bound material", async () => {
  const sourceRoot = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-source-exit-"));
  git(sourceRoot, "init", "-q");
  git(sourceRoot, "config", "user.email", "quick@example.test");
  git(sourceRoot, "config", "user.name", "Quick Test");
  writeFileSync(path.join(sourceRoot, "source.txt"), "stable\n");
  git(sourceRoot, "add", ".");
  git(sourceRoot, "commit", "-qm", "initial");
  const sourceReceipt = await runQuickVerification({
    workspaceRoot: sourceRoot,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  writeFileSync(path.join(sourceRoot, "source.txt"), "changed\n");

  const drift = await runCli([
    "quick-attest",
    "--workspace", sourceRoot,
    "--receipt", sourceReceipt.receiptPath,
  ]);
  assert.equal(drift.attestation.decision, "NO_GO");
  assert.equal(drift.exitCode, 2);

  const materialRoot = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-material-exit-"));
  git(materialRoot, "init", "-q");
  git(materialRoot, "config", "user.email", "quick@example.test");
  git(materialRoot, "config", "user.name", "Quick Test");
  writeFileSync(path.join(materialRoot, "source.txt"), "stable\n");
  git(materialRoot, "add", ".");
  git(materialRoot, "commit", "-qm", "initial");
  const materialReceipt = await runQuickVerification({
    workspaceRoot: materialRoot,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  unlinkSync(path.join(path.dirname(materialReceipt.receiptPath), "stdout.log"));

  const missing = await runCli([
    "quick-attest",
    "--workspace", materialRoot,
    "--receipt", materialReceipt.receiptPath,
  ]);
  assert.equal(missing.attestation.decision, "INDETERMINATE");
  assert.equal(missing.exitCode, 3);
  assert.ok(missing.attestation.issueCodes.includes("attestation_material_missing"));
});

test("Quick receipt cannot satisfy the Formal Contract v0.2 acceptance gate", () => {
  const { receipt } = fixture();
  const gate = validateVerificationReceiptGate({
    contractVersion: "0.2",
    receipts: [{ receiptSha256: receiptSha256(receipt), receipt }],
    sourceGate: {
      status: "valid",
      exitCode: 0,
      declaredFingerprint: "a".repeat(64),
      recomputedFingerprint: "a".repeat(64),
    },
    profileImpact: {
      decision: "verification_required",
      profileIds: [],
    },
    verificationContext: {
      schemaVersion: "OwlCodaRunKitVerificationContextV1",
      contextId: "quick-must-not-be-formal",
      runtime: { platform: "darwin", architecture: "arm64", nodeVersion: "v24.0.0" },
      commandEnvironment: { cwd: ".", environment: {}, executableSearchPath: [] },
      authorizationGranted: false,
    },
  });
  assert.equal(gate.accepted, false);
  assert.equal(gate.verificationPassed, false);
  assert.equal(gate.decision, "rejected");
  assert.ok(gate.issues.some((entry) => entry.code === "quick_receipt_not_formal"));
});
