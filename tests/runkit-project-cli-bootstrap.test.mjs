import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runBootstrapV1,
  selectProjectCliInvocationV1,
} from "../scripts/runkit-contract/runkit-bootstrap.mjs";
import {
  coreIdentityFromSourceRoot,
} from "../scripts/runkit-contract/core-contract.mjs";

const VERSION = "0.18.0";
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

async function exactLocalPackage() {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-bootstrap-"));
  const packageRoot = path.join(root, "node_modules", "owlrunkit");
  const coreContractPath = path.join(
    packageRoot,
    "scripts",
    "runkit-contract",
    "core-contract.mjs",
  );
  const cliPath = path.join(
    packageRoot,
    "scripts",
    "runkit-contract",
    "runkit-bootstrap.mjs",
  );
  await writeJson(path.join(root, "package.json"), {
    name: "fixture",
    private: true,
    dependencies: {
      owlrunkit: VERSION,
    },
  });
  await writeJson(path.join(root, "package-lock.json"), {
    lockfileVersion: 3,
    packages: {
      "node_modules/owlrunkit": {
        version: VERSION,
        resolved: RESOLVED,
        integrity: INTEGRITY,
      },
    },
  });
  await writeJson(path.join(packageRoot, "package.json"), {
    name: "owlrunkit",
    version: VERSION,
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
  const core = coreIdentityFromSourceRoot(packageRoot);
  await writeJson(path.join(root, ".owlcoda", "runkit", "config.json"), {
    schemaVersion: "OwlCodaRunKitConfigV2",
    core: {
      contractVersion: "0.2",
      coreVersion: VERSION,
      coreManifestSha256: core.coreManifestSha256,
      coreSourceRef: core.coreSourceRef,
    },
    authorizationPolicy: "external_explicit_authority_required",
  });
  return { root, cliPath, coreContractPath, packageRoot };
}

test("the bootstrap delegates project commands to the exact local package", async () => {
  const fixture = await exactLocalPackage();
  try {
    const selected = selectProjectCliInvocationV1({
      argv: ["inspect", "--workspace", fixture.root, "--json"],
      cwd: fixture.root,
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });

    assert.equal(selected.mode, "project_local");
    assert.equal(selected.binding.version, VERSION);
    assert.deepEqual(selected.commandArgv, [
      process.execPath,
      selected.binding.cliPath,
      "inspect",
      "--workspace",
      fixture.root,
      "--json",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("help intended for a child command after -- still uses the exact local package", async () => {
  const fixture = await exactLocalPackage();
  try {
    const argv = [
      "quick-verify",
      "--workspace",
      fixture.root,
      "--",
      "node",
      "--help",
    ];
    const selected = selectProjectCliInvocationV1({
      argv,
      cwd: fixture.root,
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });

    assert.equal(selected.mode, "project_local");
    assert.deepEqual(selected.commandArgv, [
      process.execPath,
      selected.binding.cliPath,
      ...argv,
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the local package does not recursively delegate to itself", async () => {
  const fixture = await exactLocalPackage();
  try {
    const selected = selectProjectCliInvocationV1({
      argv: ["inspect", "--workspace", fixture.root, "--json"],
      cwd: fixture.root,
      selfCliPath: fixture.cliPath,
    });

    assert.equal(selected.mode, "current_package");
    assert.equal(selected.workspaceRoot, fixture.root);
    assert.equal(selected.commandArgv, null);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("ordinary project commands fail closed when the exact local CLI binding is unavailable", async () => {
  const fixture = await exactLocalPackage();
  try {
    await writeJson(path.join(fixture.root, "package-lock.json"), {
      lockfileVersion: 3,
      packages: {
        "node_modules/owlrunkit": {
          version: "0.15.1",
          resolved: "https://registry.npmjs.org/owlrunkit/-/owlrunkit-0.15.1.tgz",
          integrity: "sha512-mismatch",
        },
      },
    });
    const selected = selectProjectCliInvocationV1({
      argv: ["formal", "start", "--workspace", fixture.root],
      cwd: fixture.root,
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });

    assert.equal(selected.mode, "project_local_blocked");
    assert.deepEqual(selected.binding.issueCodes, [
      "project_cli_lock_binding_mismatch",
    ]);
    let spawnCount = 0;
    assert.throws(
      () => runBootstrapV1({
        argv: ["formal", "start", "--workspace", fixture.root],
        cwd: fixture.root,
        selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
        spawn() {
          spawnCount += 1;
          return { status: 0 };
        },
      }),
      /project_local_cli_unavailable:project_cli_lock_binding_mismatch[\s\S]*owlrunkit init --workspace/u,
    );
    assert.equal(spawnCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the bootstrap refuses tampered project-local CLI bytes before spawning them", async () => {
  const fixture = await exactLocalPackage();
  try {
    await writeFile(fixture.cliPath, "#!/usr/bin/env node\nprocess.exit(0)\n");
    const selected = selectProjectCliInvocationV1({
      argv: ["inspect", "--workspace", fixture.root, "--json"],
      cwd: fixture.root,
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });

    assert.equal(selected.mode, "project_local_blocked");
    assert.deepEqual(selected.binding.issueCodes, [
      "project_cli_untrusted_core_identity",
    ]);
    let spawnCount = 0;
    assert.throws(
      () => runBootstrapV1({
        argv: ["inspect", "--workspace", fixture.root, "--json"],
        cwd: fixture.root,
        selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
        spawn() {
          spawnCount += 1;
          return { status: 0 };
        },
      }),
      /project_local_cli_unavailable:project_cli_untrusted_core_identity/u,
    );
    assert.equal(spawnCount, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the project-local binding covers the runtime contract closure, not only its entrypoint", async () => {
  const fixture = await exactLocalPackage();
  try {
    await writeFile(
      fixture.coreContractPath,
      `${await readFile(fixture.coreContractPath, "utf8")}\n// tampered\n`,
    );
    const selected = selectProjectCliInvocationV1({
      argv: ["inspect", "--workspace", fixture.root, "--json"],
      cwd: fixture.root,
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });

    assert.equal(selected.mode, "project_local_blocked");
    assert.deepEqual(selected.binding.issueCodes, [
      "project_cli_untrusted_core_identity",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the bootstrap refuses a package manifest that redirects the CLI entrypoint", async () => {
  const fixture = await exactLocalPackage();
  try {
    const manifestPath = path.join(fixture.packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.bin.owlrunkit = "scripts/runkit-contract/runkit-cli.mjs";
    await writeJson(manifestPath, manifest);

    const selected = selectProjectCliInvocationV1({
      argv: ["inspect", "--workspace", fixture.root, "--json"],
      cwd: fixture.root,
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });

    assert.equal(selected.mode, "project_local_blocked");
    assert.deepEqual(selected.binding.issueCodes, [
      "project_cli_bin_invalid",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the bootstrap refuses a jointly forged local Core and project Config", async () => {
  const fixture = await exactLocalPackage();
  try {
    await writeFile(
      fixture.cliPath,
      `${await readFile(fixture.cliPath, "utf8")}\n// forged local Core\n`,
    );
    const forged = coreIdentityFromSourceRoot(fixture.packageRoot);
    await writeJson(
      path.join(fixture.root, ".owlcoda", "runkit", "config.json"),
      {
        schemaVersion: "OwlCodaRunKitConfigV2",
        core: forged,
        authorizationPolicy: "external_explicit_authority_required",
      },
    );

    const selected = selectProjectCliInvocationV1({
      argv: ["inspect", "--workspace", fixture.root, "--json"],
      cwd: fixture.root,
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });

    assert.equal(selected.mode, "project_local_blocked");
    assert.deepEqual(selected.binding.issueCodes, [
      "project_cli_untrusted_core_identity",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("the bootstrap requires official registry provenance and canonical SHA-512 SRI", async (t) => {
  await t.test("non-official tarball", async () => {
    const fixture = await exactLocalPackage();
    try {
      const lock = JSON.parse(await readFile(
        path.join(fixture.root, "package-lock.json"),
        "utf8",
      ));
      lock.packages["node_modules/owlrunkit"].resolved =
        `https://evil.example/owlrunkit-${VERSION}.tgz`;
      await writeJson(path.join(fixture.root, "package-lock.json"), lock);

      const selected = selectProjectCliInvocationV1({
        argv: ["inspect", "--workspace", fixture.root, "--json"],
        cwd: fixture.root,
        selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
      });
      assert.equal(selected.mode, "project_local_blocked");
      assert.deepEqual(selected.binding.issueCodes, [
        "project_cli_registry_provenance_invalid",
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  await t.test("non-canonical integrity", async () => {
    const fixture = await exactLocalPackage();
    try {
      const lock = JSON.parse(await readFile(
        path.join(fixture.root, "package-lock.json"),
        "utf8",
      ));
      lock.packages["node_modules/owlrunkit"].integrity = "sha512-fixture";
      await writeJson(path.join(fixture.root, "package-lock.json"), lock);

      const selected = selectProjectCliInvocationV1({
        argv: ["inspect", "--workspace", fixture.root, "--json"],
        cwd: fixture.root,
        selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
      });
      assert.equal(selected.mode, "project_local_blocked");
      assert.deepEqual(selected.binding.issueCodes, [
        "project_cli_integrity_invalid",
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("target-version migration commands stay on the explicitly invoked package", async () => {
  const fixture = await exactLocalPackage();
  try {
    for (const argv of [
      ["init", "--workspace", fixture.root],
      ["adopt", "--workspace", fixture.root, "--exact", "owlrunkit@0.17.2"],
      ["core-successor", "plan", "--workspace", fixture.root],
    ]) {
      const selected = selectProjectCliInvocationV1({
        argv,
        cwd: fixture.root,
        selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
      });
      assert.equal(selected.mode, "current_package");
      assert.equal(selected.commandArgv, null);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("help and version remain available before a project is initialized", () => {
  for (const argv of [["--help"], ["--version"]]) {
    const selected = selectProjectCliInvocationV1({
      argv,
      cwd: process.cwd(),
      selfCliPath: "/opt/global/owlrunkit-bootstrap.mjs",
    });
    assert.equal(selected.mode, "current_package");
    assert.equal(selected.commandArgv, null);
  }
});
