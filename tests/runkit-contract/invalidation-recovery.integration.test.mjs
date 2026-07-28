import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalSourceFingerprint,
  verifyDeliveryPacket,
} from "../../scripts/runkit-contract/source-fingerprint.mjs";
import { resolveProfileImpact } from "../../scripts/runkit-contract/profile-impact.mjs";
import {
  receiptSha256,
  validateReceiptLineage,
} from "../../scripts/runkit-contract/receipt-lineage.mjs";

const desktopFixturePath = "desktop/osui/src/renderer/state/run003-fixture.ts";
const initialFixture = 'export const state = "initial";\n';
const replacementFixture = 'export const state = "replacement";\n';
const profiles = [
  { id: "desktop-profile", paths: ["desktop/osui/src/renderer/state/**"] },
  { id: "root-runtime", paths: ["src/native/**", "package.json"] },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function packetForFixture(content) {
  const files = { [desktopFixturePath]: sha256(content) };
  return {
    schemaVersion: "ExecutionDeliveryPacketV1",
    changedFiles: { wholeFileSha256: files },
    sourceFingerprint: { sha256: canonicalSourceFingerprint(files) },
  };
}

test("invalidates stale evidence before a verifier command and recovers through one targeted replacement", async (t) => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "owlcoda-run003-integration-"));
  const fixturePath = path.join(workspaceRoot, desktopFixturePath);
  await mkdir(path.dirname(fixturePath), { recursive: true });

  try {
    await writeFile(fixturePath, initialFixture);
    const originalPacket = packetForFixture(initialFixture);
    const initialGate = verifyDeliveryPacket({ workspaceRoot, packet: originalPacket });
    assert.equal(initialGate.status, "valid");

    let commandRuns = 0;
    function gateBeforeVerifier(packet) {
      const sourceGate = verifyDeliveryPacket({ workspaceRoot, packet });
      if (sourceGate.status !== "valid") return sourceGate;
      commandRuns += 1;
      return sourceGate;
    }

    await writeFile(fixturePath, replacementFixture);
    const staleGate = gateBeforeVerifier(originalPacket);
    assert.equal(staleGate.status, "invalidated_by_concurrent_write");
    assert.equal(commandRuns, 0);
    assert.match(staleGate.issues.join("\n"), /whole-file hash mismatch/);

    const impact = resolveProfileImpact({
      changedPaths: [desktopFixturePath],
      profiles,
    });
    assert.deepEqual(impact, {
      decision: "targeted_profiles",
      profileIds: ["desktop-profile"],
      uncoveredPaths: [],
    });

    const replacementPacket = packetForFixture(replacementFixture);
    const replacementGate = verifyDeliveryPacket({ workspaceRoot, packet: replacementPacket });
    assert.equal(replacementGate.status, "valid");
    assert.equal(
      replacementGate.recomputedFingerprint,
      replacementPacket.sourceFingerprint.sha256,
    );

    const invalidatedReceipt = {
      receiptId: "run003-verification-original",
      status: "invalidated_by_concurrent_write",
      declaredFingerprint: originalPacket.sourceFingerprint.sha256,
      recomputedFingerprint: staleGate.recomputedFingerprint,
      changedPaths: [desktopFixturePath],
      commandRuns,
    };
    const replacementReceipt = {
      receiptId: "run003-verification-replacement",
      status: "passed",
      sourceFingerprint: replacementPacket.sourceFingerprint.sha256,
      selectedProfileIds: impact.profileIds,
      commandRuns,
    };
    const parentReceiptSha256 = receiptSha256(invalidatedReceipt);
    const replacementReceiptSha256 = receiptSha256(replacementReceipt);
    const receipts = [
      {
        receiptSha256: parentReceiptSha256,
        receipt: invalidatedReceipt,
      },
      {
        receiptSha256: replacementReceiptSha256,
        parentReceiptSha256,
        receipt: replacementReceipt,
      },
    ];
    const receiptsBeforeValidation = structuredClone(receipts);

    const lineage = validateReceiptLineage(receipts);
    assert.equal(lineage.valid, true);
    assert.equal(lineage.active.receiptSha256, replacementReceiptSha256);
    assert.deepEqual(lineage.superseded, [receipts[0]]);
    assert.deepEqual(lineage.issues, []);
    assert.deepEqual(receipts, receiptsBeforeValidation);
    assert.equal(
      receipts.filter((entry) => entry.receiptSha256 === lineage.active.receiptSha256)
        .length,
      1,
    );
    assert.equal(await readFile(fixturePath, "utf8"), replacementFixture);

    t.diagnostic(JSON.stringify({
      oldFingerprint: originalPacket.sourceFingerprint.sha256,
      newFingerprint: replacementPacket.sourceFingerprint.sha256,
      changedPaths: [desktopFixturePath],
      selectedProfileIds: impact.profileIds,
      parentReceiptSha256,
      replacementReceiptSha256,
      commandRuns,
    }));
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("requires the full profile when a changed path has no profile rule", () => {
  assert.deepEqual(
    resolveProfileImpact({
      changedPaths: ["docs/uncovered-run003.md"],
      profiles,
    }),
    {
      decision: "full_profile_required",
      profileIds: [],
      uncoveredPaths: ["docs/uncovered-run003.md"],
    },
  );
});
