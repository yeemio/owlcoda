import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  synchronizeReleaseIdentityV1,
  verifyReleaseIdentitySurfacesV1,
} from "../scripts/runkit-contract/sync-release-identity.mjs";

const stale = `sha256:${"b".repeat(64)}`;
const core = {
  contractVersion: "0.2",
  coreVersion: "0.17.1",
  coreManifestSha256: `sha256:${"a".repeat(64)}`,
  coreSourceRef: `artifact:sha256:${"a".repeat(64)}`,
};

async function writeJson(ref, value) {
  await mkdir(path.dirname(ref), { recursive: true });
  await writeFile(ref, `${JSON.stringify(value, null, 2)}\n`);
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-release-identity-"));
  await writeJson(path.join(root, "packages/runkit/package.json"), {
    name: "owlrunkit",
    version: "0.17.1",
  });
  await writeJson(path.join(root, "packages/attest/distribution-manifest-v1.json"), {
    supportedProducerCoreIdentities: [{
      contractVersion: "0.2",
      coreVersion: "0.17.1",
      coreManifestSha256: stale,
    }],
  });
  const runtime = path.join(root, "packages/attest/src/quick.mjs");
  await mkdir(path.dirname(runtime), { recursive: true });
  await writeFile(runtime, [
    "export const SUPPORTED_QUICK_CORE_IDENTITIES = [{",
    '  contractVersion: "0.2",',
    '  coreVersion: "0.17.1",',
    `  coreManifestSha256: "${stale}",`,
    "}];",
    "",
  ].join("\n"));
  const skill = path.join(root, "integrations/codex/skills/owlcoda-runkit/SKILL.md");
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, `Core identity: \`${stale}\`.\n`);
  await writeJson(path.join(
    root,
    "integrations/codex/skills/owlcoda-runkit/assets/templates/config.json",
  ), {
    schemaVersion: "OwlCodaRunKitConfigV2",
    core: {
      contractVersion: "0.2",
      coreVersion: "0.17.1",
      coreManifestSha256: stale,
      coreSourceRef: `artifact:${stale}`,
    },
  });
  return { root, runtime, skill };
}

test("release identity sync repairs every current-version source surface", async () => {
  const { root, runtime, skill } = await fixture();
  try {
    assert.deepEqual(synchronizeReleaseIdentityV1({
      repositoryRoot: root,
      core,
    }).mismatches, [
      "attest",
      "attest_runtime",
      "skill_markdown",
      "skill_config",
    ]);
    assert.equal(synchronizeReleaseIdentityV1({
      repositoryRoot: root,
      core,
      write: true,
    }).status, "synchronized");
    assert.equal(synchronizeReleaseIdentityV1({ repositoryRoot: root, core }).status, "exact");
    assert.match(await readFile(skill, "utf8"), new RegExp(core.coreManifestSha256, "u"));
    assert.match(await readFile(runtime, "utf8"), new RegExp(core.coreManifestSha256, "u"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release identity sync rejects ambiguous Skill identity declarations", async () => {
  const { root, skill } = await fixture();
  try {
    await writeFile(skill, `${stale}\n${core.coreManifestSha256}\n`);
    assert.throws(() => synchronizeReleaseIdentityV1({
      repositoryRoot: root,
      core,
    }), /release_identity_skill_identity_ambiguous/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function releaseSurfaces() {
  const packageManifest = { name: "owlrunkit", version: core.coreVersion };
  const attestManifest = {
    supportedProducerCoreIdentities: [{
      contractVersion: core.contractVersion,
      coreVersion: core.coreVersion,
      coreManifestSha256: core.coreManifestSha256,
    }],
  };
  const attestRuntime = [
    'coreVersion: "0.17.1",',
    `coreManifestSha256: "${core.coreManifestSha256}"`,
  ].join("\n");
  const skillMarkdown = [
    "Bundled release: standalone `owlrunkit@0.17.1`,",
    "bundling Core `0.17.1`.",
    `Core identity: \`${core.coreManifestSha256}\`.`,
  ].join("\n");
  const skillConfig = { core: structuredClone(core) };
  const tarball = {
    filename: "owlrunkit-0.17.1.tgz",
    sha256: `sha256:${"c".repeat(64)}`,
    sha1: "d".repeat(40),
    integrity: `sha512-${Buffer.alloc(64, 8).toString("base64")}`,
    size: 1234,
  };
  return {
    core,
    packageManifest,
    attestManifest,
    attestRuntime,
    skillMarkdown,
    skillConfig,
    packed: {
      packageManifest: structuredClone(packageManifest),
      attestManifest: structuredClone(attestManifest),
      attestRuntime,
      skillMarkdown,
      skillConfig: structuredClone(skillConfig),
    },
    binding: {
      packageName: "owlrunkit",
      version: core.coreVersion,
      core: structuredClone(core),
      tarball,
    },
    retainedTarballSha256: tarball.sha256,
  };
}

test("release identity gate verifies all source, packed, binding, and tarball surfaces", () => {
  assert.deepEqual(verifyReleaseIdentitySurfacesV1(releaseSurfaces()), {
    status: "exact",
    packageName: "owlrunkit",
    version: "0.17.1",
    core,
    surfaceCount: 11,
    retainedTarballSha256: `sha256:${"c".repeat(64)}`,
  });
});

test("release identity gate fails when a packed surface retains an old Core", () => {
  const input = releaseSurfaces();
  input.packed.skillConfig.core.coreManifestSha256 = stale;
  assert.throws(
    () => verifyReleaseIdentitySurfacesV1(input),
    /release_identity_surface_mismatch:packed_skill_config/u,
  );
});
