import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import { validateLeaseOwnedPaths } from "./core-contract.mjs";
import { inspectProjectControlState } from "./project-control-state.mjs";
import {
  assertAllowedKeys,
  isRecord,
  relativeToWorkspace,
  safeIdentifier,
  writeJsonExclusiveAtomically,
} from "./provenance-common.mjs";

const PROJECT_ROOT = ".owlcoda/runkit/project";
const DEFINITION_SCHEMA = "OwlCodaRunKitTeamProjectDefinitionV1";
const EVENT_SCHEMA = "OwlCodaRunKitTeamProjectEventV1";
const STATUS_SCHEMA = "OwlCodaRunKitTeamProjectStatusV1";

const DEFINITION_KEYS = [
  "schemaVersion",
  "projectId",
  "objective",
  "milestones",
  "workstreams",
  "workItems",
  "integrationGates",
];
const WORK_ITEM_STATES = new Set([
  "active",
  "waiting_dependency",
  "waiting_decision",
  "verifying",
  "ready_to_integrate",
  "completed",
  "failed",
]);
const VERIFICATION_DISPOSITIONS = new Set(["verified", "no_longer_required"]);
const EVENT_KEYS = Object.freeze({
  agent_assigned: [
    "schemaVersion", "eventId", "type", "occurredAt", "assignmentId",
    "supersedesAssignmentId", "workItemId", "agentId", "executionRunId",
    "executionWorkItemId",
  ],
  checkpoint_recorded: [
    "schemaVersion", "eventId", "type", "occurredAt", "assignmentId",
    "workItemId", "state", "summary", "completedUnits", "evidenceRefs",
    "blockerRefs", "decisionRefs", "nextAction", "sourceFingerprint",
  ],
  handoff_recorded: [
    "schemaVersion", "eventId", "type", "occurredAt", "assignmentId",
    "workItemId", "fromAgentId", "toAgentId", "summary", "evidenceRefs",
    "nextAction",
  ],
  decision_opened: [
    "schemaVersion", "eventId", "type", "occurredAt", "decisionId",
    "title", "question", "ownerAgentId", "blockingWorkItemIds", "options",
  ],
  decision_resolved: [
    "schemaVersion", "eventId", "type", "occurredAt", "decisionId",
    "resolution", "rationale", "evidenceRefs",
  ],
  integration_gate_passed: [
    "schemaVersion", "eventId", "type", "occurredAt", "gateId", "summary",
    "evidenceRefs",
  ],
  verification_deferred: [
    "schemaVersion", "eventId", "type", "occurredAt", "verificationId",
    "workItemId", "ownerAgentId", "checkIds", "reason", "dueGateId",
  ],
  verification_closed: [
    "schemaVersion", "eventId", "type", "occurredAt", "verificationId",
    "disposition", "summary", "evidenceRefs", "decisionIds",
  ],
  data_candidate_recorded: [
    "schemaVersion", "eventId", "type", "occurredAt", "candidateId",
    "sourceRef", "rights", "inputRef", "outputRef", "decisionRef",
    "verificationRefs", "outcomeRef", "version",
  ],
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonical(value[key])}`
    )).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Project artifact is not canonical JSON.");
  return encoded;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value, label) {
  if (value === null) return null;
  return nonEmptyString(value, label);
}

function stringArray(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value)
    || (!allowEmpty && value.length === 0)
    || value.some(item => typeof item !== "string" || item.trim().length === 0)
    || new Set(value).size !== value.length) {
    throw new Error(`${label} must be a unique string array${allowEmpty ? "" : " with at least one entry"}.`);
  }
  return [...value];
}

function projectRoot(workspaceRoot) {
  const root = realpathSync(workspaceRoot);
  return { root, projectRoot: path.join(root, PROJECT_ROOT) };
}

function assertRealProjectTree(root, candidate) {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) {
      throw new Error("Team project control path must not contain symlinks.");
    }
  }
}

function withProjectLock(root, operation) {
  const lockPath = path.join(root, "control.lock");
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another team project control transaction is active.");
    }
    throw error;
  }
  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function uniqueIds(rows, label) {
  const ids = rows.map(row => safeIdentifier(row.id, `${label} id`));
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ids must be unique.`);
  return new Set(ids);
}

function assertAcyclic(items) {
  const byId = new Map(items.map(item => [item.id, item]));
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Work item dependency cycle includes ${id}.`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const item of items) visit(item.id);
}

function validateDefinition(value) {
  assertAllowedKeys(value, "Team project definition", DEFINITION_KEYS);
  if (value.schemaVersion !== DEFINITION_SCHEMA) {
    throw new Error(`Team project definition schemaVersion must be ${DEFINITION_SCHEMA}.`);
  }
  safeIdentifier(value.projectId, "projectId");
  nonEmptyString(value.objective, "objective");
  for (const [key, label] of [
    ["milestones", "Milestone"],
    ["workstreams", "Workstream"],
    ["workItems", "Work item"],
    ["integrationGates", "Integration gate"],
  ]) {
    if (!Array.isArray(value[key])) throw new Error(`${label} list must be an array.`);
  }
  if (value.workItems.length === 0) {
    throw new Error("Team project definition requires at least one WorkItem.");
  }
  const milestoneIds = uniqueIds(value.milestones, "Milestone");
  const workstreamIds = uniqueIds(value.workstreams, "Workstream");
  const workItemIds = uniqueIds(value.workItems, "Work item");
  const gateIds = uniqueIds(value.integrationGates, "Integration gate");

  const milestones = value.milestones.map((row) => {
    assertAllowedKeys(row, `Milestone ${row.id ?? "unknown"}`, ["id", "title"]);
    nonEmptyString(row.title, `Milestone ${row.id} title`);
    return { id: row.id, title: row.title };
  });
  const workstreams = value.workstreams.map((row) => {
    assertAllowedKeys(row, `Workstream ${row.id ?? "unknown"}`, ["id", "title", "milestoneId"]);
    nonEmptyString(row.title, `Workstream ${row.id} title`);
    if (!milestoneIds.has(row.milestoneId)) {
      throw new Error(`Workstream ${row.id} references unknown milestone ${row.milestoneId}.`);
    }
    return { id: row.id, title: row.title, milestoneId: row.milestoneId };
  });
  const workItems = value.workItems.map((row) => {
    assertAllowedKeys(row, `Work item ${row.id ?? "unknown"}`, [
      "id", "title", "milestoneId", "workstreamId", "dependencies",
      "ownedPaths", "measurable",
    ]);
    nonEmptyString(row.title, `Work item ${row.id} title`);
    if (!milestoneIds.has(row.milestoneId)) {
      throw new Error(`Work item ${row.id} references unknown milestone ${row.milestoneId}.`);
    }
    if (!workstreamIds.has(row.workstreamId)) {
      throw new Error(`Work item ${row.id} references unknown workstream ${row.workstreamId}.`);
    }
    const dependencies = stringArray(row.dependencies, `Work item ${row.id} dependencies`);
    for (const dependency of dependencies) {
      if (!workItemIds.has(dependency) || dependency === row.id) {
        throw new Error(`Work item ${row.id} has invalid dependency ${dependency}.`);
      }
    }
    const ownedPaths = validateLeaseOwnedPaths(row.ownedPaths);
    let measurable = null;
    if (row.measurable !== undefined) {
      assertAllowedKeys(row.measurable, `Work item ${row.id} measurable`, ["unit", "total"]);
      nonEmptyString(row.measurable.unit, `Work item ${row.id} measurable unit`);
      if (!Number.isSafeInteger(row.measurable.total) || row.measurable.total < 1) {
        throw new Error(`Work item ${row.id} measurable total must be a positive integer.`);
      }
      measurable = { unit: row.measurable.unit, total: row.measurable.total };
    }
    return {
      id: row.id,
      title: row.title,
      milestoneId: row.milestoneId,
      workstreamId: row.workstreamId,
      dependencies,
      ownedPaths,
      ...(measurable ? { measurable } : {}),
    };
  });
  assertAcyclic(workItems);
  const integrationGates = value.integrationGates.map((row) => {
    assertAllowedKeys(row, `Integration gate ${row.id ?? "unknown"}`, [
      "id", "title", "requiredWorkItemIds", "requiredDecisionIds",
    ]);
    nonEmptyString(row.title, `Integration gate ${row.id} title`);
    const requiredWorkItemIds = stringArray(
      row.requiredWorkItemIds,
      `Integration gate ${row.id} requiredWorkItemIds`,
      { allowEmpty: false },
    );
    for (const workItemId of requiredWorkItemIds) {
      if (!workItemIds.has(workItemId)) {
        throw new Error(`Integration gate ${row.id} references unknown work item ${workItemId}.`);
      }
    }
    const requiredDecisionIds = stringArray(
      row.requiredDecisionIds,
      `Integration gate ${row.id} requiredDecisionIds`,
    );
    return { id: row.id, title: row.title, requiredWorkItemIds, requiredDecisionIds };
  });
  if (gateIds.size !== integrationGates.length) throw new Error("Integration gate ids must be unique.");
  return {
    schemaVersion: DEFINITION_SCHEMA,
    projectId: value.projectId,
    objective: value.objective,
    milestones,
    workstreams,
    workItems,
    integrationGates,
  };
}

export function normalizeTeamProjectDefinitionV1(definition) {
  return validateDefinition(definition);
}

export function emptyTeamProjectTruthHashV1(definition) {
  const normalized = validateDefinition(definition);
  return sha256(canonical({ definition: normalized, events: [] }));
}

function readRegularJson(filePath, label) {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || realpathSync(filePath) !== filePath) {
    throw new Error(`${label} must be a regular file without symlinks.`);
  }
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function loadProject(workspaceRoot) {
  const { root, projectRoot: rootPath } = projectRoot(workspaceRoot);
  const definitionPath = path.join(rootPath, "definition.json");
  if (!existsSync(definitionPath)) throw new Error("Team project is not initialized.");
  const definition = validateDefinition(readRegularJson(definitionPath, "Team project definition"));
  const eventsRoot = path.join(rootPath, "events");
  if (!existsSync(eventsRoot)) {
    throw new Error("Team project event directory must be a regular directory without symlinks.");
  }
  const eventsStat = lstatSync(eventsRoot);
  if (eventsStat.isSymbolicLink()
    || !eventsStat.isDirectory()
    || realpathSync(eventsRoot) !== eventsRoot) {
    throw new Error("Team project event directory must be a regular directory without symlinks.");
  }
  const events = readdirSync(eventsRoot, { withFileTypes: true })
      .filter(entry => entry.name.endsWith(".json"))
      .map((entry) => {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw new Error(`Team project event must be a regular file: ${entry.name}`);
        }
        const eventPath = path.join(eventsRoot, entry.name);
        const event = readRegularJson(eventPath, `Team project event ${entry.name}`);
        if (`${event.eventId}.json` !== entry.name) {
          throw new Error(`Team project event filename is not bound to eventId: ${entry.name}`);
        }
        return { event, ref: `project/events/${entry.name}` };
      })
      .sort((left, right) => (
        left.event.occurredAt.localeCompare(right.event.occurredAt)
        || left.event.eventId.localeCompare(right.event.eventId)
      ));
  return { root, projectRoot: rootPath, definitionPath, definition, events };
}

function pathPrefix(value) {
  return value.endsWith("/**") ? value.slice(0, -3) : null;
}

function covers(owner, candidate) {
  if (owner === candidate) return true;
  const prefix = pathPrefix(owner);
  if (prefix === null) return false;
  const candidatePrefix = pathPrefix(candidate) ?? candidate;
  return candidatePrefix === prefix || candidatePrefix.startsWith(`${prefix}/`);
}

function pathsOverlap(left, right) {
  return left.some(leftPath => right.some(rightPath => (
    covers(leftPath, rightPath) || covers(rightPath, leftPath)
  )));
}

function eventRef(event) {
  return `project/events/${event.eventId}.json`;
}

function compareEventFacts(left, right) {
  return left.occurredAt.localeCompare(right.occurredAt)
    || left.eventId.localeCompare(right.eventId);
}

function latestEventFact(left, right) {
  if (!left) return right;
  if (!right) return left;
  return compareEventFacts(left, right) >= 0 ? left : right;
}

function pendingHandoffProjection(handoff) {
  return handoff
    ? {
        eventId: handoff.eventId,
        truthRef: handoff.ref,
        assignmentId: handoff.assignmentId,
        workItemId: handoff.workItemId,
        fromAgentId: handoff.fromAgentId,
        toAgentId: handoff.toAgentId,
        summary: handoff.summary,
        evidenceRefs: [...handoff.evidenceRefs],
        nextAction: handoff.nextAction,
        occurredAt: handoff.occurredAt,
      }
    : null;
}

function validateTimestamp(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))) {
    throw new Error("Team project event occurredAt must be an ISO-8601 UTC timestamp.");
  }
  return value;
}

function validateEventShape(value, definition) {
  if (!isRecord(value) || typeof value.type !== "string" || !(value.type in EVENT_KEYS)) {
    throw new Error("Team project event type is invalid.");
  }
  assertAllowedKeys(value, `Team project event ${value.eventId ?? "unknown"}`, EVENT_KEYS[value.type]);
  if (value.schemaVersion !== EVENT_SCHEMA) {
    throw new Error(`Team project event schemaVersion must be ${EVENT_SCHEMA}.`);
  }
  safeIdentifier(value.eventId, "eventId");
  validateTimestamp(value.occurredAt);
  const workItemIds = new Set(definition.workItems.map(row => row.id));
  const gateIds = new Set(definition.integrationGates.map(row => row.id));
  const assertWorkItem = (id) => {
    safeIdentifier(id, "workItemId");
    if (!workItemIds.has(id)) throw new Error(`Team project event references unknown work item ${id}.`);
  };
  if ([
    "agent_assigned",
    "checkpoint_recorded",
    "handoff_recorded",
    "verification_deferred",
  ].includes(value.type)) {
    assertWorkItem(value.workItemId);
  }
  if (["agent_assigned", "checkpoint_recorded", "handoff_recorded"].includes(value.type)) {
    safeIdentifier(value.assignmentId, "assignmentId");
  }
  if (value.type === "agent_assigned") {
    safeIdentifier(value.agentId, "agentId");
    if (value.supersedesAssignmentId !== undefined) {
      safeIdentifier(value.supersedesAssignmentId, "supersedesAssignmentId");
    }
    if ((value.executionRunId === undefined) !== (value.executionWorkItemId === undefined)) {
      throw new Error("executionRunId and executionWorkItemId must be supplied together.");
    }
    if (value.executionRunId !== undefined) {
      safeIdentifier(value.executionRunId, "executionRunId");
      safeIdentifier(value.executionWorkItemId, "executionWorkItemId");
    }
  } else if (value.type === "checkpoint_recorded") {
    if (!WORK_ITEM_STATES.has(value.state)) throw new Error("Checkpoint state is invalid.");
    nonEmptyString(value.summary, "Checkpoint summary");
    stringArray(value.evidenceRefs, "Checkpoint evidenceRefs");
    stringArray(value.blockerRefs, "Checkpoint blockerRefs");
    stringArray(value.decisionRefs, "Checkpoint decisionRefs");
    nullableString(value.nextAction, "Checkpoint nextAction");
    if (value.sourceFingerprint !== undefined
      && !/^(?:sha256:)?[a-f0-9]{64}$/u.test(value.sourceFingerprint)) {
      throw new Error("Checkpoint sourceFingerprint is invalid.");
    }
    if (value.completedUnits !== undefined
      && (!Number.isSafeInteger(value.completedUnits) || value.completedUnits < 0)) {
      throw new Error("Checkpoint completedUnits must be a non-negative integer.");
    }
    if (value.state === "completed" && value.evidenceRefs.length === 0) {
      throw new Error("Completed checkpoint requires evidence.");
    }
  } else if (value.type === "handoff_recorded") {
    safeIdentifier(value.fromAgentId, "fromAgentId");
    safeIdentifier(value.toAgentId, "toAgentId");
    if (value.fromAgentId === value.toAgentId) {
      throw new Error("fromAgentId and toAgentId must differ.");
    }
    nonEmptyString(value.summary, "Handoff summary");
    stringArray(value.evidenceRefs, "Handoff evidenceRefs", { allowEmpty: false });
    nonEmptyString(value.nextAction, "Handoff nextAction");
  } else if (value.type === "decision_opened") {
    safeIdentifier(value.decisionId, "decisionId");
    safeIdentifier(value.ownerAgentId, "ownerAgentId");
    nonEmptyString(value.title, "Decision title");
    nonEmptyString(value.question, "Decision question");
    const blocking = stringArray(value.blockingWorkItemIds, "Decision blockingWorkItemIds");
    for (const id of blocking) assertWorkItem(id);
    stringArray(value.options, "Decision options", { allowEmpty: false });
  } else if (value.type === "decision_resolved") {
    safeIdentifier(value.decisionId, "decisionId");
    nonEmptyString(value.resolution, "Decision resolution");
    nonEmptyString(value.rationale, "Decision rationale");
    stringArray(value.evidenceRefs, "Decision evidenceRefs", { allowEmpty: false });
  } else if (value.type === "integration_gate_passed") {
    safeIdentifier(value.gateId, "gateId");
    if (!gateIds.has(value.gateId)) throw new Error(`Unknown integration gate ${value.gateId}.`);
    nonEmptyString(value.summary, "Integration gate summary");
    stringArray(value.evidenceRefs, "Integration gate evidenceRefs", { allowEmpty: false });
  } else if (value.type === "verification_deferred") {
    safeIdentifier(value.verificationId, "verificationId");
    safeIdentifier(value.ownerAgentId, "ownerAgentId");
    const checkIds = stringArray(
      value.checkIds,
      "Deferred verification checkIds",
      { allowEmpty: false },
    );
    for (const checkId of checkIds) safeIdentifier(checkId, "checkId");
    nonEmptyString(value.reason, "Deferred verification reason");
    safeIdentifier(value.dueGateId, "dueGateId");
    if (!gateIds.has(value.dueGateId)) {
      throw new Error(`Unknown deferred verification gate ${value.dueGateId}.`);
    }
  } else if (value.type === "verification_closed") {
    safeIdentifier(value.verificationId, "verificationId");
    if (!VERIFICATION_DISPOSITIONS.has(value.disposition)) {
      throw new Error("Deferred verification disposition is invalid.");
    }
    nonEmptyString(value.summary, "Deferred verification close summary");
    const evidenceRefs = stringArray(
      value.evidenceRefs,
      "Deferred verification close evidenceRefs",
    );
    const decisionIds = stringArray(
      value.decisionIds,
      "Deferred verification close decisionIds",
    );
    for (const decisionId of decisionIds) safeIdentifier(decisionId, "decisionId");
    if (value.disposition === "verified" && evidenceRefs.length === 0) {
      throw new Error("Verified deferred verification requires evidence.");
    }
    if (value.disposition === "verified" && decisionIds.length > 0) {
      throw new Error("Verified deferred verification must close with evidence, not decision IDs.");
    }
    if (value.disposition === "no_longer_required" && decisionIds.length === 0) {
      throw new Error("No-longer-required deferred verification requires a resolved decision.");
    }
  } else if (value.type === "data_candidate_recorded") {
    safeIdentifier(value.candidateId, "candidateId");
    nonEmptyString(value.sourceRef, "Data candidate sourceRef");
    nonEmptyString(value.rights, "Data candidate rights");
    nonEmptyString(value.inputRef, "Data candidate inputRef");
    nonEmptyString(value.outputRef, "Data candidate outputRef");
    nullableString(value.decisionRef, "Data candidate decisionRef");
    stringArray(value.verificationRefs, "Data candidate verificationRefs");
    nullableString(value.outcomeRef, "Data candidate outcomeRef");
    nonEmptyString(value.version, "Data candidate version");
  }
  return structuredClone(value);
}

function projectEvents(definition, records) {
  const assignments = new Map();
  const assignmentHistory = new Map(definition.workItems.map(row => [row.id, []]));
  const checkpoints = new Map();
  const handoffs = new Map();
  const decisions = new Map();
  const gatePasses = new Map();
  const verifications = new Map();
  const dataCandidates = [];
  const seenAssignments = new Set();
  const seenDecisions = new Set();

  for (const { event, ref } of records) {
    validateEventShape(event, definition);
    if (event.type === "agent_assigned") {
      if (seenAssignments.has(event.assignmentId)) {
        throw new Error(`Duplicate assignmentId ${event.assignmentId}.`);
      }
      seenAssignments.add(event.assignmentId);
      assignments.set(event.workItemId, { ...event, ref });
      assignmentHistory.get(event.workItemId).push({ ...event, ref });
    } else if (event.type === "checkpoint_recorded") {
      checkpoints.set(event.workItemId, { ...event, ref });
    } else if (event.type === "handoff_recorded") {
      handoffs.set(event.workItemId, { ...event, ref });
    } else if (event.type === "decision_opened") {
      if (seenDecisions.has(event.decisionId)) {
        throw new Error(`Duplicate decision_opened event for ${event.decisionId}.`);
      }
      seenDecisions.add(event.decisionId);
      decisions.set(event.decisionId, { opened: { ...event, ref }, resolved: null });
    } else if (event.type === "decision_resolved") {
      const decision = decisions.get(event.decisionId);
      if (!decision || decision.resolved) {
        throw new Error(`Decision ${event.decisionId} is not open.`);
      }
      decision.resolved = { ...event, ref };
    } else if (event.type === "integration_gate_passed") {
      gatePasses.set(event.gateId, { ...event, ref });
    } else if (event.type === "verification_deferred") {
      if (verifications.has(event.verificationId)) {
        throw new Error(`Duplicate deferred verification ${event.verificationId}.`);
      }
      if (gatePasses.has(event.dueGateId)) {
        throw new Error(
          `Deferred verification cannot target integration gate ${event.dueGateId}; gate already passed.`,
        );
      }
      verifications.set(event.verificationId, {
        deferred: { ...event, ref },
        closed: null,
      });
    } else if (event.type === "verification_closed") {
      const verification = verifications.get(event.verificationId);
      if (!verification || verification.closed) {
        throw new Error(`Deferred verification ${event.verificationId} is not open.`);
      }
      if (event.disposition === "no_longer_required") {
        for (const decisionId of event.decisionIds) {
          if (!decisions.get(decisionId)?.resolved) {
            throw new Error(
              `No-longer-required deferred verification requires resolved decision ${decisionId}.`,
            );
          }
        }
      }
      verification.closed = { ...event, ref };
    } else if (event.type === "data_candidate_recorded") {
      if (dataCandidates.some(row => row.candidateId === event.candidateId)) {
        throw new Error(`Duplicate data candidate ${event.candidateId}.`);
      }
      dataCandidates.push({ ...event, ref });
    }
  }
  return {
    assignments,
    assignmentHistory,
    checkpoints,
    handoffs,
    decisions,
    gatePasses,
    verifications,
    dataCandidates,
  };
}

function executionTruthFor(workspaceRoot, assignment) {
  if (!assignment?.executionRunId) return null;
  if (!workspaceRoot
    || !existsSync(path.join(workspaceRoot, ".owlcoda/runkit/executions"))) {
    return {
      status: "missing",
      runId: assignment.executionRunId,
      lifecycle: null,
      closeoutDecision: null,
      closeoutTrusted: false,
      leaseState: "missing",
      leaseWorkItemId: assignment.executionWorkItemId,
      issues: ["execution_not_found"],
    };
  }
  const control = inspectProjectControlState({ workspaceRoot });
  const execution = control.executions.find(row => row.runId === assignment.executionRunId);
  if (!execution) {
    return {
      status: "missing",
      runId: assignment.executionRunId,
      lifecycle: null,
      closeoutDecision: null,
      closeoutTrusted: false,
      leaseState: "missing",
      leaseWorkItemId: assignment.executionWorkItemId,
      issues: ["execution_not_found"],
    };
  }
  const lease = execution.lease;
  let leaseState = "missing";
  if (lease.activeWorkItemIds.includes(assignment.executionWorkItemId)) leaseState = "active";
  else if (lease.releasedWorkItemIds.includes(assignment.executionWorkItemId)) leaseState = "released";
  else if (lease.preservedInactiveWorkItemIds.includes(assignment.executionWorkItemId)) leaseState = "preserved_inactive";
  const issues = [
    ...execution.issues,
    ...lease.issues,
    ...(leaseState === "missing" ? ["execution_lease_work_item_missing"] : []),
  ];
  return {
    status: issues.length === 0 ? "bound" : "invalid",
    runId: assignment.executionRunId,
    lifecycle: execution.lifecycle,
    closeoutDecision: execution.closeout?.decision ?? null,
    closeoutTrusted: execution.closeout?.trusted === true,
    leaseState,
    leaseWorkItemId: assignment.executionWorkItemId,
    issues,
  };
}

function compareIdentifiers(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareIdentifiers);
}

function sortWorkItemIds(ids, priority) {
  return [...new Set(ids)].sort((left, right) => (
    (priority.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (priority.get(right) ?? Number.MAX_SAFE_INTEGER)
    || compareIdentifiers(left, right)
  ));
}

function dominantGapCandidateOrder(status) {
  const byId = new Map(status.workItems.map(row => [row.workItemId, row]));
  const failed = status.workItems
    .filter(row => row.status === "failed")
    .map(row => row.workItemId)
    .sort(compareIdentifiers);
  const failedIds = new Set(failed);
  const critical = status.criticalWorkItems
    .filter(workItemId => (
      byId.get(workItemId)?.status !== "completed"
      && !failedIds.has(workItemId)
    ));
  const criticalIds = new Set([...failed, ...critical]);
  const remaining = status.workItems
    .filter(row => row.status !== "completed" && !criticalIds.has(row.workItemId))
    .map(row => row.workItemId)
    .sort(compareIdentifiers);
  return [...failed, ...critical, ...remaining];
}

function unresolvedRootWorkItemIds(workItemId, byId, priority, visiting = new Set()) {
  const row = byId.get(workItemId);
  if (!row || visiting.has(workItemId)) return [workItemId];
  const nextVisiting = new Set(visiting).add(workItemId);
  const unresolved = row.unresolvedDependencies.filter(id => byId.has(id));
  if (unresolved.length === 0) return [workItemId];
  return sortWorkItemIds(
    unresolved.flatMap(id => unresolvedRootWorkItemIds(id, byId, priority, nextVisiting)),
    priority,
  );
}

function openDecisionsForWorkItem(row, openDecisions) {
  const decisionRefs = new Set([
    ...row.decisionRefs,
    ...row.blockers
      .filter(ref => ref.startsWith("decision:"))
      .map(ref => ref.slice("decision:".length)),
  ]);
  return openDecisions
    .filter(decision => (
      decisionRefs.has(decision.decisionId)
      || decision.blockingWorkItemIds.includes(row.workItemId)
    ))
    .sort((left, right) => compareIdentifiers(left.decisionId, right.decisionId));
}

function workItemGapReason(row) {
  if (row.status === "failed") {
    return row.summary
      ?? (row.executionTruth?.issues?.length > 0 ? "Execution truth is invalid." : null)
      ?? "Work item failed.";
  }
  return row.blockers.length > 0 ? row.summary ?? "Work item is blocked." : null;
}

function nextActionForGap(gap, status) {
  if (gap.kind === "decision") {
    return { action: `Resolve ${gap.id}`, actorId: gap.agentId };
  }
  if (gap.kind === "deferred_verification") {
    return { action: `Run deferred verification ${gap.id}`, actorId: gap.agentId };
  }
  if (gap.kind === "integration_gate") {
    return { action: `Review integration gate ${gap.id}`, actorId: null };
  }
  if (gap.kind === "none") return { action: null, actorId: null };

  const workItem = status.workItems.find(row => row.workItemId === gap.workItemId);
  if (workItem?.pendingHandoff) {
    return {
      action: `Accept handoff ${gap.workItemId}`,
      actorId: workItem.pendingHandoff.toAgentId,
    };
  }
  if (!workItem?.agentId) return { action: `Assign ${gap.workItemId}`, actorId: null };
  if (workItem.nextAction) {
    return { action: workItem.nextAction, actorId: workItem.agentId };
  }
  if (workItem.status === "failed") {
    return { action: `Rework ${gap.workItemId}`, actorId: workItem.agentId };
  }
  if (workItem.status === "verifying") {
    return { action: `Verify ${gap.workItemId}`, actorId: workItem.agentId };
  }
  if (workItem.status === "ready_to_integrate") {
    return { action: `Integrate ${gap.workItemId}`, actorId: workItem.agentId };
  }
  return { action: `Continue ${gap.workItemId}.`, actorId: workItem.agentId };
}

function singleLine(value) {
  return String(value).replace(/\s+/gu, " ").trim();
}

function gapLabel(gap) {
  if (gap.kind === "none") return "none";
  if (gap.kind === "decision") return `decision ${gap.id} (${gap.title})`;
  if (gap.kind === "deferred_verification") {
    return `deferred verification ${gap.id}`;
  }
  if (gap.kind === "failed_work") return `failed work ${gap.workItemId} (${gap.title})`;
  if (gap.kind === "work_item") return `work item ${gap.workItemId} (${gap.title})`;
  return `integration gate ${gap.id} (${gap.title})`;
}

function buildProjectHeadline(gap, next) {
  const owner = gap.agentId ?? next.actorId ?? "unassigned";
  const blocker = gap.reason ?? "none";
  const action = next.action ?? "none";
  const normalizedAction = singleLine(action);
  const actionTerminator = /[.!?。！？]$/u.test(normalizedAction) ? "" : ".";
  return `Dominant gap: ${singleLine(gapLabel(gap))}; owner: ${singleLine(owner)}; `
    + `blocker: ${singleLine(blocker)}; next: ${normalizedAction}${actionTerminator}`;
}

function deriveProjectDriverSummary(status) {
  const byId = new Map(status.workItems.map(row => [row.workItemId, row]));
  const priority = new Map(
    dominantGapCandidateOrder(status).map((workItemId, index) => [workItemId, index]),
  );
  let gap = null;

  for (const candidateId of dominantGapCandidateOrder(status)) {
    const rootId = unresolvedRootWorkItemIds(candidateId, byId, priority)[0];
    const root = byId.get(rootId);
    if (!root) continue;
    if (root.pendingHandoff) {
      gap = {
        kind: "work_item",
        id: root.workItemId,
        title: root.title,
        workItemId: root.workItemId,
        agentId: root.pendingHandoff.toAgentId,
        reason: root.pendingHandoff.summary,
        truthRefs: uniqueSorted(root.truthRefs),
      };
    } else if (openDecisionsForWorkItem(root, status.openDecisions).length > 0) {
      const decisions = openDecisionsForWorkItem(root, status.openDecisions);
      const decision = decisions[0];
      gap = {
        kind: "decision",
        id: decision.decisionId,
        title: decision.title,
        workItemId: root.workItemId,
        agentId: decision.ownerAgentId,
        reason: decision.question,
        truthRefs: uniqueSorted([...decision.truthRefs, ...root.truthRefs]),
      };
    } else {
      gap = {
        kind: root.status === "failed" ? "failed_work" : "work_item",
        id: root.workItemId,
        title: root.title,
        workItemId: root.workItemId,
        agentId: root.agentId,
        reason: workItemGapReason(root),
        truthRefs: uniqueSorted(root.truthRefs),
      };
    }
    break;
  }

  if (!gap && status.workItems.every(row => row.status === "completed")) {
    const firstUnpassedGate = status.integrationGates
      .find(gate => gate.status !== "passed") ?? null;
    const gateDecisions = firstUnpassedGate
      ? status.openDecisions
        .filter(decision => firstUnpassedGate.unresolvedDecisionIds.includes(decision.decisionId))
        .sort((left, right) => compareIdentifiers(left.decisionId, right.decisionId))
      : [];
    if (gateDecisions.length > 0) {
      const decision = gateDecisions[0];
      gap = {
        kind: "decision",
        id: decision.decisionId,
        title: decision.title,
        workItemId: null,
        agentId: decision.ownerAgentId,
        reason: decision.question,
        truthRefs: uniqueSorted([...decision.truthRefs, ...firstUnpassedGate.truthRefs]),
      };
    } else if (firstUnpassedGate?.unresolvedVerificationIds.length > 0) {
      const verification = status.deferredVerifications.find(row => (
        row.verificationId === firstUnpassedGate.unresolvedVerificationIds[0]
      ));
      gap = {
        kind: "deferred_verification",
        id: verification.verificationId,
        title: `Deferred verification ${verification.verificationId}`,
        workItemId: verification.workItemId,
        agentId: verification.ownerAgentId,
        reason: verification.reason,
        truthRefs: uniqueSorted([
          ...verification.truthRefs,
          ...firstUnpassedGate.truthRefs,
        ]),
      };
    } else if (firstUnpassedGate) {
      gap = {
        kind: "integration_gate",
        id: firstUnpassedGate.gateId,
        title: firstUnpassedGate.title,
        workItemId: null,
        agentId: null,
        reason: "Integration gate has not passed.",
        truthRefs: uniqueSorted(firstUnpassedGate.truthRefs),
      };
    } else if (status.openDecisions.length > 0) {
      const decision = status.openDecisions[0];
      gap = {
        kind: "decision",
        id: decision.decisionId,
        title: decision.title,
        workItemId: null,
        agentId: decision.ownerAgentId,
        reason: decision.question,
        truthRefs: uniqueSorted(decision.truthRefs),
      };
    }
  }

  if (!gap) {
    gap = {
      kind: "none",
      id: null,
      title: null,
      workItemId: null,
      agentId: null,
      reason: null,
      truthRefs: uniqueSorted([
        "project/definition.json",
        ...status.integrationGates.flatMap(gate => gate.truthRefs),
      ]),
    };
  }

  const next = nextActionForGap(gap, status);
  return {
    headline: buildProjectHeadline(gap, next),
    dominantGap: gap,
    nextAction: next.action,
    nextActorId: next.actorId,
  };
}

function projectStatus(definition, records, workspaceRoot = null) {
  const state = projectEvents(definition, records);
  const completed = new Set();
  for (const [id, checkpoint] of state.checkpoints) {
    if (checkpoint.state === "completed") completed.add(id);
  }
  let workItems = definition.workItems.map((item) => {
    const assignment = state.assignments.get(item.id) ?? null;
    const checkpoint = state.checkpoints.get(item.id) ?? null;
    const handoff = state.handoffs.get(item.id) ?? null;
    const latestFact = latestEventFact(checkpoint, handoff);
    const activeHandoff = handoff
      && handoff.assignmentId === assignment?.assignmentId
      && handoff.fromAgentId === assignment?.agentId
      ? handoff
      : null;
    const pendingHandoff = activeHandoff && latestFact?.eventId === activeHandoff.eventId
      ? pendingHandoffProjection(activeHandoff)
      : null;
    const executionTruth = executionTruthFor(workspaceRoot, assignment);
    const unresolvedDependencies = item.dependencies.filter(id => !completed.has(id));
    let status = "planned";
    if (assignment) status = unresolvedDependencies.length > 0 ? "waiting_dependency" : "active";
    if (pendingHandoff) status = "planned";
    if (latestFact?.type === "checkpoint_recorded") status = checkpoint.state;
    if (executionTruth && (executionTruth.status !== "bound"
      || (executionTruth.lifecycle === "closed"
        && executionTruth.closeoutDecision !== "accepted"))) {
      status = "failed";
    }
    const measured = item.measurable
      ? {
          kind: "measured_units",
          unit: item.measurable.unit,
          completed: checkpoint?.completedUnits ?? 0,
          total: item.measurable.total,
        }
      : { kind: "state_only" };
    const history = state.assignmentHistory.get(item.id).map(row => ({
      assignmentId: row.assignmentId,
      agentId: row.agentId,
      occurredAt: row.occurredAt,
      supersedesAssignmentId: row.supersedesAssignmentId ?? null,
      executionRunId: row.executionRunId ?? null,
      truthRef: row.ref,
    }));
    const truthRefs = [
      "project/definition.json",
      ...history.map(row => row.truthRef),
      ...(checkpoint ? [checkpoint.ref] : []),
      ...(handoff ? [handoff.ref] : []),
    ];
    return {
      workItemId: item.id,
      title: item.title,
      milestoneId: item.milestoneId,
      workstreamId: item.workstreamId,
      status,
      agentId: assignment?.agentId ?? null,
      assignmentId: assignment?.assignmentId ?? null,
      executionRunId: assignment?.executionRunId ?? null,
      executionWorkItemId: assignment?.executionWorkItemId ?? null,
      executionTruth,
      dependencies: [...item.dependencies],
      unresolvedDependencies,
      blockers: latestFact?.type === "checkpoint_recorded"
        ? checkpoint.blockerRefs
        : unresolvedDependencies.map(id => `work-item:${id}`),
      decisionRefs: latestFact?.type === "checkpoint_recorded" ? checkpoint.decisionRefs : [],
      progress: measured,
      summary: latestFact?.summary ?? null,
      nextAction: latestFact?.nextAction ?? null,
      pendingHandoff,
      lastCheckpointAt: checkpoint?.occurredAt ?? null,
      evidenceRefs: latestFact?.evidenceRefs ?? [],
      assignmentHistory: history,
      truthRefs,
    };
  });
  const openDecisions = [...state.decisions.values()]
    .filter(row => row.resolved === null)
    .map(row => ({
      decisionId: row.opened.decisionId,
      title: row.opened.title,
      question: row.opened.question,
      ownerAgentId: row.opened.ownerAgentId,
      blockingWorkItemIds: [...row.opened.blockingWorkItemIds],
      options: [...row.opened.options],
      truthRefs: [row.opened.ref],
    }))
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
  const openDecisionIds = new Set(openDecisions.map(row => row.decisionId));
  workItems = workItems.map((row) => {
    const terminal = ["completed", "failed"].includes(row.status);
    const currentDecisionIds = terminal
      ? []
      : openDecisionsForWorkItem(row, openDecisions).map(decision => decision.decisionId);
    const checkpointDecisionIds = uniqueSorted([
      ...row.decisionRefs,
      ...row.blockers
        .filter(ref => ref.startsWith("decision:"))
        .map(ref => ref.slice("decision:".length)),
    ]);
    const staleDecisionRefs = checkpointDecisionIds.filter(id => !openDecisionIds.has(id));
    const currentBlockers = row.blockers.filter(ref => (
      !ref.startsWith("decision:") || openDecisionIds.has(ref.slice("decision:".length))
    ));
    for (const decisionId of currentDecisionIds) {
      const blockerRef = `decision:${decisionId}`;
      if (!currentBlockers.includes(blockerRef)) currentBlockers.push(blockerRef);
    }
    const underlyingStatus = row.assignmentId === null
      ? "planned"
      : row.unresolvedDependencies.length > 0 ? "waiting_dependency" : "active";
    let status = row.status;
    if (!row.pendingHandoff && !terminal) {
      status = currentDecisionIds.length > 0
        ? "waiting_decision"
        : row.status === "waiting_decision" ? underlyingStatus : row.status;
    }
    return {
      ...row,
      status,
      blockers: currentBlockers,
      decisionRefs: row.decisionRefs.filter(id => openDecisionIds.has(id)),
      summary: staleDecisionRefs.length > 0 ? null : row.summary,
      nextAction: staleDecisionRefs.length > 0 ? null : row.nextAction,
    };
  });
  const byId = new Map(workItems.map(row => [row.workItemId, row]));
  const resolvedDecisions = [...state.decisions.values()]
    .filter(row => row.resolved !== null)
    .map(row => ({
      decisionId: row.opened.decisionId,
      resolution: row.resolved.resolution,
      rationale: row.resolved.rationale,
      evidenceRefs: [...row.resolved.evidenceRefs],
      truthRefs: [row.opened.ref, row.resolved.ref],
    }))
    .sort((left, right) => left.decisionId.localeCompare(right.decisionId));
  const resolvedDecisionIds = new Set(resolvedDecisions.map(row => row.decisionId));
  const gateOrder = new Map(
    definition.integrationGates.map((gate, index) => [gate.id, index]),
  );
  const deferredVerifications = [...state.verifications.values()]
    .map((row) => ({
      verificationId: row.deferred.verificationId,
      workItemId: row.deferred.workItemId,
      ownerAgentId: row.deferred.ownerAgentId,
      checkIds: [...row.deferred.checkIds],
      reason: row.deferred.reason,
      dueGateId: row.deferred.dueGateId,
      status: row.closed ? "closed" : "open",
      disposition: row.closed?.disposition ?? null,
      summary: row.closed?.summary ?? null,
      evidenceRefs: row.closed ? [...row.closed.evidenceRefs] : [],
      decisionIds: row.closed ? [...row.closed.decisionIds] : [],
      truthRefs: [row.deferred.ref, ...(row.closed ? [row.closed.ref] : [])],
    }))
    .sort((left, right) => (
      gateOrder.get(left.dueGateId) - gateOrder.get(right.dueGateId)
      || compareIdentifiers(left.verificationId, right.verificationId)
    ));
  const openDeferredVerifications = deferredVerifications.filter(row => row.status === "open");
  const openDeferredVerificationIds = openDeferredVerifications
    .map(row => row.verificationId);
  const integrationGates = definition.integrationGates.map((gate) => {
    const unresolvedWorkItemIds = gate.requiredWorkItemIds.filter(id => byId.get(id).status !== "completed");
    const unresolvedDecisionIds = gate.requiredDecisionIds.filter(id => !resolvedDecisionIds.has(id));
    const gateVerifications = deferredVerifications.filter(row => row.dueGateId === gate.id);
    const unresolvedVerificationIds = gateVerifications
      .filter(row => row.status === "open")
      .map(row => row.verificationId);
    const pass = state.gatePasses.get(gate.id) ?? null;
    let status = unresolvedWorkItemIds.length === 0
      && unresolvedDecisionIds.length === 0
      && unresolvedVerificationIds.length === 0
      ? "ready"
      : "blocked";
    if (pass) {
      if (status !== "ready") throw new Error(`Integration gate ${gate.id} was passed before prerequisites.`);
      status = "passed";
    }
    return {
      gateId: gate.id,
      title: gate.title,
      status,
      unresolvedWorkItemIds,
      unresolvedDecisionIds,
      unresolvedVerificationIds,
      evidenceRefs: pass?.evidenceRefs ?? [],
      truthRefs: [
        "project/definition.json",
        ...gateVerifications.flatMap(row => row.truthRefs),
        ...(pass ? [pass.ref] : []),
      ],
    };
  });
  const stateNames = [
    "planned", "active", "waiting_dependency", "waiting_decision", "verifying",
    "ready_to_integrate", "completed", "failed",
  ];
  const counts = Object.fromEntries(stateNames.map(name => [
    name,
    workItems.filter(row => row.status === name).length,
  ]));
  counts.total = workItems.length;
  const orderedCounts = { total: counts.total };
  for (const name of stateNames) orderedCounts[name] = counts[name];
  const readyQueue = workItems
    .filter(row => row.status === "planned"
      && row.assignmentId === null
      && row.pendingHandoff === null
      && row.unresolvedDependencies.length === 0)
    .map(row => row.workItemId)
    .sort();
  const downstream = new Map(workItems.map(row => [row.workItemId, 0]));
  for (const item of workItems) {
    for (const dependency of item.dependencies) {
      downstream.set(dependency, downstream.get(dependency) + 1);
    }
  }
  const decisionBlocked = new Set(openDecisions.flatMap(row => row.blockingWorkItemIds));
  const criticalWorkItems = workItems
    .filter(row => row.status !== "completed" && (downstream.get(row.workItemId) > 0 || decisionBlocked.has(row.workItemId)))
    .sort((left, right) => (
      downstream.get(right.workItemId) - downstream.get(left.workItemId)
      || left.workItemId.localeCompare(right.workItemId)
    ))
    .map(row => row.workItemId);
  const agents = [...new Set(workItems.map(row => row.agentId).filter(Boolean))]
    .sort()
    .map(agentId => {
      const assigned = workItems.filter(row => row.agentId === agentId);
      const nextActions = assigned.map(row => row.nextAction).filter(Boolean);
      return {
        agentId,
        activeWorkItemIds: assigned.filter(row => ["active", "verifying", "ready_to_integrate"].includes(row.status)).map(row => row.workItemId).sort(),
        waitingWorkItemIds: assigned.filter(row => ["waiting_dependency", "waiting_decision"].includes(row.status)).map(row => row.workItemId).sort(),
        completedWorkItemIds: assigned.filter(row => row.status === "completed").map(row => row.workItemId).sort(),
        failedWorkItemIds: assigned.filter(row => row.status === "failed").map(row => row.workItemId).sort(),
        nextActions,
        lastCheckpointAt: assigned.map(row => row.lastCheckpointAt).filter(Boolean).sort().at(-1) ?? null,
      };
    });
  const aggregateGroup = (definitions, foreignKey, idKey) => definitions.map(group => {
    const items = workItems.filter(row => row[foreignKey] === group.id);
    return {
      [idKey]: group.id,
      title: group.title,
      totalWorkItems: items.length,
      completedWorkItems: items.filter(row => row.status === "completed").length,
      blockedWorkItems: items.filter(row => ["waiting_dependency", "waiting_decision", "failed"].includes(row.status)).map(row => row.workItemId).sort(),
    };
  });
  const dataCandidates = state.dataCandidates.map((row) => {
    const missingFields = [
      ...(row.decisionRef === null ? ["decisionRef"] : []),
      ...(row.outcomeRef === null ? ["outcomeRef"] : []),
      ...(row.rights === "unknown" ? ["rights"] : []),
      ...(row.verificationRefs.length === 0 ? ["verificationRefs"] : []),
    ].sort();
    return {
      candidateId: row.candidateId,
      sourceRef: row.sourceRef,
      rights: row.rights,
      inputRef: row.inputRef,
      outputRef: row.outputRef,
      decisionRef: row.decisionRef,
      verificationRefs: [...row.verificationRefs],
      outcomeRef: row.outcomeRef,
      version: row.version,
      admissionStatus: missingFields.length === 0 ? "eligible_candidate" : "incomplete",
      missingFields,
      truthRefs: [row.ref],
    };
  });
  let overall = "planned";
  if (workItems.every(row => row.status === "completed")
    && integrationGates.every(row => row.status === "passed")
    && openDecisions.length === 0) overall = "completed";
  else if (openDecisions.length > 0 || workItems.some(row => row.status === "failed")) overall = "active_with_blockers";
  else if (workItems.some(row => row.status !== "planned" || row.pendingHandoff !== null)) overall = "active";
  const status = {
    schemaVersion: STATUS_SCHEMA,
    status: "team_project_status",
    projectId: definition.projectId,
    objective: definition.objective,
    overall,
    counts: orderedCounts,
    milestones: aggregateGroup(definition.milestones, "milestoneId", "milestoneId"),
    workstreams: aggregateGroup(definition.workstreams, "workstreamId", "workstreamId"),
    workItems,
    agents,
    readyQueue,
    criticalWorkItems,
    openDecisions,
    resolvedDecisions,
    deferredVerifications,
    openDeferredVerificationIds,
    integrationGates,
    dataCandidates,
    projectTruthHash: sha256(canonical({ definition, events: records.map(row => row.event) })),
    authorizationGranted: false,
  };
  return { ...status, ...deriveProjectDriverSummary(status) };
}

function validateEventAgainstState(event, definition, records, workspaceRoot) {
  const normalized = validateEventShape(event, definition);
  const state = projectEvents(definition, records);
  const status = projectStatus(definition, records, workspaceRoot);
  const workItem = definition.workItems.find(row => row.id === normalized.workItemId);
  if (normalized.type === "agent_assigned") {
    if (normalized.executionRunId !== undefined) {
      const executionTruth = executionTruthFor(workspaceRoot, normalized);
      if (executionTruth.status !== "bound") {
        throw new Error(
          `Agent assignment execution binding is not valid: ${executionTruth.issues.join(", ")}.`,
        );
      }
    }
    const current = state.assignments.get(normalized.workItemId) ?? null;
    if (current && normalized.supersedesAssignmentId !== current.assignmentId) {
      throw new Error(`Assignment must supersede current assignment ${current.assignmentId}.`);
    }
    if (!current && normalized.supersedesAssignmentId !== undefined) {
      throw new Error("supersedesAssignmentId has no current assignment.");
    }
    const currentProjection = status.workItems.find(
      row => row.workItemId === normalized.workItemId,
    );
    if (currentProjection?.pendingHandoff
      && normalized.agentId !== currentProjection.pendingHandoff.toAgentId) {
      throw new Error(
        `Assignment must accept pending handoff target ${currentProjection.pendingHandoff.toAgentId}.`,
      );
    }
    for (const projected of status.workItems) {
      if (projected.workItemId === normalized.workItemId
        || projected.assignmentId === null
        || ["completed", "failed"].includes(projected.status)) continue;
      const other = definition.workItems.find(row => row.id === projected.workItemId);
      if (pathsOverlap(workItem.ownedPaths, other.ownedPaths)) {
        throw new Error(
          `Owned paths overlap active assignment ${projected.assignmentId}: ${normalized.workItemId} <> ${projected.workItemId}.`,
        );
      }
    }
  } else if (normalized.type === "checkpoint_recorded") {
    const current = state.assignments.get(normalized.workItemId);
    if (!current || current.assignmentId !== normalized.assignmentId) {
      throw new Error("Checkpoint must bind the current assignment.");
    }
    if (normalized.state !== "completed") {
      const invalidatedGate = definition.integrationGates.find(gate => (
        gate.requiredWorkItemIds.includes(normalized.workItemId)
        && state.gatePasses.has(gate.id)
      ));
      if (invalidatedGate) {
        throw new Error(
          `Checkpoint cannot invalidate passed integration gate ${invalidatedGate.id}.`,
        );
      }
    }
    const unresolved = status.workItems.find(row => row.workItemId === normalized.workItemId).unresolvedDependencies;
    if (normalized.state === "completed" && unresolved.length > 0) {
      throw new Error(`Completed checkpoint has unresolved dependencies: ${unresolved.join(", ")}.`);
    }
    const executionTruth = status.workItems.find(
      row => row.workItemId === normalized.workItemId,
    ).executionTruth;
    if (normalized.state === "completed" && executionTruth
      && !(executionTruth.status === "bound"
        && executionTruth.lifecycle === "closed"
        && executionTruth.closeoutTrusted
        && executionTruth.closeoutDecision === "accepted"
        && new Set(["released", "preserved_inactive"]).has(executionTruth.leaseState))) {
      throw new Error("Completed checkpoint bound execution is not closed and accepted with a released lease.");
    }
    if (workItem.measurable) {
      if (normalized.completedUnits === undefined) {
        throw new Error("Measured work item checkpoint requires completedUnits.");
      }
      if (normalized.completedUnits > workItem.measurable.total) {
        throw new Error("Checkpoint completedUnits exceeds measurable total.");
      }
      if (normalized.state === "completed" && normalized.completedUnits !== workItem.measurable.total) {
        throw new Error("Completed measured work item must reach its total units.");
      }
    } else if (normalized.completedUnits !== undefined) {
      throw new Error("Unmeasured work item cannot claim completedUnits.");
    }
  } else if (normalized.type === "handoff_recorded") {
    const current = state.assignments.get(normalized.workItemId);
    const projected = status.workItems.find(row => row.workItemId === normalized.workItemId);
    if (["completed", "failed"].includes(projected?.status)) {
      throw new Error("Handoff cannot target a completed or failed WorkItem.");
    }
    if (!current
      || current.assignmentId !== normalized.assignmentId
      || current.agentId !== normalized.fromAgentId) {
      throw new Error("Handoff must bind the current assignment and Agent.");
    }
  } else if (normalized.type === "decision_opened") {
    if (state.decisions.has(normalized.decisionId)) throw new Error(`Decision ${normalized.decisionId} already exists.`);
  } else if (normalized.type === "decision_resolved") {
    const decision = state.decisions.get(normalized.decisionId);
    if (!decision || decision.resolved) throw new Error(`Decision ${normalized.decisionId} is not open.`);
  } else if (normalized.type === "verification_deferred") {
    if (state.verifications.has(normalized.verificationId)) {
      throw new Error(`Deferred verification ${normalized.verificationId} already exists.`);
    }
    if (state.gatePasses.has(normalized.dueGateId)) {
      throw new Error(
        `Deferred verification cannot target integration gate ${normalized.dueGateId}; gate already passed.`,
      );
    }
  } else if (normalized.type === "verification_closed") {
    const verification = state.verifications.get(normalized.verificationId);
    if (!verification || verification.closed) {
      throw new Error(`Deferred verification ${normalized.verificationId} is not open.`);
    }
    if (normalized.disposition === "no_longer_required") {
      for (const decisionId of normalized.decisionIds) {
        const decision = state.decisions.get(decisionId);
        if (!decision?.resolved) {
          throw new Error(
            `No-longer-required deferred verification requires resolved decision ${decisionId}.`,
          );
        }
      }
    }
  } else if (normalized.type === "integration_gate_passed") {
    const gate = status.integrationGates.find(row => row.gateId === normalized.gateId);
    if (state.gatePasses.has(normalized.gateId)) {
      throw new Error(`Integration gate ${normalized.gateId} has already passed.`);
    }
    if (gate.status !== "ready") throw new Error(`Integration gate ${normalized.gateId} is not ready.`);
  } else if (normalized.type === "data_candidate_recorded") {
    if (state.dataCandidates.some(row => row.candidateId === normalized.candidateId)) {
      throw new Error(`Data candidate ${normalized.candidateId} already exists.`);
    }
  }
  return normalized;
}

export function initializeTeamProjectV1({ workspaceRoot, definition }) {
  const normalized = validateDefinition(definition);
  if (!existsSync(workspaceRoot)) mkdirSync(workspaceRoot, { recursive: true });
  const { root, projectRoot: rootPath } = projectRoot(workspaceRoot);
  assertRealProjectTree(root, rootPath);
  assertRealProjectTree(root, path.join(rootPath, "events"));
  const definitionPath = path.join(rootPath, "definition.json");
  if (existsSync(definitionPath)) {
    const existing = readRegularJson(definitionPath, "Team project definition");
    if (canonical(existing) !== canonical(normalized)) {
      throw new Error("Team project definition is immutable and differs.");
    }
    return {
      status: "team_project_initialized",
      exitCode: 0,
      projectId: normalized.projectId,
      definitionPath: relativeToWorkspace(root, definitionPath),
      definitionSha256: sha256(canonical(normalized)),
      resumed: true,
      authorizationGranted: false,
    };
  }
  writeJsonExclusiveAtomically(definitionPath, normalized);
  return {
    status: "team_project_initialized",
    exitCode: 0,
    projectId: normalized.projectId,
    definitionPath: relativeToWorkspace(root, definitionPath),
    definitionSha256: sha256(canonical(normalized)),
    resumed: false,
    authorizationGranted: false,
  };
}

export function appendTeamProjectEventV1({ workspaceRoot, event }) {
  const loaded = loadProject(workspaceRoot);
  return withProjectLock(loaded.projectRoot, () => {
    const refreshed = loadProject(workspaceRoot);
    const shaped = validateEventShape(event, refreshed.definition);
    const eventPath = path.join(refreshed.projectRoot, "events", `${shaped.eventId}.json`);
    if (existsSync(eventPath)) {
      const existing = readRegularJson(eventPath, `Team project event ${shaped.eventId}`);
      if (canonical(existing) !== canonical(shaped)) {
        throw new Error(`Team project immutable event differs: ${shaped.eventId}.`);
      }
      return {
        status: "team_project_event_recorded",
        exitCode: 0,
        eventId: shaped.eventId,
        eventPath: relativeToWorkspace(refreshed.root, eventPath),
        eventSha256: sha256(canonical(shaped)),
        resumed: true,
        authorizationGranted: false,
      };
    }
    const latest = refreshed.events.at(-1)?.event ?? null;
    if (latest && (shaped.occurredAt < latest.occurredAt
      || (shaped.occurredAt === latest.occurredAt
        && shaped.eventId.localeCompare(latest.eventId) <= 0))) {
      throw new Error(
        `Team project event must sort after the latest event ${latest.eventId}.`,
      );
    }
    const normalized = validateEventAgainstState(
      shaped,
      refreshed.definition,
      refreshed.events,
      refreshed.root,
    );
    writeJsonExclusiveAtomically(eventPath, normalized);
    return {
      status: "team_project_event_recorded",
      exitCode: 0,
      eventId: normalized.eventId,
      eventPath: relativeToWorkspace(refreshed.root, eventPath),
      eventSha256: sha256(canonical(normalized)),
      resumed: false,
      authorizationGranted: false,
    };
  });
}

export function assignTeamProjectV1({
  workspaceRoot,
  assignmentId,
  occurredAt,
  workItemId,
  agentId,
  supersedesAssignmentId,
  executionRunId,
  executionWorkItemId,
}) {
  safeIdentifier(assignmentId, "assignmentId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `assignment-${assignmentId}`,
    type: "agent_assigned",
    occurredAt,
    assignmentId,
    workItemId,
    agentId,
  };
  if (supersedesAssignmentId !== undefined) {
    event.supersedesAssignmentId = supersedesAssignmentId;
  }
  if (executionRunId !== undefined) event.executionRunId = executionRunId;
  if (executionWorkItemId !== undefined) event.executionWorkItemId = executionWorkItemId;

  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  if (recorded.resumed) {
    const current = status.workItems.find(row => row.workItemId === workItemId);
    if (current?.assignmentId !== assignmentId) {
      throw new Error(
        `Cannot resume historical/superseded assignment ${assignmentId}; `
        + `current assignment=${current?.assignmentId ?? "none"}, `
        + `current owner=${current?.agentId ?? "none"}.`,
      );
    }
  }
  return {
    status: "team_project_assignment",
    assignmentId,
    workItemId,
    agentId,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    projectTruthHash: status.projectTruthHash,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function handoffTeamProjectV1({
  workspaceRoot,
  handoffId,
  occurredAt,
  assignmentId,
  workItemId,
  fromAgentId,
  toAgentId,
  summary,
  nextAction,
  evidenceRefs,
}) {
  safeIdentifier(handoffId, "handoffId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `handoff-${handoffId}`,
    type: "handoff_recorded",
    occurredAt,
    assignmentId,
    workItemId,
    fromAgentId,
    toAgentId,
    summary,
    evidenceRefs,
    nextAction,
  };
  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  const current = status.workItems.find(row => row.workItemId === workItemId);
  const pending = current?.pendingHandoff ?? null;
  if (recorded.resumed && (
    current?.assignmentId !== assignmentId
      || current?.agentId !== fromAgentId
      || pending?.eventId !== event.eventId
  )) {
    throw new Error(
      `Cannot resume historical/superseded handoff ${handoffId}; `
      + `current assignment=${current?.assignmentId ?? "none"}, `
      + `current owner=${current?.agentId ?? "none"}, `
      + `current pending target=${pending?.toAgentId ?? "none"}.`,
    );
  }
  return {
    status: "team_project_handoff",
    handoffId,
    assignmentId,
    workItemId,
    fromAgentId,
    toAgentId,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    pending: true,
    targetNextAction: pending?.nextAction ?? nextAction,
    projectTruthHash: status.projectTruthHash,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    projectNextAction: status.nextAction,
    projectNextActorId: status.nextActorId,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function openTeamProjectDecisionV1({
  workspaceRoot,
  decisionId,
  occurredAt,
  title,
  question,
  ownerAgentId,
  blockingWorkItemIds,
  options,
}) {
  safeIdentifier(decisionId, "decisionId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `decision-opened-${decisionId}`,
    type: "decision_opened",
    occurredAt,
    decisionId,
    title,
    question,
    ownerAgentId,
    blockingWorkItemIds,
    options,
  };
  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  if (recorded.resumed && !status.openDecisions.some(row => row.decisionId === decisionId)) {
    const resolved = status.resolvedDecisions.some(row => row.decisionId === decisionId);
    throw new Error(
      `Cannot resume historical decision ${decisionId}; `
      + (resolved ? "decision is already resolved." : "decision is not currently open."),
    );
  }
  return {
    status: "team_project_decision",
    operation: "opened",
    decisionId,
    ownerAgentId,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    projectTruthHash: status.projectTruthHash,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function resolveTeamProjectDecisionV1({
  workspaceRoot,
  decisionId,
  occurredAt,
  resolution,
  rationale,
  evidenceRefs,
}) {
  safeIdentifier(decisionId, "decisionId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `decision-resolved-${decisionId}`,
    type: "decision_resolved",
    occurredAt,
    decisionId,
    resolution,
    rationale,
    evidenceRefs,
  };
  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  if (recorded.resumed && !status.resolvedDecisions.some(row => row.decisionId === decisionId)) {
    throw new Error(`Cannot resume decision ${decisionId}; decision is not resolved.`);
  }
  return {
    status: "team_project_decision",
    operation: "resolved",
    decisionId,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    projectTruthHash: status.projectTruthHash,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function deferTeamProjectVerificationV1({
  workspaceRoot,
  verificationId,
  occurredAt,
  workItemId,
  ownerAgentId,
  checkIds,
  reason,
  dueGateId,
}) {
  safeIdentifier(verificationId, "verificationId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `verification-deferred-${verificationId}`,
    type: "verification_deferred",
    occurredAt,
    verificationId,
    workItemId,
    ownerAgentId,
    checkIds,
    reason,
    dueGateId,
  };
  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  const verification = status.deferredVerifications.find(
    row => row.verificationId === verificationId,
  );
  if (recorded.resumed && verification?.status !== "open") {
    throw new Error(`Cannot resume closed deferred verification ${verificationId}.`);
  }
  const gate = status.integrationGates.find(row => row.gateId === dueGateId);
  return {
    status: "team_project_verification",
    operation: "deferred",
    verificationId,
    verificationStatus: verification?.status ?? null,
    dueGateId,
    gateStatus: gate?.status ?? null,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    overall: status.overall,
    projectTruthHash: status.projectTruthHash,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    verificationCommandExecuted: false,
    gitWritePerformed: false,
    releaseWritePerformed: false,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function closeTeamProjectVerificationV1({
  workspaceRoot,
  verificationId,
  occurredAt,
  disposition,
  summary,
  evidenceRefs,
  decisionIds,
}) {
  safeIdentifier(verificationId, "verificationId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `verification-closed-${verificationId}`,
    type: "verification_closed",
    occurredAt,
    verificationId,
    disposition,
    summary,
    evidenceRefs,
    decisionIds,
  };
  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  const verification = status.deferredVerifications.find(
    row => row.verificationId === verificationId,
  );
  if (verification?.status !== "closed" || verification.disposition !== disposition) {
    throw new Error(`Cannot resume deferred verification close ${verificationId}.`);
  }
  const gate = status.integrationGates.find(row => row.gateId === verification.dueGateId);
  return {
    status: "team_project_verification",
    operation: "closed",
    verificationId,
    verificationStatus: verification.disposition,
    dueGateId: verification.dueGateId,
    gateStatus: gate?.status ?? null,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    overall: status.overall,
    projectTruthHash: status.projectTruthHash,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    verificationCommandExecuted: false,
    gitWritePerformed: false,
    releaseWritePerformed: false,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function integrateTeamProjectV1({
  workspaceRoot,
  gateId,
  occurredAt,
  summary,
  evidenceRefs,
}) {
  safeIdentifier(gateId, "gateId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `integration-gate-${gateId}`,
    type: "integration_gate_passed",
    occurredAt,
    gateId,
    summary,
    evidenceRefs,
  };
  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  const gate = status.integrationGates.find(row => row.gateId === gateId);
  return {
    status: "team_project_integration",
    gateId,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    gateStatus: gate?.status ?? null,
    overall: status.overall,
    projectTruthHash: status.projectTruthHash,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    gitWritePerformed: false,
    releaseWritePerformed: false,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function checkpointTeamProjectV1({
  workspaceRoot,
  checkpointId,
  occurredAt,
  assignmentId,
  workItemId,
  state,
  summary,
  completedUnits,
  evidenceRefs = [],
  blockerRefs = [],
  decisionRefs = [],
  nextAction = null,
  sourceFingerprint,
}) {
  safeIdentifier(checkpointId, "checkpointId");
  const event = {
    schemaVersion: EVENT_SCHEMA,
    eventId: `checkpoint-${checkpointId}`,
    type: "checkpoint_recorded",
    occurredAt,
    assignmentId,
    workItemId,
    state,
    summary,
    ...(completedUnits === undefined ? {} : { completedUnits }),
    evidenceRefs,
    blockerRefs,
    decisionRefs,
    nextAction,
    ...(sourceFingerprint === undefined ? {} : { sourceFingerprint }),
  };
  const recorded = appendTeamProjectEventV1({ workspaceRoot, event });
  const status = readTeamProjectStatusV1({ workspaceRoot });
  if (recorded.resumed) {
    const loaded = loadProject(workspaceRoot);
    const stateProjection = projectEvents(loaded.definition, loaded.events);
    const currentAssignment = stateProjection.assignments.get(workItemId) ?? null;
    const latestFact = latestEventFact(
      stateProjection.checkpoints.get(workItemId) ?? null,
      stateProjection.handoffs.get(workItemId) ?? null,
    );
    if (currentAssignment?.assignmentId !== assignmentId || latestFact?.eventId !== event.eventId) {
      throw new Error(
        `Cannot resume historical/superseded checkpoint ${checkpointId}; `
        + `current assignment=${currentAssignment?.assignmentId ?? "none"}, `
        + `current owner=${currentAssignment?.agentId ?? "none"}, `
        + `latest fact=${latestFact?.eventId ?? "none"}.`,
      );
    }
  }
  return {
    status: "team_project_checkpoint",
    checkpointId,
    assignmentId,
    workItemId,
    state,
    eventId: recorded.eventId,
    eventPath: recorded.eventPath,
    eventSha256: recorded.eventSha256,
    resumed: recorded.resumed,
    projectTruthHash: status.projectTruthHash,
    overall: status.overall,
    nextAction: status.nextAction,
    nextActorId: status.nextActorId,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function readTeamProjectStatusV1({ workspaceRoot }) {
  const loaded = loadProject(workspaceRoot);
  return {
    ...projectStatus(loaded.definition, loaded.events, loaded.root),
    exitCode: 0,
  };
}

export function buildTeamProjectTakeoverV1({ workspaceRoot, agentId }) {
  safeIdentifier(agentId, "agentId");
  const loaded = loadProject(workspaceRoot);
  const status = projectStatus(loaded.definition, loaded.events, loaded.root);
  const responsibilities = status.workItems.filter(row => row.agentId === agentId);
  const current = responsibilities.find(row => (
    ["active", "verifying", "ready_to_integrate"].includes(row.status)
    && row.pendingHandoff === null
  ))
    ?? responsibilities.find(row => !["completed", "failed"].includes(row.status))
    ?? responsibilities.at(-1)
    ?? null;
  const pendingForCurrent = current?.pendingHandoff ?? null;
  const pendingForAgent = status.workItems.find(row => (
    row.pendingHandoff?.toAgentId === agentId
  ))?.pendingHandoff ?? null;
  const pendingHandoff = pendingForCurrent ?? pendingForAgent;
  const checkpoints = loaded.events
    .filter(row => row.event.type === "checkpoint_recorded"
      && responsibilities.some(item => item.workItemId === row.event.workItemId))
    .map(row => ({ ...row.event, truthRef: row.ref }));
  const lastCheckpoint = checkpoints.at(-1) ?? null;
  const evidenceRefs = [...new Set([
    ...(lastCheckpoint?.evidenceRefs ?? []),
    ...(current?.evidenceRefs ?? []),
    ...(pendingHandoff?.evidenceRefs ?? []),
  ])].sort();
  const unresolvedDecisionsById = new Map();
  for (const decision of status.openDecisions) {
    if (decision.ownerAgentId === agentId
      || (current && openDecisionsForWorkItem(current, [decision]).length > 0)) {
      unresolvedDecisionsById.set(decision.decisionId, decision);
    }
  }
  const unresolvedDecisions = [...unresolvedDecisionsById.values()]
    .sort((left, right) => compareIdentifiers(left.decisionId, right.decisionId));
  const ownedDecision = status.openDecisions.find(row => (
    row.ownerAgentId === agentId
      && status.dominantGap.kind === "decision"
      && status.dominantGap.id === row.decisionId
  )) ?? status.openDecisions.find(row => row.ownerAgentId === agentId) ?? null;
  const blockingDecision = current
    ? openDecisionsForWorkItem(current, status.openDecisions)[0] ?? null
    : null;
  const deferredVerifications = status.deferredVerifications.filter(row => (
    row.status === "open" && row.ownerAgentId === agentId
  ));
  const ownedVerification = deferredVerifications[0] ?? null;
  let nextAction = null;
  if (pendingForAgent && !current) {
    nextAction = pendingForAgent.nextAction;
  } else if (pendingForCurrent) {
    nextAction = `Waiting for ${pendingForCurrent.toAgentId} to accept ${pendingForCurrent.workItemId}.`;
  } else if (ownedDecision) {
    nextAction = `Resolve ${ownedDecision.decisionId}`;
  } else if (blockingDecision) {
    nextAction = `Waiting for ${blockingDecision.ownerAgentId} to resolve ${blockingDecision.decisionId}.`;
  } else if (ownedVerification) {
    nextAction = `Run deferred verification ${ownedVerification.verificationId}`;
  } else if (current?.nextAction) {
    nextAction = current.nextAction;
  } else {
    nextAction = current && !["completed", "failed"].includes(current.status)
      ? `Continue ${current.workItemId}.`
      : current ? null : status.readyQueue[0] ? `Take ${status.readyQueue[0]}.` : null;
  }
  return {
    schemaVersion: "OwlCodaRunKitTeamProjectTakeoverV1",
    status: "team_project_takeover",
    projectId: status.projectId,
    objective: status.objective,
    overall: status.overall,
    projectHeadline: status.headline,
    dominantGap: status.dominantGap,
    projectNextAction: status.nextAction,
    projectNextActorId: status.nextActorId,
    agentId,
    currentResponsibility: current,
    allResponsibilities: responsibilities,
    pendingHandoff,
    lastAcceptedCheckpoint: lastCheckpoint
      ? {
          workItemId: lastCheckpoint.workItemId,
          assignmentId: lastCheckpoint.assignmentId,
          state: lastCheckpoint.state,
          summary: lastCheckpoint.summary,
          evidenceRefs: [...lastCheckpoint.evidenceRefs],
          occurredAt: lastCheckpoint.occurredAt,
          truthRef: lastCheckpoint.truthRef,
        }
      : null,
    unresolvedDecisions,
    deferredVerifications,
    dependencies: current?.unresolvedDependencies ?? [],
    evidenceRefs,
    nextAction,
    projectTruthHash: status.projectTruthHash,
    authorizationGranted: false,
    exitCode: 0,
  };
}

export function formatTeamProjectStatusHumanV1(status) {
  const nextAction = status.nextAction === null ? "none" : singleLine(status.nextAction);
  return [
    status.headline,
    `Project: ${status.projectId} — ${singleLine(status.objective)}`,
    `State: ${status.overall}`,
    `Work: ${status.counts.completed}/${status.counts.total} completed; ${status.counts.active} active; ${status.counts.waiting_dependency + status.counts.waiting_decision} waiting`,
    `Agents: ${status.agents.map(agent => agent.agentId).join(", ") || "none assigned"}`,
    `Open decisions: ${status.openDecisions.map(row => row.decisionId).join(", ") || "none"}`,
    `Deferred verification: ${status.openDeferredVerificationIds.length} open${
      status.openDeferredVerificationIds.length > 0
        ? ` (${status.openDeferredVerificationIds.join(", ")})`
        : ""
    }`,
    `Ready queue: ${status.readyQueue.join(", ") || "none"}`,
    `Next: ${nextAction}${status.nextActorId ? ` (owner ${status.nextActorId})` : ""}`,
    "",
  ].join("\n");
}

export function formatTeamProjectTakeoverHumanV1(takeover) {
  const responsibility = takeover.currentResponsibility;
  const agentNextAction = takeover.nextAction === null
    ? "none"
    : singleLine(takeover.nextAction);
  const projectNextAction = takeover.projectNextAction === null
    ? "none"
    : singleLine(takeover.projectNextAction);
  return [
    takeover.projectHeadline,
    `Project: ${takeover.projectId} — ${singleLine(takeover.objective)}`,
    `Agent: ${takeover.agentId}`,
    `Responsibility: ${responsibility?.workItemId ?? "none"}`,
    `Open decisions: ${takeover.unresolvedDecisions.map(row => row.decisionId).join(", ") || "none"}`,
    `Deferred verification: ${takeover.deferredVerifications
      .map(row => row.verificationId).join(", ") || "none"}`,
    `Pending handoff: ${takeover.pendingHandoff
      ? `${takeover.pendingHandoff.fromAgentId} -> ${takeover.pendingHandoff.toAgentId} for ${takeover.pendingHandoff.workItemId}`
      : "none"}`,
    `Agent next: ${agentNextAction}`,
    `Project next: ${projectNextAction}${takeover.projectNextActorId ? ` (owner ${takeover.projectNextActorId})` : ""}`,
    `State: ${takeover.overall}`,
    "",
  ].join("\n");
}
