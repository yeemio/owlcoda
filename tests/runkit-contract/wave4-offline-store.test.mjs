import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import * as attest from "../../packages/attest/src/index.mjs";
import { coreManifest } from "../../scripts/runkit-contract/core-contract.mjs";
import { runCli } from "../../scripts/runkit-contract/runkit-cli.mjs";
import { runQuickVerification } from "../../scripts/runkit-contract/quick-verify.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-offline-")));
  git(root, "init", "-q");
  git(root, "config", "user.email", "wave4@example.test");
  git(root, "config", "user.name", "Wave 4 Test");
  writeFileSync(path.join(root, "source.txt"), "stable\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return root;
}

async function quickFixture() {
  const workspace = repository();
  const verification = await runQuickVerification({
    workspaceRoot: workspace,
    commandArgv: [process.execPath, "-e", "process.stdout.write('offline ok\\n')"],
  });
  assert.equal(verification.status, "quick_verification_passed");
  return { workspace, verification };
}

test("public verifier exposes strict read-only offline bundle helpers", async () => {
  assert.equal(typeof attest.createOfflineAttestationBundle, "function");
  assert.equal(typeof attest.parseOfflineAttestationBundle, "function");

  const { verification } = await quickFixture();
  const receiptBytes = readFileSync(verification.receiptPath);
  const bundle = attest.createOfflineAttestationBundle(verification.receiptPath);

  assert.deepEqual(Object.keys(bundle), [
    "schemaVersion",
    "reference",
    "receiptByteLength",
    "receiptBytesBase64",
  ]);
  assert.equal(bundle.schemaVersion, "OwlCodaOfflineAttestationBundleV1");
  assert.equal(bundle.reference.receiptSha256, attest.sha256Bytes(receiptBytes));
  assert.equal(bundle.receiptByteLength, receiptBytes.byteLength);
  assert.deepEqual(
    attest.parseOfflineAttestationBundle(JSON.stringify(bundle)).receiptBytes,
    receiptBytes,
  );
});

test("Core identity binds the offline store mutation module", () => {
  assert.equal(coreManifest().files.includes("offline-store.mjs"), true);
});

test("Core identity binds the public dependency closure used by the offline store", async () => {
  const dependencies = [
    "packages/attest/src/formal.mjs",
    "packages/attest/src/offline-bundle.mjs",
    "packages/attest/src/quick-receipt-contract.mjs",
    "packages/attest/src/reference-contract.mjs",
  ];
  assert.deepEqual(coreManifest().dependencyFiles, dependencies);

  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-core-binding-")));
  const copiedCore = path.join(scratch, "scripts", "runkit-contract");
  const copiedPublicSource = path.join(scratch, "packages", "attest", "src");
  mkdirSync(path.dirname(copiedCore), { recursive: true });
  mkdirSync(path.dirname(copiedPublicSource), { recursive: true });
  cpSync(path.resolve("scripts/runkit-contract"), copiedCore, { recursive: true });
  cpSync(path.resolve("packages/attest/src"), copiedPublicSource, { recursive: true });

  const copiedContract = await import(
    `${pathToFileURL(path.join(copiedCore, "core-contract.mjs")).href}?wave4=${Date.now()}`,
  );
  const before = copiedContract.currentCoreIdentity().coreManifestSha256;
  appendFileSync(path.join(copiedPublicSource, "offline-bundle.mjs"), "\n");
  const after = copiedContract.currentCoreIdentity().coreManifestSha256;
  assert.notEqual(after, before);
});

test("offline bundle parsing rejects hidden fields, duplicate keys, and byte drift", async () => {
  const { verification } = await quickFixture();
  const bundle = attest.createOfflineAttestationBundle(verification.receiptPath);

  assert.throws(
    () => attest.parseOfflineAttestationBundle(JSON.stringify({
      ...bundle,
      location: "https://example.test/receipt.json",
    })),
    (error) => error.code === "offline_bundle_invalid",
  );
  assert.throws(
    () => attest.parseOfflineAttestationBundle(
      JSON.stringify(bundle).replace(
        '"schemaVersion":"OwlCodaOfflineAttestationBundleV1"',
        '"schemaVersion":"OwlCodaOfflineAttestationBundleV1","schemaVersion":"forged"',
      ),
    ),
    (error) => error.code === "receipt_duplicate_key",
  );
  assert.throws(
    () => attest.parseOfflineAttestationBundle(JSON.stringify({
      ...bundle,
      receiptBytesBase64: Buffer.alloc(bundle.receiptByteLength, 0x78).toString("base64"),
    })),
    (error) => error.code === "offline_bundle_hash_mismatch",
  );
});

test("Core offline export and import preserve exact receipt bytes without network authority", async () => {
  const { workspace, verification } = await quickFixture();
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-transfer-")));
  const bundlePath = path.join(scratch, "receipt.bundle.json");
  const store = path.join(scratch, "store");
  mkdirSync(store);

  const exported = await runCli([
    "offline-export",
    "--workspace", workspace,
    "--receipt", verification.receiptPath,
    "--output", bundlePath,
  ]);
  assert.equal(exported.status, "offline_bundle_exported", JSON.stringify(exported));
  assert.equal(exported.exitCode, 0);
  assert.equal(exported.authorizationGranted, false);
  assert.equal(exported.networkRequests, 0);
  assert.equal(lstatSync(bundlePath).isFile(), true);

  const imported = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", bundlePath,
    "--store", store,
  ]);
  assert.equal(imported.status, "offline_receipt_imported", JSON.stringify(imported));
  assert.equal(imported.exitCode, 0);
  assert.equal(imported.authorizationGranted, false);
  assert.equal(imported.networkRequests, 0);
  assert.deepEqual(
    readFileSync(imported.receiptPath),
    readFileSync(verification.receiptPath),
  );

  const referencePath = path.join(scratch, "reference.json");
  writeFileSync(referencePath, `${JSON.stringify(imported.reference, null, 2)}\n`);
  const resolved = attest.resolveAttestationRef({
    reference: imported.reference,
    stores: [store],
    workspaceRoot: workspace,
  });
  assert.equal(resolved.status, "resolved_valid");
  assert.equal(resolved.attestation.decision, "GO");
  assert.equal(resolved.networkRequests, 0);
});

test("offline import is idempotent for exact bytes and fails closed on conflicts", async () => {
  const { workspace, verification } = await quickFixture();
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-conflict-")));
  const bundlePath = path.join(scratch, "receipt.bundle.json");
  const store = path.join(scratch, "store");
  mkdirSync(store);
  await runCli([
    "offline-export",
    "--workspace", workspace,
    "--receipt", verification.receiptPath,
    "--output", bundlePath,
  ]);
  const first = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", bundlePath,
    "--store", store,
  ]);
  const originalBytes = readFileSync(first.receiptPath);
  const second = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", bundlePath,
    "--store", store,
  ]);
  assert.equal(second.status, "offline_receipt_already_present");
  assert.deepEqual(readFileSync(first.receiptPath), originalBytes);

  writeFileSync(first.receiptPath, "conflicting bytes\n");
  const conflict = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", bundlePath,
    "--store", store,
  ]);
  assert.equal(conflict.status, "offline_store_conflict");
  assert.equal(conflict.exitCode, 1);
  assert.deepEqual(readFileSync(first.receiptPath), Buffer.from("conflicting bytes\n"));
});

test("offline transfer rejects symlink roots, leaves, and existing export targets", async () => {
  const { workspace, verification } = await quickFixture();
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-symlink-")));
  const bundlePath = path.join(scratch, "receipt.bundle.json");
  const realStore = path.join(scratch, "real-store");
  const linkedStore = path.join(scratch, "linked-store");
  mkdirSync(realStore);
  symlinkSync(realStore, linkedStore);

  const exported = await runCli([
    "offline-export",
    "--workspace", workspace,
    "--receipt", verification.receiptPath,
    "--output", bundlePath,
  ]);
  assert.equal(exported.status, "offline_bundle_exported");
  const duplicate = await runCli([
    "offline-export",
    "--workspace", workspace,
    "--receipt", verification.receiptPath,
    "--output", bundlePath,
  ]);
  assert.equal(duplicate.status, "offline_output_exists");
  assert.equal(duplicate.exitCode, 1);

  const linked = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", bundlePath,
    "--store", linkedStore,
  ]);
  assert.equal(linked.status, "offline_store_invalid");
  assert.equal(linked.exitCode, 3);
  assert.equal(lstatSync(linkedStore).isSymbolicLink(), true);
});

test("offline transfer rejects symlink receipt leaves and ancestor components", async () => {
  const { workspace, verification } = await quickFixture();
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-ancestor-")));
  const linkedReceipt = path.join(workspace, "linked-receipt.json");
  symlinkSync(verification.receiptPath, linkedReceipt);
  const linkedReceiptResult = await runCli([
    "offline-export",
    "--workspace", workspace,
    "--receipt", linkedReceipt,
    "--output", path.join(scratch, "linked-receipt.bundle.json"),
  ]);
  assert.equal(linkedReceiptResult.status, "offline_receipt_invalid");
  assert.equal(linkedReceiptResult.exitCode, 3);

  const realOutputRoot = path.join(scratch, "real-output");
  const linkedOutputRoot = path.join(scratch, "linked-output");
  mkdirSync(path.join(realOutputRoot, "nested"), { recursive: true });
  symlinkSync(realOutputRoot, linkedOutputRoot);
  const linkedOutputResult = await runCli([
    "offline-export",
    "--workspace", workspace,
    "--receipt", verification.receiptPath,
    "--output", path.join(linkedOutputRoot, "nested", "receipt.bundle.json"),
  ]);
  assert.equal(linkedOutputResult.status, "offline_output_invalid");
  assert.equal(linkedOutputResult.exitCode, 3);

  const controlBundle = path.join(scratch, "control.bundle.json");
  const controlExport = await runCli([
    "offline-export",
    "--workspace", workspace,
    "--receipt", verification.receiptPath,
    "--output", controlBundle,
  ]);
  assert.equal(controlExport.status, "offline_bundle_exported");

  const realBundleRoot = path.join(scratch, "real-bundle");
  const linkedBundleRoot = path.join(scratch, "linked-bundle");
  mkdirSync(realBundleRoot);
  const realBundle = path.join(realBundleRoot, "receipt.bundle.json");
  writeFileSync(realBundle, readFileSync(controlBundle));
  symlinkSync(realBundleRoot, linkedBundleRoot);
  const store = path.join(scratch, "control-store");
  mkdirSync(store);
  const linkedBundleResult = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", path.join(linkedBundleRoot, "receipt.bundle.json"),
    "--store", store,
  ]);
  assert.equal(linkedBundleResult.status, "offline_bundle_invalid");
  assert.equal(linkedBundleResult.exitCode, 3);

  const realStoreAncestor = path.join(scratch, "real-store-ancestor");
  const linkedStoreAncestor = path.join(scratch, "linked-store-ancestor");
  mkdirSync(path.join(realStoreAncestor, "nested"), { recursive: true });
  symlinkSync(realStoreAncestor, linkedStoreAncestor);
  const linkedStoreResult = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", controlBundle,
    "--store", path.join(linkedStoreAncestor, "nested"),
  ]);
  assert.equal(linkedStoreResult.status, "offline_store_invalid");
  assert.equal(linkedStoreResult.exitCode, 3);

  const danglingStore = path.join(scratch, "dangling-store");
  const parsedBundle = attest.parseOfflineAttestationBundle(readFileSync(controlBundle, "utf8"));
  const danglingReceiptRoot = path.join(
    danglingStore,
    "quick",
    "receipts",
    parsedBundle.reference.receiptId,
  );
  mkdirSync(danglingReceiptRoot, { recursive: true });
  symlinkSync(
    path.join(danglingReceiptRoot, "missing.json"),
    path.join(danglingReceiptRoot, "receipt.json"),
  );
  const danglingStoreResult = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", controlBundle,
    "--store", danglingStore,
  ]);
  assert.equal(danglingStoreResult.status, "offline_store_invalid");
  assert.equal(danglingStoreResult.exitCode, 3);

  const danglingAncestorStore = path.join(scratch, "dangling-ancestor-store");
  mkdirSync(danglingAncestorStore);
  symlinkSync(path.join(danglingAncestorStore, "missing"), path.join(danglingAncestorStore, "quick"));
  const danglingAncestorResult = await runCli([
    "offline-import",
    "--workspace", workspace,
    "--bundle", controlBundle,
    "--store", danglingAncestorStore,
  ]);
  assert.equal(danglingAncestorResult.status, "offline_store_invalid");
  assert.equal(danglingAncestorResult.exitCode, 3);
});
