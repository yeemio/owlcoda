import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runQuickVerification } from "../../scripts/runkit-contract/quick-verify.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(root, "packages", "attest");
const nMinusOneTarball = path.join(
  packageRoot,
  "compatibility",
  "owlcoda-attest-wave3-n-minus-1-0.1.0.tgz",
);

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function pack(cwd, destination) {
  const output = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    { cwd, encoding: "utf8" },
  ));
  const entry = Array.isArray(output) ? output[0] : Object.values(output)[0];
  return path.join(destination, entry.filename);
}

function install(prefix, tarball) {
  execFileSync("npm", [
    "install",
    "--offline",
    "--force",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    prefix,
    tarball,
  ], { stdio: "ignore" });
}

function installedPackage(prefix) {
  return path.join(prefix, "node_modules", "@owlcoda", "attest");
}

function installedCli(prefix) {
  return path.join(installedPackage(prefix), "cli", "owlcoda-attest.mjs");
}

function installedOwlcodaCli(prefix) {
  return path.join(prefix, "node_modules", ".bin", "owlcoda");
}

function cli(prefix, args) {
  return spawnSync(process.execPath, [installedCli(prefix), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      PAGER: "cat",
      npm_config_offline: "true",
    },
  });
}

test("Wave 4 ships a declared public manifest, support policy, and exact N-1 fixture", () => {
  assert.equal(existsSync(path.join(packageRoot, "distribution-manifest-v1.json")), true);
  assert.equal(existsSync(path.join(
    root,
    "docs",
    "architecture",
    "runkit-attestation-v1",
    "UNSIGNED_V1_SUPPORT_POLICY.md",
  )), true);
  assert.equal(existsSync(path.join(
    root,
    "docs",
    "architecture",
    "runkit-attestation-v1",
    "UPGRADE_AND_ROLLBACK.md",
  )), true);
  assert.equal(existsSync(nMinusOneTarball), true);

  const manifest = JSON.parse(readFileSync(
    path.join(packageRoot, "distribution-manifest-v1.json"),
    "utf8",
  ));
  assert.equal(manifest.schemaVersion, "OwlCodaRunKitDistributionManifestV1");
  assert.equal(manifest.consumerSurface, "unsigned_v1");
  assert.equal(manifest.current.packageVersion, "0.2.0");
  assert.equal(manifest.nMinusOne.packageVersion, "0.1.0");
  assert.equal(manifest.nMinusOne.tarballSha256, `sha256:${sha256File(nMinusOneTarball)}`);
  assert.equal(manifest.authorizationGranted, false);
});

test("N-1 to N to N-1 installed verifier cycle preserves receipts and decisions", { timeout: 180_000 }, async () => {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-upgrade-")));
  const installRoot = path.join(scratch, "install");
  const packedN = pack(packageRoot, scratch);
  const acceptedBundlePath = path.join(scratch, "accepted-wave3-bundle.json");
  writeFileSync(
    acceptedBundlePath,
    execFileSync("tar", [
      "-xOf",
      nMinusOneTarball,
      "package/fixtures/good/accepted-replacement-chain.json",
    ]),
  );
  const acceptedBundleBefore = readFileSync(acceptedBundlePath);
  const projectRoot = path.join(scratch, "project");
  execFileSync("git", ["init", "-q", projectRoot]);
  execFileSync("git", ["-C", projectRoot, "config", "user.email", "wave4@example.test"]);
  execFileSync("git", ["-C", projectRoot, "config", "user.name", "Wave 4 Test"]);
  writeFileSync(path.join(projectRoot, "source.txt"), "stable\n");
  execFileSync("git", ["-C", projectRoot, "add", "."]);
  execFileSync("git", ["-C", projectRoot, "commit", "-qm", "initial"]);
  const verification = await runQuickVerification({
    workspaceRoot: projectRoot,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const receiptBefore = readFileSync(verification.receiptPath);

  install(installRoot, nMinusOneTarball);
  assert.equal(
    JSON.parse(readFileSync(path.join(installedPackage(installRoot), "package.json"))).version,
    "0.1.0",
  );
  const oldDecision = cli(installRoot, [
    "attest",
    acceptedBundlePath,
    "--json",
  ]);
  assert.equal(oldDecision.status, 0, `${oldDecision.stdout}\n${oldDecision.stderr}`);
  assert.equal(JSON.parse(oldDecision.stdout).decision, "GO");

  install(installRoot, packedN);
  assert.equal(
    JSON.parse(readFileSync(path.join(installedPackage(installRoot), "package.json"))).version,
    "0.2.0",
  );
  const newDecision = cli(installRoot, [
    "attest",
    verification.receiptPath,
    "--workspace",
    projectRoot,
    "--json",
  ]);
  assert.equal(newDecision.status, 0, `${newDecision.stdout}\n${newDecision.stderr}`);
  assert.equal(JSON.parse(newDecision.stdout).decision, "GO");
  const historicalDecision = cli(installRoot, [
    "attest",
    acceptedBundlePath,
    "--json",
  ]);
  assert.equal(historicalDecision.status, 0, `${historicalDecision.stdout}\n${historicalDecision.stderr}`);
  assert.equal(JSON.parse(historicalDecision.stdout).decision, "GO");

  install(installRoot, nMinusOneTarball);
  assert.equal(
    JSON.parse(readFileSync(path.join(installedPackage(installRoot), "package.json"))).version,
    "0.1.0",
  );
  const rollbackDecision = cli(installRoot, [
    "attest",
    acceptedBundlePath,
    "--json",
  ]);
  assert.equal(rollbackDecision.status, 0, `${rollbackDecision.stdout}\n${rollbackDecision.stderr}`);
  assert.equal(JSON.parse(rollbackDecision.stdout).decision, "GO");
  assert.deepEqual(readFileSync(verification.receiptPath), receiptBefore);
  assert.deepEqual(readFileSync(acceptedBundlePath), acceptedBundleBefore);
});

test("packed surfaces expose installed help and exclude private product material", { timeout: 180_000 }, () => {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-pack-")));
  const attestTarball = pack(packageRoot, scratch);
  const attestEntries = execFileSync("tar", ["-tzf", attestTarball], { encoding: "utf8" });
  assert.doesNotMatch(
    attestEntries,
    /desktop\/|src\/native\/|scripts\/runkit-contract\/|execution-prompts\/|\.owlcoda\/|credential|private-engine/i,
  );
  for (const required of [
    "package/distribution-manifest-v1.json",
    "package/schemas/offline-attestation-bundle-v1.schema.json",
    "package/README.md",
  ]) {
    assert.match(attestEntries, new RegExp(`^${required.replaceAll(".", "\\.")}$`, "m"));
  }

  const installRoot = path.join(scratch, "install");
  install(installRoot, attestTarball);
  const help = cli(installRoot, ["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /attest <receipt-or-bundle\.json>/);
  assert.match(help.stdout, /resolve <attestation-ref\.json>/);
  assert.match(help.stdout, /network requests: 0/i);
  assert.equal(readdirSync(installedPackage(installRoot)).includes("distribution-manifest-v1.json"), true);
});

test("packed OwlCoda CLI produces and transfers unsigned evidence using installed help", { timeout: 180_000 }, () => {
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave4-root-pack-")));
  const rootTarball = pack(root, scratch);
  const entries = execFileSync("tar", ["-tzf", rootTarball], { encoding: "utf8" });
  assert.doesNotMatch(
    entries,
    /package\/desktop\/|package\/docs\/execution-prompts\/|package\/\.owlcoda\/|credential|private-engine/i,
  );
  assert.doesNotMatch(
    entries,
    /package\/packages\/attest\/(?:compatibility|test)\//,
  );
  for (const required of [
    "package/dist/native/runkit-command-port.js",
    "package/scripts/runkit-contract/offline-store.mjs",
    "package/packages/attest/distribution-manifest-v1.json",
    "package/packages/attest/schemas/offline-attestation-bundle-v1.schema.json",
  ]) {
    assert.match(entries, new RegExp(`^${required.replaceAll(".", "\\.")}$`, "m"));
  }

  const installRoot = path.join(scratch, "install");
  install(installRoot, rootTarball);
  const owlcoda = installedOwlcodaCli(installRoot);
  const help = spawnSync(owlcoda, ["runkit", "store", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /OwlCodaOfflineAttestationBundleV1/);
  assert.match(help.stdout, /network requests: 0/);

  const projectRoot = path.join(scratch, "project");
  execFileSync("git", ["init", "-q", projectRoot]);
  execFileSync("git", ["-C", projectRoot, "config", "user.email", "wave4@example.test"]);
  execFileSync("git", ["-C", projectRoot, "config", "user.name", "Wave 4 Test"]);
  writeFileSync(path.join(projectRoot, "source.txt"), "stable\n");
  execFileSync("git", ["-C", projectRoot, "add", "."]);
  execFileSync("git", ["-C", projectRoot, "commit", "-qm", "initial"]);
  const verified = spawnSync(owlcoda, [
    "runkit", "verify", "--json", "--",
    process.execPath, "-e", "process.exit(0)",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(verified.status, 0, `${verified.stdout}\n${verified.stderr}`);
  const verification = JSON.parse(verified.stdout);
  const receiptBefore = readFileSync(verification.receiptPath);

  const bundlePath = path.join(scratch, "receipt.bundle.json");
  const exported = spawnSync(owlcoda, [
    "runkit", "store", "export",
    "--receipt", verification.receiptPath,
    "--output", bundlePath,
    "--json",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(exported.status, 0, `${exported.stdout}\n${exported.stderr}`);
  assert.equal(JSON.parse(exported.stdout).status, "offline_bundle_exported");

  const store = path.join(scratch, "offline-store");
  mkdirSync(store);
  const imported = spawnSync(owlcoda, [
    "runkit", "store", "import",
    "--bundle", bundlePath,
    "--store", store,
    "--json",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(imported.status, 0, `${imported.stdout}\n${imported.stderr}`);
  const importResult = JSON.parse(imported.stdout);
  assert.equal(importResult.status, "offline_receipt_imported");
  assert.deepEqual(readFileSync(importResult.receiptPath), receiptBefore);

  const referencePath = path.join(scratch, "attestation-ref.json");
  writeFileSync(referencePath, `${JSON.stringify(importResult.reference, null, 2)}\n`);
  const resolved = spawnSync(owlcoda, [
    "resolve", referencePath, "--store", store, "--workspace", projectRoot, "--json",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(resolved.status, 0, `${resolved.stdout}\n${resolved.stderr}`);
  assert.equal(JSON.parse(resolved.stdout).status, "resolved_valid");
  assert.deepEqual(readFileSync(verification.receiptPath), receiptBefore);
});
