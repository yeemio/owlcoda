import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCoreArtifact,
  inspectProjectUpgradeSafety,
  validateExecutionPin,
} from "../../scripts/runkit-contract/core-contract.mjs";

const HISTORICAL_CORE = {
  contractVersion: "0.2",
  coreVersion: "0.13.0",
  coreManifestSha256:
    "sha256:037c012751b32abbbb48ce8a8d2cd8faa4fc2c38d6797db391205477e667065f",
  coreSourceRef:
    "artifact:sha256:037c012751b32abbbb48ce8a8d2cd8faa4fc2c38d6797db391205477e667065f",
};

const PRODUCER = {
  adapterKind: "codex",
  adapterVersion: "0.1.0",
};

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rehashCloseout(closeout) {
  const acceptance = {
    schemaVersion: closeout.artifact.schemaVersion,
    core: closeout.artifact.core,
    payload: closeout.artifact.payload,
  };
  return {
    ...closeout,
    acceptanceSha256: `sha256:${createHash("sha256").update(canonicalJson(acceptance)).digest("hex")}`,
    artifactSha256: `sha256:${createHash("sha256").update(canonicalJson(closeout.artifact)).digest("hex")}`,
  };
}

async function writeLease(executionRoot, workItemId, state = "active") {
  await writeJson(
    path.join(executionRoot, "leases", `${workItemId}-attempt-001.json`),
    {
      schemaVersion: "OwlCodaRunKitWorkerLeaseV1",
      workItemId,
      attempt: 1,
      ownedPaths: ["src/exact-file.ts"],
      state,
    },
  );
}

async function writeCloseout(executionRoot, runId, decision) {
  const verification = decision === "accepted"
    ? {
        contractVersion: "0.2",
        gateDecision: "accepted_passed",
        gateInputSha256: "a".repeat(64),
        activeReceiptSha256: "b".repeat(64),
        sourceFingerprint: "c".repeat(64),
        verificationContextFingerprint: "d".repeat(64),
        leaseState: "released",
        selectedProfileIds: ["full"],
        releasedLeaseIds: ["accepted-work"],
      }
    : undefined;
  const created = createCoreArtifact({
    core: HISTORICAL_CORE,
    producer: PRODUCER,
    payload: {
      runId,
      decision,
      ...(verification ? { verification } : {}),
      authorizationGranted: false,
    },
  });
  await writeJson(path.join(executionRoot, "engine-pin.json"), HISTORICAL_CORE);
  await writeJson(path.join(executionRoot, "closeout-receipt.json"), created);
  return created;
}

test("upgrade safety ignores preserved active lease bytes in trusted nonaccepted history", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-historical-lease-safe-"),
  );
  try {
    for (const decision of ["rejected", "blocked"]) {
      const runId = `${decision}-history`;
      const executionRoot = path.join(
        workspaceRoot,
        ".owlcoda/runkit/executions",
        runId,
      );
      await writeCloseout(executionRoot, runId, decision);
      await writeLease(executionRoot, `${decision}-work`);
    }

    assert.deepEqual(inspectProjectUpgradeSafety({ workspaceRoot }), {
      status: "safe",
      activeRunIds: [],
      activeLeaseIds: [],
      issues: [],
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("upgrade safety still blocks active execution and accepted lease inconsistency", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-historical-lease-active-"),
  );
  try {
    const activeRoot = path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions/active-run",
    );
    await writeJson(path.join(activeRoot, "engine-pin.json"), HISTORICAL_CORE);
    await writeLease(activeRoot, "live-work");

    const acceptedRoot = path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions/accepted-history",
    );
    await writeCloseout(acceptedRoot, "accepted-history", "accepted");
    await writeLease(acceptedRoot, "accepted-work");

    const result = inspectProjectUpgradeSafety({ workspaceRoot });
    assert.equal(result.status, "unsafe");
    assert.deepEqual(result.activeRunIds, ["active-run"]);
    assert.deepEqual(result.activeLeaseIds, [
      "accepted-history:accepted-work",
      "active-run:live-work",
    ]);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("upgrade safety does not trust a closeout with invalid hashes", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-historical-lease-forged-"),
  );
  try {
    const runId = "forged-history";
    const executionRoot = path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions",
      runId,
    );
    const closeout = await writeCloseout(executionRoot, runId, "rejected");
    await writeJson(path.join(executionRoot, "closeout-receipt.json"), {
      ...closeout,
      artifactSha256: `sha256:${"f".repeat(64)}`,
    });
    await writeLease(executionRoot, "forged-work");

    const result = inspectProjectUpgradeSafety({ workspaceRoot });
    assert.equal(result.status, "unsafe");
    assert.deepEqual(result.activeRunIds, ["forged-history"]);
    assert.deepEqual(result.activeLeaseIds, ["forged-history:forged-work"]);
    assert.match(result.issues.join("\n"), /closeout.*hash/i);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("upgrade safety rejects rehashed nonaccepted closeout payload extensions", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-historical-lease-extra-payload-"),
  );
  try {
    const runId = "extended-history";
    const executionRoot = path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions",
      runId,
    );
    const closeout = createCoreArtifact({
      core: HISTORICAL_CORE,
      producer: PRODUCER,
      payload: {
        runId,
        decision: "blocked",
        authorizationGranted: false,
        unexpected: "not-closeout-truth",
      },
    });
    await writeJson(path.join(executionRoot, "engine-pin.json"), HISTORICAL_CORE);
    await writeJson(path.join(executionRoot, "closeout-receipt.json"), closeout);
    await writeLease(executionRoot, "extended-work");

    const result = inspectProjectUpgradeSafety({ workspaceRoot });
    assert.equal(result.status, "unsafe");
    assert.deepEqual(result.activeLeaseIds, ["extended-history:extended-work"]);
    assert.match(result.issues.join("\n"), /closeout.*payload/i);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Core artifacts reject malformed semantic versions and unbound source refs", () => {
  assert.throws(
    () => createCoreArtifact({
      core: {
        ...HISTORICAL_CORE,
        coreVersion: "evil",
      },
      producer: PRODUCER,
      payload: {},
    }),
    /coreVersion/i,
  );
  assert.throws(
    () => createCoreArtifact({
      core: {
        ...HISTORICAL_CORE,
        coreSourceRef: `artifact:sha256:${"a".repeat(64)}`,
      },
      producer: PRODUCER,
      payload: {},
    }),
    /coreSourceRef/i,
  );
  assert.throws(
    () => createCoreArtifact({
      core: {
        ...HISTORICAL_CORE,
        contractVersion: "evil-contract",
      },
      producer: PRODUCER,
      payload: {},
    }),
    /contractVersion/i,
  );
  assert.throws(
    () => createCoreArtifact({
      core: {
        ...HISTORICAL_CORE,
        unexpectedAuthority: "not-schema-valid",
      },
      producer: PRODUCER,
      payload: {},
    }),
    /Core identity.*unsupported/i,
  );
  assert.throws(
    () => createCoreArtifact({
      core: HISTORICAL_CORE,
      producer: {
        ...PRODUCER,
        unexpectedAuthority: "not-schema-valid",
      },
      payload: {},
    }),
    /Producer.*unsupported/i,
  );
  assert.throws(
    () => createCoreArtifact({
      core: HISTORICAL_CORE,
      producer: {
        adapterKind: "",
        adapterVersion: "",
      },
      payload: {},
    }),
    /Producer.*non-empty/i,
  );
  assert.deepEqual(
    validateExecutionPin({
      expected: {
        ...HISTORICAL_CORE,
        coreSourceRef: undefined,
      },
      actual: {
        ...HISTORICAL_CORE,
        coreSourceRef: undefined,
      },
    }),
    {
      status: "invalid_input",
      exitCode: 3,
      issues: [
        "invalid engine pin: Core identity coreSourceRef must be a non-empty string.",
      ],
    },
  );
});

test("upgrade safety rejects schema-invalid Core and engine-pin fields before skipping leases", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "owlrunkit-historical-lease-schema-"),
  );
  try {
    const artifactRunId = "extra-core-history";
    const artifactRoot = path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions",
      artifactRunId,
    );
    const artifactCloseout = await writeCloseout(
      artifactRoot,
      artifactRunId,
      "blocked",
    );
    artifactCloseout.artifact.core.unexpectedAuthority = "not-schema-valid";
    await writeJson(
      path.join(artifactRoot, "closeout-receipt.json"),
      rehashCloseout(artifactCloseout),
    );
    await writeLease(artifactRoot, "extra-core-work");

    const pinRunId = "extra-pin-history";
    const pinRoot = path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions",
      pinRunId,
    );
    await writeCloseout(pinRoot, pinRunId, "rejected");
    await writeJson(path.join(pinRoot, "engine-pin.json"), {
      ...HISTORICAL_CORE,
      unexpected: "not-schema-valid",
    });
    await writeLease(pinRoot, "extra-pin-work");

    const producerRunId = "empty-producer-history";
    const producerRoot = path.join(
      workspaceRoot,
      ".owlcoda/runkit/executions",
      producerRunId,
    );
    const producerCloseout = await writeCloseout(
      producerRoot,
      producerRunId,
      "blocked",
    );
    producerCloseout.artifact.producer = {
      adapterKind: "",
      adapterVersion: "",
    };
    await writeJson(
      path.join(producerRoot, "closeout-receipt.json"),
      rehashCloseout(producerCloseout),
    );
    await writeLease(producerRoot, "empty-producer-work");

    const result = inspectProjectUpgradeSafety({ workspaceRoot });
    assert.equal(result.status, "unsafe");
    assert.deepEqual(result.activeLeaseIds, [
      "empty-producer-history:empty-producer-work",
      "extra-core-history:extra-core-work",
      "extra-pin-history:extra-pin-work",
    ]);
    assert.match(result.issues.join("\n"), /Core identity.*unsupported/i);
    assert.match(result.issues.join("\n"), /invalid engine pin/i);
    assert.match(result.issues.join("\n"), /Producer.*non-empty/i);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
