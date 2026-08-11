#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { verifyVerificationEnvelopeReceiptV1 } from "./verification-envelope.mjs";

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) {
    throw new Error(`${name} is required.`);
  }
  return argv[index + 1];
}

export function verifyEnvelopeForFormalV1(argv = process.argv.slice(2)) {
  if (argv.length !== 4
    || argv[0] !== "--workspace"
    || argv[2] !== "--receipt") {
    throw new Error("Usage: verification-envelope-check.mjs --workspace <path> --receipt <path>");
  }
  const workspaceRoot = realpathSync(option(argv, "--workspace"));
  const result = verifyVerificationEnvelopeReceiptV1({
    workspaceRoot,
    receiptPath: option(argv, "--receipt"),
  });
  return {
    ...result,
    status: result.formalEligible
      ? "verification_envelope_formal_eligible"
      : "verification_envelope_not_formal_eligible",
    exitCode: result.formalEligible ? 0 : 2,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = verifyEnvelopeForFormalV1();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  }
}
