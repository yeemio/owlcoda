import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";
import * as sourceCandidate from "../scripts/runkit-contract/source-candidate.mjs";

const {
  freezeSourceCandidateV1,
  verifySourceCandidateV1,
} = sourceCandidate;

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function gitStatus(root) {
  return execFileSync("git", [
    "-C",
    root,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
}

async function workingTreeSnapshot(root) {
  const entries = [];
  async function visit(relativePath) {
    const absolutePath = path.join(root, relativePath);
    const names = await readdir(absolutePath);
    names.sort();
    for (const name of names) {
      if (relativePath === "" && name === ".git") continue;
      const childRelative = relativePath ? `${relativePath}/${name}` : name;
      const childAbsolute = path.join(root, childRelative);
      const stat = await lstat(childAbsolute);
      if (stat.isSymbolicLink()) {
        entries.push({
          path: childRelative,
          kind: "symlink",
          mode: stat.mode & 0o777,
          target: await readlink(childAbsolute),
        });
      } else if (stat.isDirectory()) {
        entries.push({
          path: childRelative,
          kind: "directory",
          mode: stat.mode & 0o777,
        });
        await visit(childRelative);
      } else {
        const bytes = await readFile(childAbsolute);
        entries.push({
          path: childRelative,
          kind: "file",
          mode: stat.mode & 0o777,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await visit("");
  return entries;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-source-candidate-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/example.txt"), "baseline\n");
  await writeJson(path.join(root, "goal.json"), {
    schemaVersion: "OwlCodaRunKitGoalContractV1",
    objective: "freeze a dirty source candidate",
    nonGoals: [],
    authorization: {
      git: false,
      publish: false,
      deploy: false,
      destructive: false,
    },
  });
  git(root, "init", "-q");
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=RunKit Test",
    "-c",
    "user.email=runkit@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
  assert.equal((await runCli([
    "start",
    "--workspace",
    root,
    "--run-id",
    "dirty-candidate",
    "--goal",
    path.join(root, "goal.json"),
    "--work-item",
    "delivery",
    "--owned-path",
    "src/**",
  ])).status, "started");
  return root;
}

test("a dirty worktree becomes an exact immutable source candidate without a commit", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const frozen = freezeSourceCandidateV1({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-001",
    });

    assert.equal(frozen.status, "source_candidate_frozen");
    assert.equal(frozen.authorizationGranted, false);
    const candidate = JSON.parse(await readFile(
      path.join(root, frozen.candidatePath),
      "utf8",
    ));
    assert.equal(candidate.schemaVersion, "OwlCodaRunKitSourceCandidateV1");
    assert.equal(candidate.sourceMode, "dirty_worktree_exact_manifest");
    assert.equal(candidate.baseline.head, git(root, "rev-parse", "HEAD"));
    assert.deepEqual(
      Object.keys(candidate.changedFiles.wholeFileSha256),
      ["src/example.txt"],
    );
    assert.match(candidate.candidateSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      verifySourceCandidateV1({
        workspaceRoot: root,
        candidatePath: frozen.candidatePath,
      }).status,
      "valid",
    );

    await writeFile(path.join(root, "src/example.txt"), "drifted\n");
    const drifted = verifySourceCandidateV1({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
    });
    assert.equal(drifted.status, "invalid");
    assert.ok(drifted.issueCodes.includes("source_candidate_delivery_drift"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source candidates are create-only", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    freezeSourceCandidateV1({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-001",
    });
    assert.throws(() => freezeSourceCandidateV1({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-001",
    }), /already exists/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the candidate CLI freezes and verifies the same exact source", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const frozen = await runCli([
      "candidate",
      "freeze",
      "--workspace",
      root,
      "--run-id",
      "dirty-candidate",
      "--from-lease",
      "delivery",
      "--candidate-id",
      "candidate-cli",
    ]);
    assert.equal(frozen.status, "source_candidate_frozen");
    assert.equal(
      JSON.parse(await readFile(path.join(root, frozen.candidatePath), "utf8"))
        .schemaVersion,
      "OwlCodaRunKitSourceCandidateV2",
    );
    const verified = await runCli([
      "candidate",
      "verify",
      "--workspace",
      root,
      "--candidate",
      frozen.candidatePath,
    ]);
    assert.equal(verified.status, "valid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V2 freezes modified, added, deleted, and renamed dirty files in one exact manifest", async () => {
  assert.equal(typeof sourceCandidate.freezeSourceCandidateV2, "function");
  assert.equal(typeof sourceCandidate.verifySourceCandidateV2, "function");
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    await writeFile(path.join(root, "src/added.txt"), "added\n");
    await writeFile(path.join(root, "src/deleted.txt"), "delete me\n");
    await writeFile(path.join(root, "src/old-name.txt"), "rename me\n");
    git(root, "add", "src/deleted.txt", "src/old-name.txt");
    git(
      root,
      "-c",
      "user.name=RunKit Test",
      "-c",
      "user.email=runkit@example.invalid",
      "commit",
      "-qm",
      "add dirty candidate fixtures",
    );
    await unlink(path.join(root, "src/deleted.txt"));
    await rename(
      path.join(root, "src/old-name.txt"),
      path.join(root, "src/new-name.txt"),
    );
    git(root, "add", "-A", "src/old-name.txt", "src/new-name.txt");

    const frozen = sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-v2",
    });
    assert.equal(frozen.status, "source_candidate_frozen");
    assert.equal(frozen.authorizationGranted, false);
    const candidate = JSON.parse(await readFile(
      path.join(root, frozen.candidatePath),
      "utf8",
    ));
    assert.equal(candidate.schemaVersion, "OwlCodaRunKitSourceCandidateV2");
    assert.equal(candidate.sourceManifest.schemaVersion, "OwlCodaRunKitDirtySourceManifestV2");
    assert.deepEqual(
      candidate.sourceManifest.entries.map((entry) => ({
        operation: entry.operation,
        path: entry.path,
        previousPath: entry.previousPath,
      })),
      [
        { operation: "added", path: "src/added.txt", previousPath: undefined },
        { operation: "deleted", path: "src/deleted.txt", previousPath: undefined },
        { operation: "modified", path: "src/example.txt", previousPath: undefined },
        { operation: "renamed", path: "src/new-name.txt", previousPath: "src/old-name.txt" },
      ],
    );
    assert.match(candidate.sourceManifest.sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.match(candidate.candidateSha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(
      sourceCandidate.verifySourceCandidateV2({
        workspaceRoot: root,
        candidatePath: frozen.candidatePath,
      }).status,
      "valid",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("V2 exact manifests detect content, absence, rename, and owned-status drift", async () => {
  const cases = [
    {
      name: "content",
      mutate: async (root) => writeFile(path.join(root, "src/example.txt"), "drifted\n"),
    },
    {
      name: "new-owned-path",
      mutate: async (root) => writeFile(path.join(root, "src/later.txt"), "later\n"),
    },
  ];
  for (const { name, mutate } of cases) {
    const root = await setup();
    try {
      await writeFile(path.join(root, "src/example.txt"), "candidate\n");
      const frozen = sourceCandidate.freezeSourceCandidateV2({
        workspaceRoot: root,
        runId: "dirty-candidate",
        workItemId: "delivery",
        candidateId: `candidate-${name}`,
      });
      await mutate(root);
      const verified = sourceCandidate.verifySourceCandidateV2({
        workspaceRoot: root,
        candidatePath: frozen.candidatePath,
      });
      assert.equal(verified.status, "invalid");
      assert.ok(verified.issueCodes.includes("source_candidate_manifest_drift"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("V2 exact manifests invalidate restored deletions and changed renames", async () => {
  for (const name of ["deleted", "renamed"]) {
    const root = await setup();
    try {
      await writeFile(path.join(root, "src/deleted.txt"), "delete me\n");
      await writeFile(path.join(root, "src/old-name.txt"), "rename me\n");
      git(root, "add", "src/deleted.txt", "src/old-name.txt");
      git(
        root,
        "-c",
        "user.name=RunKit Test",
        "-c",
        "user.email=runkit@example.invalid",
        "commit",
        "-qm",
        "add absence fixtures",
      );
      await unlink(path.join(root, "src/deleted.txt"));
      await rename(
        path.join(root, "src/old-name.txt"),
        path.join(root, "src/new-name.txt"),
      );
      git(root, "add", "-A", "src/old-name.txt", "src/new-name.txt");
      const frozen = sourceCandidate.freezeSourceCandidateV2({
        workspaceRoot: root,
        runId: "dirty-candidate",
        workItemId: "delivery",
        candidateId: `candidate-${name}`,
      });
      if (name === "deleted") {
        await writeFile(path.join(root, "src/deleted.txt"), "restored\n");
      } else {
        await writeFile(path.join(root, "src/new-name.txt"), "renamed drift\n");
      }
      const verified = sourceCandidate.verifySourceCandidateV2({
        workspaceRoot: root,
        candidatePath: frozen.candidatePath,
      });
      assert.equal(verified.status, "invalid");
      assert.ok(verified.issueCodes.includes("source_candidate_manifest_drift"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("V2 source candidates are create-only and reject symlinked dirty files", async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-v2",
    });
    assert.throws(() => sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-v2",
    }), /already exists/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const symlinkRoot = await setup();
  try {
    await symlink(
      path.join(symlinkRoot, "goal.json"),
      path.join(symlinkRoot, "src/link.txt"),
    );
    assert.throws(() => sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: symlinkRoot,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-symlink",
    }), /symlink/u);
  } finally {
    await rm(symlinkRoot, { recursive: true, force: true });
  }
});

test("V2 materializes an exact dirty candidate into an independent baseline clone", async () => {
  assert.equal(typeof sourceCandidate.materializeSourceCandidateV2, "function");
  const root = await setup();
  const scratch = await mkdtemp(path.join(tmpdir(), "owlrunkit-source-materialize-"));
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    await writeFile(path.join(root, "src/added.txt"), "added\n");
    await writeFile(path.join(root, "src/deleted.txt"), "delete me\n");
    await writeFile(path.join(root, "src/old-name.txt"), "rename me\n");
    git(root, "add", "src/deleted.txt", "src/old-name.txt");
    git(
      root,
      "-c",
      "user.name=RunKit Test",
      "-c",
      "user.email=runkit@example.invalid",
      "commit",
      "-qm",
      "add materialize fixtures",
    );
    await unlink(path.join(root, "src/deleted.txt"));
    await rename(
      path.join(root, "src/old-name.txt"),
      path.join(root, "src/new-name.txt"),
    );
    git(root, "add", "-A", "src/old-name.txt", "src/new-name.txt");
    const frozen = sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-materialize",
    });
    const cloneRoot = path.join(scratch, "clean-clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
    git(cloneRoot, "checkout", "--quiet", "--detach", git(root, "rev-parse", "HEAD"));

    const materialized = sourceCandidate.materializeSourceCandidateV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      targetWorkspaceRoot: cloneRoot,
    });

    assert.equal(materialized.status, "source_candidate_materialized");
    assert.equal(materialized.authorizationGranted, false);
    assert.equal(
      await readFile(path.join(cloneRoot, "src/example.txt"), "utf8"),
      "candidate\n",
    );
    assert.equal(
      await readFile(path.join(cloneRoot, "src/added.txt"), "utf8"),
      "added\n",
    );
    assert.equal(
      await readFile(path.join(cloneRoot, "src/new-name.txt"), "utf8"),
      "rename me\n",
    );
    await assert.rejects(access(path.join(cloneRoot, "src/deleted.txt")));
    await assert.rejects(access(path.join(cloneRoot, "src/old-name.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("V2 materializes a deletion-only candidate with an empty payload", async () => {
  const root = await setup();
  const scratch = await mkdtemp(path.join(tmpdir(), "owlrunkit-source-delete-only-"));
  try {
    await unlink(path.join(root, "src/example.txt"));
    const frozen = sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-delete-only",
    });
    const candidate = JSON.parse(await readFile(
      path.join(root, frozen.candidatePath),
      "utf8",
    ));
    assert.equal(candidate.payload.blobCount, 0);
    assert.equal(candidate.payload.totalBytes, 0);
    assert.deepEqual(candidate.payload.entries, []);

    const cloneRoot = path.join(scratch, "clean-clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
    git(cloneRoot, "checkout", "--quiet", "--detach", candidate.baseline.head);
    const materialized = sourceCandidate.materializeSourceCandidateV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      targetWorkspaceRoot: cloneRoot,
    });
    assert.equal(materialized.status, "source_candidate_materialized");
    await assert.rejects(access(path.join(cloneRoot, "src/example.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("V2 materialization rejects a changed frozen payload", async () => {
  const root = await setup();
  const scratch = await mkdtemp(path.join(tmpdir(), "owlrunkit-source-payload-drift-"));
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const frozen = sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-payload-drift",
    });
    const candidate = JSON.parse(await readFile(
      path.join(root, frozen.candidatePath),
      "utf8",
    ));
    await writeFile(
      path.join(root, candidate.payload.entries[0].payloadPath),
      "tampered\n",
    );
    const cloneRoot = path.join(scratch, "clean-clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
    git(cloneRoot, "checkout", "--quiet", "--detach", candidate.baseline.head);

    assert.throws(() => sourceCandidate.materializeSourceCandidateV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      targetWorkspaceRoot: cloneRoot,
    }), /payload/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const injectedFailure of [
  {
    name: "payload write",
    hook: "beforePayloadWrite",
  },
  {
    name: "payload chmod",
    hook: "beforePayloadChmod",
  },
]) {
  test(`V2 materialization leaves the target byte-exact after ${injectedFailure.name} failure`, async () => {
    const root = await setup();
    const scratch = await mkdtemp(path.join(
      tmpdir(),
      "owlrunkit-source-atomic-failure-",
    ));
    try {
      await writeFile(path.join(root, "src/example.txt"), "candidate\n");
      await writeFile(path.join(root, "src/added.txt"), "added\n");
      const frozen = sourceCandidate.freezeSourceCandidateV2({
        workspaceRoot: root,
        runId: "dirty-candidate",
        workItemId: "delivery",
        candidateId: `candidate-${injectedFailure.hook}`,
      });
      const candidate = JSON.parse(await readFile(
        path.join(root, frozen.candidatePath),
        "utf8",
      ));
      const cloneRoot = path.join(scratch, "clean-clone");
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
      git(cloneRoot, "checkout", "--quiet", "--detach", candidate.baseline.head);
      const treeBefore = await workingTreeSnapshot(cloneRoot);
      const statusBefore = gitStatus(cloneRoot);

      assert.throws(() => sourceCandidate.materializeSourceCandidateV2({
        workspaceRoot: root,
        candidatePath: frozen.candidatePath,
        targetWorkspaceRoot: cloneRoot,
        hooks: {
          [injectedFailure.hook]() {
            throw new Error(`injected ${injectedFailure.name} failure`);
          },
        },
      }), new RegExp(`injected ${injectedFailure.name} failure`, "u"));

      assert.deepEqual(await workingTreeSnapshot(cloneRoot), treeBefore);
      assert.deepEqual(gitStatus(cloneRoot), statusBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

test("V2 materialization rejects and rolls back an extra dirty path injected after the atomic switch", async () => {
  const root = await setup();
  const scratch = await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-source-extra-path-",
  ));
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const frozen = sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-extra-path",
    });
    const candidate = JSON.parse(await readFile(
      path.join(root, frozen.candidatePath),
      "utf8",
    ));
    const cloneRoot = path.join(scratch, "clean-clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
    git(cloneRoot, "checkout", "--quiet", "--detach", candidate.baseline.head);
    const treeBefore = await workingTreeSnapshot(cloneRoot);
    const statusBefore = gitStatus(cloneRoot);

    assert.throws(() => sourceCandidate.materializeSourceCandidateV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      targetWorkspaceRoot: cloneRoot,
      hooks: {
        afterTargetSwitch() {
          writeFileSync(
            path.join(cloneRoot, "injected-untracked.txt"),
            "not in candidate\n",
          );
        },
      },
    }), /unexpected Git changes/u);

    assert.deepEqual(await workingTreeSnapshot(cloneRoot), treeBefore);
    assert.deepEqual(gitStatus(cloneRoot), statusBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("V2 committed-journal recovery never accepts target drift outside the candidate", async () => {
  const root = await setup();
  const scratch = await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-source-committed-drift-",
  ));
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const frozen = sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-committed-drift",
    });
    const candidate = JSON.parse(await readFile(
      path.join(root, frozen.candidatePath),
      "utf8",
    ));
    const cloneRoot = path.join(scratch, "clean-clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
    git(cloneRoot, "checkout", "--quiet", "--detach", candidate.baseline.head);

    assert.throws(() => sourceCandidate.materializeSourceCandidateV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      targetWorkspaceRoot: cloneRoot,
      hooks: {
        simulateInterruptionAt: "after_commit",
      },
    }), /simulated materialization interruption/u);
    await writeFile(
      path.join(cloneRoot, "injected-untracked.txt"),
      "not in candidate\n",
    );

    const materialized = sourceCandidate.materializeSourceCandidateV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      targetWorkspaceRoot: cloneRoot,
    });

    assert.equal(materialized.status, "source_candidate_materialized");
    await assert.rejects(access(path.join(cloneRoot, "injected-untracked.txt")));
    assert.equal(
      await readFile(path.join(cloneRoot, "src/example.txt"), "utf8"),
      "candidate\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const interruptionPhase of [
  "after_target_backup",
  "after_target_switch",
  "after_commit",
]) {
  test(`V2 materialization recovers an interruption ${interruptionPhase}`, async () => {
    const root = await setup();
    const scratch = await mkdtemp(path.join(
      tmpdir(),
      "owlrunkit-source-interruption-recovery-",
    ));
    try {
      await writeFile(path.join(root, "src/example.txt"), "candidate\n");
      await writeFile(path.join(root, "src/added.txt"), "added\n");
      const frozen = sourceCandidate.freezeSourceCandidateV2({
        workspaceRoot: root,
        runId: "dirty-candidate",
        workItemId: "delivery",
        candidateId: `candidate-interruption-${interruptionPhase}`,
      });
      const candidate = JSON.parse(await readFile(
        path.join(root, frozen.candidatePath),
        "utf8",
      ));
      const cloneRoot = path.join(scratch, "clean-clone");
      execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
      git(cloneRoot, "checkout", "--quiet", "--detach", candidate.baseline.head);
      const treeBefore = await workingTreeSnapshot(cloneRoot);
      const statusBefore = gitStatus(cloneRoot);

      assert.throws(() => sourceCandidate.materializeSourceCandidateV2({
        workspaceRoot: root,
        candidatePath: frozen.candidatePath,
        targetWorkspaceRoot: cloneRoot,
        hooks: {
          simulateInterruptionAt: interruptionPhase,
        },
      }), /simulated materialization interruption/u);

      let materialized;
      if (interruptionPhase === "after_commit") {
        materialized = sourceCandidate.materializeSourceCandidateV2({
          workspaceRoot: root,
          candidatePath: frozen.candidatePath,
          targetWorkspaceRoot: cloneRoot,
        });
        assert.equal(materialized.resumed, true);
      } else {
        assert.throws(() => sourceCandidate.materializeSourceCandidateV2({
          workspaceRoot: root,
          candidatePath: frozen.candidatePath,
          targetWorkspaceRoot: cloneRoot,
          hooks: {
            afterRecovery() {
              throw new Error("stop after recovery");
            },
          },
        }), /stop after recovery/u);
        assert.deepEqual(await workingTreeSnapshot(cloneRoot), treeBefore);
        assert.deepEqual(gitStatus(cloneRoot), statusBefore);
        materialized = sourceCandidate.materializeSourceCandidateV2({
          workspaceRoot: root,
          candidatePath: frozen.candidatePath,
          targetWorkspaceRoot: cloneRoot,
        });
      }

      assert.equal(materialized.status, "source_candidate_materialized");
      assert.equal(
        await readFile(path.join(cloneRoot, "src/example.txt"), "utf8"),
        "candidate\n",
      );
      assert.equal(
        await readFile(path.join(cloneRoot, "src/added.txt"), "utf8"),
        "added\n",
      );
      assert.deepEqual(
        (await readdir(scratch)).filter((name) => (
          name.startsWith(".owlrunkit-source-materialize-")
        )),
        [],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });
}

test("the candidate CLI exposes clean-room materialization", async () => {
  const root = await setup();
  const scratch = await mkdtemp(path.join(tmpdir(), "owlrunkit-source-cli-materialize-"));
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const frozen = await runCli([
      "candidate",
      "freeze",
      "--workspace",
      root,
      "--run-id",
      "dirty-candidate",
      "--from-lease",
      "delivery",
      "--candidate-id",
      "candidate-cli-materialize",
    ]);
    const cloneRoot = path.join(scratch, "clean-clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, cloneRoot]);
    git(cloneRoot, "checkout", "--quiet", "--detach", git(root, "rev-parse", "HEAD"));

    const materialized = await runCli([
      "candidate",
      "materialize",
      "--workspace",
      root,
      "--candidate",
      frozen.candidatePath,
      "--target-workspace",
      cloneRoot,
    ]);
    assert.equal(materialized.status, "source_candidate_materialized");
    assert.equal(
      await readFile(path.join(cloneRoot, "src/example.txt"), "utf8"),
      "candidate\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

test("release input closure rejects dirty build inputs outside the frozen candidate", async () => {
  assert.equal(typeof sourceCandidate.verifySourceCandidatePathClosureV2, "function");
  const root = await setup();
  try {
    await writeFile(path.join(root, "src/example.txt"), "candidate\n");
    const frozen = sourceCandidate.freezeSourceCandidateV2({
      workspaceRoot: root,
      runId: "dirty-candidate",
      workItemId: "delivery",
      candidateId: "candidate-closure",
    });
    assert.equal(sourceCandidate.verifySourceCandidatePathClosureV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      includedPaths: ["src/**"],
    }).status, "valid");

    await writeFile(path.join(root, "package-input.txt"), "unbound build input\n");
    const incomplete = sourceCandidate.verifySourceCandidatePathClosureV2({
      workspaceRoot: root,
      candidatePath: frozen.candidatePath,
      includedPaths: ["src/**", "package-input.txt"],
    });
    assert.equal(incomplete.status, "invalid");
    assert.deepEqual(incomplete.uncoveredDirtyPaths, ["package-input.txt"]);
    assert.ok(incomplete.issueCodes.includes("source_candidate_path_closure_incomplete"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
