import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REMOTE_DEPLOYMENT_STAGES,
  createRemoteDeploymentStageJournalV1,
  executeRemoteDeployment,
  validateRemoteDeploymentManifest,
} from "../scripts/runkit-contract/remote-deployment.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function target(overrides = {}) {
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

function manifest(overrides = {}) {
  return {
    schemaVersion: "OwlCodaRunKitRemoteDeploymentManifestV1",
    deploymentId: "remote-deployment-001",
    deploymentLineageSha256: hash("deployment-lineage"),
    mode: "first",
    target: target(),
    adapter: {
      adapterId: "local-fake",
      version: "1.0.0",
      executable: "/opt/owlcoda/adapters/local-fake",
      sha256: hash("adapter"),
    },
    credentialRef: "keychain:owlcoda/deploy-production",
    artifact: {
      path: "dist/owlrunkit-0.16.0.tgz",
      sha256: hash("release-archive"),
      size: 48123,
      mediaType: "application/gzip",
    },
    upload: {
      remotePath: "/var/lib/owlcoda/staging/owlrunkit-0.16.0.tgz",
      createOnly: true,
    },
    priorDeployment: null,
    expectedRemoteFiles: [],
    deletionAllowlist: [],
    ...overrides,
  };
}

function builtInSshAdapterManifest() {
  return {
    kind: "builtin_ssh",
    adapterId: "builtin-ssh-v1",
    version: "1.0.0",
    executable: "/opt/owlcoda/runkit/ssh-remote-adapter.mjs",
    sha256: hash("builtin-ssh-adapter"),
    knownHostsPath: "/opt/owlcoda/deployment/known_hosts",
    sshExecutable: "/usr/bin/ssh",
    sshExecutableSha256: hash("ssh-executable"),
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
    stageContracts: {
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
          sha256: hash("systemd-unit"),
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
          sha256: hash("nginx-config"),
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
    },
  };
}

function successfulStageResult(stage, input) {
  if (stage === "identity_preflight") {
    return {
      status: "passed",
      hostKeySha256: input.target.hostKeySha256,
      machineIdentitySha256: input.target.machineIdentitySha256,
    };
  }
  if (stage === "upload") {
    return {
      status: "created",
      remotePath: input.upload.remotePath,
      sha256: input.artifact.sha256,
      size: input.artifact.size,
    };
  }
  if (stage === "verify_remote_hashes") {
    return {
      status: "passed",
      remotePath: input.upload.remotePath,
      sha256: input.artifact.sha256,
      size: input.artifact.size,
    };
  }
  return {
    status: "passed",
    evidenceSha256: hash(`evidence:${stage}`),
  };
}

function fakeAdapter({
  resultFor = successfulStageResult,
  identity = {
    adapterId: "local-fake",
    version: "1.0.0",
    executable: "/opt/owlcoda/adapters/local-fake",
    sha256: hash("adapter"),
  },
} = {}) {
  const calls = [];
  return {
    calls,
    identity,
    async runStage(input) {
      calls.push(structuredClone(input));
      return resultFor(input.stage, input);
    },
  };
}

function permissions(destructive = false) {
  return {
    deploy: true,
    destructive,
  };
}

test("manifest accepts a deterministically bound built-in SSH adapter without changing the runtime identity contract", async () => {
  const adapterDeclaration = builtInSshAdapterManifest();
  const deploymentManifest = manifest({
    adapter: adapterDeclaration,
  });
  const validation = validateRemoteDeploymentManifest(deploymentManifest);
  assert.equal(validation.status, "valid");
  assert.deepEqual(validation.normalized.adapter, adapterDeclaration);

  const adapter = fakeAdapter({
    identity: {
      adapterId: adapterDeclaration.adapterId,
      version: adapterDeclaration.version,
      executable: adapterDeclaration.executable,
      sha256: adapterDeclaration.sha256,
    },
    resultFor(stage, input) {
      const result = successfulStageResult(stage, input);
      return stage === "identity_preflight"
        ? {
            ...result,
            remoteHelper: structuredClone(
              adapterDeclaration.remoteHelper,
            ),
          }
        : result;
    },
  });
  const result = await executeRemoteDeployment({
    manifest: deploymentManifest,
    adapter,
    permissions: permissions(),
    beforeStageGuard() {},
  });

  assert.equal(result.status, "deployed");
  assert.equal(JSON.stringify(result).includes("knownHostsPath"), false);
  assert.equal(JSON.stringify(result).includes("credential"), false);
});

test("an explicitly declared process adapter preserves the legacy process identity", async () => {
  const legacy = manifest().adapter;
  const deploymentManifest = manifest({
    adapter: {
      kind: "process",
      ...legacy,
    },
  });
  const validation = validateRemoteDeploymentManifest(deploymentManifest);
  assert.equal(validation.normalized.adapter.kind, "process");

  const result = await executeRemoteDeployment({
    manifest: deploymentManifest,
    adapter: fakeAdapter({ identity: legacy }),
    permissions: permissions(),
    beforeStageGuard() {},
  });
  assert.equal(result.status, "deployed");
  assert.deepEqual(result.adapter, legacy);
});

test("typed adapter runs the fixed remote stage machine without persisting credential references", async () => {
  const adapter = fakeAdapter();
  const result = await executeRemoteDeployment({
    manifest: manifest(),
    adapter,
    permissions: permissions(),
    beforeStageGuard() {},
  });

  assert.equal(result.schemaVersion, "OwlCodaRunKitRemoteDeploymentResultV1");
  assert.equal(result.status, "deployed");
  assert.deepEqual(adapter.calls.map((call) => call.stage), REMOTE_DEPLOYMENT_STAGES);
  assert.deepEqual(result.completedStages, REMOTE_DEPLOYMENT_STAGES);
  assert.equal(result.stoppedAtStage, null);
  assert.equal(JSON.stringify(result).includes("keychain:owlcoda/deploy-production"), false);
  assert.equal(result.authorizationGranted, false);
});

test("identity mismatch stops before upload and records the exact failed stage", async () => {
  const adapter = fakeAdapter({
    resultFor(stage, input) {
      if (stage === "identity_preflight") {
        return {
          status: "passed",
          hostKeySha256: hash("unexpected-host-key"),
          machineIdentitySha256: input.target.machineIdentitySha256,
        };
      }
      return successfulStageResult(stage, input);
    },
  });

  const result = await executeRemoteDeployment({
    manifest: manifest(),
    adapter,
    permissions: permissions(),
    beforeStageGuard() {},
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAtStage, "identity_preflight");
  assert.deepEqual(result.completedStages, []);
  assert.match(result.failureCode, /target_identity_mismatch/);
  assert.deepEqual(adapter.calls.map((call) => call.stage), ["identity_preflight"]);
});

test("create-only upload conflict stops before remote hash verification", async () => {
  const adapter = fakeAdapter({
    resultFor(stage, input) {
      if (stage === "upload") {
        return {
          status: "conflict",
          remotePath: input.upload.remotePath,
          sha256: hash("different-remote-bytes"),
          size: input.artifact.size,
        };
      }
      return successfulStageResult(stage, input);
    },
  });

  const result = await executeRemoteDeployment({
    manifest: manifest(),
    adapter,
    permissions: permissions(),
    beforeStageGuard() {},
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAtStage, "upload");
  assert.match(result.failureCode, /create_only_upload_conflict/);
  assert.deepEqual(adapter.calls.map((call) => call.stage), [
    "identity_preflight",
    "upload",
  ]);
});

test("update mode requires prior deployment hashes and exact deletion allowlist entries", async () => {
  const update = manifest({
    mode: "update",
    priorDeployment: {
      receiptSha256: hash("prior-receipt"),
      artifactSha256: hash("prior-artifact"),
    },
    expectedRemoteFiles: [{
      path: "/opt/owlcoda/current/package.json",
      sha256: hash("prior-package-json"),
    }],
    deletionAllowlist: [{
      path: "/opt/owlcoda/current/package.json",
      priorSha256: hash("prior-package-json"),
    }],
  });
  assert.equal(validateRemoteDeploymentManifest(update).status, "valid");

  const adapter = fakeAdapter();
  const result = await executeRemoteDeployment({
    manifest: update,
    adapter,
    permissions: permissions(true),
    beforeStageGuard() {},
  });
  assert.equal(result.status, "deployed");
  assert.deepEqual(
    adapter.calls.find((call) => call.stage === "install").deletionAllowlist,
    update.deletionAllowlist,
  );

  assert.throws(
    () => validateRemoteDeploymentManifest(manifest({
      mode: "update",
      priorDeployment: null,
    })),
    /priorDeployment/,
  );
  assert.throws(
    () => validateRemoteDeploymentManifest({
      ...update,
      deletionAllowlist: [{
        path: "/opt/owlcoda/current/*.js",
        priorSha256: hash("prior-package-json"),
      }],
    }),
    /exact remote path/,
  );
  assert.throws(
    () => validateRemoteDeploymentManifest({
      ...update,
      deletionAllowlist: [{
        path: "/opt/owlcoda/current/package.json",
        priorSha256: hash("wrong-prior-bytes"),
      }],
    }),
    /expected prior hash/,
  );
});

test("adapter failure stops at its stage and later stages are never called", async () => {
  const adapter = fakeAdapter({
    resultFor(stage, input) {
      if (stage === "service") {
        return {
          status: "failed",
          failureCode: "systemd_unit_not_active",
          evidenceSha256: hash("service-failure-evidence"),
        };
      }
      return successfulStageResult(stage, input);
    },
  });

  const result = await executeRemoteDeployment({
    manifest: manifest(),
    adapter,
    permissions: permissions(),
    beforeStageGuard() {},
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAtStage, "service");
  assert.equal(result.failureCode, "systemd_unit_not_active");
  assert.deepEqual(adapter.calls.map((call) => call.stage), [
    "identity_preflight",
    "upload",
    "verify_remote_hashes",
    "install",
    "service",
  ]);
});

test("raw credentials and secret-shaped adapter output are rejected instead of persisted", async () => {
  assert.throws(
    () => validateRemoteDeploymentManifest({
      ...manifest(),
      password: "do-not-store-me",
    }),
    /unsupported field|secret material/,
  );

  const adapter = fakeAdapter({
    resultFor(stage, input) {
      if (stage === "smoke") {
        return {
          status: "passed",
          evidenceSha256: hash("smoke"),
          token: "do-not-store-me",
        };
      }
      return successfulStageResult(stage, input);
    },
  });
  const result = await executeRemoteDeployment({
    manifest: manifest(),
    adapter,
    permissions: permissions(),
    beforeStageGuard() {},
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAtStage, "smoke");
  assert.match(result.failureCode, /secret_material_forbidden|stage_result_invalid/);
  assert.equal(JSON.stringify(result).includes("do-not-store-me"), false);
});

test("destructive=false rejects every declared remote deletion before the adapter runs", async () => {
  const update = manifest({
    mode: "update",
    priorDeployment: {
      receiptSha256: hash("prior-receipt"),
      artifactSha256: hash("prior-artifact"),
    },
    expectedRemoteFiles: [{
      path: "/opt/owlcoda/current/package.json",
      sha256: hash("prior-package-json"),
    }],
    deletionAllowlist: [{
      path: "/opt/owlcoda/current/package.json",
      priorSha256: hash("prior-package-json"),
    }],
  });
  const adapter = fakeAdapter();

  await assert.rejects(
    executeRemoteDeployment({
      manifest: update,
      adapter,
      permissions: permissions(false),
    }),
    /destructive=false.*deletion/u,
  );
  assert.deepEqual(adapter.calls, []);
});

test("remote targets and paths reject shell metacharacters while accepting safe host forms", () => {
  for (const host of [
    "deploy.example.invalid;touch-pwn",
    "deploy.example.invalid$(touch-pwn)",
    "deploy.example.invalid`touch-pwn`",
    "deploy.example.invalid|touch-pwn",
    "deploy.example.invalid&touch-pwn",
  ]) {
    assert.throws(
      () => validateRemoteDeploymentManifest(manifest({
        target: target({ host }),
      })),
      /exact host name or address/u,
    );
  }

  for (const remotePath of [
    "/var/lib/owlcoda/release.tgz;touch-pwn",
    "/var/lib/owlcoda/$(touch-pwn)",
    "/var/lib/owlcoda/`touch-pwn`",
    "/var/lib/owlcoda/release.tgz|touch-pwn",
    "/var/lib/owlcoda/release.tgz\nnext-command",
  ]) {
    assert.throws(
      () => validateRemoteDeploymentManifest(manifest({
        upload: {
          remotePath,
          createOnly: true,
        },
      })),
      /exact remote path/u,
    );
  }

  assert.equal(validateRemoteDeploymentManifest(manifest({
    target: target({ host: "192.0.2.10" }),
  })).status, "valid");
  assert.equal(validateRemoteDeploymentManifest(manifest({
    target: target({ host: "2001:db8::10" }),
  })).status, "valid");
});

test("remote execution requires a control guard and rechecks it before every stage", async () => {
  const adapter = fakeAdapter();
  await assert.rejects(
    executeRemoteDeployment({
      manifest: manifest(),
      adapter,
      permissions: permissions(),
    }),
    /control guard/u,
  );
  assert.deepEqual(adapter.calls, []);

  const guardedAdapter = fakeAdapter();
  const guardCalls = [];
  const result = await executeRemoteDeployment({
    manifest: manifest(),
    adapter: guardedAdapter,
    permissions: permissions(),
    beforeStageGuard({ stage }) {
      guardCalls.push(stage);
      if (stage === "verify_remote_hashes") {
        throw new Error("child lease was released");
      }
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.stoppedAtStage, "verify_remote_hashes");
  assert.equal(result.failureCode, "deployment_control_guard_failed");
  assert.deepEqual(guardCalls, [
    "identity_preflight",
    "upload",
    "verify_remote_hashes",
  ]);
  assert.deepEqual(guardedAdapter.calls.map((call) => call.stage), [
    "identity_preflight",
    "upload",
  ]);
});

function journalBinding(deploymentManifest, adapterIdentity) {
  return {
    deploymentId: deploymentManifest.deploymentId,
    deploymentLineageSha256: deploymentManifest.deploymentLineageSha256,
    remoteManifestSha256: hash("exact-remote-manifest-bytes"),
    executeRequestSha256: hash("exact-execute-request-bytes"),
    adapterIdentity,
  };
}

for (const interruptedStage of [
  "upload",
  "install",
  "service",
  "proxy",
  "smoke",
]) {
  test(`create-only stage journal resumes safely after a hard crash at ${interruptedStage}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-journal-"));
    try {
      const deploymentManifest = manifest();
      const firstAdapter = fakeAdapter();
      firstAdapter.reconcileCalls = [];
      firstAdapter.reconcileStage = async (input) => {
        firstAdapter.reconcileCalls.push(structuredClone(input));
        if (new Set(["install", "service", "proxy"]).has(input.stage)) {
          return successfulStageResult(input.stage, input);
        }
        return {
          status: "failed",
          failureCode: "desired_state_not_proven",
          evidenceSha256: hash(`not-proven:${input.stage}`),
        };
      };
      const persisted = createRemoteDeploymentStageJournalV1({
        journalRoot: root,
        binding: journalBinding(deploymentManifest, firstAdapter.identity),
      });
      let crashed = false;
      const crashAfterExternalCall = {
        ...persisted,
        completeInvocation(input) {
          if (
            !crashed
            && input.operation === "execute"
            && input.stage === interruptedStage
          ) {
            crashed = true;
            throw new Error(`simulated-sigkill:${interruptedStage}`);
          }
          return persisted.completeInvocation(input);
        },
      };

      await assert.rejects(
        executeRemoteDeployment({
          manifest: deploymentManifest,
          adapter: firstAdapter,
          permissions: permissions(),
          beforeStageGuard() {},
          stageJournal: crashAfterExternalCall,
        }),
        new RegExp(`simulated-sigkill:${interruptedStage}`),
      );

      const resumedAdapter = fakeAdapter();
      resumedAdapter.reconcileCalls = [];
      resumedAdapter.reconcileStage = async (input) => {
        resumedAdapter.reconcileCalls.push(structuredClone(input));
        if (new Set(["install", "service", "proxy"]).has(input.stage)) {
          return successfulStageResult(input.stage, input);
        }
        return {
          status: "failed",
          failureCode: "desired_state_not_proven",
          evidenceSha256: hash(`not-proven:${input.stage}`),
        };
      };
      const resumed = await executeRemoteDeployment({
        manifest: deploymentManifest,
        adapter: resumedAdapter,
        permissions: permissions(),
        beforeStageGuard() {},
        stageJournal: createRemoteDeploymentStageJournalV1({
          journalRoot: root,
          binding: journalBinding(deploymentManifest, resumedAdapter.identity),
        }),
      });

      assert.equal(resumed.status, "deployed");
      assert.deepEqual(resumed.completedStages, REMOTE_DEPLOYMENT_STAGES);
      assert.deepEqual(
        resumedAdapter.reconcileCalls.map((call) => call.stage),
        [interruptedStage],
      );
      if (new Set(["install", "service", "proxy"]).has(interruptedStage)) {
        assert.equal(
          resumedAdapter.calls.some((call) => call.stage === interruptedStage),
          false,
        );
      } else {
        assert.equal(
          resumedAdapter.calls.filter((call) => call.stage === interruptedStage)
            .length,
          1,
        );
      }
      const journalEntries = await readdir(root);
      assert.equal(
        journalEntries.some((name) => (
          name.includes(`${interruptedStage}-execute-attempt-`)
          && name.endsWith("-before.json")
        )),
        true,
      );
      assert.equal(
        journalEntries.some((name) => (
          name.includes(`${interruptedStage}-reconcile-attempt-`)
          && name.endsWith("-after.json")
        )),
        true,
      );
      const binding = JSON.parse(await readFile(
        path.join(root, "journal-binding.json"),
        "utf8",
      ));
      assert.equal(
        binding.deploymentLineageSha256,
        deploymentManifest.deploymentLineageSha256,
      );
      assert.equal(binding.remoteManifestSha256, hash("exact-remote-manifest-bytes"));
      assert.equal(binding.executeRequestSha256, hash("exact-execute-request-bytes"));
      assert.deepEqual(binding.adapterIdentity, firstAdapter.identity);
      assert.match(binding.adapterIdentitySha256, /^[a-f0-9]{64}$/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an interrupted non-idempotent stage requires reconciliation instead of rerunning the side effect", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-reconcile-"));
  try {
    const deploymentManifest = manifest();
    const firstAdapter = fakeAdapter();
    const persisted = createRemoteDeploymentStageJournalV1({
      journalRoot: root,
      binding: journalBinding(deploymentManifest, firstAdapter.identity),
    });
    let crashed = false;
    await assert.rejects(
      executeRemoteDeployment({
        manifest: deploymentManifest,
        adapter: firstAdapter,
        permissions: permissions(),
        beforeStageGuard() {},
        stageJournal: {
          ...persisted,
          completeInvocation(input) {
            if (
              !crashed
              && input.operation === "execute"
              && input.stage === "install"
            ) {
              crashed = true;
              throw new Error("simulated-sigkill:install");
            }
            return persisted.completeInvocation(input);
          },
        },
      }),
      /simulated-sigkill:install/u,
    );

    const resumedAdapter = fakeAdapter();
    resumedAdapter.reconcileStage = async () => ({
      status: "failed",
      failureCode: "desired_state_not_proven",
      evidenceSha256: hash("desired-state-not-proven"),
    });
    const resumed = await executeRemoteDeployment({
      manifest: deploymentManifest,
      adapter: resumedAdapter,
      permissions: permissions(),
      beforeStageGuard() {},
      stageJournal: createRemoteDeploymentStageJournalV1({
        journalRoot: root,
        binding: journalBinding(deploymentManifest, resumedAdapter.identity),
      }),
    });

    assert.equal(resumed.status, "reconciliation_required");
    assert.equal(resumed.stoppedAtStage, "install");
    assert.equal(resumed.failureCode, "remote_stage_reconciliation_required");
    assert.equal(
      resumedAdapter.calls.some((call) => call.stage === "install"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an adapter exception leaves an indeterminate journal that a later proof can reconcile without rerunning install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-exception-"));
  try {
    const deploymentManifest = manifest();
    const throwingAdapter = fakeAdapter();
    throwingAdapter.runStage = async (input) => {
      throwingAdapter.calls.push(structuredClone(input));
      if (input.stage === "install") throw new Error("transport vanished");
      return successfulStageResult(input.stage, input);
    };
    const first = await executeRemoteDeployment({
      manifest: deploymentManifest,
      adapter: throwingAdapter,
      permissions: permissions(),
      beforeStageGuard() {},
      stageJournal: createRemoteDeploymentStageJournalV1({
        journalRoot: root,
        binding: journalBinding(deploymentManifest, throwingAdapter.identity),
      }),
    });
    assert.equal(first.status, "reconciliation_required");
    assert.equal(first.stoppedAtStage, "install");

    const resumedAdapter = fakeAdapter();
    resumedAdapter.reconcileStage = async (input) => (
      successfulStageResult(input.stage, input)
    );
    const resumed = await executeRemoteDeployment({
      manifest: deploymentManifest,
      adapter: resumedAdapter,
      permissions: permissions(),
      beforeStageGuard() {},
      stageJournal: createRemoteDeploymentStageJournalV1({
        journalRoot: root,
        binding: journalBinding(deploymentManifest, resumedAdapter.identity),
      }),
    });

    assert.equal(resumed.status, "deployed");
    assert.equal(
      resumedAdapter.calls.some((call) => call.stage === "install"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stage journal validates every historical invocation before trusting the latest state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-journal-history-"));
  try {
    const deploymentManifest = manifest();
    const adapter = fakeAdapter();
    const journal = createRemoteDeploymentStageJournalV1({
      journalRoot: root,
      binding: journalBinding(deploymentManifest, adapter.identity),
    });
    const first = journal.beginInvocation({
      stage: "smoke",
      operation: "execute",
    });
    journal.completeInvocation({
      stage: "smoke",
      operation: "execute",
      before: first,
      outcome: "indeterminate",
      stageReceipt: {
        stage: "smoke",
        status: "failed",
        failureCode: "adapter_process_timeout",
      },
    });
    const second = journal.beginInvocation({
      stage: "smoke",
      operation: "execute",
    });
    journal.completeInvocation({
      stage: "smoke",
      operation: "execute",
      before: second,
      outcome: "completed",
      stageReceipt: {
        stage: "smoke",
        status: "passed",
        evidenceSha256: hash("smoke"),
      },
    });

    const firstBeforePath = path.join(
      root,
      "07-smoke-execute-attempt-001-before.json",
    );
    const tampered = JSON.parse(await readFile(firstBeforePath, "utf8"));
    tampered.deploymentId = "tampered-deployment";
    await writeFile(firstBeforePath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => journal.readStageState("smoke"),
      /stage before journal is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stage journal validates reconciliation history before resuming an interrupted stage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-reconcile-history-"));
  try {
    const deploymentManifest = manifest();
    const adapter = fakeAdapter();
    const journal = createRemoteDeploymentStageJournalV1({
      journalRoot: root,
      binding: journalBinding(deploymentManifest, adapter.identity),
    });
    journal.beginInvocation({
      stage: "install",
      operation: "execute",
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const before = journal.beginInvocation({
        stage: "install",
        operation: "reconcile",
      });
      journal.completeInvocation({
        stage: "install",
        operation: "reconcile",
        before,
        outcome: "completed",
        stageReceipt: {
          stage: "install",
          status: "failed",
          failureCode: "remote_state_not_proven",
        },
      });
    }

    const firstBeforePath = path.join(
      root,
      "04-install-reconcile-attempt-001-before.json",
    );
    const tampered = JSON.parse(await readFile(firstBeforePath, "utf8"));
    tampered.deploymentId = "tampered-deployment";
    await writeFile(firstBeforePath, `${JSON.stringify(tampered, null, 2)}\n`);

    assert.throws(
      () => journal.readStageState("install"),
      /stage before journal is invalid/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
