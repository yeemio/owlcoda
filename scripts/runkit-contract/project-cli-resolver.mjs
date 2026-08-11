import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { currentCoreIdentity } from "./core-contract.mjs";

const MAX_JSON_BYTES = 1_048_576;
const MAX_LOCK_BYTES = 33_554_432;
const MAX_CORE_FILE_BYTES = 16_777_216;
const MAX_CORE_TOTAL_BYTES = 67_108_864;
const PACKAGE_NAME = "owlrunkit";
const OFFICIAL_CLI_ENTRYPOINT =
  "scripts/runkit-contract/runkit-bootstrap.mjs";
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const TRUSTED_PRIOR_CORE_IDENTITIES = new Map([
  ["0.17.2", new Set([
    "sha256:67b883b8a763253b873fb6047c7e7e01c81123aa5250a0db5feaabd13cc4d860",
  ])],
  ["0.17.1", new Set([
    "sha256:5376f3736dd17c07598df8b655a6bbceb3b64b44f3e6630e69f966e420d82e26",
  ])],
  ["0.17.0", new Set([
    "sha256:0c0c52e7f6299bdd3d3ea49005c8ceef0b28831d60af25d77da65a4e4de714c9",
  ])],
  ["0.16.0", new Set([
    "sha256:320fb1d97b4459d1a14b0b67807dcf2bc6b03970492cb9fb2c6245b17912c81e",
  ])],
  ["0.15.1", new Set([
    "sha256:e8ca57522a8e473da356ceb3768bb650267894638d450d5e49463ab6f51c752b",
  ])],
  ["0.15.0", new Set([
    "sha256:06d7616c369b4b3ece3aca32f05c505d4b30781d3ca87a13bd8d7293c1491f64",
  ])],
  ["0.14.0", new Set([
    "sha256:d3b498562bebb2fa180d6861cb834ce3551288bf499ce0d769ee6c64b2663231",
  ])],
  ["0.13.0", new Set([
    "sha256:0e3233a417365afb4e2ce22db5260608a9c697a819cd5c02897276d6454dde1f",
    "sha256:037c012751b32abbbb48ce8a8d2cd8faa4fc2c38d6797db391205477e667065f",
    "sha256:2f840d1884b34656902f8f23af3bd8052dde3212aa516dac2cbb0e0b29627ea1",
    "sha256:febf2551317fce9e4bb412b833a392a20376d702dda09c57d6116e8a3ca4f857",
    "sha256:4b72f572b6964f149c4a6fe5c2c9da85f73b8060c88023dc96ba5ca50a036972",
    "sha256:0455c847bf2df77703583c6f19c20cf103206bafc4f122795bf34d3f85f0263d",
  ])],
  ["0.12.0", new Set([
    "sha256:c415b10cb00d2a7891744b7257774fa501ddf40f8ec2f290356505a17fefb40f",
    "sha256:be4b079fb0bc29e71858af03a1e579f864d4414c815ac612c3b514d8d663d07b",
  ])],
]);
const LOCKFILES = [
  { manager: "npm", path: "package-lock.json" },
  { manager: "pnpm", path: "pnpm-lock.yaml" },
  { manager: "yarn", path: "yarn.lock" },
  { manager: "bun", path: "bun.lock" },
];

function strictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function canonicalWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("workspaceRoot is required.");
  }
  const requested = path.resolve(workspaceRoot);
  const stat = lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("workspace root must be a regular directory");
  }
  return realpathSync(requested);
}

function assertRegularDescendant(root, target, type, symlinkCode) {
  if (!strictDescendant(root, target)) throw new Error("project_cli_path_invalid");
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(symlinkCode);
  }
  const stat = lstatSync(target);
  if (
    (type === "file" && !stat.isFile())
    || (type === "directory" && !stat.isDirectory())
    || realpathSync(target) !== path.resolve(target)
  ) {
    throw new Error("project_cli_path_invalid");
  }
}

function readJson(root, relativePath) {
  const target = path.join(root, relativePath);
  assertRegularDescendant(root, target, "file", "project_cli_symlink_rejected");
  const stat = lstatSync(target);
  if (stat.size > MAX_JSON_BYTES) throw new Error("project_cli_json_too_large");
  return JSON.parse(readFileSync(target, "utf8"));
}

function readJsonAt(root, target) {
  assertRegularDescendant(root, target, "file", "project_cli_symlink_rejected");
  const stat = lstatSync(target);
  if (stat.size > MAX_JSON_BYTES) throw new Error("project_cli_json_too_large");
  return JSON.parse(readFileSync(target, "utf8"));
}

function readLock(root, relativePath) {
  const target = path.join(root, relativePath);
  assertRegularDescendant(root, target, "file", "project_cli_symlink_rejected");
  const stat = lstatSync(target);
  if (stat.size > MAX_LOCK_BYTES) throw new Error("project_cli_lockfile_too_large");
  return readFileSync(target, "utf8");
}

function dependencyDeclarations(manifest) {
  return ["dependencies", "devDependencies", "optionalDependencies"]
    .filter(section => Object.hasOwn(manifest[section] ?? {}, PACKAGE_NAME))
    .map(section => manifest[section][PACKAGE_NAME]);
}

function exactDeclaredVersion(manifest) {
  const declarations = dependencyDeclarations(manifest);
  if (declarations.length !== 1) {
    throw new Error("project_cli_dependency_ambiguous");
  }
  const version = declarations[0];
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) {
    throw new Error("project_cli_dependency_not_exact");
  }
  return version;
}

function mismatch(issueCode) {
  return {
    status: "mismatch",
    issueCodes: [issueCode],
    authorizationGranted: false,
  };
}

function packageManagerName(manifest) {
  if (manifest.packageManager === undefined) return null;
  if (typeof manifest.packageManager !== "string") {
    throw new Error("project_cli_package_manager_invalid");
  }
  const match = /^(npm|pnpm|yarn|bun)@[^\s]+$/.exec(manifest.packageManager);
  if (!match) throw new Error("project_cli_package_manager_invalid");
  return match[1];
}

function selectLockfile(root, manifest) {
  const present = LOCKFILES.filter(entry => existsSync(path.join(root, entry.path)));
  if (existsSync(path.join(root, "bun.lockb"))) {
    throw new Error("project_cli_lockfile_unsupported");
  }
  if (present.length !== 1) throw new Error("project_cli_lockfile_ambiguous");
  const declaredManager = packageManagerName(manifest);
  if (declaredManager !== null && declaredManager !== present[0].manager) {
    throw new Error("project_cli_package_manager_mismatch");
  }
  return present[0];
}

function officialTarballUrl(version) {
  return `https://registry.npmjs.org/${PACKAGE_NAME}/-/`
    + `${PACKAGE_NAME}-${version}.tgz`;
}

function canonicalSha512Sri(value) {
  if (
    typeof value !== "string"
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)
  ) {
    throw new Error("project_cli_integrity_invalid");
  }
  const encoded = value.slice("sha512-".length);
  const digest = Buffer.from(encoded, "base64");
  if (digest.length !== 64 || digest.toString("base64") !== encoded) {
    throw new Error("project_cli_integrity_invalid");
  }
  return value;
}

function validateRegistryBinding(binding, version) {
  if (binding.resolved !== officialTarballUrl(version)) {
    throw new Error("project_cli_registry_provenance_invalid");
  }
  return {
    resolved: binding.resolved,
    integrity: canonicalSha512Sri(binding.integrity),
  };
}

function npmLockBinding(root, version) {
  const lock = JSON.parse(readLock(root, "package-lock.json"));
  const rootDeclarations = dependencyDeclarations(lock.packages?.[""] ?? {});
  const entry = lock.packages?.[`node_modules/${PACKAGE_NAME}`];
  if (
    (
      rootDeclarations.length > 0
      && (
        rootDeclarations.length !== 1
        || rootDeclarations[0] !== version
      )
    )
    || entry?.version !== version
    || typeof entry.resolved !== "string"
    || typeof entry.integrity !== "string"
  ) {
    throw new Error("project_cli_lock_binding_mismatch");
  }
  return {
    resolved: entry.resolved,
    integrity: entry.integrity,
  };
}

function yamlScalar(value) {
  const trimmed = String(value).trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) return trimmed.slice(1, -1);
  return trimmed;
}

function indentedBlock(lines, start) {
  const indent = lines[start].match(/^\s*/)[0].length;
  const block = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      block.push(line);
      continue;
    }
    if (line.match(/^\s*/)[0].length <= indent) break;
    block.push(line);
  }
  return block;
}

function pnpmLockBinding(root, version) {
  const lines = readLock(root, "pnpm-lock.yaml").split(/\r?\n/);
  const dependencyBound = lines.some((line, index) => {
    if (!/^\s+owlrunkit:\s*$/.test(line)) return false;
    const block = indentedBlock(lines, index).join("\n");
    const specifier = /^\s*specifier:\s*(.+?)\s*$/m.exec(block)?.[1];
    const resolvedVersion = /^\s*version:\s*(.+?)\s*$/m.exec(block)?.[1];
    return yamlScalar(specifier) === version
      && yamlScalar(resolvedVersion).split("(")[0] === version;
  });
  const escaped = version.replaceAll(".", "\\.");
  const packageHeader = new RegExp(
    `^\\s{2}(?:/)?owlrunkit@${escaped}(?:\\([^)]*\\))?:\\s*$`,
  );
  let resolution = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!packageHeader.test(lines[index])) continue;
    const block = indentedBlock(lines, index).join("\n");
    const integrity = /(?:^|[{,\s])integrity:\s*([^,}\s]+)/m.exec(block)?.[1];
    if (!integrity) continue;
    const tarball = /(?:^|[{,\s])tarball:\s*([^,}\s]+)/m.exec(block)?.[1];
    resolution = {
      resolved: tarball ? yamlScalar(tarball) : officialTarballUrl(version),
      integrity: yamlScalar(integrity),
    };
    break;
  }
  if (!dependencyBound || !resolution) {
    throw new Error("project_cli_lock_binding_mismatch");
  }
  return resolution;
}

function yarnLockBinding(root, version) {
  const lines = readLock(root, "yarn.lock").split(/\r?\n/);
  const escaped = version.replaceAll(".", "\\.");
  const selector = new RegExp(
    `(?:^|,\\s*)"?owlrunkit@(?:npm:)?${escaped}"?(?:,|:)`,
  );
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s/.test(lines[index]) || !selector.test(lines[index])) continue;
    const block = indentedBlock(lines, index).join("\n");
    const lockedVersion = /(?:^|\n)\s*version(?::|\s)\s*"?([^"\s]+)"?/m.exec(block)?.[1];
    const resolved =
      /(?:^|\n)\s*resolved\s+"?([^"\s]+)"?/m.exec(block)?.[1]
      ?? /(?:^|\n)\s*resolution:\s*"?([^"\s]+)"?/m.exec(block)?.[1];
    const integrity =
      /(?:^|\n)\s*integrity\s+([^\s]+)/m.exec(block)?.[1]
      ?? /(?:^|\n)\s*checksum:\s*"?([^"\s]+)"?/m.exec(block)?.[1];
    if (lockedVersion === version && resolved && integrity) {
      return { resolved, integrity };
    }
  }
  throw new Error("project_cli_lock_binding_mismatch");
}

function stripJsonComments(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const next = value[index + 1];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < value.length && value[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < value.length
        && !(value[index] === "*" && value[index + 1] === "/")
      ) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function removeTrailingCommas(value) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let cursor = index + 1;
      while (/\s/.test(value[cursor] ?? "")) cursor += 1;
      if (value[cursor] === "}" || value[cursor] === "]") continue;
    }
    output += character;
  }
  return output;
}

function bunLockBinding(root, version) {
  const lock = JSON.parse(removeTrailingCommas(stripJsonComments(
    readLock(root, "bun.lock"),
  )));
  const workspaceVersion = exactDeclaredVersion(lock.workspaces?.[""] ?? {});
  const entry =
    lock.packages?.[PACKAGE_NAME]
    ?? lock.packages?.[`${PACKAGE_NAME}@${version}`];
  let resolved;
  let integrity;
  if (Array.isArray(entry)) {
    const identity = entry.find(value =>
      typeof value === "string"
      && new Set([
        `${PACKAGE_NAME}@${version}`,
        `${PACKAGE_NAME}@npm:${version}`,
      ]).has(value));
    resolved = entry.find(value =>
      typeof value === "string" && /^https?:\/\//.test(value))
      ?? (identity ? officialTarballUrl(version) : null);
    integrity = [...entry].reverse().find(value =>
      typeof value === "string" && /^(?:sha512-|[a-f0-9]{64,})/i.test(value));
  } else if (entry && typeof entry === "object") {
    if (entry.version !== version) {
      throw new Error("project_cli_lock_binding_mismatch");
    }
    resolved = entry.resolved ?? entry.resolution;
    integrity = entry.integrity ?? entry.checksum;
  }
  if (workspaceVersion !== version || !resolved || !integrity) {
    throw new Error("project_cli_lock_binding_mismatch");
  }
  return { resolved, integrity };
}

function lockBinding(root, lockfile, version) {
  const binding = lockfile.manager === "npm"
    ? npmLockBinding(root, version)
    : lockfile.manager === "pnpm"
      ? pnpmLockBinding(root, version)
      : lockfile.manager === "yarn"
        ? yarnLockBinding(root, version)
        : bunLockBinding(root, version);
  return validateRegistryBinding(binding, version);
}

function storeRoot(root, manager) {
  if (manager === "pnpm") return path.join(root, "node_modules", ".pnpm");
  if (manager === "yarn") return path.join(root, ".yarn", "unplugged");
  if (manager === "bun") return path.join(root, "node_modules", ".bun");
  return null;
}

function resolvePackageRoot(root, manager) {
  const logicalPackageRoot = path.join(root, "node_modules", PACKAGE_NAME);
  assertRegularDescendant(
    root,
    path.dirname(logicalPackageRoot),
    "directory",
    "project_cli_symlink_rejected",
  );
  const stat = lstatSync(logicalPackageRoot);
  if (!stat.isSymbolicLink()) {
    assertRegularDescendant(
      root,
      logicalPackageRoot,
      "directory",
      "project_cli_symlink_rejected",
    );
    return {
      logicalPackageRoot,
      packageRoot: logicalPackageRoot,
      symlinkedStore: false,
    };
  }
  const packageRoot = realpathSync(logicalPackageRoot);
  const allowedStore = storeRoot(root, manager);
  if (
    allowedStore === null
    || !strictDescendant(root, packageRoot)
    || !strictDescendant(allowedStore, packageRoot)
  ) {
    throw new Error("project_cli_symlink_rejected");
  }
  assertRegularDescendant(
    root,
    packageRoot,
    "directory",
    "project_cli_symlink_rejected",
  );
  return {
    logicalPackageRoot,
    packageRoot,
    symlinkedStore: true,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function coreFileList(coreContractSource, identifier) {
  const marker = `const ${identifier} = [`;
  const start = coreContractSource.indexOf(marker);
  if (start < 0) throw new Error("project_cli_core_contract_invalid");
  const bodyStart = start + marker.length;
  const end = coreContractSource.indexOf("];", bodyStart);
  if (end < 0) throw new Error("project_cli_core_contract_invalid");
  const body = coreContractSource.slice(bodyStart, end);
  const values = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^("(?:[^"\\]|\\.)*"),?$/u.exec(line);
      if (!match) throw new Error("project_cli_core_contract_invalid");
      return JSON.parse(match[1]);
    });
  if (
    values.length > 512
    || new Set(values).size !== values.length
    || values.some((value) => (
      typeof value !== "string"
      || value.length === 0
      || path.isAbsolute(value)
      || value.includes("\\")
      || value.split("/").some((segment) => (
        segment.length === 0 || segment === "." || segment === ".."
      ))
    ))
  ) {
    throw new Error("project_cli_core_contract_invalid");
  }
  return values;
}

function installedCoreManifestSha256(packageRoot) {
  const coreRoot = path.join(packageRoot, "scripts", "runkit-contract");
  const coreContractPath = path.join(coreRoot, "core-contract.mjs");
  assertRegularDescendant(
    packageRoot,
    coreContractPath,
    "file",
    "project_cli_symlink_rejected",
  );
  if (lstatSync(coreContractPath).size > MAX_JSON_BYTES) {
    throw new Error("project_cli_core_contract_too_large");
  }
  const source = readFileSync(coreContractPath, "utf8");
  const coreFiles = coreFileList(source, "CORE_FILES");
  const dependencyFiles = coreFileList(source, "CORE_DEPENDENCY_FILES");
  const entries = [
    ...coreFiles.map((relativePath) => ({
      relativePath,
      target: path.join(coreRoot, relativePath),
    })),
    ...dependencyFiles.map((relativePath) => ({
      relativePath,
      target: path.join(packageRoot, relativePath),
    })),
  ];
  if (
    entries.length === 0
    || new Set(entries.map((entry) => entry.target)).size !== entries.length
  ) {
    throw new Error("project_cli_core_contract_invalid");
  }
  let totalBytes = 0;
  const stream = entries.map(({ relativePath, target }) => {
    assertRegularDescendant(
      packageRoot,
      target,
      "file",
      "project_cli_symlink_rejected",
    );
    const size = lstatSync(target).size;
    totalBytes += size;
    if (
      size > MAX_CORE_FILE_BYTES
      || totalBytes > MAX_CORE_TOTAL_BYTES
    ) {
      throw new Error("project_cli_core_closure_too_large");
    }
    return `${relativePath}\tsha256:${sha256(readFileSync(target))}\n`;
  }).join("");
  return `sha256:${sha256(stream)}`;
}

function trustedCoreManifestHashes(version) {
  const running = currentCoreIdentity();
  if (running.coreVersion === version) {
    return {
      hashes: new Set([running.coreManifestSha256]),
      source: "running_bootstrap_core",
    };
  }
  const prior = TRUSTED_PRIOR_CORE_IDENTITIES.get(version);
  if (!prior) throw new Error("project_cli_core_version_untrusted");
  return {
    hashes: prior,
    source: "bootstrap_embedded_prior_core_catalog",
  };
}

function verifyInstalledCoreBinding(root, packageRoot, version) {
  let config;
  try {
    config = readJson(root, ".owlcoda/runkit/config.json");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("project_cli_core_config_missing");
    }
    throw error;
  }
  const core = config?.core;
  if (
    !new Set([
      "OwlCodaRunKitConfigV1",
      "OwlCodaRunKitConfigV2",
    ]).has(config?.schemaVersion)
    || typeof core?.contractVersion !== "string"
    || core.coreVersion !== version
    || !SHA256_REF.test(core.coreManifestSha256)
    || core.coreSourceRef !== `artifact:${core.coreManifestSha256}`
  ) {
    throw new Error("project_cli_core_config_invalid");
  }
  const actualCoreManifestSha256 = installedCoreManifestSha256(packageRoot);
  const trusted = trustedCoreManifestHashes(version);
  if (!trusted.hashes.has(actualCoreManifestSha256)) {
    throw new Error("project_cli_untrusted_core_identity");
  }
  if (actualCoreManifestSha256 !== core.coreManifestSha256) {
    throw new Error("project_cli_installed_core_drift");
  }
  return {
    schemaVersion: "OwlCodaRunKitInstalledCoreBindingV1",
    coreVersion: version,
    coreManifestSha256: actualCoreManifestSha256,
    trustedIdentitySource: trusted.source,
    configPath: ".owlcoda/runkit/config.json",
  };
}

export function resolveProjectCli({
  workspaceRoot,
  expectedVersion = null,
  requireEntrypoint = true,
} = {}) {
  let root;
  try {
    root = canonicalWorkspaceRoot(workspaceRoot);
  } catch {
    return mismatch("project_cli_workspace_invalid");
  }
  try {
    const manifest = readJson(root, "package.json");
    const version = exactDeclaredVersion(manifest);
    if (expectedVersion !== null && version !== expectedVersion) {
      return mismatch("project_cli_version_mismatch");
    }
    const selectedLockfile = selectLockfile(root, manifest);
    const binding = lockBinding(root, selectedLockfile, version);
    const installed = resolvePackageRoot(root, selectedLockfile.manager);
    const installedManifest = readJsonAt(
      root,
      path.join(installed.packageRoot, "package.json"),
    );
    if (
      installedManifest.name !== PACKAGE_NAME
      || installedManifest.version !== version
    ) {
      return mismatch("project_cli_install_binding_mismatch");
    }
    const bin = typeof installedManifest.bin === "string"
      ? installedManifest.bin
      : installedManifest.bin?.[PACKAGE_NAME];
    if (typeof bin !== "string" || bin.length === 0) {
      if (requireEntrypoint) return mismatch("project_cli_bin_missing");
      return {
        schemaVersion: "OwlCodaRunKitProjectCliBindingV1",
        status: "bound",
        workspaceRoot: root,
        packageName: PACKAGE_NAME,
        packageManager: selectedLockfile.manager,
        lockfilePath: selectedLockfile.path,
        logicalPackageRoot: installed.logicalPackageRoot,
        packageRoot: installed.packageRoot,
        symlinkedStore: installed.symlinkedStore,
        version,
        requestedSpec: `${PACKAGE_NAME}@${version}`,
        resolved: binding.resolved,
        integrity: binding.integrity,
        cliStatus: "unavailable",
        authorizationGranted: false,
      };
    }
    if (bin !== OFFICIAL_CLI_ENTRYPOINT) {
      return mismatch("project_cli_bin_invalid");
    }
    const cliPath = path.resolve(installed.packageRoot, bin);
    if (!strictDescendant(installed.packageRoot, cliPath)) {
      return mismatch("project_cli_path_invalid");
    }
    assertRegularDescendant(
      installed.packageRoot,
      cliPath,
      "file",
      "project_cli_symlink_rejected",
    );
    const installedCoreBinding = requireEntrypoint
      ? verifyInstalledCoreBinding(root, installed.packageRoot, version)
      : null;
    return {
      schemaVersion: "OwlCodaRunKitProjectCliBindingV1",
      status: "bound",
      workspaceRoot: root,
      packageName: PACKAGE_NAME,
      packageManager: selectedLockfile.manager,
      lockfilePath: selectedLockfile.path,
      logicalPackageRoot: installed.logicalPackageRoot,
      packageRoot: installed.packageRoot,
      symlinkedStore: installed.symlinkedStore,
      version,
      requestedSpec: `${PACKAGE_NAME}@${version}`,
      resolved: binding.resolved,
      integrity: binding.integrity,
      cliPath,
      cliStatus: "bound",
      installedCoreBinding,
      argvPrefix: [process.execPath, cliPath],
      authorizationGranted: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return mismatch(
      message.startsWith("project_cli_")
        ? message
        : "project_cli_install_binding_mismatch",
    );
  }
}
