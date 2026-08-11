import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { captureWorkspaceSnapshot } from "../../scripts/runkit-contract/quick-workspace-snapshot.mjs";
import { sha256Bytes } from "../../scripts/runkit-contract/quick-canonical.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), "owlcoda-quick-snapshot-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "quick@example.test");
  git(root, "config", "user.name", "Quick Test");
  writeFileSync(path.join(root, "tracked.txt"), "one\n");
  writeFileSync(path.join(root, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return root;
}

test("clean snapshots are deterministic and bind the dependency lockfile", () => {
  const root = repository();
  const first = captureWorkspaceSnapshot(root);
  const second = captureWorkspaceSnapshot(root);

  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, "OwlCodaWorkspaceSnapshotV1");
  assert.match(first.repositoryIdentity, /.+/);
  assert.match(first.headCommit, /^[0-9a-f]{40}$/);
  assert.match(first.trackedTreeIdentity, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(first.dirtyOverlay, []);
  assert.deepEqual(first.excludedRoots, [".owlcoda/runkit"]);
  assert.equal(first.ignoredPathsBound, false);
  assert.deepEqual(first.dependencyLockfiles.map((entry) => entry.path), ["package-lock.json"]);
  assert.match(first.sourceFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("dirty and untracked source bytes change the snapshot fingerprint while control files do not", () => {
  const root = repository();
  const clean = captureWorkspaceSnapshot(root);
  writeFileSync(path.join(root, "tracked.txt"), "two\n");
  writeFileSync(path.join(root, "untracked.js"), "export const value = 1\n");
  mkdirSync(path.join(root, ".owlcoda", "runkit"), { recursive: true });
  writeFileSync(path.join(root, ".owlcoda", "runkit", "control.json"), "{}\n");

  const dirty = captureWorkspaceSnapshot(root);
  assert.notEqual(dirty.sourceFingerprint, clean.sourceFingerprint);
  assert.deepEqual(
    dirty.dirtyOverlay.map((entry) => [entry.path, entry.state]),
    [["tracked.txt", "modified"], ["untracked.js", "untracked"]],
  );
  assert.ok(dirty.dirtyOverlay.every((entry) => !entry.path.startsWith(".owlcoda/runkit")));
});

test("submodule commits are included in the reproducible snapshot", () => {
  const child = repository();
  const root = repository();
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor/child");
  git(root, "commit", "-qam", "add submodule");

  const snapshot = captureWorkspaceSnapshot(root);
  assert.deepEqual(snapshot.submodules, [{
    path: "vendor/child",
    commit: git(child, "rev-parse", "HEAD"),
  }]);
});

test("dirty submodule bytes change the workspace fingerprint without a submodule commit", () => {
  const child = repository();
  const root = repository();
  git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor/child");
  git(root, "commit", "-qam", "add submodule");
  const submoduleRoot = path.join(root, "vendor", "child");

  writeFileSync(path.join(submoduleRoot, "tracked.txt"), "dirty-before\n");
  const before = captureWorkspaceSnapshot(root);
  writeFileSync(path.join(submoduleRoot, "tracked.txt"), "dirty-after\n");
  const after = captureWorkspaceSnapshot(root);

  assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
  assert.notEqual(
    after.dirtyOverlay.find((entry) => entry.path === "vendor/child")?.sha256,
    before.dirtyOverlay.find((entry) => entry.path === "vendor/child")?.sha256,
  );
});

test("repository identity never persists credentials from the origin URL", () => {
  const root = repository();
  git(root, "remote", "add", "origin", "https://automation:secret-token@example.test/team/repository.git");

  const snapshot = captureWorkspaceSnapshot(root);
  assert.equal(snapshot.repositoryIdentity, "https://example.test/team/repository.git");
  assert.doesNotMatch(JSON.stringify(snapshot), /automation|secret-token/);
});

test("workspace capture does not refresh or write the Git index", () => {
  const root = repository();
  const trackedPath = path.join(root, "tracked.txt");
  const indexPath = path.join(root, ".git", "index");
  const trackedStat = statSync(trackedPath);
  utimesSync(trackedPath, trackedStat.atime, new Date(trackedStat.mtimeMs + 2_000));
  const before = sha256Bytes(readFileSync(indexPath));

  captureWorkspaceSnapshot(root);

  assert.equal(sha256Bytes(readFileSync(indexPath)), before);
});
