import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

import { currentCoreIdentity } from "./core-contract.mjs";
import {
  closeQuickOutputFiles,
  createQuickReceiptStore,
  persistQuickReceipt,
} from "./quick-receipt.mjs";
import { captureWorkspaceSnapshot } from "./quick-workspace-snapshot.mjs";

function runExactCommand({ executable, argv, cwd, stdoutFd, stderrFd }) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(executable, argv, {
      cwd,
      shell: false,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: process.env,
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: null, signal: null, launchError: error.message });
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, launchError: null });
    });
  });
}

export async function runQuickVerification({ workspaceRoot, commandArgv }) {
  if (!Array.isArray(commandArgv) || commandArgv.length === 0 || !commandArgv.every((value) => typeof value === "string")) {
    return {
      status: "quick_verification_input_invalid",
      exitCode: 3,
      issues: ["An exact command is required after --."],
      authorizationGranted: false,
    };
  }
  let root;
  try {
    root = realpathSync(workspaceRoot);
  } catch {
    return {
      status: "quick_verification_input_invalid",
      exitCode: 3,
      issues: ["Workspace does not exist."],
      authorizationGranted: false,
    };
  }

  let workspaceBefore;
  let store;
  try {
    workspaceBefore = captureWorkspaceSnapshot(root);
    store = createQuickReceiptStore(root);
  } catch (error) {
    return {
      status: "quick_verification_input_invalid",
      exitCode: 3,
      issues: [error instanceof Error ? error.message : String(error)],
      authorizationGranted: false,
    };
  }

  const [executable, ...argv] = commandArgv;
  const startedAt = new Date().toISOString();
  const execution = await runExactCommand({
    executable,
    argv,
    cwd: root,
    stdoutFd: store.stdoutFd,
    stderrFd: store.stderrFd,
  });
  closeQuickOutputFiles(store);
  const finishedAt = new Date().toISOString();

  let workspaceAfter;
  try {
    workspaceAfter = captureWorkspaceSnapshot(root);
  } catch (error) {
    return {
      status: "quick_verification_source_mutated",
      exitCode: 2,
      receiptPath: null,
      receiptSha256: null,
      issues: [error instanceof Error ? error.message : String(error)],
      authorizationGranted: false,
    };
  }

  const sourceMutated = workspaceBefore.sourceFingerprint !== workspaceAfter.sourceFingerprint;
  const issueCodes = ["quick_ignored_artifact_unbound"];
  if (sourceMutated) issueCodes.push("source_mutated_during_verification");
  let persisted;
  try {
    persisted = persistQuickReceipt({
      workspaceRoot: root,
      store,
      receipt: {
      schemaVersion: "OwlCodaQuickVerificationReceiptV1",
      receiptId: store.receiptId,
      assurance: "captured_verification",
      authorizationGranted: false,
      coreIdentity: {
        contractVersion: currentCoreIdentity().contractVersion,
        coreVersion: currentCoreIdentity().coreVersion,
        coreManifestSha256: currentCoreIdentity().coreManifestSha256,
      },
      workspaceBefore,
      exactCommand: {
        executable,
        argv,
        cwd: root,
      },
      verificationContext: {
        platform: process.platform,
        architecture: process.arch,
        runtime: process.version,
      },
      startedAt,
      finishedAt,
      exitResult: {
        exitCode: execution.exitCode,
        signal: execution.signal,
      },
      workspaceAfter,
      mutationDecision: sourceMutated
        ? "invalidated_by_command_source_mutation"
        : "source_unchanged",
        issueCodes,
      },
    });
  } catch (error) {
    return {
      status: "quick_verification_control_invalid",
      exitCode: 1,
      receiptPath: null,
      receiptSha256: null,
      sourceFingerprint: workspaceAfter.sourceFingerprint,
      commandExitCode: execution.exitCode,
      mutationDecision: sourceMutated
        ? "invalidated_by_command_source_mutation"
        : "source_unchanged",
      issueCodes: [...issueCodes, "quick_receipt_store_invalid"],
      issues: [error instanceof Error ? error.message : String(error)],
      nextAllowedAction: "repair_quick_receipt_store_and_rerun",
      authorizationGranted: false,
    };
  }

  if (sourceMutated) {
    return {
      status: "quick_verification_source_mutated",
      exitCode: 2,
      receiptPath: persisted.receiptPath,
      receiptSha256: persisted.receiptSha256,
      sourceFingerprint: workspaceAfter.sourceFingerprint,
      commandExitCode: execution.exitCode,
      mutationDecision: "invalidated_by_command_source_mutation",
      issueCodes,
      attestCommand: `owlcoda attest ${persisted.receiptPath}`,
      issues: [],
      nextAllowedAction: "restore_source_or_run_a_new_quick_verification",
      authorizationGranted: false,
    };
  }
  if (execution.launchError || execution.exitCode !== 0) {
    return {
      status: "quick_verification_failed",
      exitCode: 1,
      receiptPath: persisted.receiptPath,
      receiptSha256: persisted.receiptSha256,
      sourceFingerprint: workspaceAfter.sourceFingerprint,
      commandExitCode: execution.exitCode,
      mutationDecision: "source_unchanged",
      issueCodes,
      attestCommand: `owlcoda attest ${persisted.receiptPath}`,
      issues: execution.launchError ? [execution.launchError] : [],
      nextAllowedAction: "inspect_output_and_rerun",
      authorizationGranted: false,
    };
  }
  return {
    status: "quick_verification_passed",
    exitCode: 0,
    receiptPath: persisted.receiptPath,
    receiptSha256: persisted.receiptSha256,
    sourceFingerprint: workspaceAfter.sourceFingerprint,
    commandExitCode: 0,
    mutationDecision: "source_unchanged",
    issueCodes,
    attestCommand: `owlcoda attest ${persisted.receiptPath}`,
    issues: [],
    nextAllowedAction: `owlcoda attest ${persisted.receiptPath}`,
    authorizationGranted: false,
  };
}
