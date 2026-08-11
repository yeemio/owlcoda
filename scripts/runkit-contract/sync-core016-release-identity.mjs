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
  skillConfig:
    "integrations/codex/skills/owlcoda-runkit/assets/templates/config.json",
});

const RELEASE_VERSION = "0.16.1";
const ATTEST_RUNTIME_CORE016 =
  new RegExp(
    `(coreVersion:\\s*"${RELEASE_VERSION.replaceAll(".", "\\.")}",`
      + `\\s*coreManifestSha256:\\s*")sha256:[a-f0-9]{64}("\\s*,?)`,
    "gu",
  );

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
    && (
      !includeSourceRef
      || actual?.coreSourceRef === expected.coreSourceRef
    );
}

export function synchronizeCore016ReleaseIdentityV1({
  repositoryRoot,
  core,
  write = false,
}) {
  const root = path.resolve(repositoryRoot);
  if (
    core?.contractVersion !== "0.2"
    || core?.coreVersion !== RELEASE_VERSION
    || !/^sha256:[a-f0-9]{64}$/u.test(
      core?.coreManifestSha256 ?? "",
    )
    || core?.coreSourceRef !== `artifact:${core.coreManifestSha256}`
  ) throw new Error("core016_release_identity_invalid");
  const refs = Object.fromEntries(Object.entries(RELEASE_FILES).map(
    ([key, relative]) => [key, path.join(root, relative)],
  ));
  const packageManifest = readJson(refs.packageManifest);
  if (
    packageManifest.name !== "owlrunkit"
    || packageManifest.version !== RELEASE_VERSION
  ) throw new Error("core016_release_package_invalid");
  const attestManifest = readJson(refs.attestManifest);
  const candidateIndexes = attestManifest.supportedProducerCoreIdentities
    ?.map((identity, index) => ({ identity, index }))
    .filter(({ identity }) => identity?.coreVersion === RELEASE_VERSION) ?? [];
  if (candidateIndexes.length !== 1) {
    throw new Error("core016_release_attest_candidate_ambiguous");
  }
  const attestRuntime = readFileSync(refs.attestRuntime, "utf8");
  const runtimeMatches = [...attestRuntime.matchAll(ATTEST_RUNTIME_CORE016)];
  if (runtimeMatches.length !== 1) {
    throw new Error("core016_release_attest_runtime_candidate_ambiguous");
  }
  const skillMarkdown = readFileSync(refs.skillMarkdown, "utf8");
  const skillHashes = skillMarkdown.match(/sha256:[a-f0-9]{64}/gu) ?? [];
  if (skillHashes.length !== 1) {
    throw new Error("core016_release_skill_identity_ambiguous");
  }
  const skillConfig = readJson(refs.skillConfig);
  const mismatches = [];
  if (!exactCore(candidateIndexes[0].identity, core, false)) {
    mismatches.push("attest");
  }
  if (!runtimeMatches[0][0].includes(core.coreManifestSha256)) {
    mismatches.push("attest_runtime");
  }
  if (skillHashes[0] !== core.coreManifestSha256) {
    mismatches.push("skill_markdown");
  }
  if (!exactCore(skillConfig.core, core, true)) {
    mismatches.push("skill_config");
  }
  if (write && mismatches.length > 0) {
    attestManifest.supportedProducerCoreIdentities[
      candidateIndexes[0].index
    ] = {
      contractVersion: core.contractVersion,
      coreVersion: core.coreVersion,
      coreManifestSha256: core.coreManifestSha256,
    };
    writeAtomic(refs.attestManifest, bytes(attestManifest));
    writeAtomic(
      refs.attestRuntime,
      attestRuntime.replace(
        ATTEST_RUNTIME_CORE016,
        `$1${core.coreManifestSha256}$2`,
      ),
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

function main(argv) {
  const write = argv.includes("--write");
  const rootIndex = argv.indexOf("--repository-root");
  const repositoryRoot = rootIndex === -1
    ? path.resolve(fileURLToPath(new URL("../..", import.meta.url)))
    : argv[rootIndex + 1];
  if (!repositoryRoot) throw new Error("repository_root_required");
  const result = synchronizeCore016ReleaseIdentityV1({
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
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
