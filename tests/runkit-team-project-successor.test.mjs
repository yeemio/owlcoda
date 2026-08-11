import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runCli } from "../scripts/runkit-contract/runkit-cli.mjs";
import { coreManifest } from "../scripts/runkit-contract/core-contract.mjs";
import {
  appendTeamProjectEventV1,
  initializeTeamProjectV1,
  readTeamProjectStatusV1,
} from "../scripts/runkit-contract/team-project.mjs";

const CLI_URL = pathToFileURL(path.resolve(
  "scripts/runkit-contract/runkit-cli.mjs",
)).href;

function projectDefinition(projectId, workItemId = "delivery") {
  return {
    schemaVersion: "OwlCodaRunKitTeamProjectDefinitionV1",
    projectId,
    objective: `Complete ${projectId}`,
    milestones: [{ id: "m1", title: "Delivery" }],
    workstreams: [{ id: "runtime", title: "Runtime", milestoneId: "m1" }],
    workItems: [{
      id: workItemId,
      title: `Complete ${workItemId}`,
      milestoneId: "m1",
      workstreamId: "runtime",
      dependencies: [],
      ownedPaths: [`src/${workItemId}/**`],
    }],
    integrationGates: [{
      id: "accepted",
      title: "Accepted",
      requiredWorkItemIds: [workItemId],
      requiredDecisionIds: [],
    }],
  };
}

function event(eventId, type, fields) {
  return {
    schemaVersion: "OwlCodaRunKitTeamProjectEventV1",
    eventId,
    type,
    occurredAt: `2026-08-09T00:0${eventId.at(-1)}:00.000Z`,
    ...fields,
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function setupProject({ completed = true, projectId = "project-old" } = {}) {
  const root = await realpath(await mkdtemp(path.join(
    tmpdir(),
    "owlrunkit-project-successor-",
  )));
  const definition = projectDefinition(projectId);
  initializeTeamProjectV1({ workspaceRoot: root, definition });
  if (completed) {
    completeProject(root);
  }
  return root;
}

function completeProject(root, {
  eventPrefix = "event",
  assignmentId = "assignment-old",
  workItemId = "delivery",
  agentId = "agent-old",
  evidenceSuffix = "old-project",
} = {}) {
  appendTeamProjectEventV1({
    workspaceRoot: root,
    event: event(`${eventPrefix}-1`, "agent_assigned", {
      assignmentId,
      workItemId,
      agentId,
    }),
  });
  appendTeamProjectEventV1({
    workspaceRoot: root,
    event: event(`${eventPrefix}-2`, "checkpoint_recorded", {
      assignmentId,
      workItemId,
      state: "completed",
      summary: `The ${evidenceSuffix} project is complete.`,
      evidenceRefs: [`receipt:${evidenceSuffix}`],
      blockerRefs: [],
      decisionRefs: [],
      nextAction: null,
    }),
  });
  appendTeamProjectEventV1({
    workspaceRoot: root,
    event: event(`${eventPrefix}-3`, "integration_gate_passed", {
      gateId: "accepted",
      summary: `Owner accepted the ${evidenceSuffix} project.`,
      evidenceRefs: [`gate:${evidenceSuffix}`],
    }),
  });
}

function successorArgs(root, definitionPath, {
  transitionId = "transition-001",
  at = "2026-08-09T08:00:00.000Z",
  reason = "Begin the next bounded project.",
} = {}) {
  return [
    "project", "successor",
    "--workspace", root,
    "--transition-id", transitionId,
    "--at", at,
    "--definition", definitionPath,
    "--reason", reason,
    "--json",
  ];
}

async function regularFiles(root) {
  const files = new Map();
  async function walk(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) files.set(relative, await readFile(absolute));
      else throw new Error(`Unexpected non-regular fixture entry: ${relative}`);
    }
  }
  await walk(root);
  return files;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameFiles(left, right) {
  return left.size === right.size
    && [...left].every(([filePath, bytes]) => right.get(filePath)?.equals(bytes));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function assertArchiveSealed(directory) {
  async function walk(current) {
    const currentStat = await lstat(current);
    assert.equal(currentStat.isSymbolicLink(), false, current);
    assert.equal(currentStat.isDirectory(), true, current);
    assert.equal(currentStat.mode & 0o777, 0o555, current);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else {
        const fileStat = await lstat(absolute);
        assert.equal(fileStat.isSymbolicLink(), false, absolute);
        assert.equal(fileStat.isFile(), true, absolute);
        assert.equal(fileStat.mode & 0o777, 0o444, absolute);
      }
    }
  }
  await walk(directory);
}

async function removeFixture(root) {
  if (!(await pathExists(root))) return;
  async function makeWritable(current) {
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) return;
    if (currentStat.isFile()) {
      await chmod(current, 0o600);
      return;
    }
    await chmod(current, 0o700);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      await makeWritable(path.join(current, entry.name));
    }
  }
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

const CRASH_CHILD_SOURCE = String.raw`
  import { writeFileSync } from "node:fs";
  const { runCli } = await import(process.env.OWLRUNKIT_SUCCESSOR_CLI_URL);
  const result = await runCli(JSON.parse(process.env.OWLRUNKIT_SUCCESSOR_ARGV), {
    onTeamProjectSuccessorStep({ phase }) {
      if (phase !== process.env.OWLRUNKIT_SUCCESSOR_STOP_PHASE) return;
      writeFileSync(process.env.OWLRUNKIT_SUCCESSOR_MARKER, phase);
      if (process.env.OWLRUNKIT_SUCCESSOR_PAUSE === "1") {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      }
      process.exit(91);
    },
  });
  process.stdout.write(JSON.stringify(result));
  process.exit(result.exitCode);
`;

function startCrashChild(argv, markerPath, phase, { pause = false } = {}) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", CRASH_CHILD_SOURCE],
    {
      env: {
        ...process.env,
        OWLRUNKIT_SUCCESSOR_CLI_URL: CLI_URL,
        OWLRUNKIT_SUCCESSOR_ARGV: JSON.stringify(argv),
        OWLRUNKIT_SUCCESSOR_STOP_PHASE: phase,
        OWLRUNKIT_SUCCESSOR_MARKER: markerPath,
        OWLRUNKIT_SUCCESSOR_PAUSE: pause ? "1" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const closed = new Promise(resolve => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, closed };
}

async function waitForPath(filePath) {
  const deadline = Date.now() + 5_000;
  while (!(await pathExists(filePath))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("Owner successor archives exact bytes, installs one empty active project, and retries idempotently", async () => {
  const root = await setupProject();
  try {
    const coreFiles = coreManifest().files;
    assert.ok(coreFiles.includes("team-project-successor.mjs"));
    assert.ok(coreFiles.includes("schemas/team-project-successor-receipt-v1.schema.json"));
    const activeRoot = path.join(root, ".owlcoda/runkit/project");
    await writeFile(path.join(activeRoot, "opaque.bin"), Buffer.from([0, 255, 13, 10, 7]));
    const oldFiles = await regularFiles(activeRoot);
    const oldStatus = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(oldStatus.overall, "completed");

    const nextDefinitionPath = path.join(root, "next-project.json");
    await writeJson(nextDefinitionPath, projectDefinition("project-new", "next-delivery"));
    const args = successorArgs(root, nextDefinitionPath);
    const transitioned = await runCli(args);

    assert.equal(
      transitioned.status,
      "team_project_successor",
      transitioned.issues?.join("\n"),
    );
    assert.equal(transitioned.phase, "completed");
    assert.equal(transitioned.resumed, false);
    assert.equal(transitioned.authorizationGranted, false);
    assert.equal(transitioned.exitCode, 0);

    const receiptPath = path.join(root, transitioned.receiptPath);
    const receiptBytes = await readFile(receiptPath);
    const receipt = JSON.parse(receiptBytes);
    assert.equal(receipt.schemaVersion, "OwlCodaRunKitTeamProjectSuccessorReceiptV1");
    assert.equal(receipt.transitionId, "transition-001");
    assert.equal(receipt.phase, "completed");
    assert.equal(receipt.from.projectId, "project-old");
    assert.equal(receipt.from.projectTruthHash, oldStatus.projectTruthHash);
    assert.equal(receipt.to.projectId, "project-new");
    assert.equal(receipt.to.eventCount, 0);
    assert.equal(receipt.authorizationGranted, false);
    assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/u);
    assert.match(receipt.archive.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.deepEqual(receipt.archive.sealPolicy, {
      policy: "posix-owner-write-denied-v1",
      regularFileMode: "0444",
      directoryMode: "0555",
    });
    assert.match(receipt.archive.path, new RegExp(
      `project-old-${oldStatus.projectTruthHash}-${receipt.archive.manifestSha256}$`,
      "u",
    ));

    const archivedFiles = await regularFiles(path.join(root, receipt.archive.path));
    assert.deepEqual(archivedFiles, oldFiles);
    await assertArchiveSealed(path.join(root, receipt.archive.path));
    assert.deepEqual(
      receipt.archive.files.map(row => row.path),
      [...oldFiles.keys()].sort(),
    );
    for (const row of receipt.archive.files) {
      assert.equal(row.sha256, sha256(oldFiles.get(row.path)));
      assert.equal(row.byteLength, oldFiles.get(row.path).byteLength);
    }

    const activeEvents = await readdir(path.join(activeRoot, "events"));
    assert.deepEqual(activeEvents, []);
    const newStatus = readTeamProjectStatusV1({ workspaceRoot: root });
    assert.equal(newStatus.projectId, "project-new");
    assert.equal(newStatus.overall, "planned");
    assert.equal(newStatus.projectTruthHash, receipt.to.projectTruthHash);
    assert.doesNotMatch(JSON.stringify(newStatus), /assignment-old|receipt:old-project/u);

    const takeover = await runCli([
      "project", "takeover", "--workspace", root, "--agent", "agent-old", "--json",
    ]);
    assert.equal(takeover.projectId, "project-new");
    assert.equal(takeover.currentResponsibility, null);
    assert.deepEqual(takeover.allResponsibilities, []);
    assert.deepEqual(takeover.evidenceRefs, []);

    const activeFiles = await regularFiles(activeRoot);
    const retried = await runCli(args);
    assert.equal(retried.status, "team_project_successor");
    assert.equal(retried.resumed, true);
    assert.equal(retried.receiptSha256, transitioned.receiptSha256);
    assert.deepEqual(await readFile(receiptPath), receiptBytes);
    assert.deepEqual(await regularFiles(path.join(root, receipt.archive.path)), oldFiles);
    assert.deepEqual(await regularFiles(activeRoot), activeFiles);
  } finally {
    await removeFixture(root);
  }
});

test("ancestor-symlinked definition directories fail before successor mutation", async () => {
  const root = await setupProject({ projectId: "ancestor-link-old" });
  try {
    const activePath = path.join(root, ".owlcoda/runkit/project");
    const before = readTeamProjectStatusV1({ workspaceRoot: root });
    const realDirectory = path.join(root, "definition-source-real");
    const linkedDirectory = path.join(root, "definition-source-link");
    await mkdir(realDirectory);
    await symlink(realDirectory, linkedDirectory);
    const realDefinition = path.join(realDirectory, "next.json");
    const linkedDefinition = path.join(linkedDirectory, "next.json");
    await writeJson(realDefinition, projectDefinition("ancestor-link-new"));

    const result = await runCli(successorArgs(root, linkedDefinition, {
      transitionId: "transition-ancestor-link",
    }));
    const journalPath = path.join(
      root,
      ".owlcoda/runkit/project-successor-transitions/transition-ancestor-link.json",
    );
    const archivesPath = path.join(root, ".owlcoda/runkit/project-archives");
    const after = readTeamProjectStatusV1({ workspaceRoot: root });

    assert.deepEqual({
      status: result.status,
      rejectedSymlink: /definition.*symlink/iu.test(result.issues?.join("\n") ?? ""),
      journalExists: await pathExists(journalPath),
      archiveNamespaceExists: await pathExists(archivesPath),
      activeProjectId: after.projectId,
      activeTruthPreserved: after.projectTruthHash === before.projectTruthHash,
      activeStillExists: await pathExists(activePath),
    }, {
      status: "invalid_input",
      rejectedSymlink: true,
      journalExists: false,
      archiveNamespaceExists: false,
      activeProjectId: "ancestor-link-old",
      activeTruthPreserved: true,
      activeStillExists: true,
    });
  } finally {
    await removeFixture(root);
  }
});

test("sealed archives reject ordinary writes and historical tamper blocks the next successor", async () => {
  const root = await setupProject({ projectId: "history-old" });
  try {
    const firstDefinitionPath = path.join(root, "history-current.json");
    await writeJson(firstDefinitionPath, projectDefinition("history-current", "current-delivery"));
    const firstArgs = successorArgs(root, firstDefinitionPath, {
      transitionId: "transition-history-first",
    });
    const first = await runCli(firstArgs);
    assert.equal(first.status, "team_project_successor", first.issues?.join("\n"));
    const firstReceiptPath = path.join(root, first.receiptPath);
    const firstReceiptBytes = await readFile(firstReceiptPath);
    const firstReceipt = JSON.parse(firstReceiptBytes);
    const archiveRoot = path.join(root, firstReceipt.archive.path);
    const archivedDefinition = path.join(archiveRoot, "definition.json");

    let ordinaryWriteCode = null;
    let writableHandle;
    try {
      writableHandle = await open(archivedDefinition, "r+");
    } catch (error) {
      ordinaryWriteCode = error?.code ?? "unknown";
    } finally {
      await writableHandle?.close();
    }

    await chmod(archivedDefinition, 0o644);
    const sealDriftRetry = await runCli(firstArgs);
    await chmod(archivedDefinition, 0o444);

    completeProject(root, {
      eventPrefix: "current-event",
      assignmentId: "assignment-current",
      workItemId: "current-delivery",
      agentId: "agent-current",
      evidenceSuffix: "current-project",
    });
    const currentBefore = readTeamProjectStatusV1({ workspaceRoot: root });
    const activeBefore = await regularFiles(path.join(root, ".owlcoda/runkit/project"));

    await chmod(archivedDefinition, 0o644);
    await writeFile(archivedDefinition, "forced historical tamper\n");
    await chmod(archivedDefinition, 0o444);

    const secondDefinitionPath = path.join(root, "history-next.json");
    await writeJson(secondDefinitionPath, projectDefinition("history-next", "next-delivery"));
    const secondTransitionId = "transition-history-second";
    const second = await runCli(successorArgs(root, secondDefinitionPath, {
      transitionId: secondTransitionId,
      at: "2026-08-09T08:01:00.000Z",
      reason: "Historical integrity must precede the next project.",
    }));
    const currentAfter = readTeamProjectStatusV1({ workspaceRoot: root });
    const secondJournalPath = path.join(
      root,
      `.owlcoda/runkit/project-successor-transitions/${secondTransitionId}.json`,
    );

    assert.deepEqual({
      ordinaryWriteRejected: ["EACCES", "EPERM"].includes(ordinaryWriteCode),
      sealDriftRetryStatus: sealDriftRetry.status,
      sealDriftRetryRejected: /archive.*seal/iu.test(sealDriftRetry.issues?.join("\n") ?? ""),
      retryReceiptPreserved: (await readFile(firstReceiptPath)).equals(firstReceiptBytes),
      laterSuccessorStatus: second.status,
      laterSuccessorRejected: /historical.*archive|archive.*(?:bytes|manifest)/iu.test(
        second.issues?.join("\n") ?? "",
      ),
      laterJournalExists: await pathExists(secondJournalPath),
      activeProjectId: currentAfter.projectId,
      activeTruthPreserved: currentAfter.projectTruthHash === currentBefore.projectTruthHash,
      activeBytesPreserved: sameFiles(
        await regularFiles(path.join(root, ".owlcoda/runkit/project")),
        activeBefore,
      ),
    }, {
      ordinaryWriteRejected: true,
      sealDriftRetryStatus: "invalid_input",
      sealDriftRetryRejected: true,
      retryReceiptPreserved: true,
      laterSuccessorStatus: "invalid_input",
      laterSuccessorRejected: true,
      laterJournalExists: false,
      activeProjectId: "history-current",
      activeTruthPreserved: true,
      activeBytesPreserved: true,
    });
  } finally {
    await removeFixture(root);
  }
});

test("successor derives completion and rejects same identity or symlinked inputs without moving truth", async () => {
  const plannedRoot = await setupProject({ completed: false, projectId: "planned-old" });
  const completedRoot = await setupProject({ projectId: "completed-old" });
  const symlinkedActiveRoot = await setupProject({ projectId: "symlinked-old" });
  try {
    const plannedDefinition = path.join(plannedRoot, "planned-next.json");
    await writeJson(plannedDefinition, projectDefinition("planned-next"));
    const plannedBefore = await regularFiles(path.join(plannedRoot, ".owlcoda/runkit/project"));
    const rejectedPlanned = await runCli(successorArgs(plannedRoot, plannedDefinition));
    assert.equal(rejectedPlanned.status, "invalid_input");
    assert.match(rejectedPlanned.issues.join("\n"), /derived status.*completed/iu);
    assert.deepEqual(
      await regularFiles(path.join(plannedRoot, ".owlcoda/runkit/project")),
      plannedBefore,
    );
    assert.equal(await pathExists(path.join(
      plannedRoot,
      ".owlcoda/runkit/project-successor-transitions/transition-001.json",
    )), false);

    const sameDefinition = path.join(completedRoot, "same-project.json");
    await writeJson(sameDefinition, projectDefinition("completed-old"));
    const sameBefore = readTeamProjectStatusV1({ workspaceRoot: completedRoot });
    const rejectedSame = await runCli(successorArgs(completedRoot, sameDefinition));
    assert.equal(rejectedSame.status, "invalid_input");
    assert.match(rejectedSame.issues.join("\n"), /different project identity/iu);
    assert.equal(
      readTeamProjectStatusV1({ workspaceRoot: completedRoot }).projectTruthHash,
      sameBefore.projectTruthHash,
    );

    const realDefinition = path.join(completedRoot, "real-next.json");
    const linkedDefinition = path.join(completedRoot, "linked-next.json");
    await writeJson(realDefinition, projectDefinition("linked-next"));
    await symlink(realDefinition, linkedDefinition);
    const rejectedDefinitionLink = await runCli(successorArgs(
      completedRoot,
      linkedDefinition,
      { transitionId: "transition-linked-definition" },
    ));
    assert.equal(rejectedDefinitionLink.status, "invalid_input");
    assert.match(rejectedDefinitionLink.issues.join("\n"), /definition.*symlink/iu);

    const activePath = path.join(symlinkedActiveRoot, ".owlcoda/runkit/project");
    const redirectedPath = path.join(symlinkedActiveRoot, ".owlcoda/runkit/project-real");
    await rename(activePath, redirectedPath);
    await symlink(redirectedPath, activePath);
    const safeDefinition = path.join(symlinkedActiveRoot, "safe-next.json");
    await writeJson(safeDefinition, projectDefinition("safe-next"));
    const rejectedActiveLink = await runCli(successorArgs(symlinkedActiveRoot, safeDefinition));
    assert.equal(rejectedActiveLink.status, "invalid_input");
    assert.match(rejectedActiveLink.issues.join("\n"), /active project.*symlink/iu);
  } finally {
    await Promise.all([
      removeFixture(plannedRoot),
      removeFixture(completedRoot),
      removeFixture(symlinkedActiveRoot),
    ]);
  }
});

test("exact retry recovers prepared, archived, and active-installed crash boundaries", async () => {
  for (const phase of ["prepared", "archived", "active_installed"]) {
    const root = await setupProject({ projectId: `crash-old-${phase}` });
    try {
      const activePath = path.join(root, ".owlcoda/runkit/project");
      await writeFile(path.join(activePath, "raw.bin"), Buffer.from(`raw-${phase}\0`));
      const oldFiles = await regularFiles(activePath);
      const nextDefinitionPath = path.join(root, `next-${phase}.json`);
      await writeJson(nextDefinitionPath, projectDefinition(`crash-new-${phase}`));
      const args = successorArgs(root, nextDefinitionPath, {
        transitionId: `transition-${phase}`,
      });
      const marker = path.join(root, `${phase}.marker`);
      const crashed = startCrashChild(args, marker, phase);
      const crashResult = await crashed.closed;
      assert.equal(crashResult.code, 91, crashResult.stderr || crashResult.stdout);
      assert.equal(await readFile(marker, "utf8"), phase);

      const recovered = await runCli(args);
      assert.equal(recovered.status, "team_project_successor");
      assert.equal(recovered.phase, "completed");
      assert.equal(recovered.resumed, true);
      const receipt = JSON.parse(await readFile(path.join(root, recovered.receiptPath)));
      const archivePath = path.join(root, receipt.archive.path);
      assert.deepEqual(await regularFiles(archivePath), oldFiles);
      await assertArchiveSealed(archivePath);
      assert.deepEqual(await readdir(path.join(activePath, "events")), []);
      assert.equal(readTeamProjectStatusV1({ workspaceRoot: root }).projectId, `crash-new-${phase}`);
    } finally {
      await removeFixture(root);
    }
  }
});

test("a live lifecycle lock rejects a different transition, and an archive symlink fails closed", async () => {
  const competingRoot = await setupProject({ projectId: "competing-old" });
  const collisionRoot = await setupProject({ projectId: "collision-old" });
  let pausedChild = null;
  try {
    const competingDefinition = path.join(competingRoot, "competing-next.json");
    await writeJson(competingDefinition, projectDefinition("competing-next"));
    const originalArgs = successorArgs(competingRoot, competingDefinition, {
      transitionId: "transition-owner-a",
    });
    const marker = path.join(competingRoot, "paused.marker");
    pausedChild = startCrashChild(originalArgs, marker, "prepared", { pause: true });
    await waitForPath(marker);

    const rejectedCompetitor = await runCli(successorArgs(
      competingRoot,
      competingDefinition,
      {
        transitionId: "transition-owner-b",
        at: "2026-08-09T08:01:00.000Z",
        reason: "Competing transition must not win.",
      },
    ));
    assert.equal(rejectedCompetitor.status, "invalid_input");
    assert.match(rejectedCompetitor.issues.join("\n"), /lifecycle transaction.*active/iu);
    assert.equal(await pathExists(path.join(
      competingRoot,
      ".owlcoda/runkit/project-successor-transitions/transition-owner-b.json",
    )), false);

    pausedChild.child.kill("SIGKILL");
    await pausedChild.closed;
    pausedChild = null;
    const recovered = await runCli(originalArgs);
    assert.equal(recovered.status, "team_project_successor");
    assert.equal(recovered.resumed, true);

    const collisionDefinition = path.join(collisionRoot, "collision-next.json");
    await writeJson(collisionDefinition, projectDefinition("collision-next"));
    const collisionArgs = successorArgs(collisionRoot, collisionDefinition, {
      transitionId: "transition-collision",
    });
    const collisionMarker = path.join(collisionRoot, "collision.marker");
    const crashed = startCrashChild(collisionArgs, collisionMarker, "prepared");
    const crashResult = await crashed.closed;
    assert.equal(crashResult.code, 91, crashResult.stderr || crashResult.stdout);

    const journalPath = path.join(
      collisionRoot,
      ".owlcoda/runkit/project-successor-transitions/transition-collision.json",
    );
    const prepared = JSON.parse(await readFile(journalPath));
    const trapPath = path.join(collisionRoot, "archive-trap");
    const archivePath = path.join(collisionRoot, prepared.archive.path);
    await mkdir(trapPath);
    await mkdir(path.dirname(archivePath), { recursive: true });
    await symlink(trapPath, archivePath);

    const collisionBefore = readTeamProjectStatusV1({ workspaceRoot: collisionRoot });
    const rejectedCollision = await runCli(collisionArgs);
    assert.equal(rejectedCollision.status, "invalid_input");
    assert.match(rejectedCollision.issues.join("\n"), /archive.*symlink/iu);
    assert.equal(
      readTeamProjectStatusV1({ workspaceRoot: collisionRoot }).projectTruthHash,
      collisionBefore.projectTruthHash,
    );
    assert.deepEqual(await readdir(trapPath), []);
  } finally {
    if (pausedChild) {
      pausedChild.child.kill("SIGKILL");
      await pausedChild.closed;
    }
    await Promise.all([
      removeFixture(competingRoot),
      removeFixture(collisionRoot),
    ]);
  }
});
