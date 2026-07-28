import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../scripts/runkit-contract/runkit-cli.mjs", import.meta.url));

function run(args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
  return { ...result, json: result.stdout ? JSON.parse(result.stdout) : null };
}

test("Codex adapter initializes, plans, inspects, and records a rejected execution without Git authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-workflow-"));
  try {
    const goalPath = path.join(root, "goal.json");
    await writeFile(goalPath, `${JSON.stringify({ objective: "Read one file without changing business source." })}\n`);

    const initialized = run(["init", "--workspace", root]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(initialized.json.status, "initialized");

    const planned = run(["plan", "--workspace", root, "--run-id", "fixture-run-001", "--goal", goalPath]);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(planned.json.status, "planned");
    assert.equal(planned.json.authorizationGranted, false);

    const inspected = run(["inspect", "--json", "--workspace", root]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.deepEqual(inspected.json.runIds, ["fixture-run-001"]);
    assert.equal(inspected.json.executions[0].enginePin.status, "valid");

    const closed = run([
      "closeout",
      "--workspace", root,
      "--run-id", "fixture-run-001",
      "--decision", "rejected",
    ]);
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(closed.json.status, "closed");
    assert.equal(closed.json.authorizationGranted, false);

    const executionRoot = path.join(root, ".owlcoda/runkit/executions/fixture-run-001");
    const events = (await readFile(path.join(executionRoot, "events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map((event) => event.type), ["execution_planned", "execution_closed"]);
    const closeout = JSON.parse(await readFile(path.join(executionRoot, "closeout-receipt.json"), "utf8"));
    assert.equal(closeout.artifact.payload.decision, "rejected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one run id cannot be planned twice", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-duplicate-"));
  try {
    const goalPath = path.join(root, "goal.json");
    await writeFile(goalPath, "{}\n");
    assert.equal(run(["init", "--workspace", root]).status, 0);
    assert.equal(run(["plan", "--workspace", root, "--run-id", "same-run", "--goal", goalPath]).status, 0);
    const duplicate = run(["plan", "--workspace", root, "--run-id", "same-run", "--goal", goalPath]);
    assert.equal(duplicate.status, 3);
    assert.equal(duplicate.json.status, "invalid_input");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
