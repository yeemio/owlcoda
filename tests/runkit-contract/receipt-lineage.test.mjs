import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("../../scripts/runkit-contract/receipt-lineage.mjs", import.meta.url),
);

async function loadSubject() {
  try {
    return await import("../../scripts/runkit-contract/receipt-lineage.mjs");
  } catch (error) {
    assert.fail(`receipt-lineage module must be importable: ${error.message}`);
  }
}

test("selects the replacement as active without mutating append-only receipts", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const parentReceipt = {
    receiptId: "verification-001",
    status: "invalidated_by_concurrent_write",
    summary: "Source fingerprint changed after verification.",
  };
  const replacementReceipt = {
    receiptId: "verification-002",
    status: "passed",
    summary: "Verification repeated against the current fingerprint.",
  };
  const entries = [
    {
      receiptSha256: receiptSha256(parentReceipt),
      receipt: parentReceipt,
    },
    {
      receiptSha256: receiptSha256(replacementReceipt),
      parentReceiptSha256: receiptSha256(parentReceipt),
      receipt: replacementReceipt,
    },
  ];
  const before = structuredClone(entries);

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, true);
  assert.deepEqual(result.active, entries[1]);
  assert.deepEqual(result.superseded, [entries[0]]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(entries, before);
});

test("rejects a replacement whose parent hash does not exist", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const receipt = { receiptId: "verification-002", status: "passed" };
  const entries = [
    {
      receiptSha256: receiptSha256(receipt),
      parentReceiptSha256: "f".repeat(64),
      receipt,
    },
  ];

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "parent_not_found"));
});

test("rejects a replacement when its parent was not invalidated by a concurrent write", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const parentReceipt = { receiptId: "verification-001", status: "passed" };
  const replacementReceipt = { receiptId: "verification-002", status: "passed" };
  const entries = [
    {
      receiptSha256: receiptSha256(parentReceipt),
      receipt: parentReceipt,
    },
    {
      receiptSha256: receiptSha256(replacementReceipt),
      parentReceiptSha256: receiptSha256(parentReceipt),
      receipt: replacementReceipt,
    },
  ];

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some(
      (issue) => issue.code === "parent_not_invalidated_by_concurrent_write",
    ),
  );
});

test("accepts an explicit repair supersedes edge without rewriting a previously passed receipt", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const parentReceipt = {
    receiptId: "verification-001",
    status: "passed",
    sourceFingerprint: "a".repeat(64),
  };
  const parentSha = receiptSha256(parentReceipt);
  const replacementReceipt = {
    receiptId: "verification-002",
    status: "passed",
    sourceFingerprint: "b".repeat(64),
    supersedesReceiptSha256: parentSha,
  };
  const entries = [
    { receiptSha256: parentSha, receipt: parentReceipt },
    {
      receiptSha256: receiptSha256(replacementReceipt),
      parentReceiptSha256: parentSha,
      receipt: replacementReceipt,
    },
  ];
  const before = structuredClone(entries);

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, true);
  assert.equal(result.active.receipt.receiptId, "verification-002");
  assert.deepEqual(result.superseded, [entries[0]]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(entries, before);
});

test("rejects a repair edge whose embedded supersedes hash does not match its parent", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const parentReceipt = {
    receiptId: "verification-001",
    status: "passed",
    sourceFingerprint: "a".repeat(64),
  };
  const parentSha = receiptSha256(parentReceipt);
  const replacementReceipt = {
    receiptId: "verification-002",
    status: "passed",
    sourceFingerprint: "b".repeat(64),
    supersedesReceiptSha256: "f".repeat(64),
  };
  const entries = [
    { receiptSha256: parentSha, receipt: parentReceipt },
    {
      receiptSha256: receiptSha256(replacementReceipt),
      parentReceiptSha256: parentSha,
      receipt: replacementReceipt,
    },
  ];

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "supersedes_receipt_sha256_mismatch"));
});

test("rejects an entry whose declared receipt hash does not match its receipt", async () => {
  const { validateReceiptLineage } = await loadSubject();
  const entries = [
    {
      receiptSha256: "0".repeat(64),
      receipt: { receiptId: "verification-001", status: "passed" },
    },
  ];

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "receipt_hash_mismatch"),
  );
});

test("rejects cycles in replacement references", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const firstReceipt = {
    receiptId: "verification-001",
    status: "invalidated_by_concurrent_write",
  };
  const secondReceipt = {
    receiptId: "verification-002",
    status: "invalidated_by_concurrent_write",
  };
  const firstSha = receiptSha256(firstReceipt);
  const secondSha = receiptSha256(secondReceipt);
  const entries = [
    {
      receiptSha256: firstSha,
      parentReceiptSha256: secondSha,
      receipt: firstReceipt,
    },
    {
      receiptSha256: secondSha,
      parentReceiptSha256: firstSha,
      receipt: secondReceipt,
    },
  ];

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "cycle_detected"));
});

test("rejects multiple active leaves", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const parentReceipt = {
    receiptId: "verification-001",
    status: "invalidated_by_concurrent_write",
  };
  const firstReceipt = { receiptId: "verification-002", status: "passed" };
  const secondReceipt = { receiptId: "verification-003", status: "passed" };
  const parentSha = receiptSha256(parentReceipt);
  const entries = [
    { receiptSha256: parentSha, receipt: parentReceipt },
    {
      receiptSha256: receiptSha256(firstReceipt),
      parentReceiptSha256: parentSha,
      receipt: firstReceipt,
    },
    {
      receiptSha256: receiptSha256(secondReceipt),
      parentReceiptSha256: parentSha,
      receipt: secondReceipt,
    },
  ];

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, false);
  assert.equal(result.active, null);
  assert.ok(
    result.issues.some((issue) => issue.code === "multiple_active_leaves"),
  );
});

test("rejects a parent reference that points forward in the append-only array", async () => {
  const { receiptSha256, validateReceiptLineage } = await loadSubject();
  const parentReceipt = {
    receiptId: "verification-001",
    status: "invalidated_by_concurrent_write",
  };
  const replacementReceipt = { receiptId: "verification-002", status: "passed" };
  const parentSha = receiptSha256(parentReceipt);
  const replacementSha = receiptSha256(replacementReceipt);
  const entries = [
    {
      receiptSha256: replacementSha,
      parentReceiptSha256: parentSha,
      receipt: replacementReceipt,
    },
    { receiptSha256: parentSha, receipt: parentReceipt },
  ];

  const result = validateReceiptLineage(entries);

  assert.equal(result.valid, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "parent_not_prior"),
  );
});

test("CLI emits machine-readable JSON and does not rewrite the receipt file", async () => {
  const { receiptSha256 } = await loadSubject();
  const directory = await mkdtemp(path.join(tmpdir(), "receipt-lineage-"));
  const inputPath = path.join(directory, "receipts.json");
  const parentReceipt = {
    receiptId: "verification-001",
    status: "invalidated_by_concurrent_write",
  };
  const replacementReceipt = { receiptId: "verification-002", status: "passed" };
  const input = JSON.stringify(
    {
      receipts: [
        {
          receiptSha256: receiptSha256(parentReceipt),
          receipt: parentReceipt,
        },
        {
          receiptSha256: receiptSha256(replacementReceipt),
          parentReceiptSha256: receiptSha256(parentReceipt),
          receipt: replacementReceipt,
        },
      ],
    },
    null,
    2,
  );
  await writeFile(inputPath, input);

  const completed = spawnSync(process.execPath, [scriptPath, inputPath], {
    encoding: "utf8",
  });

  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.active.receipt.receiptId, "verification-002");
  assert.equal(await readFile(inputPath, "utf8"), input);
});

test("CLI exits 2 for an invalid lineage while still emitting JSON", async () => {
  const { receiptSha256 } = await loadSubject();
  const directory = await mkdtemp(path.join(tmpdir(), "receipt-lineage-"));
  const inputPath = path.join(directory, "receipts.json");
  const receipt = { receiptId: "verification-002", status: "passed" };
  await writeFile(
    inputPath,
    JSON.stringify([
      {
        receiptSha256: receiptSha256(receipt),
        parentReceiptSha256: "f".repeat(64),
        receipt,
      },
    ]),
  );

  const completed = spawnSync(process.execPath, [scriptPath, inputPath], {
    encoding: "utf8",
  });

  assert.equal(completed.status, 2, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === "parent_not_found"));
});
