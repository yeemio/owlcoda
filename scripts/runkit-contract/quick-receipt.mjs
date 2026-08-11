import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { sha256Bytes } from "./quick-canonical.mjs";

const QUICK_ROOT = ".owlcoda/runkit/quick";

function withinRoot(root, candidate) {
  const remainder = path.relative(root, candidate);
  return remainder !== ""
    && !remainder.startsWith(`..${path.sep}`)
    && remainder !== ".."
    && !path.isAbsolute(remainder);
}

function ensureDirectoryChain(workspaceRoot, relativeDirectory) {
  const root = realpathSync(workspaceRoot);
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Quick receipt store component must be a real directory: ${current}`);
    }
    const resolved = realpathSync(current);
    if (!withinRoot(root, resolved)) {
      throw new Error(`Quick receipt store escapes the workspace: ${current}`);
    }
  }
  return current;
}

function atomicWriteJson(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  renameSync(temporary, filePath);
}

export function createQuickReceiptStore(workspaceRoot, receiptId = `quick-${Date.now()}-${randomUUID()}`) {
  if (!/^[a-zA-Z0-9._-]+$/.test(receiptId)) throw new Error("receiptId is unsafe");
  const receiptRoot = ensureDirectoryChain(workspaceRoot, `${QUICK_ROOT}/receipts/${receiptId}`);
  const stdoutPath = path.join(receiptRoot, "stdout.log");
  const stderrPath = path.join(receiptRoot, "stderr.log");
  const stdoutFd = openSync(stdoutPath, "wx", 0o600);
  const stderrFd = openSync(stderrPath, "wx", 0o600);
  const rootStat = lstatSync(receiptRoot);
  const stdoutStat = fstatSync(stdoutFd);
  const stderrStat = fstatSync(stderrFd);
  return {
    receiptId,
    receiptRoot,
    receiptPath: path.join(receiptRoot, "receipt.json"),
    stdoutPath,
    stderrPath,
    stdoutFd,
    stderrFd,
    receiptRootIdentity: {
      dev: rootStat.dev,
      ino: rootStat.ino,
    },
    stdoutIdentity: {
      dev: stdoutStat.dev,
      ino: stdoutStat.ino,
    },
    stderrIdentity: {
      dev: stderrStat.dev,
      ino: stderrStat.ino,
    },
  };
}

export function closeQuickOutputFiles(store) {
  closeSync(store.stdoutFd);
  closeSync(store.stderrFd);
}

function outputArtifact(workspaceRoot, filePath) {
  const bytes = readFileSync(filePath);
  return {
    path: path.relative(realpathSync(workspaceRoot), filePath).split(path.sep).join("/"),
    sha256: sha256Bytes(bytes),
    sizeBytes: bytes.byteLength,
  };
}

function assertStorePath(root, filePath, expectedIdentity, expectedType) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || (expectedType === "file" ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error(`Quick receipt store ${expectedType} is not trusted: ${filePath}`);
  }
  if (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino) {
    throw new Error(`Quick receipt store ${expectedType} identity changed: ${filePath}`);
  }
  const resolved = realpathSync(filePath);
  if (!withinRoot(root, resolved)) {
    throw new Error(`Quick receipt store ${expectedType} escapes the workspace: ${filePath}`);
  }
}

function validateQuickReceiptStore(workspaceRoot, store) {
  const root = realpathSync(workspaceRoot);
  assertStorePath(root, store.receiptRoot, store.receiptRootIdentity, "directory");
  assertStorePath(root, store.stdoutPath, store.stdoutIdentity, "file");
  assertStorePath(root, store.stderrPath, store.stderrIdentity, "file");
}

export function persistQuickReceipt({ workspaceRoot, store, receipt }) {
  validateQuickReceiptStore(workspaceRoot, store);
  const complete = {
    ...receipt,
    outputArtifacts: {
      stdout: outputArtifact(workspaceRoot, store.stdoutPath),
      stderr: outputArtifact(workspaceRoot, store.stderrPath),
    },
  };
  atomicWriteJson(store.receiptPath, complete);
  return {
    receipt: complete,
    receiptPath: store.receiptPath,
    receiptSha256: sha256Bytes(readFileSync(store.receiptPath)),
  };
}

export function quickReceiptRoot(workspaceRoot) {
  return path.join(realpathSync(workspaceRoot), ...QUICK_ROOT.split("/"), "receipts");
}
