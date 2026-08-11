import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { attestQuickReceipt } from "./quick-attest.mjs";
import { quickReceiptRoot } from "./quick-receipt.mjs";

function trustedReceiptRoot(workspaceRoot) {
  const workspace = realpathSync(workspaceRoot);
  const root = quickReceiptRoot(workspace);
  let current = workspace;
  for (const segment of path.relative(workspace, root).split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) return { status: "missing", root };
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { status: "invalid", root };
    const resolved = realpathSync(current);
    const remainder = path.relative(workspace, resolved);
    if (remainder === "" || remainder === ".."
      || remainder.startsWith(`..${path.sep}`) || path.isAbsolute(remainder)) {
      return { status: "invalid", root };
    }
  }
  return { status: "valid", root };
}

export function readLocalQuickMetrics(workspaceRoot) {
  const selected = trustedReceiptRoot(workspaceRoot);
  if (selected.status === "invalid") {
    return {
      status: "quick_receipt_store_invalid",
      exitCode: 3,
      schemaVersion: "OwlCodaRunKitLocalMetricsV1",
      telemetry: false,
      networkRequests: 0,
      inputs: [],
      quick: {
        total: 0,
        passed: 0,
        failed: 0,
        sourceMutated: 0,
        invalid: 0,
      },
      issueCodes: ["quick_receipt_store_invalid"],
      authorizationGranted: false,
    };
  }
  const receiptPaths = selected.status === "valid"
    ? readdirSync(selected.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => path.join(selected.root, entry.name, "receipt.json"))
      .filter(existsSync)
      .sort()
    : [];
  const totals = {
    total: receiptPaths.length,
    passed: 0,
    failed: 0,
    sourceMutated: 0,
    invalid: 0,
  };
  for (const receiptPath of receiptPaths) {
    try {
      const result = attestQuickReceipt({ receiptPath, workspaceRoot });
      if (result.decision === "GO") totals.passed += 1;
      else if (result.issueCodes.includes("receipt_source_mismatch")) totals.sourceMutated += 1;
      else totals.failed += 1;
    } catch {
      totals.invalid += 1;
    }
  }
  return {
    status: "local_metrics",
    exitCode: 0,
    schemaVersion: "OwlCodaRunKitLocalMetricsV1",
    telemetry: false,
    networkRequests: 0,
    inputs: receiptPaths,
    quick: totals,
    authorizationGranted: false,
  };
}
