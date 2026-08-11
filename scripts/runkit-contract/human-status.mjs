function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function completeInspectTruth(inspected) {
  return isRecord(inspected)
    && inspected.status === "inspected"
    && Number.isInteger(inspected.exitCode)
    && typeof inspected.runtimeRoot === "string"
    && isRecord(inspected.configCore)
    && typeof inspected.configCore.status === "string"
    && Array.isArray(inspected.configCore.issues)
    && Array.isArray(inspected.controlIssues)
    && Array.isArray(inspected.runIds)
    && Array.isArray(inspected.executions)
    && isRecord(inspected.recovery)
    && typeof inspected.recovery.state === "string"
    && Array.isArray(inspected.recovery.activeRunIds)
    && (
      inspected.recovery.selectedRunId === null
      || typeof inspected.recovery.selectedRunId === "string"
    )
    && typeof inspected.recovery.nextAllowedAction === "string";
}

function issueCode(value) {
  return String(value)
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function milestone(status, evidence, label) {
  return { status, evidence, label };
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function closedDecision(execution) {
  if (
    execution.closeout?.decision === "accepted"
    && execution.recovery?.evidenceTrustLevel !== "closed_nonaccepted"
  ) {
    return "accepted";
  }
  if (execution.closeout?.decision === "blocked") return "blocked";
  if (execution.closeout?.decision === "rejected") return "rejected";
  return "nonaccepted";
}

function sameStringSet(left, right) {
  const sortedLeft = [...left].sort(compareCodeUnits);
  const sortedRight = [...right].sort(compareCodeUnits);
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function decisionCounts(closed) {
  const counts = { accepted: 0, blocked: 0, rejected: 0 };
  for (const execution of closed) counts[closedDecision(execution)] += 1;
  return counts;
}

function sameDecisionCounts(left, right) {
  return isRecord(left)
    && isRecord(right)
    && ["accepted", "blocked", "rejected"].every(
      (decision) => left[decision] === right[decision],
    );
}

export function selectClosedHistoryFocusV1(inspected) {
  const closed = Array.isArray(inspected?.executions)
    ? inspected.executions.filter(execution => execution.lifecycle === "closed")
    : [];
  if (closed.length === 0) {
    return {
      status: "empty",
      selectedExecution: null,
      decision: null,
    };
  }
  if (closed.length === 1) {
    return {
      status: "single",
      selectedExecution: closed[0],
      decision: closedDecision(closed[0]),
    };
  }

  const history = inspected.controlState?.closedHistory;
  const closedRunIds = closed.map(execution => execution.runId);
  const historyBound = isRecord(history)
    && Array.isArray(history.runIds)
    && history.runIds.every(runId => typeof runId === "string")
    && sameStringSet(history.runIds, closedRunIds);
  if (
    historyBound
    && history.status === "unique_head"
    && history.lineageVerified === true
    && typeof history.headRunId === "string"
  ) {
    const head = closed.find(execution => execution.runId === history.headRunId);
    if (head && history.decision === head.closeout?.decision) {
      return {
        status: "unique_head",
        selectedExecution: head,
        decision: closedDecision(head),
      };
    }
  }
  if (
    historyBound
    && history.status === "multiple_independent_closed_histories"
    && history.lineageVerified === false
    && history.headRunId === null
    && history.blocking === false
    && Array.isArray(history.issues)
    && history.issues.length === 0
    && sameDecisionCounts(history.decisionCounts, decisionCounts(closed))
  ) {
    return {
      status: "multiple_independent_closed_histories",
      selectedExecution: null,
      decision: null,
    };
  }

  const decisions = new Set(closed.map(closedDecision));
  if (decisions.size === 1) {
    return {
      status: "consistent_unordered",
      selectedExecution: null,
      decision: decisions.values().next().value,
    };
  }
  return {
    status: "ambiguous_history",
    selectedExecution: null,
    decision: null,
  };
}

function milestoneExecution(inspected) {
  if (!completeInspectTruth(inspected)) return null;
  if (inspected.recovery.selectedRunId !== null) {
    return inspected.executions.find(execution =>
      execution.runId === inspected.recovery.selectedRunId) ?? null;
  }
  if (inspected.recovery.state !== "no_active_execution") return null;
  return selectClosedHistoryFocusV1(inspected).selectedExecution;
}

function operationalMilestones(inspected) {
  const execution = milestoneExecution(inspected);
  const delivery = execution?.recovery?.delivery ?? null;
  const verification = execution?.recovery?.verification ?? null;
  let sourceData = milestone(
    "not_evidenced",
    "none",
    "Source/data readiness is not evidenced by inspect.",
  );
  if (delivery?.status === "fresh") {
    sourceData = milestone(
      "ready",
      "fresh_delivery_packet",
      "Source/data is ready from a fresh delivery packet.",
    );
  } else if (
    delivery?.status === "historical"
    && verification?.status === "passed"
  ) {
    sourceData = milestone(
      "ready",
      "verified_historical_source",
      "Source/data is ready from verified historical evidence.",
    );
  } else if (delivery?.status === "stale" || delivery?.status === "invalid") {
    sourceData = milestone(
      "not_ready",
      `${delivery.status}_delivery_packet`,
      `Source/data is not ready because delivery evidence is ${delivery.status}.`,
    );
  }
  return {
    sourceData,
    releasePackage: milestone(
      "not_evidenced",
      "none",
      "Release package readiness is not evidenced by inspect.",
    ),
    remoteVmWrite: milestone(
      "not_evidenced",
      "none",
      "Remote/VM write is not evidenced by inspect.",
    ),
  };
}

function withMilestones(projection, inspected) {
  return {
    ...projection,
    milestones: operationalMilestones(inspected),
  };
}

function blockedProjection({
  headline,
  controlStatus,
  issueCodes,
  nextAllowedAction,
  gateCode,
  gateLabel,
  currentExecutionId = null,
  stage = "setup",
}) {
  return {
    schemaVersion: "OwlCodaRunKitHumanStatusV1",
    status: "projected",
    overall: "blocked",
    headline,
    stage,
    currentExecutionId,
    completedSteps: [],
    remainingGates: [{
      code: gateCode,
      label: gateLabel,
      nextAllowedAction,
    }],
    remainingGateCount: 1,
    control: {
      status: controlStatus,
      issueCodes,
    },
    nextAllowedAction,
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
    deployAuthorization: false,
  };
}

function consistentUnorderedProjection(decision) {
  if (decision !== "accepted") {
    const details = decision === "rejected"
      ? {
          headline: "All indexed closeouts are rejected, but their chronology is not proven.",
          action: "review_rejected_closeout",
          gateCode: "rejected_closeout",
          gateLabel: "Review the rejected closeout history before planning a successor.",
        }
      : decision === "blocked"
        ? {
            headline: "All indexed closeouts are blocked, but their chronology is not proven.",
            action: "resolve_blocked_closeout",
            gateCode: "blocked_closeout",
            gateLabel: "Resolve the blocked closeout history before planning a successor.",
          }
        : {
            headline: "All indexed closeouts are nonaccepted, but their chronology is not proven.",
            action: "review_nonaccepted_closeout",
            gateCode: "closed_nonaccepted",
            gateLabel: "Review the nonaccepted closeout history before continuing.",
          };
    return {
      ...blockedProjection({
        headline: details.headline,
        controlStatus: "healthy",
        issueCodes: [],
        nextAllowedAction: details.action,
        gateCode: details.gateCode,
        gateLabel: details.gateLabel,
        stage: "closeout",
      }),
      completedSteps: ["execution_history_closed_consistent"],
    };
  }
  return {
    schemaVersion: "OwlCodaRunKitHumanStatusV1",
    status: "projected",
    overall: "closed",
    headline: "Closed execution history is consistent but has no proven chronology.",
    stage: "closeout",
    currentExecutionId: null,
    completedSteps: ["execution_history_closed_consistent"],
    remainingGates: [],
    remainingGateCount: 0,
    control: { status: "healthy", issueCodes: [] },
    nextAllowedAction: "plan_new_execution",
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
    deployAuthorization: false,
  };
}

function stageForAction(action) {
  if (["acquire_writer_lease", "plan_new_execution", "run_onboarding_diagnostics"].includes(action)) {
    return "setup";
  }
  if (action === "continue_feature_work") return "implementation";
  if (["prepare_delivery_packet", "replace_delivery_packet"].includes(action)) return "delivery";
  if (
    action === "run_stage_verification"
    || action === "run_resource_preflight"
    || action === "begin_model_execution"
    || action === "continue_without_model_calls"
    || action === "pause_at_deterministic_stage"
  ) {
    return "verification";
  }
  if (["release_writer_lease", "close_execution"].includes(action)) return "closeout";
  return "external_action";
}

function completedSteps(selected) {
  if (!selected) return [];
  const recovery = selected.recovery ?? {};
  const steps = [];
  if (recovery.lease?.status === "active") steps.push("writer_lease_active");
  if (recovery.delivery?.status === "fresh") steps.push("delivery_packet_ready");
  if (recovery.verification?.status === "passed") steps.push("verification_passed");
  if (recovery.resourcePreflight?.status === "ready") steps.push("resource_preflight_passed");
  return steps;
}

function headlineFor(overall, action, selectedRunId) {
  if (overall === "closed") return "Execution is closed.";
  if (overall === "idle") return "No RunKit execution is active.";
  if (overall === "ready_for_closeout") return `Execution ${selectedRunId} is ready to close out.`;
  if (overall === "blocked") return `Execution ${selectedRunId ?? "control"} is blocked at ${action}.`;
  return `Execution ${selectedRunId} is working at ${action}.`;
}

function nonacceptedCloseoutProjection(execution) {
  const decision = execution.closeout?.decision;
  const superseded = execution.closeout?.statusCode === "closed_superseded"
    && execution.closeout?.businessGoalIncomplete === true
    && execution.closeout?.replacementPlanRequired === true;
  const details = superseded
    ? {
        headline: `Execution ${execution.runId} was superseded; the business goal is not complete.`,
        action: "plan_replacement_execution",
        gateCode: "replacement_execution_required",
        gateLabel: "Plan a replacement execution for the current Owner decision.",
      }
    : decision === "rejected"
    ? {
        headline: `Execution ${execution.runId} closed as rejected.`,
        action: "review_rejected_closeout",
        gateCode: "rejected_closeout",
        gateLabel: "Review the rejected closeout before planning a successor.",
      }
    : decision === "blocked"
      ? {
          headline: `Execution ${execution.runId} closed as blocked.`,
          action: "resolve_blocked_closeout",
          gateCode: "blocked_closeout",
          gateLabel: "Resolve the blocked closeout before planning a successor.",
        }
      : {
          headline: `Execution ${execution.runId} closed without acceptance.`,
          action: "review_nonaccepted_closeout",
          gateCode: "closed_nonaccepted",
          gateLabel: "Review the nonaccepted closeout before continuing.",
        };
  return {
    schemaVersion: "OwlCodaRunKitHumanStatusV1",
    status: "projected",
    overall: "blocked",
    headline: details.headline,
    stage: "closeout",
    currentExecutionId: execution.runId,
    completedSteps: [superseded
      ? "execution_closed_superseded"
      : "execution_closed_nonaccepted"],
    remainingGates: [{
      code: details.gateCode,
      label: details.gateLabel,
      nextAllowedAction: details.action,
    }],
    remainingGateCount: 1,
    control: {
      status: "healthy",
      issueCodes: [],
    },
    nextAllowedAction: details.action,
    ...(superseded
      ? {
        businessGoalIncomplete: true,
        replacementPlanRequired: true,
      }
      : {}),
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
    deployAuthorization: false,
  };
}

export function deriveHumanStatusFromInspectV1(inspected) {
  if (!completeInspectTruth(inspected)) {
    return withMilestones(blockedProjection({
      headline: "Inspect truth is incomplete; progress was not inferred.",
      controlStatus: "invalid",
      issueCodes: ["inspect_truth_incomplete"],
      nextAllowedAction: "rerun_inspect",
      gateCode: "restore_complete_inspect_truth",
      gateLabel: "Rerun a complete inspect before continuing.",
    }), inspected);
  }

  if (
    inspected.controlIssues.length > 0
    || inspected.configCore.status === "invalid_config"
  ) {
    return withMilestones(blockedProjection({
      headline: "RunKit control artifacts require repair.",
      controlStatus: "invalid",
      issueCodes: [
        inspected.configCore.status,
        ...inspected.configCore.issues.map(issueCode),
        ...inspected.controlIssues.map(issueCode),
      ],
      nextAllowedAction: "repair_execution_artifacts",
      gateCode: "repair_control_artifacts",
      gateLabel: "Repair the invalid RunKit control artifacts.",
    }), inspected);
  }

  if (inspected.configCore.status !== "valid") {
    const drifted = inspected.configCore.status === "engine_changed_during_execution";
    const activeExecution = inspected.recovery.activeRunIds.length > 0;
    return withMilestones(blockedProjection({
      headline: drifted && activeExecution
        ? "An active execution must be resolved before the Core binding can migrate."
        : drifted
        ? "Project control is bound to a different Core identity."
        : "Project Core binding is invalid.",
      controlStatus: drifted ? "drifted" : "invalid",
      issueCodes: [
        inspected.configCore.status,
        ...inspected.configCore.issues.map(issueCode),
      ],
      nextAllowedAction: drifted && activeExecution
        ? inspected.recovery.nextAllowedAction
        : drifted
        ? "run_official_init_migration"
        : "repair_execution_artifacts",
      gateCode: drifted && activeExecution
        ? "resolve_active_execution_before_core_migration"
        : drifted
        ? "restore_current_core_binding"
        : "repair_control_artifacts",
      gateLabel: drifted && activeExecution
        ? "Resolve and close the active execution before Core migration."
        : drifted
        ? "Migrate project control to the current Core identity."
        : "Repair the invalid RunKit control artifacts.",
      currentExecutionId: inspected.recovery.selectedRunId,
    }), inspected);
  }

  if (inspected.recovery.state === "no_active_execution") {
    const history = selectClosedHistoryFocusV1(inspected);
    if (history.status === "multiple_independent_closed_histories") {
      return withMilestones({
        schemaVersion: "OwlCodaRunKitHumanStatusV1",
        status: "projected",
        overall: "closed",
        headline: "Multiple independent closed histories are trusted; no lineage head was selected.",
        stage: "closeout",
        currentExecutionId: null,
        completedSteps: ["multiple_independent_closed_histories"],
        remainingGates: [],
        remainingGateCount: 0,
        control: { status: "healthy", issueCodes: [] },
        nextAllowedAction: inspected.recovery.nextAllowedAction,
        authorizationGranted: false,
        gitAuthorization: false,
        releaseAuthorization: false,
        deployAuthorization: false,
      }, inspected);
    }
    if (history.status === "ambiguous_history") {
      return withMilestones(blockedProjection({
        headline: "Closed execution history has conflicting outcomes without proven chronology.",
        controlStatus: "healthy",
        issueCodes: ["ambiguous_history"],
        nextAllowedAction: "inspect_closed_history",
        gateCode: "ambiguous_history",
        gateLabel: "Establish a verified predecessor lineage or inspect the conflicting closeouts.",
        stage: "closeout",
      }), inspected);
    }
    if (history.status === "consistent_unordered") {
      return withMilestones(
        consistentUnorderedProjection(history.decision),
        inspected,
      );
    }
    const latestClosed = history.selectedExecution;
    if (
      latestClosed
      && (
        latestClosed.closeout?.decision !== "accepted"
        || latestClosed.recovery?.evidenceTrustLevel === "closed_nonaccepted"
      )
    ) {
      return withMilestones(
        nonacceptedCloseoutProjection(latestClosed),
        inspected,
      );
    }
    const overall = history.status === "empty" ? "idle" : "closed";
    return withMilestones({
      schemaVersion: "OwlCodaRunKitHumanStatusV1",
      status: "projected",
      overall,
      headline: headlineFor(overall, inspected.recovery.nextAllowedAction, null),
      stage: overall === "closed" ? "closeout" : "setup",
      currentExecutionId: null,
      completedSteps: overall === "closed" ? ["execution_closed"] : [],
      remainingGates: [],
      remainingGateCount: 0,
      control: { status: "healthy", issueCodes: [] },
      nextAllowedAction: inspected.recovery.nextAllowedAction,
      authorizationGranted: false,
      gitAuthorization: false,
      releaseAuthorization: false,
      deployAuthorization: false,
    }, inspected);
  }

  if (inspected.recovery.state === "multiple_active_executions") {
    return withMilestones(blockedProjection({
      headline: "Multiple active executions require an explicit selection.",
      controlStatus: "healthy",
      issueCodes: ["multiple_active_executions"],
      nextAllowedAction: "select_active_execution",
      gateCode: "select_active_execution",
      gateLabel: "Select the execution to continue.",
    }), inspected);
  }

  const selected = inspected.executions.find(execution =>
    execution.runId === inspected.recovery.selectedRunId);
  if (
    inspected.recovery.state !== "single_active_execution"
    || !selected
    || selected.lifecycle === "closed"
  ) {
    return withMilestones(blockedProjection({
      headline: "Inspect execution selection is inconsistent.",
      controlStatus: "invalid",
      issueCodes: ["inspect_truth_inconsistent"],
      nextAllowedAction: "rerun_inspect",
      gateCode: "restore_consistent_inspect_truth",
      gateLabel: "Rerun inspect and repair inconsistent execution truth.",
    }), inspected);
  }

  const action = inspected.recovery.nextAllowedAction;
  const blocked = action === "repair_execution_artifacts"
    || action === "replace_delivery_packet";
  const readyForCloseout = action === "release_writer_lease"
    || action === "close_execution";
  const overall = blocked
    ? "blocked"
    : readyForCloseout
      ? "ready_for_closeout"
      : "working";
  const gates = [{
    code: action,
    label: action.replaceAll("_", " "),
    nextAllowedAction: action,
  }];
  const selectedIssues = (selected.recovery?.issues ?? []).map(issueCode);
  return withMilestones({
    schemaVersion: "OwlCodaRunKitHumanStatusV1",
    status: "projected",
    overall,
    headline: headlineFor(overall, action, selected.runId),
    stage: stageForAction(action),
    currentExecutionId: selected.runId,
    completedSteps: completedSteps(selected),
    remainingGates: gates,
    remainingGateCount: gates.length,
    control: {
      status: selectedIssues.length > 0 ? "invalid" : "healthy",
      issueCodes: selectedIssues,
    },
    nextAllowedAction: action,
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
    deployAuthorization: false,
  }, inspected);
}
