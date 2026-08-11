import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { currentCoreIdentity } from "../../scripts/runkit-contract/core-contract.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const skillPath = path.join(
  root,
  "integrations/codex/skills/owlcoda-runkit/SKILL.md",
);
const contractPath = path.join(
  root,
  "docs/architecture/OWLCODA_RUN_KIT_CONTRACT_V0_2.md",
);
const configTemplatePath = path.join(
  root,
  "integrations/codex/skills/owlcoda-runkit/assets/templates/config.json",
);

test("Codex Skill documents the shipped Core 0.15 product boundary", () => {
  const skill = readFileSync(skillPath, "utf8");
  const contract = readFileSync(contractPath, "utf8");
  const configTemplate = JSON.parse(readFileSync(configTemplatePath, "utf8"));

  assert.match(skill, /Core v0\.14/);
  assert.match(skill, /owlrunkit doctor/);
  assert.match(skill, /profiles detect/);
  assert.match(skill, /owlrunkit adopt/);
  assert.match(skill, /owlrunkit uses its own version lifecycle/i);
  assert.match(skill, /registry-first adoption/i);
  assert.match(skill, /quick-verify/);
  assert.match(skill, /deterministic repair/i);
  assert.match(skill, /offline-export/);
  assert.match(skill, /install-codex-skill\.mjs/);
  assert.match(skill, /local tarball.*not.*formal adoption/is);

  assert.match(contract, /## Core v0\.14 /);
  assert.match(contract, /standalone `owlrunkit` package/i);
  assert.match(contract, /registry.*shasum.*integrity.*tarball URL/is);
  assert.match(contract, /does not grant Git, npm, release, or foreign-project authority/i);

  assert.equal(configTemplate.core.coreVersion, currentCoreIdentity().coreVersion);
});
