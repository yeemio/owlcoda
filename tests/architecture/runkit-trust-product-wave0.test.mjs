import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const decisionPath = path.join(
  repoRoot,
  "docs/architecture/OWLCODA_RUNKIT_TRUST_PRODUCTIZATION_DECISION_DRAFT_20260728.md",
);
const contractRoot = path.join(
  repoRoot,
  "docs/architecture/runkit-trust-product-v1",
);
const reviewedDraftSha256 =
  "802ac47909db2258ebc0b82eab182ab472a453b4f867bf77b73cd8cc880231f2";

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

test("Wave 0 accepts the reviewed decision without granting repository authority", () => {
  const decision = readFileSync(decisionPath, "utf8");
  assert.match(
    decision,
    /decision_accepted \/ wave0_implementation_authorized \/ git_not_authorized \/ release_not_authorized/,
  );

  const receiptRelativePath =
    "docs/architecture/runkit-trust-product-v1/OWLCODA_RK_TRUST_PRODUCT_001_DECISION_RECEIPT.json";
  assert.equal(
    existsSync(path.join(repoRoot, receiptRelativePath)),
    true,
    "controller-owned decision receipt must exist",
  );
  const receipt = readJson(receiptRelativePath);
  assert.equal(receipt.schemaVersion, "OwlCodaArchitectureDecisionReceiptV1");
  assert.equal(receipt.decisionId, "OWLCODA-RK-TRUST-PRODUCT-001");
  assert.equal(receipt.decision, "accepted");
  assert.equal(receipt.reviewedDraft.sha256, reviewedDraftSha256);
  assert.equal(receipt.decisionDocument.path, path.relative(repoRoot, decisionPath));
  assert.equal(receipt.decisionDocument.sha256, sha256(decision));
  assert.deepEqual(receipt.implementationAuthorization, {
    status: "authorized",
    scope: "wave0_docs_and_contracts_only",
  });
  assert.deepEqual(receipt.repositoryAuthorization, {
    stage: false,
    commit: false,
    branch: false,
    merge: false,
    push: false,
    tag: false,
    publish: false,
    deploy: false,
    release: false,
  });
  assert.equal(receipt.authorizationGranted, false);
});

test("Wave 0 freezes seven strict Draft 2020-12 contracts and keeps Quick separate from Formal", () => {
  const schemaFiles = [
    "quick-verification-receipt-v1.schema.json",
    "workspace-snapshot-v1.schema.json",
    "attestation-result-v1.schema.json",
    "attestation-ref-v1.schema.json",
    "receipt-signature-v1.schema.json",
    "receipt-checkpoint-v1.schema.json",
    "repair-plan-v1.schema.json",
  ];

  for (const file of schemaFiles) {
    const relativePath = `docs/architecture/runkit-trust-product-v1/schemas/${file}`;
    assert.equal(existsSync(path.join(repoRoot, relativePath)), true, `${file} must exist`);
    const schema = readJson(relativePath);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^https:\/\/owlcoda\.dev\/schemas\/runkit\/trust\//);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required) && schema.required.length > 0);
    assert.equal(typeof schema.properties?.schemaVersion?.const, "string");
  }

  const quick = readJson(
    "docs/architecture/runkit-trust-product-v1/schemas/quick-verification-receipt-v1.schema.json",
  );
  assert.equal(quick.properties.assurance.const, "captured_verification");
  assert.equal(quick.properties.authorizationGranted.const, false);
  assert.equal("accepted" in quick.properties, false);
  assert.equal("readyForCommit" in quick.properties, false);

  const attestation = readJson(
    "docs/architecture/runkit-trust-product-v1/schemas/attestation-result-v1.schema.json",
  );
  assert.deepEqual(attestation.properties.decision.enum, [
    "GO",
    "NO_GO",
    "INDETERMINATE",
  ]);
  assert.equal(
    attestation.properties.subjectRef.$ref,
    "attestation-ref-v1.schema.json",
  );

  const repair = readJson(
    "docs/architecture/runkit-trust-product-v1/schemas/repair-plan-v1.schema.json",
  );
  assert.deepEqual(repair.properties.requiredTrust.properties.riskMode.enum, [
    "lightweight",
    "standard",
    "full",
  ]);
  assert.deepEqual(
    repair.properties.requiredTrust.properties.riskCategories.items.enum,
    ["migration", "backtest", "release", "funds", "production"],
  );

  const signature = readJson(
    "docs/architecture/runkit-trust-product-v1/schemas/receipt-signature-v1.schema.json",
  );
  assert.equal(signature.properties.publicKeyEncoding.const, "base64url_no_padding");
  assert.equal(signature.properties.signatureEncoding.const, "base64url_no_padding");
  assert.equal(signature.properties.authorizationGranted.const, false);
});

test("Wave 0 schemas pass an independent Draft 2020-12 meta-schema and Quick-as-Formal rejection", () => {
  const python = String.raw`
from pathlib import Path
import json
import sys
from jsonschema import Draft202012Validator
from referencing import Registry, Resource

root = Path(sys.argv[1])
schemas = [json.loads(path.read_text()) for path in sorted(root.glob("*.schema.json"))]
assert len(schemas) == 7
for schema in schemas:
    Draft202012Validator.check_schema(schema)

registry = Registry().with_resources(
    (schema["$id"], Resource.from_contents(schema)) for schema in schemas
)
quick = next(
    schema
    for schema in schemas
    if schema["title"] == "OwlCoda Quick Verification Receipt V1"
)
snapshot = {
    "schemaVersion": "OwlCodaWorkspaceSnapshotV1",
    "repositoryIdentity": "local:test",
    "headCommit": "0" * 40,
    "trackedTreeIdentity": "sha256:" + "1" * 64,
    "submodules": [],
    "dirtyOverlay": [],
    "dependencyLockfiles": [],
    "excludedRoots": [".owlcoda/runkit"],
    "ignoredPathsBound": False,
    "policyVersion": "workspace-snapshot-v1",
    "sourceFingerprint": "sha256:" + "2" * 64,
}
receipt = {
    "schemaVersion": "OwlCodaQuickVerificationReceiptV1",
    "receiptId": "quick-smoke-001",
    "assurance": "captured_verification",
    "authorizationGranted": False,
    "coreIdentity": {
        "contractVersion": "0.2",
        "coreVersion": "0.13.0",
        "coreManifestSha256": "sha256:" + "3" * 64,
    },
    "workspaceBefore": snapshot,
    "exactCommand": {
        "executable": "node",
        "argv": ["--version"],
        "cwd": ".",
    },
    "verificationContext": {
        "platform": "darwin",
        "architecture": "arm64",
        "runtime": "node",
    },
    "startedAt": "2026-07-28T00:00:00Z",
    "finishedAt": "2026-07-28T00:00:01Z",
    "exitResult": {"exitCode": 0, "signal": None},
    "outputArtifacts": {
        "stdout": {
            "path": "stdout.log",
            "sha256": "sha256:" + "4" * 64,
            "sizeBytes": 1,
        },
        "stderr": {
            "path": "stderr.log",
            "sha256": "sha256:" + "5" * 64,
            "sizeBytes": 0,
        },
    },
    "workspaceAfter": snapshot,
    "mutationDecision": "source_unchanged",
    "issueCodes": ["quick_ignored_artifact_unbound"],
}
validator = Draft202012Validator(quick, registry=registry)
validator.validate(receipt)
errors = list(validator.iter_errors(dict(receipt, accepted=True)))
assert errors
assert any(error.validator == "additionalProperties" for error in errors)
`;
  const result = spawnSync(
    "python3",
    ["-c", python, path.join(contractRoot, "schemas")],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(
    result.status,
    0,
    `independent Draft 2020-12 gate failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

test("Wave 0 canonicalization vectors and issue codes are deterministic and append-only shaped", () => {
  const vectors = readJson(
    "docs/architecture/runkit-trust-product-v1/canonicalization-vectors-v1.json",
  );
  assert.equal(vectors.schemaVersion, "OwlCodaRunKitCanonicalizationVectorsV1");
  assert.equal(vectors.algorithm, "sha256(UTF8(JCS(value)))");
  assert.ok(vectors.vectors.length >= 4);
  for (const vector of vectors.vectors) {
    const canonical = canonicalize(vector.value);
    assert.equal(canonical, vector.canonicalJson, `${vector.id} canonical JSON`);
    assert.equal(sha256(canonical), vector.sha256, `${vector.id} SHA-256`);
  }

  const registry = readJson(
    "docs/architecture/runkit-trust-product-v1/issue-code-registry-v1.json",
  );
  assert.equal(registry.schemaVersion, "OwlCodaRunKitIssueCodeRegistryV1");
  assert.equal(registry.mutationPolicy, "append_only_with_versioned_replacement");
  const codes = new Set(registry.issues.map((issue) => issue.code));
  for (const code of [
    "quick_ignored_artifact_unbound",
    "quick_receipt_not_formal",
    "source_mutated_during_verification",
    "signature_absent",
    "signature_invalid",
    "anchor_absent",
    "attestation_target_not_found",
    "attestation_target_ambiguous",
    "repair_replay_failed",
    "external_receipt_signing_forbidden",
  ]) {
    assert.equal(codes.has(code), true, `missing issue code ${code}`);
  }
  assert.equal(codes.size, registry.issues.length, "issue codes must be unique");
  const issueByCode = new Map(registry.issues.map((issue) => [issue.code, issue]));
  assert.equal(
    issueByCode.get("signature_absent").defaultEffect,
    "policy_dependent",
  );
  assert.equal(
    issueByCode.get("anchor_absent").defaultEffect,
    "policy_dependent",
  );
});

test("Wave 0 freezes public/private ownership and maps every accepted Public Verifier capability", () => {
  const graph = readJson(
    "docs/architecture/runkit-trust-product-v1/package-graph-v1.json",
  );
  assert.equal(graph.schemaVersion, "OwlCodaRunKitPackageGraphV1");
  assert.equal(graph.baseline.commit, "52e12964a99a7c6b833ec345c2bd91c4eaf704a5");
  assert.equal(
    graph.reconciliationInputs.publicCliSecurityCandidate.commit,
    "6f5cbf5ca883610efd1f03933cf3834d493d783c",
  );
  assert.equal(
    graph.reconciliationInputs.privateReplacementCandidate.status,
    "not_a_wave0_source_baseline",
  );
  assert.equal(
    graph.currentPublicReleaseTruth.provenance,
    "controller_delegated_live_truth",
  );
  assert.equal(
    graph.reconciliationInputs.privateReplacementCandidate.provenance,
    "controller_delegated_project_truth",
  );
  const packageById = new Map(graph.packages.map((entry) => [entry.id, entry]));
  assert.equal(packageById.get("packages/attest").visibility, "public_readonly");
  assert.equal(
    packageById.get("scripts/runkit-contract").visibility,
    "private_mutation_runtime",
  );
  for (const edge of graph.importEdges) {
    assert.notDeepEqual(
      [edge.from, edge.to],
      ["packages/attest", "scripts/runkit-contract"],
      "public attest package must not import the private mutation runtime",
    );
    assert.notDeepEqual(
      [edge.from, edge.to],
      ["packages/attest", "desktop/osui"],
      "public attest package must not import private Desktop",
    );
    assert.notDeepEqual(
      [edge.from, edge.to],
      ["owlcoda-cli", "scripts/runkit-contract"],
      "public CLI must not source-import the private mutation runtime",
    );
  }
  const privateCommandPort = graph.commandEdges.find(
    (edge) =>
      edge.from === "owlcoda-cli" && edge.to === "scripts/runkit-contract",
  );
  assert.equal(privateCommandPort.scope, "host_owned_private_engine_command_port");
  assert.equal(privateCommandPort.sourceImportAllowed, false);

  const migrationMap = readText(
    "docs/architecture/runkit-trust-product-v1/PUBLIC_VERIFIER_MIGRATION_MAP.md",
  );
  for (const capability of [
    "strict schema",
    "duplicate object key",
    "canonical JSON",
    "source fingerprint",
    "verification context",
    "single active leaf",
    "replacement lineage",
    "accepted requires passed receipt",
    "authorization remains false",
  ]) {
    assert.match(migrationMap, new RegExp(capability, "i"));
  }
  assert.match(migrationMap, /9\/9 Node/);
  assert.match(migrationMap, /12\/12 Draft 2020-12/);
  assert.match(migrationMap, /d2971f36ebef1894440f3bbaac178f4f2c72f1572488291b584bfc3afdb78066/);
});

test("Wave 0 governance assets preserve boundaries and measurable adoption", () => {
  const requiredDocuments = [
    "README.md",
    "PUBLIC_PRIVATE_PACKAGE_GRAPH.md",
    "THREAT_MODEL.md",
    "NAMING_CLEARANCE_CHECKLIST.md",
    "ADOPTION_BASELINE.md",
  ];
  for (const file of requiredDocuments) {
    assert.equal(existsSync(path.join(contractRoot, file)), true, `${file} must exist`);
  }

  const threatModel = readFileSync(path.join(contractRoot, "THREAT_MODEL.md"), "utf8");
  for (const threat of [
    "Quick-as-Formal",
    "sign arbitrary",
    "ignored artifact",
    "issued-at",
    "silent network",
    "source mutation",
  ]) {
    assert.match(threatModel, new RegExp(threat, "i"));
  }

  const naming = readFileSync(
    path.join(contractRoot, "NAMING_CLEARANCE_CHECKLIST.md"),
    "utf8",
  );
  assert.match(naming, /pending/i);
  assert.match(naming, /OwlCoda-prefixed/i);
  assert.match(naming, /bare `RunKit`.*not cleared/i);

  const adoption = readFileSync(path.join(contractRoot, "ADOPTION_BASELINE.md"), "utf8");
  assert.match(adoption, /Weekly Valid Receipts/);
  assert.match(adoption, /Weekly Consumed Receipts/);
  assert.match(adoption, /rolling four-week/i);
  assert.match(adoption, /local-only/i);
  assert.match(adoption, /telemetry.*disabled/i);
  assert.match(adoption, /time_to_first_receipt/);
});
