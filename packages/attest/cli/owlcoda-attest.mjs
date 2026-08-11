#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";

import {
  attestFile,
  parseJsonStrict,
  resolveAttestationRef,
} from "../src/index.mjs";

const HELP = `Usage:
  owlcoda-attest attest <receipt-or-bundle.json> [--workspace <path>] [--json]
  owlcoda-attest resolve <attestation-ref.json> --store <path> [--store <path>...] [--workspace <path>] [--json]

Read-only unsigned V1 verifier.
Otherwise-valid Quick without --workspace: INDETERMINATE; current checkout/output bytes not checked.
Authorization granted: false
Network requests: 0
`;

function inputError(message) {
  const error = new Error(message);
  error.code = "receipt_schema_invalid";
  return error;
}

function publicIssueCode(error) {
  if (error?.code === "DUPLICATE_OBJECT_KEY") return "receipt_duplicate_key";
  if (error?.code === "ENOENT") return "attestation_material_missing";
  const supported = new Set([
    "attestation_material_missing",
    "receipt_duplicate_key",
    "receipt_schema_invalid",
  ]);
  return supported.has(error?.code) ? error.code : "receipt_schema_invalid";
}

function parseOptions(args, { valueNames }) {
  const values = new Map();
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (entry === "--json") {
      json = true;
      continue;
    }
    if (!valueNames.has(entry)) {
      throw inputError(`unknown option: ${entry}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw inputError(`${entry} requires a value`);
    }
    const existing = values.get(entry) ?? [];
    existing.push(value);
    values.set(entry, existing);
    index += 1;
  }
  return { json, values };
}

function printHuman(result) {
  const decision = result.decision ?? result.attestation?.decision ?? result.status;
  process.stdout.write(`${decision}: ${result.status}\n`);
  process.stdout.write(`authorization: false\n`);
  process.stdout.write(`network requests: ${result.networkRequests ?? 0}\n`);
  if (Array.isArray(result.issueCodes)) {
    process.stdout.write(`issues: ${result.issueCodes.join(", ") || "none"}\n`);
  }
  if (result.nextAllowedAction) {
    process.stdout.write(`next: ${result.nextAllowedAction}\n`);
  }
}

function emit(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    printHuman(result);
  }
  return result.exitCode;
}

function runAttest(args) {
  const subjectPath = args[0];
  if (!subjectPath || subjectPath.startsWith("--")) {
    throw inputError("usage: owlcoda-attest attest <receipt-or-bundle.json> [--workspace <path>] [--json]");
  }
  const { json, values } = parseOptions(args.slice(1), {
    valueNames: new Set(["--workspace"]),
  });
  const workspace = values.get("--workspace")?.[0];
  const result = attestFile({
    subjectPath,
    workspaceRoot: workspace === undefined ? undefined : realpathSync(workspace),
  });
  return emit(result, json);
}

function runResolve(args) {
  const referencePath = args[0];
  if (!referencePath || referencePath.startsWith("--")) {
    throw inputError("usage: owlcoda-attest resolve <attestation-ref.json> --store <path> [--store <path>...] [--workspace <path>] [--json]");
  }
  const { json, values } = parseOptions(args.slice(1), {
    valueNames: new Set(["--store", "--workspace"]),
  });
  const stores = values.get("--store") ?? [];
  if (stores.length === 0) {
    throw inputError("resolve requires at least one --store");
  }
  const workspace = values.get("--workspace")?.[0];
  if ((values.get("--workspace")?.length ?? 0) > 1) {
    throw inputError("--workspace may be supplied only once");
  }
  const reference = parseJsonStrict(readFileSync(referencePath, "utf8"));
  const result = resolveAttestationRef({
    reference,
    stores,
    workspaceRoot: workspace === undefined ? undefined : realpathSync(workspace),
  });
  return emit(result, json);
}

export function run(argv) {
  const [command, ...args] = argv;
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "attest") return runAttest(args);
  if (command === "resolve") return runResolve(args);
  throw inputError("usage: owlcoda-attest <attest|resolve> ...");
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (error) {
  const result = {
    schemaVersion: "OwlCodaAttestCommandErrorV1",
    status: "input_invalid",
    exitCode: 3,
    issueCodes: [publicIssueCode(error)],
    message: error instanceof Error ? error.message : String(error),
    authorizationGranted: false,
    networkRequests: 0,
  };
  const json = process.argv.includes("--json");
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stderr.write(`${result.message}\n`);
  }
  process.exitCode = result.exitCode;
}
