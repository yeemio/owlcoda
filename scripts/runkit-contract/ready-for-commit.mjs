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
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonExclusive,
} from "./provenance-common.mjs";
import { resolveProfileImpactProjection } from "./profile-impact.mjs";
import { verifySnapshotEvidence, verifySnapshotFreshness } from "./snapshot.mjs";
import { verifySourceCandidateV2 } from "./source-candidate.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";

const REQUEST_KEYS_V1 = [
  "schemaVersion",
  "deliveryPacketPath",
  "verificationGateInputPath",
  "roots",
];
const REQUEST_KEYS_V2 = [
  ...REQUEST_KEYS_V1,
  "sourceCandidatePath",
];
const RECEIPT_COMMON_KEYS = [
  "schemaVersion",
  "runId",
  "status",
  "sourceFingerprint",
  "activeReceiptSha256",
  "verificationGateInputPath",
  "verificationGateInputSha256",
  "closeoutReceiptPath",
  "closeoutReceiptSha256",
  "releasedLeaseIds",
  "roots",
  "repositoryActions",
  "authorizationGranted",
];
const RECEIPT_ROOT_KEYS = [
  "role",
  "snapshotPath",
  "snapshotSha256",
  "targetRoot",
  "head",
  "manifestFingerprint",
];
const RECEIPT_SOURCE_ARTIFACT_KEYS = [
  "kind",
  "path",
  "sha256",
  "sourceFingerprint",
];
const PLAIN_SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function exactFalseRepositoryActions(value) {
  const expected = repositoryActionsFalse();
  return isRecord(value)
    && Object.keys(value).length === Object.keys(expected).length
    && Object.keys(expected).every((key) => value[key] === false);
}

export function validateReadyForCommitReceipt(receipt) {
  const v1 = receipt?.schemaVersion
    === "OwlCodaRunKitReadyForCommitReceiptV1";
  const v2 = receipt?.schemaVersion
    === "OwlCodaRunKitReadyForCommitReceiptV2";
  if (!v1 && !v2) {
    throw new Error(
      "Ready-for-commit receipt has an unsupported schemaVersion.",
    );
  }
  assertAllowedKeys(
    receipt,
    "Ready-for-commit receipt",
    v1
      ? [...RECEIPT_COMMON_KEYS, "deliveryPacketPath", "deliveryPacketSha256"]
      : [...RECEIPT_COMMON_KEYS, "sourceArtifact"],
  );
  if (
    safeIdentifier(receipt.runId, "Ready-for-commit receipt runId")
      !== receipt.runId
    || receipt.status !== "ready_for_commit"
    || !PLAIN_SHA256.test(receipt.sourceFingerprint ?? "")
    || !PLAIN_SHA256.test(receipt.activeReceiptSha256 ?? "")
    || !PLAIN_SHA256.test(receipt.verificationGateInputSha256 ?? "")
    || !PLAIN_SHA256.test(receipt.closeoutReceiptSha256 ?? "")
    || receipt.authorizationGranted !== false
    || !exactFalseRepositoryActions(receipt.repositoryActions)
  ) {
    throw new Error("Ready-for-commit receipt common fields are invalid.");
  }
  safeRelativePath(
    receipt.verificationGateInputPath,
    "Ready-for-commit receipt verificationGateInputPath",
  );
  safeRelativePath(
    receipt.closeoutReceiptPath,
    "Ready-for-commit receipt closeoutReceiptPath",
  );
  if (
    !Array.isArray(receipt.releasedLeaseIds)
    || receipt.releasedLeaseIds.length === 0
    || new Set(receipt.releasedLeaseIds).size
      !== receipt.releasedLeaseIds.length
    || receipt.releasedLeaseIds.some((workItemId) => {
      try {
        return safeIdentifier(
          workItemId,
          "Ready-for-commit receipt released lease",
        ) !== workItemId;
      } catch {
        return true;
      }
    })
    || JSON.stringify(receipt.releasedLeaseIds)
      !== JSON.stringify([...receipt.releasedLeaseIds].sort())
  ) {
    throw new Error("Ready-for-commit receipt released leases are invalid.");
  }
  if (!Array.isArray(receipt.roots) || receipt.roots.length === 0) {
    throw new Error("Ready-for-commit receipt roots are invalid.");
  }
  const roles = new Set();
  for (const root of receipt.roots) {
    assertAllowedKeys(root, "Ready-for-commit receipt root", RECEIPT_ROOT_KEYS);
    if (
      typeof root.role !== "string"
      || root.role.length === 0
      || roles.has(root.role)
      || !PLAIN_SHA256.test(root.snapshotSha256 ?? "")
      || !path.isAbsolute(root.targetRoot ?? "")
      || !GIT_OBJECT_ID.test(root.head ?? "")
      || !PLAIN_SHA256.test(root.manifestFingerprint ?? "")
    ) {
      throw new Error("Ready-for-commit receipt root is invalid.");
    }
    safeRelativePath(
      root.snapshotPath,
      "Ready-for-commit receipt root snapshotPath",
    );
    roles.add(root.role);
  }
  if (!roles.has("candidate")) {
    throw new Error(
      "Ready-for-commit receipt requires a candidate root.",
    );
  }
  if (v1) {
    safeRelativePath(
      receipt.deliveryPacketPath,
      "Ready-for-commit receipt deliveryPacketPath",
    );
    if (!PLAIN_SHA256.test(receipt.deliveryPacketSha256 ?? "")) {
      throw new Error(
        "Ready-for-commit receipt delivery packet hash is invalid.",
      );
    }
  } else {
    assertAllowedKeys(
      receipt.sourceArtifact,
      "Ready-for-commit receipt sourceArtifact",
      RECEIPT_SOURCE_ARTIFACT_KEYS,
    );
    if (
      !["delivery_packet_v1", "source_candidate_v2"]
        .includes(receipt.sourceArtifact.kind)
      || !PLAIN_SHA256.test(receipt.sourceArtifact.sha256 ?? "")
      || !PLAIN_SHA256.test(
        receipt.sourceArtifact.sourceFingerprint ?? "",
      )
    ) {
      throw new Error(
        "Ready-for-commit receipt sourceArtifact is invalid.",
      );
    }
    safeRelativePath(
      receipt.sourceArtifact.path,
      "Ready-for-commit receipt sourceArtifact path",
    );
  }
  return { v1, v2 };
}

function deliveryPacketChangedPaths(packet) {
  const files = packet?.changedFiles?.files ?? packet?.changedFiles?.wholeFileSha256;
  if (!isRecord(files) || Object.keys(files).length === 0) {
    throw new Error("Delivery packet does not declare changed files.");
  }
  return Object.keys(files).sort();
}

function sourceCandidateChangedPaths(candidate) {
  const entries = candidate?.sourceManifest?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Source candidate does not declare changed files.");
  }
  return [...new Set(entries.flatMap((entry) => (
    entry.previousPath ? [entry.path, entry.previousPath] : [entry.path]
  )))].sort();
}

function validateRequest(request) {
  const v1 = request.schemaVersion === "OwlCodaRunKitReadyForCommitRequestV1";
  const v2 = request.schemaVersion === "OwlCodaRunKitReadyForCommitRequestV2";
  if (!v1 && !v2) {
    throw new Error("Unsupported ready-for-commit request schemaVersion.");
  }
  assertAllowedKeys(
    request,
    "Ready-for-commit request",
    v1 ? REQUEST_KEYS_V1 : REQUEST_KEYS_V2,
  );
  const hasDeliveryPacket = typeof request.deliveryPacketPath === "string"
    && request.deliveryPacketPath.length > 0;
  const hasSourceCandidate = typeof request.sourceCandidatePath === "string"
    && request.sourceCandidatePath.length > 0;
  if (v1 && !hasDeliveryPacket) {
    throw new Error("Ready-for-commit request requires deliveryPacketPath.");
  }
  if (v2 && hasDeliveryPacket === hasSourceCandidate) {
    throw new Error(
      "Ready-for-commit V2 requires exactly one deliveryPacketPath or sourceCandidatePath.",
    );
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
  return { v1, v2, hasDeliveryPacket, hasSourceCandidate };
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

function sameSourceArtifact(left, right) {
  return left?.kind === right.kind
    && left?.runId === right.runId
    && left?.path === right.path
    && left?.sha256 === right.sha256
    && left?.sourceFingerprint === right.sourceFingerprint;
}

function verifyCloseout({
  executionRoot,
  runId,
  gateInputBytes,
  gate,
  sourceArtifact,
  requireSourceArtifact,
}) {
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
  if (
    requireSourceArtifact
    && !sameSourceArtifact(payload.verification?.sourceArtifact, sourceArtifact)
  ) {
    throw new Error("Closeout source artifact does not match the requested source.");
  }
  return { closeoutPath, closeout };
}

function loadReadySource({ workspaceRoot, runId, request, requestVersion }) {
  if (request.deliveryPacketPath !== undefined) {
    const sourcePath = resolveExistingArtifact(
      workspaceRoot,
      request.deliveryPacketPath,
      "deliveryPacketPath",
    );
    const source = readJson(sourcePath);
    if (source.runId !== runId) {
      throw new Error("Delivery packet runId does not match the execution.");
    }
    const sourceGate = verifyDeliveryPacket({ workspaceRoot, packet: source });
    return {
      source,
      sourcePath,
      sourceGate,
      changedPaths: deliveryPacketChangedPaths(source),
      sourceArtifact: {
        kind: "delivery_packet_v1",
        runId,
        path: request.deliveryPacketPath,
        sha256: sha256(readFileSync(sourcePath)),
        sourceFingerprint: sourceGate.recomputedFingerprint,
      },
      legacyV1: requestVersion.v1,
    };
  }

  const sourcePath = resolveExistingArtifact(
    workspaceRoot,
    request.sourceCandidatePath,
    "sourceCandidatePath",
  );
  const source = readJson(sourcePath);
  if (source.runId !== runId) {
    throw new Error("Source candidate runId does not match the execution.");
  }
  const candidateGate = verifySourceCandidateV2({
    workspaceRoot,
    candidatePath: request.sourceCandidatePath,
  });
  return {
    source,
    sourcePath,
    sourceGate: {
      status: candidateGate.status,
      exitCode: candidateGate.exitCode,
      recomputedFingerprint: candidateGate.sourceFingerprint,
      issues: candidateGate.issueCodes ?? [],
    },
    changedPaths: sourceCandidateChangedPaths(source),
    sourceArtifact: {
      kind: "source_candidate_v2",
      runId,
      path: request.sourceCandidatePath,
      sha256: sha256(readFileSync(sourcePath)),
      sourceFingerprint: candidateGate.sourceFingerprint,
    },
    legacyV1: false,
  };
}

export function runReadyForCommit({ workspaceRoot, runId, request }) {
  const requestVersion = validateRequest(request);
  const { executionRoot, pinGate } = loadActiveExecution(workspaceRoot, runId);
  if (pinGate.status !== "valid") return pinGate;
  const sourceBinding = loadReadySource({
    workspaceRoot,
    runId,
    request,
    requestVersion,
  });
  const sourceGate = sourceBinding.sourceGate;
  if (sourceGate.status !== "valid") {
    return {
      status: sourceGate.status,
      exitCode: sourceGate.exitCode,
      runId,
      issues: sourceGate.issues ?? [],
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
  if (
    requestVersion.v2
    && !sameSourceArtifact(
      gate.lineage.active.receipt.sourceArtifact,
      sourceBinding.sourceArtifact,
    )
  ) {
    throw new Error(
      "Verification gate source artifact does not match the requested source.",
    );
  }
  const profiles = readJson(path.join(workspaceRoot, ".owlcoda/runkit/profiles.json")).profiles;
  const detailedProfileImpact = isRecord(gateInput.profileImpact)
    && ("directProfileIds" in gateInput.profileImpact
      || "transitiveProfileIds" in gateInput.profileImpact);
  const currentProfileImpact = resolveProfileImpactProjection({
    changedPaths: sourceBinding.changedPaths,
    profiles,
    detailed: detailedProfileImpact,
  });
  if (JSON.stringify(currentProfileImpact) !== JSON.stringify(gateInput.profileImpact)) {
    throw new Error("Verification profile impact is stale.");
  }
  const releasedLeaseIds = verifyReleasedLeases(executionRoot);
  const { closeoutPath } = verifyCloseout({
    executionRoot,
    runId,
    gateInputBytes,
    gate,
    sourceArtifact: sourceBinding.sourceArtifact,
    requireSourceArtifact: requestVersion.v2,
  });
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
  const commonReceipt = {
    runId,
    status: "ready_for_commit",
    sourceFingerprint: sourceGate.recomputedFingerprint,
    activeReceiptSha256: gate.activeReceiptSha256,
    verificationGateInputPath: request.verificationGateInputPath,
    verificationGateInputSha256: sha256(gateInputBytes),
    closeoutReceiptPath: relativeToWorkspace(workspaceRoot, closeoutPath),
    closeoutReceiptSha256: sha256(readFileSync(closeoutPath)),
    releasedLeaseIds,
    roots,
    repositoryActions: repositoryActionsFalse(),
    authorizationGranted: false,
  };
  const receipt = requestVersion.v1
    ? {
        schemaVersion: "OwlCodaRunKitReadyForCommitReceiptV1",
        ...commonReceipt,
        deliveryPacketPath: request.deliveryPacketPath,
        deliveryPacketSha256: sourceBinding.sourceArtifact.sha256,
      }
    : {
        schemaVersion: "OwlCodaRunKitReadyForCommitReceiptV2",
        ...commonReceipt,
        sourceArtifact: {
          kind: sourceBinding.sourceArtifact.kind,
          path: sourceBinding.sourceArtifact.path,
          sha256: sourceBinding.sourceArtifact.sha256,
          sourceFingerprint: sourceBinding.sourceArtifact.sourceFingerprint,
        },
      };
  validateReadyForCommitReceipt(receipt);
  writeJsonExclusive(readyPath, receipt);
  return {
    status: "ready_for_commit",
    exitCode: 0,
    runId,
    readyReceiptPath: relativeToWorkspace(workspaceRoot, readyPath),
    authorizationGranted: false,
  };
}
