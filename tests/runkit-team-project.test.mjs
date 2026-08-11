import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";
import {
  appendTeamProjectEventV1,
  buildTeamProjectTakeoverV1,
  initializeTeamProjectV1,
  readTeamProjectStatusV1,
} from "../scripts/runkit-contract/team-project.mjs";
import * as teamProject from "../scripts/runkit-contract/team-project.mjs";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function definition() {
  return {
    schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
    projectId: "runkit-017",
    objective: "Ship Agent-native multi-Agent project management",
    milestones: [
      { id: "m1", title: "Product core" },
      { id: "m2", title: "Release" },
    ],
    workstreams: [
      { id: "design", title: "Design", milestoneId: "m1" },
      { id: "runtime", title: "Runtime", milestoneId: "m1" },
      { id: "release", title: "Release", milestoneId: "m2" },
    ],
    workItems: [
      {
        id: "contract",
        title: "Freeze product contract",
        milestoneId: "m1",
        workstreamId: "design",
        dependencies: [],
        ownedPaths: ["docs/architecture/**"],
      },
      {
        id: "engine",
        title: "Implement team truth engine",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: [],
        ownedPaths: ["scripts/runkit-contract/**"],
        measurable: { unit: "acceptance_tests", total: 4 },
      },
      {
        id: "cli",
        title: "Expose Agent shortcuts",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: ["engine"],
        ownedPaths: ["integrations/codex/skills/owlcoda-runkit/**"],
      },
      {
        id: "docs",
        title: "Document team workflow",
        milestoneId: "m1",
        workstreamId: "design",
        dependencies: ["contract"],
        ownedPaths: ["packages/runkit/README.md"],
      },
      {
        id: "integrate",
        title: "Integrate and verify release",
        milestoneId: "m2",
        workstreamId: "release",
        dependencies: ["cli", "docs"],
        ownedPaths: ["packages/runkit/**"],
      },
    ],
    integrationGates: [{
      id: "release-ready",
      title: "All product work accepted",
      requiredWorkItemIds: ["cli", "docs", "integrate"],
      requiredDecisionIds: ["scope-decision"],
    }],
  };
}

function singleItemDefinition({ measurable = null, dependencies = [] } = {}) {
  return {
    schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
    projectId: "runkit-single",
    objective: "Complete one typed checkpoint slice",
    milestones: [{ id: "m1", title: "Delivery" }],
    workstreams: [{ id: "runtime", title: "Runtime", milestoneId: "m1" }],
    workItems: [{
      id: "x",
      title: "Complete x",
      milestoneId: "m1",
      workstreamId: "runtime",
      dependencies,
      ownedPaths: ["src/x/**"],
      ...(measurable ? { measurable } : {}),
    }],
    integrationGates: [{
      id: "done",
      title: "Done",
      requiredWorkItemIds: ["x"],
      requiredDecisionIds: [],
    }],
  };
}

function event(eventId, type, fields = {}) {
  const minute = String(Number(eventId.slice(-2)) % 60).padStart(2, "0");
  return {
    schemaVersion: "OwlCodaRunKitTeamProjectEventV1",
    eventId,
    type,
    occurredAt: `2026-08-08T00:${minute}:00.000Z`,
    ...fields,
  };
}

async function setup(projectDefinition = definition()) {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-team-project-"));
  const initialized = initializeTeamProjectV1({
    workspaceRoot: root,
    definition: projectDefinition,
  });
  assert.equal(initialized.status, "team_project_initialized");
  return root;
}

async function appendEvents(root, events) {
  for (const value of events) appendTeamProjectEventV1({ workspaceRoot: root, event: value });
}

async function eventFiles(root) {
  return (await readdir(path.join(root, ".owlcoda/runkit/project/events")))
    .filter(name => name.endsWith(".json"))
    .sort();
}

function fullCompletionEvents() {
  return [
    event("event-01", "agent_assigned", {
      assignmentId: "assign-contract",
      workItemId: "contract",
      agentId: "agent-design",
    }),
    event("event-02", "checkpoint_recorded", {
      assignmentId: "assign-contract",
      workItemId: "contract",
      state: "completed",
      summary: "Contract accepted.",
      evidenceRefs: ["receipt:contract"],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: null,
    }),
    event("event-03", "agent_assigned", {
      assignmentId: "assign-docs",
      workItemId: "docs",
      agentId: "agent-docs",
    }),
    event("event-04", "checkpoint_recorded", {
      assignmentId: "assign-docs",
      workItemId: "docs",
      state: "completed",
      summary: "Workflow documented.",
      evidenceRefs: ["receipt:docs"],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: null,
    }),
    event("event-05", "agent_assigned", {
      assignmentId: "assign-engine",
      workItemId: "engine",
      agentId: "agent-runtime",
    }),
    event("event-06", "checkpoint_recorded", {
      assignmentId: "assign-engine",
      workItemId: "engine",
      state: "completed",
      summary: "Engine completed.",
      completedUnits: 4,
      evidenceRefs: ["receipt:engine"],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: null,
    }),
    event("event-07", "agent_assigned", {
      assignmentId: "assign-cli",
      workItemId: "cli",
      agentId: "agent-cli",
    }),
    event("event-08", "checkpoint_recorded", {
      assignmentId: "assign-cli",
      workItemId: "cli",
      state: "completed",
      summary: "Agent shortcuts completed.",
      evidenceRefs: ["receipt:cli"],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: null,
    }),
    event("event-09", "agent_assigned", {
      assignmentId: "assign-integrate",
      workItemId: "integrate",
      agentId: "agent-release",
    }),
    event("event-10", "checkpoint_recorded", {
      assignmentId: "assign-integrate",
      workItemId: "integrate",
      state: "completed",
      summary: "Integration completed.",
      evidenceRefs: ["receipt:integrate"],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: null,
    }),
    event("event-11", "decision_opened", {
      decisionId: "scope-decision",
      title: "0.18 project scope",
      question: "Which project slice is authorized for this round?",
      ownerAgentId: "owner",
      blockingWorkItemIds: [],
      options: ["driver-summary", "formal-run"],
    }),
    event("event-12", "decision_resolved", {
      decisionId: "scope-decision",
      resolution: "driver-summary",
      rationale: "The project driver is the current product slice.",
      evidenceRefs: ["decision-record:scope"],
    }),
  ];
}

async function treeHash(root) {
  const projectRoot = path.join(root, ".owlcoda/runkit/project");
  const names = [];
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else names.push(relative);
    }
  }
  await walk(projectRoot);
  const hash = createHash("sha256");
  for (const name of names.sort()) {
    hash.update(name);
    hash.update(await readFile(path.join(projectRoot, name)));
  }
  return hash.digest("hex");
}

async function projectSnapshot(root) {
  return {
    tree: await treeHash(root),
    events: await eventFiles(root),
    truth: readTeamProjectStatusV1({ workspaceRoot: root }).projectTruthHash,
  };
}

function directHandoffArgs(root, {
  handoffId,
  at,
  assignmentId,
  workItemId,
  fromAgentId,
  toAgentId,
  summary,
  nextAction,
  evidenceRefs,
}, json = false) {
  const args = [
    "project", "handoff", "--workspace", root,
    "--handoff-id", handoffId,
    "--at", at,
    "--assignment-id", assignmentId,
    "--work-item", workItemId,
    "--from-agent", fromAgentId,
    "--to-agent", toAgentId,
    "--summary", summary,
    "--next", nextAction,
  ];
  for (const evidenceRef of evidenceRefs ?? []) args.push("--evidence", evidenceRef);
  if (json) args.push("--json");
  return args;
}

function directDecisionArgs(root, {
  operation,
  decisionId,
  at,
  title,
  question,
  ownerAgentId,
  blockingWorkItemIds = [],
  options = [],
  resolution,
  rationale,
  evidenceRefs = [],
}, json = false) {
  const args = [
    "project", "decision", "--workspace", root,
    operation === "open" ? "--open" : "--resolve",
    "--decision-id", decisionId,
    "--at", at,
  ];
  if (operation === "open") {
    args.push(
      "--title", title,
      "--question", question,
      "--owner-agent", ownerAgentId,
    );
    for (const workItemId of blockingWorkItemIds) {
      args.push("--blocking-work-item", workItemId);
    }
    for (const option of options) args.push("--option", option);
  } else {
    args.push("--resolution", resolution, "--rationale", rationale);
    for (const evidenceRef of evidenceRefs) args.push("--evidence", evidenceRef);
  }
  if (json) args.push("--json");
  return args;
}

function directIntegrateArgs(root, {
  gateId,
  at,
  summary,
  evidenceRefs = [],
}, json = false) {
  const args = [
    "project", "integrate", "--workspace", root,
    "--gate", gateId,
    "--at", at,
    "--summary", summary,
  ];
  for (const evidenceRef of evidenceRefs) args.push("--evidence", evidenceRef);
  if (json) args.push("--json");
  return args;
}

function directVerificationArgs(root, {
  operation,
  verificationId,
  at,
  workItemId,
  ownerAgentId,
  checkIds = [],
  reason,
  dueGateId,
  disposition,
  summary,
  evidenceRefs = [],
  decisionIds = [],
}, json = false) {
  const args = [
    "project", "verification", "--workspace", root,
    operation === "defer" ? "--defer" : "--close",
    "--verification-id", verificationId,
    "--at", at,
  ];
  if (operation === "defer") {
    args.push(
      "--work-item", workItemId,
      "--owner-agent", ownerAgentId,
      "--reason", reason,
      "--due-gate", dueGateId,
    );
    for (const checkId of checkIds) args.push("--check", checkId);
  } else {
    args.push("--disposition", disposition, "--summary", summary);
    for (const evidenceRef of evidenceRefs) args.push("--evidence", evidenceRef);
    for (const decisionId of decisionIds) args.push("--decision", decisionId);
  }
  if (json) args.push("--json");
  return args;
}

function directCheckpointArgs(root, {
  checkpointId,
  at,
  assignmentId,
  workItemId,
  state,
  summary,
  completedUnits,
  evidenceRefs = [],
  blockerRefs = [],
  decisionRefs = [],
  nextAction,
  sourceFingerprint,
}, json = false) {
  const args = [
    "project", "checkpoint", "--workspace", root,
    "--checkpoint-id", checkpointId,
    "--at", at,
    "--assignment-id", assignmentId,
    "--work-item", workItemId,
    "--state", state,
    "--summary", summary,
  ];
  if (completedUnits !== undefined) args.push("--completed-units", String(completedUnits));
  for (const evidenceRef of evidenceRefs) args.push("--evidence", evidenceRef);
  for (const blockerRef of blockerRefs) args.push("--blocker", blockerRef);
  for (const decisionId of decisionRefs) args.push("--decision", decisionId);
  if (nextAction !== undefined) args.push("--next", nextAction);
  if (sourceFingerprint !== undefined) args.push("--source-fingerprint", sourceFingerprint);
  if (json) args.push("--json");
  return args;
}

test("a team project projects real per-Agent progress, dependencies, decisions, and integration gates", async () => {
  const root = await setup();
  try {
    const events = [
      event("event-01", "agent_assigned", {
        assignmentId: "assign-contract",
        workItemId: "contract",
        agentId: "agent-design",
      }),
      event("event-02", "agent_assigned", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        agentId: "agent-runtime",
      }),
      event("event-03", "agent_assigned", {
        assignmentId: "assign-cli",
        workItemId: "cli",
        agentId: "agent-cli",
      }),
      event("event-04", "checkpoint_recorded", {
        assignmentId: "assign-contract",
        workItemId: "contract",
        state: "completed",
        summary: "Contract accepted.",
        evidenceRefs: ["docs/architecture/contract.md#sha256:aaa"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
      event("event-05", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Two of four acceptance tests pass.",
        completedUnits: 2,
        evidenceRefs: ["tests/team-project.test.mjs#run-001"],
        blockerRefs: ["decision:scope-decision"],
        decisionRefs: ["scope-decision"],
        nextAction: "Resolve scope decision, then finish two tests.",
      }),
      event("event-06", "checkpoint_recorded", {
        assignmentId: "assign-cli",
        workItemId: "cli",
        state: "waiting_dependency",
        summary: "Waiting for engine contract.",
        evidenceRefs: [],
        blockerRefs: ["work-item:engine"],
        decisionRefs: [],
        nextAction: "Resume after engine completes.",
      }),
      event("event-07", "decision_opened", {
        decisionId: "scope-decision",
        title: "0.17 release scope",
        question: "Ship team progress and Verification Envelope together?",
        ownerAgentId: "owner",
        blockingWorkItemIds: ["engine", "integrate"],
        options: ["ship-together", "split-release"],
      }),
    ];
    for (const value of events) {
      appendTeamProjectEventV1({ workspaceRoot: root, event: value });
    }

    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.schemaVersion, "OwlCodaRunKitTeamProjectStatusV1");
    assert.equal(status.overall, "active_with_blockers");
    assert.deepEqual(status.counts, {
      total: 5,
      planned: 1,
      active: 0,
      waiting_dependency: 1,
      waiting_decision: 2,
      verifying: 0,
      ready_to_integrate: 0,
      completed: 1,
      failed: 0,
    });
    assert.deepEqual(status.readyQueue, ["docs"]);
    assert.ok(status.criticalWorkItems.includes("engine"));
    assert.deepEqual(status.openDecisions.map(row => row.decisionId), ["scope-decision"]);
    assert.equal(status.integrationGates[0].status, "blocked");
    assert.deepEqual(status.integrationGates[0].unresolvedWorkItemIds, [
      "cli",
      "docs",
      "integrate",
    ]);
    assert.deepEqual(status.integrationGates[0].unresolvedDecisionIds, ["scope-decision"]);

    const runtime = status.agents.find(row => row.agentId === "agent-runtime");
    assert.deepEqual(runtime.waitingWorkItemIds, ["engine"]);
    assert.equal(runtime.nextActions[0], "Resolve scope decision, then finish two tests.");
    const engine = status.workItems.find(row => row.workItemId === "engine");
    assert.deepEqual(engine.progress, {
      kind: "measured_units",
      unit: "acceptance_tests",
      completed: 2,
      total: 4,
    });
    assert.equal(Object.hasOwn(engine.progress, "percent"), false);
    assert.ok(engine.truthRefs.includes("project/definition.json"));
    assert.ok(engine.truthRefs.some(ref => ref.includes("event-05")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project status and blank-session takeover expose one deterministic project driver summary", async () => {
  const root = await setup();
  try {
    for (const value of [
      event("event-01", "agent_assigned", {
        assignmentId: "assign-contract",
        workItemId: "contract",
        agentId: "agent-design",
      }),
      event("event-02", "checkpoint_recorded", {
        assignmentId: "assign-contract",
        workItemId: "contract",
        state: "completed",
        summary: "Contract accepted.",
        evidenceRefs: ["receipt:contract"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
      event("event-03", "agent_assigned", {
        assignmentId: "assign-docs",
        workItemId: "docs",
        agentId: "agent-docs",
      }),
      event("event-04", "checkpoint_recorded", {
        assignmentId: "assign-docs",
        workItemId: "docs",
        state: "completed",
        summary: "Workflow documented.",
        evidenceRefs: ["receipt:docs"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
      event("event-05", "agent_assigned", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        agentId: "agent-runtime",
      }),
      event("event-06", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "waiting_decision",
        summary: "Implementation is waiting for the scope decision.",
        completedUnits: 2,
        evidenceRefs: ["artifact:engine-progress"],
        blockerRefs: ["decision:scope-decision"],
        decisionRefs: ["scope-decision"],
        nextAction: "Implement after the scope decision.",
      }),
      event("event-07", "decision_opened", {
        decisionId: "scope-decision",
        title: "0.18 project scope",
        question: "Which project slice is authorized for this round?",
        ownerAgentId: "owner",
        blockingWorkItemIds: ["engine"],
        options: ["driver-summary", "formal-run"],
      }),
    ]) appendTeamProjectEventV1({ workspaceRoot: root, event: value });

    const before = await treeHash(root);
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const assignedTakeover = buildTeamProjectTakeoverV1({
      workspaceRoot: root,
      agentId: "agent-runtime",
    });
    const blankTakeover = buildTeamProjectTakeoverV1({
      workspaceRoot: root,
      agentId: "blank-agent",
    });
    const ownerTakeover = buildTeamProjectTakeoverV1({
      workspaceRoot: root,
      agentId: "owner",
    });
    const statusHuman = (await runCli([
      "project", "status", "--workspace", root,
    ])).humanOutput;
    const takeoverHuman = (await runCli([
      "project", "takeover", "--workspace", root, "--agent", "blank-agent",
    ])).humanOutput;
    const after = await treeHash(root);

    assert.equal(status.dominantGap.kind, "decision");
    assert.equal(status.dominantGap.id, "scope-decision");
    assert.equal(status.dominantGap.title, "0.18 project scope");
    assert.equal(status.dominantGap.workItemId, "engine");
    assert.equal(status.dominantGap.agentId, "owner");
    assert.equal(status.nextAction, "Resolve scope-decision");
    assert.equal(status.nextActorId, "owner");
    assert.equal(status.authorizationGranted, false);
    assert.equal(Object.hasOwn(status, "percent"), false);
    assert.ok(status.headline.includes("scope-decision"));
    assert.ok(status.headline.includes("owner"));
    assert.ok(status.headline.includes("Which project slice is authorized for this round?"));
    assert.ok(status.headline.includes("Resolve scope-decision"));
    assert.deepEqual(assignedTakeover.dominantGap, status.dominantGap);
    assert.equal(assignedTakeover.projectHeadline, status.headline);
    assert.equal(assignedTakeover.projectNextAction, status.nextAction);
    assert.equal(assignedTakeover.projectNextActorId, status.nextActorId);
    assert.equal(assignedTakeover.projectTruthHash, status.projectTruthHash);
    assert.equal(assignedTakeover.authorizationGranted, false);
    assert.equal(assignedTakeover.currentResponsibility.workItemId, "engine");
    assert.equal(assignedTakeover.nextAction, "Waiting for owner to resolve scope-decision.");
    assert.deepEqual(assignedTakeover.unresolvedDecisions.map(row => row.decisionId), ["scope-decision"]);
    assert.equal(ownerTakeover.currentResponsibility, null);
    assert.equal(ownerTakeover.nextAction, "Resolve scope-decision");
    assert.equal(blankTakeover.currentResponsibility, null);
    assert.equal(blankTakeover.projectHeadline, status.headline);
    assert.deepEqual(blankTakeover.dominantGap, status.dominantGap);
    assert.equal(blankTakeover.projectNextAction, "Resolve scope-decision");
    assert.equal(blankTakeover.projectNextActorId, "owner");
    assert.equal(blankTakeover.nextAction, null);
    assert.equal(blankTakeover.authorizationGranted, false);
    assert.equal(statusHuman.split("\n").filter(Boolean)[0], status.headline);
    assert.equal(takeoverHuman.split("\n").filter(Boolean)[0], status.headline);
    assert.equal(
      statusHuman.split("\n").filter(Boolean)[1],
      `Project: ${status.projectId} — ${status.objective}`,
    );
    assert.equal(
      takeoverHuman.split("\n").filter(Boolean)[1],
      `Project: ${blankTakeover.projectId} — ${blankTakeover.objective}`,
    );
    assert.ok(statusHuman.split("\n").filter(Boolean).length <= 10);
    assert.ok(takeoverHuman.split("\n").filter(Boolean).length <= 12);
    assert.doesNotMatch(statusHuman, /receipt|lease|json/iu);
    assert.doesNotMatch(takeoverHuman, /receipt|lease|json/iu);
    assert.equal(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project headlines normalize terminal punctuation without duplicating it", async () => {
  const cases = [
    ["Continue engine implementation.", "Continue engine implementation."],
    ["Pause!", "Pause!"],
    ["What next?", "What next?"],
    ["继续。", "继续。"],
    ["注意！", "注意！"],
    ["疑问？", "疑问？"],
    ["Continue engine implementation", "Continue engine implementation."],
  ];
  const roots = [];
  try {
    for (const [index, [nextAction, expectedSuffix]] of cases.entries()) {
      const root = await setup(singleItemDefinition());
      roots.push(root);
      await appendEvents(root, [
        event(`event-${String(index * 2 + 1).padStart(2, "0")}`, "agent_assigned", {
          assignmentId: "assign-x",
          workItemId: "x",
          agentId: "agent-a",
        }),
        event(`event-${String(index * 2 + 2).padStart(2, "0")}`, "checkpoint_recorded", {
          assignmentId: "assign-x",
          workItemId: "x",
          state: "active",
          summary: "Work is active.",
          evidenceRefs: [],
          blockerRefs: [],
          decisionRefs: [],
          nextAction,
        }),
      ]);
      const status = readTeamProjectStatusV1({ workspaceRoot: root });
      assert.equal(status.nextAction, nextAction);
      assert.ok(status.headline.endsWith(`next: ${expectedSuffix}`));
      assert.doesNotMatch(status.headline, /[.!?。！？]{2}$/u);
    }
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test("takeover selects an actionable responsibility before blocked work for the same Agent", async () => {
  const project = {
    schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
    projectId: "actionable-takeover",
    objective: "Give one Agent a legal bounded next action",
    milestones: [{ id: "m1", title: "Delivery" }],
    workstreams: [{ id: "runtime", title: "Runtime", milestoneId: "m1" }],
    workItems: [
      {
        id: "blocked-first",
        title: "Blocked first responsibility",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: ["dependency"],
        ownedPaths: ["src/blocked/**"],
      },
      {
        id: "dependency",
        title: "Unassigned dependency",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: [],
        ownedPaths: ["src/dependency/**"],
      },
      {
        id: "ready-second",
        title: "Actionable second responsibility",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: [],
        ownedPaths: ["src/ready/**"],
      },
    ],
    integrationGates: [],
  };
  const root = await setup(project);
  try {
    await appendEvents(root, [
      event("event-01", "agent_assigned", {
        assignmentId: "assign-blocked",
        workItemId: "blocked-first",
        agentId: "agent-shared",
      }),
      event("event-02", "agent_assigned", {
        assignmentId: "assign-ready",
        workItemId: "ready-second",
        agentId: "agent-shared",
      }),
    ]);
    const takeover = buildTeamProjectTakeoverV1({
      workspaceRoot: root,
      agentId: "agent-shared",
    });
    assert.equal(takeover.currentResponsibility.workItemId, "ready-second");
    assert.equal(takeover.nextAction, "Continue ready-second.");
    assert.equal(takeover.projectNextAction, "Assign dependency");
    assert.equal(takeover.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the project driver exposes failed work before ordinary active work", async () => {
  const project = {
    schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
    projectId: "failed-first",
    objective: "Expose the blocking failure",
    milestones: [{ id: "m1", title: "Delivery" }],
    workstreams: [{ id: "runtime", title: "Runtime", milestoneId: "m1" }],
    workItems: [
      {
        id: "a-active",
        title: "Ordinary active work",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: [],
        ownedPaths: ["src/active/**"],
      },
      {
        id: "z-failed",
        title: "Hard failure",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: [],
        ownedPaths: ["src/failed/**"],
      },
    ],
    integrationGates: [],
  };
  const root = await setup(project);
  try {
    await appendEvents(root, [
      event("event-01", "agent_assigned", {
        assignmentId: "assign-active",
        workItemId: "a-active",
        agentId: "agent-active",
      }),
      event("event-02", "agent_assigned", {
        assignmentId: "assign-failed",
        workItemId: "z-failed",
        agentId: "agent-failed",
      }),
      event("event-03", "checkpoint_recorded", {
        assignmentId: "assign-failed",
        workItemId: "z-failed",
        state: "failed",
        summary: "Hard failure needs rework.",
        evidenceRefs: ["artifact:failure"],
        blockerRefs: ["blocker:hard"],
        decisionRefs: [],
        nextAction: null,
      }),
    ]);
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.overall, "active_with_blockers");
    assert.equal(status.dominantGap.kind, "failed_work");
    assert.equal(status.dominantGap.workItemId, "z-failed");
    assert.equal(status.nextAction, "Rework z-failed");
    assert.equal(status.nextActorId, "agent-failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the first unpassed gate and its unresolved decision stay definition ordered", async () => {
  const project = definition();
  project.integrationGates = [
    {
      id: "z-gate",
      title: "Z gate",
      requiredWorkItemIds: ["cli", "docs", "integrate"],
      requiredDecisionIds: ["z-decision"],
    },
    {
      id: "a-gate",
      title: "A gate",
      requiredWorkItemIds: ["cli", "docs", "integrate"],
      requiredDecisionIds: ["a-decision"],
    },
  ];
  const root = await setup(project);
  try {
    await appendEvents(root, fullCompletionEvents());
    await appendEvents(root, [
      event("event-13", "decision_opened", {
        decisionId: "z-decision",
        title: "Z gate decision",
        question: "Resolve the first gate decision.",
        ownerAgentId: "z-owner",
        blockingWorkItemIds: [],
        options: ["accept"],
      }),
      event("event-14", "decision_opened", {
        decisionId: "a-decision",
        title: "A gate decision",
        question: "Resolve the later gate decision.",
        ownerAgentId: "a-owner",
        blockingWorkItemIds: [],
        options: ["accept"],
      }),
    ]);
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.deepEqual(status.integrationGates.map(gate => [
      gate.gateId,
      gate.status,
      gate.unresolvedDecisionIds,
    ]), [
      ["z-gate", "blocked", ["z-decision"]],
      ["a-gate", "blocked", ["a-decision"]],
    ]);
    assert.equal(status.dominantGap.kind, "decision");
    assert.equal(status.dominantGap.id, "z-decision");
    assert.equal(status.dominantGap.title, "Z gate decision");
    assert.equal(status.nextAction, "Resolve z-decision");
    assert.equal(status.nextActorId, "z-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the project driver projects an unpassed gate, then none after the gate is passed", async () => {
  const root = await setup();
  try {
    await appendEvents(root, fullCompletionEvents());
    const before = await treeHash(root);
    const ready = readTeamProjectStatusV1({ workspaceRoot: root });
    buildTeamProjectTakeoverV1({ workspaceRoot: root, agentId: "blank-agent" });
    assert.equal(await treeHash(root), before);
    assert.equal(ready.overall, "active");
    assert.equal(ready.dominantGap.kind, "integration_gate");
    assert.equal(ready.dominantGap.id, "release-ready");
    assert.equal(ready.nextAction, "Review integration gate release-ready");
    assert.equal(ready.nextActorId, null);
    assert.equal(ready.workItems.every(row => row.status === "completed"), true);
    assert.equal(ready.integrationGates[0].status, "ready");

    appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-13", "integration_gate_passed", {
        gateId: "release-ready",
        summary: "All product work accepted.",
        evidenceRefs: ["receipt:release-ready"],
      }),
    });
    const completed = readTeamProjectStatusV1({ workspaceRoot: root });
    const completedBeforeRead = await treeHash(root);
    buildTeamProjectTakeoverV1({ workspaceRoot: root, agentId: "blank-agent" });
    assert.equal(completed.overall, "completed");
    assert.deepEqual(completed.dominantGap, {
      kind: "none",
      id: null,
      title: null,
      workItemId: null,
      agentId: null,
      reason: null,
      truthRefs: [
        "project/definition.json",
        "project/events/event-13.json",
      ],
    });
    assert.equal(completed.nextAction, null);
    assert.equal(completed.nextActorId, null);
    assert.equal(await treeHash(root), completedBeforeRead);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed integration passes a ready gate with durable idempotent project-only output", async () => {
  const root = await setup();
  const integration = {
    gateId: "release-ready",
    at: "2026-08-08T00:13:00.000Z",
    summary: "All product work accepted.",
    evidenceRefs: ["artifact:release-ready", "check:focused"],
  };
  try {
    await appendEvents(root, fullCompletionEvents());
    const before = await projectSnapshot(root);
    const passed = await runCli(directIntegrateArgs(root, integration));
    assert.equal(passed.status, "team_project_integration");
    assert.equal(passed.gateId, "release-ready");
    assert.equal(passed.eventId, "integration-gate-release-ready");
    assert.match(passed.eventPath, /project\/events\/integration-gate-release-ready\.json$/u);
    assert.match(passed.eventSha256, /^[a-f0-9]{64}$/u);
    assert.equal(passed.resumed, false);
    assert.equal(passed.gateStatus, "passed");
    assert.equal(passed.overall, "completed");
    assert.equal(passed.nextAction, null);
    assert.equal(passed.nextActorId, null);
    assert.equal(passed.gitWritePerformed, false);
    assert.equal(passed.releaseWritePerformed, false);
    assert.equal(passed.authorizationGranted, false);
    assert.equal(passed.exitCode, 0);
    const humanLines = passed.humanOutput.split("\n").filter(Boolean);
    assert.equal(humanLines[0], "Passed project integration gate release-ready.");
    assert.ok(humanLines.some(line => /Project state: completed; next: none/u.test(line)));
    assert.ok(humanLines.some(line => /Git\/release not performed/u.test(line)));
    assert.ok(humanLines.length <= 5);
    assert.doesNotMatch(passed.humanOutput, /\b(receipt|lease|json)\b/iu);

    const afterPass = await projectSnapshot(root);
    assert.equal(afterPass.events.filter(name => name.includes("integration-gate-release-ready")).length, 1);
    assert.deepEqual(await readdir(path.join(root, ".owlcoda/runkit")), ["project"]);
    const replay = await runCli(directIntegrateArgs(root, integration, true));
    assert.equal(replay.status, "team_project_integration");
    assert.equal(replay.resumed, true);
    assert.equal(replay.eventSha256, passed.eventSha256);
    assert.equal(replay.projectTruthHash, passed.projectTruthHash);
    assert.equal(Object.hasOwn(replay, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), afterPass);

    const changed = await runCli(directIntegrateArgs(root, {
      ...integration,
      summary: "Changed integration claim.",
    }));
    assert.equal(changed.status, "invalid_input");
    assert.equal(changed.exitCode, 3);
    assert.match(changed.issues[0], /immutable event differs: integration-gate-release-ready/iu);
    assert.equal(Object.hasOwn(changed, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), afterPass);

    const backdated = await runCli(directIntegrateArgs(root, {
      ...integration,
      at: "2026-08-08T00:00:00.000Z",
    }));
    assert.equal(backdated.status, "invalid_input");
    assert.match(backdated.issues[0], /immutable event differs: integration-gate-release-ready/iu);
    assert.deepEqual(await projectSnapshot(root), afterPass);

    const outOfOrderPath = path.join(root, "out-of-order-integration-request.json");
    await writeJson(outOfOrderPath, event("event-14", "integration_gate_passed", {
      occurredAt: "2026-08-08T00:12:00.000Z",
      gateId: "release-ready",
      summary: "Backdated second pass.",
      evidenceRefs: ["artifact:backdated-second-pass"],
    }));
    const outOfOrder = await runCli([
      "project", "integrate", "--workspace", root,
      "--request", outOfOrderPath,
    ]);
    assert.equal(outOfOrder.status, "invalid_input");
    assert.match(outOfOrder.issues[0], /must sort after the latest event/iu);
    assert.deepEqual(await projectSnapshot(root), afterPass);

    const duplicatePath = path.join(root, "duplicate-integration-request.json");
    const duplicateEvent = event("event-15", "integration_gate_passed", {
      gateId: "release-ready",
      summary: "Second event identity.",
      evidenceRefs: ["artifact:duplicate-pass"],
    });
    await writeJson(duplicatePath, duplicateEvent);
    const duplicate = await runCli([
      "project", "integrate", "--workspace", root,
      "--request", duplicatePath,
    ]);
    assert.equal(duplicate.status, "invalid_input");
    assert.match(duplicate.issues[0], /integration gate release-ready has already passed/iu);
    assert.deepEqual(await projectSnapshot(root), afterPass);
    assert.notDeepEqual(afterPass, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deferred verification records unrun checks and becomes the due integration gap", async () => {
  const root = await setup();
  const deferred = {
    operation: "defer",
    verificationId: "release-batch",
    at: "2026-08-08T00:13:00.000Z",
    workItemId: "integrate",
    ownerAgentId: "agent-release",
    checkIds: ["typecheck", "full-suite", "package-smoke"],
    reason: "Batch the broad checks after the related release changes settle.",
    dueGateId: "release-ready",
  };
  try {
    await appendEvents(root, fullCompletionEvents());
    const recorded = await runCli(directVerificationArgs(root, deferred, true));
    assert.equal(recorded.status, "team_project_verification");
    assert.equal(recorded.operation, "deferred");
    assert.equal(recorded.verificationId, "release-batch");
    assert.equal(recorded.verificationStatus, "open");
    assert.equal(recorded.gateStatus, "blocked");
    assert.equal(recorded.overall, "active");
    assert.equal(recorded.nextAction, "Run deferred verification release-batch");
    assert.equal(recorded.nextActorId, "agent-release");
    assert.equal(recorded.authorizationGranted, false);

    let status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.deepEqual(status.deferredVerifications, [{
      verificationId: "release-batch",
      workItemId: "integrate",
      ownerAgentId: "agent-release",
      checkIds: ["typecheck", "full-suite", "package-smoke"],
      reason: deferred.reason,
      dueGateId: "release-ready",
      status: "open",
      disposition: null,
      summary: null,
      evidenceRefs: [],
      decisionIds: [],
      truthRefs: ["project/events/verification-deferred-release-batch.json"],
    }]);
    assert.deepEqual(status.openDeferredVerificationIds, ["release-batch"]);
    assert.deepEqual(status.integrationGates[0].unresolvedVerificationIds, ["release-batch"]);
    assert.equal(status.integrationGates[0].status, "blocked");
    assert.deepEqual(status.dominantGap, {
      kind: "deferred_verification",
      id: "release-batch",
      title: "Deferred verification release-batch",
      workItemId: "integrate",
      agentId: "agent-release",
      reason: deferred.reason,
      truthRefs: [
        "project/definition.json",
        "project/events/verification-deferred-release-batch.json",
      ],
    });

    const takeover = buildTeamProjectTakeoverV1({
      workspaceRoot: root,
      agentId: "agent-release",
    });
    assert.deepEqual(takeover.deferredVerifications.map(row => row.verificationId), [
      "release-batch",
    ]);
    assert.equal(takeover.nextAction, "Run deferred verification release-batch");
    const humanStatus = await runCli(["project", "status", "--workspace", root]);
    assert.match(humanStatus.humanOutput, /Deferred verification: 1 open \(release-batch\)/u);
    const humanTakeover = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "agent-release",
    ]);
    assert.match(humanTakeover.humanOutput, /Deferred verification: release-batch/u);

    const beforeRejectedGate = await projectSnapshot(root);
    const rejectedGate = await runCli(directIntegrateArgs(root, {
      gateId: "release-ready",
      at: "2026-08-08T00:14:00.000Z",
      summary: "Must not pass with due verification open.",
      evidenceRefs: ["artifact:premature-gate"],
    }, true));
    assert.equal(rejectedGate.status, "invalid_input");
    assert.match(rejectedGate.issues[0], /not ready/iu);
    assert.deepEqual(await projectSnapshot(root), beforeRejectedGate);

    const closed = await runCli(directVerificationArgs(root, {
      operation: "close",
      verificationId: "release-batch",
      at: "2026-08-08T00:14:00.000Z",
      disposition: "verified",
      summary: "The batched release checks passed against the frozen candidate.",
      evidenceRefs: ["receipt:release-batch"],
    }, true));
    assert.equal(closed.status, "team_project_verification");
    assert.equal(closed.operation, "closed");
    assert.equal(closed.verificationStatus, "verified");
    assert.equal(closed.gateStatus, "ready");
    assert.equal(closed.nextAction, "Review integration gate release-ready");

    status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.deepEqual(status.openDeferredVerificationIds, []);
    assert.equal(status.deferredVerifications[0].status, "closed");
    assert.equal(status.deferredVerifications[0].disposition, "verified");
    assert.deepEqual(status.deferredVerifications[0].evidenceRefs, ["receipt:release-batch"]);
    assert.deepEqual(status.deferredVerifications[0].truthRefs, [
      "project/events/verification-deferred-release-batch.json",
      "project/events/verification-closed-release-batch.json",
    ]);

    const passed = await runCli(directIntegrateArgs(root, {
      gateId: "release-ready",
      at: "2026-08-08T00:15:00.000Z",
      summary: "Release package is accepted after batched verification.",
      evidenceRefs: ["artifact:release-ready"],
    }, true));
    assert.equal(passed.gateStatus, "passed");
    assert.equal(passed.overall, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deferred verification closes without a test only through a resolved decision", async () => {
  const root = await setup();
  try {
    await appendEvents(root, fullCompletionEvents());
    await runCli(directVerificationArgs(root, {
      operation: "defer",
      verificationId: "obsolete-check",
      at: "2026-08-08T00:13:00.000Z",
      workItemId: "integrate",
      ownerAgentId: "agent-release",
      checkIds: ["legacy-node-smoke"],
      reason: "Await the compatibility-scope decision before running a redundant check.",
      dueGateId: "release-ready",
    }, true));

    const beforeMissingDecision = await projectSnapshot(root);
    const missingDecision = await runCli(directVerificationArgs(root, {
      operation: "close",
      verificationId: "obsolete-check",
      at: "2026-08-08T00:14:00.000Z",
      disposition: "no_longer_required",
      summary: "The check was removed from the accepted compatibility scope.",
    }, true));
    assert.equal(missingDecision.status, "invalid_input");
    assert.match(missingDecision.issues[0], /resolved decision/iu);
    assert.deepEqual(await projectSnapshot(root), beforeMissingDecision);

    await runCli(directDecisionArgs(root, {
      operation: "open",
      decisionId: "compatibility-scope",
      at: "2026-08-08T00:14:00.000Z",
      title: "Compatibility scope",
      question: "Is the legacy standalone check still required?",
      ownerAgentId: "owner",
      options: ["keep", "remove"],
    }, true));
    await runCli(directDecisionArgs(root, {
      operation: "resolve",
      decisionId: "compatibility-scope",
      at: "2026-08-08T00:15:00.000Z",
      resolution: "remove",
      rationale: "The same supported baseline is already covered by the compatibility cycle.",
      evidenceRefs: ["decision-record:compatibility-scope"],
    }, true));
    const closed = await runCli(directVerificationArgs(root, {
      operation: "close",
      verificationId: "obsolete-check",
      at: "2026-08-08T00:16:00.000Z",
      disposition: "no_longer_required",
      summary: "The resolved scope decision removed this duplicate check.",
      decisionIds: ["compatibility-scope"],
    }, true));
    assert.equal(closed.verificationStatus, "no_longer_required");
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.deferredVerifications[0].disposition, "no_longer_required");
    assert.deepEqual(status.deferredVerifications[0].decisionIds, ["compatibility-scope"]);
    assert.equal(status.integrationGates[0].status, "ready");

    const replay = await runCli(directVerificationArgs(root, {
      operation: "close",
      verificationId: "obsolete-check",
      at: "2026-08-08T00:16:00.000Z",
      disposition: "no_longer_required",
      summary: "The resolved scope decision removed this duplicate check.",
      decisionIds: ["compatibility-scope"],
    }, true));
    assert.equal(replay.resumed, true);

    await runCli(directIntegrateArgs(root, {
      gateId: "release-ready",
      at: "2026-08-08T00:17:00.000Z",
      summary: "The gate is ready after the explicit scope decision.",
      evidenceRefs: ["artifact:release-ready"],
    }, true));
    const beforeLateDebt = await projectSnapshot(root);
    const lateDebt = await runCli(directVerificationArgs(root, {
      operation: "defer",
      verificationId: "late-debt",
      at: "2026-08-08T00:18:00.000Z",
      workItemId: "integrate",
      ownerAgentId: "agent-release",
      checkIds: ["late-check"],
      reason: "A passed gate must not be retroactively invalidated.",
      dueGateId: "release-ready",
    }, true));
    assert.equal(lateDebt.status, "invalid_input");
    assert.match(lateDebt.issues[0], /already passed/iu);
    assert.deepEqual(await projectSnapshot(root), beforeLateDebt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed integration rejects unknown and unready gates without writing project truth", async () => {
  const unknownRoot = await setup();
  const workRoot = await setup();
  const decisionRoot = await setup();
  const roots = [unknownRoot, workRoot, decisionRoot];
  const assertRejectedWithoutWrite = async (root, args, pattern) => {
    const before = await projectSnapshot(root);
    const result = await runCli(args);
    assert.equal(result.status, "invalid_input");
    assert.equal(result.exitCode, 3);
    assert.equal(result.authorizationGranted, false);
    assert.match(result.issues[0], pattern);
    assert.equal(Object.hasOwn(result, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), before);
  };
  try {
    await assertRejectedWithoutWrite(
      unknownRoot,
      directIntegrateArgs(unknownRoot, {
        gateId: "missing-gate",
        at: "2026-08-08T00:00:00.000Z",
        summary: "Unknown gate.",
        evidenceRefs: ["artifact:unknown"],
      }),
      /unknown integration gate/iu,
    );
    await assertRejectedWithoutWrite(
      workRoot,
      directIntegrateArgs(workRoot, {
        gateId: "release-ready",
        at: "2026-08-08T00:00:00.000Z",
        summary: "Work is not complete.",
        evidenceRefs: ["artifact:unready-work"],
      }),
      /not ready/iu,
    );
    await appendEvents(decisionRoot, fullCompletionEvents().slice(0, -1));
    await assertRejectedWithoutWrite(
      decisionRoot,
      directIntegrateArgs(decisionRoot, {
        gateId: "release-ready",
        at: "2026-08-08T00:12:00.000Z",
        summary: "Decision is still open.",
        evidenceRefs: ["artifact:unready-decision"],
      }),
      /not ready/iu,
    );
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test("integration gate progression follows definition order and unrelated open decisions block completion", async () => {
  const project = definition();
  project.integrationGates = [
    {
      id: "z-gate",
      title: "Z gate",
      requiredWorkItemIds: ["cli", "docs", "integrate"],
      requiredDecisionIds: [],
    },
    {
      id: "a-gate",
      title: "A gate",
      requiredWorkItemIds: ["cli", "docs", "integrate"],
      requiredDecisionIds: [],
    },
  ];
  const root = await setup(project);
  const earlyRoot = await setup(project);
  try {
    await appendEvents(earlyRoot, fullCompletionEvents());
    const earlyLaterGate = await runCli(directIntegrateArgs(earlyRoot, {
      gateId: "a-gate",
      at: "2026-08-08T00:13:00.000Z",
      summary: "Independently ready later gate.",
      evidenceRefs: ["artifact:early-a-gate"],
    }, true));
    assert.equal(earlyLaterGate.status, "team_project_integration");
    let earlyStatus = readTeamProjectStatusV1({ workspaceRoot: earlyRoot });
    assert.equal(earlyStatus.integrationGates[0].status, "ready");
    assert.equal(earlyStatus.integrationGates[1].status, "passed");
    assert.equal(earlyStatus.dominantGap.kind, "integration_gate");
    assert.equal(earlyStatus.dominantGap.id, "z-gate");
    assert.equal(earlyStatus.nextAction, "Review integration gate z-gate");
    const earlyFirstGate = await runCli(directIntegrateArgs(earlyRoot, {
      gateId: "z-gate",
      at: "2026-08-08T00:14:00.000Z",
      summary: "Definition-first gate follows.",
      evidenceRefs: ["artifact:early-z-gate"],
    }, true));
    assert.equal(earlyFirstGate.gateStatus, "passed");
    earlyStatus = readTeamProjectStatusV1({ workspaceRoot: earlyRoot });
    assert.equal(earlyStatus.overall, "completed");

    await appendEvents(root, fullCompletionEvents());
    const first = await runCli(directIntegrateArgs(root, {
      gateId: "z-gate",
      at: "2026-08-08T00:13:00.000Z",
      summary: "First definition gate passed.",
      evidenceRefs: ["artifact:z-gate"],
    }, true));
    assert.equal(first.status, "team_project_integration");
    let status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.integrationGates[0].status, "passed");
    assert.equal(status.integrationGates[1].status, "ready");
    assert.equal(status.dominantGap.kind, "integration_gate");
    assert.equal(status.dominantGap.id, "a-gate");
    assert.equal(status.nextAction, "Review integration gate a-gate");

    const second = await runCli(directIntegrateArgs(root, {
      gateId: "a-gate",
      at: "2026-08-08T00:14:00.000Z",
      summary: "Second definition gate passed.",
      evidenceRefs: ["artifact:a-gate"],
    }, true));
    assert.equal(second.gateStatus, "passed");
    assert.equal(readTeamProjectStatusV1({ workspaceRoot: root }).overall, "completed");

    const orphan = {
      operation: "open",
      decisionId: "orphan-decision",
      at: "2026-08-08T00:15:00.000Z",
      title: "Unrelated project decision",
      question: "Which follow-up should be considered next?",
      ownerAgentId: "orphan-owner",
      blockingWorkItemIds: [],
      options: ["later", "now"],
    };
    const opened = await runCli(directDecisionArgs(root, orphan, true));
    assert.equal(opened.status, "team_project_decision");
    status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.overall, "active_with_blockers");
    assert.equal(status.dominantGap.kind, "decision");
    assert.equal(status.dominantGap.id, "orphan-decision");
    assert.equal(status.dominantGap.agentId, "orphan-owner");
    assert.equal(status.nextAction, "Resolve orphan-decision");
    assert.equal(status.nextActorId, "orphan-owner");

    const resolved = await runCli(directDecisionArgs(root, {
      operation: "resolve",
      decisionId: "orphan-decision",
      at: "2026-08-08T00:16:00.000Z",
      resolution: "later",
      rationale: "The follow-up is outside this delivery slice.",
      evidenceRefs: ["decision-record:orphan"],
    }, true));
    assert.equal(resolved.status, "team_project_decision");
    status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.overall, "completed");
    assert.equal(status.dominantGap.kind, "none");
    assert.equal(status.nextAction, null);
    assert.equal(status.nextActorId, null);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(earlyRoot, { recursive: true, force: true }),
    ]);
  }
});

test("integration request compatibility is restricted while capture remains legacy-compatible", async () => {
  const project = definition();
  project.integrationGates = [
    {
      id: "z-gate",
      title: "Z gate",
      requiredWorkItemIds: ["cli", "docs", "integrate"],
      requiredDecisionIds: [],
    },
    {
      id: "a-gate",
      title: "A gate",
      requiredWorkItemIds: ["cli", "docs", "integrate"],
      requiredDecisionIds: [],
    },
  ];
  const root = await setup(project);
  const wrongRoot = await setup();
  const mixedRoot = await setup();
  const roots = [root, wrongRoot, mixedRoot];
  try {
    await appendEvents(root, fullCompletionEvents());
    const requestPath = path.join(root, "integration-request.json");
    await writeJson(requestPath, event("event-13", "integration_gate_passed", {
      gateId: "z-gate",
      summary: "Legacy integration pass.",
      evidenceRefs: ["artifact:legacy-z"],
    }));
    const legacy = await runCli([
      "project", "integrate", "--workspace", root, "--request", requestPath, "--json",
    ]);
    assert.equal(legacy.status, "team_project_event_recorded");
    assert.equal(legacy.authorizationGranted, false);
    assert.equal(readTeamProjectStatusV1({ workspaceRoot: root }).integrationGates[0].status, "passed");

    const capturePath = path.join(root, "capture-integration-request.json");
    await writeJson(capturePath, event("event-14", "integration_gate_passed", {
      gateId: "a-gate",
      summary: "Legacy capture pass.",
      evidenceRefs: ["artifact:legacy-a"],
    }));
    const captured = await runCli([
      "project", "capture", "--workspace", root, "--request", capturePath,
    ]);
    assert.equal(captured.status, "team_project_event_recorded");
    assert.equal(readTeamProjectStatusV1({ workspaceRoot: root }).overall, "completed");

    await appendEvents(wrongRoot, fullCompletionEvents());
    const wrongPath = path.join(wrongRoot, "wrong-integration-request.json");
    await writeJson(wrongPath, event("event-13", "checkpoint_recorded", {
      assignmentId: "assign-integrate",
      workItemId: "integrate",
      state: "completed",
      summary: "Wrong event type.",
      completedUnits: 1,
      evidenceRefs: ["artifact:wrong"],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: null,
    }));
    const wrongBefore = await projectSnapshot(wrongRoot);
    const wrong = await runCli([
      "project", "integrate", "--workspace", wrongRoot, "--request", wrongPath,
    ]);
    assert.equal(wrong.status, "invalid_input");
    assert.match(wrong.issues[0], /only accepts type=integration_gate_passed/iu);
    assert.deepEqual(await projectSnapshot(wrongRoot), wrongBefore);

    const mixedPath = path.join(mixedRoot, "mixed-integration-request.json");
    await writeJson(mixedPath, event("event-13", "integration_gate_passed", {
      gateId: "release-ready",
      summary: "Mixed request.",
      evidenceRefs: ["artifact:mixed"],
    }));
    const mixedBefore = await projectSnapshot(mixedRoot);
    const mixed = await runCli([
      "project", "integrate", "--workspace", mixedRoot,
      "--request", mixedPath, "--gate", "release-ready",
    ]);
    assert.equal(mixed.status, "invalid_input");
    assert.match(mixed.issues[0], /cannot be combined with direct integrate fields/iu);
    assert.deepEqual(await projectSnapshot(mixedRoot), mixedBefore);
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test("typed checkpoint records the current active fact and replays it idempotently", async () => {
  const root = await setup();
  const checkpoint = {
    checkpointId: "engine-active",
    at: "2026-08-08T00:01:00.000Z",
    assignmentId: "assign-engine",
    workItemId: "engine",
    state: "active",
    summary: "Parser work is active.",
    completedUnits: 1,
    evidenceRefs: ["artifact:parser"],
    blockerRefs: [],
    decisionRefs: [],
    nextAction: "Continue the parser.",
    sourceFingerprint: "a".repeat(64),
  };
  try {
    const assigned = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine", "--agent", "agent-runtime", "--json",
    ]);
    assert.equal(assigned.status, "team_project_assignment");
    const before = await projectSnapshot(root);
    const recorded = await runCli(directCheckpointArgs(root, checkpoint));
    assert.equal(recorded.status, "team_project_checkpoint");
    assert.equal(recorded.checkpointId, checkpoint.checkpointId);
    assert.equal(recorded.assignmentId, checkpoint.assignmentId);
    assert.equal(recorded.workItemId, checkpoint.workItemId);
    assert.equal(recorded.state, checkpoint.state);
    assert.equal(recorded.eventId, "checkpoint-engine-active");
    assert.match(recorded.eventPath, /project\/events\/checkpoint-engine-active\.json$/u);
    assert.match(recorded.eventSha256, /^[a-f0-9]{64}$/u);
    assert.equal(recorded.resumed, false);
    assert.equal(recorded.overall, "active");
    assert.equal(recorded.nextAction, "Continue the parser.");
    assert.equal(recorded.nextActorId, "agent-runtime");
    assert.equal(recorded.authorizationGranted, false);
    assert.equal(recorded.exitCode, 0);
    const humanLines = recorded.humanOutput.split("\n").filter(Boolean);
    assert.equal(
      humanLines[0],
      "Recorded checkpoint engine-active for WorkItem engine: active.",
    );
    assert.ok(humanLines.some(line => /Project state: active; next: Continue the parser\./u.test(line)));
    assert.ok(humanLines.length <= 5);
    assert.doesNotMatch(recorded.humanOutput, /\b(receipt|lease|json)\b/iu);

    const eventArtifact = JSON.parse(await readFile(
      path.join(root, recorded.eventPath),
      "utf8",
    ));
    assert.deepEqual(eventArtifact, {
      schemaVersion: "OwlCodaRunKitTeamProjectEventV1",
      eventId: "checkpoint-engine-active",
      type: "checkpoint_recorded",
      occurredAt: checkpoint.at,
      assignmentId: "assign-engine",
      workItemId: "engine",
      state: "active",
      summary: "Parser work is active.",
      completedUnits: 1,
      evidenceRefs: ["artifact:parser"],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: "Continue the parser.",
      sourceFingerprint: "a".repeat(64),
    });
    const after = await projectSnapshot(root);
    assert.equal(after.events.length, before.events.length + 1);
    const replay = await runCli(directCheckpointArgs(root, checkpoint, true));
    assert.equal(replay.status, "team_project_checkpoint");
    assert.equal(replay.resumed, true);
    assert.equal(replay.eventSha256, recorded.eventSha256);
    assert.equal(replay.projectTruthHash, recorded.projectTruthHash);
    assert.equal(Object.hasOwn(replay, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), after);

    const changed = await runCli(directCheckpointArgs(root, {
      ...checkpoint,
      summary: "Changed checkpoint claim.",
    }));
    assert.equal(changed.status, "invalid_input");
    assert.equal(changed.exitCode, 3);
    assert.match(changed.issues[0], /immutable event differs: checkpoint-engine-active/iu);
    assert.equal(Object.hasOwn(changed, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), after);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed completed checkpoint uses measurable truth, unlocks its gate, and composes with integrate", async () => {
  const root = await setup(singleItemDefinition({
    measurable: { unit: "steps", total: 2 },
  }));
  try {
    assert.equal((await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-x", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "x", "--agent", "worker", "--json",
    ])).status, "team_project_assignment");
    const completed = await runCli(directCheckpointArgs(root, {
      checkpointId: "x-completed",
      at: "2026-08-08T00:01:00.000Z",
      assignmentId: "assign-x",
      workItemId: "x",
      state: "completed",
      summary: "x is complete.",
      completedUnits: 2,
      evidenceRefs: ["artifact:x-complete"],
    }, true));
    assert.equal(completed.status, "team_project_checkpoint");
    assert.equal(completed.state, "completed");
    assert.equal(completed.nextAction, "Review integration gate done");
    assert.equal(completed.nextActorId, null);
    const eventArtifact = JSON.parse(await readFile(
      path.join(root, ".owlcoda/runkit/project/events/checkpoint-x-completed.json"),
      "utf8",
    ));
    assert.equal(eventArtifact.nextAction, null);
    assert.deepEqual(eventArtifact.blockerRefs, []);
    assert.deepEqual(eventArtifact.decisionRefs, []);
    assert.equal(Object.hasOwn(eventArtifact, "sourceFingerprint"), false);
    let status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.workItems.find(row => row.workItemId === "x").status, "completed");
    assert.equal(status.integrationGates[0].status, "ready");
    assert.equal(status.overall, "active");
    assert.equal(status.nextAction, "Review integration gate done");

    const integrated = await runCli(directIntegrateArgs(root, {
      gateId: "done",
      at: "2026-08-08T00:02:00.000Z",
      summary: "x integration accepted.",
      evidenceRefs: ["artifact:done"],
    }, true));
    assert.equal(integrated.status, "team_project_integration");
    assert.equal(integrated.gateStatus, "passed");
    assert.equal(integrated.overall, "completed");
    status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.overall, "completed");
    assert.deepEqual(await readdir(path.join(root, ".owlcoda/runkit")), ["project"]);

    const beforeReopen = await projectSnapshot(root);
    const reopened = await runCli(directCheckpointArgs(root, {
      checkpointId: "x-reopened",
      at: "2026-08-08T00:03:00.000Z",
      assignmentId: "assign-x",
      workItemId: "x",
      state: "active",
      summary: "A passed gate cannot be invalidated.",
      completedUnits: 1,
      evidenceRefs: ["artifact:reopen-attempt"],
    }, true));
    assert.equal(reopened.status, "invalid_input");
    assert.equal(reopened.exitCode, 3);
    assert.equal(reopened.authorizationGranted, false);
    assert.match(reopened.issues[0], /cannot invalidate passed integration gate done/iu);
    assert.deepEqual(await projectSnapshot(root), beforeReopen);
    assert.equal(readTeamProjectStatusV1({ workspaceRoot: root }).overall, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed checkpoint stale replay fails closed after newer checkpoint, handoff, and successor assignment", async () => {
  const root = await setup();
  const oldCheckpoint = {
    checkpointId: "engine-old",
    at: "2026-08-08T00:01:00.000Z",
    assignmentId: "assign-engine",
    workItemId: "engine",
    state: "active",
    summary: "Old progress.",
    completedUnits: 1,
    evidenceRefs: ["artifact:old"],
  };
  const newestCheckpoint = {
    ...oldCheckpoint,
    checkpointId: "engine-new",
    at: "2026-08-08T00:02:00.000Z",
    summary: "Newest progress.",
    completedUnits: 2,
    evidenceRefs: ["artifact:new"],
    nextAction: "Verify the newest progress.",
  };
  try {
    assert.equal((await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine", "--agent", "agent-a", "--json",
    ])).status, "team_project_assignment");
    assert.equal((await runCli(directCheckpointArgs(root, oldCheckpoint, true))).resumed, false);
    const newest = await runCli(directCheckpointArgs(root, newestCheckpoint, true));
    assert.equal(newest.status, "team_project_checkpoint");
    assert.equal(newest.resumed, false);
    const beforeOldReplay = await projectSnapshot(root);
    const oldReplay = await runCli(directCheckpointArgs(root, oldCheckpoint));
    assert.equal(oldReplay.status, "invalid_input");
    assert.equal(oldReplay.exitCode, 3);
    assert.match(
      oldReplay.issues[0],
      /historical\/superseded.*current assignment=assign-engine.*latest fact=checkpoint-engine-new/iu,
    );
    assert.equal(Object.hasOwn(oldReplay, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), beforeOldReplay);

    const currentReplay = await runCli(directCheckpointArgs(root, newestCheckpoint, true));
    assert.equal(currentReplay.status, "team_project_checkpoint");
    assert.equal(currentReplay.resumed, true);

    const handoff = await runCli(directHandoffArgs(root, {
      handoffId: "after-checkpoint",
      at: "2026-08-08T00:03:00.000Z",
      assignmentId: "assign-engine",
      workItemId: "engine",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      summary: "Target Agent should continue the newest context.",
      nextAction: "Continue the newest context.",
      evidenceRefs: ["artifact:handoff"],
    }, true));
    assert.equal(handoff.status, "team_project_handoff");
    const beforeHandoffReplay = await projectSnapshot(root);
    const handoffReplay = await runCli(directCheckpointArgs(root, newestCheckpoint));
    assert.equal(handoffReplay.status, "invalid_input");
    assert.match(
      handoffReplay.issues[0],
      /historical\/superseded.*current assignment=assign-engine.*latest fact=handoff-after-checkpoint/iu,
    );
    assert.deepEqual(await projectSnapshot(root), beforeHandoffReplay);

    const successor = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine-b", "--at", "2026-08-08T00:04:00.000Z",
      "--work-item", "engine", "--agent", "agent-b",
      "--supersedes", "assign-engine", "--json",
    ]);
    assert.equal(successor.status, "team_project_assignment");
    const beforeSuccessorReplay = await projectSnapshot(root);
    const successorReplay = await runCli(directCheckpointArgs(root, newestCheckpoint));
    assert.equal(successorReplay.status, "invalid_input");
    assert.match(
      successorReplay.issues[0],
      /historical\/superseded.*current assignment=assign-engine-b.*latest fact=handoff-after-checkpoint/iu,
    );
    assert.deepEqual(await projectSnapshot(root), beforeSuccessorReplay);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed waiting-decision checkpoint remains linked until typed decision resolution", async () => {
  const root = await setup();
  try {
    assert.equal((await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine", "--agent", "agent-runtime", "--json",
    ])).status, "team_project_assignment");
    const opened = await runCli(directDecisionArgs(root, {
      operation: "open",
      decisionId: "scope-decision",
      at: "2026-08-08T00:01:00.000Z",
      title: "Scope",
      question: "Which scope should continue?",
      ownerAgentId: "owner",
      blockingWorkItemIds: ["engine"],
      options: ["driver", "formal"],
    }, true));
    assert.equal(opened.status, "team_project_decision");
    const waiting = await runCli(directCheckpointArgs(root, {
      checkpointId: "engine-waiting-decision",
      at: "2026-08-08T00:02:00.000Z",
      assignmentId: "assign-engine",
      workItemId: "engine",
      state: "waiting_decision",
      summary: "Waiting for the scope decision.",
      completedUnits: 1,
      evidenceRefs: ["artifact:waiting"],
      blockerRefs: ["decision:scope-decision"],
      decisionRefs: ["scope-decision"],
      nextAction: "Resolve scope-decision before continuing.",
    }, true));
    assert.equal(waiting.status, "team_project_checkpoint");
    assert.equal(waiting.nextAction, "Resolve scope-decision");
    assert.equal(waiting.nextActorId, "owner");
    let status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.status, "waiting_decision");
    assert.deepEqual(engine.blockers, ["decision:scope-decision"]);
    assert.deepEqual(engine.decisionRefs, ["scope-decision"]);

    const resolved = await runCli(directDecisionArgs(root, {
      operation: "resolve",
      decisionId: "scope-decision",
      at: "2026-08-08T00:03:00.000Z",
      resolution: "driver",
      rationale: "The driver slice continues.",
      evidenceRefs: ["decision-record:scope"],
    }, true));
    assert.equal(resolved.status, "team_project_decision");
    status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.workItems.find(row => row.workItemId === "engine").status, "active");
    assert.deepEqual(status.workItems.find(row => row.workItemId === "engine").blockers, []);
    assert.deepEqual(status.workItems.find(row => row.workItemId === "engine").decisionRefs, []);
    assert.equal(status.nextAction, "Continue engine.");
    assert.equal(status.nextActorId, "agent-runtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed checkpoint rejects unsafe direct inputs and preserves zero-write boundaries", async () => {
  const roots = [];
  const assignedRoot = async (workItemId = "engine", assignmentId = `assign-${workItemId}`) => {
    const root = await setup();
    roots.push(root);
    const assigned = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", assignmentId, "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", workItemId, "--agent", "agent-a", "--json",
    ]);
    assert.equal(assigned.status, "team_project_assignment");
    return root;
  };
  const assertRejectedWithoutWrite = async (root, args, pattern) => {
    const before = await projectSnapshot(root);
    const result = await runCli(args);
    assert.equal(result.status, "invalid_input");
    assert.equal(result.exitCode, 3);
    assert.equal(result.authorizationGranted, false);
    assert.match(result.issues[0], pattern);
    assert.equal(Object.hasOwn(result, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), before);
  };
  try {
    for (const [label, completedUnits] of [
      ["negative", -1],
      ["fractional", 1.2],
      ["nan", "NaN"],
      ["empty", ""],
      ["overflow", "9007199254740992"],
    ]) {
      const root = await assignedRoot();
      await assertRejectedWithoutWrite(
        root,
        directCheckpointArgs(root, {
          checkpointId: `invalid-units-${label}`,
          at: "2026-08-08T00:01:00.000Z",
          assignmentId: "assign-engine",
          workItemId: "engine",
          state: "active",
          summary: "Invalid units.",
          completedUnits,
        }),
        /completed-units must be a canonical non-negative safe integer/iu,
      );
    }

    const invalidState = await assignedRoot();
    await assertRejectedWithoutWrite(
      invalidState,
      directCheckpointArgs(invalidState, {
        checkpointId: "invalid-state",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "invalid_state",
        summary: "Invalid state.",
      }),
      /Checkpoint state is invalid/iu,
    );
    const malformedId = await assignedRoot();
    await assertRejectedWithoutWrite(
      malformedId,
      directCheckpointArgs(malformedId, {
        checkpointId: "bad/id",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Malformed id.",
      }),
      /checkpointId must use letters/iu,
    );
    const malformedTime = await assignedRoot();
    await assertRejectedWithoutWrite(
      malformedTime,
      directCheckpointArgs(malformedTime, {
        checkpointId: "bad-time",
        at: "2026-08-08T00:01:00Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Malformed time.",
      }),
      /ISO-8601 UTC timestamp/iu,
    );
    const badFingerprint = await assignedRoot();
    await assertRejectedWithoutWrite(
      badFingerprint,
      directCheckpointArgs(badFingerprint, {
        checkpointId: "bad-fingerprint",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Bad fingerprint.",
        sourceFingerprint: "not-a-sha256",
      }),
      /sourceFingerprint is invalid/iu,
    );
    const wrongAssignment = await assignedRoot();
    await assertRejectedWithoutWrite(
      wrongAssignment,
      directCheckpointArgs(wrongAssignment, {
        checkpointId: "wrong-assignment",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "other-assignment",
        workItemId: "engine",
        state: "active",
        summary: "Wrong assignment.",
      }),
      /bind the current assignment/iu,
    );
    const missingUnits = await assignedRoot();
    await assertRejectedWithoutWrite(
      missingUnits,
      directCheckpointArgs(missingUnits, {
        checkpointId: "missing-units",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Missing units.",
      }),
      /Measured work item checkpoint requires completedUnits/iu,
    );
    const noCompletedEvidence = await assignedRoot();
    await assertRejectedWithoutWrite(
      noCompletedEvidence,
      directCheckpointArgs(noCompletedEvidence, {
        checkpointId: "no-completed-evidence",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "completed",
        summary: "No evidence.",
        completedUnits: 4,
      }),
      /Completed checkpoint requires evidence/iu,
    );
    const blankCompletedEvidence = await assignedRoot();
    await assertRejectedWithoutWrite(
      blankCompletedEvidence,
      directCheckpointArgs(blankCompletedEvidence, {
        checkpointId: "blank-completed-evidence",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "completed",
        summary: "Blank evidence must not prove completion.",
        completedUnits: 4,
        evidenceRefs: ["   "],
      }),
      /evidenceRefs must be a unique string array/iu,
    );
    const duplicateArrays = await assignedRoot();
    await assertRejectedWithoutWrite(
      duplicateArrays,
      directCheckpointArgs(duplicateArrays, {
        checkpointId: "duplicate-arrays",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Duplicate arrays.",
        completedUnits: 1,
        evidenceRefs: ["same", "same"],
        blockerRefs: ["same", "same"],
        decisionRefs: ["same", "same"],
      }),
      /evidenceRefs must be a unique string array/iu,
    );
    const outOfOrder = await assignedRoot();
    assert.equal((await runCli(directCheckpointArgs(outOfOrder, {
      checkpointId: "first-order",
      at: "2026-08-08T00:01:00.000Z",
      assignmentId: "assign-engine",
      workItemId: "engine",
      state: "active",
      summary: "First order checkpoint.",
      completedUnits: 1,
    }, true))).status, "team_project_checkpoint");
    await assertRejectedWithoutWrite(
      outOfOrder,
      directCheckpointArgs(outOfOrder, {
        checkpointId: "second-order",
        at: "2026-08-08T00:00:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Backdated checkpoint.",
        completedUnits: 1,
      }),
      /must sort after the latest event/iu,
    );

    const dependencyRoot = await setup();
    roots.push(dependencyRoot);
    assert.equal((await runCli([
      "project", "assign", "--workspace", dependencyRoot,
      "--assignment-id", "assign-cli", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "cli", "--agent", "agent-a", "--json",
    ])).status, "team_project_assignment");
    await assertRejectedWithoutWrite(
      dependencyRoot,
      directCheckpointArgs(dependencyRoot, {
        checkpointId: "dependency-blocked",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-cli",
        workItemId: "cli",
        state: "completed",
        summary: "Dependency is incomplete.",
        evidenceRefs: ["artifact:cli"],
      }),
      /unresolved dependencies: engine/iu,
    );
    const unknownWork = await setup();
    roots.push(unknownWork);
    await assertRejectedWithoutWrite(
      unknownWork,
      directCheckpointArgs(unknownWork, {
        checkpointId: "unknown-work",
        at: "2026-08-08T00:00:00.000Z",
        assignmentId: "assign-missing",
        workItemId: "missing-work",
        state: "active",
        summary: "Unknown work item.",
      }),
      /unknown work item/iu,
    );
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test("typed checkpoint request compatibility is restricted while capture remains legacy-compatible", async () => {
  const roots = [];
  const assignedRoot = async () => {
    const root = await setup();
    roots.push(root);
    assert.equal((await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine", "--agent", "agent-a", "--json",
    ])).status, "team_project_assignment");
    return root;
  };
  const checkpointEvent = event("event-02", "checkpoint_recorded", {
    assignmentId: "assign-engine",
    workItemId: "engine",
    state: "active",
    summary: "Legacy checkpoint request.",
    completedUnits: 1,
    evidenceRefs: ["artifact:legacy"],
    blockerRefs: [],
    decisionRefs: [],
    nextAction: null,
  });
  try {
    const legacy = await assignedRoot();
    const requestPath = path.join(legacy, "checkpoint-request.json");
    await writeJson(requestPath, checkpointEvent);
    const recorded = await runCli([
      "project", "checkpoint", "--workspace", legacy,
      "--request", requestPath, "--json",
    ]);
    assert.equal(recorded.status, "team_project_event_recorded");
    assert.equal(recorded.authorizationGranted, false);
    assert.deepEqual(await eventFiles(legacy), ["assignment-assign-engine.json", "event-02.json"]);
    const beforeMixed = await projectSnapshot(legacy);
    const mixed = await runCli([
      "project", "checkpoint", "--workspace", legacy,
      "--request", requestPath, "--checkpoint-id", "mixed",
    ]);
    assert.equal(mixed.status, "invalid_input");
    assert.match(mixed.issues[0], /cannot be combined with direct checkpoint fields/iu);
    assert.deepEqual(await projectSnapshot(legacy), beforeMixed);

    const wrong = await assignedRoot();
    const wrongPath = path.join(wrong, "wrong-checkpoint-request.json");
    await writeJson(wrongPath, event("event-02", "agent_assigned", {
      assignmentId: "another-assignment",
      workItemId: "engine",
      agentId: "agent-b",
    }));
    const beforeWrong = await projectSnapshot(wrong);
    const wrongResult = await runCli([
      "project", "checkpoint", "--workspace", wrong,
      "--request", wrongPath,
    ]);
    assert.equal(wrongResult.status, "invalid_input");
    assert.match(wrongResult.issues[0], /only accepts type=checkpoint_recorded/iu);
    assert.deepEqual(await projectSnapshot(wrong), beforeWrong);

    const capture = await assignedRoot();
    const capturePath = path.join(capture, "capture-checkpoint-request.json");
    await writeJson(capturePath, checkpointEvent);
    const captured = await runCli([
      "project", "capture", "--workspace", capture,
      "--request", capturePath,
    ]);
    assert.equal(captured.status, "team_project_event_recorded");
    assert.equal(captured.authorizationGranted, false);
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test("failed work is not completed and defaults to an explicit rework action", async () => {
  const root = await setup();
  try {
    await appendEvents(root, [
      event("event-01", "agent_assigned", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        agentId: "agent-runtime",
      }),
      event("event-02", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "failed",
        summary: "The engine implementation failed its focused check.",
        completedUnits: 1,
        evidenceRefs: ["test:engine-failed"],
        blockerRefs: ["test:focused-check"],
        decisionRefs: [],
        nextAction: null,
      }),
    ]);
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    const cli = status.workItems.find(row => row.workItemId === "cli");
    assert.equal(engine.status, "failed");
    assert.notEqual(cli.status, "completed");
    assert.equal(status.counts.completed, 0);
    assert.equal(status.dominantGap.kind, "failed_work");
    assert.equal(status.dominantGap.workItemId, "engine");
    assert.equal(status.nextAction, "Rework engine");
    assert.equal(status.nextActorId, "agent-runtime");
    assert.ok(status.headline.includes("The engine implementation failed its focused check."));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assigned verification stages and unassigned work use the fixed next-action vocabulary", async () => {
  const verifyingRoot = await setup();
  const emptyRoot = await setup();
  try {
    await appendEvents(verifyingRoot, [
      event("event-01", "agent_assigned", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        agentId: "agent-runtime",
      }),
      event("event-02", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "verifying",
        summary: "Ready for verification.",
        completedUnits: 4,
        evidenceRefs: ["artifact:engine-ready"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
    ]);
    const verifying = readTeamProjectStatusV1({ workspaceRoot: verifyingRoot });
    assert.equal(verifying.dominantGap.workItemId, "engine");
    assert.equal(verifying.nextAction, "Verify engine");
    assert.equal(verifying.nextActorId, "agent-runtime");

    appendTeamProjectEventV1({
      workspaceRoot: verifyingRoot,
      event: event("event-03", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "ready_to_integrate",
        summary: "Verification complete; integration remains.",
        completedUnits: 4,
        evidenceRefs: ["receipt:engine-verify"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
    });
    const readyToIntegrate = readTeamProjectStatusV1({ workspaceRoot: verifyingRoot });
    assert.equal(readyToIntegrate.nextAction, "Integrate engine");
    assert.equal(readyToIntegrate.nextActorId, "agent-runtime");

    const empty = readTeamProjectStatusV1({ workspaceRoot: emptyRoot });
    assert.equal(empty.dominantGap.kind, "work_item");
    assert.equal(empty.dominantGap.workItemId, "engine");
    assert.equal(empty.nextAction, "Assign engine");
    assert.equal(empty.nextActorId, null);
  } finally {
    await Promise.all([
      rm(verifyingRoot, { recursive: true, force: true }),
      rm(emptyRoot, { recursive: true, force: true }),
    ]);
  }
});

test("equivalent definition and event storage order does not change the dominant decision", async () => {
  const events = [
    event("event-01", "agent_assigned", {
      assignmentId: "assign-engine",
      workItemId: "engine",
      agentId: "agent-runtime",
    }),
    event("event-02", "checkpoint_recorded", {
      assignmentId: "assign-engine",
      workItemId: "engine",
      state: "waiting_decision",
      summary: "Waiting for one of two decisions.",
      completedUnits: 1,
      evidenceRefs: ["artifact:engine-progress"],
      blockerRefs: ["decision:scope-a", "decision:scope-z"],
      decisionRefs: ["scope-z", "scope-a"],
      nextAction: "Continue after the decision.",
    }),
    event("event-03", "decision_opened", {
      decisionId: "scope-z",
      title: "Later decision",
      question: "Should the later scope apply?",
      ownerAgentId: "owner-z",
      blockingWorkItemIds: ["engine"],
      options: ["yes", "no"],
    }),
    event("event-04", "decision_opened", {
      decisionId: "scope-a",
      title: "Earlier decision",
      question: "Should the earlier scope apply?",
      ownerAgentId: "owner-a",
      blockingWorkItemIds: ["engine"],
      options: ["yes", "no"],
    }),
  ];
  const orderedRoot = await setup();
  const reorderedDefinition = definition();
  reorderedDefinition.workItems = [...reorderedDefinition.workItems].reverse();
  const reorderedRoot = await setup(reorderedDefinition);
  try {
    await appendEvents(orderedRoot, events);
    for (const value of [...events].reverse()) {
      await writeJson(
        path.join(reorderedRoot, ".owlcoda/runkit/project/events", `${value.eventId}.json`),
        value,
      );
    }
    const ordered = readTeamProjectStatusV1({ workspaceRoot: orderedRoot });
    const reordered = readTeamProjectStatusV1({ workspaceRoot: reorderedRoot });
    assert.deepEqual(reordered.dominantGap, ordered.dominantGap);
    assert.equal(ordered.dominantGap.id, "scope-a");
    assert.equal(ordered.nextAction, "Resolve scope-a");
    assert.equal(ordered.nextActorId, "owner-a");
    assert.equal(reordered.nextAction, ordered.nextAction);
    assert.equal(reordered.nextActorId, ordered.nextActorId);
  } finally {
    await Promise.all([
      rm(orderedRoot, { recursive: true, force: true }),
      rm(reorderedRoot, { recursive: true, force: true }),
    ]);
  }
});

test("handoff and reassignment preserve history while a blank Agent can recover the next action", async () => {
  const root = await setup();
  try {
    for (const value of [
      event("event-10", "agent_assigned", {
        assignmentId: "assign-engine-a",
        workItemId: "engine",
        agentId: "agent-a",
      }),
      event("event-11", "checkpoint_recorded", {
        assignmentId: "assign-engine-a",
        workItemId: "engine",
        state: "active",
        summary: "Parser is complete; projector remains.",
        completedUnits: 1,
        evidenceRefs: ["artifact:parser-pass"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: "Implement the projector.",
      }),
      event("event-12", "handoff_recorded", {
        assignmentId: "assign-engine-a",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        summary: "Continue from the accepted parser checkpoint.",
        evidenceRefs: ["artifact:parser-pass"],
        nextAction: "Implement the projector.",
      }),
      event("event-13", "agent_assigned", {
        assignmentId: "assign-engine-b",
        supersedesAssignmentId: "assign-engine-a",
        workItemId: "engine",
        agentId: "agent-b",
      }),
    ]) appendTeamProjectEventV1({ workspaceRoot: root, event: value });

    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.agentId, "agent-b");
    assert.equal(engine.assignmentId, "assign-engine-b");
    assert.deepEqual(engine.assignmentHistory.map(row => row.assignmentId), [
      "assign-engine-a",
      "assign-engine-b",
    ]);
    assert.equal(status.nextAction, "Implement the projector.");
    assert.equal(status.nextActorId, "agent-b");

    const takeover = buildTeamProjectTakeoverV1({
      workspaceRoot: root,
      agentId: "agent-b",
    });
    assert.equal(takeover.objective, definition().objective);
    assert.equal(takeover.currentResponsibility.workItemId, "engine");
    assert.equal(takeover.lastAcceptedCheckpoint.summary, "Parser is complete; projector remains.");
    assert.equal(takeover.nextAction, "Implement the projector.");
    assert.equal(takeover.projectNextAction, "Implement the projector.");
    assert.equal(takeover.projectNextActorId, "agent-b");
    assert.deepEqual(takeover.unresolvedDecisions, []);
    assert.ok(takeover.evidenceRefs.includes("artifact:parser-pass"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed checkpoint clears an earlier handoff next action everywhere", async () => {
  const root = await setup();
  try {
    for (const value of [
      event("event-14", "agent_assigned", {
        assignmentId: "assign-engine-a",
        workItemId: "engine",
        agentId: "agent-a",
      }),
      event("event-15", "handoff_recorded", {
        assignmentId: "assign-engine-a",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        summary: "Continue the projector implementation.",
        evidenceRefs: ["artifact:handoff"],
        nextAction: "Implement the projector.",
      }),
      event("event-16", "agent_assigned", {
        assignmentId: "assign-engine-b",
        supersedesAssignmentId: "assign-engine-a",
        workItemId: "engine",
        agentId: "agent-b",
      }),
      event("event-17", "checkpoint_recorded", {
        assignmentId: "assign-engine-b",
        workItemId: "engine",
        state: "completed",
        summary: "Projector completed and verified.",
        completedUnits: 4,
        evidenceRefs: ["receipt:projector-pass"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
    ]) appendTeamProjectEventV1({ workspaceRoot: root, event: value });

    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    const agent = status.agents.find(row => row.agentId === "agent-b");
    assert.equal(engine.status, "completed");
    assert.equal(engine.summary, "Projector completed and verified.");
    assert.equal(engine.nextAction, null);
    assert.deepEqual(agent.nextActions, []);

    const takeover = buildTeamProjectTakeoverV1({
      workspaceRoot: root,
      agentId: "agent-b",
    });
    assert.equal(takeover.currentResponsibility.status, "completed");
    assert.equal(takeover.nextAction, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project status and takeover are read-only, while event ids are immutable and idempotent", async () => {
  const root = await setup();
  try {
    const assigned = event("event-20", "agent_assigned", {
      assignmentId: "assign-contract",
      workItemId: "contract",
      agentId: "agent-a",
    });
    const first = appendTeamProjectEventV1({ workspaceRoot: root, event: assigned });
    const resumed = appendTeamProjectEventV1({ workspaceRoot: root, event: assigned });
    assert.equal(first.resumed, false);
    assert.equal(resumed.resumed, true);
    assert.throws(() => appendTeamProjectEventV1({
      workspaceRoot: root,
      event: { ...assigned, agentId: "agent-b" },
    }), /immutable event differs/iu);
    assert.throws(() => appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-19", "decision_opened", {
        decisionId: "backdated",
        title: "Backdated decision",
        question: "Should this reorder project history?",
        ownerAgentId: "owner",
        blockingWorkItemIds: [],
        options: ["no"],
      }),
    }), /must sort after the latest event/iu);

    const before = await treeHash(root);
    readTeamProjectStatusV1({ workspaceRoot: root });
    buildTeamProjectTakeoverV1({ workspaceRoot: root, agentId: "agent-a" });
    const cliStatus = await runCli([
      "project", "status", "--workspace", root, "--json",
    ]);
    const cliTakeover = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "agent-a", "--json",
    ]);
    const after = await treeHash(root);
    assert.equal(cliStatus.status, "team_project_status");
    assert.equal(cliTakeover.status, "team_project_takeover");
    assert.equal(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project status rejects a redirected event directory instead of hiding history", async () => {
  const root = await setup(singleItemDefinition());
  try {
    appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-01", "agent_assigned", {
        assignmentId: "assign-x",
        workItemId: "x",
        agentId: "agent-a",
      }),
    });
    const projectRoot = path.join(root, ".owlcoda/runkit/project");
    const eventsRoot = path.join(projectRoot, "events");
    const preservedEventsRoot = path.join(projectRoot, "preserved-events");
    const redirectedEventsRoot = path.join(projectRoot, "redirected-events");
    await rename(eventsRoot, preservedEventsRoot);
    await mkdir(redirectedEventsRoot);
    await symlink(redirectedEventsRoot, eventsRoot, "dir");

    assert.throws(
      () => readTeamProjectStatusV1({ workspaceRoot: root }),
      /event directory.*regular directory without symlinks/iu,
    );
    const status = await runCli(["project", "status", "--workspace", root, "--json"]);
    assert.equal(status.status, "invalid_input");
    assert.equal(status.exitCode, 3);
    assert.equal(status.authorizationGranted, false);
    assert.deepEqual(await readdir(preservedEventsRoot), ["event-01.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("team project contracts reject fake percentages, cycles, unevidenced completion, and overlapping active ownership", async () => {
  const root = await setup();
  try {
    const emptyWorkspace = path.join(root, "empty-project");
    assert.throws(() => initializeTeamProjectV1({
      workspaceRoot: emptyWorkspace,
      definition: {
        ...definition(),
        milestones: [],
        workstreams: [],
        workItems: [],
        integrationGates: [],
      },
    }), /at least one WorkItem/iu);
    await assert.rejects(access(emptyWorkspace), error => error?.code === "ENOENT");

    assert.throws(() => initializeTeamProjectV1({
      workspaceRoot: path.join(root, "invalid-project"),
      definition: {
        ...definition(),
        workItems: definition().workItems.map((row, index) => index === 0
          ? { ...row, percentComplete: 80 }
          : row),
      },
    }), /unsupported field.*percentComplete/iu);
    assert.throws(() => initializeTeamProjectV1({
      workspaceRoot: path.join(root, "cyclic-project"),
      definition: {
        ...definition(),
        workItems: definition().workItems.map(row => row.id === "contract"
          ? { ...row, dependencies: ["docs"] }
          : row),
      },
    }), /dependency cycle/iu);

    appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-30", "agent_assigned", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        agentId: "agent-a",
      }),
    });
    assert.throws(() => appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-31", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "completed",
        summary: "Done without proof.",
        completedUnits: 4,
        evidenceRefs: [],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
    }), /completed checkpoint requires evidence/iu);

    appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-32", "agent_assigned", {
        assignmentId: "assign-integrate",
        workItemId: "integrate",
        agentId: "agent-release",
      }),
    });
    assert.throws(() => appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-33", "agent_assigned", {
        assignmentId: "assign-package",
        workItemId: "docs",
        agentId: "agent-docs",
      }),
    }), /owned paths overlap active assignment/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("decision and data-candidate events remain provenance-bound and incomplete facts are not promoted", async () => {
  const root = await setup();
  try {
    for (const value of [
      event("event-40", "decision_opened", {
        decisionId: "scope-decision",
        title: "Scope",
        question: "Ship both features?",
        ownerAgentId: "owner",
        blockingWorkItemIds: ["integrate"],
        options: ["yes", "no"],
      }),
      event("event-41", "decision_resolved", {
        decisionId: "scope-decision",
        resolution: "yes",
        rationale: "Both are needed for the product promise.",
        evidenceRefs: ["decision-record:scope-v1"],
      }),
      event("event-42", "data_candidate_recorded", {
        candidateId: "candidate-complete",
        sourceRef: "execution:formal-engine-001",
        rights: "project_owned",
        inputRef: "artifact:input",
        outputRef: "artifact:output",
        decisionRef: "decision-record:scope-v1",
        verificationRefs: ["receipt:quality"],
        outcomeRef: "outcome:accepted",
        version: "1",
      }),
      event("event-43", "data_candidate_recorded", {
        candidateId: "candidate-incomplete",
        sourceRef: "execution:formal-engine-002",
        rights: "unknown",
        inputRef: "artifact:input-2",
        outputRef: "artifact:output-2",
        decisionRef: null,
        verificationRefs: [],
        outcomeRef: null,
        version: "1",
      }),
    ]) appendTeamProjectEventV1({ workspaceRoot: root, event: value });

    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.openDecisions.length, 0);
    assert.equal(status.resolvedDecisions[0].evidenceRefs[0], "decision-record:scope-v1");
    assert.equal(status.dataCandidates[0].admissionStatus, "eligible_candidate");
    assert.equal(status.dataCandidates[1].admissionStatus, "incomplete");
    assert.deepEqual(status.dataCandidates[1].missingFields, [
      "decisionRef",
      "outcomeRef",
      "rights",
      "verificationRefs",
    ]);
    assert.equal(status.dataCandidates.some(row => row.admissionStatus === "dataset_member"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the project CLI writes typed events from request files and keeps authority false", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-team-cli-"));
  try {
    const definitionPath = path.join(root, "project-definition.json");
    const assignmentPath = path.join(root, "assignment.json");
    await writeJson(definitionPath, definition());
    await writeJson(assignmentPath, event("event-50", "agent_assigned", {
      assignmentId: "assign-contract",
      workItemId: "contract",
      agentId: "agent-a",
    }));
    const initialized = await runCli([
      "project", "init", "--workspace", root, "--definition", definitionPath,
    ]);
    const appended = await runCli([
      "project", "assign", "--workspace", root, "--request", assignmentPath,
    ]);
    assert.equal(initialized.status, "team_project_initialized");
    assert.equal(appended.status, "team_project_event_recorded");
    assert.equal(initialized.authorizationGranted, false);
    assert.equal(appended.authorizationGranted, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed project assignment records one deterministic event and returns the driver action", async () => {
  const root = await setup();
  const args = [
    "project", "assign", "--workspace", root,
    "--assignment-id", "assign-engine",
    "--at", "2026-08-08T00:00:00.000Z",
    "--work-item", "engine",
    "--agent", "agent-runtime",
  ];
  try {
    const before = await treeHash(root);
    const assigned = await runCli(args);
    assert.equal(assigned.status, "team_project_assignment");
    assert.equal(assigned.assignmentId, "assign-engine");
    assert.equal(assigned.workItemId, "engine");
    assert.equal(assigned.agentId, "agent-runtime");
    assert.equal(assigned.eventId, "assignment-assign-engine");
    assert.match(assigned.eventPath, /project\/events\/assignment-assign-engine\.json$/u);
    assert.match(assigned.eventSha256, /^[a-f0-9]{64}$/u);
    assert.equal(assigned.resumed, false);
    assert.equal(assigned.nextAction, "Continue engine.");
    assert.equal(assigned.nextActorId, "agent-runtime");
    assert.equal(assigned.authorizationGranted, false);
    assert.equal(assigned.exitCode, 0);
    const humanLines = assigned.humanOutput.split("\n").filter(Boolean);
    assert.match(humanLines[0], /^Assigned WorkItem engine to Agent agent-runtime\.$/u);
    assert.ok(humanLines.length <= 5);
    assert.doesNotMatch(assigned.humanOutput, /receipt|lease|json/iu);
    assert.equal(
      (await readdir(path.join(root, ".owlcoda/runkit"))).includes("executions"),
      false,
    );
    assert.deepEqual(await eventFiles(root), ["assignment-assign-engine.json"]);
    const after = await treeHash(root);
    assert.notEqual(after, before);

    const repeated = await runCli(args);
    assert.equal(repeated.status, "team_project_assignment");
    assert.equal(repeated.resumed, true);
    assert.equal(repeated.eventSha256, assigned.eventSha256);
    assert.equal(repeated.projectTruthHash, assigned.projectTruthHash);
    assert.deepEqual(await eventFiles(root), ["assignment-assign-engine.json"]);
    assert.equal(await treeHash(root), after);

    const structured = await runCli([...args, "--json"]);
    assert.equal(structured.status, "team_project_assignment");
    assert.equal(structured.resumed, true);
    assert.equal(structured.authorizationGranted, false);
    assert.equal(Object.hasOwn(structured, "humanOutput"), false);

    const reassigned = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine-b",
      "--at", "2026-08-08T00:01:00.000Z",
      "--work-item", "engine",
      "--agent", "agent-b",
      "--supersedes", "assign-engine",
      "--json",
    ]);
    assert.equal(reassigned.status, "team_project_assignment");
    assert.equal(reassigned.resumed, false);
    assert.equal(reassigned.eventId, "assignment-assign-engine-b");
    assert.equal(reassigned.nextActorId, "agent-b");
    assert.deepEqual(await eventFiles(root), [
      "assignment-assign-engine-b.json",
      "assignment-assign-engine.json",
    ]);
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(status.workItems.find(row => row.workItemId === "engine").agentId, "agent-b");

    const staleBefore = {
      tree: await treeHash(root),
      events: await eventFiles(root),
      truth: status.projectTruthHash,
    };
    const stale = await runCli(args);
    assert.equal(stale.status, "invalid_input");
    assert.equal(stale.exitCode, 3);
    assert.equal(stale.authorizationGranted, false);
    assert.match(
      stale.issues[0],
      /historical\/superseded.*current assignment=assign-engine-b.*current owner=agent-b/iu,
    );
    assert.equal(Object.hasOwn(stale, "humanOutput"), false);
    assert.deepEqual({
      tree: await treeHash(root),
      events: await eventFiles(root),
      truth: readTeamProjectStatusV1({ workspaceRoot: root }).projectTruthHash,
    }, staleBefore);

    const currentReplay = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine-b",
      "--at", "2026-08-08T00:01:00.000Z",
      "--work-item", "engine",
      "--agent", "agent-b",
      "--supersedes", "assign-engine",
    ]);
    assert.equal(currentReplay.status, "team_project_assignment");
    assert.equal(currentReplay.resumed, true);
    assert.equal(currentReplay.assignmentId, "assign-engine-b");
    assert.equal(currentReplay.agentId, "agent-b");
    assert.match(
      currentReplay.humanOutput.split("\n").filter(Boolean)[0],
      /^Resumed WorkItem engine to Agent agent-b\.$/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed assignment helper compiles the existing agent_assigned event contract", async () => {
  const root = await setup();
  try {
    const assigned = teamProject.assignTeamProjectV1({
      workspaceRoot: root,
      assignmentId: "assign-helper",
      occurredAt: "2026-08-08T00:00:00.000Z",
      workItemId: "engine",
      agentId: "agent-helper",
    });
    assert.equal(assigned.status, "team_project_assignment");
    assert.equal(assigned.eventId, "assignment-assign-helper");
    assert.equal(assigned.resumed, false);
    const stored = JSON.parse(await readFile(
      path.join(root, ".owlcoda/runkit/project/events/assignment-assign-helper.json"),
      "utf8",
    ));
    assert.deepEqual(stored, {
      schemaVersion: "OwlCodaRunKitTeamProjectEventV1",
      eventId: "assignment-assign-helper",
      type: "agent_assigned",
      occurredAt: "2026-08-08T00:00:00.000Z",
      assignmentId: "assign-helper",
      workItemId: "engine",
      agentId: "agent-helper",
    });
    assert.equal(assigned.projectTruthHash, readTeamProjectStatusV1({ workspaceRoot: root }).projectTruthHash);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed assignment rejects unsafe requests without appending another event", async () => {
  const root = await setup();
  const assign = (assignmentId, at, workItemId, agentId, extra = []) => runCli([
    "project", "assign", "--workspace", root,
    "--assignment-id", assignmentId,
    "--at", at,
    "--work-item", workItemId,
    "--agent", agentId,
    ...extra,
  ]);
  try {
    assert.equal((await assign(
      "assign-engine", "2026-08-08T00:00:00.000Z", "engine", "agent-runtime",
    )).status, "team_project_assignment");
    assert.equal((await assign(
      "assign-integrate", "2026-08-08T00:01:00.000Z", "integrate", "agent-release",
    )).status, "team_project_assignment");
    const snapshot = async () => ({
      tree: await treeHash(root),
      events: await eventFiles(root),
      truth: readTeamProjectStatusV1({ workspaceRoot: root }).projectTruthHash,
    });
    const assertRejectedWithoutWrite = async (args, pattern) => {
      const before = await snapshot();
      const result = await runCli(args);
      assert.equal(result.status, "invalid_input");
      assert.equal(result.exitCode, 3);
      assert.equal(result.authorizationGranted, false);
      assert.match(result.issues[0], pattern);
      assert.deepEqual(await snapshot(), before);
    };

    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-docs",
      "--at", "2026-08-08T00:02:00.000Z",
      "--work-item", "docs",
      "--agent", "agent-docs",
    ], /owned paths overlap active assignment/iu);
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine-b",
      "--at", "2026-08-08T00:03:00.000Z",
      "--work-item", "engine",
      "--agent", "agent-new",
    ], /must supersede current assignment assign-engine/iu);
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine-c",
      "--at", "2026-08-08T00:04:00.000Z",
      "--work-item", "engine",
      "--agent", "agent-new",
      "--supersedes", "wrong-assignment",
    ], /must supersede current assignment assign-engine/iu);
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-half-execution",
      "--at", "2026-08-08T00:05:00.000Z",
      "--work-item", "cli",
      "--agent", "agent-cli",
      "--execution-run-id", "run-only",
    ], /executionRunId and executionWorkItemId must be supplied together/iu);
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-unknown-work",
      "--at", "2026-08-08T00:06:00.000Z",
      "--work-item", "missing-work-item",
      "--agent", "agent-cli",
    ], /unknown work item/iu);
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-bad-agent",
      "--at", "2026-08-08T00:07:00.000Z",
      "--work-item", "cli",
      "--agent", "agent/bad",
    ], /agentId must use letters/iu);
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-cli-extra-option",
      "--at", "2026-08-08T00:08:00.000Z",
      "--work-item", "cli",
      "--agent", "agent-cli",
      "--authorize", "true",
    ], /unsupported option.*--authorize/iu);

    const requestPath = path.join(root, "assignment-request.json");
    await writeJson(requestPath, event("request-assignment", "agent_assigned", {
      assignmentId: "request-assignment",
      workItemId: "cli",
      agentId: "agent-cli",
    }));
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--request", requestPath,
      "--assignment-id", "assign-mixed",
      "--at", "2026-08-08T00:09:00.000Z",
      "--work-item", "cli",
      "--agent", "agent-cli",
    ], /cannot be combined with direct assignment fields/iu);
    await assertRejectedWithoutWrite([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine",
      "--at", "2026-08-08T00:10:00.000Z",
      "--work-item", "engine",
      "--agent", "agent-changed",
    ], /immutable event differs: assignment-assign-engine/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed decision opening gives a decision-owner blank takeover and one durable event", async () => {
  const root = await setup();
  const decision = {
    operation: "open",
    decisionId: "scope-decision",
    at: "2026-08-08T00:00:00.000Z",
    title: "0.18 project scope",
    question: "Which project slice is authorized for this round?",
    ownerAgentId: "decision-owner",
    blockingWorkItemIds: ["engine"],
    options: ["driver-summary", "formal-run"],
  };
  try {
    const before = await projectSnapshot(root);
    const opened = await runCli(directDecisionArgs(root, decision));
    assert.equal(opened.status, "team_project_decision");
    assert.equal(opened.operation, "opened");
    assert.equal(opened.decisionId, "scope-decision");
    assert.equal(opened.eventId, "decision-opened-scope-decision");
    assert.match(opened.eventPath, /project\/events\/decision-opened-scope-decision\.json$/u);
    assert.match(opened.eventSha256, /^[a-f0-9]{64}$/u);
    assert.equal(opened.resumed, false);
    assert.equal(opened.nextAction, "Resolve scope-decision");
    assert.equal(opened.nextActorId, "decision-owner");
    assert.equal(opened.authorizationGranted, false);
    assert.equal(opened.exitCode, 0);
    assert.match(opened.humanOutput, /Opened decision scope-decision.*decision-owner/iu);
    assert.match(opened.humanOutput, /Project next: Resolve scope-decision.*decision-owner/iu);
    assert.ok(opened.humanOutput.split("\n").filter(Boolean).length <= 5);
    assert.doesNotMatch(opened.humanOutput, /receipt|lease|json/iu);

    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.status, "waiting_decision");
    assert.equal(status.dominantGap.kind, "decision");
    assert.equal(status.dominantGap.id, "scope-decision");
    assert.equal(status.dominantGap.agentId, "decision-owner");
    assert.equal(status.nextAction, "Resolve scope-decision");
    assert.equal(status.nextActorId, "decision-owner");
    assert.equal(status.readyQueue.includes("engine"), false);

    const takeover = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "decision-owner", "--json",
    ]);
    assert.equal(takeover.currentResponsibility, null);
    assert.deepEqual(takeover.unresolvedDecisions.map(row => row.decisionId), ["scope-decision"]);
    assert.equal(takeover.nextAction, "Resolve scope-decision");
    assert.equal(takeover.projectNextAction, status.nextAction);
    assert.equal(takeover.projectNextActorId, status.nextActorId);
    assert.equal(takeover.projectTruthHash, status.projectTruthHash);
    assert.equal(takeover.authorizationGranted, false);

    const takeoverHuman = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "decision-owner",
    ]);
    const takeoverLines = takeoverHuman.humanOutput.split("\n").filter(Boolean);
    assert.equal(takeoverLines[0], status.headline);
    assert.equal(takeoverLines[1], `Project: ${status.projectId} — ${status.objective}`);
    assert.ok(takeoverLines.some(line => /Open decisions: scope-decision/u.test(line)));
    assert.ok(takeoverLines.length <= 12);
    assert.doesNotMatch(takeoverHuman.humanOutput, /receipt|lease|json/iu);

    assert.deepEqual(await eventFiles(root), ["decision-opened-scope-decision.json"]);
    assert.deepEqual(await readdir(path.join(root, ".owlcoda/runkit")), ["project"]);
    const afterOpen = await projectSnapshot(root);
    assert.notDeepEqual(afterOpen, before);
    const replay = await runCli(directDecisionArgs(root, decision, true));
    assert.equal(replay.status, "team_project_decision");
    assert.equal(replay.operation, "opened");
    assert.equal(replay.resumed, true);
    assert.equal(replay.eventSha256, opened.eventSha256);
    assert.equal(replay.projectTruthHash, opened.projectTruthHash);
    assert.equal(Object.hasOwn(replay, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), afterOpen);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed decision resolution removes the active decision block and rejects stale open replay", async () => {
  const root = await setup();
  const openDecision = {
    operation: "open",
    decisionId: "scope-decision",
    at: "2026-08-08T00:03:00.000Z",
    title: "0.18 project scope",
    question: "Which project slice is authorized for this round?",
    ownerAgentId: "decision-owner",
    blockingWorkItemIds: ["engine"],
    options: ["driver-summary", "formal-run"],
  };
  const resolution = {
    operation: "resolve",
    decisionId: "scope-decision",
    at: "2026-08-08T00:04:00.000Z",
    resolution: "driver-summary",
    rationale: "The project driver is the current product slice.",
    evidenceRefs: ["decision-record:scope"],
  };
  try {
    const assigned = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine",
      "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine",
      "--agent", "agent-runtime",
    ]);
    assert.equal(assigned.status, "team_project_assignment");
    appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-02", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "waiting_decision",
        summary: "Implementation is waiting for the scope decision.",
        completedUnits: 1,
        evidenceRefs: ["artifact:engine-progress"],
        blockerRefs: ["decision:scope-decision"],
        decisionRefs: ["scope-decision"],
        nextAction: "Resolve scope-decision before continuing.",
      }),
    });
    const opened = await runCli(directDecisionArgs(root, openDecision, true));
    assert.equal(opened.status, "team_project_decision");
    assert.equal(opened.resumed, false);
    assert.equal(readTeamProjectStatusV1({ workspaceRoot: root }).workItems.find(row => row.workItemId === "engine").status, "waiting_decision");

    const resolved = await runCli(directDecisionArgs(root, resolution, true));
    assert.equal(resolved.status, "team_project_decision");
    assert.equal(resolved.operation, "resolved");
    assert.equal(resolved.eventId, "decision-resolved-scope-decision");
    assert.equal(resolved.resumed, false);
    assert.equal(resolved.nextActorId, "agent-runtime");
    assert.equal(resolved.authorizationGranted, false);

    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.status, "active");
    assert.deepEqual(engine.blockers, []);
    assert.deepEqual(engine.decisionRefs, []);
    assert.equal(engine.nextAction, null);
    assert.notEqual(status.nextAction, "Resolve scope-decision before continuing.");
    assert.equal(status.nextAction, "Continue engine.");
    assert.equal(status.nextActorId, "agent-runtime");
    assert.doesNotMatch(status.dominantGap.reason ?? "", /waiting for decision/iu);
    assert.deepEqual(status.openDecisions, []);
    assert.deepEqual(status.resolvedDecisions.map(row => row.decisionId), ["scope-decision"]);
    assert.deepEqual(status.resolvedDecisions[0].truthRefs.length, 2);

    const afterResolve = await projectSnapshot(root);
    const resolveReplay = await runCli(directDecisionArgs(root, resolution, true));
    assert.equal(resolveReplay.status, "team_project_decision");
    assert.equal(resolveReplay.operation, "resolved");
    assert.equal(resolveReplay.resumed, true);
    assert.equal(resolveReplay.eventSha256, resolved.eventSha256);
    assert.deepEqual(await projectSnapshot(root), afterResolve);

    const staleOpen = await runCli(directDecisionArgs(root, openDecision));
    assert.equal(staleOpen.status, "invalid_input");
    assert.equal(staleOpen.exitCode, 3);
    assert.match(staleOpen.issues[0], /already resolved/iu);
    assert.equal(Object.hasOwn(staleOpen, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), afterResolve);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy decision request events remain accepted", async () => {
  const root = await setup();
  try {
    const openPath = path.join(root, "decision-open-request.json");
    const resolvePath = path.join(root, "decision-resolve-request.json");
    await writeJson(openPath, event("event-01", "decision_opened", {
      decisionId: "legacy-decision",
      title: "Legacy decision",
      question: "Should the legacy request remain supported?",
      ownerAgentId: "legacy-owner",
      blockingWorkItemIds: [],
      options: ["yes"],
    }));
    await writeJson(resolvePath, event("event-02", "decision_resolved", {
      decisionId: "legacy-decision",
      resolution: "yes",
      rationale: "The compatibility path is still part of the contract.",
      evidenceRefs: ["decision-record:legacy"],
    }));
    const opened = await runCli([
      "project", "decision", "--workspace", root, "--request", openPath,
    ]);
    assert.equal(opened.status, "team_project_event_recorded");
    assert.equal(opened.authorizationGranted, false);
    const resolved = await runCli([
      "project", "decision", "--workspace", root, "--request", resolvePath,
    ]);
    assert.equal(resolved.status, "team_project_event_recorded");
    assert.equal(resolved.authorizationGranted, false);
    assert.deepEqual(readTeamProjectStatusV1({ workspaceRoot: root }).resolvedDecisions.map(row => row.decisionId), ["legacy-decision"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolving one of several checkpoint decision blockers keeps only the remaining open blocker", async () => {
  const root = await setup();
  const decision = (decisionId, at, ownerAgentId) => ({
    operation: "open",
    decisionId,
    at,
    title: `Decision ${decisionId}`,
    question: `Choose ${decisionId}.`,
    ownerAgentId,
    blockingWorkItemIds: ["engine"],
    options: ["yes", "no"],
  });
  try {
    assert.equal((await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine", "--agent", "agent-runtime",
    ])).status, "team_project_assignment");
    assert.equal((await runCli(directDecisionArgs(root, decision(
      "decision-a", "2026-08-08T00:01:00.000Z", "owner-a",
    ), true))).status, "team_project_decision");
    assert.equal((await runCli(directDecisionArgs(root, decision(
      "decision-b", "2026-08-08T00:02:00.000Z", "owner-b",
    ), true))).status, "team_project_decision");
    appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-03", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "waiting_decision",
        summary: "Waiting for two decisions.",
        completedUnits: 1,
        evidenceRefs: ["artifact:engine-progress"],
        blockerRefs: ["decision:decision-a", "decision:decision-b"],
        decisionRefs: ["decision-a", "decision-b"],
        nextAction: "Resolve both decisions, then continue engine.",
      }),
    });
    const resolvedA = await runCli(directDecisionArgs(root, {
      operation: "resolve",
      decisionId: "decision-a",
      at: "2026-08-08T00:04:00.000Z",
      resolution: "yes",
      rationale: "A is resolved.",
      evidenceRefs: ["decision-record:a"],
    }, true));
    assert.equal(resolvedA.status, "team_project_decision");

    let status = readTeamProjectStatusV1({ workspaceRoot: root });
    let engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.status, "waiting_decision");
    assert.deepEqual(engine.blockers, ["decision:decision-b"]);
    assert.deepEqual(engine.decisionRefs, ["decision-b"]);
    assert.equal(status.dominantGap.kind, "decision");
    assert.equal(status.dominantGap.id, "decision-b");
    assert.equal(status.nextAction, "Resolve decision-b");
    assert.equal(status.nextActorId, "owner-b");
    assert.doesNotMatch(status.headline, /decision-a/iu);

    const resolvedB = await runCli(directDecisionArgs(root, {
      operation: "resolve",
      decisionId: "decision-b",
      at: "2026-08-08T00:05:00.000Z",
      resolution: "no",
      rationale: "B is resolved.",
      evidenceRefs: ["decision-record:b"],
    }, true));
    assert.equal(resolvedB.status, "team_project_decision");
    status = readTeamProjectStatusV1({ workspaceRoot: root });
    engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.status, "active");
    assert.deepEqual(engine.blockers, []);
    assert.deepEqual(engine.decisionRefs, []);
    assert.equal(status.nextAction, "Continue engine.");
    assert.equal(status.nextActorId, "agent-runtime");
    assert.doesNotMatch(status.headline, /decision-[ab]/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed decision modes, identities, ordering, and immutable replay fail closed", async () => {
  const root = await setup();
  const open = {
    operation: "open",
    decisionId: "typed-decision",
    at: "2026-08-08T00:00:00.000Z",
    title: "Typed decision",
    question: "Which path should continue?",
    ownerAgentId: "decision-owner",
    blockingWorkItemIds: [],
    options: ["yes", "no"],
  };
  const resolve = {
    operation: "resolve",
    decisionId: "typed-decision",
    at: "2026-08-08T00:02:00.000Z",
    resolution: "yes",
    rationale: "The typed path is selected.",
    evidenceRefs: ["decision-record:typed"],
  };
  const assertRejectedWithoutWrite = async (args, pattern) => {
    const before = await projectSnapshot(root);
    const result = await runCli(args);
    assert.equal(result.status, "invalid_input");
    assert.equal(result.exitCode, 3);
    assert.equal(result.authorizationGranted, false);
    assert.match(result.issues[0], pattern);
    assert.equal(Object.hasOwn(result, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), before);
  };
  try {
    await assertRejectedWithoutWrite([
      "project", "decision", "--workspace", root,
    ], /exactly one of --open or --resolve/iu);
    await assertRejectedWithoutWrite([
      "project", "decision", "--workspace", root, "--open", "--resolve",
    ], /exactly one of --open or --resolve/iu);
    await assertRejectedWithoutWrite([
      ...directDecisionArgs(root, { ...open, resolution: "yes", rationale: "wrong mode" }),
      "--resolution", "yes", "--rationale", "wrong mode",
    ], /cannot accept resolution, rationale, or evidence/iu);
    await assertRejectedWithoutWrite([
      ...directDecisionArgs(root, resolve, true).filter(value => value !== "--json"),
      "--title", "wrong mode",
    ], /cannot accept title, question, owner-agent, blocking-work-item, or option/iu);
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...open, options: [] }),
      /requires at least one --option/iu,
    );
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...resolve, evidenceRefs: [] }),
      /requires at least one --evidence/iu,
    );
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...open, blockingWorkItemIds: ["missing-work-item"] }),
      /unknown work item/iu,
    );
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...open, decisionId: "bad/id" }),
      /decisionId must use letters/iu,
    );

    const requestPath = path.join(root, "decision-mixed-request.json");
    await writeJson(requestPath, event("event-01", "decision_opened", {
      decisionId: "legacy-mixed",
      title: "Legacy mixed",
      question: "Should this be rejected?",
      ownerAgentId: "legacy-owner",
      blockingWorkItemIds: [],
      options: ["no"],
    }));
    await assertRejectedWithoutWrite([
      "project", "decision", "--workspace", root, "--request", requestPath,
      "--decision-id", "mixed", "--open",
    ], /cannot be combined with direct decision fields/iu);

    const opened = await runCli(directDecisionArgs(root, open, true));
    assert.equal(opened.status, "team_project_decision");
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...open, title: "Changed typed decision" }),
      /immutable event differs: decision-opened-typed-decision/iu,
    );
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...resolve, decisionId: "missing-decision" }),
      /is not open/iu,
    );
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...resolve, at: "2026-08-07T23:59:00.000Z" }),
      /must sort after the latest event/iu,
    );

    const resolved = await runCli(directDecisionArgs(root, resolve, true));
    assert.equal(resolved.status, "team_project_decision");
    await assertRejectedWithoutWrite(
      directDecisionArgs(root, { ...resolve, rationale: "Changed resolution" }),
      /immutable event differs: decision-resolved-typed-decision/iu,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed handoff records pending ownership transfer without granting assignment or authority", async () => {
  const root = await setup();
  const handoff = {
    handoffId: "handoff-engine-a",
    at: "2026-08-08T00:01:00.000Z",
    assignmentId: "assign-engine",
    workItemId: "engine",
    fromAgentId: "agent-a",
    toAgentId: "agent-b",
    summary: "Parser is complete; projector remains.",
    nextAction: "Implement the projector.",
    evidenceRefs: ["artifact:parser-pass", "artifact:handoff"],
  };
  try {
    const assigned = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine",
      "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine",
      "--agent", "agent-a",
    ]);
    assert.equal(assigned.status, "team_project_assignment");

    const humanHandoff = await runCli(directHandoffArgs(root, handoff));
    assert.equal(humanHandoff.status, "team_project_handoff");
    assert.equal(humanHandoff.handoffId, handoff.handoffId);
    assert.equal(humanHandoff.assignmentId, handoff.assignmentId);
    assert.equal(humanHandoff.workItemId, handoff.workItemId);
    assert.equal(humanHandoff.fromAgentId, handoff.fromAgentId);
    assert.equal(humanHandoff.toAgentId, handoff.toAgentId);
    assert.equal(humanHandoff.eventId, "handoff-handoff-engine-a");
    assert.match(humanHandoff.eventPath, /project\/events\/handoff-handoff-engine-a\.json$/u);
    assert.match(humanHandoff.eventSha256, /^[a-f0-9]{64}$/u);
    assert.equal(humanHandoff.resumed, false);
    assert.equal(humanHandoff.pending, true);
    assert.equal(humanHandoff.targetNextAction, handoff.nextAction);
    assert.equal(humanHandoff.nextAction, "Accept handoff engine");
    assert.equal(humanHandoff.nextActorId, "agent-b");
    assert.equal(humanHandoff.projectNextAction, "Accept handoff engine");
    assert.equal(humanHandoff.projectNextActorId, "agent-b");
    assert.equal(humanHandoff.authorizationGranted, false);
    assert.equal(humanHandoff.exitCode, 0);
    const handoffLines = humanHandoff.humanOutput.split("\n").filter(Boolean);
    assert.ok(handoffLines.length <= 5);
    assert.match(handoffLines[0], /Handed off WorkItem engine from Agent agent-a to Agent agent-b\./u);
    assert.match(humanHandoff.humanOutput, /Target next: Implement the projector\./u);
    assert.match(humanHandoff.humanOutput, /Project next: Accept handoff engine/u);
    assert.doesNotMatch(humanHandoff.humanOutput, /receipt|lease|json/iu);
    assert.deepEqual(await readdir(path.join(root, ".owlcoda/runkit")), ["project"]);

    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.assignmentId, "assign-engine");
    assert.equal(engine.agentId, "agent-a");
    assert.equal(engine.status, "planned");
    assert.equal(engine.nextAction, handoff.nextAction);
    assert.deepEqual(engine.pendingHandoff, {
      eventId: "handoff-handoff-engine-a",
      truthRef: "project/events/handoff-handoff-engine-a.json",
      assignmentId: "assign-engine",
      workItemId: "engine",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      summary: handoff.summary,
      evidenceRefs: handoff.evidenceRefs,
      nextAction: handoff.nextAction,
      occurredAt: handoff.at,
    });
    assert.equal(status.dominantGap.kind, "work_item");
    assert.equal(status.dominantGap.workItemId, "engine");
    assert.equal(status.dominantGap.agentId, "agent-b");
    assert.match(status.dominantGap.reason, /Parser is complete; projector remains\./u);
    assert.equal(status.nextAction, "Accept handoff engine");
    assert.equal(status.nextActorId, "agent-b");
    assert.match(status.headline, /owner: agent-b/iu);
    assert.match(status.headline, /next: Accept handoff engine/iu);

    const statusHuman = await runCli(["project", "status", "--workspace", root]);
    const statusLines = statusHuman.humanOutput.split("\n").filter(Boolean);
    assert.equal(statusLines[0], status.headline);
    assert.match(statusLines[1], /^Project: runkit-017 — /u);
    assert.ok(statusLines.length <= 10);

    const beforeTakeover = await projectSnapshot(root);
    const target = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "agent-b", "--json",
    ]);
    assert.equal(target.status, "team_project_takeover");
    assert.equal(target.currentResponsibility, null);
    assert.equal(target.pendingHandoff.workItemId, "engine");
    assert.equal(target.pendingHandoff.fromAgentId, "agent-a");
    assert.equal(target.pendingHandoff.toAgentId, "agent-b");
    assert.equal(target.nextAction, handoff.nextAction);
    assert.ok(target.evidenceRefs.includes("artifact:parser-pass"));
    assert.equal(target.projectNextAction, "Accept handoff engine");
    assert.equal(target.projectNextActorId, "agent-b");
    assert.equal(target.projectTruthHash, status.projectTruthHash);
    assert.equal(target.authorizationGranted, false);

    const targetHuman = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "agent-b",
    ]);
    const targetLines = targetHuman.humanOutput.split("\n").filter(Boolean);
    assert.equal(targetLines[0], targetHuman.projectHeadline);
    assert.match(targetLines[1], /^Project: runkit-017 — /u);
    assert.ok(targetLines.some(line => /Pending handoff: agent-a -> agent-b for engine/u.test(line)));
    assert.ok(targetLines.length <= 12);
    assert.deepEqual(await projectSnapshot(root), beforeTakeover);

    const source = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "agent-a", "--json",
    ]);
    assert.equal(source.currentResponsibility.workItemId, "engine");
    assert.match(source.nextAction, /Waiting for agent-b to accept engine\./u);
    assert.doesNotMatch(source.nextAction, /Continue engine/u);
    assert.equal(source.projectNextAction, "Accept handoff engine");

    const repeated = await runCli(directHandoffArgs(root, handoff, true));
    assert.equal(repeated.status, "team_project_handoff");
    assert.equal(repeated.resumed, true);
    assert.equal(repeated.pending, true);
    assert.equal(repeated.eventSha256, humanHandoff.eventSha256);
    assert.equal(repeated.projectTruthHash, humanHandoff.projectTruthHash);
    assert.deepEqual(await eventFiles(root), [
      "assignment-assign-engine.json",
      "handoff-handoff-engine-a.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a one-item project with a pending handoff remains active", async () => {
  const root = await setup({
    schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
    projectId: "one-item-handoff",
    objective: "Keep a pending handoff visible as active work",
    milestones: [{ id: "m1", title: "Core" }],
    workstreams: [{ id: "w1", title: "Runtime", milestoneId: "m1" }],
    workItems: [{
      id: "x",
      title: "Carry x",
      milestoneId: "m1",
      workstreamId: "w1",
      dependencies: [],
      ownedPaths: ["src/x/**"],
    }],
    integrationGates: [],
  });
  try {
    const assigned = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-x",
      "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "x",
      "--agent", "agent-a",
    ]);
    assert.equal(assigned.status, "team_project_assignment");
    const handedOff = await runCli(directHandoffArgs(root, {
      handoffId: "handoff-x",
      at: "2026-08-08T00:01:00.000Z",
      assignmentId: "assign-x",
      workItemId: "x",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      summary: "x is ready for the target Agent.",
      nextAction: "Continue x from the handoff.",
      evidenceRefs: ["artifact:x"],
    }, true));
    assert.equal(handedOff.status, "team_project_handoff");
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const workItem = status.workItems.find(row => row.workItemId === "x");
    assert.equal(workItem.status, "planned");
    assert.equal(workItem.pendingHandoff.toAgentId, "agent-b");
    assert.equal(status.nextAction, "Accept handoff x");
    assert.equal(status.nextActorId, "agent-b");
    assert.deepEqual({ overall: status.overall, readyQueue: status.readyQueue }, {
      overall: "active",
      readyQueue: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newer checkpoint and handoff facts win by event time and leave one pending target", async () => {
  const root = await setup();
  try {
    await appendEvents(root, [
      event("event-01", "agent_assigned", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        agentId: "agent-a",
      }),
      event("event-02", "handoff_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        summary: "Initial handoff is stale after checkpoint.",
        evidenceRefs: ["artifact:initial-handoff"],
        nextAction: "Do the initial projector work.",
      }),
      event("event-03", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "active",
        summary: "Checkpoint is newer than the initial handoff.",
        completedUnits: 2,
        evidenceRefs: ["artifact:newer-checkpoint"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: "Verify the newer checkpoint.",
      }),
    ]);
    let status = readTeamProjectStatusV1({ workspaceRoot: root });
    let engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.pendingHandoff, null);
    assert.equal(engine.summary, "Checkpoint is newer than the initial handoff.");
    assert.equal(engine.nextAction, "Verify the newer checkpoint.");
    assert.deepEqual(engine.evidenceRefs, ["artifact:newer-checkpoint"]);
    assert.equal(status.dominantGap.agentId, "agent-a");
    assert.equal(status.nextAction, "Verify the newer checkpoint.");

    await appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-04", "handoff_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-c",
        summary: "Redirected after the newer checkpoint.",
        evidenceRefs: ["artifact:redirected-handoff"],
        nextAction: "Review the redirected projector context.",
      }),
    });
    status = readTeamProjectStatusV1({ workspaceRoot: root });
    engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.pendingHandoff.toAgentId, "agent-c");
    assert.equal(engine.summary, "Redirected after the newer checkpoint.");
    assert.equal(engine.nextAction, "Review the redirected projector context.");
    assert.equal(status.dominantGap.agentId, "agent-c");
    assert.equal(status.nextAction, "Accept handoff engine");
    assert.equal(status.nextActorId, "agent-c");
    const target = buildTeamProjectTakeoverV1({ workspaceRoot: root, agentId: "agent-c" });
    assert.equal(target.currentResponsibility, null);
    assert.equal(target.pendingHandoff.toAgentId, "agent-c");
    assert.equal(target.nextAction, "Review the redirected projector context.");
    assert.ok(target.evidenceRefs.includes("artifact:redirected-handoff"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redirected and accepted handoffs reject stale replay while preserving the latest durable context", async () => {
  const root = await setup();
  const first = {
    handoffId: "handoff-first",
    at: "2026-08-08T00:01:00.000Z",
    assignmentId: "assign-engine",
    workItemId: "engine",
    fromAgentId: "agent-a",
    toAgentId: "agent-b",
    summary: "First target should not replay after redirect.",
    nextAction: "Work the first target context.",
    evidenceRefs: ["artifact:first"],
  };
  const redirected = {
    ...first,
    handoffId: "handoff-second",
    at: "2026-08-08T00:02:00.000Z",
    toAgentId: "agent-c",
    summary: "Second target is the only pending handoff.",
    nextAction: "Work the redirected context.",
    evidenceRefs: ["artifact:second"],
  };
  const assign = [
    "project", "assign", "--workspace", root,
    "--assignment-id", "assign-engine", "--at", "2026-08-08T00:00:00.000Z",
    "--work-item", "engine", "--agent", "agent-a",
  ];
  try {
    assert.equal((await runCli(assign)).status, "team_project_assignment");
    assert.equal((await runCli(directHandoffArgs(root, first, true))).resumed, false);
    assert.equal((await runCli(directHandoffArgs(root, redirected, true))).resumed, false);

    const beforeStale = await projectSnapshot(root);
    const stale = await runCli(directHandoffArgs(root, first));
    assert.equal(stale.status, "invalid_input");
    assert.equal(stale.exitCode, 3);
    assert.match(stale.issues[0], /historical\/superseded.*current assignment=assign-engine.*current owner=agent-a.*pending target=agent-c/iu);
    assert.equal(Object.hasOwn(stale, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), beforeStale);

    const currentReplay = await runCli(directHandoffArgs(root, redirected, true));
    assert.equal(currentReplay.status, "team_project_handoff");
    assert.equal(currentReplay.resumed, true);
    assert.equal(currentReplay.toAgentId, "agent-c");

    const beforeWrongTarget = await projectSnapshot(root);
    const wrongTarget = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine-b",
      "--at", "2026-08-08T00:03:00.000Z",
      "--work-item", "engine", "--agent", "agent-b",
      "--supersedes", "assign-engine", "--json",
    ]);
    assert.equal(wrongTarget.status, "invalid_input");
    assert.equal(wrongTarget.exitCode, 3);
    assert.match(wrongTarget.issues[0], /pending handoff target agent-c/iu);
    assert.deepEqual(await projectSnapshot(root), beforeWrongTarget);

    const accepted = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine-c",
      "--at", "2026-08-08T00:03:00.000Z",
      "--work-item", "engine", "--agent", "agent-c",
      "--supersedes", "assign-engine", "--json",
    ]);
    assert.equal(accepted.status, "team_project_assignment");
    const status = readTeamProjectStatusV1({ workspaceRoot: root });
    const engine = status.workItems.find(row => row.workItemId === "engine");
    assert.equal(engine.assignmentId, "assign-engine-c");
    assert.equal(engine.agentId, "agent-c");
    assert.equal(engine.pendingHandoff, null);
    assert.equal(engine.summary, redirected.summary);
    assert.equal(engine.nextAction, redirected.nextAction);
    assert.ok(engine.evidenceRefs.includes("artifact:second"));

    const beforeAcceptedStale = await projectSnapshot(root);
    const acceptedStale = await runCli(directHandoffArgs(root, redirected));
    assert.equal(acceptedStale.status, "invalid_input");
    assert.match(acceptedStale.issues[0], /historical\/superseded.*current assignment=assign-engine-c.*current owner=agent-c/iu);
    assert.deepEqual(await projectSnapshot(root), beforeAcceptedStale);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("typed handoff rejects unsafe state transitions and preserves request compatibility", async () => {
  const roots = [];
  const assignedRoot = async () => {
    const root = await setup();
    roots.push(root);
    const result = await runCli([
      "project", "assign", "--workspace", root,
      "--assignment-id", "assign-engine", "--at", "2026-08-08T00:00:00.000Z",
      "--work-item", "engine", "--agent", "agent-a",
    ]);
    assert.equal(result.status, "team_project_assignment");
    return root;
  };
  const assertRejectedWithoutWrite = async (root, args, pattern) => {
    const before = await projectSnapshot(root);
    const result = await runCli(args);
    assert.equal(result.status, "invalid_input");
    assert.equal(result.exitCode, 3);
    assert.equal(result.authorizationGranted, false);
    assert.match(result.issues[0], pattern);
    assert.equal(Object.hasOwn(result, "humanOutput"), false);
    assert.deepEqual(await projectSnapshot(root), before);
  };
  try {
    const sameAgent = await assignedRoot();
    await assertRejectedWithoutWrite(
      sameAgent,
      directHandoffArgs(sameAgent, {
        handoffId: "handoff-same-agent",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-a",
        summary: "No transfer.",
        nextAction: "Continue.",
        evidenceRefs: ["artifact:no-transfer"],
      }),
      /fromAgentId and toAgentId must differ/iu,
    );
    await assertRejectedWithoutWrite(
      sameAgent,
      directHandoffArgs(sameAgent, {
        handoffId: "handoff-wrong-assignment",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "wrong-assignment",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        summary: "Wrong assignment.",
        nextAction: "Do not run.",
        evidenceRefs: ["artifact:wrong-assignment"],
      }),
      /bind the current assignment and Agent/iu,
    );
    await assertRejectedWithoutWrite(
      sameAgent,
      directHandoffArgs(sameAgent, {
        handoffId: "handoff-wrong-agent",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        fromAgentId: "agent-c",
        toAgentId: "agent-b",
        summary: "Wrong source.",
        nextAction: "Do not run.",
        evidenceRefs: ["artifact:wrong-agent"],
      }),
      /bind the current assignment and Agent/iu,
    );
    await assertRejectedWithoutWrite(
      sameAgent,
      directHandoffArgs(sameAgent, {
        handoffId: "handoff-malformed-agent",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent/bad",
        summary: "Malformed target.",
        nextAction: "Do not run.",
        evidenceRefs: ["artifact:malformed"],
      }),
      /toAgentId must use letters/iu,
    );
    await assertRejectedWithoutWrite(
      sameAgent,
      directHandoffArgs(sameAgent, {
        handoffId: "handoff-empty-evidence",
        at: "2026-08-08T00:01:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        summary: "No evidence.",
        nextAction: "Do not run.",
        evidenceRefs: [],
      }),
      /evidenceRefs must be a unique string array with at least one entry/iu,
    );
    await assertRejectedWithoutWrite(
      sameAgent,
      directHandoffArgs(sameAgent, {
        handoffId: "handoff-backdated",
        at: "2026-08-07T23:59:59.000Z",
        assignmentId: "assign-engine",
        workItemId: "engine",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        summary: "Backdated.",
        nextAction: "Do not run.",
        evidenceRefs: ["artifact:backdated"],
      }),
      /must sort after the latest event/iu,
    );

    const immutable = await assignedRoot();
    const immutableSpec = {
      handoffId: "handoff-immutable",
      at: "2026-08-01T00:01:00.000Z",
      assignmentId: "assign-engine",
      workItemId: "engine",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      summary: "Immutable handoff.",
      nextAction: "Keep immutable.",
      evidenceRefs: ["artifact:immutable"],
    };
    immutableSpec.at = "2026-08-08T00:01:00.000Z";
    assert.equal((await runCli(directHandoffArgs(immutable, immutableSpec))).status, "team_project_handoff");
    await assertRejectedWithoutWrite(
      immutable,
      directHandoffArgs(immutable, { ...immutableSpec, summary: "Changed immutable handoff." }),
      /immutable event differs: handoff-handoff-immutable/iu,
    );

    const unknownWork = await setup();
    roots.push(unknownWork);
    await assertRejectedWithoutWrite(
      unknownWork,
      directHandoffArgs(unknownWork, {
        handoffId: "handoff-unknown-work",
        at: "2026-08-08T00:00:00.000Z",
        assignmentId: "assign-engine",
        workItemId: "missing-work-item",
        fromAgentId: "agent-a",
        toAgentId: "agent-b",
        summary: "Unknown work item.",
        nextAction: "Do not run.",
        evidenceRefs: ["artifact:unknown-work"],
      }),
      /unknown work item/iu,
    );

    for (const [state, completedUnits] of [["completed", 4], ["failed", 1]]) {
      const root = await assignedRoot();
      await appendTeamProjectEventV1({
        workspaceRoot: root,
        event: event(`event-${state === "completed" ? "02" : "03"}`, "checkpoint_recorded", {
          assignmentId: "assign-engine",
          workItemId: "engine",
          state,
          summary: `${state} checkpoint.`,
          completedUnits,
          evidenceRefs: [`artifact:${state}`],
          blockerRefs: [],
          decisionRefs: [],
          nextAction: null,
        }),
      });
      await assertRejectedWithoutWrite(
        root,
        directHandoffArgs(root, {
          handoffId: `handoff-${state}`,
          at: "2026-08-08T00:04:00.000Z",
          assignmentId: "assign-engine",
          workItemId: "engine",
          fromAgentId: "agent-a",
          toAgentId: "agent-b",
          summary: `Cannot handoff ${state}.`,
          nextAction: "Do not run.",
          evidenceRefs: [`artifact:${state}-handoff`],
        }),
        /completed or failed WorkItem/iu,
      );
    }

    const legacy = await assignedRoot();
    const requestPath = path.join(legacy, "handoff-request.json");
    await writeJson(requestPath, event("event-02", "handoff_recorded", {
      assignmentId: "assign-engine",
      workItemId: "engine",
      fromAgentId: "agent-a",
      toAgentId: "agent-b",
      summary: "Legacy request handoff.",
      evidenceRefs: ["artifact:legacy"],
      nextAction: "Use the legacy request path.",
    }));
    const legacyResult = await runCli([
      "project", "handoff", "--workspace", legacy, "--request", requestPath,
    ]);
    assert.equal(legacyResult.status, "team_project_event_recorded");
    assert.equal(legacyResult.authorizationGranted, false);
    await assertRejectedWithoutWrite(
      legacy,
      [
        "project", "handoff", "--workspace", legacy, "--request", requestPath,
        "--handoff-id", "handoff-mixed", "--summary", "mixed",
      ],
      /cannot be combined with direct handoff fields/iu,
    );
  } finally {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  }
});

test("an execution-bound assignment derives lifecycle and lease truth instead of trusting an Agent claim", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "owlrunkit-team-execution-"));
  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src/value.txt"), "value\n");
    const goalPath = path.join(root, "goal.json");
    await writeJson(goalPath, {
      schemaVersion: "OwlCodaRunKitGoalContractV1",
      objective: "Bind a real execution to team progress",
      nonGoals: [],
      authorization: { git: false, publish: false, deploy: false, destructive: false },
    });
    assert.equal((await runCli(["init", "--workspace", root])).status, "initialized");
    assert.equal((await runCli([
      "start", "--workspace", root,
      "--run-id", "agent-run",
      "--goal", goalPath,
      "--work-item", "delivery",
      "--owned-path", "src/**",
    ])).status, "started");
    const project = {
      schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
      projectId: "execution-bound",
      objective: "Use lifecycle truth",
      milestones: [{ id: "m1", title: "Delivery" }],
      workstreams: [{ id: "runtime", title: "Runtime", milestoneId: "m1" }],
      workItems: [{
        id: "engine",
        title: "Engine",
        milestoneId: "m1",
        workstreamId: "runtime",
        dependencies: [],
        ownedPaths: ["src/**"],
      }],
      integrationGates: [{
        id: "done",
        title: "Done",
        requiredWorkItemIds: ["engine"],
        requiredDecisionIds: [],
      }],
    };
    initializeTeamProjectV1({ workspaceRoot: root, definition: project });
    assert.throws(() => appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-59", "agent_assigned", {
        assignmentId: "assign-missing",
        workItemId: "engine",
        agentId: "agent-a",
        executionRunId: "missing-run",
        executionWorkItemId: "delivery",
      }),
    }), /execution binding is not valid/iu);
    appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-60", "agent_assigned", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        agentId: "agent-a",
        executionRunId: "agent-run",
        executionWorkItemId: "delivery",
      }),
    });

    let status = readTeamProjectStatusV1({ workspaceRoot: root });
    let engine = status.workItems[0];
    assert.deepEqual(engine.executionTruth, {
      status: "bound",
      runId: "agent-run",
      lifecycle: "active",
      closeoutDecision: null,
      closeoutTrusted: false,
      leaseState: "active",
      leaseWorkItemId: "delivery",
      issues: [],
    });
    assert.throws(() => appendTeamProjectEventV1({
      workspaceRoot: root,
      event: event("event-61", "checkpoint_recorded", {
        assignmentId: "assign-engine",
        workItemId: "engine",
        state: "completed",
        summary: "Agent claims completion while execution is active.",
        evidenceRefs: ["self-report:done"],
        blockerRefs: [],
        decisionRefs: [],
        nextAction: null,
      }),
    }), /bound execution is not closed and accepted/iu);

    assert.equal((await runCli([
      "finish", "--workspace", root,
      "--run-id", "agent-run",
      "--decision", "blocked",
    ])).status, "finished");
    status = readTeamProjectStatusV1({ workspaceRoot: root });
    engine = status.workItems[0];
    assert.equal(engine.status, "failed");
    assert.equal(engine.executionTruth.lifecycle, "closed");
    assert.equal(engine.executionTruth.closeoutDecision, "blocked");
    assert.equal(engine.executionTruth.leaseState, "released");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
