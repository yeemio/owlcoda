import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

const MAX_CONTROL_BYTES = 1_048_576;
const CLOSEOUT_DECISIONS = new Set(["accepted", "blocked", "rejected"]);
const LEASE_STATES = new Set(["active", "released"]);

function emptyClosedHistory(status = "empty") {
  return {
    status,
    runIds: [],
    headRunId: null,
    decision: null,
    lineageVerified: false,
    issues: [],
  };
}

function hasFilesystemEntry(filePath) {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
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

function inspectDirectory(root, directory, label, issues) {
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink()) {
      issues.push(`${label} must be a regular directory, not a symlink`);
      return false;
    }
    if (!stat.isDirectory()) {
      issues.push(`${label} must be a regular directory`);
      return false;
    }
    const realDirectory = realpathSync(directory);
    if (realDirectory !== path.resolve(directory) || !within(root, realDirectory)) {
      issues.push(`${label} must remain inside the project without symlink ancestors`);
      return false;
    }
    return true;
  } catch {
    issues.push(`${label} is unreadable`);
    return false;
  }
}

function readJsonBounded(root, filePath, label, issues) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      issues.push(`${label} must be a regular file, not a symlink`);
      return null;
    }
    if (!stat.isFile()) {
      issues.push(`${label} must be a regular file`);
      return null;
    }
    if (stat.size > MAX_CONTROL_BYTES) {
      issues.push(`${label} exceeds the input-byte limit`);
      return null;
    }
    const realFile = realpathSync(filePath);
    if (realFile !== path.resolve(filePath) || !within(root, realFile)) {
      issues.push(`${label} must remain inside the project without symlink ancestors`);
      return null;
    }
    return JSON.parse(readFileSync(realFile, "utf8"));
  } catch {
    issues.push(`${label} must contain valid JSON`);
    return null;
  }
}

function readJsonLinesBounded(root, filePath, label, issues) {
  try {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      issues.push(`${label} must be a regular file, not a symlink`);
      return null;
    }
    if (stat.size > MAX_CONTROL_BYTES) {
      issues.push(`${label} exceeds the input-byte limit`);
      return null;
    }
    const realFile = realpathSync(filePath);
    if (realFile !== path.resolve(filePath) || !within(root, realFile)) {
      issues.push(`${label} must remain inside the project without symlink ancestors`);
      return null;
    }
    return readFileSync(realFile, "utf8")
      .split("\n")
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line));
  } catch {
    issues.push(`${label} must contain valid JSON lines`);
    return null;
  }
}

function allowedKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).every(key => expected.includes(key));
}

function validateHistoricalLeaseOwnedPaths(paths, contract) {
  try {
    return contract.validateLeaseOwnedPaths(paths);
  } catch {
    if (!Array.isArray(paths) || paths.length === 0) throw new Error("invalid");
    const normalized = [...new Set(paths.map(value => {
      if (
        typeof value !== "string"
        || value.length === 0
        || path.isAbsolute(value)
        || path.win32.isAbsolute(value)
        || value.includes("\\")
      ) throw new Error("invalid");
      const segments = value.split("/");
      if (segments.some(segment => (
        segment.length === 0 || segment === "." || segment === ".."
      ))) throw new Error("invalid");
      if (
        value.startsWith(`${contract.runtimeRoot}/`)
        && value !== `${contract.runtimeRoot}/profiles.json`
      ) throw new Error("invalid");
      return value;
    }))].sort(compareCodeUnits);
    return normalized;
  }
}

function inspectLeases(
  root,
  executionRoot,
  runId,
  contract,
  { historicalAccepted = false, expectedReleasedLeaseIds = null } = {},
) {
  const leasesRoot = path.join(executionRoot, "leases");
  if (!hasFilesystemEntry(leasesRoot)) {
    return {
      status: "none",
      workItemIds: [],
      activeWorkItemIds: [],
      releasedWorkItemIds: [],
      preservedInactiveWorkItemIds: [],
      issues: [],
    };
  }
  const issues = [];
  if (!inspectDirectory(root, leasesRoot, `Lease directory for ${runId}`, issues)) {
    return {
      status: "invalid",
      workItemIds: [],
      activeWorkItemIds: [],
      releasedWorkItemIds: [],
      preservedInactiveWorkItemIds: [],
      issues,
    };
  }
  const leases = [];
  for (const entry of readdirSync(leasesRoot, { withFileTypes: true })
    .sort((left, right) => compareCodeUnits(left.name, right.name))) {
    if (!entry.name.endsWith(".json")) continue;
    const leasePath = path.join(leasesRoot, entry.name);
    if (entry.isSymbolicLink()) {
      issues.push(`Lease artifact must not be a symlink: ${runId}/${entry.name}`);
      continue;
    }
    if (!entry.isFile()) {
      issues.push(`Lease artifact must be a regular file: ${runId}/${entry.name}`);
      continue;
    }
    const lease = readJsonBounded(
      root,
      leasePath,
      `Lease artifact ${runId}/${entry.name}`,
      issues,
    );
    if (!lease) continue;
    if (!allowedKeys(
      lease,
      ["attempt", "ownedPaths", "schemaVersion", "state", "workItemId"],
    )) {
      issues.push(`Lease artifact contains unsupported fields: ${runId}/${entry.name}`);
      continue;
    }
    if (lease.schemaVersion !== "OwlCodaRunKitWorkerLeaseV1") {
      issues.push(`Lease schemaVersion is invalid: ${runId}/${entry.name}`);
    }
    if (typeof lease.workItemId !== "string" || lease.workItemId.length === 0) {
      issues.push(`Lease workItemId is invalid: ${runId}/${entry.name}`);
    }
    if (!Number.isInteger(lease.attempt) || lease.attempt < 1) {
      issues.push(`Lease attempt is invalid: ${runId}/${entry.name}`);
    }
    try {
      const ownedPaths = historicalAccepted
        ? validateHistoricalLeaseOwnedPaths(lease.ownedPaths, contract)
        : contract.validateLeaseOwnedPaths(lease.ownedPaths);
      if (ownedPaths.some(ownedPath => (
        ownedPath.includes("*")
        && (!ownedPath.endsWith("/**") || ownedPath.slice(0, -3).includes("*"))
      ))) {
        throw new Error("unsupported wildcard");
      }
    } catch {
      issues.push(`Lease ownedPaths are invalid: ${runId}/${entry.name}`);
    }
    if (!LEASE_STATES.has(lease.state)) {
      issues.push(`Lease state is invalid: ${runId}/${entry.name}`);
    }
    leases.push(lease);
  }
  const workItemIds = leases
    .map(lease => lease.workItemId)
    .filter(workItemId => typeof workItemId === "string")
    .sort(compareCodeUnits);
  if (new Set(workItemIds).size !== workItemIds.length) {
    issues.push(`Lease workItemId values must be unique: ${runId}`);
  }
  const activeWorkItemIds = leases
    .filter(lease => lease.state === "active")
    .map(lease => lease.workItemId)
    .filter(workItemId => typeof workItemId === "string")
    .sort(compareCodeUnits);
  const releasedWorkItemIds = leases
    .filter(lease => lease.state === "released")
    .map(lease => lease.workItemId)
    .filter(workItemId => typeof workItemId === "string")
    .sort(compareCodeUnits);
  if (
    historicalAccepted
    && Array.isArray(expectedReleasedLeaseIds)
    && JSON.stringify(releasedWorkItemIds)
      !== JSON.stringify([...expectedReleasedLeaseIds].sort(compareCodeUnits))
  ) {
    issues.push(`Historical accepted released lease binding mismatch: ${runId}`);
  }
  return {
    status: issues.length > 0
      ? "invalid"
      : activeWorkItemIds.length > 0
        ? "active"
        : leases.length > 0
          ? "released"
          : "none",
    workItemIds,
    activeWorkItemIds,
    releasedWorkItemIds,
    preservedInactiveWorkItemIds: [],
    issues,
  };
}

function inspectCloseout(root, executionRoot, runId, pin, contract) {
  const issues = [];
  const closeout = readJsonBounded(
    root,
    path.join(executionRoot, "closeout-receipt.json"),
    `Closeout receipt for ${runId}`,
    issues,
  );
  if (!closeout) return { trusted: false, decision: null, issues };
  const artifactGate = contract.validateCoreArtifact(closeout.artifact);
  issues.push(...artifactGate.issues.map(issue => `Closeout receipt is invalid: ${runId}: ${issue}`));
  if (artifactGate.valid && closeout.acceptanceSha256 !== artifactGate.acceptanceSha256) {
    issues.push(`Closeout receipt acceptance hash mismatch: ${runId}`);
  }
  if (artifactGate.valid && closeout.artifactSha256 !== artifactGate.artifactSha256) {
    issues.push(`Closeout receipt artifact hash mismatch: ${runId}`);
  }
  const payload = closeout.artifact?.payload;
  if (artifactGate.valid && payload?.runId !== runId) {
    issues.push(`Closeout receipt runId mismatch: ${runId}`);
  }
  if (artifactGate.valid && (
    !CLOSEOUT_DECISIONS.has(payload?.decision)
    || payload.authorizationGranted !== false
  )) {
    issues.push(`Closeout receipt decision or authorization is invalid: ${runId}`);
  }
  if (artifactGate.valid) {
    const superseded = payload?.decision === "blocked"
      && payload?.statusCode === "closed_superseded";
    const payloadKeys = payload?.decision === "accepted"
      ? ["authorizationGranted", "decision", "runId", "verification"]
      : superseded
        ? [
          "authorizationGranted",
          "businessGoalIncomplete",
          "decision",
          "nextAllowedAction",
          "replacementPlanRequired",
          "runId",
          "statusCode",
          "supersession",
        ]
      : ["authorizationGranted", "decision", "runId"];
    if (!allowedKeys(payload, payloadKeys)) {
      issues.push(`Closeout receipt payload contains unsupported fields: ${runId}`);
    }
    if (
      superseded
      && (
        payload.businessGoalIncomplete !== true
        || payload.replacementPlanRequired !== true
        || payload.nextAllowedAction !== "plan_replacement_execution"
        || !allowedKeys(payload.supersession, [
          "priorDecisionSha256",
          "replacementDecisionSha256",
        ])
        || !/^[a-f0-9]{64}$/u.test(
          payload.supersession?.priorDecisionSha256 ?? "",
        )
        || !/^[a-f0-9]{64}$/u.test(
          payload.supersession?.replacementDecisionSha256 ?? "",
        )
      )
    ) {
      issues.push(`Superseded closeout payload is invalid: ${runId}`);
    }
    issues.push(...contract.acceptedCloseoutVerificationIssues(closeout.artifact)
      .map(issue => `Closeout receipt is invalid: ${runId}: ${issue}`));
    const pinGate = contract.validateExecutionPin({
      expected: pin,
      actual: closeout.artifact.core,
    });
    if (pinGate.status !== "valid") {
      issues.push(...pinGate.issues.map(issue => `Closeout engine pin mismatch: ${runId}: ${issue}`));
    }
  }
  return {
    trusted: issues.length === 0,
    decision: issues.length === 0 ? payload.decision : null,
    ...(issues.length === 0 && payload.statusCode === "closed_superseded"
      ? {
        statusCode: payload.statusCode,
        businessGoalIncomplete: payload.businessGoalIncomplete,
        replacementPlanRequired: payload.replacementPlanRequired,
        nextAllowedAction: payload.nextAllowedAction,
      }
      : {}),
    core: issues.length === 0 ? closeout.artifact.core : null,
    releasedLeaseIds: issues.length === 0
      && payload.decision === "accepted"
      && Array.isArray(payload.verification?.releasedLeaseIds)
      ? [...payload.verification.releasedLeaseIds]
      : null,
    issues,
  };
}

function safeRunId(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\");
}

function inspectContinuationEdge(
  root,
  executionRoot,
  runId,
  runtimeRoot,
) {
  const planPath = path.join(executionRoot, "execution-plan.json");
  if (!hasFilesystemEntry(planPath)) return { edge: null, issues: [] };
  const issues = [];
  const plan = readJsonBounded(
    root,
    planPath,
    `Execution plan for ${runId}`,
    issues,
  );
  if (!plan || plan.continuation === undefined) {
    return { edge: null, issues };
  }
  const continuation = plan.continuation;
  if (
    plan.schemaVersion !== "OwlCodaRunKitExecutionPlanV1"
    || plan.runId !== runId
    || !allowedKeys(
      continuation,
      ["attemptPath", "parentRunId", "resumeId"],
    )
    || !safeRunId(continuation.parentRunId)
    || !safeRunId(continuation.resumeId)
  ) {
    issues.push(`Continuation lineage is invalid: ${runId}`);
    return { edge: null, issues };
  }
  const expectedAttemptPath = path.posix.join(
    runtimeRoot,
    "executions",
    runId,
    "resume-attempts",
    `${continuation.resumeId}.json`,
  );
  if (continuation.attemptPath !== expectedAttemptPath) {
    issues.push(`Continuation attempt path is invalid: ${runId}`);
    return { edge: null, issues };
  }
  const attempt = readJsonBounded(
    root,
    path.join(root, expectedAttemptPath),
    `Continuation attempt for ${runId}`,
    issues,
  );
  const expectedParentCloseoutPath = path.posix.join(
    runtimeRoot,
    "executions",
    continuation.parentRunId,
    "closeout-receipt.json",
  );
  if (
    !attempt
    || attempt.schemaVersion !== "OwlCodaRunKitResumeAttemptV1"
    || attempt.mode !== "continuation"
    || attempt.runId !== runId
    || attempt.sourceRunId !== continuation.parentRunId
    || attempt.resumeId !== continuation.resumeId
    || attempt.parentCloseout?.path !== expectedParentCloseoutPath
    || typeof attempt.parentCloseout?.sha256 !== "string"
  ) {
    issues.push(`Continuation attempt binding is invalid: ${runId}`);
    return { edge: null, issues };
  }
  const parentCloseoutPath = path.join(root, expectedParentCloseoutPath);
  const parentCloseout = readJsonBounded(
    root,
    parentCloseoutPath,
    `Continuation parent closeout for ${runId}`,
    issues,
  );
  if (!parentCloseout) return { edge: null, issues };
  const parentCloseoutSha256 = createHash("sha256")
    .update(readFileSync(parentCloseoutPath))
    .digest("hex");
  if (
    attempt.parentCloseout.sha256 !== parentCloseoutSha256
    || attempt.parentCloseout.decision
      !== parentCloseout.artifact?.payload?.decision
  ) {
    issues.push(`Continuation parent closeout binding drifted: ${runId}`);
    return { edge: null, issues };
  }
  const events = readJsonLinesBounded(
    root,
    path.join(executionRoot, "events.jsonl"),
    `Continuation events for ${runId}`,
    issues,
  );
  const sequenced = Array.isArray(events)
    && events.length >= 3
    && events.every((event, index) => (
      event
      && typeof event === "object"
      && !Array.isArray(event)
      && event.sequence === index + 1
    ));
  const planned = sequenced ? events[0] : null;
  const resumed = sequenced ? events[1] : null;
  const closedIndex = sequenced
    ? events.findIndex(event => (
        event.type === "execution_closed"
        && event.runId === runId
      ))
    : -1;
  if (
    !sequenced
    || planned.type !== "execution_planned"
    || planned.runId !== runId
    || planned.authorizationGranted !== false
    || resumed.type !== "execution_resumed"
    || resumed.runId !== runId
    || resumed.sourceRunId !== continuation.parentRunId
    || resumed.resumeId !== continuation.resumeId
    || resumed.authorizationGranted !== false
    || closedIndex <= 1
  ) {
    issues.push(`Continuation event sequence is invalid: ${runId}`);
    return { edge: null, issues };
  }
  return {
    edge: {
      childRunId: runId,
      parentRunId: continuation.parentRunId,
      parentDecision: attempt.parentCloseout.decision,
    },
    issues,
  };
}

function closedHistoryProjection(executions, continuationEdges, issues) {
  const closed = executions
    .filter(execution => execution.lifecycle === "closed")
    .sort((left, right) => compareCodeUnits(left.runId, right.runId));
  const runIds = closed.map(execution => execution.runId);
  if (closed.length === 0) {
    return { ...emptyClosedHistory(), issues: [...issues] };
  }
  if (closed.length === 1) {
    return {
      status: "single",
      runIds,
      headRunId: closed[0].runId,
      decision: closed[0].closeout.decision,
      lineageVerified: false,
      issues: [...issues],
    };
  }

  const byRunId = new Map(closed.map(execution => [execution.runId, execution]));
  const childToParent = new Map();
  const parentToChildren = new Map();
  let lineageValid = issues.length === 0;
  for (const edge of continuationEdges) {
    const child = byRunId.get(edge.childRunId);
    const parent = byRunId.get(edge.parentRunId);
    if (
      !child
      || !parent
      || edge.childRunId === edge.parentRunId
      || edge.parentDecision !== parent.closeout.decision
      || childToParent.has(edge.childRunId)
    ) {
      lineageValid = false;
      continue;
    }
    childToParent.set(edge.childRunId, edge.parentRunId);
    const children = parentToChildren.get(edge.parentRunId) ?? [];
    children.push(edge.childRunId);
    parentToChildren.set(edge.parentRunId, children);
  }
  const roots = runIds.filter(runId => !childToParent.has(runId));
  const heads = runIds.filter(runId => !parentToChildren.has(runId));
  if (
    lineageValid
    && childToParent.size === closed.length - 1
    && roots.length === 1
    && heads.length === 1
  ) {
    const visited = new Set();
    let cursor = heads[0];
    while (cursor !== undefined && !visited.has(cursor)) {
      visited.add(cursor);
      cursor = childToParent.get(cursor);
    }
    if (visited.size === closed.length && cursor === undefined) {
      const head = byRunId.get(heads[0]);
      return {
        status: "unique_head",
        runIds,
        headRunId: head.runId,
        decision: head.closeout.decision,
        lineageVerified: true,
        issues: [],
      };
    }
  }

  const decisionCounts = { accepted: 0, blocked: 0, rejected: 0 };
  for (const execution of closed) {
    decisionCounts[execution.closeout.decision] += 1;
  }
  const decisions = new Set(closed.map(execution => execution.closeout.decision));
  if (decisions.size === 1) {
    return {
      status: "consistent_unordered",
      runIds,
      headRunId: null,
      decision: closed[0].closeout.decision,
      lineageVerified: false,
      issues: [...issues],
    };
  }
  if (issues.length === 0) {
    return {
      status: "multiple_independent_closed_histories",
      runIds,
      headRunId: null,
      decision: null,
      decisionCounts,
      lineageVerified: false,
      blocking: false,
      issues: [],
    };
  }
  return {
    status: "ambiguous_history",
    runIds,
    headRunId: null,
    decision: null,
    lineageVerified: false,
    blocking: true,
    issues: [...issues],
  };
}

function recoveryProjection(activeRunIds, issues) {
  if (issues.length > 0) {
    return {
      state: "invalid_control_truth",
      activeRunIds,
      selectedRunId: null,
      nextAllowedAction: "repair_execution_artifacts",
      authorizationGranted: false,
    };
  }
  if (activeRunIds.length === 0) {
    return {
      state: "no_active_execution",
      activeRunIds,
      selectedRunId: null,
      nextAllowedAction: "plan_new_execution",
      authorizationGranted: false,
    };
  }
  if (activeRunIds.length === 1) {
    return {
      state: "single_active_execution",
      activeRunIds,
      selectedRunId: activeRunIds[0],
      nextAllowedAction: "inspect_active_execution",
      authorizationGranted: false,
    };
  }
  return {
    state: "multiple_active_executions",
    activeRunIds,
    selectedRunId: null,
    nextAllowedAction: "select_active_execution",
    authorizationGranted: false,
  };
}

export function parseProjectControlState({
  workspaceRoot,
  currentCore,
  contract,
} = {}) {
  if (
    !contract
    || typeof contract.runtimeRoot !== "string"
    || typeof contract.acceptedCloseoutVerificationIssues !== "function"
    || typeof contract.validateCoreArtifact !== "function"
    || typeof contract.validateExecutionPin !== "function"
    || typeof contract.validateLeaseOwnedPaths !== "function"
  ) {
    throw new Error("project control-state parser contract is required");
  }
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const executionsRoot = path.join(root, contract.runtimeRoot, "executions");
  const controlIssues = [];
  if (!hasFilesystemEntry(executionsRoot)) {
    return {
      schemaVersion: "OwlCodaRunKitProjectControlStateV1",
      status: "idle",
      workspaceRoot: root,
      executions: [],
      activeRunIds: [],
      activeLeaseIds: [],
      closedHistory: emptyClosedHistory(),
      issues: [],
      upgradeSafety: {
        status: "safe",
        activeRunIds: [],
        activeLeaseIds: [],
        issues: [],
      },
      recovery: recoveryProjection([], []),
      authorizationGranted: false,
    };
  }
  if (!inspectDirectory(root, executionsRoot, "Executions directory", controlIssues)) {
    const recovery = recoveryProjection([], controlIssues);
    return {
      schemaVersion: "OwlCodaRunKitProjectControlStateV1",
      status: "invalid",
      workspaceRoot: root,
      executions: [],
      activeRunIds: [],
      activeLeaseIds: [],
      closedHistory: emptyClosedHistory("unavailable"),
      issues: controlIssues,
      upgradeSafety: {
        status: "unsafe",
        activeRunIds: [],
        activeLeaseIds: [],
        issues: controlIssues,
      },
      recovery,
      authorizationGranted: false,
    };
  }

  const executions = [];
  const activeRunIds = [];
  const activeLeaseIds = [];
  const continuationEdges = [];
  const closedHistoryIssues = [];
  for (const entry of readdirSync(executionsRoot, { withFileTypes: true })
    .sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const runId = entry.name;
    const executionRoot = path.join(executionsRoot, runId);
    const issues = [];
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      issues.push(`Execution must be a regular directory: ${runId}`);
      activeRunIds.push(runId);
      controlIssues.push(...issues);
      executions.push({
        runId,
        lifecycle: "unknown",
        historical: false,
        closeout: { trusted: false, decision: null },
        lease: { status: "invalid", activeWorkItemIds: [], issues },
        issues,
      });
      continue;
    }
    if (!inspectDirectory(root, executionRoot, `Execution directory ${runId}`, issues)) {
      activeRunIds.push(runId);
      controlIssues.push(...issues);
      executions.push({
        runId,
        lifecycle: "unknown",
        historical: false,
        closeout: { trusted: false, decision: null },
        lease: { status: "invalid", activeWorkItemIds: [], issues },
        issues,
      });
      continue;
    }
    const pin = readJsonBounded(
      root,
      path.join(executionRoot, "engine-pin.json"),
      `Engine pin for ${runId}`,
      issues,
    );
    const closeoutPath = path.join(executionRoot, "closeout-receipt.json");
    const hasCloseout = hasFilesystemEntry(closeoutPath);
    const closeout = hasCloseout && pin
      ? inspectCloseout(root, executionRoot, runId, pin, contract)
      : { trusted: false, decision: null, issues: [] };
    issues.push(...closeout.issues);

    let lifecycle;
    if (!hasCloseout) {
      lifecycle = pin ? "active" : "unknown";
      if (pin) {
        const pinGate = contract.validateExecutionPin({ expected: pin, actual: currentCore });
        if (pinGate.status !== "valid") {
          issues.push(...pinGate.issues.map(issue => `Active engine pin mismatch: ${runId}: ${issue}`));
        }
      }
    } else {
      lifecycle = closeout.trusted ? "closed" : "unknown";
    }
    if (lifecycle === "closed") {
      const continuation = inspectContinuationEdge(
        root,
        executionRoot,
        runId,
        contract.runtimeRoot,
      );
      if (continuation.edge) continuationEdges.push(continuation.edge);
      closedHistoryIssues.push(...continuation.issues);
    }
    const historical = Boolean(pin)
      && contract.validateExecutionPin({ expected: pin, actual: currentCore }).status !== "valid";
    const preserveHistoricalLeases = lifecycle === "closed"
      && new Set(["blocked", "rejected"]).has(closeout.decision);
    const inspectedLease = inspectLeases(
      root,
      executionRoot,
      runId,
      contract,
      {
        historicalAccepted: historical
          && lifecycle === "closed"
          && closeout.decision === "accepted",
        expectedReleasedLeaseIds: closeout.releasedLeaseIds,
      },
    );
    const lease = preserveHistoricalLeases && inspectedLease.status !== "invalid"
      ? {
          ...inspectedLease,
          status: "preserved_inactive",
          activeWorkItemIds: [],
          preservedInactiveWorkItemIds: [
            ...inspectedLease.activeWorkItemIds,
          ],
        }
      : inspectedLease;
    issues.push(...lease.issues);
    if (
      lifecycle === "closed"
      && closeout.decision === "accepted"
      && lease.activeWorkItemIds.length > 0
    ) {
      issues.push(`Accepted closeout retains active lease: ${runId}`);
    }
    if (lifecycle !== "closed") activeRunIds.push(runId);
    if (!preserveHistoricalLeases) {
      for (const workItemId of lease.activeWorkItemIds) {
        activeLeaseIds.push(`${runId}:${workItemId}`);
      }
    }
    controlIssues.push(...issues);
    executions.push({
      runId,
      lifecycle,
      historical,
      enginePin: pin,
      closeout: {
        trusted: closeout.trusted,
        decision: closeout.decision,
        ...(closeout.statusCode === undefined
          ? {}
          : {
            statusCode: closeout.statusCode,
            businessGoalIncomplete: closeout.businessGoalIncomplete,
            replacementPlanRequired: closeout.replacementPlanRequired,
            nextAllowedAction: closeout.nextAllowedAction,
          }),
      },
      lease,
      issues,
    });
  }

  activeRunIds.sort(compareCodeUnits);
  activeLeaseIds.sort(compareCodeUnits);
  const closedHistory = closedHistoryProjection(
    executions,
    continuationEdges,
    closedHistoryIssues,
  );
  const recovery = recoveryProjection(activeRunIds, controlIssues);
  const unsafe = activeRunIds.length > 0
    || activeLeaseIds.length > 0
    || controlIssues.length > 0;
  return {
    schemaVersion: "OwlCodaRunKitProjectControlStateV1",
    status: controlIssues.length > 0
      ? "invalid"
      : activeRunIds.length > 0
        ? "active"
        : "idle",
    workspaceRoot: root,
    executions,
    activeRunIds,
    activeLeaseIds,
    closedHistory,
    issues: controlIssues,
    upgradeSafety: {
      status: unsafe ? "unsafe" : "safe",
      activeRunIds,
      activeLeaseIds,
      issues: controlIssues,
    },
    recovery,
    authorizationGranted: false,
  };
}
