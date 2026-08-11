import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";

const cliPath = path.resolve("scripts/runkit-contract/runkit-cli.mjs");
const bootstrapPath = path.resolve(
  "scripts/runkit-contract/runkit-bootstrap.mjs",
);

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function assuranceRequest(overrides = {}) {
  return {
    needsDurableEvidence: true,
    needsFormalAcceptance: false,
    exactCommandCount: 1,
    writerCount: 0,
    mayMutateProject: false,
    externalSideEffects: false,
    longRunning: false,
    interruptionRecovery: false,
    dirtyParallelWorkspace: false,
    riskCategories: [],
    ...overrides,
  };
}

test("daily-use commands expose action-specific help without project state", async () => {
  const cases = [
    {
      argv: ["assurance", "route", "--help"],
      usage: "owlrunkit assurance route",
      option: "--request",
    },
    {
      argv: ["fleet", "discover", "--help"],
      usage: "owlrunkit fleet discover",
      option: "--fleet-root",
    },
    {
      argv: ["fleet", "replace-registry", "--help"],
      usage: "owlrunkit fleet replace-registry",
      option: "--dry-run",
    },
    {
      argv: ["profiles", "detect", "--help"],
      usage: "owlrunkit profiles detect",
      option: "--apply",
    },
    {
      argv: ["formal", "start", "--help"],
      usage: "owlrunkit formal start",
      option: "--owned-path",
    },
    {
      argv: ["candidate", "freeze", "--help"],
      usage: "owlrunkit candidate freeze",
      option: "--candidate-id",
    },
    {
      argv: ["deployment", "execute", "--help"],
      usage: "owlrunkit deployment execute",
      option: "--owner-authority",
    },
    {
      argv: ["core-successor", "plan", "--help"],
      usage: "owlrunkit core-successor plan",
      option: "--plan-id",
    },
    {
      argv: ["status", "--help"],
      usage: "owlrunkit status",
      option: "--workspace",
    },
  ];

  for (const expected of cases) {
    const result = await runCli(expected.argv);
    assert.equal(result.status, "help", expected.argv.join(" "));
    assert.equal(result.exitCode, 0, expected.argv.join(" "));
    assert.equal(result.authorizationGranted, false);
    assert.match(result.humanOutput, new RegExp(expected.usage, "u"));
    assert.match(result.humanOutput, new RegExp(expected.option, "u"));
  }
});

test("the real non-TTY CLI prints profiles action help as human-readable usage", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "profiles",
    "detect",
    "--help",
  ], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:\s*\n\s*owlrunkit profiles detect/u);
  assert.match(result.stdout, /--apply/u);
  assert.doesNotMatch(result.stdout, /^\{"status":"help"/u);
});

test("the published bootstrap exposes nested help before project-local binding", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-help-bootstrap-"));
  try {
    const result = spawnSync(process.execPath, [
      bootstrapPath,
      "formal",
      "start",
      "--help",
    ], {
      cwd: root,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:\s*\n\s*owlrunkit formal start/u);
    assert.match(result.stdout, /--owned-path/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assurance route selects the lane from a structured request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-assurance-cli-"));
  try {
    const requestPath = path.join(root, "request.json");
    await writeJson(requestPath, assuranceRequest());
    const routed = await runCli([
      "assurance",
      "route",
      "--workspace",
      root,
      "--request",
      requestPath,
    ]);
    assert.equal(routed.status, "routed");
    assert.equal(routed.lane, "quick");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fleet discover scans declared roots and freezes the discovered workspace list", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-fleet-cli-"));
  try {
    const first = path.join(root, "one");
    const second = path.join(root, "nested", "two");
    for (const project of [first, second]) {
      await writeJson(path.join(project, ".owlcoda/runkit/config.json"), {
        schemaVersion: "OwlCodaRunKitConfigV2",
      });
    }
    const discovered = await runCli([
      "fleet",
      "discover",
      "--fleet-root",
      root,
    ]);
    assert.equal(discovered.status, "discovered");
    assert.equal(discovered.complete, true);
    assert.deepEqual(discovered.workspaceRoots, [
      await import("node:fs/promises").then(({ realpath }) => realpath(first)),
      await import("node:fs/promises").then(({ realpath }) => realpath(second)),
    ].sort());
    assert.match(discovered.frozenManifestSha256, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fleet register-root makes later no-argument discovery automatic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-fleet-registry-cli-"));
  const previousHome = process.env.OWLCODA_HOME;
  try {
    const owlcodaHome = path.join(root, "owlcoda-home");
    const fleetRoot = path.join(root, "projects");
    const project = path.join(fleetRoot, "nested", "project");
    process.env.OWLCODA_HOME = owlcodaHome;
    await writeJson(path.join(project, ".owlcoda/runkit/config.json"), {
      schemaVersion: "OwlCodaRunKitConfigV2",
    });

    const registered = await runCli([
      "fleet",
      "register-root",
      "--fleet-root",
      fleetRoot,
    ]);
    assert.equal(registered.status, "fleet_root_registered");

    const discovered = await runCli(["fleet", "discover"]);
    assert.equal(discovered.status, "discovered");
    assert.equal(discovered.source, "fleet_registry");
    assert.deepEqual(discovered.workspaceRoots, [await realpath(project)]);
    assert.match(discovered.registrySha256, /^sha256:[a-f0-9]{64}$/u);
  } finally {
    if (previousHome === undefined) delete process.env.OWLCODA_HOME;
    else process.env.OWLCODA_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("fleet registry CLI exposes exact inspect and a non-mutating replacement dry-run", async () => {
  const root = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-fleet-registry-replacement-cli-",
  )));
  try {
    const registryPath = path.join(root, "registry.json");
    const fleetRoot = path.join(root, "projects");
    const project = path.join(fleetRoot, "project");
    await writeJson(path.join(project, ".owlcoda/runkit/config.json"), {});
    await runCli([
      "fleet",
      "register-root",
      "--fleet-root",
      fleetRoot,
      "--registry",
      registryPath,
    ]);
    const before = await readFile(registryPath);
    const inspected = await runCli([
      "fleet",
      "inspect-registry",
      "--registry",
      registryPath,
    ]);
    const requestPath = path.join(root, "request.json");
    await writeJson(requestPath, {
      schemaVersion: "OwlCodaRunKitFleetRegistryReplacementRequestV1",
      expectedRegistrySha256: inspected.registrySha256,
      coverageRoots: [fleetRoot],
      membership: {
        schemaVersion: "OwlCodaRunKitFleetMembershipV1",
        entries: [{ path: project, classification: "active" }],
        authorizationGranted: false,
      },
      removedCoverageEvidence: [],
      authorizationGranted: false,
    });
    const dryRun = await runCli([
      "fleet",
      "replace-registry",
      "--registry",
      registryPath,
      "--request",
      requestPath,
      "--receipt",
      path.join(root, "receipt.json"),
      "--dry-run",
    ]);
    assert.equal(dryRun.status, "fleet_registry_replacement_dry_run");
    assert.match(dryRun.beforeFileSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.match(dryRun.afterFileSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(await readFile(registryPath), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profiles detect can directly apply a high-confidence common project profile", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "owlrunkit-profiles-cli-")),
  );
  try {
    await writeJson(path.join(root, "package.json"), {
      name: "profile-cli-fixture",
      private: true,
      scripts: {
        build: "node -e \"process.exit(0)\"",
        test: "node --test",
      },
    });
    await writeJson(path.join(root, "package-lock.json"), {
      name: "profile-cli-fixture",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "profile-cli-fixture",
        },
      },
    });
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });

    const applied = await runCli([
      "profiles",
      "detect",
      "--workspace",
      root,
      "--apply",
    ]);
    assert.equal(applied.status, "profiles_applied");
    const profiles = JSON.parse(await readFile(
      path.join(root, ".owlcoda/runkit/profiles.json"),
      "utf8",
    ));
    assert.equal(profiles.schemaVersion, "OwlCodaRunKitProfilesV1");
    assert.equal(profiles.profiles.filter((profile) => profile.primary).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status presents one concise projection from inspect truth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-status-cli-"));
  try {
    const initialized = await runCli(["init", "--workspace", root, "--json"]);
    assert.equal(initialized.status, "initialized");
    const status = await runCli(["status", "--workspace", root, "--json"]);
    assert.equal(status.schemaVersion, "OwlCodaRunKitHumanStatusV1");
    assert.equal(status.overall, "idle");
    assert.equal(status.remainingGateCount, 0);
    assert.equal(status.releaseAuthorization, false);

    const humanStatus = await runCli(["status", "--workspace", root]);
    assert.match(humanStatus.humanOutput, /Source\/data readiness:\s+not_evidenced/u);
    assert.match(humanStatus.humanOutput, /Release package:\s+not_evidenced/u);
    assert.match(humanStatus.humanOutput, /Remote\/VM write:\s+not_evidenced/u);
    assert.match(humanStatus.humanOutput, /Remaining gates:\s+0/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
