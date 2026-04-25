import { describe, expect, it } from 'vitest'
import { routeConversationNotice, summarizeLoopNoise } from '../../src/native/loop-noise.js'

const baseState = {
  trimCount: 0,
  nudgeCount: 0,
  repairCount: 0,
  summaryGateCount: 0,
  compactionCount: 0,
  targetedCheckCount: 0,
  synthesisCount: 0,
  fallbackSynthesisCount: 0,
  hardStopCount: 0,
  constrainedContinuationCount: 0,
}

describe('loop-noise routing', () => {
  it('suppresses repeated loop budget notices into footer state', () => {
    const routed = routeConversationNotice(
      'Loop budget: trimmed older tool results (24211 → 18911 est. tokens)',
      baseState,
    )

    expect(routed.transcriptEntry).toBeNull()
    expect(routed.footerNotice).toContain('Loop budget: trimmed older tool results')
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual({ ...baseState, trimCount: 1 })
  })

  it('suppresses nudge notices into footer state', () => {
    const routed = routeConversationNotice(
      'Nudge: requesting text summary after 3 consecutive tool-only turns',
      { ...baseState, trimCount: 2 },
    )

    expect(routed.transcriptEntry).toBeNull()
    expect(routed.footerNotice).toContain('Nudge: requesting text summary')
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual({ ...baseState, trimCount: 2, nudgeCount: 1 })
  })

  it('suppresses summary gate notices into footer state', () => {
    const routed = routeConversationNotice(
      'Summary gate: batched 4 exploratory tools and deferred 2 more until the assistant summarizes',
      baseState,
    )

    expect(routed.transcriptEntry).toBeNull()
    expect(routed.footerNotice).toContain('Summary gate:')
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual({ ...baseState, summaryGateCount: 1 })
  })

  it('suppresses repair notices into footer state', () => {
    const routed = routeConversationNotice(
      'Conversation repair: cleaned orphaned tool calls from saved history',
      baseState,
    )

    expect(routed.transcriptEntry).toBeNull()
    expect(routed.footerNotice).toContain('Conversation repair:')
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual({ ...baseState, repairCount: 1 })
  })

  it('surfaces targeted-check transitions in transcript and footer', () => {
    const routed = routeConversationNotice(
      'Targeted check: Still missing one focused point: inspect conversation.ts truncation handling. scanned 8 sources across 2 exploratory batches, 2 requests, 18s, and 8 relevant signals',
      baseState,
    )

    expect(routed.footerNotice).toContain('Targeted check:')
    expect(routed.transcriptEntry).toContain('Targeted check:')
    expect(routed.workflowPhase).toBe('targeted_check')
    expect(routed.nextState).toEqual({ ...baseState, targetedCheckCount: 1 })
  })

  it('surfaces synthesis transitions in transcript and footer', () => {
    const routed = routeConversationNotice(
      'Synthesis phase: scanned 9 sources across 3 exploratory batches, 4 requests, 29s, and 11 relevant signals',
      { ...baseState, targetedCheckCount: 1 },
    )

    expect(routed.footerNotice).toContain('Synthesis phase:')
    expect(routed.transcriptEntry).toContain('Synthesis phase:')
    expect(routed.workflowPhase).toBe('synthesizing')
    expect(routed.nextState).toEqual({ ...baseState, targetedCheckCount: 1, synthesisCount: 1 })
  })

  it('surfaces fallback synthesis transitions in transcript and footer', () => {
    const routed = routeConversationNotice(
      'Fallback synthesis: the synthesis response came back empty; retrying with a tighter evidence packet',
      { ...baseState, synthesisCount: 1 },
    )

    expect(routed.footerNotice).toContain('Fallback synthesis:')
    expect(routed.transcriptEntry).toContain('Fallback synthesis:')
    expect(routed.workflowPhase).toBe('fallback_synthesizing')
    expect(routed.nextState).toEqual({ ...baseState, synthesisCount: 1, fallbackSynthesisCount: 1 })
  })

  it('surfaces hard-stop notices distinctly from synthesis', () => {
    const routed = routeConversationNotice(
      'Hard stop: fallback synthesis could not produce a usable final answer',
      { ...baseState, synthesisCount: 1, fallbackSynthesisCount: 1 },
    )

    expect(routed.footerNotice).toContain('Hard stop:')
    expect(routed.transcriptEntry).toContain('Hard stop:')
    expect(routed.workflowPhase).toBe('hard_stop')
    expect(routed.nextState).toEqual({ ...baseState, synthesisCount: 1, fallbackSynthesisCount: 1, hardStopCount: 1 })
  })

  it('routes Constrained continuation to footer + transcript and explicitly clears workflowPhase', () => {
    const routed = routeConversationNotice(
      'Constrained continuation: focused verification produced new evidence, so the runtime reopened exploration. (1 / 3)',
      { ...baseState, targetedCheckCount: 1 },
    )

    expect(routed.footerNotice).toContain('Constrained continuation:')
    expect(routed.transcriptEntry).toContain('Constrained continuation:')
    expect(routed.workflowPhase).toBeNull() // explicit clear, distinct from undefined
    expect(routed.nextState).toEqual({
      ...baseState,
      targetedCheckCount: 1,
      constrainedContinuationCount: 1,
    })
  })

  it('distinguishes "preserve phase" (undefined) from "clear phase" (null) in returned shape', () => {
    const preserved = routeConversationNotice('Loop budget: trimmed older tool results (100 → 80 est. tokens)', baseState)
    const cleared = routeConversationNotice('Constrained continuation: reopened exploration.', baseState)

    expect('workflowPhase' in preserved).toBe(false) // absent = preserve
    expect(cleared.workflowPhase).toBeNull()          // present-null = clear
  })

  it('keeps non-loop notices in the transcript as platform events', () => {
    const routed = routeConversationNotice(
      'Router fallback: minimax-m27 → kimi-k2',
      { ...baseState, trimCount: 1, nudgeCount: 1 },
    )

    expect(routed.footerNotice).toBeNull()
    expect(routed.transcriptEntry).toContain('Router fallback')
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual({ ...baseState, trimCount: 1, nudgeCount: 1 })
  })

  it('summarizes suppressed loop noise once per turn', () => {
    const summary = summarizeLoopNoise({
      ...baseState,
      trimCount: 3,
      nudgeCount: 1,
      repairCount: 1,
      summaryGateCount: 1,
      compactionCount: 1,
      targetedCheckCount: 1,
      synthesisCount: 1,
      fallbackSynthesisCount: 1,
      hardStopCount: 1,
    })

    expect(summary).toHaveLength(9)
    expect(summary[0]).toContain('Loop budget trimmed older tool results 3× during this turn')
    expect(summary[1]).toContain('Prompted the model to produce a text summary after tool-only loops')
    expect(summary[2]).toContain('Runtime paused additional file-discovery tools until the assistant summarized')
    expect(summary[3]).toContain('Repaired dangling tool history before continuing')
    expect(summary[4]).toContain('Context compaction ran in the background during this turn')
    expect(summary[5]).toContain('Runtime narrowed exploration to one final targeted verification')
    expect(summary[6]).toContain('Runtime moved the task into synthesis mode')
    expect(summary[7]).toContain('Runtime retried with a tighter fallback synthesis packet')
    expect(summary[8]).toContain('Runtime reached a hard stop after synthesis could not be recovered')
  })

  it('summarizes constrained continuation alongside other counters', () => {
    const summary = summarizeLoopNoise({
      ...baseState,
      targetedCheckCount: 1,
      constrainedContinuationCount: 1,
      synthesisCount: 1,
    })

    expect(summary).toHaveLength(3)
    const joined = summary.join('\n')
    expect(joined).toContain('Runtime narrowed exploration to one final targeted verification')
    expect(joined).toContain('Runtime reopened exploration after a constrained continuation')
    expect(joined).toContain('Runtime moved the task into synthesis mode')
  })
})
