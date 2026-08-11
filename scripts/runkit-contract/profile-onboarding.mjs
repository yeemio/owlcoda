import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  readWorkspaceJsonBounded,
  resolveBoundedWorkspaceRoot,
} from "./onboarding-doctor.mjs";
import { resolveProfileImpactDetailed } from "./profile-impact.mjs";
import {
  safeIdentifier,
  safeRelativePath,
} from "./provenance-common.mjs";

function resolveRegularExecutable(name) {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter);
  const suffixes = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory || ".", `${name}${suffix}`);
      try {
        const resolved = realpathSync(candidate);
        const stat = lstatSync(resolved);
        if (stat.isFile() && !stat.isSymbolicLink()) return resolved;
      } catch {
        // Continue through PATH without treating a missing or unsafe entry as authority.
      }
    }
  }
  return null;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("profile_detection_noncanonical_value");
  return encoded;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedRegularFile(root, relativePath) {
  safeRelativePath(relativePath, "profile detection input");
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`profile_detection_input_outside_workspace:${relativePath}`);
  }
  const stat = lstatSync(absolute);
  const resolved = realpathSync(absolute);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || resolved !== absolute
  ) {
    throw new Error(`profile_detection_input_not_regular:${relativePath}`);
  }
  return absolute;
}

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function ensureDirectoryChain(root, relativeDirectory) {
  let current = root;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    try {
      lstatSync(current);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(current);
    }
    const stat = lstatSync(current);
    const resolved = realpathSync(current);
    if (
      stat.isSymbolicLink()
      || !stat.isDirectory()
      || resolved !== current
      || !insideRoot(root, resolved)
    ) {
      throw new Error("profile_apply_directory_untrusted");
    }
  }
  return current;
}

function regularExecutable(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return null;
  try {
    const resolved = realpathSync(value);
    const stat = lstatSync(resolved);
    return stat.isFile() && !stat.isSymbolicLink() ? resolved : null;
  } catch {
    return null;
  }
}

function toolIdentity(executable, argvPrefix, version) {
  const launcher = regularExecutable(argvPrefix[0] ?? executable);
  if (!launcher || typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+/.test(version)) {
    return null;
  }
  return {
    version,
    executableSha256: sha256(readFileSync(executable)),
    launcherSha256: sha256(readFileSync(launcher)),
  };
}

function defaultProjectNpm(root, manifest) {
  try {
    if (
      typeof manifest.packageManager === "string"
      && !manifest.packageManager.startsWith("npm@")
    ) return null;
    const lockPath = boundedRegularFile(root, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(lock.lockfileVersion)) return null;
    const executable = regularExecutable(process.execPath);
    if (!executable) return null;
    const npmEntry = path.join(
      path.dirname(executable),
      process.platform === "win32" ? "npm.cmd" : "npm",
    );
    const npmCli = regularExecutable(npmEntry);
    if (!npmCli || process.platform === "win32") return null;
    const npmManifestPath = path.resolve(npmCli, "..", "..", "package.json");
    const npmManifest = JSON.parse(readFileSync(npmManifestPath, "utf8"));
    if (
      npmManifest.name !== "npm"
      || typeof npmManifest.version !== "string"
      || (
        typeof manifest.packageManager === "string"
        && manifest.packageManager.startsWith("npm@")
        && manifest.packageManager.slice(4) !== npmManifest.version
      )
    ) {
      return null;
    }
    const identity = toolIdentity(executable, [npmCli], npmManifest.version);
    if (!identity) return null;
    return {
      status: "resolved",
      confidence: "high",
      source: "project_lockfile",
      packageManager: "npm",
      executable,
      argvPrefix: [npmCli],
      inputFiles: ["package.json", "package-lock.json"],
      issueCodes: [],
      ...identity,
    };
  } catch {
    return null;
  }
}

function selectedPackageManager(root, manifest) {
  const declared = typeof manifest.packageManager === "string"
    ? /^(npm|pnpm|yarn|bun)@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/
      .exec(manifest.packageManager)
    : null;
  const lockfiles = [
    { manager: "npm", refs: ["package-lock.json"] },
    { manager: "pnpm", refs: ["pnpm-lock.yaml"] },
    { manager: "yarn", refs: ["yarn.lock"] },
    { manager: "bun", refs: ["bun.lock", "bun.lockb"] },
  ].flatMap(entry => entry.refs
    .filter(ref => existsSync(path.join(root, ref)))
    .map(ref => ({ manager: entry.manager, ref })));
  if (lockfiles.length !== 1) return {
    manager: declared?.[1] ?? null,
    version: declared?.[2] ?? null,
    lockfile: null,
  };
  if (declared && declared[1] !== lockfiles[0].manager) {
    return {
      manager: declared[1],
      version: declared[2],
      lockfile: null,
    };
  }
  return {
    manager: declared?.[1] ?? lockfiles[0].manager,
    version: declared?.[2] ?? null,
    lockfile: lockfiles[0].ref,
  };
}

function defaultProjectInstalledManager(root, manifest) {
  const selected = selectedPackageManager(root, manifest);
  if (
    selected.manager === null
    || selected.manager === "npm"
    || selected.version === null
    || selected.lockfile === null
  ) return null;
  try {
    boundedRegularFile(root, selected.lockfile);
    const requestedPackageRoot = path.join(
      root,
      "node_modules",
      selected.manager,
    );
    const packageRoot = realpathSync(requestedPackageRoot);
    if (!insideRoot(root, packageRoot)) return null;
    const managerManifestPath = path.join(packageRoot, "package.json");
    const managerManifestStat = lstatSync(managerManifestPath);
    if (
      managerManifestStat.isSymbolicLink()
      || !managerManifestStat.isFile()
      || realpathSync(managerManifestPath) !== managerManifestPath
    ) return null;
    const managerManifest = JSON.parse(readFileSync(managerManifestPath, "utf8"));
    if (
      managerManifest.name !== selected.manager
      || managerManifest.version !== selected.version
    ) return null;
    const declaredBin = typeof managerManifest.bin === "string"
      ? managerManifest.bin
      : managerManifest.bin?.[selected.manager];
    if (typeof declaredBin !== "string" || declaredBin.length === 0) return null;
    safeRelativePath(declaredBin, "project package manager bin");
    const launcher = realpathSync(path.join(packageRoot, declaredBin));
    const launcherStat = lstatSync(launcher);
    if (
      !insideRoot(root, launcher)
      || launcherStat.isSymbolicLink()
      || !launcherStat.isFile()
    ) return null;
    const executable = regularExecutable(process.execPath);
    if (!executable) return null;
    const identity = toolIdentity(executable, [launcher], selected.version);
    if (!identity) return null;
    const managerManifestRef = path.relative(root, managerManifestPath)
      .split(path.sep)
      .join("/");
    const launcherRef = path.relative(root, launcher)
      .split(path.sep)
      .join("/");
    return {
      status: "resolved",
      confidence: "high",
      source: "project_install",
      packageManager: selected.manager,
      executable,
      argvPrefix: [launcher],
      inputFiles: [
        "package.json",
        selected.lockfile,
        managerManifestRef,
        launcherRef,
      ].sort(),
      issueCodes: [],
      ...identity,
    };
  } catch {
    return null;
  }
}

function resolveProjectTool(root, manifest, projectToolResolver) {
  const selected = selectedPackageManager(root, manifest);
  const packageManager = selected.manager ?? "npm";
  if (typeof projectToolResolver === "function") {
    try {
      const resolved = projectToolResolver({
        workspaceRoot: root,
        tool: packageManager,
        manifest: structuredClone(manifest),
      });
      const executable = regularExecutable(resolved?.executable);
      const argvPrefix = Array.isArray(resolved?.argvPrefix)
        && resolved.argvPrefix.every(value => typeof value === "string" && value.length > 0)
        ? [...resolved.argvPrefix]
        : null;
      const inputFiles = Array.isArray(resolved?.inputFiles)
        && resolved.inputFiles.every(value => typeof value === "string" && value.length > 0)
        ? [...new Set(resolved.inputFiles)].sort()
        : null;
      const authoritativeSource = new Set([
        "project_install",
        "project_lockfile",
        "project_toolchain",
      ]).has(resolved?.source);
      const identity = executable && argvPrefix
        ? toolIdentity(executable, argvPrefix, resolved?.version)
        : null;
      const lockBound = inputFiles?.includes("package.json")
        && inputFiles.some(ref => [
          "bun.lock",
          "bun.lockb",
          "package-lock.json",
          "pnpm-lock.yaml",
          "yarn.lock",
        ].includes(ref));
      if (
        resolved?.status === "resolved"
        && executable
        && argvPrefix
        && inputFiles
        && identity
      ) {
        const high = resolved.confidence === "high"
          && authoritativeSource
          && lockBound;
        return {
          status: "resolved",
          confidence: high ? "high" : "review_required",
          source: String(resolved.source ?? "injected_resolver"),
          packageManager,
          executable,
          argvPrefix,
          inputFiles,
          issueCodes: high ? [] : ["project_tool_resolution_not_authoritative"],
          ...identity,
        };
      }
      return {
        status: "invalid",
        confidence: "review_required",
        source: "injected_resolver",
        packageManager,
        executable: null,
        argvPrefix: [],
        inputFiles: [],
        version: null,
        executableSha256: null,
        launcherSha256: null,
        issueCodes: ["project_tool_resolution_invalid"],
      };
    } catch {
      return {
        status: "invalid",
        confidence: "review_required",
        source: "injected_resolver",
        packageManager,
        executable: null,
        argvPrefix: [],
        inputFiles: [],
        version: null,
        executableSha256: null,
        launcherSha256: null,
        issueCodes: ["project_tool_resolution_failed"],
      };
    }
  }

  const installedManager = defaultProjectInstalledManager(root, manifest);
  if (installedManager) return installedManager;
  const projectNpm = defaultProjectNpm(root, manifest);
  if (projectNpm) return projectNpm;
  const executable = resolveRegularExecutable(packageManager);
  return {
    status: executable ? "resolved" : "unavailable",
    confidence: "review_required",
    source: executable ? "path_fallback" : "unavailable",
    packageManager,
    executable,
    argvPrefix: [],
    inputFiles: [],
    version: null,
    executableSha256: executable ? sha256(readFileSync(executable)) : null,
    launcherSha256: null,
    issueCodes: ["project_tool_resolution_not_authoritative"],
  };
}

function command(id, script, executable) {
  return {
    id,
    cwd: ".",
    executable,
    argv: ["run", script],
  };
}

function workspaceCommand(
  id,
  workspacePath,
  script,
  executable,
  useWorkspaceCwd = false,
) {
  return {
    id,
    cwd: useWorkspaceCwd ? workspacePath : ".",
    executable,
    argv: useWorkspaceCwd
      ? ["run", script]
      : ["run", "--workspace", workspacePath, script],
  };
}

function detectedScripts(manifest) {
  return Object.keys(manifest.scripts ?? {}).sort();
}

function workspacePatterns(manifest) {
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces;
  if (
    manifest.workspaces
    && typeof manifest.workspaces === "object"
    && Array.isArray(manifest.workspaces.packages)
  ) {
    return manifest.workspaces.packages;
  }
  return [];
}

function safeWorkspacePattern(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || path.isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")
  ) {
    return null;
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  const wildcardCount = [...value].filter((character) => character === "*").length;
  if (wildcardCount === 0) return { kind: "literal", path: value };
  if (wildcardCount === 1 && value.endsWith("/*")) {
    return { kind: "children", path: value.slice(0, -2) };
  }
  return null;
}

function discoverWorkspaces(root, manifest) {
  const warnings = [];
  const paths = new Set();
  for (const rawPattern of workspacePatterns(manifest)) {
    const pattern = safeWorkspacePattern(rawPattern);
    if (pattern === null) {
      warnings.push(`unsupported_workspace_pattern:${String(rawPattern)}`);
      continue;
    }
    if (pattern.kind === "literal") {
      paths.add(pattern.path);
      continue;
    }
    const parent = path.join(root, pattern.path);
    try {
      const parentStat = lstatSync(parent);
      if (
        parentStat.isSymbolicLink()
        || !parentStat.isDirectory()
        || realpathSync(parent) !== path.resolve(parent)
      ) {
        warnings.push(`unsafe_workspace_parent:${pattern.path}`);
        continue;
      }
      for (const entry of readdirSync(parent, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          paths.add(`${pattern.path}/${entry.name}`);
        }
      }
    } catch {
      // A declared workspace pattern may legitimately have no current matches.
    }
  }

  const workspaces = [];
  for (const workspacePath of [...paths].sort()) {
    try {
      const workspaceManifest = readWorkspaceJsonBounded(
        root,
        path.join(workspacePath, "package.json"),
      );
      workspaces.push({
        name: typeof workspaceManifest.name === "string"
          ? workspaceManifest.name
          : workspacePath,
        path: workspacePath,
        scripts: detectedScripts(workspaceManifest),
      });
    } catch {
      warnings.push(`workspace_manifest_unreadable:${workspacePath}`);
    }
  }
  return {
    workspaces,
    warnings: [...new Set(warnings)].sort(),
  };
}

function profileIdForWorkspace(workspacePath) {
  return `workspace-${workspacePath.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
}

function workspaceProfiles(
  workspaces,
  npmExecutable,
  packageManager = "npm",
  useWorkspaceCwd = false,
) {
  return workspaces
    .map((workspace) => {
      const qualityScripts = workspace.scripts.filter((script) =>
        ["build", "e2e", "lint", "test", "typecheck"].includes(script));
      if (qualityScripts.length === 0) return null;
      const profileId = profileIdForWorkspace(workspace.path);
      return {
        id: profileId,
        paths: [`${workspace.path}/**`],
        role: "primary",
        primary: false,
        requiresProfileIds: [],
        commands: npmExecutable
          ? qualityScripts.map((script) => workspaceCommand(
              `${packageManager}-${profileId}-${script}`,
              workspace.path,
              script,
              npmExecutable,
              useWorkspaceCwd,
            ))
          : [],
      };
    })
    .filter(Boolean);
}

function profileCandidates(
  root,
  manifest,
  npmExecutable,
  workspaces,
  packageManager = "npm",
  useWorkspaceCwd = false,
  includeLegacyDatabaseProfile = false,
) {
  const scripts = new Set(detectedScripts(manifest));
  const candidates = [];
  if (
    includeLegacyDatabaseProfile
    && (
      existsSync(path.join(root, "prisma"))
      || [...scripts].some((script) => /^(db:|prisma)/.test(script))
    )
  ) {
    const commands = [...scripts]
      .filter((script) => /^(db:|prisma)/.test(script))
      .map((script) => npmExecutable
        ? command(
            `${packageManager}-${script.replaceAll(":", "-")}`,
            script,
            npmExecutable,
          )
        : null)
      .filter(Boolean);
    candidates.push({
      id: "database",
      paths: ["prisma/**"],
      role: "primary",
      primary: false,
      requiresProfileIds: [],
      commands,
    });
  }
  if (
    existsSync(path.join(root, "package.json"))
    && [...scripts].some((script) => ["build", "lint", "test", "typecheck"].includes(script))
  ) {
    const commands = ["build", "lint", "test", "typecheck"]
      .filter((script) => scripts.has(script))
      .map((script) => npmExecutable
        ? command(`${packageManager}-${script}`, script, npmExecutable)
        : null)
      .filter(Boolean);
    candidates.push({
      id: "node-quality",
      paths: ["src/**", "tests/**"],
      role: "primary",
      primary: false,
      requiresProfileIds: [],
      commands,
    });
  }
  if (
    existsSync(path.join(root, "playwright.config.ts"))
    || existsSync(path.join(root, "playwright.config.js"))
    || scripts.has("e2e")
  ) {
    const commands = scripts.has("e2e") && npmExecutable
      ? [command(`${packageManager}-e2e`, "e2e", npmExecutable)]
      : [];
    candidates.push({
      id: "web-e2e",
      paths: ["playwright.config.ts", "tests/e2e/**"],
      role: "primary",
      primary: false,
      requiresProfileIds: [],
      commands,
    });
  }
  candidates.push(...workspaceProfiles(
    workspaces,
    npmExecutable,
    packageManager,
    useWorkspaceCwd,
  ));
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

export function detectProfiles({ workspaceRoot } = {}) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  const manifest = readWorkspaceJsonBounded(root, "package.json");
  const npmExecutable = resolveRegularExecutable("npm");
  const discovered = discoverWorkspaces(root, manifest);
  const candidates = profileCandidates(
    root,
    manifest,
    npmExecutable,
    discovered.workspaces,
    "npm",
    false,
    true,
  );
  const primaryCandidates = candidates.filter((profile) => profile.role === "primary");
  const warnings = primaryCandidates.length > 1
    ? [`ambiguous_primary_profile:${primaryCandidates.map((profile) => profile.id).join(",")}`]
    : [];
  warnings.push(...discovered.warnings);
  if (
    npmExecutable === null
    && (
      detectedScripts(manifest).some((script) =>
        /^(build|db:|e2e|lint|prisma|test|typecheck)/.test(script))
      || discovered.workspaces.some((workspace) => workspace.scripts.some((script) =>
        /^(build|e2e|lint|test|typecheck)$/.test(script)))
    )
  ) {
    warnings.push("npm_regular_executable_unavailable");
  }
  return {
    schemaVersion: "OwlCodaRunKitProfileDetectionV1",
    status: "profiles_detected",
    dryRun: true,
    writesPerformed: 0,
    candidates,
    primaryProfileId: primaryCandidates.length === 1 ? primaryCandidates[0].id : null,
    warnings,
    detectedScripts: detectedScripts(manifest),
    detectedWorkspaces: discovered.workspaces,
    authorizationGranted: false,
  };
}

function detectedInputManifest(root, workspaces, toolBinding) {
  const refs = new Set([
    "package.json",
    ...[
      "bun.lock",
      "bun.lockb",
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
    ].filter(ref => existsSync(path.join(root, ref))),
    ...workspaces.map(workspace => `${workspace.path}/package.json`),
    ...toolBinding.inputFiles,
  ]);
  return [...refs]
    .sort()
    .map((ref) => {
      const absolute = boundedRegularFile(root, ref);
      return {
        path: ref,
        sha256: sha256(readFileSync(absolute)),
      };
    });
}

function bindCommandsToProjectTool(profiles, toolBinding) {
  return profiles.map(profile => ({
    ...profile,
    commands: profile.commands.map(entry => ({
      ...entry,
      executable: toolBinding.executable,
      argv: [...toolBinding.argvPrefix, ...entry.argv],
    })),
  }));
}

function proposedProfileDocument(candidates, inputManifest) {
  const actionable = candidates.filter(profile => profile.commands.length > 0);
  const selectedPrimary = actionable.find(profile => profile.id === "node-quality")
    ?? actionable[0]
    ?? null;
  const rootSurfacePaths = inputManifest
    .map(entry => entry.path)
    .filter(ref => !ref.includes("/"));
  return {
    schemaVersion: "OwlCodaRunKitProfilesV1",
    profiles: candidates.map(profile => ({
      ...profile,
      paths: [...new Set([
        ...profile.paths,
        ...(profile.id === selectedPrimary?.id ? rootSurfacePaths : []),
      ])].sort(),
      primary: profile.id === selectedPrimary?.id,
    })),
  };
}

function profilesFileHash(root) {
  const ref = path.join(root, ".owlcoda", "runkit", "profiles.json");
  if (!existsSync(ref)) return null;
  return sha256(readFileSync(boundedRegularFile(
    root,
    path.join(".owlcoda", "runkit", "profiles.json"),
  )));
}

function exactRegularFileBytes(absolutePath, expectedBytes) {
  try {
    const stat = lstatSync(absolutePath);
    return !stat.isSymbolicLink()
      && stat.isFile()
      && realpathSync(absolutePath) === absolutePath
      && readFileSync(absolutePath, "utf8") === expectedBytes;
  } catch {
    return false;
  }
}

function commitCreateOnlyStagedFile(stagedPath, finalPath, expectedBytes) {
  if (!exactRegularFileBytes(stagedPath, expectedBytes)) {
    throw new Error("profile_apply_staged_file_invalid");
  }
  try {
    linkSync(stagedPath, finalPath);
  } catch (error) {
    if (
      error?.code !== "EEXIST"
      || !exactRegularFileBytes(finalPath, expectedBytes)
    ) {
      throw error;
    }
  }
  rmSync(stagedPath, { force: true });
}

function recoverProfileApplyTransaction({
  root,
  transactionRoot,
  profilesPath,
  profilesBytes,
  receiptAbsolutePath,
  receiptBytes,
  receipt,
}) {
  const transactionStat = lstatSync(transactionRoot);
  if (
    transactionStat.isSymbolicLink()
    || !transactionStat.isDirectory()
    || realpathSync(transactionRoot) !== transactionRoot
    || !insideRoot(root, transactionRoot)
  ) {
    throw new Error("profile_apply_transaction_directory_untrusted");
  }
  const entries = readdirSync(transactionRoot).sort();
  if (entries.some((entry) => !["profiles.json", "receipt.json"].includes(entry))) {
    throw new Error("profile_apply_transaction_contents_untrusted");
  }
  const stagedProfiles = path.join(transactionRoot, "profiles.json");
  const stagedReceipt = path.join(transactionRoot, "receipt.json");
  const currentProfilesSha256 = profilesFileHash(root);
  const receiptExists = existsSync(receiptAbsolutePath);
  if (
    currentProfilesSha256 === null
    && !exactRegularFileBytes(stagedProfiles, profilesBytes)
  ) {
    throw new Error("profile_apply_transaction_staged_profile_mismatch");
  }
  if (
    currentProfilesSha256 !== null
    && currentProfilesSha256 !== receipt.appliedProfilesSha256
  ) {
    throw new Error("profile_apply_transaction_profile_mismatch");
  }
  if (
    currentProfilesSha256 !== null
    && existsSync(stagedProfiles)
    && !exactRegularFileBytes(stagedProfiles, profilesBytes)
  ) {
    throw new Error("profile_apply_transaction_staged_profile_mismatch");
  }
  if (
    receiptExists
      ? !exactRegularFileBytes(receiptAbsolutePath, receiptBytes)
      : !exactRegularFileBytes(stagedReceipt, receiptBytes)
  ) {
    throw new Error("profile_apply_transaction_receipt_mismatch");
  }
  let profilesCommittedByRecovery = false;
  try {
    if (currentProfilesSha256 === null) {
      commitCreateOnlyStagedFile(stagedProfiles, profilesPath, profilesBytes);
      profilesCommittedByRecovery = true;
    } else {
      rmSync(stagedProfiles, { force: true });
    }
    if (receiptExists) {
      rmSync(stagedReceipt, { force: true });
    } else {
      commitCreateOnlyStagedFile(
        stagedReceipt,
        receiptAbsolutePath,
        receiptBytes,
      );
    }
  } catch (error) {
    if (
      profilesCommittedByRecovery
      && profilesFileHash(root) === receipt.appliedProfilesSha256
    ) {
      try {
        linkSync(profilesPath, stagedProfiles);
      } catch (linkError) {
        if (
          linkError?.code !== "EEXIST"
          || !exactRegularFileBytes(stagedProfiles, profilesBytes)
        ) {
          throw linkError;
        }
      }
      rmSync(profilesPath);
    }
    throw error;
  }
  rmSync(transactionRoot, { recursive: true });
  return receipt;
}

export function detectProfilesV2({
  workspaceRoot,
  projectToolResolver,
} = {}) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  const manifest = readWorkspaceJsonBounded(root, "package.json");
  const discovered = discoverWorkspaces(root, manifest);
  const toolBinding = resolveProjectTool(root, manifest, projectToolResolver);
  const rawCandidates = profileCandidates(
    root,
    manifest,
    toolBinding.executable,
    discovered.workspaces,
    toolBinding.packageManager,
    true,
  );
  const candidates = bindCommandsToProjectTool(rawCandidates, toolBinding);
  let inputManifest = [];
  const issueCodes = [
    ...toolBinding.issueCodes,
    ...discovered.warnings,
  ];
  try {
    inputManifest = detectedInputManifest(root, discovered.workspaces, toolBinding);
  } catch (error) {
    issueCodes.push(error instanceof Error ? error.message : String(error));
  }
  const proposedProfiles = proposedProfileDocument(candidates, inputManifest);
  issueCodes.push(...validateProfileDocument(proposedProfiles));
  const qualityIssues = [...new Set(issueCodes)].sort();
  const confidence = qualityIssues.length === 0 && toolBinding.confidence === "high"
    ? "high"
    : "review_required";
  const currentProfilesSha256 = profilesFileHash(root);
  const applyStatus = currentProfilesSha256 !== null
    ? "profiles_already_exists"
    : confidence === "high"
      ? "ready_to_apply"
      : "review_required";
  const body = {
    schemaVersion: "OwlCodaRunKitProfileDetectionV2",
    status: "profiles_detected",
    dryRun: true,
    writesPerformed: 0,
    confidence,
    applyStatus,
    issueCodes: qualityIssues,
    proposedProfiles,
    candidates,
    primaryProfileId: proposedProfiles.profiles.find(profile => profile.primary)?.id ?? null,
    inputManifest,
    toolBinding: {
      status: toolBinding.status,
      confidence: toolBinding.confidence,
      source: toolBinding.source,
      packageManager: toolBinding.packageManager,
      executable: toolBinding.executable,
      argvPrefix: [...toolBinding.argvPrefix],
      version: toolBinding.version,
      executableSha256: toolBinding.executableSha256,
      launcherSha256: toolBinding.launcherSha256,
    },
    currentProfilesSha256,
    detectedScripts: detectedScripts(manifest),
    detectedWorkspaces: discovered.workspaces,
    authorizationGranted: false,
  };
  return {
    ...body,
    detectionSha256: sha256(canonicalJson(body)),
  };
}

function blockedApply(detection, issueCodes, currentProfilesSha256 = null) {
  return {
    schemaVersion: "OwlCodaRunKitProfilesApplyReceiptV1",
    status: "profiles_apply_blocked",
    writesPerformed: 0,
    detectionSha256: detection?.detectionSha256 ?? null,
    currentProfilesSha256,
    issueCodes: [...new Set(issueCodes)].sort(),
    authorizationGranted: false,
  };
}

function verifyDetectionInputs(root, detection) {
  const issues = [];
  const { detectionSha256, ...body } = detection;
  if (
    detection.schemaVersion !== "OwlCodaRunKitProfileDetectionV2"
    || detection.status !== "profiles_detected"
    || !/^[a-f0-9]{64}$/.test(detectionSha256 ?? "")
    || sha256(canonicalJson(body)) !== detectionSha256
  ) {
    issues.push("profile_detection_invalid");
  }
  if (detection.confidence !== "high" || detection.applyStatus !== "ready_to_apply") {
    issues.push("profile_detection_not_ready_to_apply");
  }
  issues.push(...validateProfileDocument(detection.proposedProfiles));
  const executable = regularExecutable(detection.toolBinding?.executable);
  const launcher = regularExecutable(detection.toolBinding?.argvPrefix?.[0]);
  if (
    !executable
    || !launcher
    || sha256(readFileSync(executable)) !== detection.toolBinding.executableSha256
    || sha256(readFileSync(launcher)) !== detection.toolBinding.launcherSha256
  ) {
    issues.push("profile_detection_tool_drift");
  }
  if (!Array.isArray(detection.inputManifest)) {
    issues.push("profile_detection_invalid");
  } else {
    for (const entry of detection.inputManifest) {
      try {
        const actual = sha256(readFileSync(boundedRegularFile(root, entry.path)));
        if (actual !== entry.sha256) issues.push(`profile_detection_input_drift:${entry.path}`);
      } catch {
        issues.push(`profile_detection_input_unavailable:${entry.path}`);
      }
    }
  }
  return [...new Set(issues)].sort();
}

export function applyDetectedProfilesV2({
  workspaceRoot,
  detection,
} = {}) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  let currentProfilesSha256;
  try {
    currentProfilesSha256 = profilesFileHash(root);
  } catch {
    return blockedApply(detection, ["profile_apply_directory_untrusted"]);
  }
  const issues = verifyDetectionInputs(root, detection ?? {});
  if (issues.length > 0) return blockedApply(detection, issues);

  const receiptPath = path.join(
    ".owlcoda",
    "runkit",
    "profile-apply-receipts",
    `${detection.detectionSha256}.json`,
  );
  let runtimeRoot;
  let receiptRoot;
  try {
    runtimeRoot = ensureDirectoryChain(root, ".owlcoda/runkit");
    receiptRoot = ensureDirectoryChain(
      root,
      ".owlcoda/runkit/profile-apply-receipts",
    );
  } catch {
    return blockedApply(detection, ["profile_apply_directory_untrusted"]);
  }
  const profilesPath = path.join(runtimeRoot, "profiles.json");
  const receiptAbsolutePath = path.join(
    receiptRoot,
    `${detection.detectionSha256}.json`,
  );
  const profilesBytes = `${JSON.stringify(detection.proposedProfiles, null, 2)}\n`;
  const receipt = {
    schemaVersion: "OwlCodaRunKitProfilesApplyReceiptV1",
    status: "profiles_applied",
    writesPerformed: 2,
    detectionSha256: detection.detectionSha256,
    beforeProfilesSha256: null,
    appliedProfilesSha256: sha256(profilesBytes),
    receiptPath,
    issueCodes: [],
    authorizationGranted: false,
  };
  const receiptBytes = `${JSON.stringify(receipt, null, 2)}\n`;
  const transactionRoot = path.join(
    runtimeRoot,
    `.profile-apply-${detection.detectionSha256}.lock`,
  );
  if (existsSync(transactionRoot)) {
    try {
      return recoverProfileApplyTransaction({
        root,
        transactionRoot,
        profilesPath,
        profilesBytes,
        receiptAbsolutePath,
        receiptBytes,
        receipt,
      });
    } catch {
      return blockedApply(
        detection,
        ["profile_apply_transaction_recovery_invalid"],
        currentProfilesSha256,
      );
    }
  }
  if (currentProfilesSha256 !== null) {
    return blockedApply(detection, ["profiles_already_exists"], currentProfilesSha256);
  }
  try {
    mkdirSync(transactionRoot);
  } catch (error) {
    if (error?.code === "EEXIST") {
      return blockedApply(detection, ["profile_apply_transaction_active"]);
    }
    throw error;
  }
  let profilesCommitted = false;
  try {
    const current = profilesFileHash(root);
    if (current !== null) {
      return blockedApply(detection, ["profiles_already_exists"], current);
    }
    if (existsSync(receiptAbsolutePath)) {
      return blockedApply(detection, ["profile_apply_receipt_already_exists"]);
    }
    const stagedProfiles = path.join(transactionRoot, "profiles.json");
    const stagedReceipt = path.join(transactionRoot, "receipt.json");
    writeFileSync(stagedProfiles, profilesBytes, { flag: "wx" });
    writeFileSync(stagedReceipt, receiptBytes, { flag: "wx" });
    commitCreateOnlyStagedFile(stagedProfiles, profilesPath, profilesBytes);
    profilesCommitted = true;
    commitCreateOnlyStagedFile(
      stagedReceipt,
      receiptAbsolutePath,
      receiptBytes,
    );
    return receipt;
  } catch {
    if (
      profilesCommitted
      && existsSync(profilesPath)
      && profilesFileHash(root) === receipt.appliedProfilesSha256
    ) {
      rmSync(profilesPath);
    }
    return blockedApply(detection, ["profile_apply_transaction_failed"]);
  } finally {
    rmSync(transactionRoot, { recursive: true, force: true });
  }
}

function exactKeys(value, allowed) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function representativePath(rule) {
  return rule.endsWith("/**")
    ? `${rule.slice(0, -3)}/__owlrunkit_profile_surface__`
    : rule;
}

function validateProfileDocument(config) {
  const issues = [];
  if (
    !exactKeys(config, ["schemaVersion", "profiles"])
    || config.schemaVersion !== "OwlCodaRunKitProfilesV1"
    || !Array.isArray(config.profiles)
    || config.profiles.length === 0
  ) {
    return ["profiles_document_invalid"];
  }

  const ids = new Set();
  const commandIds = new Set();
  for (const profile of config.profiles) {
    if (!exactKeys(profile, [
      "commands",
      "id",
      "paths",
      "primary",
      "requiresProfileIds",
      "role",
    ])) {
      issues.push("profile_shape_invalid");
      continue;
    }
    if (typeof profile.id !== "string" || profile.id.length === 0) {
      issues.push("profile_id_invalid");
    } else if (ids.has(profile.id)) {
      issues.push(`duplicate_profile_id:${profile.id}`);
    } else {
      ids.add(profile.id);
    }
    if (!Array.isArray(profile.paths) || profile.paths.length === 0) {
      issues.push(`profile_paths_missing:${profile.id ?? "unknown"}`);
    }
    if (profile.role !== undefined && !["primary", "supporting"].includes(profile.role)) {
      issues.push(`profile_role_invalid:${profile.id ?? "unknown"}`);
    }
    if (profile.primary !== undefined && typeof profile.primary !== "boolean") {
      issues.push(`profile_primary_invalid:${profile.id ?? "unknown"}`);
    }
    if (
      profile.requiresProfileIds !== undefined
      && (
        !Array.isArray(profile.requiresProfileIds)
        || profile.requiresProfileIds.some((id) => typeof id !== "string" || id.length === 0)
        || new Set(profile.requiresProfileIds).size !== profile.requiresProfileIds.length
      )
    ) {
      issues.push(`profile_requirements_invalid:${profile.id ?? "unknown"}`);
    }
    if (profile.commands !== undefined) {
      if (!Array.isArray(profile.commands)) {
        issues.push(`profile_commands_invalid:${profile.id ?? "unknown"}`);
      } else {
        for (const entry of profile.commands) {
          if (
            !exactKeys(entry, ["argv", "cwd", "executable", "id"])
            || typeof entry.id !== "string"
            || entry.id.length === 0
            || typeof entry.cwd !== "string"
            || entry.cwd.length === 0
            || typeof entry.executable !== "string"
            || entry.executable.length === 0
            || !Array.isArray(entry.argv)
            || entry.argv.some((argument) => typeof argument !== "string" || argument.length === 0)
          ) {
            issues.push(`profile_command_invalid:${profile.id ?? "unknown"}`);
            break;
          }
          try {
            safeIdentifier(entry.id, "profile command id");
          } catch {
            issues.push(`profile_command_id_invalid:${profile.id}:${entry.id}`);
          }
          try {
            safeRelativePath(entry.cwd, "profile command cwd", { allowDot: true });
          } catch {
            issues.push(`profile_command_cwd_invalid:${profile.id}:${entry.id}`);
          }
          if (commandIds.has(entry.id)) {
            issues.push(`duplicate_profile_command_id:${entry.id}`);
          } else {
            commandIds.add(entry.id);
          }
        }
      }
    }
  }
  if (issues.length > 0) return [...new Set(issues)].sort();

  try {
    const changedPaths = config.profiles.flatMap((profile) =>
      profile.paths.map(representativePath));
    resolveProfileImpactDetailed({ changedPaths, profiles: config.profiles });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  for (const profile of config.profiles) {
    for (const requiredId of profile.requiresProfileIds ?? []) {
      if (!ids.has(requiredId)) {
        issues.push(`required_profile_missing:${profile.id}:${requiredId}`);
      }
    }
  }
  const actionable = config.profiles.filter((profile) =>
    (profile.role ?? "primary") === "primary"
    && Array.isArray(profile.commands)
    && profile.commands.length > 0);
  if (actionable.length === 0) issues.push("actionable_primary_profile_missing");
  const explicitPrimaryIds = actionable
    .filter((profile) => profile.primary === true)
    .map((profile) => profile.id)
    .sort();
  if (explicitPrimaryIds.length > 1) {
    issues.push(`ambiguous_primary_profile:${explicitPrimaryIds.join(",")}`);
  } else if (explicitPrimaryIds.length === 0 && actionable.length > 1) {
    issues.push(`ambiguous_primary_profile:${actionable.map((profile) => profile.id).sort().join(",")}`);
  }
  return [...new Set(issues)].sort();
}

export function validateProfiles({ workspaceRoot } = {}) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  const issues = [];
  let profileIds = [];
  try {
    const config = readWorkspaceJsonBounded(
      root,
      path.join(".owlcoda", "runkit", "profiles.json"),
    );
    profileIds = Array.isArray(config.profiles)
      ? config.profiles
        .map((profile) => profile?.id)
        .filter((id) => typeof id === "string")
        .sort()
      : [];
    issues.push(...validateProfileDocument(config));
    if (issues.length === 0) {
      const detected = detectProfiles({ workspaceRoot: root });
      const detectedPaths = detected.candidates.flatMap((profile) =>
        profile.paths.map(representativePath));
      if (detectedPaths.length > 0) {
        const impact = resolveProfileImpactDetailed({
          changedPaths: detectedPaths,
          profiles: config.profiles,
        });
        issues.push(...impact.uncoveredPaths.map((value) =>
          `uncovered_detected_surface:${value}`));
        issues.push(...impact.warnings
          .filter((warning) => warning.startsWith("supporting_only_match:"))
          .map((warning) => `detected_surface_${warning}`));
      }
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const valid = issues.length === 0;
  return {
    schemaVersion: "OwlCodaRunKitProfilesValidationV1",
    status: valid ? "valid" : "invalid",
    valid,
    exitCode: valid ? 0 : 2,
    profileIds,
    issues: [...new Set(issues)].sort(),
    authorizationGranted: false,
  };
}

export function resolveProfilesImpact({ workspaceRoot, changedPaths } = {}) {
  const root = resolveBoundedWorkspaceRoot(workspaceRoot);
  const config = readWorkspaceJsonBounded(
    root,
    path.join(".owlcoda", "runkit", "profiles.json"),
  );
  const documentIssues = validateProfileDocument(config);
  if (documentIssues.length > 0) {
    return {
      schemaVersion: "OwlCodaRunKitProfileImpactV1",
      status: "profile_impact_blocked",
      valid: false,
      exitCode: 2,
      changedPaths: [...new Set(changedPaths)].sort(),
      decision: "invalid_profiles",
      primaryProfileId: null,
      directProfileIds: [],
      transitiveProfileIds: [],
      supportingProfileIds: [],
      selectedProfileIds: [],
      uncoveredPaths: [],
      warnings: [],
      issues: documentIssues,
      authorizationGranted: false,
    };
  }
  const impact = resolveProfileImpactDetailed({
    changedPaths,
    profiles: config.profiles,
  });
  const issues = [
    ...impact.uncoveredPaths.map((value) => `uncovered_changed_path:${value}`),
    ...impact.warnings.filter((warning) =>
      warning.startsWith("supporting_only_match:")
      || warning.startsWith("ambiguous_primary_profile:")),
  ];
  const valid = impact.decision === "targeted_profiles" && issues.length === 0;
  return {
    schemaVersion: "OwlCodaRunKitProfileImpactV1",
    status: valid ? "profile_impact_resolved" : "profile_impact_blocked",
    valid,
    exitCode: valid ? 0 : 2,
    changedPaths: [...new Set(changedPaths)].sort(),
    ...impact,
    issues: [...new Set(issues)].sort(),
    authorizationGranted: false,
  };
}
