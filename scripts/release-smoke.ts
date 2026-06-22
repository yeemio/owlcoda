/**
 * Release Smoke Runner CLI (0.14.24)
 *
 * Usage:
 *   npx tsx scripts/release-smoke.ts
 *   npx tsx scripts/release-smoke.ts --case=readonly-review
 *   npx tsx scripts/release-smoke.ts --json
 *   npx tsx scripts/release-smoke.ts --case=deck-12p --json
 *
 * Exit codes:
 *   0 — all cases passed or cleanly skipped (no mock trajectory)
 *   1 — any case failed, or any case that has a mockResponseSequence was skipped unexpectedly
 */

import { isBenchmarkCaseId, BENCHMARK_CASE_IDS } from '../src/benchmark/index.js'
import { runBenchmarkCaseLive, runBenchmarkSuiteLive } from '../src/benchmark/runner.js'
import type { LiveBenchmarkResult } from '../src/benchmark/runner.js'
import { createConversation } from '../src/native/conversation.js'
import { auditRuntimeEventSessions, runtimeEventAuditHasFailures } from '../src/native/runtime-event-audit.js'
import type { RuntimeEventAuditReport } from '../src/native/runtime-event-audit.js'
import { appendRuntimeEvent } from '../src/native/runtime-events.js'
import { listSessions } from '../src/native/session.js'
import type { SessionFile } from '../src/native/session.js'

const RUNTIME_EVENT_AUDIT_CASE_ID = 'runtime-event-audit'

interface RuntimeEventAuditSmokeResult {
  caseId: typeof RUNTIME_EVENT_AUDIT_CASE_ID
  kind: typeof RUNTIME_EVENT_AUDIT_CASE_ID
  ranLive: true
  passed: boolean
  audit: RuntimeEventAuditReport
  currentRuntimeContractProbe: CurrentRuntimeContractProbe
}

interface CurrentRuntimeContractProbe {
  passed: boolean
  event_count: number
  contract_valid: number
  legacy_replay_compatible: number
  malformed_saved_event: number
  event_kinds: string[]
}

type ReleaseSmokeResult = LiveBenchmarkResult | RuntimeEventAuditSmokeResult

function parseArgs(): { caseId: string | null; jsonMode: boolean } {
  const args = process.argv.slice(2)
  let caseId: string | null = null
  let jsonMode = false

  for (const arg of args) {
    if (arg.startsWith('--case=')) {
      caseId = arg.slice('--case='.length)
    } else if (arg === '--json') {
      jsonMode = true
    }
  }

  return { caseId, jsonMode }
}

function resultSummaryLine(r: ReleaseSmokeResult): string {
  if (isRuntimeEventAuditSmokeResult(r)) {
    const totals = r.audit.totals
    const probe = r.currentRuntimeContractProbe
    const summary = `sessions=${r.audit.sessions_scanned} events=${totals.event_count} legacy=${totals.legacy_replay_compatible} malformed=${totals.malformed_saved_event} currentValid=${probe.contract_valid}/${probe.event_count}`
    if (r.passed) {
      return `  PASS  ${r.caseId}  (${summary})`
    }
    const failedSessions = r.audit.sessions
      .filter((session) => session.status === 'failed')
      .map((session) => `${session.id}:malformed=${session.diagnostics.malformed_event_count}`)
      .join(', ')
    return `  FAIL  ${r.caseId}  (${summary})${failedSessions ? ` ${failedSessions}` : ''}`
  }
  if (!r.ranLive) {
    return `  SKIP  ${r.caseId}  (${r.skippedReason ?? 'no mock'})`
  }
  if (r.passed) {
    return `  PASS  ${r.caseId}`
  }
  const problems: string[] = []
  if (r.diff?.finalStatusMismatch) {
    problems.push(`finalStatus: expected=${r.diff.finalStatusMismatch.expected} actual=${r.diff.finalStatusMismatch.actual}`)
  }
  if (r.diff?.taskNoProgressMismatch) {
    const e = r.diff.taskNoProgressMismatch.expected
    const a = r.diff.taskNoProgressMismatch.actual
    problems.push(`taskNoProgress: expected={hard:${e.hard},suppressed:${e.suppressed}} actual={hard:${a.hard},suppressed:${a.suppressed}}`)
  }
  if (r.diff?.artifactMismatches && r.diff.artifactMismatches.length > 0) {
    problems.push(`missing artifacts: ${r.diff.artifactMismatches.map((m) => m.path).join(', ')}`)
  }
  if (r.diff?.timeToFirstWriteToleranceExceeded) {
    const t = r.diff.timeToFirstWriteToleranceExceeded
    problems.push(`timeToFirstWriteMs out of tolerance: expected=${t.expected} actual=${t.actual} tolerance=±${t.toleranceMs}`)
  }
  return `  FAIL  ${r.caseId}  ${problems.join(' | ')}`
}

function isRuntimeEventAuditSmokeResult(result: ReleaseSmokeResult): result is RuntimeEventAuditSmokeResult {
  return (result as RuntimeEventAuditSmokeResult).kind === RUNTIME_EVENT_AUDIT_CASE_ID
}

function runRuntimeEventAuditReleaseCheck(): RuntimeEventAuditSmokeResult {
  const audit = auditRuntimeEventSessions(listSessions())
  const currentRuntimeContractProbe = runCurrentRuntimeContractProbe()
  return {
    caseId: RUNTIME_EVENT_AUDIT_CASE_ID,
    kind: RUNTIME_EVENT_AUDIT_CASE_ID,
    ranLive: true,
    passed: !runtimeEventAuditHasFailures(audit) && currentRuntimeContractProbe.passed,
    audit,
    currentRuntimeContractProbe,
  }
}

function runCurrentRuntimeContractProbe(): CurrentRuntimeContractProbe {
  const conversation = createConversation({
    system: 'release smoke runtime event contract probe',
    model: 'mimo-v2.5-pro',
  })
  const turnId = 'release-smoke-runtime-event-contract-turn'
  const itemId = 'release-smoke-runtime-event-contract-item'

  appendRuntimeEvent(conversation, {
    kind: 'turn_started',
    turnId,
  })
  appendRuntimeEvent(conversation, {
    kind: 'assistant_stream_recorded',
    turnId,
    payload: {
      response_index: 1,
      source: 'sse',
      text_delta_count: 1,
      text_chars: 0,
      thinking_start_count: 0,
      thinking_delta_count: 0,
      thinking_chars: 0,
      thinking_end_count: 0,
      usage_update_count: 1,
      input_tokens: 1,
      output_tokens: 1,
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'assistant_response_recorded',
    turnId,
    payload: {
      response_index: 1,
      phase: 'main',
      stop_reason: 'tool_use',
      text_chars: 0,
      text_digest: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      tool_use_count: 1,
      has_tool_use: true,
      thinking_block_count: 0,
      input_tokens: 1,
      output_tokens: 1,
      is_empty_response: false,
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'assistant_response_disposition_recorded',
    turnId,
    payload: {
      response_index: 1,
      phase: 'main',
      action: 'execute_tools',
      stop_reason: 'tool_use',
      text_chars: 0,
      original_tool_use_count: 1,
      executed_tool_count: 1,
      deferred_tool_count: 0,
      runtime_tool_count: 0,
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'runtime_intervention',
    turnId,
    checkpointId: 'release-smoke-runtime-event-contract-checkpoint',
    checkpointKind: 'long_task_checkpoint',
    payload: {
      intervention_kind: 'recovery_guard_hard_stop',
      action: 'hard_stop',
      guard_kind: 'long_task_checkpoint',
      gate_kind: 'long_task_checkpoint',
      stop_reason: 'tool_loop',
      ignored_tool_count: 1,
      response_index: 1,
      reason: 'release smoke guard hard-stop probe',
      checkpoint_id: 'release-smoke-runtime-event-contract-checkpoint',
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'runtime_intervention',
    turnId,
    itemId: 'release-smoke-long-task-wait-policy-item',
    payload: {
      intervention_kind: 'long_task_wait_policy',
      action: 'skipped_tool_use',
      tool_use_id: 'release-smoke-long-task-wait-policy-item',
      tool_name: 'Sleep',
      violation_kind: 'sleep_polling',
      long_task_id: 'task:release-smoke-long-task',
      wait_strategy: 'runtime_await',
      stop_polling: false,
      next_check_command: 'LongTaskAwait longTaskId=task:release-smoke-long-task timeoutMs=5000',
      reason: 'release smoke wait-policy probe',
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'runtime_intervention',
    turnId,
    itemId: 'release-smoke-post-recovery-overrun-item',
    checkpointId: 'release-smoke-verification-repair-checkpoint',
    checkpointKind: 'verification_repair_checkpoint',
    payload: {
      intervention_kind: 'post_recovery_overrun_guard',
      action: 'skipped_redundant_task_update',
      tool_use_id: 'release-smoke-post-recovery-overrun-item',
      tool_name: 'TaskUpdate',
      task_id: 'release-smoke-task',
      step_id: 'release-smoke-step',
      checkpoint_id: 'release-smoke-verification-repair-checkpoint',
      requested_status_field: 'stepStatus',
      requested_status: 'completed',
      ledger_status: 'clean',
      recovery_resolved_this_run: true,
      scope: 'task release-smoke-task step release-smoke-step',
      reason: 'release smoke post-recovery overrun probe',
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'runtime_intervention',
    turnId,
    checkpointId: 'release-smoke-runtime-truth-resume-checkpoint',
    checkpointKind: 'context_replacement_checkpoint',
    payload: {
      intervention_kind: 'runtime_truth_resume_report_gate',
      action: 'replaced_incomplete_report_with_synthetic_report',
      report_source: 'runtime_synthetic',
      original_report_source: 'assistant_text',
      checkpoint_id: 'release-smoke-runtime-truth-resume-checkpoint',
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'item_started',
    turnId,
    itemId,
    payload: {
      tool_name: 'ReleaseSmokeProbe',
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'item_completed',
    turnId,
    itemId,
    payload: {
      tool_name: 'ReleaseSmokeProbe',
      is_error: false,
    },
  })
  appendRuntimeEvent(conversation, {
    kind: 'turn_completed',
    turnId,
    payload: {
      iterations: 1,
      request_count: 1,
      input_tokens: 1,
      output_tokens: 1,
      assistant_response_count: 1,
      assistant_text_chars: 12,
      final_text_chars: 12,
      tool_use_count: 1,
      executed_tool_count: 1,
      empty_response_count: 0,
    },
  })

  const events = conversation.options?.runtimeEventLog?.events ?? []
  const probeSession: SessionFile = {
    version: 1,
    id: `${conversation.id}-runtime-event-contract-probe`,
    model: conversation.model,
    system: conversation.system,
    maxTokens: conversation.maxTokens,
    turns: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    runtimeEventLog: conversation.options?.runtimeEventLog,
  }
  const audit = auditRuntimeEventSessions([probeSession])
  const totals = audit.totals
  return {
    passed: totals.event_count === 11
      && totals.contract_valid === 11
      && totals.legacy_replay_compatible === 0
      && totals.malformed_saved_event === 0,
    event_count: totals.event_count,
    contract_valid: totals.contract_valid,
    legacy_replay_compatible: totals.legacy_replay_compatible,
    malformed_saved_event: totals.malformed_saved_event,
    event_kinds: events.map((event) => event.kind),
  }
}

async function main(): Promise<void> {
  const { caseId, jsonMode } = parseArgs()

  let results: ReleaseSmokeResult[]

  if (caseId !== null) {
    if (caseId === RUNTIME_EVENT_AUDIT_CASE_ID) {
      results = [runRuntimeEventAuditReleaseCheck()]
    } else if (isBenchmarkCaseId(caseId)) {
      results = [await runBenchmarkCaseLive(caseId)]
    } else {
      console.error(`Unknown case id: ${caseId}. Valid ids: ${[...BENCHMARK_CASE_IDS, RUNTIME_EVENT_AUDIT_CASE_ID].join(', ')}`)
      process.exitCode = 1
      return
    }
  } else {
    results = [
      ...(await runBenchmarkSuiteLive()),
      runRuntimeEventAuditReleaseCheck(),
    ]
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify(results, null, 2) + '\n')
  } else {
    console.log('\nOwlCoda Release Smoke Runner\n')
    for (const r of results) {
      console.log(resultSummaryLine(r))
    }
    console.log()
  }

  const failed = results.filter((r) => r.ranLive && !r.passed)
  const cleanSkips = results.filter((r) => !r.ranLive)

  if (!jsonMode) {
    console.log(`${results.filter((r) => r.ranLive && r.passed).length} passed, ${failed.length} failed, ${cleanSkips.length} skipped`)
  }

  if (failed.length > 0) {
    process.exitCode = 1
    return
  }

  process.exitCode = 0
}

main().catch((err: unknown) => {
  console.error('Smoke runner fatal:', err)
  process.exit(1)
})
