import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createSshRemoteAdapterV1,
} from "../scripts/runkit-contract/ssh-remote-adapter.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function target(hostKeySha256, overrides = {}) {
  return {
    schemaVersion: "OwlCodaRunKitRemoteTargetV1",
    targetId: "vm-production-01",
    environment: "production",
    host: "deploy.example.invalid",
    port: 2222,
    user: "deploy",
    hostKeySha256,
    machineIdentitySha256: sha256("machine-identity"),
    ...overrides,
  };
}

function stageContracts() {
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
      checks: [
        {
          checkId: "service-active",
          kind: "systemd_active",
          unitName: "owlapp.service",
        },
        {
          checkId: "health",
          kind: "http",
          url: "http://127.0.0.1:3100/health",
          expectedStatus: 200,
        },
      ],
    },
  };
}

function remoteHelper(overrides = {}) {
  return {
    path: "/usr/local/libexec/owlrunkit-remote-helper",
    protocol: "OwlCodaRunKitSshRemoteHelperV1",
    version: "1.0.0",
    capabilities: ["execute", "reconcile"],
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-ssh-adapter-"));
  const knownHostsPath = path.join(root, "known_hosts");
  const artifactPath = path.join(root, "release.tgz");
  const knownHosts = "[deploy.example.invalid]:2222 ssh-ed25519 AAAATESTKEY\n";
  const artifact = Buffer.from("release archive bytes");
  await writeFile(knownHostsPath, knownHosts);
  await writeFile(artifactPath, artifact);
  return {
    root,
    knownHostsPath,
    artifactPath,
    knownHosts,
    artifact,
  };
}

function commonStageInput(fx, overrides = {}) {
  const inputTarget = target(sha256(fx.knownHosts));
  return {
    deploymentId: "deployment-001",
    deploymentLineageSha256: sha256("deployment-lineage"),
    mode: "first",
    target: inputTarget,
    artifact: {
      path: "release.tgz",
      sha256: sha256(fx.artifact),
      size: fx.artifact.length,
      mediaType: "application/gzip",
    },
    upload: {
      remotePath: "/var/lib/owlcoda/staging/release.tgz",
      createOnly: true,
    },
    priorDeployment: null,
    expectedRemoteFiles: [],
    deletionAllowlist: [],
    permissions: {
      deploy: true,
      destructive: false,
    },
    credentialRef: "agent:owlcoda/deploy-production",
    ...overrides,
  };
}

function passedOutput(stage, payload, input) {
  if (stage === "identity_preflight") {
    return {
      status: "passed",
      machineIdentitySha256: input.target.machineIdentitySha256,
      remoteHelper: payload.expectedRemoteHelper,
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
      verifiedPriorFiles: input.expectedRemoteFiles,
    };
  }
  if (stage === "install") {
    return {
      status: "passed",
      mode: input.mode,
      installedArtifactSha256: input.artifact.sha256,
      deletedFiles: input.deletionAllowlist,
      evidenceSha256: sha256(`evidence:${stage}`),
    };
  }
  if (stage === "service") {
    return {
      status: "passed",
      unitName: payload.contract.unitName,
      unitFileSha256: payload.contract.unitFile.sha256,
      evidenceSha256: sha256(`evidence:${stage}`),
    };
  }
  if (stage === "proxy") {
    return {
      status: "passed",
      siteName: payload.contract.siteName,
      configFileSha256: payload.contract.configFile.sha256,
      evidenceSha256: sha256(`evidence:${stage}`),
    };
  }
  return {
    status: "passed",
    checks: payload.contract.checks.map(({ checkId }) => ({
      checkId,
      status: "passed",
      evidenceSha256: sha256(`smoke:${checkId}`),
    })),
    evidenceSha256: sha256(`evidence:${stage}`),
  };
}

function recordingRunner(input) {
  const calls = [];
  const runner = async (file, args, options) => {
    const payload = JSON.parse(options.input);
    calls.push({
      file,
      args: [...args],
      options: { ...options, input: payload },
    });
    const output = input?.resultFor
      ? input.resultFor(payload.stage, payload, calls.length - 1)
      : passedOutput(payload.stage, payload, input.stageInput);
    return {
      status: 0,
      stdout: `${JSON.stringify(output)}\n`,
      stderr: "",
    };
  };
  return { calls, runner };
}

test("pins SSH identity and StrictHostKeyChecking without invoking a shell", async () => {
  const fx = await fixture();
  try {
    const stageInput = commonStageInput(fx);
    const recording = recordingRunner({ stageInput });
    const adapter = createSshRemoteAdapterV1({
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      stageContracts: stageContracts(),
      sshExecutable: "/usr/bin/ssh",
      execFile: recording.runner,
    });

    const result = await adapter.runStage({
      stage: "identity_preflight",
      ...stageInput,
    });

    assert.deepEqual(result, {
      status: "passed",
      hostKeySha256: stageInput.target.hostKeySha256,
      machineIdentitySha256: stageInput.target.machineIdentitySha256,
      remoteHelper: remoteHelper(),
    });
    assert.equal(recording.calls.length, 1);
    assert.equal(recording.calls[0].file, "/usr/bin/ssh");
    assert.deepEqual(recording.calls[0].args, [
      "-F",
      "none",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${await realpath(fx.knownHostsPath)}`,
      "-p",
      "2222",
      "deploy@deploy.example.invalid",
      "/usr/local/libexec/owlrunkit-remote-helper",
      "--protocol",
      "OwlCodaRunKitSshRemoteHelperV1",
      "--stage",
      "identity_preflight",
    ]);
    assert.equal(recording.calls[0].options.shell, false);
    assert.equal(recording.calls[0].options.input.target.targetId, "vm-production-01");
    assert.equal(
      JSON.stringify(recording.calls[0]).includes("machine-identity"),
      false,
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("requires a caller-provided remote helper and rejects a mismatched capability handshake", async () => {
  const fx = await fixture();
  try {
    const stageInput = commonStageInput(fx);
    assert.throws(
      () => createSshRemoteAdapterV1({
        target: stageInput.target,
        credential: {
          ref: stageInput.credentialRef,
          mode: "agent",
        },
        knownHostsPath: fx.knownHostsPath,
        workspaceRoot: fx.root,
        stageContracts: stageContracts(),
        execFile: recordingRunner({ stageInput }).runner,
      }),
      /remote helper binding is required/iu,
    );

    const recording = recordingRunner({
      stageInput,
      resultFor(stage, payload) {
        return {
          ...passedOutput(stage, payload, stageInput),
          remoteHelper: {
            ...remoteHelper(),
            version: "9.9.9",
          },
        };
      },
    });
    const adapter = createSshRemoteAdapterV1({
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      stageContracts: stageContracts(),
      execFile: recording.runner,
    });

    const result = await adapter.runStage({
      stage: "identity_preflight",
      ...stageInput,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failureCode, "remote_helper_capability_mismatch");
    assert.deepEqual(
      recording.calls[0].options.input.expectedRemoteHelper,
      remoteHelper(),
    );
    assert.equal(
      recording.calls[0].args.includes(remoteHelper().path),
      true,
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("runs every first-deployment stage through structured helper payloads", async () => {
  const fx = await fixture();
  try {
    const stageInput = commonStageInput(fx);
    const recording = recordingRunner({ stageInput });
    const contracts = stageContracts();
    const adapter = createSshRemoteAdapterV1({
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      stageContracts: contracts,
      sshExecutable: "/usr/bin/ssh",
      execFile: recording.runner,
    });
    const results = [];
    for (const stage of [
      "identity_preflight",
      "upload",
      "verify_remote_hashes",
      "install",
      "service",
      "proxy",
      "smoke",
    ]) {
      results.push(await adapter.runStage({ stage, ...stageInput }));
    }

    assert.equal(results.every((result) => (
      ["passed", "created"].includes(result.status)
    )), true);
    assert.deepEqual(
      recording.calls.map((call) => call.options.input.stage),
      [
        "identity_preflight",
        "upload",
        "verify_remote_hashes",
        "install",
        "service",
        "proxy",
        "smoke",
      ],
    );
    const upload = recording.calls[1].options.input;
    assert.equal(upload.createOnly, true);
    assert.equal(upload.contentBase64, fx.artifact.toString("base64"));
    assert.deepEqual(recording.calls[3].options.input.contract, {
      ...contracts.install,
      releasePath: "/opt/owlapp/releases/deployment-001",
    });
    assert.deepEqual(recording.calls[4].options.input.contract, contracts.systemd);
    assert.deepEqual(recording.calls[5].options.input.contract, contracts.nginx);
    assert.deepEqual(recording.calls[6].options.input.contract, contracts.smoke);
    for (const call of recording.calls) {
      assert.equal(call.options.shell, false);
      assert.equal(
        call.args.some((argument) => (
          argument === "sh"
          || argument === "-c"
          || /(?:;|\$\(|`|\||&&)/u.test(argument)
        )),
        false,
      );
    }
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("update install requires exact prior hashes and reports only allowlisted deletions", async () => {
  const fx = await fixture();
  try {
    const expectedRemoteFiles = [{
      path: "/opt/owlapp/current/obsolete.js",
      sha256: sha256("obsolete"),
    }];
    const deletionAllowlist = [{
      path: "/opt/owlapp/current/obsolete.js",
      priorSha256: sha256("obsolete"),
    }];
    const stageInput = commonStageInput(fx, {
      mode: "update",
      permissions: {
        deploy: true,
        destructive: true,
      },
      priorDeployment: {
        receiptSha256: sha256("prior-receipt"),
        artifactSha256: sha256("prior-artifact"),
      },
      expectedRemoteFiles,
      deletionAllowlist,
    });
    const recording = recordingRunner({ stageInput });
    const adapter = createSshRemoteAdapterV1({
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      stageContracts: stageContracts(),
      sshExecutable: "/usr/bin/ssh",
      execFile: recording.runner,
    });

    const verified = await adapter.runStage({
      stage: "verify_remote_hashes",
      ...stageInput,
    });
    const installed = await adapter.runStage({
      stage: "install",
      ...stageInput,
    });
    assert.equal(verified.status, "passed");
    assert.equal(installed.status, "passed");
    assert.deepEqual(
      recording.calls[1].options.input.deletionAllowlist,
      deletionAllowlist,
    );

    const unsafeRunner = recordingRunner({
      stageInput,
      resultFor(stage, payload) {
        return {
          ...passedOutput(stage, payload, stageInput),
          deletedFiles: [
            ...deletionAllowlist,
            {
              path: "/opt/owlapp/current/not-authorized.js",
              priorSha256: sha256("not-authorized"),
            },
          ],
        };
      },
    });
    const unsafeAdapter = createSshRemoteAdapterV1({
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      stageContracts: stageContracts(),
      sshExecutable: "/usr/bin/ssh",
      execFile: unsafeRunner.runner,
    });
    const rejected = await unsafeAdapter.runStage({
      stage: "install",
      ...stageInput,
    });
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.failureCode, "remote_deletion_set_mismatch");
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("rejects arbitrary service, proxy, smoke, target, and helper commands before SSH", async () => {
  const fx = await fixture();
  try {
    const stageInput = commonStageInput(fx);
    const recording = recordingRunner({ stageInput });
    const base = {
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      sshExecutable: "/usr/bin/ssh",
      execFile: recording.runner,
    };
    for (const contracts of [
      {
        ...stageContracts(),
        systemd: {
          ...stageContracts().systemd,
          command: "systemctl restart owlapp; curl attacker",
        },
      },
      {
        ...stageContracts(),
        nginx: {
          ...stageContracts().nginx,
          argv: ["nginx", "-s", "reload"],
        },
      },
      {
        ...stageContracts(),
        smoke: {
          command: "curl http://127.0.0.1:3100/health",
        },
      },
    ]) {
      assert.throws(
        () => createSshRemoteAdapterV1({
          ...base,
          stageContracts: contracts,
        }),
        /unsupported field|structured/u,
      );
    }
    assert.throws(
      () => createSshRemoteAdapterV1({
        ...base,
        target: {
          ...stageInput.target,
          host: "deploy.example.invalid;touch-pwn",
        },
        stageContracts: stageContracts(),
      }),
      /exact host/u,
    );
    assert.throws(
      () => createSshRemoteAdapterV1({
        ...base,
        remoteHelper: remoteHelper({
          path: "/usr/local/bin/helper;touch-pwn",
        }),
        stageContracts: stageContracts(),
      }),
      /remote helper path/u,
    );
    assert.throws(
      () => createSshRemoteAdapterV1({
        ...base,
        remoteHelper: remoteHelper({ path: "/bin/sh" }),
        stageContracts: stageContracts(),
      }),
      /remote helper executable name/u,
    );
    assert.throws(
      () => createSshRemoteAdapterV1({
        ...base,
        sshExecutable: "/bin/sh",
        stageContracts: stageContracts(),
      }),
      /SSH executable/u,
    );
    assert.equal(recording.calls.length, 0);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("fails closed with structured evidence on host-key drift, artifact drift, timeout, and invalid output", async () => {
  const fx = await fixture();
  try {
    const stageInput = commonStageInput(fx);
    const create = (execFile) => createSshRemoteAdapterV1({
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      stageContracts: stageContracts(),
      sshExecutable: "/usr/bin/ssh",
      execFile,
    });

    const neverCalled = recordingRunner({ stageInput });
    const hostDriftAdapter = create(neverCalled.runner);
    await writeFile(fx.knownHostsPath, "changed host key bytes\n");
    const hostDrift = await hostDriftAdapter.runStage({
      stage: "identity_preflight",
      ...stageInput,
    });
    assert.deepEqual(hostDrift, {
      status: "failed",
      failureCode: "known_hosts_hash_mismatch",
      evidenceSha256: sha256("known_hosts_hash_mismatch"),
    });
    assert.equal(neverCalled.calls.length, 0);

    await writeFile(fx.knownHostsPath, fx.knownHosts);
    const missingHostRunner = recordingRunner({ stageInput });
    const missingHostAdapter = create(missingHostRunner.runner);
    await unlink(fx.knownHostsPath);
    const missingHostFile = await missingHostAdapter.runStage({
      stage: "identity_preflight",
      ...stageInput,
    });
    assert.equal(missingHostFile.status, "failed");
    assert.equal(missingHostFile.failureCode, "known_hosts_invalid");
    assert.equal(missingHostRunner.calls.length, 0);

    await writeFile(fx.knownHostsPath, fx.knownHosts);
    await writeFile(fx.artifactPath, "drifted artifact");
    const artifactRunner = recordingRunner({ stageInput });
    const artifactDrift = await create(artifactRunner.runner).runStage({
      stage: "upload",
      ...stageInput,
    });
    assert.equal(artifactDrift.status, "failed");
    assert.equal(artifactDrift.failureCode, "local_artifact_hash_mismatch");
    assert.equal(artifactRunner.calls.length, 0);

    await writeFile(fx.artifactPath, fx.artifact);
    const timeout = new Error("timed out");
    timeout.code = "ETIMEDOUT";
    const timedOut = await create(async () => {
      throw timeout;
    }).runStage({
      stage: "service",
      ...stageInput,
    });
    assert.equal(timedOut.status, "indeterminate");
    assert.equal(timedOut.failureCode, "ssh_process_timeout");
    assert.match(timedOut.evidenceSha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(timedOut).includes("timed out"), false);

    const invalid = await create(async () => ({
      status: 0,
      stdout: "not-json",
      stderr: "remote-secret-must-not-be-returned",
    })).runStage({
      stage: "proxy",
      ...stageInput,
    });
    assert.equal(invalid.status, "indeterminate");
    assert.equal(invalid.failureCode, "ssh_output_invalid");
    assert.equal(
      JSON.stringify(invalid).includes("remote-secret"),
      false,
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("revalidates known_hosts, identity file, and SSH executable exact bytes before every remote stage", async () => {
  const fx = await fixture();
  try {
    const identityPath = path.join(fx.root, "deploy-identity");
    const sshPath = path.join(fx.root, "ssh");
    const identityBytes = "exact private identity fixture";
    const sshBytes = "exact ssh executable fixture";
    await writeFile(identityPath, identityBytes);
    await writeFile(sshPath, sshBytes);
    const stageInput = commonStageInput(fx, {
      credentialRef: "keychain:owlcoda/deploy-production",
    });

    for (const drift of ["known_hosts", "identity_file", "ssh_executable"]) {
      await writeFile(fx.knownHostsPath, fx.knownHosts);
      await writeFile(identityPath, identityBytes);
      await writeFile(sshPath, sshBytes);
      const recording = recordingRunner({ stageInput });
      const adapter = createSshRemoteAdapterV1({
        target: stageInput.target,
        credential: {
          ref: stageInput.credentialRef,
          mode: "identity_file",
          identityFile: {
            path: identityPath,
            sha256: sha256(identityBytes),
          },
        },
        knownHostsPath: fx.knownHostsPath,
        workspaceRoot: fx.root,
        remoteHelper: remoteHelper(),
        stageContracts: stageContracts(),
        sshExecutable: sshPath,
        sshExecutableSha256: sha256(sshBytes),
        execFile: recording.runner,
      });
      const first = await adapter.runStage({
        stage: "identity_preflight",
        ...stageInput,
      });
      assert.equal(first.status, "passed");

      if (drift === "known_hosts") {
        await writeFile(fx.knownHostsPath, "changed known hosts\n");
      } else if (drift === "identity_file") {
        await writeFile(identityPath, "changed identity\n");
      } else {
        await writeFile(sshPath, "changed ssh executable\n");
      }
      const second = await adapter.runStage({
        stage: "upload",
        ...stageInput,
      });

      assert.equal(second.status, "failed");
      assert.equal(second.failureCode, `${drift}_hash_mismatch`);
      assert.equal(recording.calls.length, 1);
    }
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("uses the read-only remote reconciliation operation instead of replaying a side-effect stage", async () => {
  const fx = await fixture();
  try {
    const sshPath = path.join(fx.root, "ssh");
    const sshBytes = "exact ssh executable fixture";
    await writeFile(sshPath, sshBytes);
    const stageInput = commonStageInput(fx);
    const recording = recordingRunner({ stageInput });
    const adapter = createSshRemoteAdapterV1({
      target: stageInput.target,
      credential: {
        ref: stageInput.credentialRef,
        mode: "agent",
      },
      knownHostsPath: fx.knownHostsPath,
      workspaceRoot: fx.root,
      remoteHelper: remoteHelper(),
      stageContracts: stageContracts(),
      sshExecutable: sshPath,
      sshExecutableSha256: sha256(sshBytes),
      execFile: recording.runner,
    });

    const reconciled = await adapter.reconcileStage({
      stage: "install",
      ...stageInput,
    });

    assert.equal(reconciled.status, "passed");
    assert.equal(recording.calls.length, 1);
    assert.equal(recording.calls[0].options.input.operation, "reconcile");
    assert.deepEqual(recording.calls[0].args.slice(-2), [
      "--operation",
      "reconcile",
    ]);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});
