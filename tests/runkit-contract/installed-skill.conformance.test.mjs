import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { currentCoreIdentity as authoritativeCoreIdentity } from "../../scripts/runkit-contract/core-contract.mjs";

const skillRoot = process.env.OWLCODA_RUNKIT_SKILL_ROOT;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("installed Codex Skill carries the exact authoritative Core and initializes a foreign fixture", { skip: !skillRoot }, async () => {
  const installed = await import(pathToFileURL(path.join(skillRoot, "scripts/runkit-contract/core-contract.mjs")));
  assert.deepEqual(installed.currentCoreIdentity(), authoritativeCoreIdentity());

  const skillMarkdown = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.doesNotMatch(skillMarkdown, /TODO/);
  assert.match(skillMarkdown, /never as authorization|without separate authority/i);
  assert.match(skillMarkdown, /Choose the smallest assurance lane/);
  assert.match(skillMarkdown, /ordinary project tools without RunKit/);
  assert.match(skillMarkdown, /Quick Verification for one low-risk command/);
  assert.match(skillMarkdown, /Formal Delivery for multi-writer work/);
  assert.match(skillMarkdown, /never treat a Quick receipt as Formal acceptance/);

  const fixture = await mkdtemp(path.join(tmpdir(), "owlcoda-runkit-skill-"));
  try {
    const businessPath = path.join(fixture, "business.txt");
    await writeFile(businessPath, "foreign fixture\n");
    const before = sha256(await readFile(businessPath));
    const result = spawnSync(process.execPath, [
      path.join(skillRoot, "scripts/runkit-contract/runkit-bootstrap.mjs"),
      "init",
      "--workspace",
      fixture,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "initialized");
    assert.equal(sha256(await readFile(businessPath)), before);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
