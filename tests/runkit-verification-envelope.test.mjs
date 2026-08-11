import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  access,
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
  resolveVerificationEnvelopeBackendV1,
  runVerificationEnvelopeV1,
  validateVerificationEnvelopeV1,
  verifyVerificationEnvelopeReceiptV1,
} from "../scripts/runkit-contract/verification-envelope.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function command(argv, timeoutMs = 5_000) {
  return {
    executable: process.execPath,
    argv,
    timeoutMs,
  };
}

function envelope(overrides = {}) {
  const value = {
    schemaVersion: "OwlCodaRunKitVerificationEnvelopeV1",
    envelopeId: "quality-v1",
    cwd: ".",
    lockfiles: ["package-lock.json"],
    paths: {
      immutableSource: ["src/**", "checks/**", "package-lock.json"],
      declaredOutput: ["artifacts/**"],
      disposableScratch: [".scratch/**"],
      forbidden: [".env", ".ssh/**", ".owlcoda/**"],
    },
    environment: {
      allowNames: ["PATH"],
      values: {},
    },
    network: { mode: "deny" },
    process: {
      allowSubprocesses: false,
      allowedExecutables: [],
      allowBackgroundAfterFinish: false,
    },
    phases: {
      setup: null,
      check: command(["checks/pass.mjs"]),
      teardown: null,
    },
    ...overrides,
  };
  return value;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-envelope-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "checks"), { recursive: true });
  await writeFile(path.join(root, "src/value.txt"), "immutable\n");
  await writeFile(path.join(root, "package-lock.json"), "fixture-lock\n");
  await writeFile(path.join(root, ".env"), "SECRET=must-not-leak\n");
  await writeFile(path.join(root, "checks/pass.mjs"), [
    'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    'readFileSync("src/value.txt", "utf8");',
    'mkdirSync("artifacts", { recursive: true });',
    'mkdirSync(".scratch", { recursive: true });',
    'writeFileSync("artifacts/result.json", "{}\\n");',
    'writeFileSync(".scratch/cache.txt", "cache\\n");',
    'process.stdout.write("quality passed\\n");',
    "",
  ].join("\n"));
  return root;
}

test("VerificationEnvelope validates exact commands and rejects ambiguous authority", async () => {
  const root = await setup();
  try {
    const valid = validateVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope(),
    });
    assert.equal(valid.envelope.schemaVersion, "OwlCodaRunKitVerificationEnvelopeV1");
    assert.match(valid.envelopeSha256, /^[a-f0-9]{64}$/u);
    assert.equal(valid.authorizationGranted, false);

    const repeatedArgv = validateVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        phases: {
          setup: null,
          check: command(["checks/pass.mjs", "", "same", "same"]),
          teardown: null,
        },
      }),
    });
    assert.deepEqual(repeatedArgv.envelope.phases.check.argv, [
      "checks/pass.mjs", "", "same", "same",
    ]);

    assert.throws(() => validateVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({ network: { mode: "unknown" } }),
    }), /network mode must be deny or loopback/iu);
    assert.throws(() => validateVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        environment: { allowNames: [], values: { API_TOKEN: "secret" } },
      }),
    }), /environment value.*not allowlisted/iu);
    assert.throws(() => validateVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        paths: {
          ...envelope().paths,
          forbidden: ["artifacts/**"],
        },
      }),
    }), /path classes overlap/iu);
    assert.throws(() => validateVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        phases: {
          setup: null,
          check: { executable: "node", argv: ["checks/pass.mjs"], timeoutMs: 5_000 },
          teardown: null,
        },
      }),
    }), /executable must be an absolute regular file/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing enforcement backend captures no evidence and never executes the command", async () => {
  const root = await setup();
  try {
    const marker = path.join(root, "artifacts/result.json");
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope(),
      artifactRoot: path.join(root, ".owlcoda/runkit/envelope-test"),
      backend: {
        id: "unavailable",
        available: false,
        reason: "fixture_backend_missing",
      },
    });
    assert.equal(result.status, "policy_backend_unavailable");
    assert.equal(result.formalEligible, false);
    assert.equal(result.commandExecuted, false);
    assert.equal(result.nextAllowedAction, "install_supported_enforcement_backend_or_use_captured_evidence");
    await assert.rejects(access(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the platform backend enforces declared output and scratch while preserving source", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    const backend = resolveVerificationEnvelopeBackendV1();
    assert.equal(backend.id, "macos_sandbox_exec_v1");
    assert.equal(backend.available, true);
    const artifactRoot = path.join(root, ".owlcoda/runkit/envelope-pass");
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope(),
      artifactRoot,
    });
    assert.equal(result.status, "verification_envelope_passed", JSON.stringify(result));
    assert.equal(result.formalEligible, true);
    assert.equal(result.commandExecuted, true);
    assert.equal(result.source.beforeSha256, result.source.afterSha256);
    assert.deepEqual(result.outputs.map(row => row.path), ["artifacts/result.json"]);
    assert.equal(result.cleanup.remainingProcessIds.length, 0);
    assert.equal(result.cleanup.remainingPorts.length, 0);
    assert.equal(await readFile(path.join(root, "src/value.txt"), "utf8"), "immutable\n");
    assert.equal(await readFile(path.join(root, "artifacts/result.json"), "utf8"), "{}\n");

    const verified = verifyVerificationEnvelopeReceiptV1({
      workspaceRoot: root,
      receiptPath: result.receiptPath,
    });
    assert.equal(verified.status, "verification_envelope_receipt_valid");
    assert.equal(verified.formalEligible, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable-source writes are blocked and cannot produce Formal-eligible evidence", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "checks/write-source.mjs"), [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("src/value.txt", "mutated\\n");',
      "",
    ].join("\n"));
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        phases: {
          setup: null,
          check: command(["checks/write-source.mjs"]),
          teardown: null,
        },
      }),
      artifactRoot: path.join(root, ".owlcoda/runkit/envelope-write-source"),
    });
    assert.equal(result.status, "verification_envelope_failed");
    assert.equal(result.formalEligible, false);
    assert.equal(result.phases[0].exitCode === 0, false);
    assert.equal(result.source.beforeSha256, result.source.afterSha256);
    assert.equal(await readFile(path.join(root, "src/value.txt"), "utf8"), "immutable\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undeclared output and credential reads are blocked", {
  skip: process.platform !== "darwin",
}, async (t) => {
  for (const scenario of [
    {
      name: "undeclared output",
      body: 'import { writeFileSync } from "node:fs"; writeFileSync("unexpected.txt", "x");',
    },
    {
      name: "credential read",
      body: 'import { readFileSync } from "node:fs"; readFileSync(".env", "utf8");',
    },
  ]) {
    await t.test(scenario.name, async () => {
      const root = await setup();
      try {
        await writeFile(path.join(root, "checks/violate.mjs"), `${scenario.body}\n`);
        const result = await runVerificationEnvelopeV1({
          workspaceRoot: root,
          envelope: envelope({
            phases: {
              setup: null,
              check: command(["checks/violate.mjs"]),
              teardown: null,
            },
          }),
          artifactRoot: path.join(root, ".owlcoda/runkit/envelope-violation"),
        });
        assert.equal(result.status, "verification_envelope_failed");
        assert.equal(result.formalEligible, false);
        await assert.rejects(access(path.join(root, "unexpected.txt")));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("unauthorized network is denied by policy and a failed check is not accepted", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  const server = createServer(socket => socket.end("should not be reached"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await writeFile(path.join(root, "checks/network.mjs"), [
      'import { connect } from "node:net";',
      `const socket = connect({ host: "127.0.0.1", port: ${port} });`,
      'socket.once("connect", () => process.exit(0));',
      'socket.once("error", () => process.exit(23));',
      'setTimeout(() => process.exit(24), 1000);',
      "",
    ].join("\n"));
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        phases: {
          setup: null,
          check: command(["checks/network.mjs"]),
          teardown: null,
        },
      }),
      artifactRoot: path.join(root, ".owlcoda/runkit/envelope-network"),
    });
    assert.equal(result.status, "verification_envelope_failed");
    assert.equal(result.formalEligible, false);
    assert.equal(result.phases[0].exitCode, 23);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("declared loopback access supports a bounded local service check", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  const server = createServer(socket => socket.end("healthy"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await writeFile(path.join(root, "checks/loopback.mjs"), [
      'import { connect } from "node:net";',
      `const socket = connect({ host: "127.0.0.1", port: ${port} });`,
      'socket.once("data", data => process.exit(data.toString() === "healthy" ? 0 : 22));',
      'socket.once("error", () => process.exit(23));',
      'setTimeout(() => process.exit(24), 1000);',
      "",
    ].join("\n"));
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        network: { mode: "loopback" },
        phases: {
          setup: null,
          check: command(["checks/loopback.mjs"]),
          teardown: null,
        },
      }),
      artifactRoot: path.join(root, ".owlcoda/runkit/envelope-loopback"),
    });
    assert.equal(result.status, "verification_envelope_passed", JSON.stringify(result));
    assert.equal(result.formalEligible, true);
    assert.equal(result.phases[0].exitCode, 0);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("setup, check, and teardown are bounded and teardown still runs after a failed check", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "checks/setup.mjs"), [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'mkdirSync(".scratch", { recursive: true });',
      'writeFileSync(".scratch/db", "ready");',
      "",
    ].join("\n"));
    await writeFile(path.join(root, "checks/fail.mjs"), "process.exit(7);\n");
    await writeFile(path.join(root, "checks/teardown.mjs"), [
      'import { rmSync } from "node:fs";',
      'rmSync(".scratch/db", { force: true });',
      "",
    ].join("\n"));
    const value = envelope({
      phases: {
        setup: command(["checks/setup.mjs"]),
        check: command(["checks/fail.mjs"]),
        teardown: command(["checks/teardown.mjs"]),
      },
    });
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: value,
      artifactRoot: path.join(root, ".owlcoda/runkit/envelope-phases"),
    });
    assert.equal(result.status, "verification_envelope_failed");
    assert.deepEqual(result.phases.map(row => row.name), ["setup", "check", "teardown"]);
    assert.deepEqual(result.phases.map(row => row.exitCode), [0, 7, 0]);
    await assert.rejects(access(path.join(root, ".scratch/db")));
    assert.equal(result.cleanup.teardownCompleted, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a leaked subprocess is blocked or killed and cannot become Formal-eligible", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    await writeFile(path.join(root, "checks/leak.mjs"), [
      'import { spawn } from "node:child_process";',
      'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "",
    ].join("\n"));
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope({
        process: {
          allowSubprocesses: true,
          allowedExecutables: [process.execPath],
          allowBackgroundAfterFinish: false,
        },
        phases: {
          setup: null,
          check: command(["checks/leak.mjs"]),
          teardown: null,
        },
      }),
      artifactRoot: path.join(root, ".owlcoda/runkit/envelope-leak"),
    });
    assert.equal(result.status, "verification_envelope_failed");
    assert.equal(result.formalEligible, false);
    assert.ok(
      result.cleanup.terminatedProcessIds.length >= 1
      || result.phases[0].exitCode !== 0,
    );
    assert.equal(result.cleanup.remainingProcessIds.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("receipt verification detects byte drift", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await setup();
  try {
    const result = await runVerificationEnvelopeV1({
      workspaceRoot: root,
      envelope: envelope(),
      artifactRoot: path.join(root, ".owlcoda/runkit/envelope-drift"),
    });
    const receipt = JSON.parse(await readFile(result.receiptPath, "utf8"));
    receipt.formalEligible = false;
    await writeJson(result.receiptPath, receipt);
    assert.throws(() => verifyVerificationEnvelopeReceiptV1({
      workspaceRoot: root,
      receiptPath: result.receiptPath,
    }), /receipt hash mismatch/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
