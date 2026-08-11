import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { currentCoreIdentity } from "../../scripts/runkit-contract/core-contract.mjs";
import { SUPPORTED_QUICK_CORE_IDENTITIES } from "../../packages/attest/src/quick.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const packageRoot = path.join(root, "packages", "runkit");
const manifestPath = path.join(packageRoot, "package.json");
const policyPath = path.join(packageRoot, "registry-release-policy-v1.json");
const buildScript = path.join(packageRoot, "build-package.mjs");
const candidateVersion = "0.18.0";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("RunKit has an independent package identity and does not bump OwlCoda", () => {
  const rootManifest = readJson(path.join(root, "package.json"));
  const manifest = readJson(manifestPath);
  const policy = readJson(policyPath);
  const sbom = readJson(path.join(packageRoot, "sbom.spdx.json"));
  const configTemplate = readJson(path.join(
    root,
    "integrations",
    "codex",
    "skills",
    "owlcoda-runkit",
    "assets",
    "templates",
    "config.json",
  ));
  const skill = readFileSync(path.join(
    root,
    "integrations",
    "codex",
    "skills",
    "owlcoda-runkit",
    "SKILL.md",
  ), "utf8");
  const readme = readFileSync(path.join(packageRoot, "README.md"), "utf8");
  const changelog = readFileSync(path.join(packageRoot, "CHANGELOG.md"), "utf8");

  assert.equal(rootManifest.name, "owlcoda");
  assert.equal(rootManifest.version, "0.18.0");

  assert.equal(manifest.name, "owlrunkit");
  assert.equal(manifest.version, candidateVersion);
  assert.equal(manifest.private, false);
  assert.equal(manifest.license, "GPL-3.0-or-later");
  assert.match(
    manifest.description,
    /^Project Driver for cross-Agent project continuity and progression;/u,
  );
  assert.match(
    readme,
    /^# OwlRunKit\n\nOwlRunKit is OwlCoda's Project Driver for cross-Agent project continuity and\s+progression\./u,
  );
  assert.doesNotMatch(readme, /--at 2026-08-09T\d{2}:\d{2}:\d{2}Z\b/u);
  assert.match(
    readme,
    /cp node_modules\/owlrunkit\/scripts\/runkit-contract\/templates\/team-project-definition\.json \.\/project-definition\.json/u,
  );
  assert.match(readme, /--definition \.\/project-definition\.json/u);
  assert.match(readme, /--work-item work-item-1/u);
  assert.match(readme, /--supersedes assign-1/u);
  assert.match(readme, /--completed-units 1/u);
  assert.match(readme, /project decision[\s\S]*?--open[\s\S]*?project decision[\s\S]*?--resolve/u);
  assert.match(readme, /project verification[\s\S]*?--defer[\s\S]*?project verification[\s\S]*?--close/u);
  assert.match(readme, /--check typecheck --check full-suite --check package-smoke/u);
  assert.match(readme, /--disposition verified/u);
  assert.match(readme, /--gate integration-ready/u);
  assert.match(readme, /project takeover --workspace \. --agent agent-successor/u);
  assert.match(readme, /project successor --workspace \. --transition-id project-next-001/u);
  assert.equal(manifest.bin.owlrunkit, "scripts/runkit-contract/runkit-bootstrap.mjs");
  assert.equal(manifest.bin["owlrunkit-attest"], "packages/attest/cli/owlcoda-attest.mjs");
  assert.equal(manifest.exports["./attest"], "./packages/attest/src/index.mjs");
  assert.equal(manifest.scripts, undefined);

  assert.equal(policy.packageName, "owlrunkit");
  assert.equal(policy.candidateVersion, candidateVersion);
  assert.equal(policy.status, "release_candidate_unpublished");
  assert.equal(policy.registryRelease, null);
  assert.deepEqual(policy.currentPublishedRelease, {
    packageName: "owlrunkit",
    version: "0.17.2",
    shasum: "73f46ec4db52d74697436900f36eafe72cb67132",
    integrity: "sha512-djTV1O/Clm7VCpx7boyXpJCfLfyAjuLUf+zoNLy7xyCG3LnmDiVUWtQcZFEyqWW8ts1ptd9DYyyZFdK5w1dAbA==",
    tarballUrl: "https://registry.npmjs.org/owlrunkit/-/owlrunkit-0.17.2.tgz",
  });
  assert.equal(policy.exactVersionRequired, true);
  assert.equal(policy.foreignProjectWriteAuthorized, false);

  assert.equal(sbom.name, `owlrunkit-${manifest.version}`);
  assert.equal(sbom.packages[0].versionInfo, manifest.version);
  assert.equal(currentCoreIdentity().coreVersion, manifest.version);
  assert.equal(configTemplate.core.coreVersion, manifest.version);
  assert.ok(
    SUPPORTED_QUICK_CORE_IDENTITIES.some((identity) =>
      identity.contractVersion === currentCoreIdentity().contractVersion
      && identity.coreVersion === currentCoreIdentity().coreVersion
      && identity.coreManifestSha256 === currentCoreIdentity().coreManifestSha256),
    "public verifier must support the exact Core shipped by the standalone package",
  );
  assert.match(
    skill,
    new RegExp(`Bundled release: standalone \`owlrunkit@${manifest.version.replaceAll(".", "\\.")}\`[\\s\\S]*Core \`${manifest.version.replaceAll(".", "\\.")}\``),
  );
  assert.doesNotMatch(
    skill,
    /(?:It is not published|current published release remains)/iu,
  );
  assert.match(skill, /Batch verification around a small explainable closure/iu);
  assert.match(skill, /two or three related changes/iu);
  assert.match(skill, /run its focused suite once/iu);
  assert.match(skill, /Independent acceptance[\s\S]*does not repeat[\s\S]*whole covered suite/iu);
  assert.match(skill, /Do not defer an immediate containment/iu);
  assert.doesNotMatch(skill, /The bundled Core is `0\.13\.0`/);
  assert.equal(
    sbom.packages[0].externalRefs[0].referenceLocator,
    `pkg:npm/owlrunkit@${manifest.version}`,
  );
  assert.match(readme, new RegExp(`owlrunkit@${manifest.version.replaceAll(".", "\\.")}`));
  for (const phrase of [
    "registered roots",
    "profiles detect --workspace . --apply",
    "No RunKit",
    "Quick Verification",
    "Formal Delivery",
    "formal start",
    "formal check",
    "formal finish",
    "Coordinate a multi-Agent project",
    "project takeover",
    "Project Driver",
    "project assign",
    "project checkpoint",
    "project verification",
    "deferred-verification ledger",
    "does not make project coordination Formal",
    "SourceCandidateV2",
    "core-successor plan",
    "core-successor apply",
    "deployment prepare",
    "deployment execute",
    "remote deployment adapter",
    "caller-provided remote",
    "not an out-of-the-box VM deployment",
  ]) {
    assert.match(readme, new RegExp(phrase));
  }
  assert.match(readme, /Verification\s+Envelope/u);
  assert.match(changelog, new RegExp(`^## ${manifest.version.replaceAll(".", "\\.")}$`, "m"));
  const productDefinition = readFileSync(path.join(
    root,
    "docs/architecture/OWLCODA_RUNKIT_017_AGENT_NATIVE_PRODUCT_DEFINITION.md",
  ), "utf8");
  assert.match(productDefinition, /persistent project truth coordinates multiple Agents/iu);
  assert.match(productDefinition, /does not accept self-reported completion percentages/iu);
  assert.match(productDefinition, /blank-session takeover/iu);
  assert.match(productDefinition, /Verification Envelope/iu);
  const projectDriverDefinition = readFileSync(path.join(
    root,
    "docs/architecture/OWLCODA_RUNKIT_018_PROJECT_DRIVER_PRODUCT_DEFINITION.md",
  ), "utf8");
  assert.match(projectDriverDefinition, /Project Driver/iu);
  assert.match(projectDriverDefinition, /dominant gap/iu);
  assert.match(projectDriverDefinition, /typed.*assign.*checkpoint/isu);
  assert.match(projectDriverDefinition, /does not make project coordination Formal/iu);
  assert.match(projectDriverDefinition, /Deferred verification without test thrash/iu);
  assert.match(projectDriverDefinition, /does not contain an executable shell command/iu);
  assert.match(projectDriverDefinition, /no_longer_required/iu);
  assert.match(projectDriverDefinition, /0\.17\.2/iu);
});

test("0.18 public surfaces disclose the bounded completed-project successor and authority boundary", () => {
  const surfaces = [
    ["package README", readFileSync(path.join(packageRoot, "README.md"), "utf8")],
    ["package changelog", readFileSync(path.join(packageRoot, "CHANGELOG.md"), "utf8")],
    [
      "Project Driver product definition",
      readFileSync(path.join(
        root,
        "docs/architecture/OWLCODA_RUNKIT_018_PROJECT_DRIVER_PRODUCT_DEFINITION.md",
      ), "utf8"),
    ],
  ];

  for (const [name, surface] of surfaces) {
    const normalized = surface.replace(/\s+/gu, " ");
    assert.match(
      normalized,
      /bounded surface for new projects and controlled dogfood/iu,
      `${name} must bound the 0.18 audience`,
    );
    assert.match(
      normalized,
      /does not claim (?:to be )?a general long-running, multi-phase, or enterprise control plane/iu,
      `${name} must reject the broad control-plane claim`,
    );
    assert.match(
      normalized,
      /derived-completed active (?:V1 )?project/iu,
      `${name} must require a completed active project`,
    );
    assert.match(
      normalized,
      /archive(?:s| its)? (?:the )?exact (?:raw )?(?:prior )?bytes|archive its exact raw bytes/iu,
      `${name} must preserve exact archived project bytes`,
    );
    assert.match(
      normalized,
      /sealed against ordinary writes/iu,
      `${name} must disclose the completed archive seal`,
    );
    assert.match(
      normalized,
      /exact retry[\s\S]*(?:next|later) successor/iu,
      `${name} must disclose the archive validation boundaries`,
    );
    assert.match(
      normalized,
      /status and takeover[\s\S]*do not|project status[\s\S]*project takeover[\s\S]*do not/iu,
      `${name} must not imply status-time historical archive scanning`,
    );
    assert.match(
      normalized,
      /handoff and takeover do not automatically promote an authoritative writer/iu,
      `${name} must preserve explicit writer authority`,
    );
    assert.match(
      normalized,
      /incomplete projects (?:stay|remain) on (?:their )?current truth/iu,
      `${name} must preserve incomplete project truth`,
    );
    assert.match(
      normalized,
      /Core successor[\s\S]*Project Successor[\s\S]*project adoption[\s\S]*separate authority boundaries/iu,
      `${name} must separate Core, project lifecycle, and adoption authority`,
    );
  }

  const skill = readFileSync(path.join(
    root,
    "integrations/codex/skills/owlcoda-runkit/SKILL.md",
  ), "utf8").replace(/\s+/gu, " ");
  assert.match(skill, /sealed against ordinary writes/iu);
  assert.match(skill, /Exact retry[\s\S]*later successor/iu);
  assert.match(skill, /Do not infer a historical archive scan from `status` or `takeover`/iu);
});

test("registry-first adoption names the 0.17.2 to 0.18.0 upgrade and rollback proof", () => {
  const adoption = readFileSync(path.join(
    root,
    "docs/architecture/runkit-attestation-v1/REGISTRY_FIRST_ADOPTION_V1.md",
  ), "utf8");
  const normalized = adoption.replace(/\s+/gu, " ");

  assert.match(normalized, /0\.17\.2 to 0\.18\.0/iu);
  assert.match(normalized, /0\.18\.0 back to 0\.17\.2/iu);
});

test("standalone package contains the RunKit runtime and excludes OwlCoda product internals", {
  timeout: 180_000,
}, () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "owlrunkit-package-"));
  try {
    const stage = path.join(scratch, "stage");
    const built = spawnSync(process.execPath, [buildScript, "--output", stage], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);

    const result = JSON.parse(built.stdout);
    assert.equal(result.status, "standalone_package_built");
    assert.equal(result.packageName, "owlrunkit");
    assert.equal(result.version, candidateVersion);

    const packed = JSON.parse(execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", scratch],
      {
        cwd: stage,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_audit: "false",
          npm_config_fund: "false",
        },
      },
    ));
    const entry = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
    const names = entry.files.map((file) => file.path).sort();

    for (const required of [
      "LICENSE",
      "NOTICE.md",
      "README.md",
      "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_1.md",
      "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_2.md",
      "docs/architecture/OWLCODA_RUNKIT_017_AGENT_NATIVE_PRODUCT_DEFINITION.md",
      "docs/architecture/OWLCODA_RUNKIT_018_PROJECT_DRIVER_PRODUCT_DEFINITION.md",
      "integrations/codex/skills/owlcoda-runkit/SKILL.md",
      "package.json",
      "packages/attest/cli/owlcoda-attest.mjs",
      "packages/attest/src/index.mjs",
      "registry-release-policy-v1.json",
      "scripts/runkit-contract/core-contract.mjs",
      "scripts/runkit-contract/runkit-bootstrap.mjs",
      "scripts/runkit-contract/runkit-cli.mjs",
      "scripts/runkit-contract/sync-release-identity.mjs",
      "scripts/runkit-contract/schemas/team-project-definition-v1.schema.json",
      "scripts/runkit-contract/schemas/team-project-event-v1.schema.json",
      "scripts/runkit-contract/schemas/team-project-status-v1.schema.json",
      "scripts/runkit-contract/schemas/verification-envelope-v1.schema.json",
      "scripts/runkit-contract/team-project.mjs",
      "scripts/runkit-contract/templates/team-project-definition.json",
      "scripts/runkit-contract/templates/verification-envelope.json",
      "scripts/runkit-contract/verification-envelope-check.mjs",
      "scripts/runkit-contract/verification-envelope.mjs",
    ]) {
      assert.ok(names.includes(required), `missing standalone package file: ${required}`);
    }

    for (const forbiddenPrefix of [
      ".owlcoda/",
      "admin/",
      "desktop/",
      "dist/",
      "docs/execution-prompts/",
      "site/",
      "src/",
      "tests/",
    ]) {
      assert.equal(
        names.some((name) => name.startsWith(forbiddenPrefix)),
        false,
        `standalone package leaked ${forbiddenPrefix}`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("packed standalone CLI installs and initializes a fresh project", {
  timeout: 180_000,
}, () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "owlrunkit-install-"));
  try {
    const stage = path.join(scratch, "stage");
    execFileSync(process.execPath, [buildScript, "--output", stage], {
      cwd: root,
      stdio: "ignore",
    });
    const packed = JSON.parse(execFileSync(
      "npm",
      ["pack", "--json", "--pack-destination", scratch],
      {
        cwd: stage,
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
    const workspace = path.join(scratch, "project");
    execFileSync("npm", [
      "install",
      "--offline",
      "--force",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      workspace,
      tarball,
    ], { stdio: "ignore" });

    const integrity = `sha512-${createHash("sha512")
      .update(readFileSync(tarball))
      .digest("base64")}`;
    writeFileSync(path.join(workspace, "package.json"), `${JSON.stringify({
      name: "owlrunkit-standalone-fixture",
      private: true,
      dependencies: {
        owlrunkit: candidateVersion,
      },
    }, null, 2)}\n`);
    writeFileSync(path.join(workspace, "package-lock.json"), `${JSON.stringify({
      name: "owlrunkit-standalone-fixture",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "owlrunkit-standalone-fixture",
          dependencies: {
            owlrunkit: candidateVersion,
          },
        },
        "node_modules/owlrunkit": {
          version: candidateVersion,
          resolved:
            `https://registry.npmjs.org/owlrunkit/-/owlrunkit-${candidateVersion}.tgz`,
          integrity,
        },
      },
    }, null, 2)}\n`);

    const installedRoot = path.join(workspace, "node_modules", "owlrunkit");
    const cli = path.join(installedRoot, "scripts", "runkit-contract", "runkit-bootstrap.mjs");

    const initialized = JSON.parse(execFileSync(
      process.execPath,
      [cli, "init", "--workspace", workspace, "--json"],
      { encoding: "utf8" },
    ));
    assert.equal(initialized.status, "initialized");

    const inspected = JSON.parse(execFileSync(
      process.execPath,
      [cli, "inspect", "--workspace", workspace, "--json"],
      { encoding: "utf8" },
    ));
    assert.equal(inspected.status, "inspected");
    assert.equal(inspected.config.core.coreVersion, candidateVersion);
    assert.equal(inspected.configCore.status, "valid");

    const definitionPath = path.join(workspace, "project-definition.json");
    writeFileSync(definitionPath, `${JSON.stringify({
      schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
      projectId: "standalone-driver",
      objective: "Validate the typed Project Driver flow",
      milestones: [{ id: "m1", title: "Driver" }],
      workstreams: [{ id: "runtime", title: "Runtime", milestoneId: "m1" }],
      workItems: [{
        id: "x",
        title: "Run typed flow",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: [],
        ownedPaths: ["src/x/**"],
      }],
      integrationGates: [],
    }, null, 2)}\n`);

    const projectInitialized = JSON.parse(execFileSync(
      process.execPath,
      [cli, "project", "init", "--workspace", workspace, "--definition", definitionPath],
      { encoding: "utf8" },
    ));
    assert.equal(projectInitialized.status, "team_project_initialized");

    const assigned = JSON.parse(execFileSync(
      process.execPath,
      [
        cli, "project", "assign", "--workspace", workspace,
        "--assignment-id", "assign-x", "--at", "2026-08-08T00:01:00.000Z",
        "--work-item", "x", "--agent", "agent-a", "--json",
      ],
      { encoding: "utf8" },
    ));
    assert.equal(assigned.status, "team_project_assignment");
    assert.equal(assigned.authorizationGranted, false);

    const checkpointed = JSON.parse(execFileSync(
      process.execPath,
      [
        cli, "project", "checkpoint", "--workspace", workspace,
        "--checkpoint-id", "checkpoint-x", "--at", "2026-08-08T00:02:00.000Z",
        "--assignment-id", "assign-x", "--work-item", "x", "--state", "active",
        "--summary", "Typed flow is active.", "--next", "Continue x.", "--json",
      ],
      { encoding: "utf8" },
    ));
    assert.equal(checkpointed.status, "team_project_checkpoint");
    assert.equal(checkpointed.authorizationGranted, false);

    const projectStatus = JSON.parse(execFileSync(
      process.execPath,
      [cli, "project", "status", "--workspace", workspace, "--json"],
      { encoding: "utf8" },
    ));
    assert.equal(projectStatus.status, "team_project_status");
    assert.equal(projectStatus.workItems.find((row) => row.workItemId === "x").status, "active");

    const takeover = JSON.parse(execFileSync(
      process.execPath,
      [cli, "project", "takeover", "--workspace", workspace, "--agent", "agent-a", "--json"],
      { encoding: "utf8" },
    ));
    assert.equal(takeover.status, "team_project_takeover");
    assert.equal(takeover.currentResponsibility.workItemId, "x");
    assert.equal(takeover.authorizationGranted, false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
