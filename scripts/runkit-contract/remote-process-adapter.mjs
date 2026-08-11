import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { REMOTE_DEPLOYMENT_STAGES } from "./remote-deployment.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SAFE_ENV_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SSH_AUTH_SOCK",
  "SystemRoot",
  "TMPDIR",
  "USER",
  "WINDIR",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function constrainedEnvironment() {
  return Object.fromEntries(
    SAFE_ENV_KEYS
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
}

function validateIdentity(identity) {
  if (
    identity === null
    || typeof identity !== "object"
    || Array.isArray(identity)
    || Object.keys(identity).some((key) => ![
      "adapterId",
      "executable",
      "sha256",
      "version",
    ].includes(key))
    || !IDENTIFIER.test(identity.adapterId ?? "")
    || typeof identity.version !== "string"
    || identity.version.length === 0
    || typeof identity.executable !== "string"
    || !path.isAbsolute(identity.executable)
    || !SHA256.test(identity.sha256 ?? "")
  ) {
    throw new Error("Remote process adapter identity is invalid.");
  }
  const stat = lstatSync(identity.executable);
  const executable = realpathSync(identity.executable);
  const resolvedStat = lstatSync(executable);
  if (
    stat.isSymbolicLink()
    || !stat.isFile()
    || resolvedStat.isSymbolicLink()
    || !resolvedStat.isFile()
  ) {
    throw new Error("Remote process adapter executable must be a regular file.");
  }
  return {
    ...structuredClone(identity),
    executable,
  };
}

function validateWorkspaceRoot(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new Error("Remote process adapter workspaceRoot is required.");
  }
  const requested = path.resolve(workspaceRoot);
  const stat = lstatSync(requested);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
  ) {
    throw new Error("Remote process adapter workspaceRoot must be a real directory.");
  }
  return realpathSync(requested);
}

function failure(failureCode, evidence) {
  return {
    status: "failed",
    failureCode,
    evidenceSha256: sha256(evidence),
  };
}

function indeterminate(failureCode, evidence) {
  return {
    ...failure(failureCode, evidence),
    status: "indeterminate",
  };
}

export function createRemoteProcessAdapterV1({
  identity,
  workspaceRoot,
  timeoutMs = 600_000,
  maxOutputBytes = 1_048_576,
  spawn = spawnSync,
} = {}) {
  const normalizedIdentity = validateIdentity(identity);
  const normalizedWorkspaceRoot = validateWorkspaceRoot(workspaceRoot);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) {
    throw new Error("Remote process adapter timeoutMs is invalid.");
  }
  if (
    !Number.isSafeInteger(maxOutputBytes)
    || maxOutputBytes < 1_024
    || maxOutputBytes > 16_777_216
  ) {
    throw new Error("Remote process adapter maxOutputBytes is invalid.");
  }
  return {
    identity: normalizedIdentity,
    async runStage(input) {
      if (!REMOTE_DEPLOYMENT_STAGES.includes(input?.stage)) {
        return failure("adapter_stage_invalid", JSON.stringify(input ?? null));
      }
      const executableBytes = readFileSync(normalizedIdentity.executable);
      if (sha256(executableBytes) !== normalizedIdentity.sha256) {
        throw new Error("Remote process adapter executable hash mismatch.");
      }
      const completed = spawn(
        normalizedIdentity.executable,
        ["--owlrunkit-remote-stage", input.stage],
        {
          encoding: "utf8",
          cwd: normalizedWorkspaceRoot,
          env: constrainedEnvironment(),
          input: `${JSON.stringify(input)}\n`,
          maxBuffer: maxOutputBytes,
          timeout: timeoutMs,
          windowsHide: true,
        },
      );
      if (completed.error) {
        return indeterminate(
          completed.error.code === "ETIMEDOUT"
            ? "adapter_process_timeout"
            : "adapter_process_failed",
          String(completed.error),
        );
      }
      if (completed.status !== 0) {
        return indeterminate(
          `adapter_process_exit_${Number.isInteger(completed.status)
            ? completed.status
            : "unknown"}`,
          `${completed.stdout ?? ""}\n${completed.stderr ?? ""}`,
        );
      }
      try {
        const output = JSON.parse(completed.stdout);
        if (output === null || typeof output !== "object" || Array.isArray(output)) {
          throw new Error("adapter output is not an object");
        }
        return output;
      } catch {
        return indeterminate(
          "adapter_output_invalid",
          `${completed.stdout ?? ""}\n${completed.stderr ?? ""}`,
        );
      }
    },
  };
}
