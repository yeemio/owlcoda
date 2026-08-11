import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyDetectedProfilesV2,
  detectProfilesV2,
} from "../scripts/runkit-contract/profile-onboarding.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createProject() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "owlrunkit-profile-v2-")));
  writeJson(path.join(root, "package.json"), {
    name: "profile-v2-fixture",
    private: true,
    scripts: {
      build: "tsc -p tsconfig.json",
      test: "node --test",
    },
  });
  writeJson(path.join(root, "package-lock.json"), {
    name: "profile-v2-fixture",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "profile-v2-fixture",
      },
    },
  });
  mkdirSync(path.join(root, "src"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(path.join(root, "src", "index.js"), "export const ready = true;\n");
  const npmCli = path.join(root, ".fixture-tools", "npm-cli.js");
  mkdirSync(path.dirname(npmCli), { recursive: true });
  writeFileSync(npmCli, "process.exitCode = 0;\n");
  return { root, npmCli };
}

function highConfidenceResolver(npmCli) {
  return ({ tool }) => {
    assert.equal(tool, "npm");
    return {
      status: "resolved",
      confidence: "high",
      source: "project_lockfile",
      executable: realpathSync(process.execPath),
      argvPrefix: [realpathSync(npmCli)],
      version: "10.9.2",
      inputFiles: ["package.json", "package-lock.json"],
    };
  };
}

function createProjectWithLocalManager(manager) {
  const version = "1.2.3";
  const root = realpathSync(mkdtempSync(
    path.join(tmpdir(), `owlrunkit-profile-${manager}-`),
  ));
  const lockfile = manager === "pnpm"
    ? "pnpm-lock.yaml"
    : manager === "yarn"
      ? "yarn.lock"
      : "bun.lock";
  writeJson(path.join(root, "package.json"), {
    name: `${manager}-profile-fixture`,
    private: true,
    packageManager: `${manager}@${version}`,
    scripts: {
      build: "node build.mjs",
      test: "node --test",
    },
  });
  writeFileSync(
    path.join(root, lockfile),
    manager === "pnpm"
      ? "lockfileVersion: '9.0'\n"
      : manager === "yarn"
        ? "# yarn lockfile v1\n"
        : '{"lockfileVersion":1}\n',
  );
  const packageRoot = path.join(root, "node_modules", manager);
  const launcherPath = path.join(packageRoot, "bin", `${manager}.cjs`);
  writeJson(path.join(packageRoot, "package.json"), {
    name: manager,
    version,
    bin: {
      [manager]: `bin/${manager}.cjs`,
    },
  });
  mkdirSync(path.dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, "process.exitCode = 0;\n");
  return { launcherPath, lockfile, manager, root, version };
}

test("ProfileDetectionV2 produces a validated directly adoptable document from an authoritative project tool binding", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });

    assert.equal(detected.schemaVersion, "OwlCodaRunKitProfileDetectionV2");
    assert.equal(detected.status, "profiles_detected");
    assert.equal(detected.confidence, "high");
    assert.equal(detected.applyStatus, "ready_to_apply");
    assert.deepEqual(detected.issueCodes, []);
    assert.match(detected.detectionSha256, /^[a-f0-9]{64}$/);
    assert.equal(detected.proposedProfiles.schemaVersion, "OwlCodaRunKitProfilesV1");
    assert.equal(
      detected.proposedProfiles.profiles.filter((profile) => profile.primary).length,
      1,
    );
    assert.ok(detected.proposedProfiles.profiles.every((profile) =>
      profile.commands.every((command) =>
        command.executable === realpathSync(process.execPath)
        && command.argv[0] === realpathSync(npmCli))));
    assert.deepEqual(
      detected.inputManifest.map((entry) => entry.path),
      ["package-lock.json", "package.json"],
    );
    assert.ok(detected.inputManifest.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ProfileDetectionV2 never treats a PATH fallback as high confidence", () => {
  const { root } = createProject();
  try {
    rmSync(path.join(root, "package-lock.json"));
    const detected = detectProfilesV2({ workspaceRoot: root });

    assert.equal(detected.confidence, "review_required");
    assert.equal(detected.applyStatus, "review_required");
    assert.ok(detected.issueCodes.includes("project_tool_resolution_not_authoritative"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a common package-lock project is ready to apply through the default public detector", () => {
  const { root } = createProject();
  try {
    const detected = detectProfilesV2({ workspaceRoot: root });

    assert.equal(detected.confidence, "high");
    assert.equal(detected.applyStatus, "ready_to_apply");
    assert.equal(detected.toolBinding.source, "project_lockfile");
    assert.match(detected.toolBinding.version, /^[0-9]+\.[0-9]+\.[0-9]+/);
    assert.match(detected.toolBinding.executableSha256, /^[a-f0-9]{64}$/);
    assert.match(detected.toolBinding.launcherSha256, /^[a-f0-9]{64}$/);

    const applied = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });
    assert.equal(applied.status, "profiles_applied");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project-local pnpm, Yarn, and Bun launchers produce directly adoptable profiles", () => {
  for (const manager of ["pnpm", "yarn", "bun"]) {
    const fixture = createProjectWithLocalManager(manager);
    try {
      const detected = detectProfilesV2({ workspaceRoot: fixture.root });

      assert.equal(detected.confidence, "high", manager);
      assert.equal(detected.applyStatus, "ready_to_apply", manager);
      assert.equal(detected.toolBinding.packageManager, manager);
      assert.equal(detected.toolBinding.source, "project_install");
      assert.equal(detected.toolBinding.version, fixture.version);
      assert.deepEqual(
        detected.toolBinding.argvPrefix,
        [realpathSync(fixture.launcherPath)],
      );
      assert.deepEqual(
        detected.inputManifest.map((entry) => entry.path),
        [
          fixture.lockfile,
          `node_modules/${manager}/bin/${manager}.cjs`,
          `node_modules/${manager}/package.json`,
          "package.json",
        ].sort(),
      );
      assert.ok(detected.proposedProfiles.profiles.every((profile) =>
        profile.commands.every((command) =>
          command.executable === realpathSync(process.execPath)
          && command.argv[0] === realpathSync(fixture.launcherPath))));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("a manager declaration without an exact project-local launcher remains review-required", () => {
  const fixture = createProjectWithLocalManager("pnpm");
  try {
    rmSync(path.join(fixture.root, "node_modules"), {
      recursive: true,
      force: true,
    });

    const detected = detectProfilesV2({ workspaceRoot: fixture.root });

    assert.equal(detected.confidence, "review_required");
    assert.equal(detected.applyStatus, "review_required");
    assert.equal(detected.toolBinding.packageManager, "pnpm");
    assert.ok(detected.issueCodes.includes(
      "project_tool_resolution_not_authoritative",
    ));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("ProfileDetectionV2 never adopts database or Prisma mutation scripts as verification commands", () => {
  const { root, npmCli } = createProject();
  try {
    writeJson(path.join(root, "package.json"), {
      name: "profile-v2-database-fixture",
      private: true,
      scripts: {
        "db:migrate": "prisma migrate deploy",
        "db:reset": "prisma migrate reset --force",
        "db:seed": "prisma db seed",
        "prisma:generate": "prisma generate",
        test: "node --test",
      },
    });
    mkdirSync(path.join(root, "prisma"), { recursive: true });
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    const commands = detected.proposedProfiles.profiles
      .flatMap((profile) => profile.commands);

    assert.equal(detected.confidence, "high");
    assert.equal(detected.applyStatus, "ready_to_apply");
    assert.equal(
      detected.proposedProfiles.profiles.some((profile) => profile.id === "database"),
      false,
    );
    assert.deepEqual(commands.map((entry) => entry.argv.at(-1)), ["test"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("high-confidence profile apply is create-only and persists a hash-bound receipt", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    const applied = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.equal(applied.schemaVersion, "OwlCodaRunKitProfilesApplyReceiptV1");
    assert.equal(applied.status, "profiles_applied");
    assert.equal(applied.detectionSha256, detected.detectionSha256);
    assert.match(applied.appliedProfilesSha256, /^[a-f0-9]{64}$/);
    assert.equal(applied.authorizationGranted, false);
    const profilesPath = path.join(root, ".owlcoda", "runkit", "profiles.json");
    assert.deepEqual(
      JSON.parse(readFileSync(profilesPath, "utf8")),
      detected.proposedProfiles,
    );
    assert.equal(existsSync(path.join(root, applied.receiptPath)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile apply rejects project tool drift after detection", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    writeFileSync(npmCli, "process.exitCode = 1;\n");

    const blocked = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.equal(blocked.status, "profiles_apply_blocked");
    assert.ok(blocked.issueCodes.includes("profile_detection_tool_drift"));
    assert.equal(
      existsSync(path.join(root, ".owlcoda", "runkit", "profiles.json")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile apply returns a blocked receipt for malformed detection input", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });

    const blocked = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: {
        ...detected,
        inputManifest: {},
      },
    });

    assert.equal(blocked.status, "profiles_apply_blocked");
    assert.ok(blocked.issueCodes.includes("profile_detection_invalid"));
    assert.equal(
      existsSync(path.join(root, ".owlcoda", "runkit", "profiles.json")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile apply refuses to overwrite any existing owner configuration", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    const ownerProfiles = {
      schemaVersion: "OwlCodaRunKitProfilesV1",
      profiles: [{
        id: "owner-profile",
        paths: ["owner/**"],
      }],
    };
    const profilesPath = path.join(root, ".owlcoda", "runkit", "profiles.json");
    writeJson(profilesPath, ownerProfiles);
    const before = readFileSync(profilesPath, "utf8");

    const blocked = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.equal(blocked.status, "profiles_apply_blocked");
    assert.equal(blocked.writesPerformed, 0);
    assert.deepEqual(blocked.issueCodes, ["profiles_already_exists"]);
    assert.equal(readFileSync(profilesPath, "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile apply completes an exact interrupted transaction without overwriting owner state", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    const runtimeRoot = path.join(root, ".owlcoda", "runkit");
    const receiptRoot = path.join(runtimeRoot, "profile-apply-receipts");
    const transactionRoot = path.join(
      runtimeRoot,
      `.profile-apply-${detected.detectionSha256}.lock`,
    );
    const profilesBytes = `${JSON.stringify(detected.proposedProfiles, null, 2)}\n`;
    const receiptPath = path.join(
      ".owlcoda",
      "runkit",
      "profile-apply-receipts",
      `${detected.detectionSha256}.json`,
    );
    const expectedReceipt = {
      schemaVersion: "OwlCodaRunKitProfilesApplyReceiptV1",
      status: "profiles_applied",
      writesPerformed: 2,
      detectionSha256: detected.detectionSha256,
      beforeProfilesSha256: null,
      appliedProfilesSha256: sha256(profilesBytes),
      receiptPath,
      issueCodes: [],
      authorizationGranted: false,
    };
    mkdirSync(transactionRoot, { recursive: true });
    mkdirSync(receiptRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, "profiles.json"), profilesBytes);
    writeJson(path.join(transactionRoot, "receipt.json"), expectedReceipt);

    const applied = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.deepEqual(applied, expectedReceipt);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(root, receiptPath), "utf8")),
      expectedReceipt,
    );
    assert.equal(existsSync(transactionRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile apply preserves an interrupted transaction whose staged receipt does not match", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    const runtimeRoot = path.join(root, ".owlcoda", "runkit");
    const transactionRoot = path.join(
      runtimeRoot,
      `.profile-apply-${detected.detectionSha256}.lock`,
    );
    const profilesBytes = `${JSON.stringify(detected.proposedProfiles, null, 2)}\n`;
    mkdirSync(transactionRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, "profiles.json"), profilesBytes);
    writeJson(path.join(transactionRoot, "receipt.json"), {
      status: "forged",
    });

    const blocked = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.equal(blocked.status, "profiles_apply_blocked");
    assert.deepEqual(blocked.issueCodes, [
      "profile_apply_transaction_recovery_invalid",
    ]);
    assert.equal(
      readFileSync(path.join(runtimeRoot, "profiles.json"), "utf8"),
      profilesBytes,
    );
    assert.equal(existsSync(transactionRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile recovery validates every staged artifact before committing profiles", () => {
  const { root, npmCli } = createProject();
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    const runtimeRoot = path.join(root, ".owlcoda", "runkit");
    const transactionRoot = path.join(
      runtimeRoot,
      `.profile-apply-${detected.detectionSha256}.lock`,
    );
    const profilesBytes = `${JSON.stringify(detected.proposedProfiles, null, 2)}\n`;
    mkdirSync(transactionRoot, { recursive: true });
    writeFileSync(path.join(transactionRoot, "profiles.json"), profilesBytes);
    writeJson(path.join(transactionRoot, "receipt.json"), {
      status: "forged",
    });

    const blocked = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.equal(blocked.status, "profiles_apply_blocked");
    assert.deepEqual(blocked.issueCodes, [
      "profile_apply_transaction_recovery_invalid",
    ]);
    assert.equal(existsSync(path.join(runtimeRoot, "profiles.json")), false);
    assert.equal(existsSync(transactionRoot), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("profile apply refuses a symlinked RunKit directory without writing outside the workspace", () => {
  const { root, npmCli } = createProject();
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), "owlrunkit-profile-outside-")));
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    mkdirSync(path.join(root, ".owlcoda"), { recursive: true });
    symlinkSync(outside, path.join(root, ".owlcoda", "runkit"));

    const blocked = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.equal(blocked.status, "profiles_apply_blocked");
    assert.ok(blocked.issueCodes.includes("profile_apply_directory_untrusted"));
    assert.equal(existsSync(path.join(outside, "profiles.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("profile apply rolls back profiles.json when its receipt cannot commit", {
  skip: process.platform === "win32",
}, () => {
  const { root, npmCli } = createProject();
  const receiptRoot = path.join(
    root,
    ".owlcoda",
    "runkit",
    "profile-apply-receipts",
  );
  try {
    const detected = detectProfilesV2({
      workspaceRoot: root,
      projectToolResolver: highConfidenceResolver(npmCli),
    });
    mkdirSync(receiptRoot, { recursive: true });
    chmodSync(receiptRoot, 0o500);

    const blocked = applyDetectedProfilesV2({
      workspaceRoot: root,
      detection: detected,
    });

    assert.equal(blocked.status, "profiles_apply_blocked");
    assert.ok(blocked.issueCodes.includes("profile_apply_transaction_failed"));
    assert.equal(
      existsSync(path.join(root, ".owlcoda", "runkit", "profiles.json")),
      false,
    );
  } finally {
    chmodSync(receiptRoot, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
