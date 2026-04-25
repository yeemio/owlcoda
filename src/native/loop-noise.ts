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

  if (/^Context compacted:/i.test(message) || /^Context limit hit/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: {
        ...state,
        compactionCount: state.compactionCount + 1,
      },
    }
  }

  if (/^Task contract:/i.test(message)) {
    return {
      footerNotice: dim(message),
      transcriptEntry: null,
      nextState: state,
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
  if (state.repairCount > 0) {
    lines.push(formatPlatformEvent('session', 'Repaired dangling tool history before continuing'))
  }
  if (state.compactionCount > 0) {
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
