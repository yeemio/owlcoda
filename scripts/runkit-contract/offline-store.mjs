import { randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  canonicalJson,
  sha256Bytes,
} from "../../packages/attest/src/formal.mjs";
import {
  createOfflineAttestationBundle,
  parseOfflineAttestationBundle,
} from "../../packages/attest/src/offline-bundle.mjs";

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function existingPathWithoutSymlinks(selectedPath, expectedType) {
  const absolute = path.resolve(selectedPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  try {
    const rootStat = lstatSync(current);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) return null;
      const isLeaf = index === segments.length - 1;
      if (!isLeaf && !stat.isDirectory()) return null;
      if (isLeaf && expectedType === "directory" && !stat.isDirectory()) return null;
      if (isLeaf && expectedType === "file" && !stat.isFile()) return null;
    }
    return realpathSync(absolute);
  } catch {
    return null;
  }
}

function safeReceiptPath(workspaceRoot, receiptPath) {
  const root = existingPathWithoutSymlinks(workspaceRoot, "directory");
  const candidate = existingPathWithoutSymlinks(receiptPath, "file");
  return root !== null && candidate !== null && withinRoot(root, candidate)
    ? candidate
    : null;
}

function writeBytesExclusiveAtomically(targetPath, bytes) {
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    linkSync(temporaryPath, targetPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function ensureStoreReceiptRoot(storeRoot, receiptId) {
  if (!/^[A-Za-z0-9._-]+$/.test(receiptId)) {
    throw new Error("offline receipt id is not path-safe");
  }
  const root = existingPathWithoutSymlinks(storeRoot, "directory");
  if (root === null) return null;
  let current = root;
  for (const segment of ["quick", "receipts", receiptId]) {
    current = path.join(current, segment);
    let currentStat = null;
    try {
      currentStat = lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      mkdirSync(current, { mode: 0o700 });
      currentStat = lstatSync(current);
    }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory()) return null;
    if (realpathSync(current) !== current) return null;
    if (existingPathWithoutSymlinks(current, "directory") !== current) return null;
  }
  return withinRoot(root, current) ? current : null;
}

export function exportOfflineReceipt({
  workspaceRoot,
  receiptPath,
  outputPath,
}) {
  const receipt = safeReceiptPath(workspaceRoot, receiptPath);
  if (receipt === null) {
    return {
      status: "offline_receipt_invalid",
      exitCode: 3,
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  const requestedOutput = path.resolve(outputPath);
  try {
    const existing = lstatSync(requestedOutput);
    return {
      status: existing.isSymbolicLink() ? "offline_output_invalid" : "offline_output_exists",
      exitCode: existing.isSymbolicLink() ? 3 : 1,
      outputPath: requestedOutput,
      authorizationGranted: false,
      networkRequests: 0,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        status: "offline_output_invalid",
        exitCode: 3,
        outputPath: requestedOutput,
        authorizationGranted: false,
        networkRequests: 0,
      };
    }
  }
  const parent = existingPathWithoutSymlinks(path.dirname(requestedOutput), "directory");
  if (parent === null) {
    return {
      status: "offline_output_invalid",
      exitCode: 3,
      outputPath: requestedOutput,
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  const output = path.join(parent, path.basename(requestedOutput));
  const bundle = createOfflineAttestationBundle(receipt);
  const bundleBytes = Buffer.from(`${canonicalJson(bundle)}\n`);
  writeBytesExclusiveAtomically(output, bundleBytes);
  return {
    status: "offline_bundle_exported",
    exitCode: 0,
    outputPath: output,
    bundleSha256: sha256Bytes(bundleBytes),
    reference: bundle.reference,
    authorizationGranted: false,
    networkRequests: 0,
  };
}

export function importOfflineReceipt({
  workspaceRoot,
  bundlePath,
  storeRoot,
}) {
  if (existingPathWithoutSymlinks(workspaceRoot, "directory") === null) {
    return {
      status: "offline_workspace_invalid",
      exitCode: 3,
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  const bundle = existingPathWithoutSymlinks(bundlePath, "file");
  if (bundle === null) {
    return {
      status: "offline_bundle_invalid",
      exitCode: 3,
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  const parsed = parseOfflineAttestationBundle(readFileSync(bundle, "utf8"));
  const receiptRoot = ensureStoreReceiptRoot(storeRoot, parsed.reference.receiptId);
  if (receiptRoot === null) {
    return {
      status: "offline_store_invalid",
      exitCode: 3,
      reference: parsed.reference,
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  const receiptPath = path.join(receiptRoot, "receipt.json");
  let existingReceiptStat = null;
  try {
    existingReceiptStat = lstatSync(receiptPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return {
        status: "offline_store_invalid",
        exitCode: 3,
        reference: parsed.reference,
        authorizationGranted: false,
        networkRequests: 0,
      };
    }
  }
  if (existingReceiptStat !== null) {
    if (
      existingReceiptStat.isSymbolicLink()
      || !existingReceiptStat.isFile()
      || existingPathWithoutSymlinks(receiptPath, "file") !== receiptPath
    ) {
      return {
        status: "offline_store_invalid",
        exitCode: 3,
        reference: parsed.reference,
        authorizationGranted: false,
        networkRequests: 0,
      };
    }
    const existing = readFileSync(receiptPath);
    if (!existing.equals(parsed.receiptBytes)) {
      return {
        status: "offline_store_conflict",
        exitCode: 1,
        receiptPath,
        reference: parsed.reference,
        authorizationGranted: false,
        networkRequests: 0,
      };
    }
    return {
      status: "offline_receipt_already_present",
      exitCode: 0,
      receiptPath,
      receiptSha256: sha256Bytes(existing),
      reference: parsed.reference,
      authorizationGranted: false,
      networkRequests: 0,
    };
  }
  writeBytesExclusiveAtomically(receiptPath, parsed.receiptBytes);
  return {
    status: "offline_receipt_imported",
    exitCode: 0,
    receiptPath,
    receiptSha256: sha256Bytes(parsed.receiptBytes),
    reference: parsed.reference,
    authorizationGranted: false,
    networkRequests: 0,
  };
}
