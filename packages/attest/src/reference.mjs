import {
  existsSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { sha256Bytes } from "./formal.mjs";
import { attestQuickReceiptDetailsFromBytes } from "./quick.mjs";
import {
  createAttestationRef,
  parseAttestationRef,
  readQuickReceiptFile,
  referenceError,
} from "./reference-contract.mjs";

export {
  createAttestationRef,
  parseAttestationRef,
} from "./reference-contract.mjs";

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function safeQuickCandidate(store, receiptId) {
  if (!/^[A-Za-z0-9._-]+$/.test(receiptId)) return null;
  const rootStat = lstatSync(store);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  const root = realpathSync(store);
  const segments = ["quick", "receipts", receiptId, "receipt.json"];
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!existsSync(current)) return null;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) return null;
    if (segment === "receipt.json" ? !stat.isFile() : !stat.isDirectory()) return null;
  }
  const resolved = realpathSync(current);
  return withinRoot(root, resolved) ? resolved : null;
}

function issue(code) {
  return { code };
}

export function resolveAttestationRef({ reference, stores, workspaceRoot }) {
  const parsed = parseAttestationRef(reference);
  if (!Array.isArray(stores) || stores.length === 0) {
    throw referenceError("at least one explicit local store is required");
  }
  const candidates = [];
  for (const selectedStore of stores) {
    if (typeof selectedStore !== "string" || selectedStore.length === 0) {
      throw referenceError("store paths must be non-empty strings");
    }
    try {
      const candidate = safeQuickCandidate(selectedStore, parsed.receiptId);
      if (candidate !== null) candidates.push(candidate);
    } catch {
      continue;
    }
  }
  const base = {
    schemaVersion: "OwlCodaAttestationResolutionV1",
    reference: parsed,
    authorizationGranted: false,
    networkRequests: 0,
  };
  if (candidates.length === 0) {
    return {
      ...base,
      status: "not_found",
      exitCode: 3,
      issueCodes: ["attestation_target_not_found"],
      candidates: [],
    };
  }
  if (candidates.length > 1) {
    return {
      ...base,
      status: "ambiguous",
      exitCode: 1,
      issueCodes: ["attestation_target_ambiguous"],
      candidates,
    };
  }

  const candidate = candidates[0];
  const { bytes, receipt } = readQuickReceiptFile(candidate);
  const actualHash = sha256Bytes(bytes);
  const identityValid = receipt.receiptId === parsed.receiptId
    && receipt.coreIdentity.contractVersion === parsed.coreIdentity.contractVersion
    && receipt.coreIdentity.coreManifestSha256 === parsed.coreIdentity.coreManifestSha256;
  if (actualHash !== parsed.receiptSha256 || !identityValid) {
    return {
      ...base,
      status: "resolved_invalid",
      exitCode: 1,
      issueCodes: [
        ...(actualHash === parsed.receiptSha256 ? [] : ["receipt_material_hash_mismatch"]),
        ...(identityValid ? [] : ["core_identity_mismatch"]),
      ],
      candidates,
    };
  }
  const details = attestQuickReceiptDetailsFromBytes({
    receiptPath: candidate,
    receiptBytes: bytes,
    workspaceRoot,
  });
  return {
    ...base,
    status: details.attestation.decision === "GO"
      ? "resolved_valid"
      : details.attestation.decision === "INDETERMINATE"
        ? "resolved_indeterminate"
        : "resolved_invalid",
    exitCode: details.attestation.decision === "GO" ? 0 : details.attestation.decision === "INDETERMINATE" ? 3 : 1,
    issueCodes: details.attestation.issueCodes,
    candidates,
    receiptPath: candidate,
    receiptSha256: actualHash,
    attestation: details.attestation,
  };
}
