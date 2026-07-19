import { dim } from './tui/colors.js'
import { formatPlatformEvent, type PlatformEventKind } from './tui/message.js'

export interface LoopNoiseState {
  trimCount: number
  nudgeCount: number
  repairCount: number
  summaryGateCount: number
  compactionCount: number
  targetedCheckCount: number
  synthesisCount: number
  fallbackSynthesisCount: number
  hardStopCount: number
  constrainedContinuationCount: number
  hygieneResultCount?: number
  hygieneOmittedChars?: number
}

export interface RoutedConversationNotice {
  footerNotice: string | null
  transcriptEntry: string | null
  nextState: LoopNoiseState
  /**
   * Tri-state phase transition signal. Discriminate with `!== undefined`, NOT truthy-check.
   *   absent  → preserve current frontend phase (footer-only noise: Loop budget, Nudge, Summary gate, Conv repair, Context compacted)
   *   null    → explicit clear to default (Constrained continuation reopens exploration)
   *   value   → set phase (Targeted check, Synthesis phase, Fallback synthesis, Hard stop)
   * Loop budget / Summary gate can fire mid-synthesis; a truthy check would flicker the UI back to default during "Synthesizing final answer".
   */
  workflowPhase?: 'targeted_check' | 'synthesizing' | 'fallback_synthesizing' | 'hard_stop' | null
}

export function routeConversationNotice(
  message: string,
  state: LoopNoiseState,
): RoutedConversationNotice {
  if (/^Task contract:/i.test(message)) {
    // Emitted once per runConversationTurn. Show as a dim footer banner so the user can see the
    // active write scope, but never write it to the transcript — otherwise N turns produces N
    // identical banners that pollute scrollback and consume context budget.
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: state,
    }
  }

  if (/^Loop budget:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        trimCount: state.trimCount + 1,
      },
    }
  }

  if (/^Nudge:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        nudgeCount: state.nudgeCount + 1,
      },
    }
  }

  if (/^Summary gate:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        summaryGateCount: state.summaryGateCount + 1,
      },
    }
  }

  if (/^Conversation repair:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        repairCount: state.repairCount + 1,
      },
    }
  }

  if (/^Max-tokens continuation /i.test(message)) {
    // 0.13.64: stop_reason=max_tokens continuation nudge fired. Same
    // routing pattern as Output bloat — footer + transcript so
    // operators see it; shares compactionCount with other context-
    // management events.
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
      },
    }
  }

  if (/^Output bloat /i.test(message)) {
    // 0.13.63 (D): output-bloat nudge fired. Same routing pattern as
    // Context pressure — footer + transcript so operators see it,
    // shares compactionCount counter with other context-management
    // events.
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
      },
    }
  }

  if (/^Heap pressure compaction:/i.test(message)) {
    // 0.13.62: heap-pressure emergency compact event. OOM-defense
    // sibling of token-window compact; same routing (footer +
    // transcript), shares compactionCount counter.
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
      },
    }
  }

  if (/^Production gate:/i.test(message)) {
    // 0.13.70 execution_economics_v1 — production_gate_v1 inject
    // event. The model receives the actual runtime nudge in its prompt;
    // users only need a transient status hint, not a scrollback entry.
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
      },
    }
  }

  if (/^Context pressure /i.test(message)) {
    // 0.13.58: high-context discipline nudge fired. Same routing as
    // compact — transcript line so operators see it, plus footer
    // banner. Reuses compactionCount as the rollup counter (both are
    // "context-management events").
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
      },
    }
  }

  if (/^Context compacted:/i.test(message) || /^Context limit hit/i.test(message)) {
    // Keep compaction visible as a footer status but out of transcript
    // scrollback. The durable truth now lives in runtime recovery/checkpoint
    // ledgers; repeating compaction lines in chat made long tasks read noisy.
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
      },
    }
  }

  const hygieneMatch = message.match(/^Context hygiene: compacted (\d+) older tool results?, omitting (\d+) characters/i)
  if (hygieneMatch) {
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
        hygieneResultCount: (state.hygieneResultCount ?? 0) + Number(hygieneMatch[1]),
        hygieneOmittedChars: (state.hygieneOmittedChars ?? 0) + Number(hygieneMatch[2]),
      },
    }
  }

  if (/^Targeted check:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        targetedCheckCount: state.targetedCheckCount + 1,
      },
      workflowPhase: 'targeted_check',
    }
  }

  if (/^Synthesis phase:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        synthesisCount: state.synthesisCount + 1,
      },
      workflowPhase: 'synthesizing',
    }
  }

  if (/^Fallback synthesis:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        fallbackSynthesisCount: state.fallbackSynthesisCount + 1,
      },
      workflowPhase: 'fallback_synthesizing',
    }
  }

  if (/^Hard stop:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        hardStopCount: state.hardStopCount + 1,
      },
      workflowPhase: 'hard_stop',
    }
  }

  if (/^Constrained continuation:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: formatPlatformEvent('session', message),
      nextState: {
        ...state,
        constrainedContinuationCount: state.constrainedContinuationCount + 1,
      },
      workflowPhase: null, // explicit clear — reopening exploration
    }
  }

  // ---------------------------------------------------------------------------
  // Model-internal prompting nudges (footer-only).
  //
  // Each entry below is a runtime nudge whose target audience is the *model*,
  // not the user. They tell the model things like "you said you're done but
  // haven't called DeliveryAudit", "there are still open required task steps",
  // "the task plan needs to be re-centered", etc. The user seeing them in the
  // scrollback is pure noise — they can't act on the message, and the model
  // already received the equivalent system_reminder injection in its prompt.
  //
  // Routing pattern: footer banner only (dim, transient), no transcript entry,
  // no counter mutation. Pre-2026-05-27 these fell through to the default
  // formatPlatformEvent path and polluted user-visible transcript.
  // ---------------------------------------------------------------------------

  if (/^Task-step nudge /i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  if (/^Continue-while-open:/i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  if (/^Delivery check:/i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  // Order matters: check the "check" variant before the bare "Probe coverage:" so
  // a pre-summary nudge doesn't get mis-routed as a post-turn satisfaction note.
  if (/^Probe coverage check:/i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  if (/^Probe coverage:/i.test(message)) {
    // Post-turn satisfaction note ("X, Y satisfied by this turn's tool calls"),
    // not a nudge — but still model-internal observability and not actionable
    // for the user.
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  if (/^task no-progress suppressed /i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  if (/^Summary gate still pending /i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  if (/^Task realign:/i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  if (/^Artifact repair:/i.test(message)) {
    return { footerNotice: dim(message), transcriptEntry: null, nextState: state }
  }

  const kind: PlatformEventKind = /router|fallback/i.test(message)
    ? 'router'
    : 'session'

  return {
    footerNotice: null,
    transcriptEntry: formatPlatformEvent(kind, message),
    nextState: state,
  }
}

export function summarizeLoopNoise(state: LoopNoiseState): string[] {
  const lines: string[] = []

  if (state.trimCount > 0) {
    lines.push(formatPlatformEvent('session', `Loop budget trimmed older tool results ${state.trimCount}× during this turn`))
  }
  if (state.nudgeCount > 0) {
    lines.push(formatPlatformEvent('session', 'Prompted the model to produce a text summary after tool-only loops'))
  }
  if (state.summaryGateCount > 0) {
    lines.push(formatPlatformEvent('session', 'Runtime paused additional file-discovery tools until the assistant summarized'))
  }
  // Conversation repair is an internal request-shape cleanup. Showing a
  // durable transcript line for it after every failed resend makes recovery
  // look worse than the underlying provider error, so it stays footer-only.
  if ((state.hygieneResultCount ?? 0) > 0) {
    lines.push(formatPlatformEvent(
      'session',
      `Context hygiene compacted ${state.hygieneResultCount} tool results, freed ~${formatApproxChars(state.hygieneOmittedChars ?? 0)} characters`,
    ))
  } else if (state.compactionCount > 0) {
    lines.push(formatPlatformEvent('session', 'Context compaction ran in the background during this turn'))
  }
  if (state.targetedCheckCount > 0) {
    lines.push(formatPlatformEvent('session', 'Runtime narrowed exploration to one final targeted verification'))
  }
  if (state.constrainedContinuationCount > 0) {
    lines.push(formatPlatformEvent('session', 'Runtime reopened exploration after a constrained continuation produced new evidence'))
  }
  if (state.synthesisCount > 0) {
    lines.push(formatPlatformEvent('session', 'Runtime moved the task into synthesis mode'))
  }
  if (state.fallbackSynthesisCount > 0) {
    lines.push(formatPlatformEvent('session', 'Runtime retried with a tighter fallback synthesis packet'))
  }
  if (state.hardStopCount > 0) {
    lines.push(formatPlatformEvent('session', 'Runtime reached a hard stop after synthesis could not be recovered'))
  }

  return lines
}

function formatApproxChars(value: number): string {
  if (value < 1000) return String(value)
  const thousands = Math.round(value / 100) / 10
  return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`
}
