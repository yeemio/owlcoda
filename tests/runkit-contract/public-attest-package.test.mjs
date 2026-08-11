import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runQuickVerification } from "../../scripts/runkit-contract/quick-verify.mjs";

const packageRoot = path.resolve("packages/attest");
const packageEntry = path.join(packageRoot, "src", "index.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "owlcoda-public-attest-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "attest@example.test");
  git(root, "config", "user.name", "Attest Test");
  writeFileSync(path.join(root, "source.txt"), "stable\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return root;
}

async function publicApi() {
  return import(pathToFileURL(packageEntry).href);
}

function formalBundle(sha256Canonical) {
  const source = { files: [{ path: "source.txt", sha256: `sha256:${"1".repeat(64)}` }] };
  const context = { runtime: "node", platform: process.platform };
  const sourceFingerprint = sha256Canonical(source);
  const contextFingerprint = sha256Canonical(context);
  return {
    schemaVersion: "OwlCodaRunKitPublicVerificationBundleV1",
    source: {
      fingerprintAlgorithm: "sha256-canonical-json-v1",
      fingerprint: sourceFingerprint,
      payload: source,
    },
    verificationContext: {
      fingerprintAlgorithm: "sha256-canonical-json-v1",
      fingerprint: contextFingerprint,
      payload: context,
    },
    receipts: [{
      schemaVersion: "OwlCodaRunKitPublicVerificationReceiptV1",
      receiptId: "formal-receipt-001",
      status: "passed",
      replacesReceiptId: null,
      sourceFingerprint,
      verificationContextFingerprint: contextFingerprint,
      authorizationGranted: false,
      gitAuthorization: false,
      releaseAuthorization: false,
      artifactMutationAuthorization: false,
      businessActionAuthorization: false,
    }],
    closeout: {
      schemaVersion: "OwlCodaRunKitPublicCloseoutV1",
      decision: "accepted",
      activeReceiptId: "formal-receipt-001",
      sourceFingerprint,
      verificationContextFingerprint: contextFingerprint,
      authorizationGranted: false,
      gitAuthorization: false,
      releaseAuthorization: false,
      artifactMutationAuthorization: false,
      businessActionAuthorization: false,
    },
  };
}

test("public package exports the complete read-only V1 consumer API", async () => {
  const api = await publicApi();

  for (const name of [
    "canonicalJson",
    "parseJsonStrict",
    "sha256Canonical",
    "attestFile",
    "attestQuickReceiptDetails",
    "createAttestationRef",
    "parseAttestationRef",
    "resolveAttestationRef",
    "verifyBundle",
  ]) {
    assert.equal(typeof api[name], "function", name);
  }
});

test("public package attests Wave 1 Quick receipts without private imports", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });

  const result = api.attestFile({
    subjectPath: verification.receiptPath,
    workspaceRoot: root,
  });

  assert.equal(result.status, "quick_attestation");
  assert.equal(result.decision, "GO");
  assert.equal(result.attestation.decision, "GO");
  assert.equal(result.authorizationGranted, false);

  const sourceFiles = [
    "src/index.mjs",
    "src/canonical.mjs",
    "src/workspace-snapshot.mjs",
    "src/quick.mjs",
    "src/formal.mjs",
    "src/reference.mjs",
  ];
  for (const relativePath of sourceFiles) {
    const source = readFileSync(path.join(packageRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /scripts\/runkit-contract|desktop\/osui|src\/native/);
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)]
      .map((match) => match[1])
      .filter((specifier) => !specifier.startsWith("./") && !specifier.startsWith("../"));
    assert.ok(imports.every((specifier) => specifier.startsWith("node:")), relativePath);
  }
});

test("public package keeps the accepted unsigned Wave 1 Core identity verifiable", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const receipt = JSON.parse(readFileSync(verification.receiptPath, "utf8"));
  receipt.coreIdentity = {
    contractVersion: "0.2",
    coreVersion: "0.12.0",
    coreManifestSha256: "sha256:c415b10cb00d2a7891744b7257774fa501ddf40f8ec2f290356505a17fefb40f",
  };
  writeFileSync(verification.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const result = api.attestFile({
    subjectPath: verification.receiptPath,
    workspaceRoot: root,
  });
  assert.equal(result.decision, "GO");
  assert.ok(result.attestation.issueCodes.includes("signature_absent"));
});

test("Quick attestation binds the complete Core identity", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const receipt = JSON.parse(readFileSync(verification.receiptPath, "utf8"));

  const wrongCoreVersion = structuredClone(receipt);
  wrongCoreVersion.coreIdentity.coreVersion = "999.0.0";
  writeFileSync(verification.receiptPath, `${JSON.stringify(wrongCoreVersion, null, 2)}\n`);
  const wrongCoreResult = api.attestFile({
    subjectPath: verification.receiptPath,
    workspaceRoot: root,
  });
  assert.equal(wrongCoreResult.decision, "NO_GO");
  assert.ok(wrongCoreResult.attestation.issueCodes.includes("core_identity_mismatch"));
});

test("Quick attestation binds exactCommand.cwd to the selected workspace", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const receipt = JSON.parse(readFileSync(verification.receiptPath, "utf8"));
  const alternateCommandRoot = mkdtempSync(path.join(tmpdir(), "owlcoda-attest-cwd-"));
  for (const artifact of [receipt.outputArtifacts.stdout, receipt.outputArtifacts.stderr]) {
    const source = path.join(root, artifact.path);
    const destination = path.join(alternateCommandRoot, artifact.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination);
  }
  const wrongCommandRoot = structuredClone(receipt);
  wrongCommandRoot.exactCommand.cwd = alternateCommandRoot;
  writeFileSync(verification.receiptPath, `${JSON.stringify(wrongCommandRoot, null, 2)}\n`);
  const wrongCommandRootResult = api.attestFile({
    subjectPath: verification.receiptPath,
    workspaceRoot: root,
  });
  assert.equal(wrongCommandRootResult.decision, "NO_GO");
  assert.ok(wrongCommandRootResult.attestation.issueCodes.includes("receipt_source_mismatch"));
});

test("attestation rejects invalid UTF-8", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const originalBytes = readFileSync(verification.receiptPath);
  const receipt = JSON.parse(originalBytes.toString("utf8"));
  const receiptIdBytes = Buffer.from(receipt.receiptId);
  const receiptIdOffset = originalBytes.indexOf(receiptIdBytes);
  assert.ok(receiptIdOffset >= 0);
  const invalidUtf8 = Buffer.from(originalBytes);
  invalidUtf8[receiptIdOffset] = 0xff;
  writeFileSync(verification.receiptPath, invalidUtf8);
  assert.throws(
    () => api.attestFile({ subjectPath: verification.receiptPath, workspaceRoot: root }),
    (error) => error.code === "INPUT_JSON_INVALID",
  );
});

test("all direct receipt APIs reject a symlink leaf", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const receiptLink = path.join(root, "receipt-link.json");
  symlinkSync(verification.receiptPath, receiptLink);
  assert.throws(
    () => api.attestFile({ subjectPath: receiptLink, workspaceRoot: root }),
    (error) => error.code === "INPUT_FILE_INVALID",
  );
  assert.throws(
    () => api.attestQuickReceiptDetails({ receiptPath: receiptLink, workspaceRoot: root }),
    (error) => error.code === "INPUT_FILE_INVALID",
  );
  assert.throws(
    () => api.createAttestationRef(receiptLink),
    (error) => error.code === "INPUT_FILE_INVALID",
  );
});

test("all public receipt paths enforce the byte limit before whole-file allocation", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const reference = api.createAttestationRef(verification.receiptPath);
  writeFileSync(
    verification.receiptPath,
    Buffer.alloc(api.PUBLIC_VERIFIER_LIMITS.maxInputBytes + 1, 0x20),
  );

  for (const operation of [
    () => api.attestFile({ subjectPath: verification.receiptPath, workspaceRoot: root }),
    () => api.attestQuickReceiptDetails({
      receiptPath: verification.receiptPath,
      workspaceRoot: root,
    }),
    () => api.createAttestationRef(verification.receiptPath),
    () => api.resolveAttestationRef({
      reference,
      stores: [path.join(root, ".owlcoda", "runkit")],
      workspaceRoot: root,
    }),
  ]) {
    assert.throws(operation, (error) => error.code === "INPUT_SIZE_LIMIT_EXCEEDED");
  }

  const formalSource = readFileSync(path.join(packageRoot, "src", "formal.mjs"), "utf8");
  assert.match(formalSource, /export function readFileBytesBounded/);
  for (const relativePath of [
    "src/index.mjs",
    "src/quick.mjs",
    "src/reference-contract.mjs",
  ]) {
    const source = readFileSync(path.join(packageRoot, relativePath), "utf8");
    assert.doesNotMatch(source, /\breadFileSync\b/, relativePath);
    assert.match(source, /\breadFileBytesBounded\b/, relativePath);
  }
  const referenceSource = readFileSync(path.join(packageRoot, "src", "reference.mjs"), "utf8");
  assert.doesNotMatch(referenceSource, /\breadFileSync\b/, "src/reference.mjs");
  assert.match(referenceSource, /\breadQuickReceiptFile\b/, "src/reference.mjs");
});

test("public package attests accepted Formal bundles and rejects binding drift", async () => {
  const api = await publicApi();
  const root = mkdtempSync(path.join(tmpdir(), "owlcoda-formal-attest-"));
  const validPath = path.join(root, "valid.json");
  const invalidPath = path.join(root, "invalid.json");
  const valid = formalBundle(api.sha256Canonical);
  writeFileSync(validPath, `${JSON.stringify(valid, null, 2)}\n`);
  const invalid = structuredClone(valid);
  invalid.receipts[0].sourceFingerprint = `sha256:${"2".repeat(64)}`;
  writeFileSync(invalidPath, `${JSON.stringify(invalid, null, 2)}\n`);

  const accepted = api.attestFile({ subjectPath: validPath });
  const rejected = api.attestFile({ subjectPath: invalidPath });
  const blocked = api.attestFile({
    subjectPath: path.join(packageRoot, "fixtures", "good", "blocked-single-leaf.json"),
  });

  assert.equal(accepted.status, "formal_attestation");
  assert.equal(accepted.decision, "GO");
  assert.equal(accepted.formalVerification.valid, true);
  assert.equal(rejected.decision, "NO_GO");
  assert.equal(rejected.formalVerification.valid, false);
  assert.equal(accepted.authorizationGranted, false);
  assert.equal(blocked.formalVerification.valid, true);
  assert.equal(blocked.formalVerification.decision, "blocked");
  assert.equal(blocked.decision, "NO_GO");
  assert.equal(blocked.exitCode, 1);
  assert.equal(blocked.nextAllowedAction, "honor_formal_decision");
});

test("AttestationRef resolves one exact local receipt and fails closed otherwise", async () => {
  const api = await publicApi();
  const root = repository();
  const verification = await runQuickVerification({
    workspaceRoot: root,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const reference = api.createAttestationRef(verification.receiptPath);
  assert.equal(api.parseAttestationRef(JSON.stringify(reference)).receiptId, reference.receiptId);

  const unchecked = api.resolveAttestationRef({
    reference,
    stores: [path.join(root, ".owlcoda", "runkit")],
  });
  assert.equal(unchecked.status, "resolved_indeterminate");
  assert.equal(unchecked.exitCode, 3);
  assert.equal(unchecked.attestation.decision, "INDETERMINATE");

  const resolved = api.resolveAttestationRef({
    reference,
    stores: [path.join(root, ".owlcoda", "runkit")],
    workspaceRoot: root,
  });
  assert.equal(resolved.status, "resolved_valid");
  assert.equal(resolved.attestation.decision, "GO");
  assert.equal(resolved.authorizationGranted, false);
  assert.equal(resolved.networkRequests, 0);

  const missing = api.resolveAttestationRef({
    reference: { ...reference, receiptId: "missing-receipt" },
    stores: [path.join(root, ".owlcoda", "runkit")],
  });
  assert.equal(missing.status, "not_found");
  assert.equal(missing.exitCode, 3);

  const secondStore = mkdtempSync(path.join(tmpdir(), "owlcoda-attest-store-"));
  const duplicateRoot = path.join(
    secondStore,
    "quick",
    "receipts",
    reference.receiptId,
  );
  mkdirSync(duplicateRoot, { recursive: true });
  cpSync(verification.receiptPath, path.join(duplicateRoot, "receipt.json"));
  const ambiguous = api.resolveAttestationRef({
    reference,
    stores: [path.join(root, ".owlcoda", "runkit"), secondStore],
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.exitCode, 1);

  const badHash = api.resolveAttestationRef({
    reference: { ...reference, receiptSha256: `sha256:${"f".repeat(64)}` },
    stores: [path.join(root, ".owlcoda", "runkit")],
  });
  assert.equal(badHash.status, "resolved_invalid");
  assert.equal(badHash.exitCode, 1);

  const unsupportedStore = mkdtempSync(path.join(tmpdir(), "owlcoda-attest-unsupported-"));
  const unsupportedRoot = path.join(
    unsupportedStore,
    "quick",
    "receipts",
    reference.receiptId,
  );
  mkdirSync(unsupportedRoot, { recursive: true });
  const unsupportedReceipt = JSON.parse(readFileSync(verification.receiptPath, "utf8"));
  unsupportedReceipt.coreIdentity.coreManifestSha256 = `sha256:${"e".repeat(64)}`;
  const unsupportedPath = path.join(unsupportedRoot, "receipt.json");
  writeFileSync(unsupportedPath, `${JSON.stringify(unsupportedReceipt, null, 2)}\n`);
  const unsupportedReference = api.createAttestationRef(unsupportedPath);
  const unsupported = api.resolveAttestationRef({
    reference: unsupportedReference,
    stores: [unsupportedStore],
  });
  assert.equal(unsupported.status, "resolved_invalid");
  assert.equal(unsupported.exitCode, 1);
  assert.ok(unsupported.issueCodes.includes("core_identity_mismatch"));

  const symlinkStore = path.join(mkdtempSync(path.join(tmpdir(), "owlcoda-attest-link-")), "store");
  symlinkSync(path.join(root, ".owlcoda", "runkit"), symlinkStore);
  const escaped = api.resolveAttestationRef({
    reference,
    stores: [symlinkStore],
  });
  assert.equal(escaped.status, "not_found");
  assert.equal(escaped.exitCode, 3);
});

test("strict reference parsing rejects duplicate keys, extra fields, and URLs", async () => {
  const { parseAttestationRef, resolveAttestationRef } = await publicApi();
  const reference = {
    schemaVersion: "OwlCodaAttestationRefV1",
    receiptId: "a",
    receiptSha256: `sha256:${"a".repeat(64)}`,
    coreIdentity: {
      contractVersion: "0.2",
      coreManifestSha256: `sha256:${"b".repeat(64)}`,
    },
  };

  assert.throws(
    () => parseAttestationRef('{"schemaVersion":"OwlCodaAttestationRefV1","receiptId":"a","receiptId":"b"}'),
    (error) => error.code === "receipt_duplicate_key",
  );
  assert.throws(
    () => parseAttestationRef(JSON.stringify({
      schemaVersion: "OwlCodaAttestationRefV1",
      receiptId: "a",
      receiptSha256: `sha256:${"a".repeat(64)}`,
      coreIdentity: {
        contractVersion: "0.2",
        coreManifestSha256: `sha256:${"b".repeat(64)}`,
      },
      location: "https://example.test/receipt.json",
    })),
    (error) => error.code === "receipt_schema_invalid",
  );
  assert.throws(
    () => resolveAttestationRef({ reference, stores: [] }),
    (error) => error.code === "receipt_schema_invalid",
  );
  assert.throws(
    () => resolveAttestationRef({ reference, stores: [""] }),
    (error) => error.code === "receipt_schema_invalid",
  );
});

test("standalone package ships the frozen unsigned schemas", () => {
  for (const name of [
    "attestation-ref-v1.schema.json",
    "attestation-result-v1.schema.json",
    "quick-verification-receipt-v1.schema.json",
    "workspace-snapshot-v1.schema.json",
  ]) {
    const frozen = JSON.parse(readFileSync(
      path.join("docs", "architecture", "runkit-trust-product-v1", "schemas", name),
      "utf8",
    ));
    const packaged = JSON.parse(readFileSync(path.join(packageRoot, "schemas", name), "utf8"));
    assert.deepEqual(packaged, frozen, name);
  }
});

test("standalone package packs, installs, imports, and contains no private product source", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "owlcoda-attest-package-"));
  const packOutput = JSON.parse(execFileSync("npm", [
    "pack",
    "--json",
    "--pack-destination",
    scratch,
  ], {
    cwd: packageRoot,
    encoding: "utf8",
  }));
  const packed = Array.isArray(packOutput)
    ? packOutput[0]
    : packOutput["@owlcoda/attest"] ?? Object.values(packOutput)[0];
  const tarball = path.join(scratch, packed.filename);
  const installRoot = path.join(scratch, "install");
  execFileSync("npm", [
    "install",
    "--offline",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--prefix",
    installRoot,
    tarball,
  ], { stdio: "ignore" });

  const installedRoot = path.join(installRoot, "node_modules", "@owlcoda", "attest");
  const imported = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import(${JSON.stringify(pathToFileURL(path.join(installedRoot, "src", "index.mjs")).href)})
      .then((api) => {
        if (typeof api.attestFile !== "function" || typeof api.resolveAttestationRef !== "function") {
          process.exit(1);
        }
      });`,
  ]);
  assert.equal(imported.byteLength, 0);
  assert.ok(readdirSync(path.join(installedRoot, "schemas")).includes("attestation-ref-v1.schema.json"));

  const bundlePath = path.join(scratch, "formal-bundle.json");
  writeFileSync(bundlePath, `${JSON.stringify(formalBundle((value) => {
    const script = `import {sha256Canonical} from ${JSON.stringify(
      pathToFileURL(path.join(installedRoot, "src", "index.mjs")).href,
    )}; process.stdout.write(sha256Canonical(${JSON.stringify(value)}));`;
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
  }), null, 2)}\n`);
  const cliResult = JSON.parse(execFileSync(
    process.execPath,
    [
      path.join(installedRoot, "cli", "owlcoda-attest.mjs"),
      "attest",
      bundlePath,
      "--json",
    ],
    { encoding: "utf8" },
  ));
  assert.equal(cliResult.status, "formal_attestation");
  assert.equal(cliResult.decision, "GO");
  assert.equal(cliResult.authorizationGranted, false);

  const synthetic = repository();
  const quick = await runQuickVerification({
    workspaceRoot: synthetic,
    commandArgv: [process.execPath, "-e", "process.exit(0)"],
  });
  const api = await publicApi();
  const referencePath = path.join(scratch, "attestation-ref.json");
  writeFileSync(
    referencePath,
    `${JSON.stringify(api.createAttestationRef(quick.receiptPath), null, 2)}\n`,
  );
  const resolution = JSON.parse(execFileSync(
    process.execPath,
    [
      path.join(installedRoot, "cli", "owlcoda-attest.mjs"),
      "resolve",
      referencePath,
      "--store",
      path.join(synthetic, ".owlcoda", "runkit"),
      "--workspace",
      synthetic,
      "--json",
    ],
    { encoding: "utf8" },
  ));
  assert.equal(resolution.status, "resolved_valid");
  assert.equal(resolution.attestation.decision, "GO");
  assert.equal(resolution.networkRequests, 0);

  const tarEntries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  assert.doesNotMatch(tarEntries, /scripts\/runkit-contract|desktop\/osui|src\/native/);
});
