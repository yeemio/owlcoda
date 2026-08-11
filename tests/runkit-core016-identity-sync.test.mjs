import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  synchronizeCore016ReleaseIdentityV1,
} from "../scripts/runkit-contract/sync-core016-release-identity.mjs";

const stale = `sha256:${"b".repeat(64)}`;
const core = {
  contractVersion: "0.2",
  coreVersion: "0.16.1",
  coreManifestSha256: `sha256:${"a".repeat(64)}`,
  coreSourceRef: `artifact:sha256:${"a".repeat(64)}`,
};

async function writeJson(ref, value) {
  await mkdir(path.dirname(ref), { recursive: true });
  await writeFile(ref, `${JSON.stringify(value, null, 2)}\n`);
}

test("Core 0.16 release identity synchronization repairs every source surface and then checks exact", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-identity-sync-"));
  try {
    await writeJson(path.join(root, "packages/runkit/package.json"), {
      name: "owlrunkit",
      version: "0.16.1",
    });
    await writeJson(path.join(
      root,
      "packages/attest/distribution-manifest-v1.json",
    ), {
      supportedProducerCoreIdentities: [{
        contractVersion: "0.2",
        coreVersion: "0.16.1",
        coreManifestSha256: stale,
      }],
    });
    const attestRuntimeRef = path.join(root, "packages/attest/src/quick.mjs");
    await mkdir(path.dirname(attestRuntimeRef), { recursive: true });
    await writeFile(attestRuntimeRef, [
      "export const SUPPORTED_QUICK_CORE_IDENTITIES = [{",
      '  contractVersion: "0.2",',
      '  coreVersion: "0.16.1",',
      `  coreManifestSha256: "${stale}",`,
      "}];",
      "",
    ].join("\n"));
    const skillRef = path.join(
      root,
      "integrations/codex/skills/owlcoda-runkit/SKILL.md",
    );
    await mkdir(path.dirname(skillRef), { recursive: true });
    await writeFile(skillRef, `Core identity: \`${stale}\`.\n`);
    await writeJson(path.join(
      root,
      "integrations/codex/skills/owlcoda-runkit/assets/templates/config.json",
    ), { schemaVersion: "OwlCodaRunKitConfigV2", core: {
      contractVersion: "0.2",
      coreVersion: "0.16.1",
      coreManifestSha256: stale,
      coreSourceRef: `artifact:${stale}`,
    } });

    assert.deepEqual(synchronizeCore016ReleaseIdentityV1({
      repositoryRoot: root,
      core,
    }).mismatches, [
      "attest",
      "attest_runtime",
      "skill_markdown",
      "skill_config",
    ]);
    assert.equal(synchronizeCore016ReleaseIdentityV1({
      repositoryRoot: root,
      core,
      write: true,
    }).status, "synchronized");
    assert.equal(synchronizeCore016ReleaseIdentityV1({
      repositoryRoot: root,
      core,
    }).status, "exact");
    assert.match(await readFile(skillRef, "utf8"), new RegExp(core.coreManifestSha256, "u"));
    assert.match(
      await readFile(attestRuntimeRef, "utf8"),
      new RegExp(core.coreManifestSha256, "u"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Core 0.16 release identity synchronization rejects ambiguous Skill identity declarations", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-identity-ambiguous-"));
  try {
    await writeJson(path.join(root, "packages/runkit/package.json"), {
      name: "owlrunkit",
      version: "0.16.1",
    });
    await writeJson(path.join(
      root,
      "packages/attest/distribution-manifest-v1.json",
    ), { supportedProducerCoreIdentities: [core] });
    const attestRuntimeRef = path.join(root, "packages/attest/src/quick.mjs");
    await mkdir(path.dirname(attestRuntimeRef), { recursive: true });
    await writeFile(attestRuntimeRef, [
      "export const SUPPORTED_QUICK_CORE_IDENTITIES = [{",
      '  contractVersion: "0.2",',
      '  coreVersion: "0.16.1",',
      `  coreManifestSha256: "${core.coreManifestSha256}",`,
      "}];",
      "",
    ].join("\n"));
    const skillRef = path.join(
      root,
      "integrations/codex/skills/owlcoda-runkit/SKILL.md",
    );
    await mkdir(path.dirname(skillRef), { recursive: true });
    await writeFile(skillRef, `${core.coreManifestSha256}\n${stale}\n`);
    await writeJson(path.join(
      root,
      "integrations/codex/skills/owlcoda-runkit/assets/templates/config.json",
    ), { core });
    assert.throws(() => synchronizeCore016ReleaseIdentityV1({
      repositoryRoot: root,
      core,
    }), /core016_release_skill_identity_ambiguous/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
