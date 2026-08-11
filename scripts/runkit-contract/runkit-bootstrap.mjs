#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveProjectCli } from "./project-cli-resolver.mjs";

const CURRENT_PACKAGE_COMMANDS = new Set([
  "adopt",
  "core-successor",
  "fleet",
  "init",
]);

function comparablePath(value) {
  const resolved = path.resolve(value);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function workspaceFromArgv(argv, cwd) {
  const index = argv.indexOf("--workspace");
  if (index < 0) return path.resolve(cwd);
  const value = argv[index + 1];
  if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
    return null;
  }
  return path.resolve(cwd, value);
}

export function selectProjectCliInvocationV1({
  argv,
  cwd = process.cwd(),
  selfCliPath = fileURLToPath(import.meta.url),
} = {}) {
  if (!Array.isArray(argv)) throw new Error("argv is required.");
  const workspaceRoot = workspaceFromArgv(argv, cwd);
  const separatorIndex = argv.indexOf("--");
  const runkitArgv = separatorIndex < 0
    ? argv
    : argv.slice(0, separatorIndex);
  if (
    workspaceRoot === null
    || argv.length === 0
    || runkitArgv.includes("--help")
    || runkitArgv.includes("-h")
    || argv[0] === "--version"
    || argv[0] === "-v"
    || CURRENT_PACKAGE_COMMANDS.has(argv[0])
  ) {
    return {
      mode: "current_package",
      workspaceRoot,
      commandArgv: null,
      binding: null,
    };
  }
  const binding = resolveProjectCli({ workspaceRoot });
  if (
    binding.status === "bound"
    && comparablePath(binding.cliPath) !== comparablePath(selfCliPath)
  ) {
    return {
      mode: "project_local",
      workspaceRoot,
      commandArgv: [...binding.argvPrefix, ...argv],
      binding,
    };
  }
  if (binding.status !== "bound") {
    return {
      mode: "project_local_blocked",
      workspaceRoot,
      commandArgv: null,
      binding,
    };
  }
  return {
    mode: "current_package",
    workspaceRoot,
    commandArgv: null,
    binding,
  };
}

export function runBootstrapV1({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  selfCliPath = fileURLToPath(import.meta.url),
  spawn = spawnSync,
} = {}) {
  const selected = selectProjectCliInvocationV1({
    argv,
    cwd,
    selfCliPath,
  });
  if (selected.mode === "project_local_blocked") {
    throw new Error([
      `project_local_cli_unavailable:${selected.binding.issueCodes.join(",")}.`,
      "The current/global package did not execute this project command.",
      "Repair the exact dependency, lockfile, and local install binding,",
      `or use the bootstrap recovery path: owlrunkit init --workspace ${selected.workspaceRoot}`,
    ].join(" "));
  }
  const commandArgv = selected.commandArgv ?? [
    process.execPath,
    path.join(path.dirname(selfCliPath), "runkit-cli.mjs"),
    ...argv,
  ];
  const completed = spawn(commandArgv[0], commandArgv.slice(1), {
    cwd,
    env: process.env,
    stdio: "inherit",
  });
  if (completed.error) throw completed.error;
  return Number.isInteger(completed.status) ? completed.status : 1;
}

const direct = comparablePath(process.argv[1] ?? "") === comparablePath(fileURLToPath(import.meta.url));
if (direct) {
  try {
    process.exitCode = runBootstrapV1();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
