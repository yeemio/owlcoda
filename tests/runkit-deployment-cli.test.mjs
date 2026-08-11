import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";
import {
  createDeploymentExecuteChildRun,
  createDeploymentExecuteLineageFromActiveRun,
  createDeploymentPrepareReceipt,
} from "../scripts/runkit-contract/deployment-workflow.mjs";
import {
  createCoreArtifact,
  currentCoreIdentity,
} from "../scripts/runkit-contract/core-contract.mjs";
import {
  canonicalSourceFingerprint,
} from "../scripts/runkit-contract/source-fingerprint.mjs";
import {
  createRemoteDeploymentStageJournalV1,
} from "../scripts/runkit-contract/remote-deployment.mjs";
import {
  builtInSshRemoteAdapterIdentityV1,
} from "../scripts/runkit-contract/ssh-remote-adapter.mjs";
import {
  buildResourcePreflight,
} from "../scripts/runkit-contract/resource-preflight.mjs";
import {
  ownerAuthorityArtifactSha256V1,
} from "../scripts/runkit-contract/owner-authority-trust.mjs";
import {
  createOwnerDeploymentDecisionV1,
  ownerDeploymentDecisionBindingV1,
} from "../scripts/runkit-contract/owner-deployment-decision.mjs";

function sha256(value) {
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
  return sha256(canonicalJson(value));
}

const TEST_OWNER_DECISION = createOwnerDeploymentDecisionV1({
  decisionId: "owner-test-deployment-001",
  decisionVersion: 1,
  provenance: {
    kind: "owner_explicit",
    sourceRef: "owner:test-suite",
    recordedAt: "2026-08-01T08:00:00.000Z",
  },
  project: { projectId: "test-project", scope: "production" },
  supersedesDecisionSha256: null,
  deploymentMode: "clean_install",
  existingProjectAssets: "preserve",
  legacyRollbackAllowed: false,
  dataAuthority: {
    mode: "preserve_existing",
    sourceRef: "owner:test-data",
  },
  serviceActivationAuthorized: true,
  baselineCutAuthorized: false,
  destructiveScope: [],
});
const TEST_OWNER_DECISION_PATH = "authorities/owner-decision-001.json";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function ownerDeploymentAuthority(root, {
  executeRunId,
  prepareReceipt,
  target,
  remoteManifest,
  destructive = false,
}) {
  await writeJson(
    path.join(root, TEST_OWNER_DECISION_PATH),
    TEST_OWNER_DECISION,
  );
  const remoteManifestBytes = Buffer.from(
    `${JSON.stringify(remoteManifest, null, 2)}\n`,
  );
  const {
    deploymentLineageSha256: _derivedLineage,
    ...remoteDeploymentIntent
  } = remoteManifest;
  const body = {
    schemaVersion: "OwlCodaRunKitOwnerDeploymentAuthorityV2",
    authorityId: `owner-${executeRunId}`,
    decision: "approved",
    scope: "execute_exact_remote_deployment",
    executeRunId,
    prepareReceiptSha256: prepareReceipt.receiptSha256,
    ownerDecisionId: TEST_OWNER_DECISION.decisionId,
    ownerDecisionSha256: TEST_OWNER_DECISION.decisionSha256,
    targetSha256: objectHash(target),
    artifactSha256: prepareReceipt.artifact.sha256,
    remoteManifestFileSha256: sha256(remoteManifestBytes),
    remoteDeploymentIntentSha256: objectHash(remoteDeploymentIntent),
    signerKeyId: "test-owner-key",
    signatureAlgorithm: "ed25519",
    permissions: {
      deploy: true,
      destructive,
    },
    authorizationGranted: false,
  };
  const authority = {
    ...body,
    authoritySha256: ownerAuthorityArtifactSha256V1(body),
    signature: Buffer.alloc(64, 7).toString("base64"),
  };
  const relativePath = `authorities/${executeRunId}.json`;
  const absolutePath = path.join(root, relativePath);
  await writeJson(absolutePath, authority);
  return {
    path: relativePath,
    sha256: sha256(await readFile(absolutePath)),
  };
}

function trustedOwnerDeploymentAuthorityHook(onVerify) {
  let verificationCount = 0;
  return {
    verifyOwnerDeploymentAuthority({ authority }) {
      verificationCount += 1;
      onVerify?.({ authority, verificationCount });
      return {
        status: "trusted",
        signerKeyId: authority.signerKeyId,
        authoritySha256: authority.authoritySha256,
        trustStoreSha256: `sha256:${"7".repeat(64)}`,
      };
    },
  };
}

async function activeDeploymentExecution(root, {
  executeRequest,
  prepareReceipt,
}) {
  executeRequest.ownerDecision = {
    path: TEST_OWNER_DECISION_PATH,
    sha256: sha256(await readFile(path.join(root, TEST_OWNER_DECISION_PATH))),
  };
  const executionRoot = path.join(
    root,
    ".owlcoda/runkit/executions",
    executeRequest.executeRunId,
  );
  const deploymentRoot = path.join(
    root,
    ".owlcoda/runkit/deployments",
    executeRequest.executeRunId,
  );
  await mkdir(deploymentRoot, { recursive: true });
  const decisionSnapshotPath = path.join(
    deploymentRoot,
    "owner-decision-snapshot.json",
  );
  await writeJson(decisionSnapshotPath, TEST_OWNER_DECISION);
  executeRequest.ownerDecisionSnapshot = {
    path:
      `.owlcoda/runkit/deployments/${executeRequest.executeRunId}`
      + "/owner-decision-snapshot.json",
    sha256: sha256(await readFile(decisionSnapshotPath)),
  };
  await mkdir(path.join(executionRoot, "leases"), { recursive: true });
  await mkdir(path.join(executionRoot, "verification-plans"), { recursive: true });
  await mkdir(path.join(executionRoot, "resource-preflights"), { recursive: true });
  const goal = {
    schemaVersion: "OwlCodaRunKitGoalContractV1",
    objective: "Execute one exact remote deployment.",
    nonGoals: [],
    authorization: {
      git: false,
      publish: false,
      deploy: true,
      destructive: executeRequest.destructive,
    },
    deployment: {
      phase: "execute",
      prepareRunId: prepareReceipt.prepareRunId,
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      targetSha256: objectHash(executeRequest.target),
      ownerDecision: ownerDeploymentDecisionBindingV1(TEST_OWNER_DECISION),
    },
  };
  const goalPath = path.join(executionRoot, "goal-contract.json");
  await writeJson(goalPath, goal);
  executeRequest.executeGoal = {
    path: `.owlcoda/runkit/executions/${executeRequest.executeRunId}/goal-contract.json`,
    sha256: sha256(await readFile(goalPath)),
  };
  await writeJson(path.join(executionRoot, "engine-pin.json"), currentCoreIdentity());
  await writeJson(path.join(executionRoot, "execution-plan.json"), {
    schemaVersion: "OwlCodaRunKitExecutionPlanV1",
    runId: executeRequest.executeRunId,
    state: "planned",
    enginePin: currentCoreIdentity(),
    goalContractSha256: executeRequest.executeGoal.sha256,
    ownerDecisionSha256: TEST_OWNER_DECISION.decisionSha256,
    ownerDecisionSnapshot: executeRequest.ownerDecisionSnapshot,
    authorizationGranted: false,
  });
  executeRequest.workItemId = "deployment-execute";
  await writeJson(
    path.join(executionRoot, "leases/deployment-execute-attempt-001.json"),
    {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId: executeRequest.workItemId,
      attempt: 1,
      ownedPaths: ["dist/release.tgz"],
      state: "active",
    },
  );
  executeRequest.profileId = "deployment";
  await writeJson(path.join(root, ".owlcoda/runkit/profiles.json"), {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: [{
      id: executeRequest.profileId,
      paths: ["dist/**"],
      role: "primary",
      primary: true,
      requiresProfileIds: [],
      commands: [],
    }],
  });
  const verificationPlan = {
    schemaVersion: "OwlCodaRunKitVerificationPlanV1",
    runId: executeRequest.executeRunId,
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
      primaryProfileId: executeRequest.profileId,
      directProfileIds: [executeRequest.profileId],
      transitiveProfileIds: [],
      supportingProfileIds: [],
      selectedProfileIds: [executeRequest.profileId],
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
    verificationContextFingerprint: sha256("deployment-verification-context"),
  };
  const verificationPlanPath = path.join(
    executionRoot,
    "verification-plans/deployment-execute-plan.json",
  );
  await writeJson(verificationPlanPath, verificationPlan);
  const preflight = buildResourcePreflight({
    runId: executeRequest.executeRunId,
    request: {
      schemaVersion: "OwlCodaRunKitResourcePreflightRequestV1",
      preflightId: "deployment-execute-preflight",
      verificationPlanPath:
        `.owlcoda/runkit/executions/${executeRequest.executeRunId}`
        + "/verification-plans/deployment-execute-plan.json",
      verificationPlanSha256: sha256(await readFile(verificationPlanPath)),
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
          id: "deterministic-deployment",
          kind: "project_declared",
          evidenceRef: "local:deployment",
          evidenceSha256: sha256("deterministic-deployment"),
          observedAt: "2026-07-31T00:00:00.000Z",
        },
        availability: {
          status: "available",
        },
        quota: {
          remainingCalls: { status: "known", value: 0 },
          remainingTokens: { status: "known", value: 0 },
          resetAt: { status: "known", value: "2026-08-01T00:00:00.000Z" },
        },
        pricing: {
          status: "known",
          currency: "USD",
          inputPerMillion: 0,
          outputPerMillion: 0,
        },
      }],
      workloads: [],
    },
    verificationPlan,
    requestSha256: sha256("deployment-preflight-request"),
    evaluatedAt: "2026-07-31T00:00:00.000Z",
  });
  const preflightPath = path.join(
    executionRoot,
    "resource-preflights/deployment-execute-preflight.json",
  );
  await writeJson(preflightPath, preflight);
  executeRequest.resourcePreflight = {
    path:
      `.owlcoda/runkit/executions/${executeRequest.executeRunId}`
      + "/resource-preflights/deployment-execute-preflight.json",
    sha256: sha256(await readFile(preflightPath)),
  };
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/release.tgz"), "archive");
}

function prepareInput() {
  return {
    prepareRunId: "prepare-001",
    prepareGoal: {
      path: ".owlcoda/runkit/executions/prepare-001/goal-contract.json",
      sha256: sha256("prepare-goal"),
    },
    trustedAcceptedCloseout: {
      trusted: true,
      decision: "accepted",
      runId: "prepare-001",
      path: ".owlcoda/runkit/executions/prepare-001/closeout-receipt.json",
      sha256: sha256("closeout"),
      gateInputSha256: sha256("gate"),
      sourceFingerprint: sha256("source"),
      authorizationGranted: false,
    },
    deliveryPacket: {
      runId: "prepare-001",
      path: ".owlcoda/runkit/executions/prepare-001/delivery-packets/release.json",
      sha256: sha256("packet"),
      sourceFingerprint: sha256("source"),
    },
    artifact: {
      path: "dist/release.tgz",
      sha256: sha256("archive"),
      size: 7,
      mediaType: "application/gzip",
    },
    ownerDecision: ownerDeploymentDecisionBindingV1(TEST_OWNER_DECISION),
  };
}

async function adapter(root) {
  const ref = path.join(root, "adapter.mjs");
  const source = `#!/usr/bin/env node
let bytes = "";
for await (const chunk of process.stdin) bytes += chunk;
const input = JSON.parse(bytes);
let output;
if (input.stage === "identity_preflight") {
  output = {
    status: "passed",
    hostKeySha256: input.target.hostKeySha256,
    machineIdentitySha256: input.target.machineIdentitySha256
  };
} else if (input.stage === "upload") {
  output = {
    status: "created",
    remotePath: input.upload.remotePath,
    sha256: input.artifact.sha256,
    size: input.artifact.size
  };
} else if (input.stage === "verify_remote_hashes") {
  output = {
    status: "passed",
    remotePath: input.upload.remotePath,
    sha256: input.artifact.sha256,
    size: input.artifact.size
  };
} else {
  output = { status: "passed", evidenceSha256: "${sha256("stage")}" };
}
process.stdout.write(JSON.stringify(output));
`;
  await writeFile(ref, source);
  await chmod(ref, 0o755);
  return { ref: await realpath(ref), sha256: sha256(source) };
}

function sshStageContracts() {
  return {
    install: {
      archiveFormat: "tar_gzip",
      releaseRoot: "/opt/owlapp/releases",
      currentSymlink: "/opt/owlapp/current",
    },
    systemd: {
      unitName: "owlapp.service",
      unitFile: {
        sourcePath: "deploy/owlapp.service",
        destinationPath: "/etc/systemd/system/owlapp.service",
        sha256: sha256("systemd-unit"),
      },
      daemonReload: true,
      enable: true,
      restart: true,
    },
    nginx: {
      siteName: "owlapp",
      configFile: {
        sourcePath: "deploy/owlapp.nginx.conf",
        destinationPath: "/etc/nginx/sites-available/owlapp.conf",
        sha256: sha256("nginx-config"),
      },
      enabledLinkPath: "/etc/nginx/sites-enabled/owlapp.conf",
      configTest: true,
      reload: true,
    },
    smoke: {
      checks: [{
        checkId: "service-active",
        kind: "systemd_active",
        unitName: "owlapp.service",
      }],
    },
  };
}

async function builtInSshManifestFixture(root, {
  executeRunId,
  target,
  artifact,
}) {
  const knownHostsPath = path.join(root, "deploy-known-hosts");
  const knownHosts = `${target.host} ssh-ed25519 AAAATESTKEY\n`;
  await writeFile(knownHostsPath, knownHosts);
  target.hostKeySha256 = sha256(knownHosts);
  const sshPath = path.join(root, "ssh");
  const sshSource = `#!/usr/bin/env node
let bytes = "";
for await (const chunk of process.stdin) bytes += chunk;
const input = JSON.parse(bytes);
let output;
if (input.stage === "identity_preflight") {
  output = {
    status: "passed",
    machineIdentitySha256: input.expectedMachineIdentitySha256,
    remoteHelper: input.expectedRemoteHelper
  };
} else if (input.stage === "upload") {
  output = {
    status: "created",
    remotePath: input.remotePath,
    sha256: input.artifact.sha256,
    size: input.artifact.size
  };
} else if (input.stage === "verify_remote_hashes") {
  output = {
    status: "passed",
    remotePath: input.remotePath,
    sha256: input.artifact.sha256,
    size: input.artifact.size,
    verifiedPriorFiles: input.expectedRemoteFiles
  };
} else if (input.stage === "install") {
  output = {
    status: "passed",
    mode: input.mode,
    installedArtifactSha256: input.artifact.sha256,
    deletedFiles: input.deletionAllowlist,
    evidenceSha256: "${sha256("install")}"
  };
} else if (input.stage === "service") {
  output = {
    status: "passed",
    unitName: input.contract.unitName,
    unitFileSha256: input.contract.unitFile.sha256,
    evidenceSha256: "${sha256("service")}"
  };
} else if (input.stage === "proxy") {
  output = {
    status: "passed",
    siteName: input.contract.siteName,
    configFileSha256: input.contract.configFile.sha256,
    evidenceSha256: "${sha256("proxy")}"
  };
} else {
  output = {
    status: "passed",
    checks: input.contract.checks.map(({ checkId }) => ({
      checkId,
      status: "passed",
      evidenceSha256: "${sha256("smoke-check")}"
    })),
    evidenceSha256: "${sha256("smoke")}"
  };
}
process.stdout.write(JSON.stringify(output));
`;
  await writeFile(sshPath, sshSource);
  await chmod(sshPath, 0o755);
  const sshExecutable = await realpath(sshPath);
  return {
    schemaVersion: "OwlCodaRunKitRemoteDeploymentManifestV1",
    deploymentId: executeRunId,
    deploymentLineageSha256: null,
    mode: "first",
    ownerDecision: ownerDeploymentDecisionBindingV1(TEST_OWNER_DECISION),
    serviceActivation: TEST_OWNER_DECISION.serviceActivationAuthorized,
    baselineCut: TEST_OWNER_DECISION.baselineCutAuthorized,
    target,
    adapter: {
      kind: "builtin_ssh",
      ...builtInSshRemoteAdapterIdentityV1(),
      knownHostsPath: await realpath(knownHostsPath),
      sshExecutable,
      sshExecutableSha256: sha256(sshSource),
      remoteHelper: {
        path: "/usr/local/libexec/owlrunkit-remote-helper",
        protocol: "OwlCodaRunKitSshRemoteHelperV1",
        version: "1.0.0",
        capabilities: ["execute", "reconcile"],
      },
      authentication: {
        mode: "agent",
        identityFile: null,
      },
      stageContracts: sshStageContracts(),
    },
    credentialRef: "agent:ssh/default",
    artifact,
    upload: {
      remotePath: "/var/lib/owlcoda/staging/release.tgz",
      createOnly: true,
    },
    priorDeployment: null,
    expectedRemoteFiles: [],
    deletionAllowlist: [],
  };
}

async function remoteManifestFixture(root, {
  executeRunId,
  target,
  artifact,
}) {
  const executable = await adapter(root);
  return {
    schemaVersion: "OwlCodaRunKitRemoteDeploymentManifestV1",
    deploymentId: executeRunId,
    deploymentLineageSha256: null,
    mode: "first",
    ownerDecision: ownerDeploymentDecisionBindingV1(TEST_OWNER_DECISION),
    serviceActivation: TEST_OWNER_DECISION.serviceActivationAuthorized,
    baselineCut: TEST_OWNER_DECISION.baselineCutAuthorized,
    target,
    adapter: {
      adapterId: "fixture-adapter",
      version: "1.0.0",
      executable: executable.ref,
      sha256: executable.sha256,
    },
    credentialRef: "agent:ssh/default",
    artifact,
    upload: {
      remotePath: "/var/lib/owlcoda/staging/release.tgz",
      createOnly: true,
    },
    priorDeployment: null,
    expectedRemoteFiles: [],
    deletionAllowlist: [],
  };
}

async function acceptedPrepareRun(root) {
  const runId = "prepare-auto-001";
  await writeJson(
    path.join(root, TEST_OWNER_DECISION_PATH),
    TEST_OWNER_DECISION,
  );
  const executionRoot = path.join(
    root,
    ".owlcoda/runkit/executions",
    runId,
  );
  const sourcePath = "src/release.mjs";
  const sourceBytes = "export const release = true;\n";
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, sourcePath), sourceBytes);
  const sourceFingerprint = canonicalSourceFingerprint({
    [sourcePath]: sha256(sourceBytes),
  });
  await writeJson(path.join(executionRoot, "engine-pin.json"), currentCoreIdentity());
  await writeJson(path.join(executionRoot, "goal-contract.json"), {
    objective: "Prepare a deployment artifact.",
  });
  await writeJson(
    path.join(executionRoot, "delivery-packets/release.json"),
    {
      runId,
      changedFiles: {
        files: {
          [sourcePath]: sha256(sourceBytes),
        },
      },
      productSourceFingerprint: {
        sha256: sourceFingerprint,
      },
    },
  );
  await writeJson(
    path.join(executionRoot, "closeout-receipt.json"),
    createCoreArtifact({
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
          gateInputSha256: sha256("gate"),
          activeReceiptSha256: sha256("active-receipt"),
          sourceFingerprint,
          verificationContextFingerprint: sha256("verification-context"),
          selectedProfileIds: ["release"],
          leaseState: "released",
          releasedLeaseIds: ["release"],
        },
      },
      extensions: {
        "dev.owlcoda.adapter.codex": {},
      },
    }),
  );
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "dist/release.tgz"), "archive");
  return runId;
}

test("deployment prepare derives accepted run bindings without a hand-built request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-auto-"));
  try {
    const runId = await acceptedPrepareRun(root);
    const prepared = await runCli([
      "deployment",
      "prepare",
      "--workspace",
      root,
      "--run-id",
      runId,
      "--artifact",
      "dist/release.tgz",
      "--media-type",
      "application/gzip",
      "--owner-decision",
      TEST_OWNER_DECISION_PATH,
      "--output",
      ".owlcoda/runkit/deployments/prepare.json",
    ]);

    assert.equal(prepared.status, "deployment_prepared");
    const receipt = JSON.parse(await readFile(
      path.join(root, prepared.receiptPath),
      "utf8",
    ));
    assert.equal(receipt.prepareRunId, runId);
    assert.equal(receipt.closeout.trusted, true);
    assert.equal(receipt.artifact.sha256, sha256("archive"));
    assert.equal(receipt.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment prepare and execute form a two-command lineage-bound remote workflow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-cli-"));
  try {
    const prepareRequest = path.join(root, "prepare-request.json");
    await writeJson(prepareRequest, prepareInput());
    const prepared = await runCli([
      "deployment",
      "prepare",
      "--workspace",
      root,
      "--request",
      prepareRequest,
      "--output",
      ".owlcoda/runkit/deployments/prepare.json",
    ]);
    assert.equal(prepared.status, "deployment_prepared");
    const prepareReceipt = JSON.parse(await readFile(
      path.join(root, prepared.receiptPath),
      "utf8",
    ));
    assert.deepEqual(prepareReceipt, createDeploymentPrepareReceipt(prepareInput()));

    const executeRequest = {
      schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
      executeRunId: "execute-001",
      executeGoal: {
        path: ".owlcoda/runkit/executions/execute-001/goal-contract.json",
        sha256: sha256("execute-goal"),
      },
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      target: {
        schemaVersion: "OwlCodaRunKitRemoteTargetV1",
        targetId: "vm-01",
        environment: "production",
        host: "deploy.example.invalid",
        port: 22,
        user: "deploy",
        hostKeySha256: sha256("host-key"),
        machineIdentitySha256: sha256("machine"),
      },
      ownerAuthority: null,
      deploy: true,
      destructive: false,
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId: executeRequest.executeRunId,
      target: executeRequest.target,
      artifact: prepareReceipt.artifact,
    });
    executeRequest.ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId: executeRequest.executeRunId,
      prepareReceipt,
      target: executeRequest.target,
      remoteManifest: manifest,
    });
    await activeDeploymentExecution(root, {
      executeRequest,
      prepareReceipt,
    });
    const executeRequestPath = path.join(root, "execute-request.json");
    await writeJson(executeRequestPath, executeRequest);
    const manifestPath = path.join(root, "remote-manifest.json");
    await writeJson(manifestPath, manifest);

    let authorityVerificationCount = 0;
    const executed = await runCli([
      "deployment",
      "execute",
      "--workspace",
      root,
      "--prepare",
      prepared.receiptPath,
      "--request",
      executeRequestPath,
      "--manifest",
      manifestPath,
      "--lineage-output",
      ".owlcoda/runkit/deployments/lineage.json",
      "--output",
      ".owlcoda/runkit/deployments/result.json",
    ], trustedOwnerDeploymentAuthorityHook(() => {
      authorityVerificationCount += 1;
    }));
    assert.equal(executed.status, "deployed", JSON.stringify(executed));
    assert.equal(executed.completedStages.length, 7);
    assert.equal(authorityVerificationCount, 8);
    assert.equal(executed.authorizationGranted, false);
    const lineage = JSON.parse(await readFile(
      path.join(root, executed.lineagePath),
      "utf8",
    ));
    assert.equal(
      lineage.child.control.deploymentParent.prepareReceiptSha256,
      prepareReceipt.receiptSha256,
    );
    assert.equal(
      lineage.child.control.lease.workItemId,
      executeRequest.workItemId,
    );
    assert.equal(
      lineage.child.control.profile.profileId,
      executeRequest.profileId,
    );
    assert.equal(
      lineage.child.control.resourcePreflight.decision,
      "ready_without_model_execution",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(root, executed.resultPath), "utf8")).status,
      "deployed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute creates and closes the linked child from prepare, signed authority, and manifest alone", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-happy-path-"));
  try {
    const prepareRequestPath = path.join(root, "prepare-request.json");
    await writeJson(prepareRequestPath, prepareInput());
    const prepared = await runCli([
      "deployment",
      "prepare",
      "--workspace",
      root,
      "--request",
      prepareRequestPath,
      "--output",
      ".owlcoda/runkit/deployments/prepare.json",
    ]);
    const prepareReceipt = JSON.parse(await readFile(
      path.join(root, prepared.receiptPath),
      "utf8",
    ));
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/release.tgz"), "archive");
    const executeRunId = "execute-happy-001";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    const ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    const manifestPath = path.join(root, "remote-manifest.json");
    await writeJson(manifestPath, manifest);

    let authorityVerificationCount = 0;
    const executed = await runCli([
      "deployment",
      "execute",
      "--workspace",
      root,
      "--prepare",
      prepared.receiptPath,
      "--owner-decision",
      TEST_OWNER_DECISION_PATH,
      "--owner-authority",
      ownerAuthority.path,
      "--manifest",
      manifestPath,
    ], trustedOwnerDeploymentAuthorityHook(() => {
      authorityVerificationCount += 1;
    }));

    assert.equal(executed.status, "deployed", JSON.stringify(executed));
    assert.equal(authorityVerificationCount, 9);
    assert.equal(executed.runId, executeRunId);
    assert.equal(executed.closeoutDecision, "accepted");
    assert.equal(executed.releasedLeaseIds.length, 1);
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions",
      executeRunId,
    );
    const generatedRequest = JSON.parse(await readFile(
      path.join(root, executed.executeRequestPath),
      "utf8",
    ));
    assert.equal(generatedRequest.executeRunId, executeRunId);
    assert.equal(generatedRequest.prepareReceiptSha256, prepareReceipt.receiptSha256);
    assert.deepEqual(generatedRequest.ownerAuthority, ownerAuthority);
    assert.equal(generatedRequest.workItemId, "deployment-execute");
    assert.equal(generatedRequest.profileId, "deployment-execute");
    assert.equal(generatedRequest.deploy, true);
    assert.equal(generatedRequest.destructive, false);
    assert.equal(
      JSON.parse(await readFile(path.join(executionRoot, "goal-contract.json"), "utf8"))
        .deployment.prepareReceiptSha256,
      prepareReceipt.receiptSha256,
    );
    assert.equal(
      JSON.parse(await readFile(
        path.join(executionRoot, "leases/deployment-execute-attempt-001.json"),
        "utf8",
      )).state,
      "released",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(executionRoot, "closeout-receipt.json"), "utf8"))
        .artifact.payload.decision,
      "accepted",
    );
    for (const relativePath of [
      "engine-pin.json",
      "execution-plan.json",
      "deployment-profile.json",
      "verification-plans/deployment-execute-plan.json",
      "resource-preflights/deployment-execute-preflight.json",
    ]) {
      assert.equal(
        await readFile(path.join(executionRoot, relativePath), "utf8")
          .then(() => true),
        true,
      );
    }
    const inspected = await runCli([
      "inspect",
      "--workspace",
      root,
      "--json",
    ]);
    assert.deepEqual(inspected.controlState.activeRunIds, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute --resume reuses the existing child, lineage, and create-only stage journal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-resume-"));
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    const preparePath = ".owlcoda/runkit/deployments/prepare.json";
    await writeJson(path.join(root, preparePath), prepareReceipt);
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/release.tgz"), "archive");
    const executeRunId = "execute-resume-001";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    const ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    const manifestPath = path.join(root, "remote-manifest.json");
    await writeJson(manifestPath, manifest);
    const generated = createDeploymentExecuteChildRun({
      workspaceRoot: root,
      prepareReceipt,
      remoteManifest: manifest,
      ownerAuthority,
      ownerDecision: {
        path: TEST_OWNER_DECISION_PATH,
        sha256: sha256(await readFile(path.join(
          root,
          TEST_OWNER_DECISION_PATH,
        ))),
      },
    });
    await writeJson(path.join(root, ".owlcoda/runkit/config.json"), {
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: currentCoreIdentity(),
      authorizationPolicy: "external_explicit_authority_required",
    });
    const hooks = trustedOwnerDeploymentAuthorityHook();
    const manifestBytes = await readFile(manifestPath);
    const lineage = createDeploymentExecuteLineageFromActiveRun({
      workspaceRoot: root,
      prepareReceipt,
      executeRequest: generated.executeRequest,
      remoteManifest: manifest,
      remoteManifestBytes: manifestBytes,
      verifyOwnerAuthority: hooks.verifyOwnerDeploymentAuthority,
    });
    await writeJson(path.join(root, generated.lineagePath), lineage);
    const requestBytes = await readFile(
      path.join(root, generated.executeRequestPath),
    );
    const journal = createRemoteDeploymentStageJournalV1({
      journalRoot: path.join(
        root,
        ".owlcoda/runkit/deployments",
        executeRunId,
        "stage-journal",
      ),
      binding: {
        deploymentId: executeRunId,
        deploymentLineageSha256: lineage.lineageSha256,
        remoteManifestSha256: sha256(manifestBytes),
        executeRequestSha256: sha256(requestBytes),
        adapterIdentity: manifest.adapter,
      },
    });
    const identityBefore = journal.beginInvocation({
      stage: "identity_preflight",
      operation: "execute",
    });
    journal.completeInvocation({
      stage: "identity_preflight",
      operation: "execute",
      before: identityBefore,
      outcome: "completed",
      stageReceipt: {
        stage: "identity_preflight",
        status: "passed",
        hostKeySha256: target.hostKeySha256,
        machineIdentitySha256: target.machineIdentitySha256,
      },
    });
    journal.beginInvocation({
      stage: "upload",
      operation: "execute",
    });

    const resumed = await runCli([
      "deployment",
      "execute",
      "--resume",
      "--workspace",
      root,
      "--prepare",
      preparePath,
      "--owner-decision",
      TEST_OWNER_DECISION_PATH,
      "--owner-authority",
      ownerAuthority.path,
      "--manifest",
      manifestPath,
    ], hooks);

    assert.equal(resumed.status, "deployed");
    assert.equal(resumed.runId, executeRunId);
    assert.equal(resumed.closeoutDecision, "accepted");
    assert.equal(resumed.executeRequestPath, generated.executeRequestPath);
    assert.equal(
      JSON.parse(await readFile(
        path.join(
          root,
          ".owlcoda/runkit/executions",
          executeRunId,
          "leases/deployment-execute-attempt-001.json",
        ),
        "utf8",
      )).state,
      "released",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute --resume closes the old child as superseded before any remote stage", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-deployment-superseded-"),
  );
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    const preparePath = ".owlcoda/runkit/deployments/prepare.json";
    await writeJson(path.join(root, preparePath), prepareReceipt);
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/release.tgz"), "archive");
    const executeRunId = "execute-superseded-001";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    const ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    const manifestPath = path.join(root, "remote-manifest.json");
    await writeJson(manifestPath, manifest);
    const generated = createDeploymentExecuteChildRun({
      workspaceRoot: root,
      prepareReceipt,
      remoteManifest: manifest,
      ownerAuthority,
      ownerDecision: {
        path: TEST_OWNER_DECISION_PATH,
        sha256: sha256(await readFile(path.join(
          root,
          TEST_OWNER_DECISION_PATH,
        ))),
      },
    });
    await writeJson(path.join(root, ".owlcoda/runkit/config.json"), {
      schemaVersion: "OwlCodaRunKitConfigV2",
      core: currentCoreIdentity(),
      authorizationPolicy: "external_explicit_authority_required",
    });
    const replacementDecision = createOwnerDeploymentDecisionV1({
      ...TEST_OWNER_DECISION,
      decisionId: "owner-test-deployment-002",
      decisionVersion: 2,
      provenance: {
        ...TEST_OWNER_DECISION.provenance,
        sourceRef: "owner:test-suite/replacement",
        recordedAt: "2026-08-01T09:00:00.000Z",
      },
      supersedesDecisionSha256: TEST_OWNER_DECISION.decisionSha256,
      decisionSha256: undefined,
    });
    await writeJson(
      path.join(root, TEST_OWNER_DECISION_PATH),
      replacementDecision,
    );
    let authorityVerificationCount = 0;
    const result = await runCli([
      "deployment",
      "execute",
      "--resume",
      "--workspace",
      root,
      "--prepare",
      preparePath,
      "--owner-decision",
      TEST_OWNER_DECISION_PATH,
      "--owner-authority",
      ownerAuthority.path,
      "--manifest",
      manifestPath,
    ], trustedOwnerDeploymentAuthorityHook(() => {
      authorityVerificationCount += 1;
    }));

    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(result.failureCode, "owner_decision_superseded");
    assert.equal(result.closeoutDecision, "blocked");
    assert.equal(result.closeoutStatus, "closed_superseded");
    assert.equal(result.businessGoalIncomplete, true);
    assert.equal(result.replacementPlanRequired, true);
    assert.equal(result.nextAllowedAction, "plan_replacement_execution");
    assert.equal(authorityVerificationCount, 0);
    assert.equal(
      JSON.parse(await readFile(path.join(
        root,
        ".owlcoda/runkit/executions",
        executeRunId,
        "leases/deployment-execute-attempt-001.json",
      ))).state,
      "released",
    );
    const snapshot = JSON.parse(await readFile(path.join(
      root,
      generated.executeRequest.ownerDecisionSnapshot.path,
    )));
    assert.equal(snapshot.decisionSha256, TEST_OWNER_DECISION.decisionSha256);
    const inspected = await runCli(["inspect", "--workspace", root, "--json"]);
    const closed = inspected.executions.find(
      (execution) => execution.runId === executeRunId,
    );
    assert.equal(
      closed.closeout.statusCode,
      "closed_superseded",
      JSON.stringify(closed),
    );
    assert.equal(closed.closeout.businessGoalIncomplete, true);
    assert.equal(closed.closeout.replacementPlanRequired, true);
    const human = await runCli(["status", "--workspace", root, "--json"]);
    assert.equal(human.overall, "blocked");
    assert.equal(
      human.nextAllowedAction,
      "plan_replacement_execution",
      JSON.stringify(human),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute runs the manifest-declared built-in SSH adapter instead of treating it as a process adapter", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-deployment-builtin-ssh-"),
  );
  try {
    const prepareRequestPath = path.join(root, "prepare-request.json");
    await writeJson(prepareRequestPath, prepareInput());
    const prepared = await runCli([
      "deployment",
      "prepare",
      "--workspace",
      root,
      "--request",
      prepareRequestPath,
      "--output",
      ".owlcoda/runkit/deployments/prepare.json",
    ]);
    const prepareReceipt = JSON.parse(await readFile(
      path.join(root, prepared.receiptPath),
      "utf8",
    ));
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/release.tgz"), "archive");
    const executeRunId = "execute-builtin-ssh-001";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-ssh-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("replaced-by-fixture"),
      machineIdentitySha256: sha256("machine"),
    };
    const manifest = await builtInSshManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    const ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    const manifestPath = path.join(root, "remote-manifest.json");
    await writeJson(manifestPath, manifest);

    const executed = await runCli([
      "deployment",
      "execute",
      "--workspace",
      root,
      "--prepare",
      prepared.receiptPath,
      "--owner-decision",
      TEST_OWNER_DECISION_PATH,
      "--owner-authority",
      ownerAuthority.path,
      "--manifest",
      manifestPath,
    ], trustedOwnerDeploymentAuthorityHook());

    assert.equal(executed.status, "deployed");
    assert.equal(executed.closeoutDecision, "accepted");
    assert.equal(executed.adapter.adapterId, "builtin-ssh-v1");
    assert.equal(
      JSON.stringify(executed).includes(manifest.credentialRef),
      false,
    );
    assert.deepEqual(executed.completedStages, [
      "identity_preflight",
      "upload",
      "verify_remote_hashes",
      "install",
      "service",
      "proxy",
      "smoke",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment child creation never deletes a pre-existing deployment directory", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-deployment-existing-control-"),
  );
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    const executeRunId = "execute-existing-control";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    const ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    const deploymentRoot = path.join(
      root,
      ".owlcoda/runkit/deployments",
      executeRunId,
    );
    const markerPath = path.join(deploymentRoot, "owner-marker.json");
    await writeJson(markerPath, { preserved: true });

    assert.throws(
      () => createDeploymentExecuteChildRun({
        workspaceRoot: root,
        prepareReceipt,
        remoteManifest: manifest,
        ownerAuthority,
        ownerDecision: {
          path: TEST_OWNER_DECISION_PATH,
          sha256: sha256(readFileSync(path.join(
            root,
            TEST_OWNER_DECISION_PATH,
          ))),
        },
      }),
      /deployment control.*already exists/iu,
    );
    assert.deepEqual(
      JSON.parse(await readFile(markerPath, "utf8")),
      { preserved: true },
    );
    await assert.rejects(
      readFile(path.join(
        root,
        ".owlcoda/runkit/executions",
        executeRunId,
        "engine-pin.json",
      )),
      /ENOENT/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment happy path releases its lease and records a blocked closeout after remote failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-happy-failure-"));
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    await writeJson(
      path.join(root, ".owlcoda/runkit/deployments/prepare.json"),
      prepareReceipt,
    );
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist/release.tgz"), "archive");
    const executeRunId = "execute-happy-failed";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    const ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    const manifestPath = path.join(root, "remote-manifest.json");
    await writeJson(manifestPath, manifest);

    const executed = await runCli([
      "deployment",
      "execute",
      "--workspace",
      root,
      "--prepare",
      ".owlcoda/runkit/deployments/prepare.json",
      "--owner-decision",
      TEST_OWNER_DECISION_PATH,
      "--owner-authority",
      ownerAuthority.path,
      "--manifest",
      manifestPath,
    ], trustedOwnerDeploymentAuthorityHook(({ verificationCount }) => {
      if (verificationCount === 3) {
        const leasePath = path.join(
          root,
          ".owlcoda/runkit/executions",
          executeRunId,
          "leases/deployment-execute-attempt-001.json",
        );
        writeFileSync(
          leasePath,
          `${JSON.stringify({
            schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
            workItemId: "deployment-execute",
            attempt: 1,
            ownedPaths: ["dist/release.tgz"],
            state: "released",
          }, null, 2)}\n`,
        );
      }
    }));

    assert.equal(executed.status, "failed");
    assert.equal(executed.closeoutDecision, "blocked");
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions",
      executeRunId,
    );
    assert.equal(
      JSON.parse(await readFile(
        path.join(executionRoot, "leases/deployment-execute-attempt-001.json"),
        "utf8",
      )).state,
      "released",
    );
    assert.equal(
      JSON.parse(await readFile(path.join(executionRoot, "closeout-receipt.json"), "utf8"))
        .artifact.payload.decision,
      "blocked",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute refuses a descriptor-only child that has no real active execution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-missing-child-"));
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    await writeJson(
      path.join(root, ".owlcoda/runkit/deployments/prepare.json"),
      prepareReceipt,
    );
    const request = {
      schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
      executeRunId: "execute-missing",
      executeGoal: {
        path: ".owlcoda/runkit/executions/execute-missing/goal-contract.json",
        sha256: sha256("invented-goal"),
      },
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      target: {
        schemaVersion: "OwlCodaRunKitRemoteTargetV1",
        targetId: "vm-01",
        environment: "production",
        host: "deploy.example.invalid",
        port: 22,
        user: "deploy",
        hostKeySha256: sha256("host-key"),
        machineIdentitySha256: sha256("machine"),
      },
      ownerAuthority: {
        authorityId: "owner-deploy-001",
        sha256: sha256("invented-owner-authority"),
        permissions: {
          deploy: true,
          destructive: false,
        },
      },
      deploy: true,
      destructive: false,
    };
    await writeJson(path.join(root, "execute-request.json"), request);
    const executable = await adapter(root);
    await writeJson(path.join(root, "remote-manifest.json"), {
      schemaVersion: "OwlCodaRunKitRemoteDeploymentManifestV1",
      deploymentId: "execute-missing",
      deploymentLineageSha256: null,
      mode: "first",
      target: request.target,
      adapter: {
        adapterId: "fixture-adapter",
        version: "1.0.0",
        executable: executable.ref,
        sha256: executable.sha256,
      },
      credentialRef: "agent:ssh/default",
      artifact: prepareReceipt.artifact,
      upload: {
        remotePath: "/var/lib/owlcoda/staging/release.tgz",
        createOnly: true,
      },
      priorDeployment: null,
      expectedRemoteFiles: [],
      deletionAllowlist: [],
    });

    const result = await runCli([
      "deployment",
      "execute",
      "--workspace",
      root,
      "--prepare",
      ".owlcoda/runkit/deployments/prepare.json",
      "--request",
      path.join(root, "execute-request.json"),
      "--manifest",
      path.join(root, "remote-manifest.json"),
      "--lineage-output",
      ".owlcoda/runkit/deployments/lineage.json",
      "--output",
      ".owlcoda/runkit/deployments/result.json",
    ], trustedOwnerDeploymentAuthorityHook());
    assert.equal(result.status, "invalid_input");
    assert.match(result.issues.join("\n"), /active child execution/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute consumes an independent exact Owner authority artifact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-owner-authority-"));
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    await writeJson(
      path.join(root, ".owlcoda/runkit/deployments/prepare.json"),
      prepareReceipt,
    );
    const executeRunId = "execute-owner-bound";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const request = {
      schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
      executeRunId,
      executeGoal: {
        path: `.owlcoda/runkit/executions/${executeRunId}/goal-contract.json`,
        sha256: sha256("execute-goal"),
      },
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      target,
      ownerAuthority: null,
      deploy: true,
      destructive: false,
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    request.ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    await activeDeploymentExecution(root, {
      executeRequest: request,
      prepareReceipt,
    });
    await writeJson(path.join(root, "execute-request.json"), request);
    await writeJson(path.join(root, "remote-manifest.json"), manifest);

    const result = await runCli([
      "deployment",
      "execute",
      "--workspace",
      root,
      "--prepare",
      ".owlcoda/runkit/deployments/prepare.json",
      "--request",
      path.join(root, "execute-request.json"),
      "--manifest",
      path.join(root, "remote-manifest.json"),
      "--lineage-output",
      ".owlcoda/runkit/deployments/lineage.json",
      "--output",
      ".owlcoda/runkit/deployments/result.json",
    ], trustedOwnerDeploymentAuthorityHook());

    assert.equal(result.status, "deployed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute stops before the next remote stage when its active lease changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-stage-guard-"));
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    await writeJson(
      path.join(root, ".owlcoda/runkit/deployments/prepare.json"),
      prepareReceipt,
    );
    const executeRunId = "execute-stage-guard";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const request = {
      schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
      executeRunId,
      executeGoal: {
        path: `.owlcoda/runkit/executions/${executeRunId}/goal-contract.json`,
        sha256: sha256("execute-goal"),
      },
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      target,
      ownerAuthority: null,
      deploy: true,
      destructive: false,
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    request.ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    await activeDeploymentExecution(root, {
      executeRequest: request,
      prepareReceipt,
    });
    await writeJson(path.join(root, "execute-request.json"), request);
    await writeJson(path.join(root, "remote-manifest.json"), manifest);

    const leasePath = path.join(
      root,
      ".owlcoda/runkit/executions",
      executeRunId,
      "leases/deployment-execute-attempt-001.json",
    );
    const result = await runCli([
      "deployment",
      "execute",
      "--workspace",
      root,
      "--prepare",
      ".owlcoda/runkit/deployments/prepare.json",
      "--request",
      path.join(root, "execute-request.json"),
      "--manifest",
      path.join(root, "remote-manifest.json"),
      "--lineage-output",
      ".owlcoda/runkit/deployments/lineage.json",
      "--output",
      ".owlcoda/runkit/deployments/result.json",
    ], trustedOwnerDeploymentAuthorityHook(({ verificationCount }) => {
      if (verificationCount === 3) {
        writeFileSync(
          leasePath,
          `${JSON.stringify({
            schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
            workItemId: "deployment-execute",
            attempt: 1,
            ownedPaths: ["dist/release.tgz"],
            state: "released",
          }, null, 2)}\n`,
        );
      }
    }));

    assert.equal(result.status, "failed");
    assert.equal(result.stoppedAtStage, "upload");
    assert.equal(result.failureCode, "deployment_control_guard_failed");
    assert.deepEqual(result.completedStages, ["identity_preflight"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute rereads the local artifact and rejects size or SHA drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-artifact-drift-"));
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    const executeRunId = "execute-artifact-bound";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const executeRequest = {
      schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
      executeRunId,
      executeGoal: {
        path: `.owlcoda/runkit/executions/${executeRunId}/goal-contract.json`,
        sha256: sha256("placeholder"),
      },
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      target,
      ownerAuthority: null,
      deploy: true,
      destructive: false,
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    executeRequest.ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    await activeDeploymentExecution(root, {
      executeRequest,
      prepareReceipt,
    });
    await writeFile(path.join(root, prepareReceipt.artifact.path), "drifted-archive");

    assert.throws(
      () => createDeploymentExecuteLineageFromActiveRun({
        workspaceRoot: root,
        prepareReceipt,
        executeRequest,
        remoteManifest: manifest,
        remoteManifestBytes: Buffer.from(
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
        verifyOwnerAuthority:
          trustedOwnerDeploymentAuthorityHook()
            .verifyOwnerDeploymentAuthority,
      }),
      /artifact size or SHA-256 drifted/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deployment execute fails closed on child control or Owner authority drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-deployment-control-drift-"));
  try {
    const prepareReceipt = createDeploymentPrepareReceipt(prepareInput());
    const executeRunId = "execute-control-bound";
    const target = {
      schemaVersion: "OwlCodaRunKitRemoteTargetV1",
      targetId: "vm-01",
      environment: "production",
      host: "deploy.example.invalid",
      port: 22,
      user: "deploy",
      hostKeySha256: sha256("host-key"),
      machineIdentitySha256: sha256("machine"),
    };
    const executeRequest = {
      schemaVersion: "OwlCodaRunKitDeploymentExecuteRequestV1",
      executeRunId,
      executeGoal: {
        path: `.owlcoda/runkit/executions/${executeRunId}/goal-contract.json`,
        sha256: sha256("placeholder"),
      },
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      target,
      ownerAuthority: null,
      deploy: true,
      destructive: false,
    };
    const manifest = await remoteManifestFixture(root, {
      executeRunId,
      target,
      artifact: prepareReceipt.artifact,
    });
    executeRequest.ownerAuthority = await ownerDeploymentAuthority(root, {
      executeRunId,
      prepareReceipt,
      target,
      remoteManifest: manifest,
    });
    await activeDeploymentExecution(root, {
      executeRequest,
      prepareReceipt,
    });
    const executionRoot = path.join(
      root,
      ".owlcoda/runkit/executions",
      executeRunId,
    );
    const cases = [
      {
        path: path.join(executionRoot, "engine-pin.json"),
        mutate: value => ({ ...value, coreVersion: "0.0.0-drift" }),
        error: /engine pin/u,
      },
      {
        path: path.join(executionRoot, "goal-contract.json"),
        mutate: value => ({
          ...value,
          deployment: {
            ...value.deployment,
            prepareReceiptSha256: sha256("different-parent"),
          },
        }),
        error: /Goal hash|exact parent/u,
      },
      {
        path: path.join(
          executionRoot,
          "leases/deployment-execute-attempt-001.json",
        ),
        mutate: value => ({ ...value, state: "released" }),
        error: /active child writer lease/u,
      },
      {
        path: path.join(root, ".owlcoda/runkit/profiles.json"),
        mutate: value => ({ ...value, profiles: [] }),
        error: /profile is missing/u,
      },
      {
        path: path.join(
          executionRoot,
          "resource-preflights/deployment-execute-preflight.json",
        ),
        mutate: value => ({
          ...value,
          decision: {
            status: "blocked_by_resource",
            blockers: ["forced-test-blocker"],
            warnings: [],
            nextAllowedAction: "pause_at_deterministic_stage",
          },
        }),
        error: /preflight hash|blocked/u,
      },
      {
        path: path.join(root, executeRequest.ownerAuthority.path),
        mutate: value => ({ ...value, decision: "rejected" }),
        error: /authority artifact hash|exact deployment scope/u,
      },
    ];

    for (const entry of cases) {
      const original = await readFile(entry.path);
      await writeFile(
        entry.path,
        `${JSON.stringify(entry.mutate(JSON.parse(original)), null, 2)}\n`,
      );
      assert.throws(
        () => createDeploymentExecuteLineageFromActiveRun({
          workspaceRoot: root,
          prepareReceipt,
          executeRequest,
          remoteManifest: manifest,
          remoteManifestBytes: Buffer.from(
            `${JSON.stringify(manifest, null, 2)}\n`,
          ),
          verifyOwnerAuthority:
            trustedOwnerDeploymentAuthorityHook()
              .verifyOwnerDeploymentAuthority,
        }),
        entry.error,
      );
      await writeFile(entry.path, original);
    }

    const changedManifest = {
      ...manifest,
      upload: {
        ...manifest.upload,
        remotePath: "/var/lib/owlcoda/staging/changed-release.tgz",
      },
    };
    assert.throws(
      () => createDeploymentExecuteLineageFromActiveRun({
        workspaceRoot: root,
        prepareReceipt,
        executeRequest,
        remoteManifest: changedManifest,
        remoteManifestBytes: Buffer.from(
          `${JSON.stringify(changedManifest, null, 2)}\n`,
        ),
        verifyOwnerAuthority:
          trustedOwnerDeploymentAuthorityHook()
            .verifyOwnerDeploymentAuthority,
      }),
      /does not bind the exact remote manifest/u,
    );

    const authorityPath = path.join(root, executeRequest.ownerAuthority.path);
    const originalAuthorityBytes = await readFile(authorityPath);
    const originalAuthorityDescriptor = structuredClone(
      executeRequest.ownerAuthority,
    );
    const legacyAuthorityBody = {
      schemaVersion: "OwlCodaRunKitOwnerDeploymentAuthorityV1",
      authorityId: `owner-${executeRunId}`,
      decision: "approved",
      scope: "execute_exact_remote_deployment",
      executeRunId,
      prepareReceiptSha256: prepareReceipt.receiptSha256,
      targetSha256: objectHash(target),
      artifactSha256: prepareReceipt.artifact.sha256,
      permissions: {
        deploy: true,
        destructive: false,
      },
      authorizationGranted: false,
    };
    await writeJson(authorityPath, {
      ...legacyAuthorityBody,
      authoritySha256: objectHash(legacyAuthorityBody),
    });
    executeRequest.ownerAuthority.sha256 = sha256(await readFile(authorityPath));
    assert.throws(
      () => createDeploymentExecuteLineageFromActiveRun({
        workspaceRoot: root,
        prepareReceipt,
        executeRequest,
        remoteManifest: manifest,
        remoteManifestBytes: Buffer.from(
          `${JSON.stringify(manifest, null, 2)}\n`,
        ),
        verifyOwnerAuthority:
          trustedOwnerDeploymentAuthorityHook()
            .verifyOwnerDeploymentAuthority,
      }),
      /deployment_owner_authority_untrusted/u,
    );
    await writeFile(authorityPath, originalAuthorityBytes);
    executeRequest.ownerAuthority = originalAuthorityDescriptor;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
