import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

test("quick verify help is a self-contained one-screen contract", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "runkit", "verify", "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        COLUMNS: "120",
        FORCE_COLOR: "0",
        NO_COLOR: "1",
        PAGER: "cat",
      },
    },
  );
  const output = result.stdout;
  const lines = output.trimEnd().split("\n");

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(stripAnsi(output), output);
  assert.ok(lines.length <= 40, `help used ${lines.length} lines`);
  assert.ok(lines.every((line) => stringWidth(line) <= 120));
  assert.match(output, /owlcoda runkit verify -- <executable>/);
  assert.match(output, /exact argv/i);
  assert.match(output, /owlcoda attest/);
  assert.match(output, /captured_verification/);
  assert.match(output, /ignored.*unbound/i);
  assert.match(output, /Exit codes:[\s\S]*0[\s\S]*1[\s\S]*2[\s\S]*3/);
  assert.doesNotMatch(output, /skill|goal contract|governance/i);
});

test("public Quick commands reserve exit 3 for missing input", () => {
  for (const argv of [
    ["runkit", "verify", "--json"],
    ["attest", "--json"],
  ]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...argv],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
      },
    );
    assert.equal(result.status, 3, `${argv.join(" ")}\n${result.stdout}\n${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "quick_input_invalid");
    assert.equal(payload.authorizationGranted, false);
  }
});

test("public attest returns structured exit 3 when the receipt file is missing", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli.ts",
      "attest",
      "does-not-exist.json",
      "--workspace",
      process.cwd(),
      "--json",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
    },
  );

  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "quick_input_invalid");
  assert.equal(payload.authorizationGranted, false);
  assert.match(payload.issues.join("\n"), /does-not-exist|receipt/i);
});
