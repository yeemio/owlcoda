#!/usr/bin/env node

import {
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { currentCoreIdentity } from "./core-contract.mjs";

const RELEASE_FILES = Object.freeze({
  packageManifest: "packages/runkit/package.json",
  attestManifest: "packages/attest/distribution-manifest-v1.json",
  attestRuntime: "packages/attest/src/quick.mjs",
  skillMarkdown: "integrations/codex/skills/owlcoda-runkit/SKILL.md",
  skillConfig: "integrations/codex/skills/owlcoda-runkit/assets/templates/config.json",
});

function readJson(ref) {
  return JSON.parse(readFileSync(ref, "utf8"));
}

function bytes(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeAtomic(ref, value) {
  const temporary = `${ref}.sync-${process.pid}`;
  writeFileSync(temporary, value, { flag: "wx" });
  renameSync(temporary, ref);
}

function exactCore(actual, expected, includeSourceRef) {
  return actual?.contractVersion === expected.contractVersion
    && actual?.coreVersion === expected.coreVersion
    && actual?.coreManifestSha256 === expected.coreManifestSha256
    && (!includeSourceRef || actual?.coreSourceRef === expected.coreSourceRef);
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function synchronizeReleaseIdentityV1({
  repositoryRoot,
  core,
  write = false,
}) {
  const root = path.resolve(repositoryRoot);
  if (core?.contractVersion !== "0.2"
    || typeof core?.coreVersion !== "string"
    || !/^\d+\.\d+\.\d+$/u.test(core.coreVersion)
    || !/^sha256:[a-f0-9]{64}$/u.test(core?.coreManifestSha256 ?? "")
    || core?.coreSourceRef !== `artifact:${core.coreManifestSha256}`) {
    throw new Error("release_identity_core_invalid");
  }
  const refs = Object.fromEntries(Object.entries(RELEASE_FILES).map(
    ([key, relative]) => [key, path.join(root, relative)],
  ));
  const packageManifest = readJson(refs.packageManifest);
  if (packageManifest.name !== "owlrunkit"
    || packageManifest.version !== core.coreVersion) {
    throw new Error("release_identity_package_invalid");
  }
  const attestManifest = readJson(refs.attestManifest);
  const candidateIndexes = attestManifest.supportedProducerCoreIdentities
    ?.map((identity, index) => ({ identity, index }))
    .filter(({ identity }) => identity?.coreVersion === core.coreVersion) ?? [];
  if (candidateIndexes.length !== 1) {
    throw new Error("release_identity_attest_candidate_ambiguous");
  }
  const attestRuntime = readFileSync(refs.attestRuntime, "utf8");
  const runtimePattern = new RegExp(
    `(coreVersion:\\s*"${escaped(core.coreVersion)}",`
      + `\\s*coreManifestSha256:\\s*")sha256:[a-f0-9]{64}("\\s*,?)`,
    "gu",
  );
  const runtimeMatches = [...attestRuntime.matchAll(runtimePattern)];
  if (runtimeMatches.length !== 1) {
    throw new Error("release_identity_attest_runtime_candidate_ambiguous");
  }
  const skillMarkdown = readFileSync(refs.skillMarkdown, "utf8");
  const skillHashes = skillMarkdown.match(/sha256:[a-f0-9]{64}/gu) ?? [];
  if (skillHashes.length !== 1) {
    throw new Error("release_identity_skill_identity_ambiguous");
  }
  const skillConfig = readJson(refs.skillConfig);
  const mismatches = [];
  if (!exactCore(candidateIndexes[0].identity, core, false)) mismatches.push("attest");
  if (!runtimeMatches[0][0].includes(core.coreManifestSha256)) mismatches.push("attest_runtime");
  if (skillHashes[0] !== core.coreManifestSha256) mismatches.push("skill_markdown");
  if (!exactCore(skillConfig.core, core, true)) mismatches.push("skill_config");
  if (write && mismatches.length > 0) {
    attestManifest.supportedProducerCoreIdentities[candidateIndexes[0].index] = {
      contractVersion: core.contractVersion,
      coreVersion: core.coreVersion,
      coreManifestSha256: core.coreManifestSha256,
    };
    writeAtomic(refs.attestManifest, bytes(attestManifest));
    writeAtomic(
      refs.attestRuntime,
      attestRuntime.replace(runtimePattern, `$1${core.coreManifestSha256}$2`),
    );
    writeAtomic(
      refs.skillMarkdown,
      skillMarkdown.replace(skillHashes[0], core.coreManifestSha256),
    );
    writeAtomic(refs.skillConfig, bytes({
      ...skillConfig,
      core: structuredClone(core),
    }));
  }
  return {
    status: mismatches.length === 0 ? "exact" : write ? "synchronized" : "drifted",
    core: structuredClone(core),
    mismatches,
    changed: write ? mismatches : [],
  };
}

function requireSurface(condition, surface) {
  if (!condition) {
    throw new Error(`release_identity_surface_mismatch:${surface}`);
  }
}

export function verifyReleaseIdentitySurfacesV1(input) {
  const core = input?.core;
  requireSurface(
    core?.contractVersion === "0.2"
      && /^\d+\.\d+\.\d+$/u.test(core?.coreVersion ?? "")
      && /^sha256:[a-f0-9]{64}$/u.test(core?.coreManifestSha256 ?? "")
      && core?.coreSourceRef === `artifact:${core.coreManifestSha256}`,
    "core",
  );
  const packageExact = (manifest) => (
    manifest?.name === "owlrunkit" && manifest?.version === core.coreVersion
  );
  const attestExact = (manifest) => (
    manifest?.supportedProducerCoreIdentities?.some(
      (identity) => exactCore(identity, core, false),
    ) === true
  );
  const attestRuntimeExact = (source) => {
    if (typeof source !== "string") return false;
    const pattern = new RegExp(
      `coreVersion:\\s*"${escaped(core.coreVersion)}",`
        + `\\s*coreManifestSha256:\\s*"(sha256:[a-f0-9]{64})"`,
      "gu",
    );
    const matches = [...source.matchAll(pattern)];
    return matches.length === 1 && matches[0][1] === core.coreManifestSha256;
  };
  const skillExact = (markdown) => {
    if (typeof markdown !== "string") return false;
    const hashes = markdown.match(/sha256:[a-f0-9]{64}/gu) ?? [];
    return hashes.length === 1
      && hashes[0] === core.coreManifestSha256
      && markdown.includes(`Bundled release: standalone \`owlrunkit@${core.coreVersion}\``)
      && markdown.includes(`Core \`${core.coreVersion}\``)
      && !/(?:It is not published|current published release remains)/iu.test(markdown);
  };

  requireSurface(packageExact(input.packageManifest), "package_manifest");
  requireSurface(attestExact(input.attestManifest), "attest");
  requireSurface(attestRuntimeExact(input.attestRuntime), "attest_runtime");
  requireSurface(skillExact(input.skillMarkdown), "skill_markdown");
  requireSurface(exactCore(input.skillConfig?.core, core, true), "skill_config");
  requireSurface(packageExact(input.packed?.packageManifest), "packed_package_manifest");
  requireSurface(attestExact(input.packed?.attestManifest), "packed_attest");
  requireSurface(attestRuntimeExact(input.packed?.attestRuntime), "packed_attest_runtime");
  requireSurface(skillExact(input.packed?.skillMarkdown), "packed_skill_markdown");
  requireSurface(
    exactCore(input.packed?.skillConfig?.core, core, true),
    "packed_skill_config",
  );
  requireSurface(
    input.binding?.packageName === "owlrunkit"
      && input.binding?.version === core.coreVersion
      && exactCore(input.binding?.core, core, true),
    "release_binding",
  );
  requireSurface(
    /^sha256:[a-f0-9]{64}$/u.test(input.binding?.tarball?.sha256 ?? "")
      && input.retainedTarballSha256 === input.binding.tarball.sha256,
    "retained_tarball",
  );
  return {
    status: "exact",
    packageName: "owlrunkit",
    version: core.coreVersion,
    core: structuredClone(core),
    surfaceCount: 11,
    retainedTarballSha256: input.retainedTarballSha256,
  };
}

function main(argv) {
  const write = argv.includes("--write");
  const rootIndex = argv.indexOf("--repository-root");
  const repositoryRoot = rootIndex === -1
    ? path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
    : argv[rootIndex + 1];
  if (!repositoryRoot) throw new Error("repository_root_required");
  const result = synchronizeReleaseIdentityV1({
    repositoryRoot,
    core: currentCoreIdentity(),
    write,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!write && result.status !== "exact") process.exitCode = 2;
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
