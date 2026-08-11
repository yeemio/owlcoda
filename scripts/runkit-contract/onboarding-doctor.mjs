import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import {
  CORE_VERSION,
  currentCoreIdentity,
  validateProjectConfigV2,
} from "./core-contract.mjs";
import {
  expectedRegistryTarballUrl,
  isCanonicalSha512Integrity,
  validateStoredRegistryAdoptionEvidence,
} from "./registry-adoption-gate.mjs";
import { resolveProjectCli } from "./project-cli-resolver.mjs";
import { inspectProjectControlState } from "./project-control-state.mjs";

const PACKAGE_NAME = "owlrunkit";
const EXPECTED_VERSION = CORE_VERSION;
const MAX_JSON_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;

class StrictJsonParser {
  constructor(text) {
    this.text = text;
    this.index = 0;
    this.nodes = 0;
  }

  parse() {
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail("unexpected trailing content");
    return value;
  }

  parseValue(depth) {
    this.skipWhitespace();
    this.nodes += 1;
    if (this.nodes > MAX_JSON_NODES) throw new Error("JSON input exceeds the node limit");
    const character = this.text[this.index];
    if (character === "{") return this.parseObject(depth);
    if (character === "[") return this.parseArray(depth);
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || (character >= "0" && character <= "9")) {
      return this.parseNumber();
    }
    this.fail("expected a JSON value");
  }

  parseObject(depth) {
    const childDepth = this.enter(depth);
    this.index += 1;
    this.skipWhitespace();
    const value = {};
    const keys = new Set();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return value;
    }
    while (true) {
      if (this.text[this.index] !== '"') this.fail("expected an object key");
      const key = this.parseString();
      if (keys.has(key)) throw new Error(`duplicate object key: ${key}`);
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") this.fail("expected ':' after an object key");
      this.index += 1;
      Object.defineProperty(value, key, {
        value: this.parseValue(childDepth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") this.fail("expected ',' or '}' in an object");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  parseArray(depth) {
    const childDepth = this.enter(depth);
    this.index += 1;
    this.skipWhitespace();
    const value = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return value;
    }
    while (true) {
      value.push(this.parseValue(childDepth));
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return value;
      }
      if (this.text[this.index] !== ",") this.fail("expected ',' or ']' in an array");
      this.index += 1;
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.text.slice(start, this.index));
        } catch {
          this.fail("invalid JSON string");
        }
      }
      if (character.charCodeAt(0) < 0x20) this.fail("unescaped control character");
      if (character === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        if (escape === "u") {
          const digits = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail("invalid Unicode escape");
          this.index += 4;
        } else if (!'"\\/bfnrt'.includes(escape)) {
          this.fail("invalid escape");
        }
      }
      this.index += 1;
    }
    this.fail("unterminated JSON string");
  }

  parseLiteral(token, value) {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      this.fail(`invalid literal: expected ${token}`);
    }
    this.index += token.length;
    return value;
  }

  parseNumber() {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      this.text.slice(this.index),
    );
    if (!match) this.fail("invalid JSON number");
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail("JSON number is outside the finite range");
    return value;
  }

  enter(depth) {
    const nextDepth = depth + 1;
    if (nextDepth > MAX_JSON_DEPTH) throw new Error("JSON input exceeds the nesting limit");
    return nextDepth;
  }

  skipWhitespace() {
    while (this.index < this.text.length && [" ", "\t", "\n", "\r"].includes(this.text[this.index])) {
      this.index += 1;
    }
  }

  fail(message) {
    throw new Error(`${message} at byte offset ${this.index}`);
  }
}

function parseJsonStrict(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_JSON_BYTES) {
    throw new Error("JSON input exceeds the input-byte limit");
  }
  return new StrictJsonParser(text).parse();
}

export function resolveBoundedWorkspaceRoot(workspaceRoot) {
  const requested = path.resolve(workspaceRoot);
  const stat = lstatSync(requested);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(requested) !== requested
  ) {
    throw new Error("workspace root must be a real directory without symlink ancestors");
  }
  return requested;
}

function identityMatches(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

export function readWorkspaceFileBounded(root, relativePath, { optional = false } = {}) {
  const target = path.resolve(root, relativePath);
  if (!strictDescendant(root, target)) throw new Error("workspace file escaped the workspace root");
  const segments = path.relative(root, target).split(path.sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (optional && error?.code === "ENOENT") return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("workspace file path contains a symlink");
    const leaf = index === segments.length - 1;
    if ((!leaf && !stat.isDirectory()) || (leaf && !stat.isFile())) {
      throw new Error("workspace file path has an invalid entry type");
    }
  }
  const realTarget = realpathSync(target);
  if (!strictDescendant(root, realTarget)) throw new Error("workspace file escaped the workspace root");

  const descriptor = openSync(target, "r");
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_JSON_BYTES) {
      throw new Error("workspace file exceeds the input-byte limit");
    }
    const buffer = Buffer.allocUnsafe(MAX_JSON_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_JSON_BYTES) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_JSON_BYTES) throw new Error("workspace file exceeds the input-byte limit");
    const after = fstatSync(descriptor);
    const currentStat = lstatSync(target);
    if (
      currentStat.isSymbolicLink()
      || !currentStat.isFile()
      || !identityMatches(before, after)
      || !identityMatches(after, currentStat)
      || realpathSync(target) !== realTarget
    ) {
      throw new Error("workspace file identity changed while reading");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}

export function readWorkspaceJsonBounded(root, relativePath, options) {
  const text = readWorkspaceFileBounded(root, relativePath, options);
  return text === null ? null : parseJsonStrict(text);
}

async function readResponseJsonBounded(response) {
  if (!response.body) throw new Error("registry response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("registry response exceeds the input-byte limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return parseJsonStrict(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

function strictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function readLocalInstallBinding({ workspaceRoot } = {}) {
  const binding = resolveProjectCli({
    workspaceRoot,
    expectedVersion: EXPECTED_VERSION,
    requireEntrypoint: false,
  });
  if (binding.status === "bound") return binding;
  const issue = binding.issueCodes?.[0];
  const issueCode = issue === "project_cli_dependency_ambiguous"
    ? "registry_install_binding_ambiguous"
    : issue === "project_cli_symlink_rejected"
      ? "installed_package_symlink_rejected"
      : issue === "project_cli_path_invalid"
        ? "installed_package_path_invalid"
        : "registry_install_binding_mismatch";
  return {
    status: "mismatch",
    issueCodes: [issueCode],
  };
}

export async function readRegistryExact({
  registryUrl,
  packageName = PACKAGE_NAME,
  version = EXPECTED_VERSION,
  timeoutMs = 1_500,
} = {}) {
  const base = registryUrl.replace(/\/+$/, "");
  const url = `${base}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return {
      status: "unavailable",
      issueCodes: ["registry_dns_or_timeout"],
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: "unauthorized",
      issueCodes: ["registry_auth_failed"],
    };
  }
  if (response.status === 404) {
    return {
      status: "version_missing",
      issueCodes: ["registry_version_missing"],
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return {
      status: "invalid",
      issueCodes: ["registry_redirect_rejected"],
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable",
      issueCodes: [`registry_http_${response.status}`],
    };
  }
  try {
    const metadata = await readResponseJsonBounded(response);
    const dist = metadata.dist;
    if (
      metadata.name !== packageName
      || metadata.version !== version
      || !/^[0-9a-f]{40}$/i.test(dist?.shasum ?? "")
      || !isCanonicalSha512Integrity(dist?.integrity)
      || dist?.tarball !== expectedRegistryTarballUrl(packageName, version)
    ) {
      return {
        status: "invalid",
        issueCodes: ["registry_release_evidence_invalid"],
      };
    }
    return {
      schemaVersion: "OwlCodaRunKitRegistryReleaseEvidenceV1",
      status: "registry_verified",
      registry: base,
      packageName,
      version,
      shasum: dist.shasum,
      integrity: dist.integrity,
      tarballUrl: dist.tarball,
      authorizationGranted: false,
    };
  } catch {
    return {
      status: "invalid",
      issueCodes: ["registry_release_evidence_invalid"],
    };
  }
}

function readProjectScripts(root) {
  try {
    const manifest = readWorkspaceJsonBounded(root, "package.json");
    return Object.keys(manifest.scripts ?? {}).sort();
  } catch {
    return [];
  }
}

function ignoreFileCoversRuntime(root, ignoreFile) {
  let text;
  try {
    text = readWorkspaceFileBounded(root, ignoreFile, { optional: true });
  } catch {
    return false;
  }
  if (text === null) return false;
  let ignored = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const negated = line.startsWith("!");
    const pattern = (negated ? line.slice(1) : line)
      .replace(/^\/+/, "")
      .replace(/^\*\*\//, "")
      .replace(/\/\*\*$/, "")
      .replace(/\/+$/, "");
    if (pattern === ".owlcoda" || pattern === ".owlcoda/runkit") {
      ignored = !negated;
    } else if (negated && pattern.startsWith(".owlcoda/runkit/")) {
      ignored = false;
    }
  }
  return ignored;
}

const BROAD_COLLECTION_TOOLS = Object.freeze([
  {
    tool: "biome",
    command: /\bbiome\s+(?:check|format|lint)\b/,
    ignoreFile: "biome.json",
    ignoreFileSupported: false,
  },
  {
    tool: "eslint",
    command: /\beslint\b/,
    ignoreFile: ".eslintignore",
    ignoreFileSupported: true,
  },
  {
    tool: "jest",
    command: /\bjest\b/,
    ignoreFile: "jest.config.*",
    ignoreFileSupported: false,
  },
  {
    tool: "markdownlint",
    command: /\bmarkdownlint(?:-cli2)?\b/,
    ignoreFile: ".markdownlintignore",
    ignoreFileSupported: true,
  },
  {
    tool: "prettier",
    command: /\bprettier\b/,
    ignoreFile: ".prettierignore",
    ignoreFileSupported: true,
  },
  {
    tool: "stylelint",
    command: /\bstylelint\b/,
    ignoreFile: ".stylelintignore",
    ignoreFileSupported: true,
  },
  {
    tool: "vitest",
    command: /\bvitest\b/,
    ignoreFile: "vitest.config.*",
    ignoreFileSupported: false,
  },
]);

function hasBroadDotTarget(command) {
  return /(?:^|\s|&&|\|\||;)(?:["']?\.\/?["']?)(?=\s|$|&&|\|\||;)/.test(command);
}

function runtimeIsolationCheck(root) {
  let manifest;
  try {
    manifest = readWorkspaceJsonBounded(root, "package.json");
  } catch {
    return {
      status: "unknown",
      affectedScripts: [],
      recommendedIgnore: ".owlcoda/runkit/",
    };
  }
  const affectedScripts = [];
  for (const [script, value] of Object.entries(manifest.scripts ?? {}).sort(([left], [right]) =>
    left.localeCompare(right))) {
    if (typeof value !== "string" || !hasBroadDotTarget(value)) continue;
    for (const descriptor of BROAD_COLLECTION_TOOLS) {
      if (!descriptor.command.test(value)) continue;
      if (
        descriptor.ignoreFileSupported
        && ignoreFileCoversRuntime(root, descriptor.ignoreFile)
      ) {
        continue;
      }
      affectedScripts.push({
        ignoreFile: descriptor.ignoreFile,
        script,
        tool: descriptor.tool,
      });
    }
  }
  return {
    status: affectedScripts.length === 0 ? "ok" : "warning",
    affectedScripts,
    recommendedIgnore: ".owlcoda/runkit/",
  };
}

function configCheck(root) {
  try {
    const config = readWorkspaceJsonBounded(
      root,
      path.join(".owlcoda", "runkit", "config.json"),
      { optional: true },
    );
    if (config === null) return { status: "missing" };
    const gate = validateProjectConfigV2(config);
    return gate.valid ? { status: "ok" } : { status: "invalid", issues: gate.issues };
  } catch {
    return { status: "invalid" };
  }
}

function profilesCheck(root) {
  try {
    const profiles = readWorkspaceJsonBounded(
      root,
      path.join(".owlcoda", "runkit", "profiles.json"),
      { optional: true },
    );
    if (profiles === null) return { status: "missing" };
    if (
      profiles.schemaVersion !== "OwlCodaRunKitProfilesV1"
      || !Array.isArray(profiles.profiles)
    ) {
      return { status: "invalid" };
    }
    const launcherWarnings = [];
    const launcherIssues = [];
    for (const profile of profiles.profiles) {
      for (const command of profile?.commands ?? []) {
        const identity = `${profile?.id ?? "unknown"}:${command?.id ?? "unknown"}`;
        if (typeof command?.executable !== "string" || !path.isAbsolute(command.executable)) {
          launcherWarnings.push(`profile_launcher_not_absolute:${identity}`);
          continue;
        }
        try {
          const stat = lstatSync(command.executable);
          if (stat.isSymbolicLink()) {
            launcherIssues.push(`profile_launcher_symlink_rejected:${identity}`);
          } else if (!stat.isFile() || realpathSync(command.executable) !== path.resolve(command.executable)) {
            launcherIssues.push(`profile_launcher_not_regular_file:${identity}`);
          }
        } catch {
          launcherIssues.push(`profile_launcher_unavailable:${identity}`);
        }
      }
    }
    const uniqueLauncherIssues = [...new Set(launcherIssues)].sort();
    return {
      status: uniqueLauncherIssues.length === 0 ? "ok" : "invalid",
      count: profiles.profiles.length,
      launcherWarnings: [...new Set(launcherWarnings)].sort(),
      launcherIssues: uniqueLauncherIssues,
      ...(uniqueLauncherIssues.length > 0 ? { issues: uniqueLauncherIssues } : {}),
    };
  } catch {
    return { status: "invalid" };
  }
}

export function readProfileLauncherReadiness({ workspaceRoot } = {}) {
  const profiles = profilesCheck(resolveBoundedWorkspaceRoot(workspaceRoot));
  const launcherWarnings = profiles.launcherWarnings ?? [];
  return {
    status: profiles.status,
    launcherWarnings,
    launcherIssues: profiles.launcherIssues ?? [],
    ready: profiles.status === "ok" && launcherWarnings.length === 0,
  };
}

function adoptionCheck(root, localInstall = readLocalInstallBinding({ workspaceRoot: root })) {
  try {
    const evidence = readWorkspaceJsonBounded(
      root,
      path.join(".owlcoda", "runkit", "adoption", `${PACKAGE_NAME}-${EXPECTED_VERSION}.json`),
      { optional: true },
    );
    if (evidence === null) return { status: "missing", version: EXPECTED_VERSION };
    const validation = validateStoredRegistryAdoptionEvidence({
      evidence,
      packageName: PACKAGE_NAME,
      version: EXPECTED_VERSION,
      localInstall,
    });
    return {
      status: validation.valid ? "ok" : "invalid",
      version: EXPECTED_VERSION,
      issueCodes: validation.issueCodes,
    };
  } catch {
    return { status: "invalid", version: EXPECTED_VERSION };
  }
}

export function readAdoptionReadiness({ workspaceRoot } = {}) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  return adoptionCheck(root);
}

export async function runDoctor({
  workspaceRoot,
  registryUrl,
  timeoutMs = 1_500,
  registryClient,
} = {}) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  const core = currentCoreIdentity();
  const lifecycle = inspectProjectControlState({
    workspaceRoot: root,
    currentCore: core,
  });
  const installed = readLocalInstallBinding({ workspaceRoot: root });
  const registry = registryClient
    ? await registryClient.readExact({ packageName: PACKAGE_NAME, version: EXPECTED_VERSION })
    : await readRegistryExact({
        registryUrl,
        packageName: PACKAGE_NAME,
        version: EXPECTED_VERSION,
        timeoutMs,
      });
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
  const config = configCheck(root);
  const profiles = profilesCheck(root);
  const adoption = adoptionCheck(root, installed);
  const runtimeIsolation = runtimeIsolationCheck(root);
  const checks = {
    node: {
      status: nodeOk ? "ok" : "unsupported",
      version: process.versions.node,
    },
    core: {
      status: core.coreVersion === EXPECTED_VERSION ? "ok" : "mismatch",
      version: core.coreVersion,
      manifestSha256: core.coreManifestSha256,
    },
    config,
    installedPackage: installed.status === "bound"
      ? {
          status: "ok",
          version: installed.version,
          cliStatus: installed.cliStatus,
          ...(installed.cliPath ? { cliPath: installed.cliPath } : {}),
        }
      : { status: "mismatch" },
    registry: registry.status === "registry_verified"
      ? { status: "ok", version: registry.version }
      : { status: "issue", issueCodes: registry.issueCodes ?? [] },
    profiles,
    adoption,
    projectScripts: {
      status: "observed",
      detected: readProjectScripts(root),
    },
    runtimeIsolation,
    lifecycle: {
      status: lifecycle.status,
      activeRunIds: lifecycle.activeRunIds,
      activeLeaseIds: lifecycle.activeLeaseIds,
      recovery: lifecycle.recovery,
    },
  };
  const issueCodes = [...(registry.issueCodes ?? [])];
  if (!nodeOk) issueCodes.push("node_version_unsupported");
  if (checks.core.status !== "ok") issueCodes.push("core_version_mismatch");
  if (config.status === "missing") issueCodes.push("runkit_config_missing");
  if (config.status === "invalid") issueCodes.push("runkit_config_invalid");
  if (profiles.status === "missing") issueCodes.push("profiles_missing");
  if (profiles.status === "invalid") issueCodes.push("profiles_invalid");
  if (lifecycle.status === "invalid") issueCodes.push("runkit_control_state_invalid");
  if (installed.status !== "bound") {
    issueCodes.push(...(installed.issueCodes ?? ["registry_install_binding_mismatch"]));
  }
  if (
    registry.status === "registry_verified"
    && (
      installed.status !== "bound"
      || installed.version !== registry.version
      || installed.integrity !== registry.integrity
      || installed.resolved !== registry.tarballUrl
    )
  ) {
    issueCodes.push("registry_install_binding_mismatch");
  }
  const uniqueIssues = [...new Set(issueCodes)].sort();
  const profileLauncherWarningCount = (profiles.launcherWarnings ?? []).length;
  const warningCodes = [
    ...runtimeIsolation.affectedScripts
      .map(({ script, tool }) => `runkit_runtime_collection_risk:${tool}:${script}`),
    ...(profileLauncherWarningCount > 0 ? ["profile_launcher_warnings"] : []),
  ].sort();
  const lifecycleNextAction = lifecycle.recovery.nextAllowedAction;
  const maintenanceNextAction = profileLauncherWarningCount > 0
    ? "review_profile_launchers"
    : null;
  const nextAllowedAction = uniqueIssues.length === 0
    ? lifecycleNextAction !== "plan_new_execution"
      ? lifecycleNextAction
      : adoption.status === "ok"
        ? "plan_new_execution"
        : "adopt_current_release"
    : uniqueIssues.some((code) => code === "node_version_unsupported")
      ? "upgrade_node"
      : uniqueIssues.some((code) => code === "core_version_mismatch")
        ? "install_matching_core"
        : uniqueIssues.some((code) => code.startsWith("runkit_config_"))
          ? "run_init_or_repair_config"
          : uniqueIssues.some((code) => code.startsWith("profiles_"))
            ? "detect_or_repair_profiles"
            : uniqueIssues.includes("runkit_control_state_invalid")
              ? "repair_execution_artifacts"
            : "repair_registry_binding";
  return {
    schemaVersion: "OwlCodaRunKitDoctorReportV1",
    status: uniqueIssues.length === 0 ? "ready" : "issues_found",
    checks,
    issueCodes: uniqueIssues,
    warningCodes,
    profileLauncherWarnings: {
      count: profileLauncherWarningCount,
      blocking: false,
      recommendedAction: maintenanceNextAction,
    },
    lifecycleNextAction,
    maintenanceNextAction,
    nextAllowedAction,
    authorizationGranted: false,
  };
}

export function formatDoctorHuman(report) {
  const otherWarnings = report.warningCodes.filter(
    (code) => code !== "profile_launcher_warnings",
  );
  return [
    `Doctor: ${report.status}`,
    `Node: ${report.checks.node.status} (${report.checks.node.version})`,
    `Core: ${report.checks.core.status} (${report.checks.core.version})`,
    `Installed package: ${report.checks.installedPackage.status}`,
    `Registry: ${report.checks.registry.status}`,
    `Profiles: ${report.checks.profiles.status}`,
    `Adoption: ${report.checks.adoption.status}`,
    `Lifecycle: ${report.checks.lifecycle.status}`,
    ...(report.issueCodes.length > 0 ? [`Issues: ${report.issueCodes.join(", ")}`] : []),
    ...(report.profileLauncherWarnings.count > 0
      ? [`Profile launcher warnings: ${report.profileLauncherWarnings.count} (non-blocking)`]
      : []),
    ...(otherWarnings.length > 0 ? [`Warnings: ${otherWarnings.join(", ")}`] : []),
    `Next: ${report.nextAllowedAction === "adopt_current_release"
      ? `owlrunkit adopt --workspace . --exact ${PACKAGE_NAME}@${EXPECTED_VERSION}`
      : report.nextAllowedAction}`,
    ...(report.maintenanceNextAction
      ? [`Maintenance: ${report.maintenanceNextAction}`]
      : []),
    "",
  ].join("\n");
}
