import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const policyPath = path.join(
  root,
  "packages",
  "runkit",
  "registry-release-policy-v1.json",
);
const planPath = path.join(
  root,
  "docs",
  "architecture",
  "OWLCODA_RUNKIT_TRUST_PRODUCTIZATION_WAVE_PLAN_V3_20260728.md",
);
const adoptionDocPath = path.join(
  root,
  "docs",
  "architecture",
  "runkit-attestation-v1",
  "REGISTRY_FIRST_ADOPTION_V1.md",
);
const verifierPath = path.join(
  root,
  "docs",
  "execution-prompts",
  "runkit-trust-product-wave6-20260729",
  "verify-wave6.mjs",
);
const candidateVersion = JSON.parse(
  readFileSync(path.join(root, "packages/runkit/package.json"), "utf8"),
).version;

const {
  OFFICIAL_NPM_REGISTRY,
  evaluateRegistryAdoption,
} = await import("../../scripts/runkit-contract/registry-adoption-gate.mjs");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function verifiedEvidence() {
  const bytes = Buffer.from("wave6-registry-verified-fixture", "utf8");
  return {
    schemaVersion: "OwlCodaRunKitRegistryReleaseEvidenceV1",
    status: "registry_verified",
    registry: OFFICIAL_NPM_REGISTRY,
    packageName: "owlrunkit",
    version: candidateVersion,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    tarballUrl: `https://registry.npmjs.org/owlrunkit/-/owlrunkit-${candidateVersion}.tgz`,
    authorizationGranted: false
  };
}

function exactRegistryInstall() {
  const evidence = verifiedEvidence();
  return {
    kind: "registry",
    requestedSpec: `owlrunkit@${candidateVersion}`,
    packageName: "owlrunkit",
    version: candidateVersion,
    shasum: evidence.shasum,
    integrity: evidence.integrity,
    resolved: evidence.tarballUrl
  };
}

test("registry-first adoption targets standalone RunKit and keeps OwlCoda independent", () => {
  const policy = JSON.parse(readFileSync(policyPath, "utf8"));
  const rootPackage = readJson("package.json");
  const runkitPackage = readJson("packages/runkit/package.json");
  const attestPackage = readJson("packages/attest/package.json");
  const plan = readFileSync(planPath, "utf8");
  const adoptionDoc = readFileSync(adoptionDocPath, "utf8");
  const verifier = readFileSync(verifierPath, "utf8");

  assert.equal(policy.schemaVersion, "OwlCodaRunKitRegistryReleasePolicyV1");
  assert.equal(policy.status, "release_candidate_unpublished");
  assert.equal(policy.packageName, "owlrunkit");
  assert.equal(policy.candidateVersion, candidateVersion);
  assert.equal(policy.registry, OFFICIAL_NPM_REGISTRY);
  assert.equal(policy.registryRequiredBeforeAdoption, true);
  assert.equal(policy.exactVersionRequired, true);
  assert.equal(policy.registryRelease, null);
  assert.equal(policy.registryEvidenceMustBeExternal, true);
  assert.equal(
    policy.registryEvidenceSchemaVersion,
    "OwlCodaRunKitRegistryReleaseEvidenceV1",
  );
  assert.deepEqual(policy.requiredRegistryBindings, [
    "packageName",
    "version",
    "shasum",
    "integrity",
    "tarballUrl"
  ]);
  assert.deepEqual(policy.forbiddenAdoptionSources, [
    "directory",
    "file",
    "git",
    "local_tarball",
    "symlink",
    "workspace"
  ]);
  assert.equal(policy.standaloneAttestPublicationRequired, false);
  assert.equal(policy.authorizationGranted, false);

  assert.equal(rootPackage.version, "0.18.0");
  assert.equal(runkitPackage.name, "owlrunkit");
  assert.equal(runkitPackage.version, candidateVersion);
  assert.equal(attestPackage.private, true);
  assert.match(verifier, /--retain-artifact/);
  assert.match(verifier, /--source-fingerprint/);
  assert.match(verifier, /--no-retain-artifact/);
  assert.match(verifier, /source-fingerprint\.mjs/);
  assert.match(verifier, /sourcePacketPath/);
  assert.match(verifier, /COPYFILE_EXCL/);
  assert.match(verifier, /tarfile\.open/);
  assert.match(verifier, /member\.isfile\(\)/);
  assert.match(verifier, /member\.isdir\(\)/);
  assert.ok(
    verifier.indexOf("tarfile.open") < verifier.indexOf('"-xzf"'),
    "archive member metadata must be validated before extraction",
  );
  assert.match(verifier, /tar[\s\S]*-xzf/);
  assert.match(verifier, /BEGIN \(\?:RSA \|EC \|OPENSSH \)\?PRIVATE KEY/);

  assert.match(plan, /npm registry publication and registry verification must precede every\s+real-project adoption/i);
  assert.match(plan, /exact registry version/i);
  assert.match(plan, /publication requires separate controller decision and explicit Git and npm\s+authority/i);
  assert.match(adoptionDoc, new RegExp(`owlrunkit@${candidateVersion.replaceAll(".", "\\.")}`));
  assert.doesNotMatch(
    adoptionDoc,
    /(?:until .* is published|current published release remains)/iu,
  );
  assert.match(
    adoptionDoc,
    /published rollback\s+baseline is `owlrunkit@0\.16\.1`/iu,
  );
  assert.match(adoptionDoc, /npm registry/i);
  assert.match(adoptionDoc, /must not use a local tarball/i);
  assert.match(adoptionDoc, /root OwlCoda CLI remains at `0\.15\.32`/i);
});

test("packed root package installs the canonical Skill from its own bytes", { timeout: 180_000 }, () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "owlcoda-wave6-skill-pack-"));
  try {
    const packed = JSON.parse(execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", scratch],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    ));
    const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    const tarball = path.join(scratch, entry.filename);
    const installRoot = path.join(scratch, "install");
    execFileSync("npm", [
      "install",
      "--offline",
      "--force",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installRoot,
      tarball,
    ], { stdio: "ignore" });

    const installedRoot = path.join(installRoot, "node_modules", "owlcoda");
    const skillRoot = path.join(scratch, "skills", "owlcoda-runkit");
    const archiveRoot = path.join(scratch, "archives");
    const installed = spawnSync(process.execPath, [
      path.join(installedRoot, "scripts/runkit-contract/install-codex-skill.mjs"),
      "install",
      "--repository",
      installedRoot,
      "--target",
      skillRoot,
      "--archive",
      archiveRoot,
    ], { encoding: "utf8" });
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
    assert.equal(JSON.parse(installed.stdout).status, "installed");

    const skill = readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
    assert.match(skill, /Choose the smallest assurance lane/);
    assert.match(skill, /Quick Verification for one low-risk command/);
    assert.match(skill, /Formal Delivery for multi-writer work/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("root tarball scanner rejects unsafe members before extraction", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "owlcoda-wave6-tar-safety-"));
  try {
    const controlRoot = path.join(scratch, "control");
    const unsafeRoot = path.join(scratch, "unsafe");
    mkdirSync(path.join(controlRoot, "package"), { recursive: true });
    mkdirSync(path.join(unsafeRoot, "package"), { recursive: true });
    writeFileSync(path.join(controlRoot, "package", "safe.txt"), "safe\n");
    writeFileSync(path.join(unsafeRoot, "package", "safe.txt"), "safe\n");
    symlinkSync("/tmp", path.join(unsafeRoot, "package", "escape"));

    const controlTarball = path.join(scratch, "control.tgz");
    const unsafeTarball = path.join(scratch, "unsafe.tgz");
    const tarOptions = {
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
      },
    };
    execFileSync(
      "tar",
      ["-czf", controlTarball, "-C", controlRoot, "package"],
      tarOptions,
    );
    execFileSync(
      "tar",
      ["-czf", unsafeTarball, "-C", unsafeRoot, "package"],
      tarOptions,
    );

    const control = spawnSync(process.execPath, [
      verifierPath,
      "--inspect-tarball",
      controlTarball,
    ], { encoding: "utf8" });
    assert.equal(control.status, 0, `${control.stdout}\n${control.stderr}`);

    const unsafe = spawnSync(process.execPath, [
      verifierPath,
      "--inspect-tarball",
      unsafeTarball,
    ], { encoding: "utf8" });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /unsafe member/i);
    assert.doesNotMatch(unsafe.stdout, /extract root tarball/i);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("unpublished release candidate is ineligible for foreign-project adoption", () => {
  const result = evaluateRegistryAdoption({
    policy: readJson("packages/runkit/registry-release-policy-v1.json"),
    install: exactRegistryInstall()
  });

  assert.deepEqual(result, {
    schemaVersion: "OwlCodaRunKitRegistryAdoptionDecisionV1",
    decision: "INELIGIBLE",
    issueCodes: ["registry_release_not_verified"],
    packageName: "owlrunkit",
    version: candidateVersion,
    authorizationGranted: false
  });
});

test("package-embedded self-assertion cannot replace controller-owned registry evidence", () => {
  const policy = {
    ...readJson("packages/runkit/registry-release-policy-v1.json"),
    status: "registry_verified",
    registryRelease: verifiedEvidence()
  };
  const result = evaluateRegistryAdoption({
    policy,
    install: exactRegistryInstall()
  });
  assert.equal(result.decision, "INELIGIBLE");
  assert.deepEqual(result.issueCodes, ["registry_release_not_verified"]);
});

test("exact official-registry version, shasum, integrity, and URL are all required", () => {
  const result = evaluateRegistryAdoption({
    policy: readJson("packages/runkit/registry-release-policy-v1.json"),
    releaseEvidence: verifiedEvidence(),
    install: exactRegistryInstall()
  });
  assert.deepEqual(result, {
    schemaVersion: "OwlCodaRunKitRegistryAdoptionDecisionV1",
    decision: "ELIGIBLE",
    issueCodes: [],
    packageName: "owlrunkit",
    version: candidateVersion,
    authorizationGranted: false
  });

  for (const [field, value, issueCode] of [
    ["requestedSpec", "owlrunkit@latest", "registry_exact_version_required"],
    ["packageName", "@owlcoda/attest", "registry_package_name_mismatch"],
    ["version", "0.12.0", "registry_version_mismatch"],
    ["shasum", "ffffffffffffffffffffffffffffffffffffffff", "registry_shasum_mismatch"],
    ["integrity", "sha512-bWlzbWF0Y2g=", "registry_integrity_mismatch"],
    ["resolved", `https://example.invalid/owlrunkit-${candidateVersion}.tgz`, "registry_tarball_url_mismatch"]
  ]) {
    const install = exactRegistryInstall();
    install[field] = value;
    const mismatch = evaluateRegistryAdoption({
      policy: readJson("packages/runkit/registry-release-policy-v1.json"),
      releaseEvidence: verifiedEvidence(),
      install
    });
    assert.equal(mismatch.decision, "INELIGIBLE", field);
    assert.deepEqual(mismatch.issueCodes, [issueCode], field);
  }
});

test("matching malformed release and install claims cannot create registry eligibility", () => {
  for (const mutate of [
    (evidence) => { evidence.shasum = "x"; },
    (evidence) => { evidence.integrity = "y"; },
    (evidence) => { evidence.tarballUrl = "https://evil.invalid/payload.tgz"; },
    (evidence) => {
      evidence.tarballUrl = `https://registry.npmjs.org/owlrunkit/-/owlrunkit-${candidateVersion}.tgz?download=1`;
    },
  ]) {
    const evidence = verifiedEvidence();
    mutate(evidence);
    const install = {
      ...exactRegistryInstall(),
      shasum: evidence.shasum,
      integrity: evidence.integrity,
      resolved: evidence.tarballUrl,
    };
    const result = evaluateRegistryAdoption({
      policy: readJson("packages/runkit/registry-release-policy-v1.json"),
      releaseEvidence: evidence,
      install,
    });
    assert.equal(result.decision, "INELIGIBLE");
    assert.deepEqual(result.issueCodes, ["registry_release_evidence_invalid"]);
  }

  const evidence = verifiedEvidence();
  evidence.registry = "https://evil.invalid";
  evidence.tarballUrl = `https://evil.invalid/owlrunkit/-/owlrunkit-${candidateVersion}.tgz`;
  const install = {
    ...exactRegistryInstall(),
    resolved: evidence.tarballUrl,
  };
  const result = evaluateRegistryAdoption({
    policy: {
      ...readJson("packages/runkit/registry-release-policy-v1.json"),
      registry: evidence.registry,
    },
    releaseEvidence: evidence,
    install,
  });
  assert.equal(result.decision, "INELIGIBLE");
  assert.deepEqual(result.issueCodes, ["registry_release_evidence_invalid"]);
});

test("local, workspace, Git, symlink, and tarball sources fail closed", () => {
  for (const kind of [
    "directory",
    "file",
    "git",
    "local_tarball",
    "symlink",
    "workspace"
  ]) {
    const install = {
      ...exactRegistryInstall(),
      kind
    };
    const result = evaluateRegistryAdoption({
      policy: readJson("packages/runkit/registry-release-policy-v1.json"),
      releaseEvidence: verifiedEvidence(),
      install
    });
    assert.equal(result.decision, "INELIGIBLE", kind);
    assert.deepEqual(result.issueCodes, ["registry_source_required"], kind);
  }
});

test("missing or malformed registry binding fields fail closed", () => {
  for (const field of [
    "requestedSpec",
    "packageName",
    "version",
    "shasum",
    "integrity",
    "resolved"
  ]) {
    const install = exactRegistryInstall();
    delete install[field];
    const result = evaluateRegistryAdoption({
      policy: readJson("packages/runkit/registry-release-policy-v1.json"),
      releaseEvidence: verifiedEvidence(),
      install
    });
    assert.equal(result.decision, "INELIGIBLE", field);
    assert.deepEqual(result.issueCodes, ["registry_install_binding_missing"], field);
  }
});
