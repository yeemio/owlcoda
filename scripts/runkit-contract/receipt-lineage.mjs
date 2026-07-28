import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { isDirectExecution } from "./core-contract.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }

  return value;
}

function issue(code, message, extra = {}) {
  return { code, ...extra, message };
}

function malformedResult(issues) {
  return {
    valid: false,
    malformed: true,
    active: null,
    superseded: [],
    issues,
  };
}

function normalizedSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value)
    ? value.toLowerCase()
    : null;
}

export function receiptSha256(receipt) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(receipt)))
    .digest("hex");
}

function validateEntryShapes(entries) {
  if (!Array.isArray(entries)) {
    return [issue("entries_not_array", "Receipt lineage input must be an entries array.")];
  }

  const issues = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      issues.push(issue(
        "entry_not_object",
        "Each receipt lineage entry must be an object.",
        { index },
      ));
      continue;
    }

    if (!normalizedSha256(entry.receiptSha256)) {
      issues.push(issue(
        "malformed_receipt_sha256",
        "receiptSha256 must be a 64-character hexadecimal SHA-256.",
        { index },
      ));
    }
    if (!isRecord(entry.receipt)) {
      issues.push(issue(
        "receipt_not_object",
        "Each receipt lineage entry must contain a receipt object.",
        { index },
      ));
    } else if (
      typeof entry.receipt.status !== "string"
      || entry.receipt.status.trim().length === 0
    ) {
      issues.push(issue(
        "malformed_receipt_status",
        "Each receipt object must contain a non-empty status string.",
        { index },
      ));
    }
    if (
      "parentReceiptSha256" in entry
      && entry.parentReceiptSha256 !== undefined
      && !normalizedSha256(entry.parentReceiptSha256)
    ) {
      issues.push(issue(
        "malformed_parent_receipt_sha256",
        "parentReceiptSha256 must be a 64-character hexadecimal SHA-256 when present.",
        { index },
      ));
    }
  }
  return issues;
}

export function validateReceiptLineage(entries) {
  const shapeIssues = validateEntryShapes(entries);
  if (shapeIssues.length > 0) return malformedResult(shapeIssues);

  const childrenByParent = new Map();
  const issues = [];
  const entriesByHash = new Map();
  const indexByHash = new Map();

  for (const [index, entry] of entries.entries()) {
    const receiptHash = normalizedSha256(entry.receiptSha256);
    if (entriesByHash.has(receiptHash)) {
      issues.push(issue(
        "duplicate_receipt_sha256",
        "Each receipt SHA-256 must be globally unique in the lineage.",
        { receiptSha256: receiptHash },
      ));
      continue;
    }
    entriesByHash.set(receiptHash, entry);
    indexByHash.set(receiptHash, index);
  }

  for (const entry of entries) {
    const receiptHash = normalizedSha256(entry.receiptSha256);
    if (receiptSha256(entry.receipt) !== receiptHash) {
      issues.push(issue(
        "receipt_hash_mismatch",
        "The declared receipt SHA-256 does not match the receipt content.",
        { receiptSha256: receiptHash },
      ));
    }
  }

  for (const [index, entry] of entries.entries()) {
    if (!entry.parentReceiptSha256) continue;

    const receiptHash = normalizedSha256(entry.receiptSha256);
    const parentHash = normalizedSha256(entry.parentReceiptSha256);
    const children = childrenByParent.get(parentHash) ?? [];
    children.push(receiptHash);
    childrenByParent.set(parentHash, children);

    const parent = entriesByHash.get(parentHash);
    if (!parent) {
      issues.push(issue(
        "parent_not_found",
        "The replacement references a receipt SHA-256 that is not present.",
        { receiptSha256: receiptHash, parentReceiptSha256: parentHash },
      ));
    } else if (parent.receipt.status !== "invalidated_by_concurrent_write") {
      issues.push(issue(
        "parent_not_invalidated_by_concurrent_write",
        "A replacement may only reference a receipt invalidated by a concurrent write.",
        { receiptSha256: receiptHash, parentReceiptSha256: parentHash },
      ));
    }

    const parentIndex = indexByHash.get(parentHash);
    if (parentIndex !== undefined && parentIndex >= index) {
      issues.push(issue(
        "parent_not_prior",
        "An append-only replacement must reference an earlier receipt entry.",
        { receiptSha256: receiptHash, parentReceiptSha256: parentHash },
      ));
    }
  }

  for (const [parentReceiptSha256, children] of childrenByParent) {
    if (children.length > 1) {
      issues.push(issue(
        "lineage_branch_detected",
        "An append-only receipt may have at most one direct replacement.",
        { parentReceiptSha256, childReceiptSha256Values: children },
      ));
    }
  }

  const visitState = new Map();
  let cycleDetected = false;

  function visit(receiptHash) {
    const state = visitState.get(receiptHash);
    if (state === "visiting") {
      cycleDetected = true;
      return;
    }
    if (state === "visited") return;

    visitState.set(receiptHash, "visiting");
    const parentHash = normalizedSha256(
      entriesByHash.get(receiptHash)?.parentReceiptSha256,
    );
    if (parentHash && entriesByHash.has(parentHash)) visit(parentHash);
    visitState.set(receiptHash, "visited");
  }

  for (const receiptHash of entriesByHash.keys()) visit(receiptHash);

  if (cycleDetected) {
    issues.push(issue(
      "cycle_detected",
      "Receipt replacement references must form an acyclic lineage.",
    ));
  }

  const activeEntries = entries.filter(
    (entry) => !childrenByParent.has(normalizedSha256(entry.receiptSha256)),
  );
  const active = activeEntries.length === 1 ? activeEntries[0] : null;
  const superseded = entries.filter((entry) =>
    childrenByParent.has(normalizedSha256(entry.receiptSha256)),
  );

  if (activeEntries.length > 1) {
    issues.push(issue(
      "multiple_active_leaves",
      "A valid receipt lineage must have exactly one active leaf.",
      {
        receiptSha256Values: activeEntries.map((entry) =>
          normalizedSha256(entry.receiptSha256)),
      },
    ));
  } else if (activeEntries.length === 0 && !cycleDetected) {
    issues.push(issue(
      "no_active_leaf",
      "A valid receipt lineage must have one active leaf.",
    ));
  }

  return {
    valid: active !== null && issues.length === 0,
    malformed: false,
    active,
    superseded,
    issues,
  };
}

function cliFailure(code, message) {
  return malformedResult([issue(code, message)]);
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.length !== 1) {
    return {
      exitCode: 3,
      output: cliFailure(
        "usage_error",
        "Usage: receipt-lineage.mjs <receipt-array.json>",
      ),
    };
  }

  let document;
  try {
    document = JSON.parse(await readFile(args[0], "utf8"));
  } catch (error) {
    return {
      exitCode: 3,
      output: cliFailure("input_error", error.message),
    };
  }

  const entries = Array.isArray(document) ? document : document?.receipts;
  const output = validateReceiptLineage(entries);
  return {
    exitCode: output.malformed ? 3 : output.valid ? 0 : 2,
    output,
  };
}

if (isDirectExecution(import.meta.url)) {
  const { exitCode, output } = await runCli();
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}
