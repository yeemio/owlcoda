import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDeploymentExecuteChildRun,
  createDeploymentExecuteLineage,
  createDeploymentPrepareReceipt,
  createDeploymentPrepareReceiptFromClosedRun,
  verifyDeploymentExecuteLineage,
} from "../scripts/runkit-contract/deployment-workflow.mjs";
import {
  createCoreArtifact,
  currentCoreIdentity,
} from "../scripts/runkit-contract/core-contract.mjs";
import {
  canonicalSourceFingerprint,
} from "../scripts/runkit-contract/source-fingerprint.mjs";
import {
  createOwnerDeploymentDecisionV1,
  ownerDeploymentDecisionBindingV1,
} from "../scripts/runkit-contract/owner-deployment-decision.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function objectHash(value) {
  return hash(canonicalJson(value));
}

function ownerDecision(overrides = {}) {
  return createOwnerDeploymentDecisionV1({
    decisionId: "owner-clean-install-001",
    decisionVersion: 1,
    provenance: {
      kind: "owner_explicit",
      sourceRef: "owner:test",
      recordedAt: "2026-08-01T08:00:00.000Z",
    },
    project: { projectId: "test-project", scope: "production" },
    supersedesDecisionSha256: null,
    deploymentMode: "clean_install",
    existingProjectAssets: "replace",
    legacyRollbackAllowed: false,
    dataAuthority: {
      mode: "preserve_existing",
      sourceRef: "owner:existing-data",
    },
    serviceActivationAuthorized: true,
    baselineCutAuthorized: true,
    destructiveScope: [],
    ...overrides,
  });
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function closedPrepareFixture({ bindDeliverySourceArtifact = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-prepare-run-"));
  const runId = "prepare-from-run-001";
  const executionRoot = path.join(root, ".owlcoda/runkit/executions", runId);
  const sourcePath = "src/release.mjs";
  const sourceBytes = "export const release = true;\n";
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, sourcePath), sourceBytes);
  const sourceFingerprint = canonicalSourceFingerprint({
    [sourcePath]: hash(sourceBytes),
  });
  await writeJson(path.join(executionRoot, "engine-pin.json"), currentCoreIdentity());
  await writeJson(path.join(executionRoot, "goal-contract.json"), {
    objective: "Build a deployable package without deployment authority.",
  });
  const packetPath = path.join(
    executionRoot,
    "delivery-packets/release.json",
  );
  await writeJson(packetPath, {
    schemaVersion: "OwlCodaRunKitDeliveryPacketV1",
    runId,
    changedFiles: {
      files: {
        [sourcePath]: hash(sourceBytes),
      },
    },
    productSourceFingerprint: {
      sha256: sourceFingerprint,
    },
  });
  const packetSha256 = hash(await readFile(packetPath));
  const closeout = createCoreArtifact({
    core: currentCoreIdentity(),
    producer: {
      adapterKind: "codex",
      adapterVersion: "0.1.0",
    },
    payload: {
      runId,
      decision: "accepted",
      authorizationGranted: false,
      verification: {
        contractVersion: "0.2",
        gateDecision: "accepted_passed",
        gateInputSha256: hash("gate-input"),
        activeReceiptSha256: hash("active-receipt"),
        sourceFingerprint,
        ...(bindDeliverySourceArtifact
          ? {
            sourceArtifact: {
              kind: "delivery_packet_v1",
              runId,
              path:
                `.owlcoda/runkit/executions/${runId}/`
                + "delivery-packets/release.json",
              sha256: packetSha256,
              sourceFingerprint,
            },
          }
          : {}),
        verificationContextFingerprint: hash("verification-context"),
        selectedProfileIds: ["release"],
        leaseState: "released",
        releasedLeaseIds: ["release"],
      },
    },
    extensions: {
      "dev.owlcoda.adapter.codex": {},
    },
  });
  await writeJson(path.join(executionRoot, "closeout-receipt.json"), closeout);
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/release.tgz"), "archive-bytes");
  return {
    root,
    runId,
    executionRoot,
    sourceFingerprint,
  };
}

function remoteTarget(overrides = {}) {
  return {
    schemaVersion: "OwlCodaRunKitRemoteTargetV1",
    targetId: "vm-production-01",
    environment: "production",
    host: "deploy.example.invalid",
    port: 22,
    user: "deploy",
    hostKeySha256: hash("host-key"),
    machineIdentitySha256: hash("machine-identity"),
    ...overrides,
  };
}

function prepareInput(overrides = {}) {
  const runId = "deployment-prepare-001";
  return {
    prepareRunId: runId,
    prepareGoal: {
      path: ".owlcoda/runkit/executions/deployment-prepare-001/goal-contract.json",
      sha256: hash("prepare-goal"),
    },
    trustedAcceptedCloseout: {
      trusted: true,
      decision: "accepted",
      runId,
      path: ".owlcoda/runkit/executions/deployment-prepare-001/closeout-receipt.json",
      sha256: hash("accepted-closeout"),
      gateInputSha256: hash("accepted-gate"),
      sourceFingerprint: hash("frozen-source"),
      authorizationGranted: false,
    },
    deliveryPacket: {
      runId,
      path: ".owlcoda/runkit/executions/deployment-prepare-001/delivery-packets/release.json",
      sha256: hash("delivery-packet"),
      sourceFingerprint: hash("frozen-source"),
    },
    artifact: {
      path: "dist/owlrunkit-0.16.0.tgz",
      sha256: hash("release-archive"),
      size: 48123,
      mediaType: "application/gzip",
    },
    ...overrides,
  };
}

function executeRequest(prepareReceipt, overrides = {}) {
  return {
    schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
    executeRunId: "deployment-execute-001",
    executeGoal: {
      path: ".owlcoda/runkit/executions/deployment-execute-001/goal-contract.json",
      sha256: hash("execute-goal"),
    },
    prepareReceiptSha256: prepareReceipt.receiptSha256,
    target: remoteTarget(),
    ownerAuthority: {
      authorityId: "owner-production-deploy-001",
      path: "authorities/owner-production-deploy-001.json",
      sha256: hash("independent-owner-authority"),
      permissions: {
        deploy: true,
        destructive: false,
      },
    },
    deploy: true,
    destructive: false,
    ...overrides,
  };
}

function remoteManifest(prepareReceipt, target) {
  return {
    schemaVersion: "OwlCodaRunKitRemoteDeploymentManifestV1",
    deploymentId: "deployment-execute-001",
    deploymentLineageSha256: null,
    mode: "first",
    target,
    adapter: {
      adapterId: "ssh-json",
      version: "1.0.0",
      executable: "/usr/local/bin/owlrunkit-ssh",
      sha256: hash("adapter"),
    },
    credentialRef: "keychain:owlcoda/deploy",
    artifact: prepareReceipt.artifact,
    upload: {
      remotePath: "/srv/releases/release.tgz",
      createOnly: true,
    },
    priorDeployment: null,
    expectedRemoteFiles: [],
    deletionAllowlist: [],
  };
}

function lineageInput(prepareReceipt, request) {
  const manifest = remoteManifest(prepareReceipt, request.target);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const {
    deploymentLineageSha256: _derivedLineage,
    ...manifestIntent
  } = manifest;
  request.ownerAuthority = {
    ...request.ownerAuthority,
    signerKeyId: "test-owner-key",
    trustStoreSha256: `sha256:${"7".repeat(64)}`,
    remoteManifestFileSha256: hash(bytes),
    remoteDeploymentIntentSha256: objectHash(manifestIntent),
  };
  return {
    prepareReceipt,
    executeRequest: request,
    remoteManifest: manifest,
    remoteManifestBytes: bytes,
  };
}

test("prepare receipt binds trusted accepted closeout, packet, and immutable artifact without deployment authority", () => {
  const receipt = createDeploymentPrepareReceipt(prepareInput());

  assert.equal(receipt.schemaVersion, "OwlCodaRunKitDeploymentPrepareReceiptV1");
  assert.equal(receipt.prepareRunId, "deployment-prepare-001");
  assert.equal(receipt.closeout.decision, "accepted");
  assert.equal(receipt.closeout.trusted, true);
  assert.equal(receipt.deliveryPacket.sha256, hash("delivery-packet"));
  assert.deepEqual(receipt.artifact, {
    path: "dist/owlrunkit-0.16.0.tgz",
    sha256: hash("release-archive"),
    size: 48123,
    mediaType: "application/gzip",
  });
  assert.deepEqual(receipt.permissions, {
    deploy: false,
    destructive: false,
  });
  assert.equal(receipt.authorizationGranted, false);
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
});

test("prepare derives all trusted bindings from one accepted run and one artifact", async () => {
  const fixture = await closedPrepareFixture();
  try {
    const receipt = createDeploymentPrepareReceiptFromClosedRun({
      workspaceRoot: fixture.root,
      prepareRunId: fixture.runId,
      artifactPath: "dist/release.tgz",
      mediaType: "application/gzip",
    });

    assert.equal(receipt.prepareRunId, fixture.runId);
    assert.equal(receipt.closeout.trusted, true);
    assert.equal(receipt.closeout.sourceFingerprint, fixture.sourceFingerprint);
    assert.equal(
      receipt.deliveryPacket.path,
      `.owlcoda/runkit/executions/${fixture.runId}/delivery-packets/release.json`,
    );
    assert.equal(receipt.artifact.sha256, hash("archive-bytes"));
    assert.equal(receipt.artifact.size, 13);
    assert.deepEqual(receipt.permissions, {
      deploy: false,
      destructive: false,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a closeout with an explicit DeliveryPacket source binding remains on the legacy prepare shape", async () => {
  const fixture = await closedPrepareFixture({
    bindDeliverySourceArtifact: true,
  });
  try {
    const receipt = createDeploymentPrepareReceiptFromClosedRun({
      workspaceRoot: fixture.root,
      prepareRunId: fixture.runId,
      artifactPath: "dist/release.tgz",
      mediaType: "application/gzip",
    });

    assert.equal(receipt.sourceArtifact, undefined);
    assert.equal(receipt.deliveryPacket.runId, fixture.runId);
    assert.equal(
      receipt.closeout.sourceArtifact.kind,
      "delivery_packet_v1",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("prepare-from-run rejects a closeout whose accepted evidence was altered", async () => {
  const fixture = await closedPrepareFixture();
  try {
    const closeoutPath = path.join(
      fixture.executionRoot,
      "closeout-receipt.json",
    );
    const closeout = JSON.parse(await readFile(closeoutPath, "utf8"));
    closeout.artifact.payload.verification.sourceFingerprint = hash("tampered");
    await writeFile(closeoutPath, `${JSON.stringify(closeout, null, 2)}\n`);

    assert.throws(
      () => createDeploymentPrepareReceiptFromClosedRun({
        workspaceRoot: fixture.root,
        prepareRunId: fixture.runId,
        artifactPath: "dist/release.tgz",
        mediaType: "application/gzip",
      }),
      /trusted accepted closeout/u,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("prepare rejects anything other than a trusted accepted non-authorizing closeout", () => {
  for (const closeout of [
    { trusted: false },
    { decision: "blocked" },
    { authorizationGranted: true },
  ]) {
    assert.throws(
      () => createDeploymentPrepareReceipt(prepareInput({
        trustedAcceptedCloseout: {
          ...prepareInput().trustedAcceptedCloseout,
          ...closeout,
        },
      })),
      /trusted accepted closeout|must not grant deployment authority/,
    );
  }
});

test("execute creates a new child run and goal bound to an exact target and independent Owner authority", () => {
  const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
  const request = executeRequest(prepareReceipt);
  const input = lineageInput(prepareReceipt, request);
  const lineage = createDeploymentExecuteLineage(input);

  assert.equal(lineage.schemaVersion, "OwlCodaRunKitDeploymentLineageV1");
  assert.equal(lineage.parent.prepareRunId, prepareReceipt.prepareRunId);
  assert.equal(lineage.child.executeRunId, request.executeRunId);
  assert.notEqual(lineage.child.executeGoal.sha256, prepareReceipt.prepareGoal.sha256);
  assert.deepEqual(lineage.target.value, request.target);
  assert.match(lineage.target.sha256, /^[a-f0-9]{64}$/);
  assert.equal(lineage.authority.source, "owner");
  assert.equal(lineage.authority.inheritedFromPrepare, false);
  assert.equal(lineage.authority.sha256, request.ownerAuthority.sha256);
  assert.equal(lineage.permissions.deploy, true);
  assert.equal(lineage.permissions.destructive, false);
  assert.equal(
    verifyDeploymentExecuteLineage({ lineage, ...input }).status,
    "valid",
  );
});

test("SourceCandidate V2 remains a first-class source artifact through prepare and deployment lineage", () => {
  const input = prepareInput();
  delete input.deliveryPacket;
  input.sourceArtifact = {
    kind: "source_candidate_v2",
    runId: input.prepareRunId,
    path:
      ".owlcoda/runkit/executions/deployment-prepare-001/"
      + "source-candidates/formal-final.json",
    sha256: hash("source-candidate-file"),
    sourceFingerprint: hash("frozen-source"),
  };
  input.trustedAcceptedCloseout.sourceArtifact =
    structuredClone(input.sourceArtifact);
  const prepareReceipt = createDeploymentPrepareReceipt(input);
  assert.equal(prepareReceipt.deliveryPacket, undefined);
  assert.deepEqual(prepareReceipt.sourceArtifact, input.sourceArtifact);

  const request = executeRequest(prepareReceipt);
  const lineageArgs = lineageInput(prepareReceipt, request);
  const lineage = createDeploymentExecuteLineage(lineageArgs);
  assert.equal(lineage.parent.deliveryPacketSha256, undefined);
  assert.deepEqual(lineage.parent.sourceArtifact, input.sourceArtifact);
  assert.equal(
    verifyDeploymentExecuteLineage({
      lineage,
      ...lineageArgs,
    }).status,
    "valid",
  );
});

test("execute authority binds the exact bytes and canonical contents of the complete remote manifest", () => {
  const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
  const request = executeRequest(prepareReceipt);
  const manifest = remoteManifest(prepareReceipt, request.target);
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const {
    deploymentLineageSha256: _derivedLineage,
    ...manifestIntent
  } = manifest;
  request.ownerAuthority = {
    ...request.ownerAuthority,
    signerKeyId: "test-owner-key",
    trustStoreSha256: `sha256:${"7".repeat(64)}`,
    remoteManifestFileSha256: hash(manifestBytes),
    remoteDeploymentIntentSha256: objectHash(manifestIntent),
  };

  const lineage = createDeploymentExecuteLineage({
    prepareReceipt,
    executeRequest: request,
    remoteManifest: manifest,
    remoteManifestBytes: manifestBytes,
  });
  assert.equal(
    lineage.authority.remoteManifestFileSha256,
    hash(manifestBytes),
  );
  assert.equal(
    lineage.authority.remoteDeploymentIntentSha256,
    objectHash(manifestIntent),
  );

  assert.throws(
    () => createDeploymentExecuteLineage({
      prepareReceipt,
      executeRequest: request,
      remoteManifest: {
        ...manifest,
        upload: {
          ...manifest.upload,
          remotePath: "/srv/releases/other.tgz",
        },
      },
      remoteManifestBytes: manifestBytes,
    }),
    /remote manifest/u,
  );
});

test("execute refuses same-run, same-goal, inherited, or non-independent authority", () => {
  const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
  const base = executeRequest(prepareReceipt);
  const invalidRequests = [
    { ...base, executeRunId: prepareReceipt.prepareRunId },
    { ...base, executeGoal: prepareReceipt.prepareGoal },
    {
      ...base,
      ownerAuthority: {
        ...base.ownerAuthority,
        sha256: prepareReceipt.closeout.sha256,
      },
    },
    { ...base, inheritedAuthorization: true },
  ];

  for (const request of invalidRequests) {
    assert.throws(
      () => createDeploymentExecuteLineage({
        ...lineageInput(prepareReceipt, request),
      }),
      /new child run|new goal|independent|unsupported field/,
    );
  }
});

test("lineage verification fails closed when target or upstream bindings drift", () => {
  const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
  const request = executeRequest(prepareReceipt);
  const input = lineageInput(prepareReceipt, request);
  const lineage = createDeploymentExecuteLineage(input);
  const tampered = structuredClone(lineage);
  tampered.target.value.host = "other.example.invalid";

  const targetDrift = verifyDeploymentExecuteLineage({
    lineage: tampered,
    ...input,
  });
  assert.equal(targetDrift.status, "invalid");
  assert.match(targetDrift.issues.join("\n"), /target|lineage hash/);

  const changedPrepare = structuredClone(prepareReceipt);
  changedPrepare.artifact.sha256 = hash("other-archive");
  const prepareDrift = verifyDeploymentExecuteLineage({
    lineage,
    prepareReceipt: changedPrepare,
    executeRequest: input.executeRequest,
    remoteManifest: input.remoteManifest,
    remoteManifestBytes: input.remoteManifestBytes,
  });
  assert.equal(prepareDrift.status, "invalid");
  assert.match(prepareDrift.issues.join("\n"), /prepare receipt/);
});

test("Owner decision conflict creates no deployment child, lease, or remote command surface", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-owner-decision-conflict-"));
  try {
    const decision = ownerDecision();
    const decisionPath = "authorities/owner-decision-001.json";
    await writeJson(path.join(root, decisionPath), decision);
    const decisionBytes = await readFile(path.join(root, decisionPath));
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput({
      ownerDecision: ownerDeploymentDecisionBindingV1(decision),
    }));
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/owlrunkit-0.16.0.tgz"), "archive");
    const manifest = remoteManifest(prepareReceipt, remoteTarget());
    manifest.mode = "update";
    manifest.ownerDecision = ownerDeploymentDecisionBindingV1(decision);
    manifest.serviceActivation = decision.serviceActivationAuthorized;
    manifest.baselineCut = decision.baselineCutAuthorized;
    manifest.priorDeployment = {
      receiptSha256: hash("prior-receipt"),
      artifactSha256: hash("prior-artifact"),
    };
    manifest.expectedRemoteFiles = [{
      path: "/srv/owlfootball/current",
      sha256: hash("prior-file"),
    }];
    const authority = {
      schemaVersion: "OwlCodaRunKitOwnerDeploymentAuthorityV2",
      authorityId: "owner-execute-conflict-001",
      decision: "approved",
      scope: "execute_exact_remote_deployment",
      executeRunId: manifest.deploymentId,
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      ownerDecisionId: decision.decisionId,
      ownerDecisionSha256: decision.decisionSha256,
      targetSha256: objectHash(manifest.target),
      artifactSha256: prepareReceipt.artifact.sha256,
      remoteManifestFileSha256: hash(`${JSON.stringify(manifest, null, 2)}\n`),
      remoteDeploymentIntentSha256: hash("intent"),
      signerKeyId: "owner-key",
      signatureAlgorithm: "ed25519",
      permissions: { deploy: true, destructive: false },
      authorizationGranted: false,
      authoritySha256: `sha256:${hash("authority")}`,
      signature: Buffer.alloc(64).toString("base64"),
    };
    const authorityPath = "authorities/owner-execute-conflict-001.json";
    await writeJson(path.join(root, authorityPath), authority);
    const authorityBytes = await readFile(path.join(root, authorityPath));

    assert.throws(
      () => createDeploymentExecuteChildRun({
        workspaceRoot: root,
        prepareReceipt,
        remoteManifest: manifest,
        ownerDecision: {
          path: decisionPath,
          sha256: hash(decisionBytes),
        },
        ownerAuthority: {
          path: authorityPath,
          sha256: hash(authorityBytes),
        },
      }),
      error => error.code === "owner_decision_conflict",
    );
    assert.equal(
      await import("node:fs").then(({ existsSync }) => existsSync(path.join(
        root,
        ".owlcoda/runkit/executions/deployment-execute-001",
      ))),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
