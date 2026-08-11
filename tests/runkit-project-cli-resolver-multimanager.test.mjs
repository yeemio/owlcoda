import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveProjectCli,
} from "../scripts/runkit-contract/project-cli-resolver.mjs";
import {
  coreIdentityFromSourceRoot,
} from "../scripts/runkit-contract/core-contract.mjs";

const VERSION = "0.18.0";
const PRIOR_VERSION = "0.17.2";
const PRIOR_CORE_MANIFEST_SHA256 =
  "sha256:67b883b8a763253b873fb6047c7e7e01c81123aa5250a0db5feaabd13cc4d860";
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
const RESOLVED =
  `https://registry.npmjs.org/owlrunkit/-/owlrunkit-${VERSION}.tgz`;
const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeInstalledPackage(packageRoot) {
  await writeJson(path.join(packageRoot, "package.json"), {
    name: "owlrunkit",
    version: VERSION,
    type: "module",
    bin: {
      owlrunkit: "scripts/runkit-contract/runkit-bootstrap.mjs",
    },
  });
  await cp(
    path.join(REPO_ROOT, "scripts", "runkit-contract"),
    path.join(packageRoot, "scripts", "runkit-contract"),
    { recursive: true },
  );
  await cp(
    path.join(REPO_ROOT, "packages", "attest"),
    path.join(packageRoot, "packages", "attest"),
    { recursive: true },
  );
  const cliPath = path.join(
    packageRoot,
    "scripts/runkit-contract/runkit-bootstrap.mjs",
  );
  return {
    cliPath: await realpath(cliPath),
    coreManifestSha256:
      coreIdentityFromSourceRoot(packageRoot).coreManifestSha256,
  };
}

async function writeCoreConfig(root, coreManifestSha256, coreVersion = VERSION) {
  await writeJson(path.join(root, ".owlcoda/runkit/config.json"), {
    schemaVersion: "OwlCodaRunKitConfigV2",
    core: {
      contractVersion: "0.2",
      coreVersion,
      coreManifestSha256,
      coreSourceRef: `artifact:${coreManifestSha256}`,
    },
    authorizationPolicy: "external_explicit_authority_required",
  });
}

async function createFixture(manager) {
  const root = await realpath(await mkdtemp(
    path.join(tmpdir(), `owlrunkit-${manager}-resolver-`),
  ));
  await writeJson(path.join(root, "package.json"), {
    name: `${manager}-fixture`,
    private: true,
    packageManager: `${manager}@10.0.0`,
    dependencies: {
      owlrunkit: VERSION,
    },
  });

  if (manager === "npm") {
    await writeJson(path.join(root, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "": {
          dependencies: {
            owlrunkit: VERSION,
          },
        },
        "node_modules/owlrunkit": {
          version: VERSION,
          resolved: RESOLVED,
          integrity: INTEGRITY,
        },
      },
    });
  } else if (manager === "pnpm") {
    await writeFile(path.join(root, "pnpm-lock.yaml"), [
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "  .:",
      "    dependencies:",
      "      owlrunkit:",
      `        specifier: ${VERSION}`,
      `        version: ${VERSION}`,
      "",
      "packages:",
      `  owlrunkit@${VERSION}:`,
      `    resolution: {integrity: ${INTEGRITY}}`,
      "",
    ].join("\n"));
  } else if (manager === "yarn") {
    await writeFile(path.join(root, "yarn.lock"), [
      "# yarn lockfile v1",
      "",
      `owlrunkit@${VERSION}:`,
      `  version \"${VERSION}\"`,
      `  resolved \"${RESOLVED}\"`,
      `  integrity ${INTEGRITY}`,
      "",
    ].join("\n"));
  } else {
    await writeFile(path.join(root, "bun.lock"), [
      "{",
      "  // Bun uses a text lockfile with JSONC syntax.",
      '  "lockfileVersion": 1,',
      '  "workspaces": {',
      '    "": {',
      `      "dependencies": { "owlrunkit": "${VERSION}", },`,
      "    },",
      "  },",
      '  "packages": {',
      `    "owlrunkit": ["owlrunkit@${VERSION}", "", {}, "${INTEGRITY}"],`,
      "  },",
      "}",
      "",
    ].join("\n"));
  }

  let packageRoot = path.join(root, "node_modules", "owlrunkit");
  if (manager !== "npm") {
    const storeRoot = manager === "pnpm"
      ? path.join(
          root,
          "node_modules",
          ".pnpm",
          `owlrunkit@${VERSION}`,
          "node_modules",
          "owlrunkit",
        )
      : manager === "yarn"
        ? path.join(
            root,
            ".yarn",
            "unplugged",
            `owlrunkit-npm-${VERSION}`,
            "node_modules",
            "owlrunkit",
          )
        : path.join(
            root,
            "node_modules",
            ".bun",
            `owlrunkit@${VERSION}`,
            "node_modules",
            "owlrunkit",
          );
    const installed = await writeInstalledPackage(storeRoot);
    await mkdir(path.dirname(packageRoot), { recursive: true });
    await symlink(path.relative(path.dirname(packageRoot), storeRoot), packageRoot);
    await writeCoreConfig(root, installed.coreManifestSha256);
    return {
      cliPath: installed.cliPath,
      packageRoot: await realpath(packageRoot),
      root,
    };
  }
  const installed = await writeInstalledPackage(packageRoot);
  await writeCoreConfig(root, installed.coreManifestSha256);
  return {
    cliPath: installed.cliPath,
    packageRoot: await realpath(packageRoot),
    root,
  };
}

test("project CLI resolver binds npm, pnpm, Yarn, and Bun exact installs", async (t) => {
  for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
    await t.test(manager, async () => {
      const fixture = await createFixture(manager);
      try {
        const bound = resolveProjectCli({
          workspaceRoot: fixture.root,
          expectedVersion: VERSION,
        });

        assert.equal(bound.status, "bound");
        assert.equal(bound.packageManager, manager);
        assert.equal(bound.lockfilePath, manager === "npm"
          ? "package-lock.json"
          : manager === "pnpm"
            ? "pnpm-lock.yaml"
            : manager === "yarn"
              ? "yarn.lock"
              : "bun.lock");
        assert.equal(bound.version, VERSION);
        assert.equal(bound.packageRoot, fixture.packageRoot);
        assert.equal(bound.cliPath, fixture.cliPath);
        assert.deepEqual(bound.argvPrefix, [process.execPath, fixture.cliPath]);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("project CLI resolver binds the exact real 0.17.2 closure and rejects adjacent drift", async () => {
  const root = await realpath(await mkdtemp(
    path.join(tmpdir(), "owlrunkit-prior-resolver-"),
  ));
  const packageRoot = path.join(root, "node_modules", "owlrunkit");
  try {
    await mkdir(packageRoot, { recursive: true });
    const archive = execFileSync("git", [
      "-C", REPO_ROOT,
      "archive", "--format=tar", "owlrunkit-v0.17.2", "--",
      "scripts/runkit-contract", "packages/attest",
    ], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", packageRoot], {
      input: archive,
      maxBuffer: 128 * 1024 * 1024,
    });
    await writeJson(path.join(packageRoot, "package.json"), {
      name: "owlrunkit",
      version: PRIOR_VERSION,
      type: "module",
      bin: {
        owlrunkit: "scripts/runkit-contract/runkit-bootstrap.mjs",
      },
    });
    await writeJson(path.join(root, "package.json"), {
      name: "prior-resolver-fixture",
      private: true,
      packageManager: "npm@10.0.0",
      dependencies: { owlrunkit: PRIOR_VERSION },
    });
    await writeJson(path.join(root, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { owlrunkit: PRIOR_VERSION } },
        "node_modules/owlrunkit": {
          version: PRIOR_VERSION,
          resolved: `https://registry.npmjs.org/owlrunkit/-/owlrunkit-${PRIOR_VERSION}.tgz`,
          integrity: INTEGRITY,
        },
      },
    });
    await writeCoreConfig(root, PRIOR_CORE_MANIFEST_SHA256, PRIOR_VERSION);

    const bound = resolveProjectCli({
      workspaceRoot: root,
      expectedVersion: PRIOR_VERSION,
    });
    assert.equal(bound.status, "bound");
    assert.equal(bound.version, PRIOR_VERSION);
    assert.equal(
      bound.installedCoreBinding.coreManifestSha256,
      PRIOR_CORE_MANIFEST_SHA256,
    );
    assert.equal(
      bound.installedCoreBinding.trustedIdentitySource,
      "bootstrap_embedded_prior_core_catalog",
    );
    assert.equal(bound.authorizationGranted, false);

    await writeFile(
      path.join(packageRoot, "scripts/runkit-contract/team-project.mjs"),
      "\n",
      { flag: "a" },
    );
    const rejected = resolveProjectCli({
      workspaceRoot: root,
      expectedVersion: PRIOR_VERSION,
    });
    assert.equal(rejected.status, "mismatch");
    assert.deepEqual(rejected.issueCodes, ["project_cli_untrusted_core_identity"]);
    assert.equal(rejected.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pnpm package symlink is accepted only when its store target stays inside the workspace", async () => {
  const fixture = await createFixture("pnpm");
  const outside = await realpath(await mkdtemp(
    path.join(tmpdir(), "owlrunkit-pnpm-outside-store-"),
  ));
  try {
    const outsidePackage = path.join(outside, "owlrunkit");
    await writeInstalledPackage(outsidePackage);
    await rm(path.join(fixture.root, "node_modules", "owlrunkit"));
    await symlink(
      outsidePackage,
      path.join(fixture.root, "node_modules", "owlrunkit"),
    );

    const rejected = resolveProjectCli({ workspaceRoot: fixture.root });

    assert.equal(rejected.status, "mismatch");
    assert.ok(rejected.issueCodes.includes("project_cli_symlink_rejected"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
