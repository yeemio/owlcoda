import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveHumanStatusFromInspectV1,
} from "../scripts/runkit-contract/human-status.mjs";
import {
  buildInspectSummary,
  formatInspectHuman,
} from "../scripts/runkit-contract/inspect-presentation.mjs";

function inspectTruth(overrides = {}) {
  return {
    status: "inspected",
    exitCode: 0,
    runtimeRoot: ".owlcoda/runkit",
    config: {},
    configCore: {
      status: "valid",
      exitCode: 0,
      issues: [],
    },
    controlIssues: [],
    runIds: [],
    executions: [],
    recovery: {
      state: "no_active_execution",
      activeRunIds: [],
      selectedRunId: null,
      nextAllowedAction: "plan_new_execution",
      authorizationGranted: false,
    },
    ...overrides,
  };
}

test("human status blocks Core drift instead of recommending a new execution", () => {
  const inspected = inspectTruth({
    exitCode: 2,
    configCore: {
      status: "engine_changed_during_execution",
      exitCode: 2,
      issues: [
        "coreVersion changed during execution",
        "coreManifestSha256 changed during execution",
      ],
    },
  });

  const status = deriveHumanStatusFromInspectV1(inspected);

  assert.equal(status.schemaVersion, "OwlCodaRunKitHumanStatusV1");
  assert.equal(status.overall, "blocked");
  assert.equal(status.stage, "setup");
  assert.equal(status.control.status, "drifted");
  assert.equal(status.nextAllowedAction, "run_official_init_migration");
  assert.equal(status.remainingGateCount, 1);
  assert.deepEqual(status.remainingGates.map((gate) => gate.code), [
    "restore_current_core_binding",
  ]);
  assert.ok(status.control.issueCodes.includes("coreVersion_changed_during_execution"));
  assert.equal(status.authorizationGranted, false);

  const summary = buildInspectSummary(inspected);
  assert.equal(summary.dominantGap.code, "run_official_init_migration");
  assert.equal(summary.nextAllowedAction, "run_official_init_migration");
  assert.equal(summary.closedHistory.blocking, false);
  const human = formatInspectHuman({ ...inspected, summary, view: { mode: "summary" } });
  assert.match(human, /Status:\s+blocked/i);
  assert.match(human, /Remaining gates:\s+1/i);
  assert.match(human, /Next allowed action:\s+run_official_init_migration/i);
});

test("Core drift never recommends migration while an execution is still active", () => {
  const status = deriveHumanStatusFromInspectV1(inspectTruth({
    exitCode: 2,
    configCore: {
      status: "engine_changed_during_execution",
      exitCode: 2,
      issues: ["coreVersion changed during execution"],
    },
    runIds: ["active-run"],
    executions: [{
      runId: "active-run",
      lifecycle: "active",
      recovery: {
        lease: { status: "active", activeWorkItemIds: ["W1"] },
        issues: ["engine pin is historical"],
      },
    }],
    recovery: {
      state: "single_active_execution",
      activeRunIds: ["active-run"],
      selectedRunId: "active-run",
      nextAllowedAction: "repair_execution_artifacts",
      authorizationGranted: false,
    },
  }));

  assert.equal(status.overall, "blocked");
  assert.equal(status.currentExecutionId, "active-run");
  assert.equal(status.nextAllowedAction, "repair_execution_artifacts");
  assert.deepEqual(status.remainingGates.map((gate) => gate.code), [
    "resolve_active_execution_before_core_migration",
  ]);
});

test("invalid config truth is repaired and never mislabeled as a migratable Core drift", () => {
  const status = deriveHumanStatusFromInspectV1(inspectTruth({
    exitCode: 2,
    config: null,
    configCore: {
      status: "invalid_config",
      exitCode: 2,
      issues: ["Project config must be a regular file, not a symlink"],
    },
    controlIssues: ["Project config must be a regular file, not a symlink"],
    recovery: {
      state: "invalid_control_truth",
      activeRunIds: [],
      selectedRunId: null,
      nextAllowedAction: "repair_execution_artifacts",
      authorizationGranted: false,
    },
  }));

  assert.equal(status.overall, "blocked");
  assert.equal(status.control.status, "invalid");
  assert.equal(status.nextAllowedAction, "repair_execution_artifacts");
  assert.deepEqual(status.remainingGates.map((gate) => gate.code), [
    "repair_control_artifacts",
  ]);
});

test("human status derives active work progress only from the selected inspect execution", () => {
  const inspected = inspectTruth({
    runIds: ["active-run"],
    executions: [{
      runId: "active-run",
      lifecycle: "active",
      recovery: {
        lease: {
          status: "active",
          activeWorkItemIds: ["W1"],
        },
        delivery: { status: "missing" },
        verification: { status: "missing" },
        resourcePreflight: { status: "none", selected: null },
        evidenceTrustLevel: "work_in_progress",
        nextAllowedAction: "continue_feature_work",
        issues: [],
      },
    }],
    recovery: {
      state: "single_active_execution",
      activeRunIds: ["active-run"],
      selectedRunId: "active-run",
      nextAllowedAction: "continue_feature_work",
      authorizationGranted: false,
    },
  });

  const status = deriveHumanStatusFromInspectV1(inspected);

  assert.equal(status.overall, "working");
  assert.equal(status.stage, "implementation");
  assert.equal(status.currentExecutionId, "active-run");
  assert.deepEqual(status.completedSteps, ["writer_lease_active"]);
  assert.equal(status.remainingGateCount, 1);
  assert.equal(status.remainingGates[0].code, "continue_feature_work");
  assert.deepEqual(status.milestones, {
    sourceData: {
      status: "not_evidenced",
      evidence: "none",
      label: "Source/data readiness is not evidenced by inspect.",
    },
    releasePackage: {
      status: "not_evidenced",
      evidence: "none",
      label: "Release package readiness is not evidenced by inspect.",
    },
    remoteVmWrite: {
      status: "not_evidenced",
      evidence: "none",
      label: "Remote/VM write is not evidenced by inspect.",
    },
  });
});

test("human status reports source readiness from a fresh delivery packet without inventing package or VM effects", () => {
  const inspected = inspectTruth({
    runIds: ["delivery-run"],
    executions: [{
      runId: "delivery-run",
      lifecycle: "active",
      recovery: {
        lease: {
          status: "released",
          activeWorkItemIds: [],
        },
        delivery: {
          status: "fresh",
          selectedPacketPath: ".owlcoda/runkit/executions/delivery-run/delivery-packets/source.json",
          sourceFingerprint: "a".repeat(64),
        },
        verification: { status: "missing" },
        resourcePreflight: { status: "none", selected: null },
        evidenceTrustLevel: "delivery_fresh",
        nextAllowedAction: "run_stage_verification",
        issues: [],
      },
    }],
    recovery: {
      state: "single_active_execution",
      activeRunIds: ["delivery-run"],
      selectedRunId: "delivery-run",
      nextAllowedAction: "run_stage_verification",
      authorizationGranted: false,
    },
  });

  const status = deriveHumanStatusFromInspectV1(inspected);

  assert.deepEqual(status.milestones.sourceData, {
    status: "ready",
    evidence: "fresh_delivery_packet",
    label: "Source/data is ready from a fresh delivery packet.",
  });
  assert.equal(status.milestones.releasePackage.status, "not_evidenced");
  assert.equal(status.milestones.remoteVmWrite.status, "not_evidenced");
  assert.equal(status.releaseAuthorization, false);
  assert.equal(status.deployAuthorization, false);

  const summary = buildInspectSummary(inspected);
  const human = formatInspectHuman({
    ...inspected,
    summary,
    view: { mode: "summary" },
  });
  assert.match(human, /Source\/data readiness:\s+ready/i);
  assert.match(human, /Release package:\s+not_evidenced/i);
  assert.match(human, /Remote\/VM write:\s+not_evidenced/i);
  assert.match(human, /Remaining gates:\s+1/i);
});

test("a healthy inspect with only closed executions projects a closed state with no invented gate", () => {
  const inspected = inspectTruth({
    runIds: ["closed-run"],
    executions: [{
      runId: "closed-run",
      lifecycle: "closed",
      closeout: {
        status: "valid",
        decision: "accepted",
        authorizationGranted: false,
      },
      recovery: {
        lease: { status: "released", activeWorkItemIds: [] },
        evidenceTrustLevel: "accepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
      },
    }],
  });

  const status = deriveHumanStatusFromInspectV1(inspected);

  assert.equal(status.overall, "closed");
  assert.equal(status.stage, "closeout");
  assert.deepEqual(status.completedSteps, ["execution_closed"]);
  assert.equal(status.remainingGateCount, 0);
  assert.deepEqual(status.remainingGates, []);
  assert.equal(status.milestones.sourceData.status, "not_evidenced");
  assert.equal(status.milestones.releasePackage.status, "not_evidenced");
  assert.equal(status.milestones.remoteVmWrite.status, "not_evidenced");
});

test("unordered mixed closed history fails closed instead of treating runId order as chronology", () => {
  const executions = [
    {
      runId: "a-new-rejected",
      lifecycle: "closed",
      closeout: {
        status: "valid",
        decision: "rejected",
        authorizationGranted: false,
      },
      recovery: {
        lease: { status: "released", activeWorkItemIds: [] },
        evidenceTrustLevel: "closed_nonaccepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
      },
    },
    {
      runId: "z-old-accepted",
      lifecycle: "closed",
      closeout: {
        status: "valid",
        decision: "accepted",
        authorizationGranted: false,
      },
      recovery: {
        lease: { status: "released", activeWorkItemIds: [] },
        evidenceTrustLevel: "closed_accepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
      },
    },
  ];

  for (const ordered of [executions, [...executions].reverse()]) {
    const inspected = inspectTruth({
      runIds: ordered.map((execution) => execution.runId),
      executions: ordered,
    });
    const status = deriveHumanStatusFromInspectV1(inspected);

    assert.equal(status.overall, "blocked");
    assert.equal(status.currentExecutionId, null);
    assert.equal(status.remainingGateCount, 1);
    assert.deepEqual(status.remainingGates.map((gate) => gate.code), [
      "ambiguous_history",
    ]);
    assert.deepEqual(status.control.issueCodes, ["ambiguous_history"]);
    assert.equal(status.nextAllowedAction, "inspect_closed_history");
    assert.deepEqual(status.completedSteps, []);

    const summary = buildInspectSummary(inspected);
    assert.equal(summary.latestIndexedCloseout, null);
    const human = formatInspectHuman({
      ...inspected,
      summary,
      view: { mode: "summary" },
    });
    assert.doesNotMatch(human, /Latest indexed closeout:\s+(?!none)/iu);
    assert.match(human, /conflicting outcomes without proven chronology/iu);
  }
});

test("trusted independent mixed closeouts do not compete with the lifecycle next action", () => {
  const executions = [
    {
      runId: "accepted-run",
      lifecycle: "closed",
      closeout: {
        status: "valid",
        decision: "accepted",
        authorizationGranted: false,
      },
      recovery: {
        lease: { status: "released", activeWorkItemIds: [] },
        evidenceTrustLevel: "closed_accepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
      },
    },
    {
      runId: "blocked-run",
      lifecycle: "closed",
      closeout: {
        status: "valid",
        decision: "blocked",
        authorizationGranted: false,
      },
      recovery: {
        lease: { status: "released", activeWorkItemIds: [] },
        evidenceTrustLevel: "closed_nonaccepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
      },
    },
  ];
  const inspected = inspectTruth({
    runIds: executions.map((execution) => execution.runId),
    executions,
    controlState: {
      schemaVersion: "OwlCodaRunKitProjectControlStateV1",
      closedHistory: {
        status: "multiple_independent_closed_histories",
        runIds: executions.map((execution) => execution.runId),
        headRunId: null,
        decision: null,
        decisionCounts: { accepted: 1, blocked: 1, rejected: 0 },
        lineageVerified: false,
        blocking: false,
        issues: [],
      },
    },
  });

  const status = deriveHumanStatusFromInspectV1(inspected);
  assert.equal(status.overall, "closed");
  assert.equal(status.nextAllowedAction, "plan_new_execution");
  assert.equal(status.remainingGateCount, 0);
  assert.deepEqual(status.control.issueCodes, []);
  assert.deepEqual(status.completedSteps, [
    "multiple_independent_closed_histories",
  ]);

  const summary = buildInspectSummary(inspected);
  assert.equal(summary.nextAllowedAction, "plan_new_execution");
  assert.equal(summary.lifecycleNextAction, "plan_new_execution");
  assert.equal(summary.maintenanceNextAction, null);
  assert.equal(summary.optionalReviewAction, "inspect_closed_history");
  assert.equal(summary.latestIndexedCloseout, null);
  assert.equal(summary.selectedHeadCloseout, null);
  assert.deepEqual(summary.closedHistory, {
    status: "multiple_independent_closed_histories",
    runCount: 2,
    blocking: false,
    selectedHeadRunId: null,
    selectionReason: "no_unique_lineage_head",
    decisionCounts: { accepted: 1, blocked: 1, rejected: 0 },
  });

  const human = formatInspectHuman({
    ...inspected,
    summary,
    view: { mode: "summary" },
  });
  assert.match(human, /Closed history:\s+multiple_independent_closed_histories \(2 runs, non-blocking\)/i);
  assert.match(human, /Selected lineage head:\s+none \(no_unique_lineage_head\)/i);
  assert.match(human, /Optional review:\s+inspect_closed_history/i);
  assert.doesNotMatch(human, /Latest indexed closeout/i);
});

test("unordered consistent closed history is summarized conservatively without claiming a latest run", () => {
  const executions = ["z-accepted", "a-accepted"].map((runId) => ({
    runId,
    lifecycle: "closed",
    closeout: {
      status: "valid",
      decision: "accepted",
      authorizationGranted: false,
    },
    recovery: {
      lease: { status: "released", activeWorkItemIds: [] },
      delivery: {
        status: "historical",
        sourceFingerprint: runId.startsWith("z") ? "1".repeat(64) : "2".repeat(64),
      },
      verification: {
        status: "passed",
        sourceFingerprint: runId.startsWith("z") ? "1".repeat(64) : "2".repeat(64),
      },
      evidenceTrustLevel: "closed_accepted",
      nextAllowedAction: "plan_new_execution",
      issues: [],
    },
  }));
  const inspected = inspectTruth({
    runIds: executions.map((execution) => execution.runId),
    executions,
  });

  const status = deriveHumanStatusFromInspectV1(inspected);

  assert.equal(status.overall, "closed");
  assert.equal(status.currentExecutionId, null);
  assert.equal(status.remainingGateCount, 0);
  assert.deepEqual(status.completedSteps, [
    "execution_history_closed_consistent",
  ]);
  assert.match(status.headline, /consistent/i);
  assert.doesNotMatch(status.headline, /latest/i);
  assert.equal(status.milestones.sourceData.status, "not_evidenced");
  assert.equal(buildInspectSummary(inspected).latestIndexedCloseout, null);
});

test("a verified unique continuation head controls the closed-history projection", () => {
  const parent = {
    runId: "z-parent-accepted",
    lifecycle: "closed",
    closeout: {
      status: "valid",
      decision: "accepted",
      authorizationGranted: false,
    },
    recovery: {
      lease: { status: "released", activeWorkItemIds: [] },
      evidenceTrustLevel: "closed_accepted",
      nextAllowedAction: "plan_new_execution",
      issues: [],
    },
  };
  const head = {
    runId: "a-child-rejected",
    lifecycle: "closed",
    closeout: {
      status: "valid",
      decision: "rejected",
      authorizationGranted: false,
    },
    recovery: {
      lease: { status: "released", activeWorkItemIds: [] },
      evidenceTrustLevel: "closed_nonaccepted",
      nextAllowedAction: "plan_new_execution",
      issues: [],
    },
  };
  const inspected = inspectTruth({
    runIds: [head.runId, parent.runId],
    executions: [head, parent],
    controlState: {
      schemaVersion: "OwlCodaRunKitProjectControlStateV1",
      closedHistory: {
        status: "unique_head",
        runIds: [head.runId, parent.runId],
        headRunId: head.runId,
        decision: "rejected",
        lineageVerified: true,
        issues: [],
      },
    },
  });

  const status = deriveHumanStatusFromInspectV1(inspected);

  assert.equal(status.overall, "blocked");
  assert.equal(status.currentExecutionId, head.runId);
  assert.equal(status.nextAllowedAction, "review_rejected_closeout");
  assert.deepEqual(status.remainingGates.map((gate) => gate.code), [
    "rejected_closeout",
  ]);
  assert.equal(buildInspectSummary(inspected).latestIndexedCloseout.runId, head.runId);
});

test("accepted verified source evidence never implies a release package or remote write", () => {
  const status = deriveHumanStatusFromInspectV1(inspectTruth({
    runIds: ["accepted-run"],
    executions: [{
      runId: "accepted-run",
      lifecycle: "closed",
      closeout: {
        status: "valid",
        decision: "accepted",
        authorizationGranted: false,
      },
      recovery: {
        lease: { status: "released", activeWorkItemIds: [] },
        delivery: {
          status: "historical",
          sourceFingerprint: "b".repeat(64),
        },
        verification: {
          status: "passed",
          activeReceiptSha256: "c".repeat(64),
          sourceFingerprint: "b".repeat(64),
        },
        evidenceTrustLevel: "closed_accepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
      },
    }],
  }));

  assert.deepEqual(status.milestones.sourceData, {
    status: "ready",
    evidence: "verified_historical_source",
    label: "Source/data is ready from verified historical evidence.",
  });
  assert.deepEqual(status.milestones.releasePackage, {
    status: "not_evidenced",
    evidence: "none",
    label: "Release package readiness is not evidenced by inspect.",
  });
  assert.deepEqual(status.milestones.remoteVmWrite, {
    status: "not_evidenced",
    evidence: "none",
    label: "Remote/VM write is not evidenced by inspect.",
  });
});

test("nonaccepted closeouts remain visibly unresolved instead of looking like zero-gate success", () => {
  const expectations = [
    {
      decision: "rejected",
      expectedAction: "review_rejected_closeout",
      expectedGate: "rejected_closeout",
    },
    {
      decision: "blocked",
      expectedAction: "resolve_blocked_closeout",
      expectedGate: "blocked_closeout",
    },
    {
      decision: null,
      expectedAction: "review_nonaccepted_closeout",
      expectedGate: "closed_nonaccepted",
    },
  ];

  for (const expectation of expectations) {
    const runId = `${expectation.decision ?? "nonaccepted"}-run`;
    const status = deriveHumanStatusFromInspectV1(inspectTruth({
      runIds: [runId],
      executions: [{
        runId,
        lifecycle: "closed",
        closeout: {
          status: "valid",
          ...(expectation.decision === null
            ? {}
            : { decision: expectation.decision }),
          authorizationGranted: false,
        },
        recovery: {
          lease: { status: "released", activeWorkItemIds: [] },
          evidenceTrustLevel: "closed_nonaccepted",
          nextAllowedAction: "plan_new_execution",
          issues: [],
        },
      }],
    }));

    assert.equal(status.overall, "blocked");
    assert.equal(status.stage, "closeout");
    assert.equal(status.currentExecutionId, runId);
    assert.deepEqual(status.completedSteps, ["execution_closed_nonaccepted"]);
    assert.equal(status.remainingGateCount, 1);
    assert.deepEqual(status.remainingGates.map((gate) => gate.code), [
      expectation.expectedGate,
    ]);
    assert.equal(status.nextAllowedAction, expectation.expectedAction);
  }
});

test("a superseded deployment is blocked and requires a replacement plan instead of reporting business completion", () => {
  const runId = "deployment-superseded-001";
  const status = deriveHumanStatusFromInspectV1(inspectTruth({
    runIds: [runId],
    executions: [{
      runId,
      lifecycle: "closed",
      closeout: {
        status: "valid",
        decision: "blocked",
        statusCode: "closed_superseded",
        businessGoalIncomplete: true,
        replacementPlanRequired: true,
        nextAllowedAction: "plan_replacement_execution",
        authorizationGranted: false,
      },
      recovery: {
        lease: { status: "released", activeWorkItemIds: [] },
        evidenceTrustLevel: "closed_nonaccepted",
        nextAllowedAction: "plan_new_execution",
        issues: [],
      },
    }],
  }));

  assert.equal(status.overall, "blocked");
  assert.equal(status.nextAllowedAction, "plan_replacement_execution");
  assert.equal(status.businessGoalIncomplete, true);
  assert.equal(status.replacementPlanRequired, true);
  assert.deepEqual(status.completedSteps, ["execution_closed_superseded"]);
  assert.match(status.headline, /superseded.*not complete/iu);
});

test("incomplete inspect truth fails closed instead of fabricating progress", () => {
  const status = deriveHumanStatusFromInspectV1({
    status: "inspected",
    recovery: {
      state: "no_active_execution",
    },
  });

  assert.equal(status.overall, "blocked");
  assert.equal(status.control.status, "invalid");
  assert.equal(status.nextAllowedAction, "rerun_inspect");
  assert.deepEqual(status.control.issueCodes, ["inspect_truth_incomplete"]);
});
