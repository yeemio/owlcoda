import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { validateCoreArtifact } from "./core-contract.mjs";
import {
  assertAllowedKeys,
  isRecord,
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  repositoryActionsFalse,
  resolveExistingArtifact,
  sha256,
  writeJsonExclusive,
} from "./provenance-common.mjs";
import { resolveProfileImpact } from "./profile-impact.mjs";
import { verifySnapshotEvidence, verifySnapshotFreshness } from "./snapshot.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";

const REQUEST_KEYS = [
  "schemaVersion",
  "deliveryPacketPath",
  "verificationGateInputPath",
  "roots",
];

function changedPaths(packet) {
  const files = packet?.changedFiles?.files ?? packet?.changedFiles?.wholeFileSha256;
  if (!isRecord(files) || Object.keys(files).length === 0) {
    throw new Error("Delivery packet does not declare changed files.");
  }
  return Object.keys(files).sort();
}

function validateRequest(request) {
  assertAllowedKeys(request, "Ready-for-commit request", REQUEST_KEYS);
  if (request.schemaVersion !== "OwlCodaRunKitReadyForCommitRequestV1") {
    throw new Error("Unsupported ready-for-commit request schemaVersion.");
  }
  if (typeof request.deliveryPacketPath !== "string" || request.deliveryPacketPath.length === 0) {
    throw new Error("Ready-for-commit request requires deliveryPacketPath.");
  }
  if (typeof request.verificationGateInputPath !== "string" || request.verificationGateInputPath.length === 0) {
    throw new Error("Ready-for-commit request requires verificationGateInputPath.");
  }
  if (!Array.isArray(request.roots) || request.roots.length === 0) {
    throw new Error("Ready-for-commit request requires roots.");
  }
  const roles = new Set();
  for (const root of request.roots) {
    if (!isRecord(root)
      || typeof root.role !== "string"
      || root.role.length === 0
      || typeof root.snapshotPath !== "string"
      || root.snapshotPath.length === 0) {
      throw new Error("Each ready root requires role and snapshotPath.");
    }
    if (roles.has(root.role)) throw new Error(`Duplicate ready root role: ${root.role}`);
    roles.add(root.role);
  }
  if (!roles.has("candidate")) throw new Error("Ready-for-commit requires a candidate root snapshot.");
}

function verifyReleasedLeases(executionRoot) {
  const leasesRoot = path.join(executionRoot, "leases");
  const leases = readdirSync(leasesRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => readJson(path.join(leasesRoot, entry.name)));
  if (leases.length === 0) throw new Error("Ready-for-commit requires at least one released lease.");
  if (leases.some((lease) => lease.state !== "released")) {
    throw new Error("Ready-for-commit is not allowed while an active lease remains.");
  }
  return leases.map((lease) => lease.workItemId).sort();
}

function verifyCloseout({ executionRoot, runId, gateInputBytes, gate }) {
  const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
  if (!existsSync(closeoutPath)) throw new Error("Accepted closeout receipt is required.");
  const closeout = readJson(closeoutPath);
  const artifactGate = validateCoreArtifact(closeout.artifact);
  if (!artifactGate.valid) throw new Error(artifactGate.issues.join("; "));
  if (closeout.acceptanceSha256 !== artifactGate.acceptanceSha256
    || closeout.artifactSha256 !== artifactGate.artifactSha256) {
    throw new Error("Closeout artifact hashes are invalid.");
  }
  const payload = closeout.artifact.payload;
  if (payload.runId !== runId || payload.decision !== "accepted") {
    throw new Error("Closeout does not accept the current execution.");
  }
  if (payload.authorizationGranted !== false) throw new Error("Closeout authorization must remain false.");
  if (payload.verification?.gateInputSha256 !== sha256(gateInputBytes)) {
    throw new Error("Closeout gate input hash does not match the requested gate input.");
  }
  if (payload.verification?.activeReceiptSha256 !== gate.activeReceiptSha256) {
    throw new Error("Closeout active receipt does not match the current verification gate.");
  }
  return { closeoutPath, closeout };
}

export function runReadyForCommit({ workspaceRoot, runId, request }) {
  validateRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  const packetPath = resolveExistingArtifact(workspaceRoot, request.deliveryPacketPath, "deliveryPacketPath");
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
  const gateInputPath = resolveExistingArtifact(
    workspaceRoot,
    request.verificationGateInputPath,
    "verificationGateInputPath",
  );
  const gateInputBytes = readFileSync(gateInputPath);
  const gateInput = JSON.parse(gateInputBytes.toString("utf8"));
  const gate = validateVerificationReceiptGate(gateInput);
  if (!gate.accepted || gate.lineage.active.receipt.runId !== runId) {
    throw new Error("Verification gate does not accept the current execution.");
  }
  if (gate.sourceFingerprint !== sourceGate.recomputedFingerprint) {
    throw new Error("Verification gate source fingerprint is stale.");
  }
  const profiles = readJson(path.join(workspaceRoot, ".owlcoda/runkit/profiles.json")).profiles;
  const currentProfileImpact = resolveProfileImpact({ changedPaths: changedPaths(packet), profiles });
  if (JSON.stringify(currentProfileImpact) !== JSON.stringify(gateInput.profileImpact)) {
    throw new Error("Verification profile impact is stale.");
  }
  const releasedLeaseIds = verifyReleasedLeases(executionRoot);
  const { closeoutPath } = verifyCloseout({ executionRoot, runId, gateInputBytes, gate });
  const roots = request.roots.map((root) => {
    const snapshotPath = resolveExistingArtifact(workspaceRoot, root.snapshotPath, "root snapshotPath");
    const snapshot = readJson(snapshotPath);
    const evidence = verifySnapshotEvidence({ workspaceRoot, runId, snapshot });
    if (!evidence.valid) throw new Error(evidence.issues.join("; "));
    const freshness = verifySnapshotFreshness(snapshot);
    if (!freshness.valid) throw new Error(freshness.issues.join("; "));
    return {
      role: root.role,
      snapshotPath: root.snapshotPath,
      snapshotSha256: sha256(readFileSync(snapshotPath)),
      targetRoot: snapshot.targetRoot,
      head: freshness.current.head,
      manifestFingerprint: freshness.current.manifestFingerprint,
    };
  });
  const readyPath = path.join(executionRoot, "READY_FOR_COMMIT_RECEIPT.json");
  const receipt = {
    schemaVersion: "OwlCodaRunKitReadyForCommitReceiptV1",
    runId,
    status: "ready_for_commit",
    sourceFingerprint: sourceGate.recomputedFingerprint,
    activeReceiptSha256: gate.activeReceiptSha256,
    verificationGateInputPath: request.verificationGateInputPath,
    verificationGateInputSha256: sha256(gateInputBytes),
    deliveryPacketPath: request.deliveryPacketPath,
    deliveryPacketSha256: sha256(readFileSync(packetPath)),
    closeoutReceiptPath: relativeToWorkspace(workspaceRoot, closeoutPath),
    closeoutReceiptSha256: sha256(readFileSync(closeoutPath)),
    releasedLeaseIds,
    roots,
    repositoryActions: repositoryActionsFalse(),
    authorizationGranted: false,
  };
  writeJsonExclusive(readyPath, receipt);
  return {
    status: "ready_for_commit",
    exitCode: 0,
    runId,
    readyReceiptPath: relativeToWorkspace(workspaceRoot, readyPath),
    authorizationGranted: false,
  };
}
