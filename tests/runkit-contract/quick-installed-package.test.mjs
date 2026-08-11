import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("packed CLI generates and attests a Quick receipt in a clean project", { timeout: 180_000 }, () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-package-"));
  const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const packResult = JSON.parse(packOutput);
  const packageEntry = Array.isArray(packResult)
    ? packResult[0]
    : packResult.owlcoda ?? Object.values(packResult)[0];
  const { filename } = packageEntry;
  const installRoot = path.join(scratch, "install");
  const projectRoot = path.join(scratch, "project");
  execFileSync("npm", ["init", "-y"], { cwd: scratch, stdio: "ignore" });
  execFileSync("npm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installRoot,
    path.join(scratch, filename),
  ], { stdio: "ignore" });
  execFileSync("git", ["init", "-q", projectRoot]);
  execFileSync("git", ["-C", projectRoot, "config", "user.email", "quick@example.test"]);
  execFileSync("git", ["-C", projectRoot, "config", "user.name", "Quick Test"]);
  writeFileSync(path.join(projectRoot, "source.txt"), "stable\n");
  execFileSync("git", ["-C", projectRoot, "add", "."]);
  execFileSync("git", ["-C", projectRoot, "commit", "-qm", "initial"]);
  const cli = path.join(installRoot, "node_modules", ".bin", "owlcoda");

  const verified = spawnSync(cli, [
    "runkit", "verify", "--json", "--",
    process.execPath, "-e", "process.stdout.write('package ok\\n')",
  ], { cwd: projectRoot, encoding: "utf8" });
  assert.equal(verified.status, 0, verified.stderr);
  const verification = JSON.parse(verified.stdout);
  assert.equal(verification.status, "quick_verification_passed");
  assert.equal(readFileSync(verification.receiptPath, "utf8").includes("captured_verification"), true);

  const attested = spawnSync(cli, [
    "attest",
    verification.receiptPath,
    "--workspace",
    projectRoot,
    "--json",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(attested.status, 0, attested.stderr);
  const attestation = JSON.parse(attested.stdout);
  assert.equal(attestation.status, "quick_attestation");
  assert.equal(attestation.attestation.decision, "GO");
  assert.equal(attestation.receiptPath, verification.receiptPath);
  assert.match(attestation.receiptSha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(attestation.sourceFingerprint, verification.sourceFingerprint);
  assert.equal(attestation.nextAllowedAction, "consume_attestation");
  assert.equal(attestation.authorizationGranted, false);

  const formalBundlePath = path.join(
    process.cwd(),
    "packages",
    "attest",
    "fixtures",
    "good",
    "accepted-replacement-chain.json",
  );
  const formal = spawnSync(cli, ["attest", formalBundlePath, "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(formal.status, 0, `${formal.stdout}\n${formal.stderr}`);
  const formalAttestation = JSON.parse(formal.stdout);
  assert.equal(formalAttestation.status, "formal_attestation");
  assert.equal(formalAttestation.decision, "GO");
  assert.equal(formalAttestation.formalVerification.valid, true);
  assert.equal(formalAttestation.authorizationGranted, false);

  const blockedBundlePath = path.join(
    process.cwd(),
    "packages",
    "attest",
    "fixtures",
    "good",
    "blocked-single-leaf.json",
  );
  const blocked = spawnSync(cli, ["attest", blockedBundlePath, "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(blocked.status, 1, `${blocked.stdout}\n${blocked.stderr}`);
  const blockedAttestation = JSON.parse(blocked.stdout);
  assert.equal(blockedAttestation.status, "formal_attestation");
  assert.equal(blockedAttestation.decision, "NO_GO");
  assert.equal(blockedAttestation.formalVerification.valid, true);
  assert.equal(blockedAttestation.formalVerification.decision, "blocked");
  assert.equal(blockedAttestation.nextAllowedAction, "honor_formal_decision");

  writeFileSync(path.join(projectRoot, "source.txt"), "changed after verification\n");
  const stale = spawnSync(cli, [
    "attest",
    verification.receiptPath,
    "--workspace",
    projectRoot,
    "--json",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(stale.status, 2, stale.stderr);
  const staleResult = JSON.parse(stale.stdout);
  assert.equal(staleResult.attestation.decision, "NO_GO");
  assert.ok(staleResult.attestation.issueCodes.includes("receipt_source_mismatch"));

  writeFileSync(path.join(projectRoot, "source.txt"), "stable\n");
  const referencePath = path.join(scratch, "attestation-ref.json");
  writeFileSync(
    referencePath,
    `${JSON.stringify(attestation.attestation.subjectRef, null, 2)}\n`,
  );
  const resolved = spawnSync(cli, [
    "resolve",
    referencePath,
    "--store",
    path.join(projectRoot, ".owlcoda", "runkit"),
    "--workspace",
    projectRoot,
    "--json",
  ], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  assert.equal(resolved.status, 0, resolved.stderr);
  const resolution = JSON.parse(resolved.stdout);
  assert.equal(resolution.status, "resolved_valid");
  assert.equal(resolution.attestation.decision, "GO");
  assert.equal(resolution.networkRequests, 0);
  assert.equal(resolution.authorizationGranted, false);
});
