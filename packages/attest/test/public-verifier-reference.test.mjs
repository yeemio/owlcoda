import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(testDirectory, "..");
const verifierPath = path.join(rootDirectory, "src", "formal.mjs");
const verifierUrl = pathToFileURL(verifierPath).href;
const fixtureIndexPath = path.join(rootDirectory, "fixtures", "index.json");
const schemaPath = path.join(
  rootDirectory,
  "schemas",
  "public-verification-bundle-v1.schema.json",
);

async function loadVerifierOrNull() {
  return import(verifierUrl).catch(() => null);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("exports the standalone public verifier API", async () => {
  const verifier = await loadVerifierOrNull();

  assert.ok(verifier, "expected verifier.mjs to be importable");
  assert.equal(typeof verifier.canonicalJson, "function");
  assert.equal(typeof verifier.parseJsonStrict, "function");
  assert.equal(typeof verifier.sha256Canonical, "function");
  assert.equal(typeof verifier.verifyBundle, "function");
});

test("strict JSON parsing rejects duplicate object keys before last-wins collapse", async () => {
  const { parseJsonStrict } = await import(verifierUrl);

  assert.throws(
    () => parseJsonStrict('{"decision":"blocked","decision":"accepted"}'),
    (error) => error.code === "DUPLICATE_OBJECT_KEY",
  );
  assert.throws(
    () => parseJsonStrict('\u00a0{"a":1}'),
    (error) => error.code === "INPUT_JSON_INVALID",
  );
  assert.deepEqual(parseJsonStrict('{"a":1,"nested":{"a":2}}'), { a: 1, nested: { a: 2 } });
});

test("canonical JSON sorts object keys recursively and preserves array order", async () => {
  const { canonicalJson, sha256Canonical } = await import(verifierUrl);
  const value = { z: [3, 2, 1], a: { b: 1, a: 0 } };

  assert.equal(canonicalJson(value), '{"a":{"a":0,"b":1},"z":[3,2,1]}');
  assert.equal(
    sha256Canonical(value),
    "sha256:3bf9b7b5d6e7ed8f345950b0602423749bf9f1bd66bc37777fbac7f15cdc094a",
  );
});

test("the indexed fixtures produce their declared valid or invalid result", async () => {
  const { verifyBundle } = await import(verifierUrl);
  const index = await readJson(fixtureIndexPath);

  assert.equal(index.schemaVersion, "OwlCodaRunKitPublicVerifierFixtureIndexV1");
  assert.ok(index.fixtures.some((entry) => entry.expectedValid));
  assert.ok(index.fixtures.some((entry) => !entry.expectedValid));

  for (const entry of index.fixtures) {
    let result;
    if (entry.inputMode === "raw_cli") {
      const execution = spawnSync(
        process.execPath,
        [verifierPath, "verify", path.join(rootDirectory, "fixtures", entry.file)],
        { encoding: "utf8" },
      );
      result = JSON.parse(execution.stdout);
    } else {
      const bundle = await readJson(path.join(rootDirectory, "fixtures", entry.file));
      result = verifyBundle(bundle);
    }
    const issueCodes = result.issues.map((issue) => issue.code);

    assert.equal(result.valid, entry.expectedValid, entry.id);
    assert.equal(result.authorizationGranted, false, entry.id);
    assert.equal(result.gitAuthorization, false, entry.id);
    assert.equal(result.releaseAuthorization, false, entry.id);
    assert.equal(result.artifactMutationAuthorization, false, entry.id);
    for (const expectedIssueCode of entry.expectedIssueCodes) {
      assert.ok(issueCodes.includes(expectedIssueCode), `${entry.id}: ${expectedIssueCode}`);
    }
  }
});

test("deterministic resource limits reject oversized, overdeep, and overcounted inputs", async () => {
  const { PUBLIC_VERIFIER_LIMITS, canonicalJson, parseJsonStrict, verifyBundle } = await import(
    verifierUrl
  );
  const fixture = await readJson(
    path.join(rootDirectory, "fixtures", "good", "accepted-replacement-chain.json"),
  );

  assert.deepEqual(PUBLIC_VERIFIER_LIMITS, {
    maxInputBytes: 1_048_576,
    maxNestingDepth: 64,
    maxJsonNodes: 50_000,
    maxReceipts: 1_024,
  });
  assert.throws(
    () => parseJsonStrict(`${"[".repeat(65)}0${"]".repeat(65)}`),
    (error) => error.code === "JSON_NESTING_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => canonicalJson(Array(65).fill(0).reduce((value) => [value], 0)),
    (error) => error.code === "JSON_NESTING_LIMIT_EXCEEDED",
  );
  assert.throws(
    () => parseJsonStrict(`[${Array(50_000).fill("0").join(",")}]`),
    (error) => error.code === "JSON_NODE_LIMIT_EXCEEDED",
  );

  const tooManyReceipts = structuredClone(fixture);
  tooManyReceipts.receipts = Array.from({ length: 1_025 }, (_, index) => ({
    ...fixture.receipts[1],
    receiptId: `receipt-${index}`,
  }));
  const countResult = verifyBundle(tooManyReceipts);
  assert.equal(countResult.valid, false);
  assert.ok(countResult.issues.some((issue) => issue.code === "RECEIPT_COUNT_LIMIT_EXCEEDED"));

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "owlcoda-public-verifier-"));
  try {
    const oversizedPath = path.join(temporaryDirectory, "oversized.json");
    await writeFile(oversizedPath, " ".repeat(1_048_577));
    const oversized = spawnSync(process.execPath, [verifierPath, "verify", oversizedPath], {
      encoding: "utf8",
    });
    const oversizedResult = JSON.parse(oversized.stdout);
    assert.equal(oversized.status, 1);
    assert.ok(
      oversizedResult.issues.some((issue) => issue.code === "INPUT_SIZE_LIMIT_EXCEEDED"),
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("accepted is valid only with one passed active leaf bound to source and context", async () => {
  const { verifyBundle } = await import(verifierUrl);
  const bundle = await readJson(
    path.join(rootDirectory, "fixtures", "good", "accepted-replacement-chain.json"),
  );
  const result = verifyBundle(bundle);

  assert.equal(result.valid, true);
  assert.equal(result.decision, "accepted");
  assert.equal(result.activeReceiptId, "receipt-002");
  assert.equal(result.activeReceiptStatus, "passed");
  assert.equal(result.sourceFingerprint, bundle.source.fingerprint);
  assert.equal(result.verificationContextFingerprint, bundle.verificationContext.fingerprint);
});

test("the CLI exits zero for valid input and nonzero for invalid input", () => {
  const valid = spawnSync(
    process.execPath,
    [verifierPath, "verify", path.join(rootDirectory, "fixtures", "good", "accepted-replacement-chain.json")],
    { encoding: "utf8" },
  );
  const invalid = spawnSync(
    process.execPath,
    [verifierPath, "verify", path.join(rootDirectory, "fixtures", "bad", "accepted-authority-leak.json")],
    { encoding: "utf8" },
  );

  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).status, "verified");
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).status, "invalid");
});

test("the published schema is strict at every public artifact boundary", async () => {
  const schema = await readJson(schemaPath);

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$defs.source.additionalProperties, false);
  assert.equal(schema.$defs.verificationContext.additionalProperties, false);
  assert.equal(schema.$defs.receipt.additionalProperties, false);
  assert.equal(schema.$defs.closeout.additionalProperties, false);
  assert.equal(schema.additionalProperties, false);
});

test("the offline bundle schema is strict and matches the architecture contract", async () => {
  const packageSchemaPath = path.join(
    rootDirectory,
    "schemas",
    "offline-attestation-bundle-v1.schema.json",
  );
  const architectureSchemaPath = path.resolve(
    rootDirectory,
    "../../docs/architecture/runkit-trust-product-v1/schemas/offline-attestation-bundle-v1.schema.json",
  );
  const schema = await readJson(packageSchemaPath);

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "reference",
    "receiptByteLength",
    "receiptBytesBase64",
  ]);
  assert.equal(schema.properties.schemaVersion.const, "OwlCodaOfflineAttestationBundleV1");
  assert.equal(schema.properties.reference.$ref, "attestation-ref-v1.schema.json");
  assert.deepEqual(
    await readFile(packageSchemaPath),
    await readFile(architectureSchemaPath),
  );
});

test("the reference implementation has no private or product-runtime dependency", async () => {
  const source = await readFile(verifierPath, "utf8");
  const forbiddenFragments = [
    "scripts/runkit-contract",
    "src/",
    "desktop/",
    "runtime-rail",
    "engine-locator",
  ];

  for (const fragment of forbiddenFragments) {
    assert.equal(source.includes(fragment), false, fragment);
  }

  const importSpecifiers = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
  assert.ok(importSpecifiers.length > 0);
  assert.deepEqual(
    importSpecifiers.filter((specifier) => !specifier.startsWith("node:")),
    [],
  );

  const productionEntries = (await readdir(path.join(rootDirectory, "src"), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(productionEntries, [
    "canonical.mjs",
    "formal.mjs",
    "index.mjs",
    "offline-bundle.mjs",
    "quick-receipt-contract.mjs",
    "quick.mjs",
    "reference-contract.mjs",
    "reference.mjs",
    "workspace-snapshot.mjs",
  ]);
});
