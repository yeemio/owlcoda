import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRemoteProcessAdapterV1,
} from "../scripts/runkit-contract/remote-process-adapter.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function adapterScript(root) {
  const filePath = path.join(root, "adapter.mjs");
  const source = `#!/usr/bin/env node
let bytes = "";
for await (const chunk of process.stdin) bytes += chunk;
const input = JSON.parse(bytes);
if (process.env.OWLRUNKIT_TEST_SECRET) {
  process.stdout.write(JSON.stringify({ status: "passed", token: process.env.OWLRUNKIT_TEST_SECRET }));
  process.exit(0);
}
if (input.stage === "identity_preflight") {
  process.stdout.write(JSON.stringify({
    status: "passed",
    hostKeySha256: input.target.hostKeySha256,
    machineIdentitySha256: input.target.machineIdentitySha256
  }));
} else {
  process.stdout.write(JSON.stringify({
    status: "passed",
    evidenceSha256: "${sha256("stage-evidence")}",
    cwd: process.cwd()
  }));
}
`;
  await writeFile(filePath, source);
  await chmod(filePath, 0o755);
  return {
    filePath,
    sha256: sha256(source),
  };
}

test("the standard process adapter verifies exact bytes and uses a constrained environment", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-process-"));
  const previous = process.env.OWLRUNKIT_TEST_SECRET;
  process.env.OWLRUNKIT_TEST_SECRET = "must-not-cross-adapter-boundary";
  try {
    const script = await adapterScript(root);
    const adapter = createRemoteProcessAdapterV1({
      identity: {
        adapterId: "fixture-adapter",
        version: "1.0.0",
        executable: script.filePath,
        sha256: script.sha256,
      },
      workspaceRoot: root,
    });
    const result = await adapter.runStage({
      stage: "identity_preflight",
      target: {
        hostKeySha256: sha256("host"),
        machineIdentitySha256: sha256("machine"),
      },
    });

    assert.equal(result.status, "passed");
    assert.equal(result.hostKeySha256, sha256("host"));
    assert.equal(result.machineIdentitySha256, sha256("machine"));
    assert.equal(JSON.stringify(result).includes("must-not-cross"), false);
  } finally {
    if (previous === undefined) delete process.env.OWLRUNKIT_TEST_SECRET;
    else process.env.OWLRUNKIT_TEST_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("the process adapter fails closed on executable drift and non-JSON output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-process-"));
  try {
    const script = await adapterScript(root);
    await assert.rejects(
      () => createRemoteProcessAdapterV1({
        identity: {
          adapterId: "fixture-adapter",
          version: "1.0.0",
          executable: script.filePath,
          sha256: sha256("wrong"),
        },
        workspaceRoot: root,
      }).runStage({ stage: "smoke" }),
      /hash mismatch/u,
    );

    await writeFile(script.filePath, "#!/usr/bin/env node\nprocess.stdout.write('not json')\n");
    await chmod(script.filePath, 0o755);
    const changedBytes = await import("node:fs/promises").then(({ readFile }) =>
      readFile(script.filePath));
    const adapter = createRemoteProcessAdapterV1({
      identity: {
        adapterId: "fixture-adapter",
        version: "1.0.1",
        executable: script.filePath,
        sha256: sha256(changedBytes),
      },
      workspaceRoot: root,
    });
    const failed = await adapter.runStage({ stage: "smoke" });
    assert.equal(failed.status, "indeterminate");
    assert.equal(failed.failureCode, "adapter_output_invalid");
    assert.match(failed.evidenceSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the process adapter treats transport errors and nonzero exits as indeterminate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-process-"));
  try {
    const script = await adapterScript(root);
    const identity = {
      adapterId: "fixture-adapter",
      version: "1.0.0",
      executable: script.filePath,
      sha256: script.sha256,
    };
    const timedOut = createRemoteProcessAdapterV1({
      identity,
      workspaceRoot: root,
      spawn: () => ({
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      }),
    });
    assert.deepEqual(
      await timedOut.runStage({ stage: "install" }),
      {
        status: "indeterminate",
        failureCode: "adapter_process_timeout",
        evidenceSha256: sha256("Error: timed out"),
      },
    );

    const nonzero = createRemoteProcessAdapterV1({
      identity,
      workspaceRoot: root,
      spawn: () => ({
        status: 23,
        stdout: "",
        stderr: "transport closed",
      }),
    });
    const result = await nonzero.runStage({ stage: "service" });
    assert.equal(result.status, "indeterminate");
    assert.equal(result.failureCode, "adapter_process_exit_23");
    assert.match(result.evidenceSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the process adapter pins every remote stage to the declared workspace cwd", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-remote-process-cwd-"));
  try {
    const script = await adapterScript(root);
    const adapter = createRemoteProcessAdapterV1({
      identity: {
        adapterId: "fixture-adapter",
        version: "1.0.0",
        executable: script.filePath,
        sha256: script.sha256,
      },
      workspaceRoot: root,
    });

    const result = await adapter.runStage({ stage: "smoke" });
    assert.equal(result.cwd, await realpath(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
