import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { validateReplayableEvidence } from "./acceptance-evidence.mjs";
import { resolveProfileImpact } from "./profile-impact.mjs";
import {
  assertAllowedKeys,
  isRecord,
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  resolveExistingArtifact,
  safeIdentifier,
  sha256,
  writeJsonAtomically,
  writeJsonExclusive,
} from "./provenance-common.mjs";
import { receiptSha256, validateReceiptLineage } from "./receipt-lineage.mjs";
import { verifySnapshotEvidence, verifySnapshotSourceBinding } from "./snapshot.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import {
  validateVerificationContext,
  verificationContextFingerprint,
} from "./verification-context.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";
import { assertExecutionUnclosed } from "./lease-lifecycle.mjs";

const REQUEST_KEYS = [
  "schemaVersion",
  "receiptId",
  "deliveryPacketPath",
  "verificationContext",
  "snapshotPaths",
];

function changedPaths(packet) {
  const files = packet?.changedFiles?.files ?? packet?.changedFiles?.wholeFileSha256;
  if (!isRecord(files) || Object.keys(files).length === 0) {
    throw new Error("Delivery packet does not declare changed files.");
  }
  return Object.keys(files).sort();
}

function validateRequest(request) {
  assertAllowedKeys(request, "Finalize request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitFinalizeRequestV1") {
    throw new Error("Unsupported finalize request schemaVersion.");
  }
  safeIdentifier(request.receiptId, "receiptId");
  if (typeof request.deliveryPacketPath !== "string" || request.deliveryPacketPath.length === 0) {
    throw new Error("Finalize request requires deliveryPacketPath.");
  }
  if (!Array.isArray(request.snapshotPaths)
    || request.snapshotPaths.length === 0
    || request.snapshotPaths.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Finalize request requires snapshotPaths.");
  }
  const context = validateVerificationContext(request.verificationContext);
  if (!context.valid) throw new Error(`Finalize verification context is invalid: ${context.issues.join("; ")}`);
}

function snapshotCommandReceipt({
  workspaceRoot,
  runId,
  snapshotPath,
  contextFingerprint,
  expectedFiles,
  expectedFingerprint,
}) {
  const absolutePath = resolveExistingArtifact(workspaceRoot, snapshotPath, "snapshotPaths entry");
  const snapshot = readJson(absolutePath);
  if (snapshot.verificationContextFingerprint !== contextFingerprint) {
    throw new Error("Snapshot verification context does not match the finalize request.");
  }
  const validation = verifySnapshotEvidence({ workspaceRoot, runId, snapshot });
  if (!validation.valid) throw new Error(validation.issues.join("; "));
  const sourceBinding = verifySnapshotSourceBinding({ snapshot, expectedFiles, expectedFingerprint });
  if (!sourceBinding.valid) throw new Error(sourceBinding.issues.join("; "));
  const evidenceValidation = validateReplayableEvidence(snapshot.command.evidence);
  if (!evidenceValidation.valid) throw new Error(evidenceValidation.issues.join("; "));
  return {
    id: snapshot.snapshotId,
    evidence: snapshot.command.evidence,
    exitCode: snapshot.command.exitCode,
    stdoutSha256: snapshot.command.stdoutSha256,
    stderrSha256: snapshot.command.stderrSha256,
  };
}

function nextLineage({ lineagePath, receipt }) {
  const nextHash = receiptSha256(receipt);
  if (!existsSync(lineagePath)) {
    return [{ receiptSha256: nextHash, receipt }];
  }
  const existing = readJson(lineagePath);
  const entries = Array.isArray(existing) ? existing : existing.receipts;
  const validation = validateReceiptLineage(entries);
  if (!validation.valid || !validation.active) {
    throw new Error("Existing receipt lineage is invalid.");
  }
  if (validation.active.receipt.status !== "invalidated_by_concurrent_write") {
    throw new Error("A new receipt may only replace an invalidated active receipt.");
  }
  return [
    ...entries,
    {
      receiptSha256: nextHash,
      parentReceiptSha256: validation.active.receiptSha256,
      receipt,
    },
  ];
}

export function runFinalize({ workspaceRoot, runId, request }) {
  validateRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  assertExecutionUnclosed(executionRoot, runId);
  const packetPath = resolveExistingArtifact(
    workspaceRoot,
    request.deliveryPacketPath,
    "deliveryPacketPath",
  );
  const packet = readJson(packetPath);
  if (packet.runId !== runId) throw new Error("Delivery packet runId does not match the execution.");
  const sourceGate = verifyDeliveryPacket({ workspaceRoot, packet });
  if (sourceGate.status !== "valid") {
    return {
      status: sourceGate.status,
      exitCode: sourceGate.exitCode,
      runId,
      issues: sourceGate.issues,
      authorizationGranted: false,
    };
  }
  const profilesDocument = readJson(path.join(workspaceRoot, ".owlcoda/runkit/profiles.json"));
  const profileImpact = resolveProfileImpact({
    changedPaths: changedPaths(packet),
    profiles: profilesDocument.profiles,
  });
  if (profileImpact.decision !== "targeted_profiles") {
    return {
      status: "full_profile_required",
      exitCode: 2,
      runId,
      profileImpact,
      authorizationGranted: false,
    };
  }
  const contextFingerprint = verificationContextFingerprint(request.verificationContext);
  const expectedFiles = packet.changedFiles?.files ?? packet.changedFiles?.wholeFileSha256;
  const commandReceipts = request.snapshotPaths.map((snapshotPath) => snapshotCommandReceipt({
    workspaceRoot,
    runId,
    snapshotPath,
    contextFingerprint,
    expectedFiles,
    expectedFingerprint: sourceGate.recomputedFingerprint,
  }));
  const receipt = {
    schemaVersion: "OwlCodaRunKitVerificationReceiptV2",
    runId,
    receiptId: request.receiptId,
    status: "passed",
    sourceFingerprint: sourceGate.recomputedFingerprint,
    verificationContextFingerprint: contextFingerprint,
    selectedProfileIds: [...profileImpact.profileIds],
    commandRuns: commandReceipts.length,
    commandReceipts,
  };
  const receiptsRoot = path.join(executionRoot, "verification-receipts");
  const outputRoot = path.join(receiptsRoot, request.receiptId);
  const receiptPath = path.join(outputRoot, "verification-receipt.json");
  const lineagePath = path.join(receiptsRoot, "receipt-lineage.json");
  const lineage = nextLineage({ lineagePath, receipt });
  const gateInput = {
    contractVersion: "0.2",
    receipts: lineage,
    sourceGate,
    profileImpact,
    verificationContext: request.verificationContext,
  };
  const gate = validateVerificationReceiptGate(gateInput);
  if (!gate.accepted) {
    throw new Error(`Generated verification gate was not accepted: ${gate.issues.map((item) => item.message).join("; ")}`);
  }
  const sourceGatePath = path.join(outputRoot, "source-gate.json");
  const profileImpactPath = path.join(outputRoot, "profile-impact.json");
  const gateInputPath = path.join(outputRoot, "verification-gate-input.json");
  const gateOutputPath = path.join(outputRoot, "verification-gate-output.json");
  writeJsonExclusive(receiptPath, receipt);
  writeJsonExclusive(sourceGatePath, sourceGate);
  writeJsonExclusive(profileImpactPath, profileImpact);
  writeJsonExclusive(gateInputPath, gateInput);
  writeJsonExclusive(gateOutputPath, gate);
  writeJsonAtomically(lineagePath, lineage);
  return {
    status: gate.decision,
    exitCode: 0,
    runId,
    receiptPath: relativeToWorkspace(workspaceRoot, receiptPath),
    lineagePath: relativeToWorkspace(workspaceRoot, lineagePath),
    gateInputPath: relativeToWorkspace(workspaceRoot, gateInputPath),
    gateOutputPath: relativeToWorkspace(workspaceRoot, gateOutputPath),
    activeReceiptSha256: gate.activeReceiptSha256,
    authorizationGranted: false,
  };
}
