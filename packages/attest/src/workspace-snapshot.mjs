import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

import { sha256Bytes, sha256Canonical } from "./formal.mjs";

const CONTROL_ROOT = ".owlcoda/runkit";
const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

function git(root, args, options = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
}

function optionalGit(root, args) {
  try {
    return git(root, args).trim();
  } catch {
    return "";
  }
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function isControlPath(value) {
  return value === CONTROL_ROOT || value.startsWith(`${CONTROL_ROOT}/`);
}

function fileHash(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    return sha256Bytes(Buffer.from(`symlink:${readlinkSync(absolutePath)}`, "utf8"));
  }
  if (stat.isDirectory()) {
    const commit = optionalGit(absolutePath, ["rev-parse", "HEAD"]);
    return sha256Canonical({
      algorithm: "gitlink-worktree-v1",
      commit,
      dirtyOverlay: parseStatus(absolutePath),
      submodules: submodules(absolutePath),
    });
  }
  return sha256Bytes(readFileSync(absolutePath));
}

function parseStatus(root) {
  const raw = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const fields = raw.split("\0");
  const entries = new Map();
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    const currentPath = normalizePath(field.slice(3));
    if (status.includes("R") || status.includes("C")) index += 1;
    if (!currentPath || isControlPath(currentPath)) continue;
    let state = "modified";
    if (status === "??") state = "untracked";
    if (status.includes("D")) state = "deleted";
    let sha256 = null;
    if (state !== "deleted") {
      try {
        sha256 = fileHash(root, currentPath);
      } catch {
        state = "deleted";
      }
    }
    entries.set(currentPath, { path: currentPath, state, sha256 });
  }
  return [...entries.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function submodules(root) {
  const output = optionalGit(root, ["submodule", "status", "--recursive"]);
  if (!output) return [];
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^[ +-U]?([0-9a-f]{40,64})\s+([^\s]+)/.exec(line);
      if (!match) throw new Error(`Cannot parse git submodule status: ${line}`);
      return { path: normalizePath(match[2]), commit: match[1] };
    })
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function dependencyLockfiles(root) {
  const raw = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]);
  return raw
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .filter((entry) => !isControlPath(entry) && LOCKFILE_NAMES.has(path.posix.basename(entry)))
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((entry) => ({ path: entry, sha256: fileHash(root, entry) }));
}

function sanitizedRemoteIdentity(remote) {
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return remote.replace(/^[^/@\s]+@(?=[^/\s]+:)/, "");
  }
}

function repositoryIdentity(root) {
  const remote = optionalGit(root, ["remote", "get-url", "origin"]);
  if (remote) return sanitizedRemoteIdentity(remote);
  return `local:${realpathSync(root)}`;
}

function trackedTreeIdentity(root, headCommit) {
  const tree = headCommit ? git(root, ["rev-parse", "HEAD^{tree}"]).trim() : "";
  const objectFormat = optionalGit(root, ["rev-parse", "--show-object-format"]) || "sha1";
  return sha256Canonical({
    algorithm: "git-tree-object-v1",
    objectFormat,
    tree,
  });
}

export function captureWorkspaceSnapshot(workspaceRoot) {
  const root = realpathSync(workspaceRoot);
  git(root, ["rev-parse", "--is-inside-work-tree"]);
  const headCommit = optionalGit(root, ["rev-parse", "HEAD"]) || null;
  const payload = {
    schemaVersion: "OwlCodaWorkspaceSnapshotV1",
    repositoryIdentity: repositoryIdentity(root),
    headCommit,
    trackedTreeIdentity: trackedTreeIdentity(root, headCommit),
    submodules: submodules(root),
    dirtyOverlay: parseStatus(root),
    dependencyLockfiles: dependencyLockfiles(root),
    excludedRoots: [CONTROL_ROOT],
    ignoredPathsBound: false,
    policyVersion: "workspace-snapshot-v1",
  };
  return {
    ...payload,
    sourceFingerprint: sha256Canonical(payload),
  };
}
