function latestIndexedCloseout(executions) {
  return [...executions].reverse().find(execution => execution.lifecycle === "closed") ?? null;
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
    ? latestIndexedCloseout(inspected.executions)
    : null;
}

export function buildInspectSummary(inspected) {
  const focus = selectedFocus(inspected);
  const latestClosed = latestIndexedCloseout(inspected.executions);
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
    latestIndexedCloseout: latestClosed
      ? {
          runId: latestClosed.runId,
          decision: latestClosed.closeout?.decision ?? "invalid",
          trustLevel: latestClosed.recovery?.evidenceTrustLevel ?? "invalid",
        }
      : null,
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
      code: inspected.recovery.nextAllowedAction,
      reasons: [...reasons],
    },
    nextAllowedAction: inspected.recovery.nextAllowedAction,
    authorizationGranted: false,
    gitAuthorization: false,
    releaseAuthorization: false,
  };
}

function value(value) {
  if (value === null || value === undefined || value === "") return "none";
  return String(value);
}

function summaryLines(summary) {
  const latest = summary.latestIndexedCloseout
    ? `${summary.latestIndexedCloseout.runId} ${summary.latestIndexedCloseout.decision}`
    : "none";
  const visibleHolders = summary.leases.holders.slice(0, 5)
    .map(holder => `${holder.runId}/${holder.workItemId}`);
  const holders = visibleHolders.length === 0
    ? "none"
    : `${visibleHolders.join(", ")}${summary.leases.holders.length > visibleHolders.length
      ? ` (+${summary.leases.holders.length - visibleHolders.length} more)`
      : ""}`;
  return [
    `Current execution: ${value(summary.currentExecution.selectedRunId)}`,
    `Latest indexed closeout: ${latest}`,
    `Source status: ${summary.source.status}`,
    `Active leases: ${summary.leases.activeCount}`,
    `Lease holders: ${holders}`,
    `Open executions: ${summary.currentExecution.openCount}`,
    `Evidence: ${summary.evidence.status}`,
    `Resource preflight: ${summary.resourcePreflight.status}`,
    `Model estimate: ${summary.resourcePreflight.estimate.calls} calls, ${summary.resourcePreflight.estimate.totalTokens} tokens`,
    `Model cost: ${summary.resourcePreflight.estimate.cost.status === "known"
      ? `$${summary.resourcePreflight.estimate.cost.valueUsd}`
      : "unknown"}`,
    `Receipt reuse: ${summary.resourcePreflight.receiptReuse.appliedCount}/${summary.resourcePreflight.receiptReuse.reusableCount}`,
    `Dominant gap: ${summary.dominantGap.code}`,
    `Next allowed action: ${summary.nextAllowedAction}`,
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
  return `${summaryLines(inspected.summary).join("\n")}\n`;
}
