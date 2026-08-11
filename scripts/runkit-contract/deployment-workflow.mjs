import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import {
  assertAllowedKeys,
  relativeToWorkspace,
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";
import {
  RUNTIME_ROOT,
  acceptedCloseoutVerificationIssues,
  createCoreArtifact,
  currentCoreIdentity,
  validateCoreArtifact,
  validateExecutionPin,
} from "./core-contract.mjs";
import { collapseByteIdenticalDeliveryCandidates } from "./delivery-selection.mjs";
import {
  acquireLeaseWithinControlTransaction,
  listLeaseArtifacts,
  releaseLeaseWithinControlTransaction,
  withControlTransaction,
} from "./lease-lifecycle.mjs";
import {
  ownerAuthorityArtifactSha256V1,
  verifyTrustedOwnerAuthorityV1,
} from "./owner-authority-trust.mjs";
import {
  compileOwnerDeploymentDecisionV1,
  createDeploymentSupersessionStatusV1,
  ownerDeploymentDecisionBindingV1,
  validateOwnerDeploymentDecisionBindingV1,
  validateOwnerDeploymentDecisionV1,
} from "./owner-deployment-decision.mjs";
import {
  canonicalRemoteDeploymentIntentSha256,
  validateRemoteTarget,
} from "./remote-deployment.mjs";
import {
  buildResourcePreflight,
  summarizeResourcePreflight,
} from "./resource-preflight.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import { verifySourceCandidateV2 } from "./source-candidate.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const PREPARE_INPUT_KEYS = [
  "prepareRunId",
  "prepareGoal",
  "trustedAcceptedCloseout",
  "deliveryPacket",
  "sourceArtifact",
  "artifact",
  "ownerDecision",
];
const GOAL_KEYS = ["path", "sha256"];
const CLOSEOUT_KEYS = [
  "trusted",
  "decision",
  "runId",
  "path",
  "sha256",
  "gateInputSha256",
  "sourceFingerprint",
  "sourceArtifact",
  "authorizationGranted",
];
const PACKET_KEYS = ["runId", "path", "sha256", "sourceFingerprint"];
const SOURCE_ARTIFACT_KEYS = [
  "kind",
  "runId",
  "path",
  "sha256",
  "sourceFingerprint",
];
const ARTIFACT_KEYS = ["path", "sha256", "size", "mediaType"];
const EXECUTE_REQUEST_KEYS = [
  "schemaVersion",
  "executeRunId",
  "executeGoal",
  "prepareReceiptSha256",
  "target",
  "ownerAuthority",
  "ownerDecision",
  "ownerDecisionSnapshot",
  "workItemId",
  "profileId",
  "resourcePreflight",
  "deploy",
  "destructive",
];
const AUTHORITY_KEYS = [
  "authorityId",
  "path",
  "sha256",
  "signerKeyId",
  "trustStoreSha256",
  "remoteManifestFileSha256",
  "remoteDeploymentIntentSha256",
  "targetSha256",
  "artifactSha256",
  "ownerDecisionId",
  "ownerDecisionSha256",
  "permissions",
];
const AUTHORITY_DESCRIPTOR_KEYS = ["path", "sha256"];
const OWNER_DEPLOYMENT_AUTHORITY_KEYS = [
  "schemaVersion",
  "authorityId",
  "decision",
  "scope",
  "executeRunId",
  "prepareReceiptSha256",
  "targetSha256",
  "artifactSha256",
  "remoteManifestFileSha256",
  "remoteDeploymentIntentSha256",
  "ownerDecisionId",
  "ownerDecisionSha256",
  "signerKeyId",
  "signatureAlgorithm",
  "permissions",
  "authorizationGranted",
  "authoritySha256",
  "signature",
];
const PERMISSION_KEYS = ["deploy", "destructive"];
const OWNER_DECISION_DESCRIPTOR_KEYS = ["path", "sha256"];

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Deployment workflow value is not canonical JSON.");
  return encoded;
}

function hashObject(value) {
  return sha256(Buffer.from(canonicalJson(value), "utf8"));
}

function canonicalWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("Deployment prepare workspaceRoot is required.");
  }
  const requested = path.resolve(workspaceRoot);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Deployment prepare workspace must be a regular directory.");
  }
  return realpathSync(requested);
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function readRegularFile(root, relativePath, label) {
  const safePath = safeRelativePath(relativePath, `${label} path`);
  const absolutePath = path.resolve(root, safePath);
  if (!within(root, absolutePath)) throw new Error(`${label} escapes the workspace.`);
  let current = root;
  for (const segment of safePath.split("/")) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symlink.`);
  }
  const stat = lstatSync(absolutePath);
  if (!stat.isFile() || realpathSync(absolutePath) !== absolutePath) {
    throw new Error(`${label} must be a regular file.`);
  }
  return {
    absolutePath,
    relativePath: safePath,
    bytes: readFileSync(absolutePath),
    size: stat.size,
  };
}

function readJsonFile(root, relativePath, label) {
  const file = readRegularFile(root, relativePath, label);
  try {
    return { ...file, value: JSON.parse(file.bytes.toString("utf8")) };
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
}

function loadOwnerDeploymentDecision(root, descriptorValue) {
  assertAllowedKeys(
    descriptorValue,
    "Owner deployment decision descriptor",
    OWNER_DECISION_DESCRIPTOR_KEYS,
  );
  const decisionPath = safeRelativePath(
    descriptorValue.path,
    "Owner deployment decision path",
  );
  if (
    decisionPath === RUNTIME_ROOT
    || decisionPath.startsWith(`${RUNTIME_ROOT}/`)
  ) {
    throw new Error(
      "Owner deployment decision must be independent from RunKit control state.",
    );
  }
  const file = readJsonFile(root, decisionPath, "Owner deployment decision");
  const fileSha256 = assertHash(
    descriptorValue.sha256,
    "Owner deployment decision file",
  );
  if (sha256(file.bytes) !== fileSha256) {
    throw new Error("owner_decision_file_hash_mismatch");
  }
  return {
    path: decisionPath,
    sha256: fileSha256,
    value: validateOwnerDeploymentDecisionV1(file.value),
  };
}

export function inspectDeploymentOwnerDecisionStateV1({
  workspaceRoot,
  descriptor,
  expectedDecisionSha256,
}) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const decisionPath = safeRelativePath(
    descriptor?.path,
    "Owner deployment decision path",
  );
  const file = readJsonFile(root, decisionPath, "Owner deployment decision");
  const current = validateOwnerDeploymentDecisionV1(file.value);
  const expectedFileSha256 = assertHash(
    descriptor?.sha256,
    "Owner deployment decision file",
  );
  const actualFileSha256 = sha256(file.bytes);
  if (
    actualFileSha256 === expectedFileSha256
    && current.decisionSha256 === expectedDecisionSha256
  ) {
    return {
      status: "current",
      decision: current,
      fileSha256: actualFileSha256,
    };
  }
  if (current.supersedesDecisionSha256 === expectedDecisionSha256) {
    return {
      status: "superseded",
      decision: current,
      fileSha256: actualFileSha256,
    };
  }
  throw new Error("owner_decision_file_hash_mismatch");
}

function trustedAcceptedCloseout(root, runId) {
  const executionRoot = `${RUNTIME_ROOT}/executions/${runId}`;
  const closeout = readJsonFile(
    root,
    `${executionRoot}/closeout-receipt.json`,
    "Deployment prepare closeout",
  );
  const pin = readJsonFile(
    root,
    `${executionRoot}/engine-pin.json`,
    "Deployment prepare engine pin",
  );
  const gate = validateCoreArtifact(closeout.value.artifact);
  const payload = closeout.value.artifact?.payload;
  const issues = [
    ...gate.issues,
    ...(gate.valid
      && closeout.value.acceptanceSha256 !== gate.acceptanceSha256
      ? ["closeout acceptanceSha256 mismatch"]
      : []),
    ...(gate.valid
      && closeout.value.artifactSha256 !== gate.artifactSha256
      ? ["closeout artifactSha256 mismatch"]
      : []),
    ...(gate.valid ? acceptedCloseoutVerificationIssues(closeout.value.artifact) : []),
    ...(gate.valid
      && validateExecutionPin({
        expected: pin.value,
        actual: closeout.value.artifact.core,
      }).status !== "valid"
      ? ["closeout engine pin mismatch"]
      : []),
  ];
  if (
    issues.length > 0
    || payload?.runId !== runId
    || payload?.decision !== "accepted"
    || payload?.authorizationGranted !== false
  ) {
    throw new Error(
      `Deployment prepare requires a trusted accepted closeout: ${issues.join("; ")}`,
    );
  }
  return {
    trusted: true,
    decision: "accepted",
    runId,
    path: closeout.relativePath,
    sha256: sha256(closeout.bytes),
    gateInputSha256: payload.verification.gateInputSha256,
    sourceFingerprint: payload.verification.sourceFingerprint,
    ...(payload.verification.sourceArtifact === undefined
      ? {}
      : {
        sourceArtifact: structuredClone(
          payload.verification.sourceArtifact,
        ),
      }),
    authorizationGranted: false,
  };
}

function selectDeliveryPacket(root, runId, sourceFingerprint) {
  const directoryRelative =
    `${RUNTIME_ROOT}/executions/${runId}/delivery-packets`;
  const directory = path.resolve(root, directoryRelative);
  const directoryStat = lstatSync(directory);
  if (
    directoryStat.isSymbolicLink()
    || !directoryStat.isDirectory()
    || realpathSync(directory) !== directory
  ) {
    throw new Error("Deployment prepare delivery packet directory is invalid.");
  }
  const candidates = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) {
      throw new Error("Deployment prepare delivery packet directory contains an unsafe entry.");
    }
    const relativePath = `${directoryRelative}/${entry.name}`;
    const file = readJsonFile(root, relativePath, "Deployment prepare delivery packet");
    const gate = verifyDeliveryPacket({
      workspaceRoot: root,
      packet: file.value,
    });
    if (
      file.value.runId === runId
      && gate.status === "valid"
      && gate.recomputedFingerprint === sourceFingerprint
    ) {
      candidates.push({
        path: file.absolutePath,
        relativePath,
        packet: file.value,
        sourceFingerprint: gate.recomputedFingerprint,
      });
    }
  }
  const selected = collapseByteIdenticalDeliveryCandidates(candidates);
  if (selected.length !== 1) {
    throw new Error(
      "Deployment prepare requires exactly one byte-distinct fresh DeliveryPacket matching the accepted closeout.",
    );
  }
  return {
    runId,
    path: selected[0].relativePath,
    sha256: selected[0].packetFileSha256,
    sourceFingerprint,
  };
}

function assertHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertHashRef(value, label) {
  if (typeof value !== "string" || !SHA256_REF.test(value)) {
    throw new Error(`${label} must be a sha256:<lowercase digest> reference.`);
  }
  return value;
}

function sourceArtifactDescriptor(value, label = "Source artifact") {
  assertAllowedKeys(value, label, SOURCE_ARTIFACT_KEYS);
  const artifact = {
    kind: value.kind,
    runId: safeIdentifier(value.runId, `${label} runId`),
    path: safeRelativePath(value.path, `${label} path`),
    sha256: assertHash(value.sha256, label),
    sourceFingerprint: assertHash(
      value.sourceFingerprint,
      `${label} source fingerprint`,
    ),
  };
  if (!new Set(["delivery_packet_v1", "source_candidate_v2"])
    .has(artifact.kind)) {
    throw new Error(`${label} kind is invalid.`);
  }
  return artifact;
}

function selectSourceArtifact(root, runId, closeout) {
  const artifact = sourceArtifactDescriptor(
    closeout.sourceArtifact,
    "Accepted closeout source artifact",
  );
  if (
    artifact.runId !== runId
    || artifact.sourceFingerprint !== closeout.sourceFingerprint
  ) {
    throw new Error(
      "Accepted closeout source artifact does not match its run or fingerprint.",
    );
  }
  const expectedRoot = `${RUNTIME_ROOT}/executions/${runId}/${
    artifact.kind === "source_candidate_v2"
      ? "source-candidates"
      : "delivery-packets"
  }/`;
  if (!artifact.path.startsWith(expectedRoot)) {
    throw new Error(
      "Accepted closeout source artifact is outside its execution source directory.",
    );
  }
  const file = readJsonFile(
    root,
    artifact.path,
    "Accepted closeout source artifact",
  );
  if (sha256(file.bytes) !== artifact.sha256) {
    throw new Error("Accepted closeout source artifact bytes changed.");
  }
  if (artifact.kind === "source_candidate_v2") {
    const gate = verifySourceCandidateV2({
      workspaceRoot: root,
      candidatePath: artifact.path,
    });
    if (
      file.value.schemaVersion !== "OwlCodaRunKitSourceCandidateV2"
      || file.value.runId !== runId
      || gate.status !== "valid"
      || gate.sourceFingerprint !== artifact.sourceFingerprint
    ) {
      throw new Error(
        "Accepted closeout SourceCandidate V2 is not current and valid.",
      );
    }
  } else {
    const gate = verifyDeliveryPacket({
      workspaceRoot: root,
      packet: file.value,
    });
    if (
      file.value.runId !== runId
      || gate.status !== "valid"
      || gate.recomputedFingerprint !== artifact.sourceFingerprint
    ) {
      throw new Error(
        "Accepted closeout DeliveryPacket is not current and valid.",
      );
    }
  }
  return artifact;
}

function descriptor(value, label) {
  assertAllowedKeys(value, label, GOAL_KEYS);
  return {
    path: safeRelativePath(value.path, `${label} path`),
    sha256: assertHash(value.sha256, label),
  };
}

function artifactDescriptor(value) {
  assertAllowedKeys(value, "Deployment artifact", ARTIFACT_KEYS);
  const artifact = {
    path: safeRelativePath(value.path, "Deployment artifact path"),
    sha256: assertHash(value.sha256, "Deployment artifact"),
    size: value.size,
    mediaType: value.mediaType,
  };
  if (!Number.isInteger(artifact.size) || artifact.size < 0) {
    throw new Error("Deployment artifact size must be a non-negative integer.");
  }
  if (typeof artifact.mediaType !== "string"
    || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(artifact.mediaType)) {
    throw new Error("Deployment artifact mediaType is invalid.");
  }
  return artifact;
}

function validatePrepareReceipt(receipt) {
  if (receipt?.schemaVersion !== "OwlCodaRunKitDeploymentPrepareReceiptV1") {
    throw new Error("Unsupported deployment prepare receipt schemaVersion.");
  }
  if (receipt.receiptSha256 !== hashObject((({ receiptSha256, ...body }) => body)(receipt))) {
    throw new Error("Deployment prepare receipt hash does not match its contents.");
  }
  if (receipt.permissions?.deploy !== false
    || receipt.permissions?.destructive !== false
    || receipt.authorizationGranted !== false) {
    throw new Error("Deployment prepare receipt must not grant deployment authority.");
  }
  const hasDeliveryPacket = receipt.deliveryPacket !== undefined;
  const hasSourceArtifact = receipt.sourceArtifact !== undefined;
  if (hasDeliveryPacket === hasSourceArtifact) {
    throw new Error(
      "Deployment prepare receipt requires exactly one sourceArtifact or legacy DeliveryPacket.",
    );
  }
  if (
    hasSourceArtifact
    && sourceArtifactDescriptor(receipt.sourceArtifact).sourceFingerprint
      !== receipt.closeout?.sourceFingerprint
  ) {
    throw new Error(
      "Deployment prepare source artifact and closeout fingerprints differ.",
    );
  }
  if (receipt.ownerDecision !== undefined) {
    validateOwnerDeploymentDecisionBindingV1(receipt.ownerDecision);
  }
  return receipt;
}

export function createDeploymentPrepareReceipt(input) {
  assertAllowedKeys(input, "Deployment prepare input", PREPARE_INPUT_KEYS);
  const prepareRunId = safeIdentifier(input.prepareRunId, "prepareRunId");
  const prepareGoal = descriptor(input.prepareGoal, "Prepare goal");
  assertAllowedKeys(
    input.trustedAcceptedCloseout,
    "Trusted accepted closeout",
    CLOSEOUT_KEYS,
  );
  const closeout = {
    trusted: input.trustedAcceptedCloseout.trusted,
    decision: input.trustedAcceptedCloseout.decision,
    runId: safeIdentifier(input.trustedAcceptedCloseout.runId, "Closeout runId"),
    path: safeRelativePath(input.trustedAcceptedCloseout.path, "Closeout path"),
    sha256: assertHash(input.trustedAcceptedCloseout.sha256, "Closeout"),
    gateInputSha256: assertHash(
      input.trustedAcceptedCloseout.gateInputSha256,
      "Closeout gate input",
    ),
    sourceFingerprint: assertHash(
      input.trustedAcceptedCloseout.sourceFingerprint,
      "Closeout source fingerprint",
    ),
    ...(input.trustedAcceptedCloseout.sourceArtifact === undefined
      ? {}
      : {
        sourceArtifact: sourceArtifactDescriptor(
          input.trustedAcceptedCloseout.sourceArtifact,
          "Closeout source artifact",
        ),
      }),
    authorizationGranted: input.trustedAcceptedCloseout.authorizationGranted,
  };
  if (closeout.trusted !== true
    || closeout.decision !== "accepted"
    || closeout.runId !== prepareRunId) {
    throw new Error("Deployment prepare requires a trusted accepted closeout for the same run.");
  }
  if (closeout.authorizationGranted !== false) {
    throw new Error("Trusted accepted closeout must not grant deployment authority.");
  }
  const hasDeliveryPacket = input.deliveryPacket !== undefined;
  const hasSourceArtifact = input.sourceArtifact !== undefined;
  if (hasDeliveryPacket === hasSourceArtifact) {
    throw new Error(
      "Deployment prepare requires exactly one sourceArtifact or legacy DeliveryPacket.",
    );
  }
  let sourceBinding;
  if (hasSourceArtifact) {
    const sourceArtifact = sourceArtifactDescriptor(input.sourceArtifact);
    if (
      sourceArtifact.kind !== "source_candidate_v2"
      || sourceArtifact.runId !== prepareRunId
      || sourceArtifact.sourceFingerprint !== closeout.sourceFingerprint
      || canonicalJson(sourceArtifact)
        !== canonicalJson(closeout.sourceArtifact)
    ) {
      throw new Error(
        "Deployment prepare source artifact must exactly match the accepted closeout.",
      );
    }
    sourceBinding = { sourceArtifact };
  } else {
    assertAllowedKeys(
      input.deliveryPacket,
      "DeliveryPacket descriptor",
      PACKET_KEYS,
    );
    const deliveryPacket = {
      runId: safeIdentifier(input.deliveryPacket.runId, "DeliveryPacket runId"),
      path: safeRelativePath(input.deliveryPacket.path, "DeliveryPacket path"),
      sha256: assertHash(input.deliveryPacket.sha256, "DeliveryPacket"),
      sourceFingerprint: assertHash(
        input.deliveryPacket.sourceFingerprint,
        "DeliveryPacket source fingerprint",
      ),
    };
    if (deliveryPacket.runId !== prepareRunId) {
      throw new Error("Deployment prepare DeliveryPacket must belong to the prepare run.");
    }
    if (deliveryPacket.sourceFingerprint !== closeout.sourceFingerprint) {
      throw new Error("Deployment prepare DeliveryPacket and accepted closeout source fingerprints differ.");
    }
    sourceBinding = { deliveryPacket };
  }
  const artifact = artifactDescriptor(input.artifact);
  const ownerDecision = input.ownerDecision === undefined
    ? null
    : validateOwnerDeploymentDecisionBindingV1(input.ownerDecision);
  const body = {
    schemaVersion: "OwlCodaRunKitDeploymentPrepareReceiptV1",
    prepareRunId,
    prepareGoal,
    closeout,
    ...sourceBinding,
    artifact,
    ...(ownerDecision === null ? {} : { ownerDecision }),
    permissions: {
      deploy: false,
      destructive: false,
    },
    authorizationGranted: false,
  };
  return { ...body, receiptSha256: hashObject(body) };
}

export function createDeploymentPrepareReceiptFromClosedRun({
  workspaceRoot,
  prepareRunId,
  artifactPath,
  mediaType,
  ownerDecision,
} = {}) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const runId = safeIdentifier(prepareRunId, "prepareRunId");
  const closeout = trustedAcceptedCloseout(root, runId);
  const goal = readRegularFile(
    root,
    `${RUNTIME_ROOT}/executions/${runId}/goal-contract.json`,
    "Deployment prepare goal",
  );
  const artifact = readRegularFile(
    root,
    safeRelativePath(artifactPath, "Deployment artifact path"),
    "Deployment artifact",
  );
  return createDeploymentPrepareReceipt({
    prepareRunId: runId,
    prepareGoal: {
      path: goal.relativePath,
      sha256: sha256(goal.bytes),
    },
    trustedAcceptedCloseout: closeout,
    ...(closeout.sourceArtifact?.kind !== "source_candidate_v2"
      ? {
        deliveryPacket: selectDeliveryPacket(
          root,
          runId,
          closeout.sourceFingerprint,
        ),
      }
      : {
        sourceArtifact: selectSourceArtifact(root, runId, closeout),
      }),
    artifact: {
      path: artifact.relativePath,
      sha256: sha256(artifact.bytes),
      size: artifact.size,
      mediaType,
    },
    ...(ownerDecision === undefined
      ? {}
      : { ownerDecision: ownerDeploymentDecisionBindingV1(ownerDecision) }),
  });
}

function deploymentChildPaths(root, runId) {
  const executionRoot = path.join(root, RUNTIME_ROOT, "executions", runId);
  const deploymentRoot = path.join(root, RUNTIME_ROOT, "deployments", runId);
  return {
    executionRoot,
    deploymentRoot,
    goalPath: path.join(executionRoot, "goal-contract.json"),
    planPath: path.join(executionRoot, "execution-plan.json"),
    pinPath: path.join(executionRoot, "engine-pin.json"),
    eventsPath: path.join(executionRoot, "events.jsonl"),
    profilePath: path.join(executionRoot, "deployment-profile.json"),
    verificationPlanPath: path.join(
      executionRoot,
      "verification-plans/deployment-execute-plan.json",
    ),
    resourcePreflightPath: path.join(
      executionRoot,
      "resource-preflights/deployment-execute-preflight.json",
    ),
    requestPath: path.join(deploymentRoot, "execute-request.json"),
    decisionSnapshotPath: path.join(
      deploymentRoot,
      "owner-decision-snapshot.json",
    ),
    lineagePath: path.join(deploymentRoot, "lineage.json"),
    resultPath: path.join(deploymentRoot, "result.json"),
  };
}

function childGoal({
  prepareReceipt,
  runId,
  target,
  destructive,
  ownerDecision,
}) {
  return {
    schemaVersion: "OwlCodaRunKitGoalContractV1",
    objective: "Execute one exact remote deployment from an accepted prepare receipt.",
    nonGoals: [
      "Change the prepared artifact.",
      "Grant Git, publish, or destructive authority beyond the signed Owner decision.",
    ],
    authorization: {
      git: false,
      publish: false,
      deploy: true,
      destructive,
    },
    deployment: {
      phase: "execute",
      prepareRunId: prepareReceipt.prepareRunId,
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      targetSha256: hashObject(target),
      ownerDecision: ownerDeploymentDecisionBindingV1(ownerDecision),
    },
    authorizationGranted: false,
  };
}

function deploymentProfile(artifactPath) {
  return {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: [{
      id: "deployment-execute",
      paths: [artifactPath],
      role: "primary",
      primary: true,
      requiresProfileIds: [],
      commands: [],
    }],
  };
}

function deploymentVerificationPlan({
  runId,
  profileSha256,
  prepareReceipt,
}) {
  return {
    schemaVersion: "OwlCodaRunKitVerificationPlanV1",
    runId,
    planId: "deployment-execute-plan",
    status: "ready_to_finalize",
    drift: {
      leasedSourceDrift: [],
      declaredDependencyDrift: [],
      unrelatedDirtyTreeDrift: [],
      globalGateFailures: [],
    },
    profileImpact: {
      decision: "targeted_profiles",
      primaryProfileId: "deployment-execute",
      directProfileIds: ["deployment-execute"],
      transitiveProfileIds: [],
      supportingProfileIds: [],
      selectedProfileIds: ["deployment-execute"],
      uncoveredPaths: [],
      warnings: [],
    },
    evidence: {
      reusableReceiptIds: [],
      invalidatedReceipts: [],
    },
    commands: {
      requiredCommandIds: [],
      reusedCommandIds: [],
      pendingCommandIds: [],
      unmappedProfileIds: [],
      pendingCommands: [],
    },
    acceptance: {
      blocked: false,
      reasons: [],
    },
    authorizationGranted: false,
    verificationContextFingerprint: hashObject({
      runId,
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      profileSha256,
    }),
  };
}

function deploymentResourcePreflight({
  runId,
  verificationPlan,
  verificationPlanPath,
  verificationPlanSha256,
}) {
  const request = {
    schemaVersion: "OwlCodaRunKitResourcePreflightRequestV1",
    preflightId: "deployment-execute-preflight",
    verificationPlanPath,
    verificationPlanSha256,
    policy: {
      gateMode: "model_optional",
      maxObservationAgeMs: 60_000,
      unknownHandling: {
        availability: "fail_closed",
        quota: "fail_closed",
        resetTime: "fail_closed",
        pricing: "fail_closed",
      },
      limits: {
        maxCalls: 0,
        maxTotalTokens: 0,
        maxElapsedMs: 0,
        maxCostUsd: 0,
      },
    },
    observations: [{
      providerId: "local",
      modelId: "none",
      adapter: {
        id: "builtin-remote-deployment",
        kind: "project_declared",
        evidenceRef: "local:deployment",
        evidenceSha256: hashObject({
          runId,
          verificationPlanSha256,
        }),
        observedAt: new Date().toISOString(),
      },
      availability: { status: "available" },
      quota: {
        remainingCalls: { status: "known", value: 0 },
        remainingTokens: { status: "known", value: 0 },
        resetAt: { status: "known", value: "9999-12-31T23:59:59.999Z" },
      },
      pricing: {
        status: "known",
        currency: "USD",
        inputPerMillion: 0,
        outputPerMillion: 0,
      },
    }],
    workloads: [],
  };
  return buildResourcePreflight({
    runId,
    request,
    verificationPlan,
    requestSha256: hashObject(request),
    evaluatedAt: request.observations[0].adapter.observedAt,
  });
}

export function createDeploymentExecuteChildRun({
  workspaceRoot,
  prepareReceipt,
  remoteManifest,
  ownerDecision,
  ownerAuthority,
}) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  validatePrepareReceipt(prepareReceipt);
  const runId = safeIdentifier(remoteManifest?.deploymentId, "executeRunId");
  const target = validateRemoteTarget(remoteManifest?.target);
  if (
    remoteManifest?.deploymentLineageSha256 !== null
    || canonicalJson(remoteManifest?.artifact)
      !== canonicalJson(prepareReceipt.artifact)
  ) {
    throw new Error(
      "Deployment execute manifest must bind the prepared artifact and start without lineage.",
    );
  }
  const decisionArtifact = loadOwnerDeploymentDecision(root, ownerDecision);
  const decisionBinding = ownerDeploymentDecisionBindingV1(
    decisionArtifact.value,
  );
  if (
    canonicalJson(prepareReceipt.ownerDecision)
      !== canonicalJson(decisionBinding)
  ) {
    throw new Error("owner_decision_conflict:prepare_receipt_binding");
  }
  assertAllowedKeys(
    ownerAuthority,
    "Owner authority descriptor",
    AUTHORITY_DESCRIPTOR_KEYS,
  );
  const authorityPath = safeRelativePath(
    ownerAuthority.path,
    "Owner authority artifact path",
  );
  if (
    authorityPath === RUNTIME_ROOT
    || authorityPath.startsWith(`${RUNTIME_ROOT}/`)
  ) {
    throw new Error("Owner authority artifact must be independent from RunKit control state.");
  }
  const authorityFile = readJsonFile(
    root,
    authorityPath,
    "Owner authority artifact",
  );
  const authoritySha256 = assertHash(
    ownerAuthority.sha256,
    "Owner authority artifact",
  );
  if (sha256(authorityFile.bytes) !== authoritySha256) {
    throw new Error("Owner authority artifact hash does not match its exact bytes.");
  }
  const destructive = authorityFile.value?.permissions?.destructive;
  if (
    authorityFile.value?.schemaVersion
      !== "OwlCodaRunKitOwnerDeploymentAuthorityV2"
    || authorityFile.value.executeRunId !== runId
    || authorityFile.value.permissions?.deploy !== true
    || typeof destructive !== "boolean"
    || authorityFile.value.ownerDecisionId
      !== decisionArtifact.value.decisionId
    || authorityFile.value.ownerDecisionSha256
      !== decisionArtifact.value.decisionSha256
  ) {
    throw new Error(
      "Signed Owner authority must name the child run and exact deployment permissions.",
    );
  }
  const prospectiveGoal = childGoal({
    prepareReceipt,
    runId,
    target,
    destructive,
    ownerDecision: decisionArtifact.value,
  });
  const decisionCompilation = compileOwnerDeploymentDecisionV1({
    decision: decisionArtifact.value,
    prepareReceipt,
    goal: prospectiveGoal,
    remoteManifest,
    authority: authorityFile.value,
    expected: {
      targetSha256: hashObject(target),
      artifactSha256: prepareReceipt.artifact.sha256,
      remoteDeploymentIntentSha256:
        canonicalRemoteDeploymentIntentSha256(remoteManifest),
    },
  });
  const paths = deploymentChildPaths(root, runId);
  mkdirSync(path.join(root, RUNTIME_ROOT, "executions"), { recursive: true });
  return withControlTransaction(root, () => {
    if (
      existsSync(paths.executionRoot)
      || existsSync(paths.deploymentRoot)
    ) {
      throw new Error(
        `Deployment execute child or deployment control already exists: ${runId}`,
      );
    }
    mkdirSync(path.join(paths.executionRoot, "leases"), { recursive: true });
    mkdirSync(path.join(paths.executionRoot, "delivery-packets"));
    mkdirSync(path.join(paths.executionRoot, "verification-receipts"));
    try {
      const enginePin = currentCoreIdentity();
      const goal = prospectiveGoal;
      writeJsonExclusiveAtomically(
        paths.decisionSnapshotPath,
        decisionArtifact.value,
      );
      const decisionSnapshot = {
        path: relativeToWorkspace(root, paths.decisionSnapshotPath),
        sha256: sha256(readFileSync(paths.decisionSnapshotPath)),
      };
      writeJsonExclusiveAtomically(paths.pinPath, enginePin);
      writeJsonExclusiveAtomically(paths.goalPath, goal);
      const goalSha256 = sha256(readFileSync(paths.goalPath));
      writeJsonExclusiveAtomically(paths.planPath, {
        schemaVersion: "OwlCodaRunKitExecutionPlanV1",
        runId,
        state: "planned",
        enginePin,
        goalContractSha256: goalSha256,
        ownerDecisionSha256: decisionArtifact.value.decisionSha256,
        ownerDecisionSnapshot: decisionSnapshot,
        ownerDecisionCompilationSha256:
          decisionCompilation.compilationSha256,
        authorizationGranted: false,
      });
      appendFileSync(
        paths.eventsPath,
        `${JSON.stringify({
          sequence: 1,
          type: "execution_planned",
          runId,
          authorizationGranted: false,
          ownerDecisionSha256: decisionArtifact.value.decisionSha256,
        })}\n`,
      );
      const lease = acquireLeaseWithinControlTransaction({
        workspaceRoot: root,
        runId,
        workItemId: "deployment-execute",
        ownedPaths: [prepareReceipt.artifact.path],
      });
      if (lease.status !== "lease_acquired") {
        throw new Error(`Deployment execute lease was not acquired: ${lease.status}`);
      }
      const profile = deploymentProfile(prepareReceipt.artifact.path);
      writeJsonExclusiveAtomically(paths.profilePath, profile);
      const profileSha256 = sha256(readFileSync(paths.profilePath));
      const verificationPlan = deploymentVerificationPlan({
        runId,
        profileSha256,
        prepareReceipt,
      });
      writeJsonExclusiveAtomically(paths.verificationPlanPath, verificationPlan);
      const verificationPlanSha256 = sha256(
        readFileSync(paths.verificationPlanPath),
      );
      const resourcePreflight = deploymentResourcePreflight({
        runId,
        verificationPlan,
        verificationPlanPath:
          relativeToWorkspace(root, paths.verificationPlanPath),
        verificationPlanSha256,
      });
      writeJsonExclusiveAtomically(
        paths.resourcePreflightPath,
        resourcePreflight,
      );
      const executeRequest = {
        schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
        executeRunId: runId,
        executeGoal: {
          path: relativeToWorkspace(root, paths.goalPath),
          sha256: goalSha256,
        },
        prepareReceiptSha256: prepareReceipt.receiptSha256,
        target,
        ownerAuthority: {
          path: authorityPath,
          sha256: authoritySha256,
        },
        ownerDecision: {
          path: decisionArtifact.path,
          sha256: decisionArtifact.sha256,
        },
        ownerDecisionSnapshot: decisionSnapshot,
        workItemId: "deployment-execute",
        profileId: "deployment-execute",
        resourcePreflight: {
          path: relativeToWorkspace(root, paths.resourcePreflightPath),
          sha256: sha256(readFileSync(paths.resourcePreflightPath)),
        },
        deploy: true,
        destructive,
      };
      writeJsonExclusiveAtomically(paths.requestPath, executeRequest);
      return {
        runId,
        executeRequest,
        executeRequestPath: relativeToWorkspace(root, paths.requestPath),
        lineagePath: relativeToWorkspace(root, paths.lineagePath),
        resultPath: relativeToWorkspace(root, paths.resultPath),
      };
    } catch (error) {
      rmSync(paths.executionRoot, { recursive: true, force: true });
      rmSync(paths.deploymentRoot, { recursive: true, force: true });
      throw error;
    }
  });
}

function validateRemoteManifestBinding({
  remoteManifest,
  remoteManifestBytes,
  prepareReceipt,
  executeRunId,
  target,
}) {
  if (
    !Buffer.isBuffer(remoteManifestBytes)
    && !(remoteManifestBytes instanceof Uint8Array)
  ) {
    throw new Error("Deployment execute requires the exact remote manifest bytes.");
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(remoteManifestBytes).toString("utf8"));
  } catch {
    throw new Error("Deployment execute remote manifest bytes must contain valid JSON.");
  }
  if (canonicalJson(parsed) !== canonicalJson(remoteManifest)) {
    throw new Error(
      "Deployment execute remote manifest object does not match its exact bytes.",
    );
  }
  if (
    remoteManifest?.deploymentLineageSha256 !== null
    || remoteManifest?.deploymentId !== executeRunId
    || canonicalJson(remoteManifest.target) !== canonicalJson(target)
    || canonicalJson(remoteManifest.artifact)
      !== canonicalJson(prepareReceipt.artifact)
  ) {
    throw new Error(
      "Deployment execute remote manifest does not bind the exact child, target, and artifact.",
    );
  }
  return {
    fileSha256: sha256(Buffer.from(remoteManifestBytes)),
    intentSha256: canonicalRemoteDeploymentIntentSha256(remoteManifest),
  };
}

function validateOwnerAuthority(ownerAuthority, request, remoteManifestBinding) {
  assertAllowedKeys(ownerAuthority, "Owner authority", AUTHORITY_KEYS);
  safeIdentifier(ownerAuthority.authorityId, "Owner authorityId");
  const authorityPath = safeRelativePath(
    ownerAuthority.path,
    "Owner authority path",
  );
  if (
    authorityPath === RUNTIME_ROOT
    || authorityPath.startsWith(`${RUNTIME_ROOT}/`)
  ) {
    throw new Error("Owner authority must be independent from RunKit control state.");
  }
  const authorityHash = assertHash(ownerAuthority.sha256, "Owner authority");
  const signerKeyId = safeIdentifier(
    ownerAuthority.signerKeyId,
    "Owner authority signerKeyId",
  );
  const trustStoreSha256 = assertHashRef(
    ownerAuthority.trustStoreSha256,
    "Owner authority trust store",
  );
  const remoteManifestFileSha256 = assertHash(
    ownerAuthority.remoteManifestFileSha256,
    "Owner authority remote manifest file",
  );
  const remoteDeploymentIntentSha256 = assertHash(
    ownerAuthority.remoteDeploymentIntentSha256,
    "Owner authority remote deployment intent",
  );
  const targetSha256 = ownerAuthority.targetSha256 === undefined
    ? null
    : assertHash(ownerAuthority.targetSha256, "Owner authority target");
  const artifactSha256 = ownerAuthority.artifactSha256 === undefined
    ? null
    : assertHash(ownerAuthority.artifactSha256, "Owner authority artifact");
  const ownerDecisionId = ownerAuthority.ownerDecisionId === undefined
    ? null
    : safeIdentifier(
      ownerAuthority.ownerDecisionId,
      "Owner authority decisionId",
    );
  const ownerDecisionSha256 = ownerAuthority.ownerDecisionSha256 === undefined
    ? null
    : assertHash(
      ownerAuthority.ownerDecisionSha256,
      "Owner authority decision",
    );
  if (
    remoteManifestFileSha256 !== remoteManifestBinding.fileSha256
    || remoteDeploymentIntentSha256 !== remoteManifestBinding.intentSha256
  ) {
    throw new Error(
      "Owner authority does not bind the exact remote manifest bytes and canonical intent.",
    );
  }
  assertAllowedKeys(ownerAuthority.permissions, "Owner authority permissions", PERMISSION_KEYS);
  if (ownerAuthority.permissions.deploy !== true
    || typeof ownerAuthority.permissions.destructive !== "boolean") {
    throw new Error("Owner authority must explicitly grant deploy and state destructive permission.");
  }
  if (request.deploy !== true
    || typeof request.destructive !== "boolean"
    || request.destructive !== ownerAuthority.permissions.destructive) {
    throw new Error("Deployment execute permissions must exactly match Owner authority.");
  }
  return {
    authorityId: ownerAuthority.authorityId,
    path: authorityPath,
    sha256: authorityHash,
    signerKeyId,
    trustStoreSha256,
    remoteManifestFileSha256,
    remoteDeploymentIntentSha256,
    ...(targetSha256 === null ? {} : { targetSha256, artifactSha256 }),
    ...(ownerDecisionId === null
      ? {}
      : { ownerDecisionId, ownerDecisionSha256 }),
    permissions: structuredClone(ownerAuthority.permissions),
  };
}

function loadOwnerDeploymentAuthority({
  root,
  descriptor: authorityDescriptor,
  prepareReceipt,
  executeRequest,
  remoteManifestBinding,
  ownerDecision,
  verifyOwnerAuthority,
}) {
  assertAllowedKeys(
    authorityDescriptor,
    "Owner authority descriptor",
    AUTHORITY_DESCRIPTOR_KEYS,
  );
  const descriptorPath = safeRelativePath(
    authorityDescriptor.path,
    "Owner authority artifact path",
  );
  if (
    descriptorPath === RUNTIME_ROOT
    || descriptorPath.startsWith(`${RUNTIME_ROOT}/`)
  ) {
    throw new Error("Owner authority artifact must be independent from RunKit control state.");
  }
  const descriptorSha256 = assertHash(
    authorityDescriptor.sha256,
    "Owner authority artifact",
  );
  const file = readJsonFile(root, descriptorPath, "Owner authority artifact");
  if (sha256(file.bytes) !== descriptorSha256) {
    throw new Error("Owner authority artifact hash does not match its exact bytes.");
  }
  const authority = file.value;
  assertAllowedKeys(
    authority,
    "Owner deployment authority",
    OWNER_DEPLOYMENT_AUTHORITY_KEYS,
  );
  const authorityId = safeIdentifier(
    authority.authorityId,
    "Owner authorityId",
  );
  if (authority.schemaVersion === "OwlCodaRunKitOwnerDeploymentAuthorityV1") {
    throw new Error("deployment_owner_authority_untrusted");
  }
  assertAllowedKeys(
    authority.permissions,
    "Owner authority permissions",
    PERMISSION_KEYS,
  );
  if (
    authority.remoteManifestFileSha256
      !== remoteManifestBinding.fileSha256
    || authority.remoteDeploymentIntentSha256
      !== remoteManifestBinding.intentSha256
  ) {
    throw new Error(
      "Owner authority does not bind the exact remote manifest bytes and canonical intent.",
    );
  }
  if (
    authority.schemaVersion
      !== "OwlCodaRunKitOwnerDeploymentAuthorityV2"
    || authority.decision !== "approved"
    || authority.scope !== "execute_exact_remote_deployment"
    || authority.executeRunId !== executeRequest.executeRunId
    || authority.prepareReceiptSha256 !== prepareReceipt.receiptSha256
    || authority.targetSha256
      !== hashObject(validateRemoteTarget(executeRequest.target))
    || authority.artifactSha256 !== prepareReceipt.artifact.sha256
    || authority.ownerDecisionId !== ownerDecision.decisionId
    || authority.ownerDecisionSha256 !== ownerDecision.decisionSha256
    || authority.permissions.deploy !== true
    || typeof authority.permissions.destructive !== "boolean"
    || authority.permissions.destructive !== executeRequest.destructive
    || executeRequest.deploy !== true
    || authority.authorizationGranted !== false
    || authority.signatureAlgorithm !== "ed25519"
    || typeof authority.signerKeyId !== "string"
    || typeof authority.signature !== "string"
    || !SHA256_REF.test(authority.authoritySha256)
    || authority.authoritySha256
      !== ownerAuthorityArtifactSha256V1(authority)
  ) {
    throw new Error(
      "Owner authority artifact does not grant the exact deployment scope.",
    );
  }
  let trustedAuthority;
  try {
    trustedAuthority = verifyOwnerAuthority({ authority });
  } catch {
    throw new Error("deployment_owner_authority_untrusted");
  }
  if (
    trustedAuthority?.status !== "trusted"
    || trustedAuthority.signerKeyId !== authority.signerKeyId
    || trustedAuthority.authoritySha256 !== authority.authoritySha256
    || !SHA256_REF.test(trustedAuthority.trustStoreSha256)
  ) {
    throw new Error("deployment_owner_authority_untrusted");
  }
  return {
    authorityId,
    path: descriptorPath,
    sha256: descriptorSha256,
    signerKeyId: trustedAuthority.signerKeyId,
    trustStoreSha256: trustedAuthority.trustStoreSha256,
    remoteManifestFileSha256: authority.remoteManifestFileSha256,
    remoteDeploymentIntentSha256:
      authority.remoteDeploymentIntentSha256,
    targetSha256: authority.targetSha256,
    artifactSha256: authority.artifactSha256,
    ownerDecisionId: authority.ownerDecisionId,
    ownerDecisionSha256: authority.ownerDecisionSha256,
    permissions: structuredClone(authority.permissions),
  };
}

export function createDeploymentExecuteLineage({
  prepareReceipt,
  executeRequest,
  executionBinding = null,
  remoteManifest,
  remoteManifestBytes,
  ownerDecision = null,
  decisionGoal = null,
}) {
  validatePrepareReceipt(prepareReceipt);
  assertAllowedKeys(executeRequest, "Deployment execute request", EXECUTE_REQUEST_KEYS);
  if (executeRequest.schemaVersion !== "OwlCodaRunKitDeploymentExecuteRequestV1") {
    throw new Error("Unsupported deployment execute request schemaVersion.");
  }
  if (executeRequest.prepareReceiptSha256 !== prepareReceipt.receiptSha256) {
    throw new Error("Deployment execute request does not bind the prepare receipt.");
  }
  const executeRunId = safeIdentifier(executeRequest.executeRunId, "executeRunId");
  if (executeRunId === prepareReceipt.prepareRunId) {
    throw new Error("Deployment execute requires a new child run.");
  }
  const executeGoal = descriptor(executeRequest.executeGoal, "Execute goal");
  if (executeGoal.path === prepareReceipt.prepareGoal.path
    || executeGoal.sha256 === prepareReceipt.prepareGoal.sha256) {
    throw new Error("Deployment execute requires a new goal.");
  }
  const target = validateRemoteTarget(executeRequest.target);
  const remoteManifestBinding = validateRemoteManifestBinding({
    remoteManifest,
    remoteManifestBytes,
    prepareReceipt,
    executeRunId,
    target,
  });
  const ownerAuthority = validateOwnerAuthority(
    executeRequest.ownerAuthority,
    executeRequest,
    remoteManifestBinding,
  );
  const decisionCompilation = ownerDecision === null
    ? null
    : compileOwnerDeploymentDecisionV1({
      decision: ownerDecision,
      prepareReceipt,
      goal: decisionGoal,
      remoteManifest,
      authority: ownerAuthority,
      expected: {
        targetSha256: hashObject(target),
        artifactSha256: prepareReceipt.artifact.sha256,
        remoteDeploymentIntentSha256: remoteManifestBinding.intentSha256,
      },
    });
  const sourceArtifact = prepareReceipt.sourceArtifact ?? null;
  const sourceArtifactSha256 = sourceArtifact?.sha256
    ?? prepareReceipt.deliveryPacket.sha256;
  const upstreamHashes = new Set([
    prepareReceipt.receiptSha256,
    prepareReceipt.prepareGoal.sha256,
    prepareReceipt.closeout.sha256,
    prepareReceipt.closeout.gateInputSha256,
    sourceArtifactSha256,
    prepareReceipt.artifact.sha256,
    executeGoal.sha256,
  ]);
  if (upstreamHashes.has(ownerAuthority.sha256)) {
    throw new Error("Deployment execute requires an independent Owner authority hash.");
  }
  const body = {
    schemaVersion: "OwlCodaRunKitDeploymentLineageV1",
    parent: {
      prepareRunId: prepareReceipt.prepareRunId,
      prepareGoal: structuredClone(prepareReceipt.prepareGoal),
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      acceptedCloseoutSha256: prepareReceipt.closeout.sha256,
      ...(sourceArtifact === null
        ? { deliveryPacketSha256: prepareReceipt.deliveryPacket.sha256 }
        : { sourceArtifact: structuredClone(sourceArtifact) }),
      artifact: structuredClone(prepareReceipt.artifact),
    },
    child: {
      executeRunId,
      executeGoal,
      ...(executionBinding === null
        ? {}
        : { control: structuredClone(executionBinding) }),
    },
    ...(decisionCompilation === null
      ? {}
      : {
        ownerDecision: {
          ...ownerDeploymentDecisionBindingV1(ownerDecision),
          compilationSha256: decisionCompilation.compilationSha256,
        },
      }),
    target: {
      value: target,
      sha256: hashObject(target),
    },
    authority: {
      source: "owner",
      authorityId: ownerAuthority.authorityId,
      path: ownerAuthority.path,
      sha256: ownerAuthority.sha256,
      signerKeyId: ownerAuthority.signerKeyId,
      trustStoreSha256: ownerAuthority.trustStoreSha256,
      remoteManifestFileSha256:
        ownerAuthority.remoteManifestFileSha256,
      remoteDeploymentIntentSha256:
        ownerAuthority.remoteDeploymentIntentSha256,
      ...(ownerAuthority.ownerDecisionId === undefined
        ? {}
        : {
          ownerDecisionId: ownerAuthority.ownerDecisionId,
          ownerDecisionSha256: ownerAuthority.ownerDecisionSha256,
        }),
      inheritedFromPrepare: false,
    },
    permissions: {
      deploy: executeRequest.deploy,
      destructive: executeRequest.destructive,
    },
    authorizationGranted: false,
  };
  return { ...body, lineageSha256: hashObject(body) };
}

function validateChildGoal({
  goal,
  prepareReceipt,
  executeRequest,
  ownerDecision,
}) {
  if (
    goal?.schemaVersion !== "OwlCodaRunKitGoalContractV1"
    || goal.authorization?.deploy !== true
    || goal.authorization?.destructive !== executeRequest.destructive
    || goal.deployment?.phase !== "execute"
    || goal.deployment?.prepareRunId !== prepareReceipt.prepareRunId
    || goal.deployment?.prepareReceiptSha256 !== prepareReceipt.receiptSha256
    || goal.deployment?.targetSha256
      !== hashObject(validateRemoteTarget(executeRequest.target))
    || canonicalJson(goal.deployment?.ownerDecision)
      !== canonicalJson(ownerDeploymentDecisionBindingV1(ownerDecision))
  ) {
    throw new Error(
      "Deployment execute child Goal does not bind the exact parent, target, and permissions.",
    );
  }
}

function loadDeploymentChildControl({
  root,
  prepareReceipt,
  executeRequest,
  ownerDecision,
}) {
  const runId = safeIdentifier(executeRequest.executeRunId, "executeRunId");
  const executionRoot = path.join(root, RUNTIME_ROOT, "executions", runId);
  const expectedGoalPath = `${RUNTIME_ROOT}/executions/${runId}/goal-contract.json`;
  const executeGoal = descriptor(executeRequest.executeGoal, "Execute goal");
  if (executeGoal.path !== expectedGoalPath) {
    throw new Error("Deployment execute Goal must belong to the real child execution.");
  }
  const enginePin = readJsonFile(
    root,
    `${RUNTIME_ROOT}/executions/${runId}/engine-pin.json`,
    "Deployment execute engine pin",
  );
  const pinGate = validateExecutionPin({
    expected: enginePin.value,
    actual: currentCoreIdentity(),
  });
  if (pinGate.status !== "valid") {
    throw new Error("Deployment execute child engine pin does not match the active Core.");
  }
  const goal = readJsonFile(
    root,
    expectedGoalPath,
    "Deployment execute Goal",
  );
  if (sha256(goal.bytes) !== executeGoal.sha256) {
    throw new Error("Deployment execute Goal hash does not match its exact bytes.");
  }
  validateChildGoal({
    goal: goal.value,
    prepareReceipt,
    executeRequest,
    ownerDecision,
  });
  const decisionSnapshot = descriptor(
    executeRequest.ownerDecisionSnapshot,
    "Owner deployment decision snapshot",
  );
  const expectedSnapshotPath =
    `${RUNTIME_ROOT}/deployments/${runId}/owner-decision-snapshot.json`;
  if (decisionSnapshot.path !== expectedSnapshotPath) {
    throw new Error("Owner deployment decision snapshot must belong to the child deployment.");
  }
  const snapshotFile = readJsonFile(
    root,
    decisionSnapshot.path,
    "Owner deployment decision snapshot",
  );
  if (
    sha256(snapshotFile.bytes) !== decisionSnapshot.sha256
    || canonicalJson(validateOwnerDeploymentDecisionV1(snapshotFile.value))
      !== canonicalJson(ownerDecision)
  ) {
    throw new Error("Owner deployment decision snapshot drifted.");
  }
  const plan = readJsonFile(
    root,
    `${RUNTIME_ROOT}/executions/${runId}/execution-plan.json`,
    "Deployment execute plan",
  );
  if (
    plan.value?.schemaVersion !== "OwlCodaRunKitExecutionPlanV1"
    || plan.value.runId !== runId
    || plan.value.state !== "planned"
    || plan.value.authorizationGranted !== false
    || plan.value.goalContractSha256 !== executeGoal.sha256
    || plan.value.ownerDecisionSha256 !== ownerDecision.decisionSha256
    || canonicalJson(plan.value.ownerDecisionSnapshot)
      !== canonicalJson(decisionSnapshot)
    || validateExecutionPin({
      expected: enginePin.value,
      actual: plan.value.enginePin,
    }).status !== "valid"
  ) {
    throw new Error("Deployment execute child plan is invalid or drifted.");
  }

  const workItemId = safeIdentifier(
    executeRequest.workItemId,
    "Deployment execute workItemId",
  );
  const leases = listLeaseArtifacts({
    workspaceRoot: root,
    executionRoot,
  }).filter(lease => lease.workItemId === workItemId);
  if (leases.length !== 1 || leases[0].state !== "active") {
    throw new Error("Deployment execute requires the exact active child writer lease.");
  }
  const [lease] = leases;
  const leaseBytes = readFileSync(lease.leasePath);

  const profileId = safeIdentifier(
    executeRequest.profileId,
    "Deployment execute profileId",
  );
  const builtInProfilePath =
    `${RUNTIME_ROOT}/executions/${runId}/deployment-profile.json`;
  const profiles = readJsonFile(
    root,
    existsSync(path.join(root, builtInProfilePath))
      ? builtInProfilePath
      : `${RUNTIME_ROOT}/profiles.json`,
    "Deployment profiles",
  );
  if (
    profiles.value?.schemaVersion !== "OwlCodaRunKitProfilesV1"
    || !Array.isArray(profiles.value.profiles)
    || profiles.value.profiles.filter(profile => profile?.id === profileId).length !== 1
  ) {
    throw new Error("Deployment execute profile is missing or ambiguous.");
  }

  const preflightDescriptor = descriptor(
    executeRequest.resourcePreflight,
    "Deployment resource preflight",
  );
  const preflightPrefix =
    `${RUNTIME_ROOT}/executions/${runId}/resource-preflights/`;
  if (!preflightDescriptor.path.startsWith(preflightPrefix)) {
    throw new Error("Deployment resource preflight must belong to the child execution.");
  }
  const preflight = readJsonFile(
    root,
    preflightDescriptor.path,
    "Deployment resource preflight",
  );
  if (sha256(preflight.bytes) !== preflightDescriptor.sha256) {
    throw new Error("Deployment resource preflight hash does not match its exact bytes.");
  }
  const preflightSummary = summarizeResourcePreflight(preflight.value, runId);
  if (
    !new Set([
      "ready_for_model_execution",
      "ready_without_model_execution",
    ]).has(preflightSummary.status)
    || (
      preflightSummary.validUntil !== null
      && Date.parse(preflightSummary.validUntil) <= Date.now()
    )
  ) {
    throw new Error("Deployment resource preflight is blocked or expired.");
  }
  const verificationPlan = readJsonFile(
    root,
    preflight.value.verificationPlan.path,
    "Deployment verification plan",
  );
  if (
    sha256(verificationPlan.bytes) !== preflight.value.verificationPlan.sha256
    || verificationPlan.value?.schemaVersion
      !== "OwlCodaRunKitVerificationPlanV1"
    || verificationPlan.value.runId !== runId
    || verificationPlan.value.planId !== preflight.value.verificationPlan.planId
    || verificationPlan.value.authorizationGranted !== false
    || verificationPlan.value.acceptance?.blocked !== false
    || !verificationPlan.value.profileImpact?.selectedProfileIds
      ?.includes(profileId)
  ) {
    throw new Error(
      "Deployment verification plan does not bind the required child profile.",
    );
  }

  const artifact = readRegularFile(
    root,
    prepareReceipt.artifact.path,
    "Deployment artifact",
  );
  if (
    sha256(artifact.bytes) !== prepareReceipt.artifact.sha256
    || artifact.size !== prepareReceipt.artifact.size
  ) {
    throw new Error("Deployment artifact size or SHA-256 drifted before execute.");
  }

  return {
    enginePin: {
      path: enginePin.relativePath,
      sha256: sha256(enginePin.bytes),
      value: structuredClone(enginePin.value),
    },
    executionPlan: {
      path: plan.relativePath,
      sha256: sha256(plan.bytes),
    },
    deploymentParent: {
      prepareRunId: prepareReceipt.prepareRunId,
      prepareReceiptSha256: prepareReceipt.receiptSha256,
    },
    lease: {
      workItemId,
      path: lease.leaseRelativePath,
      sha256: sha256(leaseBytes),
      ownedPaths: [...lease.ownedPaths],
    },
    profile: {
      profileId,
      profilesPath: profiles.relativePath,
      profilesSha256: sha256(profiles.bytes),
      verificationPlanPath: verificationPlan.relativePath,
      verificationPlanSha256: sha256(verificationPlan.bytes),
    },
    resourcePreflight: {
      preflightId: preflightSummary.preflightId,
      path: preflight.relativePath,
      sha256: sha256(preflight.bytes),
      decision: preflightSummary.status,
    },
  };
}

export function createDeploymentExecuteLineageFromActiveRun({
  workspaceRoot,
  prepareReceipt,
  executeRequest,
  remoteManifest,
  remoteManifestBytes,
  verifyOwnerAuthority = ({ authority }) => verifyTrustedOwnerAuthorityV1({
    authority,
    expectedScope: "execute_exact_remote_deployment",
    expectedPurpose: "remote_deployment",
  }),
}) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const runId = safeIdentifier(executeRequest?.executeRunId, "executeRunId");
  const executionRoot = path.join(root, RUNTIME_ROOT, "executions", runId);
  if (!existsSync(executionRoot)) {
    throw new Error("Deployment execute requires a real active child execution.");
  }
  const stat = lstatSync(executionRoot);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(executionRoot) !== executionRoot
    || existsSync(path.join(executionRoot, "closeout-receipt.json"))
  ) {
    throw new Error("Deployment execute requires a real active child execution.");
  }
  const ownerAuthority = loadOwnerDeploymentAuthority({
    root,
    descriptor: executeRequest.ownerAuthority,
    prepareReceipt,
    executeRequest,
    remoteManifestBinding: validateRemoteManifestBinding({
      remoteManifest,
      remoteManifestBytes,
      prepareReceipt,
      executeRunId: runId,
      target: validateRemoteTarget(executeRequest.target),
    }),
    ownerDecision: loadOwnerDeploymentDecision(
      root,
      executeRequest.ownerDecision,
    ).value,
    verifyOwnerAuthority,
  });
  const decisionArtifact = loadOwnerDeploymentDecision(
    root,
    executeRequest.ownerDecision,
  );
  const executionBinding = loadDeploymentChildControl({
    root,
    prepareReceipt,
    executeRequest,
    ownerDecision: decisionArtifact.value,
  });
  const goal = readJsonFile(
    root,
    executeRequest.executeGoal.path,
    "Deployment execute Goal",
  ).value;
  return createDeploymentExecuteLineage({
    prepareReceipt,
    executeRequest: {
      ...executeRequest,
      ownerAuthority,
    },
    executionBinding,
    remoteManifest,
    remoteManifestBytes,
    ownerDecision: decisionArtifact.value,
    decisionGoal: goal,
  });
}

export function verifyDeploymentExecuteLineage({
  lineage,
  prepareReceipt,
  executeRequest,
  remoteManifest,
  remoteManifestBytes,
  ownerDecision = null,
  decisionGoal = null,
}) {
  const issues = [];
  try {
    const expected = createDeploymentExecuteLineage({
      prepareReceipt,
      executeRequest,
      remoteManifest,
      remoteManifestBytes,
      ownerDecision,
      decisionGoal,
    });
    if (lineage?.lineageSha256 !== hashObject((({ lineageSha256, ...body }) => body)(lineage))) {
      issues.push("Deployment lineage hash does not match its contents.");
    }
    if (canonicalJson(lineage) !== canonicalJson(expected)) {
      issues.push("Deployment lineage target or upstream bindings drifted.");
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return {
    status: issues.length === 0 ? "valid" : "invalid",
    issues,
  };
}

export function closeDeploymentExecuteChildRun({
  workspaceRoot,
  prepareReceipt,
  executeRequest,
  result,
  resultPath,
  supersession = null,
}) {
  const root = canonicalWorkspaceRoot(workspaceRoot);
  validatePrepareReceipt(prepareReceipt);
  const runId = safeIdentifier(executeRequest?.executeRunId, "executeRunId");
  const paths = deploymentChildPaths(root, runId);
  const resultFile = readRegularFile(
    root,
    resultPath,
    "Deployment result",
  );
  let parsedResult;
  try {
    parsedResult = JSON.parse(resultFile.bytes.toString("utf8"));
  } catch {
    throw new Error("Deployment result must contain valid JSON.");
  }
  if (canonicalJson(parsedResult) !== canonicalJson(result)) {
    throw new Error("Deployment result object does not match its exact bytes.");
  }
  return withControlTransaction(root, () => {
    if (existsSync(path.join(paths.executionRoot, "closeout-receipt.json"))) {
      throw new Error(`Deployment execute child is already closed: ${runId}`);
    }
    const pin = readJsonFile(
      root,
      `${RUNTIME_ROOT}/executions/${runId}/engine-pin.json`,
      "Deployment execute engine pin",
    );
    if (validateExecutionPin({
      expected: pin.value,
      actual: currentCoreIdentity(),
    }).status !== "valid") {
      throw new Error(
        "Deployment execute child engine pin drifted before closeout.",
      );
    }
    const leases = listLeaseArtifacts({
      workspaceRoot: root,
      executionRoot: paths.executionRoot,
    });
    const deploymentLeases = leases.filter(
      lease => lease.workItemId === executeRequest.workItemId,
    );
    if (deploymentLeases.length !== 1) {
      throw new Error(
        "Deployment execute closeout requires its exact writer lease.",
      );
    }
    const releasedLeaseIds = [];
    if (deploymentLeases[0].state === "active") {
      const released = releaseLeaseWithinControlTransaction({
        workspaceRoot: root,
        runId,
        workItemId: executeRequest.workItemId,
      });
      if (released.status !== "lease_released") {
        throw new Error(
          `Deployment execute lease could not be released: ${released.status}`,
        );
      }
    }
    releasedLeaseIds.push(executeRequest.workItemId);
    const accepted = result.status === "deployed" && supersession === null;
    let verification;
    if (accepted) {
      const plan = readJsonFile(
        root,
        `${RUNTIME_ROOT}/executions/${runId}`
          + "/verification-plans/deployment-execute-plan.json",
        "Deployment verification plan",
      );
      const resultReceiptBody = {
        schemaVersion: "OwlCodaRunKitDeploymentResultReceiptV1",
        runId,
        resultPath: resultFile.relativePath,
        resultSha256: sha256(resultFile.bytes),
        resultStatus: result.status,
        completedStages: [...result.completedStages],
        authorizationGranted: false,
      };
      const resultReceipt = {
        ...resultReceiptBody,
        receiptSha256: hashObject(resultReceiptBody),
      };
      const receiptPath = path.join(
        paths.executionRoot,
        "verification-receipts/deployment-execute"
          + "/deployment-result-receipt.json",
      );
      writeJsonExclusiveAtomically(receiptPath, resultReceipt);
      const gateInputBody = {
        schemaVersion: "OwlCodaRunKitDeploymentVerificationGateInputV1",
        runId,
        decision: "accepted_passed",
        profileId: executeRequest.profileId,
        verificationPlanSha256: sha256(plan.bytes),
        resultReceiptSha256: sha256(readFileSync(receiptPath)),
        sourceFingerprint: prepareReceipt.closeout.sourceFingerprint,
        authorizationGranted: false,
      };
      const gateInput = {
        ...gateInputBody,
        gateInputSha256: hashObject(gateInputBody),
      };
      const gateInputPath = path.join(
        paths.executionRoot,
        "verification-receipts/deployment-execute"
          + "/verification-gate-input.json",
      );
      writeJsonExclusiveAtomically(gateInputPath, gateInput);
      verification = {
        contractVersion: "0.2",
        gateDecision: "accepted_passed",
        gateInputSha256: sha256(readFileSync(gateInputPath)),
        activeReceiptSha256: sha256(readFileSync(receiptPath)),
        sourceFingerprint: prepareReceipt.closeout.sourceFingerprint,
        verificationContextFingerprint:
          plan.value.verificationContextFingerprint,
        selectedProfileIds: [executeRequest.profileId],
        leaseState: "released",
        releasedLeaseIds,
      };
    }
    const supersessionStatus = supersession === null
      ? null
      : createDeploymentSupersessionStatusV1({
        runId,
        priorDecision: supersession.priorDecision,
        replacementDecision: supersession.replacementDecision,
      });
    const decision = accepted ? "accepted" : "blocked";
    const closeout = createCoreArtifact({
      core: pin.value,
      producer: {
        adapterKind: "owlcoda",
        adapterVersion: currentCoreIdentity().coreVersion,
      },
      payload: {
        runId,
        decision,
        ...(supersessionStatus === null
          ? {}
          : {
            statusCode: supersessionStatus.status,
            businessGoalIncomplete:
              supersessionStatus.businessGoalIncomplete,
            replacementPlanRequired:
              supersessionStatus.replacementPlanRequired,
            nextAllowedAction:
              supersessionStatus.nextAllowedAction,
            supersession: {
              priorDecisionSha256:
                supersessionStatus.priorDecisionSha256,
              replacementDecisionSha256:
                supersessionStatus.replacementDecisionSha256,
            },
          }),
        authorizationGranted: false,
        ...(verification ? { verification } : {}),
      },
      extensions: {},
    });
    const closeoutPath = path.join(
      paths.executionRoot,
      "closeout-receipt.json",
    );
    writeJsonExclusiveAtomically(closeoutPath, closeout);
    const priorEvents = readFileSync(paths.eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    appendFileSync(
      paths.eventsPath,
      `${JSON.stringify({
        sequence: priorEvents.length + 1,
        type: "execution_closed",
        runId,
        decision,
        ...(supersessionStatus === null
          ? {}
          : { statusCode: supersessionStatus.status }),
        artifactSha256: closeout.artifactSha256,
      })}\n`,
    );
    return {
      runId,
      closeoutDecision: decision,
      ...(supersessionStatus === null
        ? {}
        : {
          closeoutStatus: supersessionStatus.status,
          businessGoalIncomplete: true,
          replacementPlanRequired: true,
          nextAllowedAction: "plan_replacement_execution",
        }),
      closeoutPath: relativeToWorkspace(root, closeoutPath),
      closeoutArtifactSha256: closeout.artifactSha256,
      releasedLeaseIds,
      authorizationGranted: false,
    };
  });
}
