#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  RUNTIME_ROOT,
  acceptedCloseoutVerificationIssues,
  createCoreArtifact,
  currentCoreIdentity,
  initializeProjectRunKit,
  isDirectExecution,
  validateCoreArtifact,
  validateExecutionPin,
  validateLeaseOwnedPaths,
  validateProjectConfigV2,
} from "./core-contract.mjs";
import { validateVerificationReceiptGate } from "./verification-receipt-gate.mjs";
import { validateReceiptLineage } from "./receipt-lineage.mjs";
import { verifyDeliveryPacket } from "./source-fingerprint.mjs";
import { runSnapshot } from "./snapshot.mjs";
import { runFinalize } from "./finalize.mjs";
import { runReadyForCommit } from "./ready-for-commit.mjs";
import { runVisualSmoke } from "./visual-smoke.mjs";
import { runVerifyPlan } from "./verification-plan.mjs";
import { runCoverageAdoption } from "./coverage-adoption.mjs";
import { runResumeExecution } from "./resume-execution.mjs";
import {
  runResourcePreflight,
  summarizeResourcePreflight,
} from "./resource-preflight.mjs";
import {
  acquireLease,
  acquireLeaseWithinControlTransaction,
  inspectLeases,
  listLeaseArtifacts,
  releaseLease,
  releaseLeaseWithinControlTransaction,
  restoreLeaseWithinControlTransaction,
  withControlTransaction,
} from "./lease-lifecycle.mjs";
import { writeJsonExclusiveAtomically } from "./provenance-common.mjs";
import { createDeliveryFromLease } from "./delivery-create.mjs";
import {
  activeAcceptedGate,
  runHighLevelVerify,
} from "./lifecycle-orchestration.mjs";
import { buildInspectSummary, formatInspectHuman } from "./inspect-presentation.mjs";

function parseOptions(values, { multi = [], boolean = [] } = {}) {
  const options = {};
  const multiNames = new Set(multi);
  const booleanNames = new Set(boolean);
  for (let index = 0; index < values.length;) {
    const key = values[index];
    if (!key?.startsWith("--")) throw new Error("Options must use --name flags.");
    const name = key.slice(2);
    if (booleanNames.has(name)) {
      if (name in options) throw new Error(`Duplicate option: ${key}`);
      options[name] = true;
      index += 1;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined) throw new Error("Options must be --name value pairs.");
    if (multiNames.has(name)) {
      if (!(name in options)) options[name] = [];
      options[name].push(value);
    } else {
      if (name in options) throw new Error(`Duplicate option: ${key}`);
      options[name] = value;
    }
    index += 2;
  }
  return options;
}

function requireOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required.`);
  return value;
}

function safeRunId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value === "." || value === "..") {
    throw new Error("run-id must use letters, digits, dot, underscore, or hyphen without path separators.");
  }
  return value;
}

function workspace(options) {
  return realpathSync(requireOption(options, "workspace"));
}

function runtimePath(root, ...segments) {
  return path.resolve(root, RUNTIME_ROOT, ...segments);
}

function pathEntryExists(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath, value, flag = "wx") {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { flag });
}

function appendEvent(executionRoot, event) {
  appendFileSync(path.join(executionRoot, "events.jsonl"), `${JSON.stringify(event)}\n`);
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function inspectDirectory(root, directory, label, issues) {
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      issues.push(`${label} must be a real directory, not a symlink: ${relativePath(root, directory)}`);
      return false;
    }
    const realRoot = realpathSync(root);
    const realDirectory = realpathSync(directory);
    if (realDirectory !== path.resolve(directory) || !withinRoot(realRoot, realDirectory)) {
      issues.push(`${label} must remain inside the project without symlink ancestors: ${relativePath(root, directory)}`);
      return false;
    }
    return true;
  } catch {
    issues.push(`${label} is unreadable: ${relativePath(root, directory)}`);
    return false;
  }
}

function invalidOpenExecution(runId, issues) {
  return {
    runId,
    lifecycle: "unknown",
    historical: false,
    enginePin: { status: "invalid_artifact", exitCode: 2, issues: [...issues] },
    recovery: {
      lease: { status: "invalid", workItemIds: [], activeWorkItemIds: [], releasedWorkItemIds: [], issues: [...issues] },
      delivery: { status: "invalid", issues: [...issues] },
      verification: { status: "invalid", issues: [...issues] },
      evidenceTrustLevel: "invalid",
      nextAllowedAction: "repair_execution_artifacts",
      issues: [...issues],
    },
  };
}

function findNamedFiles(root, searchRoot, name, label, issues) {
  if (!pathEntryExists(searchRoot)) return [];
  if (!inspectDirectory(root, searchRoot, `${label} directory`, issues)) return [];
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
      const entryPath = path.join(directory, entry.name);
      const stat = lstatSync(entryPath);
      if (stat.isSymbolicLink()) {
        issues.push(`${label} artifact must not be a symlink: ${relativePath(root, entryPath)}`);
      } else if (stat.isDirectory()) {
        if (inspectDirectory(root, entryPath, `${label} directory`, issues)) visit(entryPath);
      } else if (stat.isFile() && entry.name === name) {
        found.push(entryPath);
      } else if (!stat.isFile()) {
        issues.push(`${label} artifact must be a regular file: ${relativePath(root, entryPath)}`);
      }
    }
  };
  visit(searchRoot);
  return found;
}

function inspectFlatJsonFiles(root, directory, directoryLabel, artifactLabel) {
  if (!pathEntryExists(directory)) return { files: [], issues: [] };
  const issues = [];
  if (!inspectDirectory(root, directory, directoryLabel, issues)) return { files: [], issues };
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const entryPath = path.join(directory, entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      issues.push(`${artifactLabel} must be a regular file, not a symlink: ${relativePath(root, entryPath)}`);
    } else if (stat.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    } else if (!stat.isFile()) {
      issues.push(`${artifactLabel} must be a regular file: ${relativePath(root, entryPath)}`);
    }
  }
  return { files, issues };
}

function readJsonForInspection(root, filePath, label, issues) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      issues.push(`${label} must be a regular file, not a symlink: ${relativePath(root, filePath)}`);
      return null;
    }
    const realRoot = realpathSync(root);
    const realFile = realpathSync(filePath);
    if (realFile !== path.resolve(filePath) || !withinRoot(realRoot, realFile)) {
      issues.push(`${label} must remain inside the project without symlink ancestors: ${relativePath(root, filePath)}`);
      return null;
    }
    return readJson(realFile);
  } catch {
    issues.push(`${label} must contain valid JSON: ${relativePath(root, filePath)}`);
    return null;
  }
}

function inspectActiveLeases(root, executionRoot) {
  const leasesRoot = path.join(executionRoot, "leases");
  if (!pathEntryExists(leasesRoot)) {
    return { status: "none", workItemIds: [], activeWorkItemIds: [], releasedWorkItemIds: [], issues: [] };
  }
  const issues = [];
  if (!inspectDirectory(root, leasesRoot, "Lease directory", issues)) {
    return { status: "invalid", workItemIds: [], activeWorkItemIds: [], releasedWorkItemIds: [], issues };
  }
  const files = [];
  for (const entry of readdirSync(leasesRoot, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const entryPath = path.join(leasesRoot, entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      issues.push(`Lease artifact must be a regular file, not a symlink: ${relativePath(root, entryPath)}`);
    } else if (stat.isFile() && entry.name.endsWith(".json")) {
      files.push(entryPath);
    } else if (!stat.isFile()) {
      issues.push(`Lease artifact must be a regular file: ${relativePath(root, entryPath)}`);
    }
  }
  if (files.length === 0) {
    return {
      status: issues.length > 0 ? "invalid" : "none",
      workItemIds: [],
      activeWorkItemIds: [],
      releasedWorkItemIds: [],
      issues,
    };
  }
  const leases = files.map((filePath) => readJsonForInspection(root, filePath, "lease", issues)).filter(Boolean);
  for (const lease of leases) {
    if (lease.schemaVersion !== "OwlCodaRunKitWorkerLeaseV1") issues.push("lease schemaVersion is invalid");
    if (typeof lease.workItemId !== "string" || lease.workItemId.length === 0) issues.push("lease workItemId is required");
    if (!Number.isInteger(lease.attempt) || lease.attempt < 1) issues.push("lease attempt must be a positive integer");
    try {
      validateLeaseOwnedPaths(lease.ownedPaths);
    } catch (error) {
      issues.push(`lease ownedPaths are invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!new Set(["active", "released"]).has(lease.state)) issues.push("lease state must be active or released");
  }
  const workItemIds = leases.map((lease) => lease.workItemId).filter((value) => typeof value === "string").sort();
  if (new Set(workItemIds).size !== workItemIds.length) issues.push("lease workItemId values must be unique");
  const activeWorkItemIds = leases.filter((lease) => lease.state === "active").map((lease) => lease.workItemId).sort();
  const releasedWorkItemIds = leases.filter((lease) => lease.state === "released").map((lease) => lease.workItemId).sort();
  return {
    status: issues.length > 0 ? "invalid" : activeWorkItemIds.length > 0 ? "active" : "released",
    workItemIds,
    activeWorkItemIds,
    releasedWorkItemIds,
    issues,
  };
}

function inspectActiveVerification(root, executionRoot, runId) {
  const receiptsRoot = path.join(executionRoot, "verification-receipts");
  const issues = [];
  const lineagePaths = findNamedFiles(
    root,
    receiptsRoot,
    "receipt-lineage.json",
    "Verification receipt",
    issues,
  );
  if (issues.length > 0) return { status: "invalid", issues };
  if (lineagePaths.length === 0) return { status: "missing", issues: [] };
  if (lineagePaths.length > 1) {
    return { status: "invalid", issues: ["multiple receipt lineage files require explicit repair"] };
  }
  const entries = readJsonForInspection(root, lineagePaths[0], "receipt lineage", issues);
  if (!entries) return { status: "invalid", issues };
  const lineage = validateReceiptLineage(Array.isArray(entries) ? entries : entries.receipts);
  if (!lineage.valid || !lineage.active) {
    return { status: "invalid", issues: lineage.issues?.map((item) => item.message ?? String(item)) ?? ["receipt lineage is invalid"] };
  }
  if (lineage.active.receipt.runId !== runId) {
    return { status: "invalid", issues: ["active receipt runId does not match the execution"] };
  }
  const matchingGates = [];
  const gateIssues = [];
  for (const gatePath of findNamedFiles(
    root,
    receiptsRoot,
    "verification-gate-input.json",
    "Verification receipt",
    gateIssues,
  )) {
    const gateInput = readJsonForInspection(root, gatePath, "verification gate input", gateIssues);
    if (!gateInput) continue;
    const gate = validateVerificationReceiptGate(gateInput);
    if (gate.accepted && gate.activeReceiptSha256 === lineage.active.receiptSha256) {
      matchingGates.push({ gatePath, gate });
    }
  }
  if (matchingGates.length !== 1) {
    return {
      status: "invalid",
      activeReceiptSha256: lineage.active.receiptSha256,
      issues: [
        ...gateIssues,
        matchingGates.length === 0
          ? "active receipt does not have one accepted verification gate"
          : "active receipt has multiple accepted verification gates",
      ],
    };
  }
  const { gatePath, gate } = matchingGates[0];
  return {
    status: "passed",
    decision: gate.decision,
    activeReceiptSha256: gate.activeReceiptSha256,
    sourceFingerprint: gate.sourceFingerprint,
    receiptId: lineage.active.receipt.receiptId,
    gateInputPath: relativePath(root, gatePath),
    issues: [],
  };
}

function inspectActiveDelivery(root, executionRoot, runId, preferredFingerprint) {
  const packetsRoot = path.join(executionRoot, "delivery-packets");
  const listing = inspectFlatJsonFiles(root, packetsRoot, "Delivery packet directory", "Delivery packet artifact");
  const packetPaths = listing.files;
  if (listing.issues.length > 0) {
    return { status: "invalid", packetPaths: [], stalePacketPaths: [], issues: listing.issues };
  }
  if (packetPaths.length === 0) return { status: "missing", packetPaths: [], stalePacketPaths: [], issues: [] };
  const issues = [];
  const fresh = [];
  const stalePacketPaths = [];
  for (const packetPath of packetPaths) {
    const packet = readJsonForInspection(root, packetPath, "delivery packet", issues);
    if (!packet) continue;
    if (packet.runId !== runId) {
      issues.push(`delivery packet runId does not match the execution: ${relativePath(root, packetPath)}`);
      continue;
    }
    const gate = verifyDeliveryPacket({ workspaceRoot: root, packet });
    if (gate.status === "valid") {
      fresh.push({ path: packetPath, sourceFingerprint: gate.recomputedFingerprint });
    } else if (gate.status === "invalidated_by_concurrent_write") {
      stalePacketPaths.push(relativePath(root, packetPath));
    } else {
      issues.push(...(gate.issues ?? []).map((item) => `${relativePath(root, packetPath)}: ${item.message ?? item}`));
    }
  }
  const matching = preferredFingerprint
    ? fresh.filter((item) => item.sourceFingerprint === preferredFingerprint)
    : fresh;
  if (matching.length === 1) {
    return {
      status: "fresh",
      packetPaths: packetPaths.map((item) => relativePath(root, item)),
      selectedPacketPath: relativePath(root, matching[0].path),
      sourceFingerprint: matching[0].sourceFingerprint,
      stalePacketPaths,
      issues,
    };
  }
  if (fresh.length === 0 && stalePacketPaths.length > 0 && issues.length === 0) {
    return { status: "stale", packetPaths: packetPaths.map((item) => relativePath(root, item)), stalePacketPaths, issues: [] };
  }
  return {
    status: "invalid",
    packetPaths: packetPaths.map((item) => relativePath(root, item)),
    stalePacketPaths,
    issues: [
      ...issues,
      preferredFingerprint && matching.length === 0
        ? "no fresh delivery packet matches the active verification receipt"
        : "multiple fresh delivery packets require explicit selection",
    ],
  };
}

function inspectResourcePreflights(root, executionRoot, runId) {
  const resourceRoot = path.join(executionRoot, "resource-preflights");
  const listing = inspectFlatJsonFiles(
    root,
    resourceRoot,
    "Resource preflight directory",
    "Resource preflight artifact",
  );
  if (listing.issues.length > 0) return { status: "invalid", selected: null, issues: listing.issues };
  if (listing.files.length === 0) return { status: "none", selected: null, issues: [] };
  const summaries = [];
  const issues = [];
  for (const artifactPath of listing.files) {
    const artifact = readJsonForInspection(root, artifactPath, "resource preflight", issues);
    if (!artifact) continue;
    try {
      const summary = summarizeResourcePreflight(artifact, runId);
      const bindingIssues = inspectResourceVerificationPlanBinding(root, executionRoot, runId, artifact);
      if (bindingIssues.length > 0) {
        issues.push(...bindingIssues.map(issue => `${relativePath(root, artifactPath)}: ${issue}`));
        continue;
      }
      summaries.push({
        ...summary,
        artifactPath: relativePath(root, artifactPath),
      });
    } catch (error) {
      issues.push(`${relativePath(root, artifactPath)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const sequences = summaries.map(summary => summary.sequence);
  if (new Set(sequences).size !== sequences.length) issues.push("resource preflight sequences must be unique");
  if (issues.length > 0) return { status: "invalid", selected: null, issues };
  const selected = [...summaries].sort((left, right) => right.sequence - left.sequence)[0];
  const expired = selected.validUntil !== null && Date.now() > new Date(selected.validUntil).getTime();
  return {
    status: expired ? "expired" : "current",
    selected,
    artifactPaths: summaries.sort((left, right) => left.sequence - right.sequence).map(summary => summary.artifactPath),
    issues: [],
  };
}

function inspectResourceVerificationPlanBinding(root, executionRoot, runId, artifact) {
  const planPath = path.resolve(root, artifact.verificationPlan.path);
  const expectedPlanRoot = path.join(executionRoot, "verification-plans");
  if (!withinRoot(expectedPlanRoot, planPath)) {
    return ["resource preflight verification plan must remain inside this execution"];
  }
  const issues = [];
  const plan = readJsonForInspection(root, planPath, "resource preflight verification plan", issues);
  if (!plan) return issues;
  if (sha256(readFileSync(planPath)) !== artifact.verificationPlan.sha256) {
    issues.push("resource preflight verification plan hash does not match the bound SHA-256");
  }
  if (plan.schemaVersion !== "OwlCodaRunKitVerificationPlanV1"
    || plan.runId !== runId
    || plan.planId !== artifact.verificationPlan.planId
    || plan.authorizationGranted !== false
    || !plan.evidence
    || !Array.isArray(plan.evidence.reusableReceiptIds)) {
    issues.push("resource preflight verification plan identity or authority boundary is invalid");
    return issues;
  }
  const planReceipts = [...plan.evidence.reusableReceiptIds].sort(compareCodeUnits);
  if (planReceipts.some(receiptId => typeof receiptId !== "string")
    || new Set(planReceipts).size !== planReceipts.length
    || JSON.stringify(planReceipts) !== JSON.stringify(artifact.receiptReuse.reusableReceiptIds)) {
    issues.push("resource preflight reusable receipts do not match the bound verification plan");
  }
  return issues;
}

function activeRecovery(root, executionRoot, runId, enginePin) {
  const lease = inspectActiveLeases(root, executionRoot);
  const verification = inspectActiveVerification(root, executionRoot, runId);
  const delivery = inspectActiveDelivery(root, executionRoot, runId, verification.sourceFingerprint);
  const resourcePreflight = inspectResourcePreflights(root, executionRoot, runId);
  const issues = [
    ...lease.issues,
    ...delivery.issues,
    ...verification.issues,
    ...(resourcePreflight.status === "invalid" ? resourcePreflight.issues : []),
  ];
  if (enginePin.status !== "valid") issues.push(...enginePin.issues);
  if (verification.status === "passed" && lease.status === "none") {
    issues.push("passed verification requires a recorded writer lease before closeout");
  }
  let evidenceTrustLevel = "planned";
  let nextAllowedAction = "acquire_writer_lease";
  if (issues.length > 0 || new Set(["invalid", "stale"]).has(delivery.status) || verification.status === "invalid") {
    evidenceTrustLevel = "invalid";
    nextAllowedAction = delivery.status === "stale" ? "replace_delivery_packet" : "repair_execution_artifacts";
  } else if (verification.status === "passed") {
    evidenceTrustLevel = "verification_passed";
    nextAllowedAction = lease.status === "active" ? "release_writer_lease" : "close_execution";
  } else if (delivery.status === "fresh") {
    evidenceTrustLevel = "delivery_fresh";
    nextAllowedAction = "run_stage_verification";
  } else if (resourcePreflight.status === "expired") {
    evidenceTrustLevel = "work_in_progress";
    nextAllowedAction = "run_resource_preflight";
  } else if (resourcePreflight.status === "current" && resourcePreflight.selected) {
    evidenceTrustLevel = "work_in_progress";
    nextAllowedAction = resourcePreflight.selected.nextAllowedAction;
  } else if (lease.status === "active") {
    evidenceTrustLevel = "work_in_progress";
    nextAllowedAction = "continue_feature_work";
  } else if (lease.status === "released") {
    evidenceTrustLevel = "work_in_progress";
    nextAllowedAction = "prepare_delivery_packet";
  }
  return { lease, delivery, verification, resourcePreflight, evidenceTrustLevel, nextAllowedAction, issues };
}

function closedRecovery(receipt, closeout) {
  if (closeout.status !== "valid") {
    return {
      lease: { status: "invalid", workItemIds: [], activeWorkItemIds: [], releasedWorkItemIds: [], issues: closeout.issues },
      delivery: { status: "invalid", issues: closeout.issues },
      verification: { status: "invalid", issues: closeout.issues },
      evidenceTrustLevel: "invalid",
      nextAllowedAction: "repair_execution_artifacts",
      issues: closeout.issues,
    };
  }
  const payload = receipt.artifact.payload;
  const verification = payload.verification;
  return {
    lease: verification
      ? { status: "released", workItemIds: [...verification.releasedLeaseIds], activeWorkItemIds: [], releasedWorkItemIds: [...verification.releasedLeaseIds], issues: [] }
      : { status: "not_required", workItemIds: [], activeWorkItemIds: [], releasedWorkItemIds: [], issues: [] },
    delivery: verification
      ? { status: "historical", sourceFingerprint: verification.sourceFingerprint, issues: [] }
      : { status: "not_applicable", issues: [] },
    verification: verification
      ? {
          status: "passed",
          decision: verification.gateDecision,
          activeReceiptSha256: verification.activeReceiptSha256,
          sourceFingerprint: verification.sourceFingerprint,
          issues: [],
        }
      : { status: "not_applicable", issues: [] },
    evidenceTrustLevel: payload.decision === "accepted" ? "closed_accepted" : "closed_nonaccepted",
    nextAllowedAction: "plan_new_execution",
    issues: [],
  };
}

function closeoutGateRejected(runId, decision, issues) {
  return {
    status: "closeout_gate_rejected",
    exitCode: 2,
    runId,
    decision,
    authorizationGranted: false,
    issues,
  };
}

async function initialize(options) {
  return initializeProjectRunKit({ workspaceRoot: workspace(options) });
}

function plan(options) {
  const root = workspace(options);
  const runId = safeRunId(requireOption(options, "run-id"));
  const goalPath = realpathSync(requireOption(options, "goal"));
  const config = readJson(runtimePath(root, "config.json"));
  const pinGate = validateExecutionPin({ expected: config.core, actual: currentCoreIdentity() });
  if (pinGate.status !== "valid") return pinGate;
  const executionRoot = runtimePath(root, "executions", runId);
  if (existsSync(executionRoot)) throw new Error(`run id already exists: ${runId}`);
  mkdirSync(path.join(executionRoot, "leases"), { recursive: true });
  mkdirSync(path.join(executionRoot, "delivery-packets"));
  mkdirSync(path.join(executionRoot, "verification-receipts"));
  const enginePin = currentCoreIdentity();
  const goal = readJson(goalPath);
  writeJson(path.join(executionRoot, "engine-pin.json"), enginePin);
  writeJson(path.join(executionRoot, "goal-contract.json"), goal);
  writeJson(path.join(executionRoot, "execution-plan.json"), {
    schemaVersion: "OwlCodaRunKitExecutionPlanV1",
    runId,
    state: "planned",
    enginePin,
    authorizationGranted: false,
  });
  appendEvent(executionRoot, { sequence: 1, type: "execution_planned", runId, authorizationGranted: false });
  return { status: "planned", exitCode: 0, runId, authorizationGranted: false, enginePin };
}

function startExecution(options) {
  const root = workspace(options);
  const runId = safeRunId(requireOption(options, "run-id"));
  const workItemId = requireOption(options, "work-item");
  const ownedPaths = options["owned-path"] ?? [];
  const executionRoot = runtimePath(root, "executions", runId);
  return withControlTransaction(root, () => {
    if (existsSync(executionRoot)) throw new Error(`run id already exists: ${runId}`);
    try {
      const planned = plan(options);
      if (planned.status !== "planned") return planned;
      const lease = acquireLeaseWithinControlTransaction({
        workspaceRoot: root,
        runId,
        workItemId,
        ownedPaths,
      });
      if (lease.status !== "lease_acquired") {
        rmSync(executionRoot, { recursive: true, force: true });
        return lease;
      }
      return {
        status: "started",
        exitCode: 0,
        runId,
        leasePath: lease.leasePath,
        enginePin: planned.enginePin,
        authorizationGranted: false,
      };
    } catch (error) {
      if (existsSync(executionRoot)) rmSync(executionRoot, { recursive: true, force: true });
      throw error;
    }
  });
}

function inspect(options) {
  const root = workspace(options);
  const requestedRunId = options["run-id"] === undefined
    ? null
    : safeRunId(requireOption(options, "run-id"));
  if (options.history && requestedRunId) throw new Error("inspect --history cannot be combined with --run-id.");
  if (options.verbose && !requestedRunId) throw new Error("inspect --verbose requires --run-id.");
  if (options.history && options.verbose) throw new Error("inspect --history cannot be combined with --verbose.");
  const controlIssues = [];
  const configPath = runtimePath(root, "config.json");
  const candidateConfig = readJsonForInspection(root, configPath, "Project config", controlIssues);
  const configGate = candidateConfig
    ? validateProjectConfigV2(candidateConfig)
    : { valid: false, issues: [] };
  if (!configGate.valid) controlIssues.push(...configGate.issues);
  const config = controlIssues.length === 0 ? candidateConfig : null;
  const current = currentCoreIdentity();
  const configCore = config
    ? validateExecutionPin({ expected: config.core, actual: current })
    : { status: "invalid_config", exitCode: 2, issues: [...controlIssues] };
  const executionsRoot = runtimePath(root, "executions");
  const executionEntries = pathEntryExists(executionsRoot) && inspectDirectory(root, executionsRoot, "Executions directory", controlIssues)
    ? readdirSync(executionsRoot, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))
    : [];
  const runIds = executionEntries.map((entry) => entry.name);
  const executions = executionEntries.map((entry) => {
    const runId = entry.name;
    const executionRoot = runtimePath(root, "executions", runId);
    const entryIssues = [];
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      entryIssues.push(`Execution must be a real directory, not a symlink: ${relativePath(root, executionRoot)}`);
      return invalidOpenExecution(runId, entryIssues);
    }
    if (!inspectDirectory(root, executionRoot, "Execution directory", entryIssues)) {
      return invalidOpenExecution(runId, entryIssues);
    }
    const inspectionIssues = [];
    const pin = readJsonForInspection(root, path.join(executionRoot, "engine-pin.json"), "engine pin", inspectionIssues);
    if (!pin) {
      const enginePin = { status: "invalid_artifact", exitCode: 2, issues: inspectionIssues };
      return {
        runId,
        lifecycle: "unknown",
        historical: false,
        enginePin,
        recovery: activeRecovery(root, executionRoot, runId, enginePin),
      };
    }
    const currentPinGate = validateExecutionPin({ expected: pin, actual: current });
    const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
    if (!pathEntryExists(closeoutPath)) {
      return {
        runId,
        lifecycle: "active",
        historical: currentPinGate.status !== "valid",
        enginePin: currentPinGate,
        recovery: activeRecovery(root, executionRoot, runId, currentPinGate),
      };
    }

    const receipt = readJsonForInspection(root, closeoutPath, "closeout receipt", inspectionIssues);
    if (!receipt) {
      const closeout = { status: "invalid", issues: inspectionIssues };
      return {
        runId,
        lifecycle: "closed",
        historical: currentPinGate.status !== "valid",
        enginePin: { status: "invalid_closeout", exitCode: 2, issues: inspectionIssues },
        closeout,
        recovery: closedRecovery({ artifact: { payload: {} } }, closeout),
      };
    }
    const artifactGate = validateCoreArtifact(receipt.artifact);
    const issues = [...artifactGate.issues];
    if (artifactGate.valid && receipt.acceptanceSha256 !== artifactGate.acceptanceSha256) {
      issues.push("closeout acceptanceSha256 does not match the artifact");
    }
    if (artifactGate.valid && receipt.artifactSha256 !== artifactGate.artifactSha256) {
      issues.push("closeout artifactSha256 does not match the artifact");
    }
    if (artifactGate.valid && receipt.artifact.payload.runId !== runId) {
      issues.push("closeout runId does not match the execution directory");
    }
    if (artifactGate.valid && !new Set(["accepted", "rejected", "blocked"]).has(receipt.artifact.payload.decision)) {
      issues.push("closeout decision is invalid");
    }
    if (artifactGate.valid && receipt.artifact.payload.authorizationGranted !== false) {
      issues.push("closeout authorizationGranted must be false");
    }
    if (artifactGate.valid) issues.push(...acceptedCloseoutVerificationIssues(receipt.artifact));
    const enginePin = artifactGate.valid
      ? validateExecutionPin({ expected: pin, actual: receipt.artifact.core })
      : { status: "invalid_closeout", exitCode: 2, issues: [...artifactGate.issues] };
    if (enginePin.status !== "valid") issues.push(...enginePin.issues);
    const closeout = issues.length === 0
      ? {
          status: "valid",
          decision: receipt.artifact.payload.decision,
          authorizationGranted: false,
        }
      : { status: "invalid", issues };
    return {
      runId,
      lifecycle: "closed",
      historical: currentPinGate.status !== "valid",
      enginePin,
      closeout,
      recovery: {
        ...closedRecovery(receipt, closeout),
        resourcePreflight: inspectResourcePreflights(root, executionRoot, runId),
      },
    };
  });
  const invalidClosedIssues = executions
    .filter((execution) => execution.lifecycle === "closed" && execution.closeout?.status === "invalid")
    .flatMap((execution) => execution.closeout.issues ?? []);
  const recoveryControlIssues = [...controlIssues, ...invalidClosedIssues];
  const activeRunIds = executions.filter((execution) => execution.lifecycle !== "closed").map((execution) => execution.runId);
  const selectedRun = activeRunIds.length === 1
    ? executions.find((execution) => execution.runId === activeRunIds[0])
    : null;
  let recovery = activeRunIds.length === 0 && recoveryControlIssues.length > 0
    ? {
        state: "invalid_control_truth",
        activeRunIds,
        selectedRunId: null,
        nextAllowedAction: "repair_execution_artifacts",
        authorizationGranted: false,
      }
    : activeRunIds.length === 0
    ? {
        state: "no_active_execution",
        activeRunIds,
        selectedRunId: null,
        nextAllowedAction: "plan_new_execution",
        authorizationGranted: false,
      }
    : activeRunIds.length === 1
      ? {
          state: "single_active_execution",
          activeRunIds,
          selectedRunId: activeRunIds[0],
          nextAllowedAction: selectedRun.recovery.nextAllowedAction,
          authorizationGranted: false,
        }
      : {
          state: "multiple_active_executions",
          activeRunIds,
          selectedRunId: null,
          nextAllowedAction: "select_active_execution",
          authorizationGranted: false,
        };
  if (recoveryControlIssues.length > 0 && activeRunIds.length > 0) {
    recovery = { ...recovery, nextAllowedAction: "repair_execution_artifacts" };
  }
  const result = {
    status: "inspected",
    exitCode: configCore.status !== "valid" || recoveryControlIssues.length > 0 || executions.some(
      (execution) => execution.enginePin.status !== "valid"
        || execution.closeout?.status === "invalid"
        || execution.recovery?.evidenceTrustLevel === "invalid",
    ) || activeRunIds.length > 1 ? 2 : 0,
    runtimeRoot: RUNTIME_ROOT,
    config,
    configCore,
    controlIssues: recoveryControlIssues,
    runIds,
    executions,
    recovery,
  };
  if (requestedRunId && !executions.some(execution => execution.runId === requestedRunId)) {
    throw new Error(`Execution was not found: ${requestedRunId}`);
  }
  const summary = buildInspectSummary(result);
  const view = options.history
    ? { mode: "history" }
    : requestedRunId
      ? {
          mode: "execution",
          runId: requestedRunId,
          verbose: options.verbose === true,
          execution: executions.find(execution => execution.runId === requestedRunId),
        }
      : { mode: "summary" };
  return { ...result, summary, view };
}

function closeout(options) {
  const root = workspace(options);
  const runId = safeRunId(requireOption(options, "run-id"));
  const decision = requireOption(options, "decision");
  if (!new Set(["accepted", "rejected", "blocked"]).has(decision)) throw new Error("decision must be accepted, rejected, or blocked.");
  if (decision === "accepted" && !options["gate-input"]) {
    return closeoutGateRejected(runId, decision, [
      "A verification gate input is required for accepted closeout.",
    ]);
  }
  const executionRoot = runtimePath(root, "executions", runId);
  const pin = readJson(path.join(executionRoot, "engine-pin.json"));
  const pinGate = validateExecutionPin({ expected: pin, actual: currentCoreIdentity() });
  if (pinGate.status !== "valid") return pinGate;
  let acceptedVerification = null;
  if (decision === "accepted") {
    const gateInputPath = realpathSync(options["gate-input"]);
    const gateInputBytes = readFileSync(gateInputPath);
    const gateInput = JSON.parse(gateInputBytes.toString("utf8"));
    const gate = validateVerificationReceiptGate(gateInput);
    if (!gate.accepted) {
      return closeoutGateRejected(
        runId,
        decision,
        gate.issues.length > 0
          ? gate.issues.map((item) => item.message)
          : ["The verification gate input was not accepted."],
      );
    }
    if (gate.contractVersion !== "0.2") {
      return closeoutGateRejected(runId, decision, [
        "Accepted closeout requires a Contract v0.2 gate input.",
      ]);
    }
    if (gate.lineage.active.receipt.runId !== runId) {
      return closeoutGateRejected(runId, decision, [
        "The active receipt runId must match the current execution.",
      ]);
    }
    const leases = listLeaseArtifacts({ workspaceRoot: root, executionRoot });
    if (leases.length === 0) {
      return closeoutGateRejected(runId, decision, [
        "At least one released lease is required for accepted closeout.",
      ]);
    }
    if (leases.some((lease) => lease.state !== "released")) {
      return closeoutGateRejected(runId, decision, [
        "Accepted closeout is not allowed while an active lease remains.",
      ]);
    }
    const releasedLeaseIds = leases.map((lease) => lease.workItemId);
    if (releasedLeaseIds.some((workItemId) => typeof workItemId !== "string" || workItemId.length === 0)
      || new Set(releasedLeaseIds).size !== releasedLeaseIds.length) {
      return closeoutGateRejected(runId, decision, [
        "Released leases must have unique non-empty workItemId values.",
      ]);
    }
    releasedLeaseIds.sort();
    acceptedVerification = {
      contractVersion: "0.2",
      gateDecision: gate.decision,
      gateInputSha256: sha256(gateInputBytes),
      activeReceiptSha256: gate.activeReceiptSha256,
      sourceFingerprint: gate.sourceFingerprint,
      verificationContextFingerprint: gate.verificationContextFingerprint,
      selectedProfileIds: [...gate.selectedProfileIds],
      leaseState: "released",
      releasedLeaseIds,
    };
  }
  const created = createCoreArtifact({
    core: pin,
    producer: { adapterKind: "codex", adapterVersion: "0.1.0" },
    payload: {
      runId,
      decision,
      authorizationGranted: false,
      ...(acceptedVerification ? { verification: acceptedVerification } : {}),
    },
    extensions: { "dev.owlcoda.adapter.codex": {} },
  });
  const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
  writeJsonExclusiveAtomically(closeoutPath, created);
  const eventsPath = path.join(executionRoot, "events.jsonl");
  const sequence = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).length + 1;
  try {
    appendEvent(executionRoot, { sequence, type: "execution_closed", runId, decision, artifactSha256: created.artifactSha256 });
  } catch (error) {
    rmSync(closeoutPath, { force: true });
    throw error;
  }
  return { status: "closed", exitCode: 0, runId, decision, authorizationGranted: false, ...created };
}

function finishExecution(options) {
  const root = workspace(options);
  const runId = safeRunId(requireOption(options, "run-id"));
  const decision = requireOption(options, "decision");
  if (!new Set(["accepted", "rejected", "blocked"]).has(decision)) {
    throw new Error("decision must be accepted, rejected, or blocked.");
  }
  return withControlTransaction(root, () => {
    const executionRoot = runtimePath(root, "executions", runId);
    const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
    if (pathEntryExists(closeoutPath)) {
      if (lstatSync(closeoutPath).isSymbolicLink()) {
        throw new Error("Closeout receipt must not be a symlink.");
      }
      throw new Error(`Execution is already closed: ${runId}`);
    }
    const gate = decision === "accepted" ? activeAcceptedGate({ workspaceRoot: root, runId }) : null;
    if (gate && gate.status !== "valid") return gate;
    const activeLeaseIds = listLeaseArtifacts({ workspaceRoot: root, executionRoot })
      .filter(lease => lease.state === "active")
      .map(lease => lease.workItemId)
      .sort();
    const releasedLeaseIds = [];
    const rollbackReleasedLeases = () => {
      for (const workItemId of [...releasedLeaseIds].reverse()) {
        const restored = restoreLeaseWithinControlTransaction({
          workspaceRoot: root,
          runId,
          workItemId,
        });
        if (restored.status !== "lease_restored") {
          throw new Error(`Could not restore lease after failed finish: ${workItemId}`);
        }
      }
    };
    let closed;
    try {
      for (const workItemId of activeLeaseIds) {
        const released = releaseLeaseWithinControlTransaction({
          workspaceRoot: root,
          runId,
          workItemId,
        });
        if (released.status !== "lease_released") {
          rollbackReleasedLeases();
          return released;
        }
        releasedLeaseIds.push(workItemId);
      }
      closed = closeout({
        ...options,
        ...(gate ? { "gate-input": gate.gateInputPath } : {}),
      });
      if (closed.status !== "closed") {
        rollbackReleasedLeases();
        return closed;
      }
    } catch (error) {
      if (!pathEntryExists(closeoutPath)) rollbackReleasedLeases();
      throw error;
    }
    return {
      status: "finished",
      exitCode: 0,
      runId,
      decision,
      releasedLeaseIds,
      activeReceiptSha256: gate?.activeReceiptSha256 ?? null,
      closeoutArtifactSha256: closed.artifactSha256,
      authorizationGranted: false,
    };
  });
}

function requestCommand(options, handler) {
  const root = workspace(options);
  const runId = safeRunId(requireOption(options, "run-id"));
  const requestPath = realpathSync(requireOption(options, "request"));
  return handler({ workspaceRoot: root, runId, request: readJson(requestPath) });
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    const separatorIndex = rest.indexOf("--");
    if (separatorIndex >= 0 && command !== "verify") {
      throw new Error("Only runkit verify accepts an exact command after --.");
    }
    const optionValues = separatorIndex >= 0 ? rest.slice(0, separatorIndex) : rest;
    const commandArgv = separatorIndex >= 0 ? rest.slice(separatorIndex + 1) : [];
    const nested = new Set(["lease", "delivery"]).has(command);
    const [action, ...nestedOptions] = nested ? optionValues : [null, ...optionValues];
    const options = parseOptions(nested ? nestedOptions : optionValues, {
      multi: (command === "lease" && action === "acquire") || command === "start" ? ["owned-path"] : [],
      boolean: command === "inspect" ? ["json", "verbose", "history"] : [],
    });
    if (command === "init") return await initialize(options);
    if (command === "start") return startExecution(options);
    if (command === "plan") {
      const root = workspace(options);
      return withControlTransaction(root, () => plan(options));
    }
    if (command === "inspect") return inspect(options);
    if (command === "lease") {
      const root = workspace(options);
      const runId = safeRunId(requireOption(options, "run-id"));
      if (action === "acquire") {
        return acquireLease({
          workspaceRoot: root,
          runId,
          workItemId: requireOption(options, "work-item"),
          ownedPaths: options["owned-path"] ?? [],
        });
      }
      if (action === "inspect") return inspectLeases({ workspaceRoot: root, runId });
      if (action === "release") {
        return releaseLease({
          workspaceRoot: root,
          runId,
          workItemId: requireOption(options, "work-item"),
        });
      }
      throw new Error("Usage: runkit-cli.mjs lease <acquire|inspect|release> [options]");
    }
    if (command === "delivery") {
      if (action !== "create") throw new Error("Usage: runkit-cli.mjs delivery create [options]");
      const root = workspace(options);
      return createDeliveryFromLease({
        workspaceRoot: root,
        runId: safeRunId(requireOption(options, "run-id")),
        workItemId: requireOption(options, "from-lease"),
        packetId: requireOption(options, "packet-id"),
      });
    }
    if (command === "verify") {
      return runHighLevelVerify({
        workspaceRoot: workspace(options),
        runId: safeRunId(requireOption(options, "run-id")),
        workItemId: requireOption(options, "from-lease"),
        verificationId: requireOption(options, "verification-id"),
        cwd: options.cwd ?? ".",
        commandArgv,
      });
    }
    if (command === "coverage-adopt") return requestCommand(options, runCoverageAdoption);
    if (command === "resume") {
      const root = workspace(options);
      const sourceRunId = safeRunId(requireOption(options, "run-id"));
      const requestPath = realpathSync(requireOption(options, "request"));
      return runResumeExecution({ workspaceRoot: root, sourceRunId, request: readJson(requestPath) });
    }
    if (command === "verify-plan") return requestCommand(options, runVerifyPlan);
    if (command === "resource-preflight") {
      const root = workspace(options);
      const runId = safeRunId(requireOption(options, "run-id"));
      const requestPath = realpathSync(requireOption(options, "request"));
      const requestBytes = readFileSync(requestPath);
      return withControlTransaction(root, () => runResourcePreflight({
          workspaceRoot: root,
          runId,
          request: JSON.parse(requestBytes.toString("utf8")),
          requestSha256: sha256(requestBytes),
        }));
    }
    if (command === "snapshot") {
      const root = workspace(options);
      return withControlTransaction(root, () => requestCommand(options, runSnapshot));
    }
    if (command === "visual-smoke") return requestCommand(options, runVisualSmoke);
    if (command === "finalize") {
      const root = workspace(options);
      return withControlTransaction(root, () => requestCommand(options, runFinalize));
    }
    if (command === "ready-for-commit") return requestCommand(options, runReadyForCommit);
    if (command === "closeout") {
      const root = workspace(options);
      return withControlTransaction(root, () => closeout(options));
    }
    if (command === "finish") return finishExecution(options);
    throw new Error("Usage: runkit-cli.mjs <init|start|verify|finish|plan|inspect|lease|delivery|coverage-adopt|resume|verify-plan|resource-preflight|snapshot|visual-smoke|finalize|ready-for-commit|closeout> [options]");
  } catch (error) {
    return {
      status: "invalid_input",
      exitCode: 3,
      issues: [error instanceof Error ? error.message : String(error)],
      authorizationGranted: false,
    };
  }
}

if (isDirectExecution(import.meta.url)) {
  const argv = process.argv.slice(2);
  const result = await runCli(argv);
  const inspectOptions = argv[0] === "inspect" && result.status === "inspected"
    ? parseOptions(argv.slice(1), { boolean: ["json", "verbose", "history"] })
    : null;
  const humanInspect = inspectOptions !== null && inspectOptions.json !== true;
  process.stdout.write(humanInspect ? formatInspectHuman(result) : `${JSON.stringify(result)}\n`);
  process.exitCode = result.exitCode;
}
