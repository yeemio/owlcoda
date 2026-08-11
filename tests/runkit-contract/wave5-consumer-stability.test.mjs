import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { FORMAL_ISSUE_CODES } from "../../packages/attest/src/formal.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(root, "packages", "attest");
const surfacePath = path.join(packageRoot, "consumer-surface-v1.json");
const sbomPath = path.join(packageRoot, "sbom.spdx.json");
const licensePath = path.join(packageRoot, "LICENSE");
const nMinusOnePath = path.join(
  packageRoot,
  "compatibility",
  "owlcoda-attest-wave3-n-minus-1-0.1.0.tgz",
);
const wave5VerifierPath = path.join(
  root,
  "docs",
  "execution-prompts",
  "runkit-trust-product-wave5-20260729",
  "verify-wave5.mjs",
);

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function pack(destination) {
  const output = JSON.parse(execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    { cwd: packageRoot, encoding: "utf8" },
  ));
  const entry = Array.isArray(output) ? output[0] : Object.values(output)[0];
  return path.join(destination, entry.filename);
}

test("Consumer Surface V1 freezes the complete unsigned contract and compatibility matrix", () => {
  assert.equal(existsSync(surfacePath), true);
  const surface = JSON.parse(readFileSync(surfacePath, "utf8"));
  assert.equal(surface.schemaVersion, "OwlCodaRunKitConsumerSurfaceManifestV1");
  assert.equal(surface.consumerSurface, "unsigned_v1");
  assert.equal(surface.status, "frozen_candidate");
  assert.deepEqual(surface.commands.map(item => item.invocation), [
    "owlcoda runkit verify -- <executable> [args...]",
    "owlcoda attest <receipt> --workspace <path> [--json]",
    "owlcoda resolve <reference> --store <path> [--store <path>...] [--workspace <path>] [--json]",
    "owlcoda runkit repair --run-id <run-id> [--json]",
    "owlcoda runkit store export --receipt <path> --output <path> [--json]",
    "owlcoda runkit store import --bundle <path> --store <path> [--json]",
    "owlcoda runkit metrics --local [--json]",
    "owlcoda-attest attest <receipt-or-bundle.json> [--workspace <path>] [--json]",
    "owlcoda-attest resolve <attestation-ref.json> --store <path> [--store <path>...] [--workspace <path>] [--json]",
  ]);
  assert.deepEqual(surface.schemas, [
    "OwlCodaAttestationRefV1",
    "OwlCodaAttestationResultV1",
    "OwlCodaOfflineAttestationBundleV1",
    "OwlCodaQuickVerificationReceiptV1",
    "OwlCodaRunKitPublicVerificationBundleV1",
    "OwlCodaWorkspaceSnapshotV1",
  ]);
  assert.deepEqual(surface.attestationReference.requiredKeys, [
    "schemaVersion",
    "receiptId",
    "receiptSha256",
    "coreIdentity",
  ]);
  assert.equal(surface.attestationReference.additionalProperties, false);
  assert.deepEqual(surface.outcomes, {
    attestationDecisions: ["GO", "NO_GO", "INDETERMINATE"],
    resolutionStatuses: {
      resolved_valid: 0,
      resolved_invalid: 1,
      resolved_indeterminate: 3,
      ambiguous: 1,
      not_found: 3,
    },
  });
  assert.equal(surface.assurance.quickCanSatisfyFormalAcceptance, false);
  assert.equal(surface.assurance.signatureRequired, false);
  assert.equal(surface.assurance.signatureAbsentIssueCode, "signature_absent");
  assert.deepEqual(surface.assurance.quickWithoutWorkspace, {
    otherwiseValidDecision: "INDETERMINATE",
    deterministicallyInvalidDecision: "NO_GO",
  });
  assert.equal(surface.privacy.defaultNetworkRequests, 0);
  assert.equal(surface.privacy.telemetry, false);
  assert.equal(surface.metrics.localOnly, true);
  assert.equal(surface.metrics.performanceTarget, false);
  assert.equal(surface.authorizationGranted, false);
  assert.deepEqual(surface.compatibility.scenarios.map(item => item.id), [
    "clean_first_use",
    "dirty_workspace",
    "offline_export_import_resolve",
    "n_minus_one_upgrade",
    "rollback",
    "historical_unsigned_receipt",
    "source_drift_repair",
    "failed_repair_lineage",
  ]);
  for (const scenario of surface.compatibility.scenarios) {
    assert.equal(existsSync(path.join(root, scenario.evidencePath)), true, scenario.id);
  }
  assert.deepEqual(
    Object.keys(surface.issueCodes).filter(code => code === code.toUpperCase()).sort(),
    [...FORMAL_ISSUE_CODES].sort(),
  );
  assert.deepEqual(
    Object.keys(surface.issueCodes).filter(code => code !== code.toUpperCase()).sort(),
    [
      "anchor_absent",
      "attestation_material_missing",
      "attestation_target_ambiguous",
      "attestation_target_not_found",
      "core_identity_mismatch",
      "current_workspace_not_checked",
      "quick_ignored_artifact_unbound",
      "quick_receipt_store_invalid",
      "receipt_duplicate_key",
      "receipt_material_hash_mismatch",
      "receipt_schema_invalid",
      "receipt_source_mismatch",
      "repair_plan_incomplete",
      "repair_replay_failed",
      "signature_absent",
      "source_mutated_during_verification",
      "verification_command_failed",
      "verification_context_mismatch",
    ],
  );
  assert.equal(
    surface.unsupportedClaims.includes("unsigned_receipt_proves_signer_identity"),
    true,
  );
  assert.equal(
    surface.unsupportedClaims.includes("issued_at_proves_trusted_wall_clock_time"),
    true,
  );
  for (const id of ["quick_verify", "repair"]) {
    const command = surface.commands.find(item => item.id === id);
    assert.equal(command.networkRequests, undefined, id);
    assert.equal(command.runKitControlPlaneNetworkRequests, 0, id);
    assert.equal(command.childCommandNetworkPolicy, "caller_owned_not_restricted_or_measured", id);
  }
  assert.equal(
    surface.unsupportedClaims.includes("captured_or_replayed_child_command_has_zero_network"),
    true,
  );
});

test("packed verifier includes license, SBOM, and frozen surface without private or secret material", () => {
  assert.equal(existsSync(licensePath), true);
  assert.equal(existsSync(sbomPath), true);
  const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  const packageDocument = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(sbom.spdxVersion, "SPDX-2.3");
  assert.equal(sbom.dataLicense, "CC0-1.0");
  assert.equal(sbom.packages.length, 1);
  assert.equal(sbom.packages[0].name, packageDocument.name);
  assert.equal(sbom.packages[0].versionInfo, packageDocument.version);
  assert.equal(sbom.packages[0].licenseDeclared, packageDocument.license);

  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "owlcoda-wave5-pack-")));
  const tarball = pack(scratch);
  const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  for (const required of [
    "package/LICENSE",
    "package/consumer-surface-v1.json",
    "package/distribution-manifest-v1.json",
    "package/sbom.spdx.json",
  ]) {
    assert.match(entries, new RegExp(`^${required.replaceAll(".", "\\.")}$`, "m"));
  }
  assert.doesNotMatch(
    entries,
    /desktop\/|execution-prompts\/|\.owlcoda\/|private-engine|credential|secret|token/i,
  );
  const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}/;
  for (const entry of entries.trim().split("\n").filter((item) =>
    /\.(?:json|md|mjs)$/.test(item) || item.endsWith("/LICENSE"))) {
    const bytes = execFileSync("tar", ["-xOzf", tarball, entry]);
    assert.doesNotMatch(bytes.toString("utf8"), secretPattern, entry);
  }
  assert.equal(readFileSync(licensePath, "utf8"), readFileSync(path.join(root, "LICENSE"), "utf8"));
});

test("distribution manifest binds the frozen surface, SBOM, license, and historical N-1 bytes", () => {
  const distribution = JSON.parse(readFileSync(
    path.join(packageRoot, "distribution-manifest-v1.json"),
    "utf8",
  ));
  assert.equal(distribution.consumerSurfaceManifest.sha256, `sha256:${sha256File(surfacePath)}`);
  assert.equal(distribution.sbom.sha256, `sha256:${sha256File(sbomPath)}`);
  assert.equal(distribution.license.sha256, `sha256:${sha256File(licensePath)}`);
  assert.equal(
    distribution.nMinusOne.tarballSha256,
    `sha256:${sha256File(nMinusOnePath)}`,
  );
  assert.equal(distribution.networkRequests, 0);
  assert.equal(distribution.signatureRequired, false);
  assert.equal(distribution.authorizationGranted, false);
});

test("Wave 5 verifier consumes the fresh-checkout result contract exactly", () => {
  const verifier = readFileSync(wave5VerifierPath, "utf8");
  assert.match(verifier, /smoke\.networkRequests !== 0/);
  assert.doesNotMatch(verifier, /smoke\.externalNetworkRequests/);
});
