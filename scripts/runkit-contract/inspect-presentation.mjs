import {
  deriveHumanStatusFromInspectV1,
  selectClosedHistoryFocusV1,
} from "./human-status.mjs";

function chronologySelectedCloseout(inspected) {
  return selectClosedHistoryFocusV1(inspected).selectedExecution;
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeHumanControls(input) {
  return String(input).replace(/[\u0000-\u001f\u007f-\u009f]/g, character => (
    `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`
  ));
}

function selectedFocus(inspected) {
  const selectedRunId = inspected.recovery.selectedRunId;
  if (selectedRunId) {
    return inspected.executions.find(execution => execution.runId === selectedRunId) ?? null;
  }
  return inspected.recovery.state === "no_active_execution"
    ? chronologySelectedCloseout(inspected)
    : null;
}

function closeoutDecisionCounts(inspected) {
  const counts = { accepted: 0, blocked: 0, rejected: 0 };
  for (const execution of inspected.executions) {
    if (execution.lifecycle !== "closed") continue;
    if (Object.hasOwn(counts, execution.closeout?.decision)) {
      counts[execution.closeout.decision] += 1;
    }
  }
  return counts;
}

export function buildInspectSummary(
  inspected,
  { maintenanceNextAction = null } = {},
) {
  const humanStatus = deriveHumanStatusFromInspectV1(inspected);
  const focus = selectedFocus(inspected);
  const latestClosed = chronologySelectedCloseout(inspected);
  const controlHistory = inspected.controlState?.closedHistory ?? null;
  const closedRunCount = inspected.executions.filter(
    (execution) => execution.lifecycle === "closed",
  ).length;
  const independentHistory = controlHistory?.status
    === "multiple_independent_closed_histories"
    && controlHistory?.blocking === false;
  const selectedHeadCloseout = latestClosed
    ? {
        runId: latestClosed.runId,
        decision: latestClosed.closeout?.decision ?? "invalid",
        trustLevel: latestClosed.recovery?.evidenceTrustLevel ?? "invalid",
      }
    : null;
  const holders = inspected.executions
    .flatMap(execution => (execution.recovery?.lease?.activeWorkItemIds ?? []).map(workItemId => ({
      runId: execution.runId,
      workItemId,
    })))
    .sort((left, right) => compareCodeUnits(
      `${left.runId}/${left.workItemId}`,
      `${right.runId}/${right.workItemId}`,
    ));
  const delivery = focus?.recovery?.delivery ?? null;
  const verification = focus?.recovery?.verification ?? null;
  const resource = focus?.recovery?.resourcePreflight ?? { status: "none", selected: null };
  const selectedResource = resource.selected ?? null;
  const reasons = [
    ...(inspected.recovery.state === "multiple_active_executions"
      ? ["Multiple active executions require explicit selection."]
      : (focus?.recovery?.issues ?? [])),
    ...(inspected.configCore?.issues ?? []),
    ...(inspected.controlIssues ?? []),
    ...(selectedResource?.blockers ?? []),
  ].filter((reason, index, all) => all.indexOf(reason) === index);
  return {
    schemaVersion: "OwlCodaRunKitInspectSummaryV1",
    currentExecution: {
      state: inspected.recovery.state,
      selectedRunId: inspected.recovery.selectedRunId,
      activeRunIds: [...inspected.recovery.activeRunIds],
      openCount: inspected.recovery.activeRunIds.length,
    },
    latestIndexedCloseout: selectedHeadCloseout,
    selectedHeadCloseout,
    closedHistory: {
      status: controlHistory?.status ?? "unavailable",
      runCount: closedRunCount,
      blocking: controlHistory?.blocking === true
        || controlHistory?.status === "ambiguous_history",
      selectedHeadRunId: selectedHeadCloseout?.runId ?? null,
      selectionReason: selectedHeadCloseout
        ? "verified_lineage_head"
        : closedRunCount === 0
          ? "no_closed_history"
          : "no_unique_lineage_head",
      decisionCounts: controlHistory?.decisionCounts ?? closeoutDecisionCounts(inspected),
    },
    source: {
      status: delivery?.status ?? "none",
      sourceFingerprint: delivery?.sourceFingerprint ?? verification?.sourceFingerprint ?? null,
    },
    leases: {
      activeCount: holders.length,
      holders,
    },
    evidence: {
      status: verification?.status ?? "none",
      decision: verification?.decision ?? null,
      activeReceiptSha256: verification?.activeReceiptSha256 ?? null,
      trustLevel: focus?.recovery?.evidenceTrustLevel ?? "none",
    },
    resourcePreflight: {
      status: resource.status,
      preflightId: selectedResource?.preflightId ?? null,
      sequence: selectedResource?.sequence ?? null,
      evaluatedAt: selectedResource?.evaluatedAt ?? null,
      validUntil: selectedResource?.validUntil ?? null,
      decision: selectedResource?.status ?? null,
      nextAllowedAction: selectedResource?.nextAllowedAction ?? null,
      blockers: [...(selectedResource?.blockers ?? [])],
      warnings: [...(selectedResource?.warnings ?? [])],
      receiptReuse: selectedResource?.receiptReuse ?? { reusableCount: 0, appliedCount: 0 },
      estimate: selectedResource?.estimate ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        elapsedMs: 0,
        cost: { status: "unknown", knownSubtotalUsd: 0, unknownResources: [] },
      },
      resources: [...(selectedResource?.resources ?? [])],
    },
    dominantGap: {
      code: humanStatus.nextAllowedAction,
      reasons: [...reasons],
    },
    lifecycleNextAction: inspected.recovery.nextAllowedAction,
    maintenanceNextAction,
    optionalReviewAction: independentHistory ? "inspect_closed_history" : null,
    nextAllowedAction: humanStatus.nextAllowedAction,
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
  };
}

function value(value) {
  if (value === null || value === undefined || value === "") return "none";
  return String(value);
}

function summaryLines(summary, humanStatus) {
  const selectedHead = summary.selectedHeadCloseout
    ? `${summary.selectedHeadCloseout.runId} ${summary.selectedHeadCloseout.decision}`
    : `none (${summary.closedHistory.selectionReason})`;
  const visibleHolders = summary.leases.holders.slice(0, 5)
    .map(holder => `${holder.runId}/${holder.workItemId}`);
  const holders = visibleHolders.length === 0
    ? "none"
    : `${visibleHolders.join(", ")}${summary.leases.holders.length > visibleHolders.length
      ? ` (+${summary.leases.holders.length - visibleHolders.length} more)`
      : ""}`;
  return [
    `Status: ${humanStatus.overall}`,
    `Summary: ${humanStatus.headline}`,
    `Current execution: ${value(summary.currentExecution.selectedRunId)}`,
    `Closed history: ${summary.closedHistory.status} (${summary.closedHistory.runCount} runs, ${summary.closedHistory.blocking ? "blocking" : "non-blocking"})`,
    `Selected lineage head: ${selectedHead}`,
    `Source status: ${summary.source.status}`,
    `Source/data readiness: ${humanStatus.milestones.sourceData.status}`,
    `Release package: ${humanStatus.milestones.releasePackage.status}`,
    `Remote/VM write: ${humanStatus.milestones.remoteVmWrite.status}`,
    `Active leases: ${summary.leases.activeCount}`,
    `Lease holders: ${holders}`,
    `Open executions: ${summary.currentExecution.openCount}`,
    `Completed: ${humanStatus.completedSteps.length > 0
      ? humanStatus.completedSteps.join(", ")
      : "none"}`,
    `Remaining gates: ${humanStatus.remainingGateCount}`,
    `Evidence: ${summary.evidence.status}`,
    `Resource preflight: ${summary.resourcePreflight.status}`,
    `Model estimate: ${summary.resourcePreflight.estimate.calls} calls, ${summary.resourcePreflight.estimate.totalTokens} tokens`,
    `Model cost: ${summary.resourcePreflight.estimate.cost.status === "known"
      ? `$${summary.resourcePreflight.estimate.cost.valueUsd}`
      : "unknown"}`,
    `Receipt reuse: ${summary.resourcePreflight.receiptReuse.appliedCount}/${summary.resourcePreflight.receiptReuse.reusableCount}`,
    `Dominant gap: ${summary.dominantGap.code}`,
    `Next allowed action: ${summary.nextAllowedAction}`,
    ...(summary.maintenanceNextAction
      ? [`Maintenance: ${summary.maintenanceNextAction}`]
      : []),
    ...(summary.optionalReviewAction
      ? [`Optional review: ${summary.optionalReviewAction}`]
      : []),
    `Release authorization: ${summary.releaseAuthorization}`,
  ].map(escapeHumanControls);
}

function formatHistory(inspected) {
  const closed = inspected.executions.filter(execution => execution.lifecycle === "closed");
  return [
    "Indexed closeout history",
    ...(closed.length === 0
      ? ["none"]
      : closed.map(execution => [
          execution.runId,
          execution.closeout?.decision ?? "invalid",
          execution.recovery?.evidenceTrustLevel ?? "invalid",
        ].join("  "))),
    "Release authorization: false",
  ].map(escapeHumanControls).join("\n");
}

function formatExecution(execution) {
  const recovery = execution.recovery ?? {};
  const holders = recovery.lease?.activeWorkItemIds ?? [];
  const issues = recovery.issues ?? [];
  return [
    `Execution: ${execution.runId}`,
    `Lifecycle: ${execution.lifecycle}`,
    `Engine pin: ${execution.enginePin?.status ?? "invalid"}`,
    `Lease state: ${recovery.lease?.status ?? "none"}`,
    `Lease holders: ${holders.length > 0 ? holders.join(", ") : "none"}`,
    `Source status: ${recovery.delivery?.status ?? "none"}`,
    `Evidence: ${recovery.verification?.status ?? "none"}`,
    `Trust level: ${recovery.evidenceTrustLevel ?? "invalid"}`,
    `Next allowed action: ${recovery.nextAllowedAction ?? "repair_execution_artifacts"}`,
    `Issues: ${issues.length > 0 ? issues.join(" | ") : "none"}`,
    "Release authorization: false",
  ].map(escapeHumanControls).join("\n");
}

export function formatInspectHuman(inspected) {
  if (inspected.view?.mode === "history") return `${formatHistory(inspected)}\n`;
  if (inspected.view?.mode === "execution") return `${formatExecution(inspected.view.execution)}\n`;
  const humanStatus = deriveHumanStatusFromInspectV1(inspected);
  return `${summaryLines(inspected.summary, humanStatus).join("\n")}\n`;
}
