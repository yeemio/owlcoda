import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  acceptedCloseoutVerificationIssues,
  validateCoreArtifact,
} from "./core-contract.mjs";
import { runFinalize } from "./finalize.mjs";
import { derivedVerificationContext } from "./lifecycle-orchestration.mjs";
import { withControlTransaction } from "./lease-lifecycle.mjs";
import {
  loadActiveExecution,
  readJson,
  relativeToWorkspace,
  safeIdentifier,
  safeRelativePath,
  sha256,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";
import {
  runSnapshot,
  verifySnapshotEvidence,
} from "./snapshot.mjs";
import {
  freezeSourceCandidateWithinControlTransactionV2,
  verifySourceCandidateV2,
} from "./source-candidate.mjs";
import { validateReceiptLineage } from "./receipt-lineage.mjs";
import { verificationContextFingerprint } from "./verification-context.mjs";
import {
  runVerificationEnvelopeV1,
  validateVerificationEnvelopeV1,
  verifyVerificationEnvelopeReceiptV1,
} from "./verification-envelope.mjs";

const VERIFICATION_ENVELOPE_CHECKER = fileURLToPath(new URL(
  "./verification-envelope-check.mjs",
  import.meta.url,
));

const FORBIDDEN_EXTERNAL_TOOLS = new Set([
  "curl",
  "ftp",
  "nc",
  "ncat",
  "rsync",
  "scp",
  "sftp",
  "ssh",
  "wget",
]);
const FORBIDDEN_WRAPPERS = new Set([
  "bash",
  "cmd",
  "env",
  "fish",
  "osascript",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);
const FORBIDDEN_GIT_ACTIONS = new Set([
  "add",
  "checkout",
  "clean",
  "commit",
  "merge",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "switch",
  "tag",
]);
const FORBIDDEN_PACKAGE_ACTIONS = new Set([
  "add",
  "deprecate",
  "dist-tag",
  "install",
  "login",
  "logout",
  "owner",
  "publish",
  "remove",
  "uninstall",
  "unpublish",
  "update",
  "version",
]);
const LEGACY_FORBIDDEN_GIT_ACTIONS = new Set(["push", "tag"]);
const LEGACY_FORBIDDEN_PACKAGE_ACTIONS = new Set(["publish", "unpublish"]);
const KNOWN_DEPLOYMENT_TOOLS = new Set([
  "firebase",
  "flyctl",
  "netlify",
  "vercel",
  "wrangler",
]);
const PACKAGE_TOOLS = new Set(["bun", "npm", "npx", "pnpm", "yarn"]);

function checkRoot(executionRoot) {
  return path.join(executionRoot, "formal-checks");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Formal artifact is not canonical JSON.");
  }
  return encoded;
}

function readRegularJson(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  if (realpathSync(filePath) !== path.resolve(filePath)) {
    throw new Error(`${label} must not traverse a symlink.`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeOrResumeExactJson(filePath, value, label) {
  if (!existsSync(filePath)) {
    writeJsonExclusiveAtomically(filePath, value);
    return { value, resumed: false };
  }
  const existing = readRegularJson(filePath, label);
  if (canonicalJson(existing) !== canonicalJson(value)) {
    throw new Error(`Existing ${label} differs from the resumed command.`);
  }
  return { value: existing, resumed: true };
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

function regularExecutable(executable) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw new Error("Formal check executable must be an absolute path.");
  }
  const stat = lstatSync(executable);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("Formal check executable must be a regular file, not a symlink.");
  }
  return realpathSync(executable);
}

function executableName(executable) {
  return path.basename(executable)
    .toLowerCase()
    .replace(/\.(?:cmd|exe)$/u, "");
}

function effectiveTool(executable, argv) {
  const direct = executableName(executable);
  if (
    direct === "node"
    && typeof argv[0] === "string"
    && /^(?:npm-cli|pnpm|yarn)(?:\.[cm]?js)?$/u.test(
      path.basename(argv[0]).toLowerCase(),
    )
  ) {
    const launcher = path.basename(argv[0]).toLowerCase();
    return {
      name: launcher.startsWith("npm")
        ? "npm"
        : launcher.startsWith("pnpm")
          ? "pnpm"
          : "yarn",
      argv: argv.slice(1),
    };
  }
  return { name: direct, argv };
}

function forbiddenFormalCommand(executable, argv) {
  const externalSideEffect = forbiddenLegacyVerificationSideEffect(
    executable,
    argv,
  );
  if (externalSideEffect) return externalSideEffect;
  const tool = effectiveTool(executable, argv);
  if (FORBIDDEN_WRAPPERS.has(tool.name)) return tool.name;
  if (tool.name === "node" && tool.argv.some((argument) =>
    new Set(["-e", "--eval", "-p", "--print"]).has(argument))) {
    return "node-inline-code";
  }
  const action = tool.argv
    .map((argument) => argument.toLowerCase())
    .find((argument) => (
      tool.name === "git"
        ? FORBIDDEN_GIT_ACTIONS.has(argument)
        : FORBIDDEN_PACKAGE_ACTIONS.has(argument)
    ));
  if (tool.name === "git" && action) {
    return `git-${action}`;
  }
  if (
    new Set(["npm", "pnpm", "yarn", "bun"]).has(tool.name)
    && action
  ) {
    return `${tool.name}-${action}`;
  }
  return null;
}

function forbiddenLegacyVerificationSideEffect(executable, argv) {
  const tool = effectiveTool(executable, argv);
  if (FORBIDDEN_EXTERNAL_TOOLS.has(tool.name)) return tool.name;
  const lowered = tool.argv.map((argument) => argument.toLowerCase());
  const gitAction = lowered.find((argument) =>
    LEGACY_FORBIDDEN_GIT_ACTIONS.has(argument));
  if (tool.name === "git" && gitAction) return `git-${gitAction}`;
  const packageAction = lowered.find((argument) =>
    LEGACY_FORBIDDEN_PACKAGE_ACTIONS.has(argument));
  if (PACKAGE_TOOLS.has(tool.name) && packageAction) {
    return `${tool.name}-${packageAction}`;
  }
  const deploymentAction = lowered.find((argument) =>
    argument === "deploy" || argument === "publish");
  if (
    deploymentAction
    && (PACKAGE_TOOLS.has(tool.name) || KNOWN_DEPLOYMENT_TOOLS.has(tool.name))
  ) {
    return `${tool.name}-${deploymentAction}`;
  }
  if (tool.name === "deploy" || tool.name === "publish") return tool.name;
  return null;
}

function safeNodeSyntaxCheck({ workspaceRoot, cwd, executable, argv }) {
  if (
    executable !== realpathSync(process.execPath)
    || argv.length !== 2
    || argv[0] !== "--check"
  ) return false;
  safeRelativePath(argv[1], "Formal Node syntax-check target");
  const cwdRoot = path.resolve(workspaceRoot, cwd);
  const targetPath = path.resolve(cwdRoot, argv[1]);
  if (!withinRoot(workspaceRoot, targetPath)) return false;
  const stat = lstatSync(targetPath);
  return !stat.isSymbolicLink()
    && stat.isFile()
    && realpathSync(targetPath) === targetPath;
}

export function validateFormalVerificationCommandV1({
  workspaceRoot,
  cwd = ".",
  commandArgv,
}) {
  safeRelativePath(cwd, "Formal check cwd", { allowDot: true });
  if (
    !Array.isArray(commandArgv)
    || commandArgv.length === 0
    || commandArgv.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("Formal check requires one exact command.");
  }
  const root = realpathSync(workspaceRoot);
  const [rawExecutable, ...argv] = commandArgv;
  const executable = regularExecutable(rawExecutable);
  const forbidden = forbiddenFormalCommand(executable, argv);
  if (forbidden) {
    throw new Error(
      `Formal verification-only policy forbids external side-effect command: ${forbidden}.`,
    );
  }
  if (safeNodeSyntaxCheck({
    workspaceRoot: root,
    cwd,
    executable,
    argv,
  })) {
    return {
      schemaVersion: "OwlCodaRunKitFormalVerificationCommandPolicyV1",
      mode: "built_in_safe_verification",
      riskClassification: "built_in_read_only_verification",
      profileCommandIds: [],
      executable,
      argv,
      authorizationGranted: false,
    };
  }
  throw new Error(
    "Formal accepted evidence only admits built-in safe verification; "
    + "profile, package, wrapper, and custom commands lack an enforced "
    + "workspace-write and network sandbox.",
  );
}

export function validateLegacyVerificationSideEffectsV1({ commandArgv }) {
  if (
    !Array.isArray(commandArgv)
    || commandArgv.length === 0
    || commandArgv.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("Legacy verification requires one exact command.");
  }
  const [executable, ...argv] = commandArgv;
  const forbidden = forbiddenLegacyVerificationSideEffect(executable, argv);
  if (forbidden) {
    throw new Error(
      `Legacy verification command forbids external side effect: ${forbidden}.`,
    );
  }
  return {
    schemaVersion: "OwlCodaRunKitLegacyVerificationSideEffectPolicyV1",
    mode: "known_high_risk_side_effect_deny",
    forbidden: false,
    authorizationGranted: false,
  };
}

function readChecks(executionRoot) {
  const root = checkRoot(executionRoot);
  if (!existsSync(root)) return [];
  const stat = lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("Formal checks root must be a regular directory.");
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error(`Formal check must be a regular file: ${entry.name}`);
      }
      const value = readJson(path.join(root, entry.name));
      if (
        value.schemaVersion !== "OwlCodaRunKitFormalCheckV1"
        || !Number.isSafeInteger(value.sequence)
        || value.sequence < 1
      ) {
        throw new Error(`Formal check contract is invalid: ${entry.name}`);
      }
      return value;
    })
    .sort((left, right) => left.sequence - right.sequence);
}

function resumeOrFreezeCandidate({
  workspaceRoot,
  executionRoot,
  runId,
  workItemId,
  checkId,
}) {
  const candidatePath = path.join(
    executionRoot,
    "source-candidates",
    `${checkId}.json`,
  );
  if (!existsSync(candidatePath)) {
    return {
      candidate: freezeSourceCandidateWithinControlTransactionV2({
        workspaceRoot,
        runId,
        workItemId,
        candidateId: checkId,
      }),
      resumed: false,
    };
  }
  const candidateDocument = readRegularJson(
    candidatePath,
    "Formal source candidate",
  );
  const candidateRelativePath = relativeToWorkspace(
    workspaceRoot,
    candidatePath,
  );
  const gate = verifySourceCandidateV2({
    workspaceRoot,
    candidatePath: candidateRelativePath,
  });
  if (
    gate.status !== "valid"
    || candidateDocument.runId !== runId
    || candidateDocument.candidateId !== checkId
    || candidateDocument.discovery?.fromLease !== workItemId
  ) {
    throw new Error(
      `Existing Formal source candidate differs from the resumed command: ${checkId}`,
    );
  }
  return {
    candidate: {
      status: "source_candidate_frozen",
      exitCode: 0,
      runId,
      candidateId: checkId,
      candidatePath: candidateRelativePath,
      candidateSha256: candidateDocument.candidateSha256,
      sourceFingerprint: candidateDocument.sourceFingerprint.sha256,
      manifestEntryCount: candidateDocument.sourceManifest.entries.length,
      payloadSha256: candidateDocument.payload.sha256,
      ownedPaths: [...candidateDocument.sourceManifest.ownedPaths],
      authorizationGranted: false,
    },
    resumed: true,
  };
}

function resumeSnapshot({
  workspaceRoot,
  executionRoot,
  runId,
  request,
  candidateDocument,
}) {
  const snapshotPath = path.join(
    executionRoot,
    "snapshots",
    `${request.snapshotId}.json`,
  );
  const evidenceRoot = path.join(executionRoot, "snapshot-evidence");
  const stdoutPath = path.join(evidenceRoot, `${request.snapshotId}.stdout`);
  const stderrPath = path.join(evidenceRoot, `${request.snapshotId}.stderr`);
  if (!existsSync(snapshotPath)) {
    if (existsSync(stdoutPath) || existsSync(stderrPath)) {
      throw new Error(
        "Incomplete Formal snapshot evidence requires a new check id.",
      );
    }
    return {
      snapshot: runSnapshot({ workspaceRoot, runId, request }),
      resumed: false,
    };
  }
  const snapshot = readRegularJson(snapshotPath, "Formal snapshot");
  const expectedFiles = Object.fromEntries(
    candidateDocument.sourceManifest.entries
      .filter(entry => entry.operation !== "deleted")
      .map(entry => [entry.path, entry.sha256])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const expectedInputs = Object.entries(expectedFiles)
    .map(([id, hash]) => ({ id, sha256: hash }));
  const evidence = verifySnapshotEvidence({
    workspaceRoot,
    runId,
    snapshot,
  });
  if (
    !evidence.valid
    || snapshot.snapshotId !== request.snapshotId
    || snapshot.targetRoot !== request.targetRoot
    || snapshot.verificationContextFingerprint
      !== verificationContextFingerprint(request.verificationContext)
    || snapshot.repositoryBefore?.head !== candidateDocument.baseline.head
    || snapshot.repositoryAfter?.head !== candidateDocument.baseline.head
    || canonicalJson(snapshot.repositoryBefore?.selectedFiles)
      !== canonicalJson(expectedFiles)
    || canonicalJson(snapshot.repositoryAfter?.selectedFiles)
      !== canonicalJson(expectedFiles)
    || snapshot.command?.evidence?.cwd !== request.cwd
    || canonicalJson(snapshot.command?.evidence?.argv)
      !== canonicalJson([request.executable, ...request.argv])
    || canonicalJson(snapshot.command?.evidence?.materialInputs)
      !== canonicalJson(expectedInputs)
  ) {
    throw new Error(
      `Existing Formal snapshot differs from the resumed command: ${request.snapshotId}`,
    );
  }
  return {
    snapshot: {
      status: snapshot.status,
      exitCode: snapshot.status === "snapshot_passed" ? 0 : 2,
      runId,
      snapshotPath: relativeToWorkspace(workspaceRoot, snapshotPath),
      authorizationGranted: false,
    },
    resumed: true,
  };
}

function recordFormalCheckWithinControlTransaction({
  workspaceRoot,
  runId,
  workItemId,
  checkId,
  cwd = ".",
  commandArgv,
  hooks = {},
}) {
  safeIdentifier(checkId, "checkId");
  safeRelativePath(cwd, "Formal check cwd", { allowDot: true });
  if (!Array.isArray(commandArgv) || commandArgv.length === 0) {
    throw new Error("Formal check requires one exact command.");
  }
  const root = realpathSync(workspaceRoot);
  const { executionRoot, pinGate } = loadActiveExecution(root, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const verificationCommandPolicy = validateFormalVerificationCommandV1({
    workspaceRoot: root,
    cwd,
    commandArgv,
  });
  const receiptPath = path.join(checkRoot(executionRoot), `${checkId}.json`);
  const candidateResult = resumeOrFreezeCandidate({
    workspaceRoot: root,
    executionRoot,
    runId,
    workItemId,
    checkId,
  });
  const candidate = candidateResult.candidate;
  if (candidate.status !== "source_candidate_frozen") return candidate;
  hooks.afterCandidatePersist?.();
  const candidateDocument = readJson(path.join(root, candidate.candidatePath));
  const context = derivedVerificationContext(root);
  const { executable, argv } = verificationCommandPolicy;
  const request = {
    schemaVersion: "OwlCodaRunKitSnapshotRequestV1",
    snapshotId: `${checkId}-snapshot`,
    mode: "project",
    targetRoot: root,
    cwd,
    executable,
    argv,
    launcherVersion: "owlrunkit-formal-check-v2",
    toolVersions: structuredClone(context.toolchains),
    selectedPaths: candidateDocument.sourceManifest.entries
      .filter((entry) => entry.operation !== "deleted")
      .map((entry) => entry.path)
      .sort(),
    statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
    verificationContext: context,
  };
  const requestPath = path.join(
    executionRoot,
    "formal-check-requests",
    `${checkId}.json`,
  );
  const requestResult = writeOrResumeExactJson(
    requestPath,
    request,
    "Formal check request",
  );
  hooks.afterRequestPersist?.();
  const snapshotResult = resumeSnapshot({
    workspaceRoot: root,
    executionRoot,
    runId,
    request: requestResult.value,
    candidateDocument,
  });
  const snapshot = snapshotResult.snapshot;
  hooks.afterSnapshotPersist?.();
  const savedSnapshot = readJson(path.join(root, snapshot.snapshotPath));
  const existingReceipt = existsSync(receiptPath)
    ? readRegularJson(receiptPath, "Formal check receipt")
    : null;
  const sequence = existingReceipt?.sequence
    ?? readChecks(executionRoot).length + 1;
  const status = snapshot.status === "snapshot_passed"
    ? "formal_check_passed"
    : "formal_check_failed";
  const receipt = {
    schemaVersion: "OwlCodaRunKitFormalCheckV1",
    runId,
    checkId,
    sequence,
    status,
    candidatePath: candidate.candidatePath,
    candidateSha256: candidate.candidateSha256,
    payloadSha256: candidate.payloadSha256,
    sourceFingerprint: candidate.sourceFingerprint,
    verificationContext: context,
    verificationContextFingerprint: verificationContextFingerprint(context),
    snapshotRequestPath: relativeToWorkspace(root, requestPath),
    snapshotPath: snapshot.snapshotPath,
    commandExitCode: savedSnapshot.command.exitCode,
    verificationCommandPolicy: {
      schemaVersion: verificationCommandPolicy.schemaVersion,
      mode: verificationCommandPolicy.mode,
      riskClassification: verificationCommandPolicy.riskClassification,
      profileCommandIds: verificationCommandPolicy.profileCommandIds,
      authorizationGranted: false,
    },
    finalized: false,
    authorizationGranted: false,
  };
  const receiptResult = writeOrResumeExactJson(
    receiptPath,
    receipt,
    "Formal check receipt",
  );
  hooks.afterReceiptPersist?.();
  return {
    ...receiptResult.value,
    exitCode: status === "formal_check_passed" ? 0 : 2,
    checkReceiptPath: relativeToWorkspace(root, receiptPath),
    resumed: candidateResult.resumed
      || requestResult.resumed
      || snapshotResult.resumed
      || receiptResult.resumed,
  };
}

export function recordFormalCheckV1(options) {
  const workspaceRoot = realpathSync(options.workspaceRoot);
  return withControlTransaction(
    workspaceRoot,
    () => recordFormalCheckWithinControlTransaction({
      ...options,
      workspaceRoot,
    }),
  );
}

async function recordFormalEnvelopeCheckWithinControlTransaction({
  workspaceRoot,
  runId,
  workItemId,
  checkId,
  envelope,
  hooks = {},
}) {
  safeIdentifier(checkId, "checkId");
  const root = realpathSync(workspaceRoot);
  const { executionRoot, pinGate } = loadActiveExecution(root, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const validatedEnvelope = validateVerificationEnvelopeV1({
    workspaceRoot: root,
    envelope,
  });
  const receiptPath = path.join(checkRoot(executionRoot), `${checkId}.json`);
  const candidateResult = resumeOrFreezeCandidate({
    workspaceRoot: root,
    executionRoot,
    runId,
    workItemId,
    checkId,
  });
  const candidate = candidateResult.candidate;
  if (candidate.status !== "source_candidate_frozen") return candidate;
  hooks.afterCandidatePersist?.();
  const candidateDocument = readJson(path.join(root, candidate.candidatePath));
  const envelopePath = path.join(
    executionRoot,
    "formal-envelopes",
    `${checkId}.json`,
  );
  const envelopeResult = writeOrResumeExactJson(
    envelopePath,
    validatedEnvelope.envelope,
    "Formal Verification Envelope",
  );
  const envelopeArtifactRoot = path.join(
    executionRoot,
    "verification-envelopes",
    checkId,
  );
  const envelopeReceipt = await runVerificationEnvelopeV1({
    workspaceRoot: root,
    envelope: envelopeResult.value,
    artifactRoot: envelopeArtifactRoot,
  });
  hooks.afterEnvelopePersist?.();
  const commandArgv = [
    realpathSync(process.execPath),
    VERIFICATION_ENVELOPE_CHECKER,
    "--workspace",
    root,
    "--receipt",
    envelopeReceipt.receiptPath,
  ];
  const verificationCommandPolicy = {
    schemaVersion: "OwlCodaRunKitFormalVerificationCommandPolicyV1",
    mode: "verification_envelope_v1",
    riskClassification: "enforced_verification_envelope",
    profileCommandIds: [],
    executable: commandArgv[0],
    argv: commandArgv.slice(1),
    envelopeSha256: validatedEnvelope.envelopeSha256,
    envelopeReceiptSha256: envelopeReceipt.receiptSha256,
    authorizationGranted: false,
  };
  const context = derivedVerificationContext(root);
  const request = {
    schemaVersion: "OwlCodaRunKitSnapshotRequestV1",
    snapshotId: `${checkId}-snapshot`,
    mode: "project",
    targetRoot: root,
    cwd: ".",
    executable: verificationCommandPolicy.executable,
    argv: verificationCommandPolicy.argv,
    launcherVersion: "owlrunkit-formal-envelope-v1",
    toolVersions: structuredClone(context.toolchains),
    selectedPaths: candidateDocument.sourceManifest.entries
      .filter((entry) => entry.operation !== "deleted")
      .map((entry) => entry.path)
      .sort(),
    statusMode: "porcelain-v1-z-untracked-all-runkit-excluded",
    verificationContext: context,
  };
  const requestPath = path.join(
    executionRoot,
    "formal-check-requests",
    `${checkId}.json`,
  );
  const requestResult = writeOrResumeExactJson(
    requestPath,
    request,
    "Formal check request",
  );
  hooks.afterRequestPersist?.();
  const snapshotResult = resumeSnapshot({
    workspaceRoot: root,
    executionRoot,
    runId,
    request: requestResult.value,
    candidateDocument,
  });
  const snapshot = snapshotResult.snapshot;
  hooks.afterSnapshotPersist?.();
  const savedSnapshot = readJson(path.join(root, snapshot.snapshotPath));
  const existingReceipt = existsSync(receiptPath)
    ? readRegularJson(receiptPath, "Formal check receipt")
    : null;
  const sequence = existingReceipt?.sequence
    ?? readChecks(executionRoot).length + 1;
  const status = snapshot.status === "snapshot_passed"
    && envelopeReceipt.formalEligible
    ? "formal_check_passed"
    : "formal_check_failed";
  const receipt = {
    schemaVersion: "OwlCodaRunKitFormalCheckV1",
    runId,
    checkId,
    sequence,
    status,
    candidatePath: candidate.candidatePath,
    candidateSha256: candidate.candidateSha256,
    payloadSha256: candidate.payloadSha256,
    sourceFingerprint: candidate.sourceFingerprint,
    verificationContext: context,
    verificationContextFingerprint: verificationContextFingerprint(context),
    snapshotRequestPath: relativeToWorkspace(root, requestPath),
    snapshotPath: snapshot.snapshotPath,
    commandExitCode: savedSnapshot.command.exitCode,
    verificationCommandPolicy: {
      schemaVersion: verificationCommandPolicy.schemaVersion,
      mode: verificationCommandPolicy.mode,
      riskClassification: verificationCommandPolicy.riskClassification,
      profileCommandIds: verificationCommandPolicy.profileCommandIds,
      envelopeSha256: verificationCommandPolicy.envelopeSha256,
      envelopeReceiptSha256: verificationCommandPolicy.envelopeReceiptSha256,
      authorizationGranted: false,
    },
    envelopePath: relativeToWorkspace(root, envelopePath),
    envelopeSha256: validatedEnvelope.envelopeSha256,
    envelopeReceiptPath: relativeToWorkspace(root, envelopeReceipt.receiptPath),
    envelopeReceiptSha256: envelopeReceipt.receiptSha256,
    envelopeFormalEligible: envelopeReceipt.formalEligible,
    finalized: false,
    authorizationGranted: false,
  };
  const receiptResult = writeOrResumeExactJson(
    receiptPath,
    receipt,
    "Formal check receipt",
  );
  hooks.afterReceiptPersist?.();
  return {
    ...receiptResult.value,
    exitCode: status === "formal_check_passed" ? 0 : 2,
    checkReceiptPath: relativeToWorkspace(root, receiptPath),
    resumed: candidateResult.resumed
      || envelopeResult.resumed
      || envelopeReceipt.resumed
      || requestResult.resumed
      || snapshotResult.resumed
      || receiptResult.resumed,
  };
}

export function recordFormalEnvelopeCheckV1(options) {
  const workspaceRoot = realpathSync(options.workspaceRoot);
  return withControlTransaction(
    workspaceRoot,
    () => recordFormalEnvelopeCheckWithinControlTransaction({
      ...options,
      workspaceRoot,
    }),
  );
}

function finalizeFormalChecksWithinControlTransaction({
  workspaceRoot,
  runId,
  finalizeId,
  hooks = {},
}) {
  safeIdentifier(finalizeId, "finalizeId");
  const root = realpathSync(workspaceRoot);
  const { executionRoot, pinGate } = loadActiveExecution(root, runId);
  if (pinGate.status !== "valid") return { ...pinGate, authorizationGranted: false };
  const checks = readChecks(executionRoot);
  if (checks.length === 0) throw new Error("Formal finish requires at least one check.");
  const latest = checks.at(-1);
  const currentCandidate = verifySourceCandidateV2({
    workspaceRoot: root,
    candidatePath: latest.candidatePath,
  });
  if (currentCandidate.status !== "valid") {
    throw new Error("Formal finish requires the latest source candidate to remain current.");
  }
  const selected = checks.filter((check) => (
    check.status === "formal_check_passed"
    && check.sourceFingerprint === latest.sourceFingerprint
    && check.verificationContextFingerprint === latest.verificationContextFingerprint
  ));
  if (latest.status !== "formal_check_passed" || selected.length === 0) {
    throw new Error("Formal finish requires the latest source to have a passed check.");
  }
  for (const check of selected) {
    if (!check.envelopeReceiptPath) continue;
    const verifiedEnvelope = verifyVerificationEnvelopeReceiptV1({
      workspaceRoot: root,
      receiptPath: path.join(root, check.envelopeReceiptPath),
    });
    if (!verifiedEnvelope.formalEligible
      || verifiedEnvelope.receiptSha256 !== check.envelopeReceiptSha256
      || verifiedEnvelope.envelopeSha256 !== check.envelopeSha256) {
      throw new Error(`Formal finish requires a valid Formal-eligible envelope receipt: ${check.checkId}.`);
    }
  }
  const request = {
    schemaVersion: "OwlCodaRunKitFinalizeRequestV1",
    receiptId: `${finalizeId}-receipt`,
    sourceCandidatePath: latest.candidatePath,
    verificationContext: structuredClone(latest.verificationContext),
    snapshotPaths: selected.map((check) => check.snapshotPath),
  };
  const requestPath = path.join(
    executionRoot,
    "formal-finalize-requests",
    `${finalizeId}.json`,
  );
  writeOrResumeExactJson(
    requestPath,
    request,
    "Formal finalize request",
  );
  const finalized = runFinalize({
    workspaceRoot: root,
    runId,
    request,
    hooks,
  });
  return {
    ...finalized,
    finalizeRequestPath: relativeToWorkspace(root, requestPath),
    snapshotCount: selected.length,
    staleCheckCount: checks.length - selected.length,
    sourceFingerprint: latest.sourceFingerprint,
    sourceCandidatePath: latest.candidatePath,
    authorizationGranted: false,
  };
}

export function finalizeFormalChecksV1(options) {
  const workspaceRoot = realpathSync(options.workspaceRoot);
  return withControlTransaction(
    workspaceRoot,
    () => finalizeFormalChecksWithinControlTransaction({
      ...options,
      workspaceRoot,
    }),
  );
}

export function resumeCompletedFormalFinishV1({
  workspaceRoot,
  runId,
  finalizeId,
  decision,
}) {
  safeIdentifier(finalizeId, "finalizeId");
  const root = realpathSync(workspaceRoot);
  const executionRoot = path.join(
    root,
    ".owlcoda",
    "runkit",
    "executions",
    runId,
  );
  const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
  if (!existsSync(closeoutPath)) return null;
  const closeout = readRegularJson(closeoutPath, "Formal closeout receipt");
  const gate = validateCoreArtifact(closeout.artifact);
  const payload = closeout.artifact?.payload;
  if (
    !gate.valid
    || closeout.acceptanceSha256 !== gate.acceptanceSha256
    || closeout.artifactSha256 !== gate.artifactSha256
    || payload?.runId !== runId
    || payload?.decision !== decision
    || payload?.authorizationGranted !== false
    || (decision === "accepted"
      && acceptedCloseoutVerificationIssues(closeout.artifact).length > 0)
  ) {
    throw new Error(
      "Existing closeout does not match the resumed Formal finish command.",
    );
  }
  if (decision !== "accepted") {
    return {
      status: "formal_finished",
      exitCode: 0,
      runId,
      decision,
      snapshotCount: 0,
      staleCheckCount: 0,
      sourceFingerprint: null,
      activeReceiptSha256: null,
      closeoutArtifactSha256: closeout.artifactSha256,
      releasedLeaseIds: [],
      resumed: true,
      authorizationGranted: false,
    };
  }
  const requestPath = path.join(
    executionRoot,
    "formal-finalize-requests",
    `${finalizeId}.json`,
  );
  const request = readRegularJson(
    requestPath,
    "Formal finalize request",
  );
  if (
    request.schemaVersion !== "OwlCodaRunKitFinalizeRequestV1"
    || request.receiptId !== `${finalizeId}-receipt`
    || typeof request.sourceCandidatePath !== "string"
    || request.deliveryPacketPath !== undefined
  ) {
    throw new Error(
      "Existing closeout does not match the resumed Formal finalize request.",
    );
  }
  const lineagePath = path.join(
    executionRoot,
    "verification-receipts",
    "receipt-lineage.json",
  );
  const lineage = readRegularJson(
    lineagePath,
    "Formal verification receipt lineage",
  );
  const validated = validateReceiptLineage(lineage);
  const active = validated.active;
  if (
    !validated.valid
    || active?.receipt?.status !== "passed"
    || active.receipt.runId !== runId
    || active.receipt.receiptId !== request.receiptId
    || active.receipt.sourceArtifact?.kind !== "source_candidate_v2"
    || active.receipt.sourceArtifact.path !== request.sourceCandidatePath
    || payload.verification.activeReceiptSha256 !== active.receiptSha256
    || canonicalJson(payload.verification.sourceArtifact)
      !== canonicalJson(active.receipt.sourceArtifact)
  ) {
    throw new Error(
      "Existing closeout does not match the resumed Formal verification lineage.",
    );
  }
  const sourceArtifactPath = safeRelativePath(
    active.receipt.sourceArtifact.path,
    "Formal sourceArtifact path",
  );
  const expectedSourceRoot =
    `.owlcoda/runkit/executions/${runId}/source-candidates/`;
  if (!sourceArtifactPath.startsWith(expectedSourceRoot)) {
    throw new Error(
      "Existing closeout Formal sourceArtifact is outside its execution.",
    );
  }
  const sourceArtifactAbsolutePath = path.join(root, sourceArtifactPath);
  readRegularJson(
    sourceArtifactAbsolutePath,
    "Formal sourceArtifact",
  );
  if (
    sha256(readFileSync(sourceArtifactAbsolutePath))
      !== active.receipt.sourceArtifact.sha256
  ) {
    throw new Error(
      "Existing closeout Formal sourceArtifact bytes changed.",
    );
  }
  const checks = readChecks(executionRoot);
  const selected = checks.filter((check) => (
    check.status === "formal_check_passed"
    && check.sourceFingerprint === active.receipt.sourceFingerprint
    && check.verificationContextFingerprint
      === active.receipt.verificationContextFingerprint
  ));
  if (
    selected.length === 0
    || canonicalJson(selected.map(check => check.snapshotPath))
      !== canonicalJson(request.snapshotPaths)
  ) {
    throw new Error(
      "Existing closeout does not match the resumed Formal check set.",
    );
  }
  return {
    status: "formal_finished",
    exitCode: 0,
    runId,
    decision,
    snapshotCount: selected.length,
    staleCheckCount: checks.length - selected.length,
    sourceFingerprint: active.receipt.sourceFingerprint,
    activeReceiptSha256: active.receiptSha256,
    closeoutArtifactSha256: closeout.artifactSha256,
    releasedLeaseIds: [
      ...payload.verification.releasedLeaseIds,
    ],
    resumed: true,
    authorizationGranted: false,
  };
}
