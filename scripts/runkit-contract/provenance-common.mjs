import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  RUNTIME_ROOT,
  currentCoreIdentity,
  validateExecutionPin,
} from "./core-contract.mjs";

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJsonExclusive(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

export function writeJsonExclusiveAtomically(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    linkSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function writeJsonAtomically(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  rmSync(temporaryPath, { force: true });
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporaryPath, filePath);
}

export function assertAllowedKeys(value, label, allowedKeys) {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const allowed = new Set(allowedKeys);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported field: ${unsupported[0]}`);
  }
}

export function safeIdentifier(value, label) {
  if (typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    || value === "."
    || value === "..") {
    throw new Error(`${label} must use letters, digits, dot, underscore, or hyphen without path separators.`);
  }
  return value;
}

function withinRoot(root, candidate) {
  const remainder = path.relative(root, candidate);
  return remainder === ""
    || (!remainder.startsWith(`..${path.sep}`) && remainder !== ".." && !path.isAbsolute(remainder));
}

export function safeRelativePath(value, label, { allowDot = false } = {}) {
  if (allowDot && value === ".") return value;
  if (typeof value !== "string"
    || value.length === 0
    || path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")) {
    throw new Error(`${label} must be a safe relative path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} must not contain empty, dot, or parent segments.`);
  }
  return value;
}

export function resolveExistingArtifact(workspaceRoot, value, label) {
  const relativePath = safeRelativePath(value, label);
  const root = realpathSync(workspaceRoot);
  const candidate = path.resolve(root, relativePath);
  if (!withinRoot(root, candidate)) throw new Error(`${label} escapes the workspace.`);
  let current = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symlink.`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`${label} has a non-directory ancestor.`);
    }
    const resolved = realpathSync(current);
    if (!withinRoot(root, resolved)) {
      throw new Error(`${label} resolves outside the workspace.`);
    }
  }
  return realpathSync(candidate);
}

export function resolveWithinRoot(root, relativePath, label, options = {}) {
  const safePath = safeRelativePath(relativePath, label, options);
  const candidate = path.resolve(root, safePath);
  if (!withinRoot(root, candidate)) throw new Error(`${label} escapes its root.`);
  return candidate;
}

export function relativeToWorkspace(workspaceRoot, absolutePath) {
  const relativePath = path.relative(workspaceRoot, absolutePath).split(path.sep).join("/");
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error("Artifact path is outside the workspace.");
  }
  return relativePath;
}

export function loadActiveExecution(workspaceRoot, runId) {
  const root = realpathSync(workspaceRoot);
  const runtimeRoot = path.resolve(root, RUNTIME_ROOT);
  const executionsRoot = path.join(runtimeRoot, "executions");
  const executionRoot = path.join(executionsRoot, runId);
  for (const [directoryPath, label] of [
    [runtimeRoot, "RunKit runtime directory"],
    [executionsRoot, "Executions directory"],
    [executionRoot, "Execution directory"],
  ]) {
    const stat = lstatSync(directoryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${label} must be a real directory, not a symlink.`);
    }
    const realDirectory = realpathSync(directoryPath);
    if (realDirectory !== path.resolve(directoryPath) || !withinRoot(root, realDirectory)) {
      throw new Error(`${label} must remain inside the RunKit workspace without symlink ancestors.`);
    }
  }
  const pin = readJson(path.join(executionRoot, "engine-pin.json"));
  const pinGate = validateExecutionPin({ expected: pin, actual: currentCoreIdentity() });
  return { executionRoot, pin, pinGate };
}

export function repositoryActionsFalse() {
  return {
    staged: false,
    committed: false,
    pushed: false,
    tagged: false,
    published: false,
    deployed: false,
  };
}
