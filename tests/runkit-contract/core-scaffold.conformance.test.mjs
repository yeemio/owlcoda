import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCoreArtifact,
  currentCoreIdentity,
  initializeProjectRunKit,
  validateCoreArtifact,
  validateExecutionPin,
  validateLeaseOwnedPaths,
} from "../../scripts/runkit-contract/core-contract.mjs";
import {
  canonicalSourceFingerprint,
  verifyDeliveryPacket,
} from "../../scripts/runkit-contract/source-fingerprint.mjs";
import { resolveProfileImpact } from "../../scripts/runkit-contract/profile-impact.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("reserved OwlCoda RunKit state cannot enter source, profile, or lease paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-reserved-"));
  try {
    const runtimePath = ".owlcoda/runkit/verification-receipts/r1.json";
    const content = "{}\n";
    const files = { [runtimePath]: sha256(content) };
    const packet = {
      changedFiles: { files },
      sourceFingerprint: { sha256: canonicalSourceFingerprint(files) },
    };

    const sourceResult = verifyDeliveryPacket({ workspaceRoot: root, packet });
    assert.equal(sourceResult.status, "malformed_packet");
    assert.equal(sourceResult.exitCode, 3);
    assert.match(sourceResult.issues.join("\n"), /reserved runtime path/i);

    assert.throws(
      () => resolveProfileImpact({
        changedPaths: ["src/main.ts"],
        profiles: [{ id: "self", paths: [".owlcoda/runkit/**"] }],
      }),
      /reserved runtime path/i,
    );
    assert.throws(
      () => validateLeaseOwnedPaths([runtimePath]),
      /reserved runtime path/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution engine pin fails closed when the installed Core changes", () => {
  const pin = currentCoreIdentity();
  assert.deepEqual(validateExecutionPin({ expected: pin, actual: pin }), {
    status: "valid",
    exitCode: 0,
    issues: [],
  });

  const changed = { ...pin, coreManifestSha256: `sha256:${"0".repeat(64)}` };
  const result = validateExecutionPin({ expected: pin, actual: changed });
  assert.equal(result.status, "engine_changed_during_execution");
  assert.equal(result.exitCode, 2);
  assert.match(result.issues.join("\n"), /coreManifestSha256/);
});

test("adapter provenance cannot change the Core acceptance hash", () => {
  const first = createCoreArtifact({
    producer: { adapterKind: "codex", adapterVersion: "1" },
    payload: { decision: "ready_for_stage_verification", workItemId: "W1" },
    extensions: { "dev.owlcoda.adapter.codex": { taskId: "task-a" } },
  });
  const second = createCoreArtifact({
    producer: { adapterKind: "owlcoda-native", adapterVersion: "1" },
    payload: { decision: "ready_for_stage_verification", workItemId: "W1" },
    extensions: { "dev.owlcoda.adapter.native": { threadId: "thread-b" } },
  });

  assert.equal(first.acceptanceSha256, second.acceptanceSha256);
  assert.notEqual(first.artifactSha256, second.artifactSha256);
  assert.equal(validateCoreArtifact(first.artifact).valid, true);
  assert.equal(validateCoreArtifact(second.artifact).valid, true);
});

test("controlled initialization writes only the project RunKit state tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-init-"));
  try {
    await writeFile(path.join(root, "business.txt"), "unchanged\n");
    const before = sha256(await readFile(path.join(root, "business.txt")));
    const result = await initializeProjectRunKit({ workspaceRoot: root });

    assert.equal(result.status, "initialized");
    assert.equal(result.runtimeRoot, ".owlcoda/runkit");
    assert.equal(sha256(await readFile(path.join(root, "business.txt"))), before);
    assert.equal(existsSync(path.join(root, ".owlcoda/runkit/config.json")), true);
    assert.equal(existsSync(path.join(root, ".owlcoda/runkit/profiles.json")), true);

    const config = JSON.parse(await readFile(path.join(root, ".owlcoda/runkit/config.json"), "utf8"));
    assert.deepEqual(config.core, currentCoreIdentity());
    assert.equal(config.authorizationPolicy, "external_explicit_authority_required");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
