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
  it('routes Task contract notices to the footer without writing them to the transcript', () => {
    const routed = routeConversationNotice(
      'Task contract: write scope narrowed to 2 task paths (src/native/loop-noise.ts, src/native/task-state.ts).',
      baseState,
    )

    expect(routed.transcriptEntry).toBeNull()
    expect(routed.footerNotice).toContain('Task contract:')
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual(baseState)
  })

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

  it('routes Context compacted notices to the footer without writing them to the transcript', () => {
    const routed = routeConversationNotice(
      'Context compacted: 824K -> 412K tokens; kept 18/36 turns (threshold 800K).',
      baseState,
    )

    expect(routed.footerNotice).toContain('Context compacted:')
    expect(routed.transcriptEntry).toBeNull()
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual({ ...baseState, compactionCount: 1 })
  })

  it('aggregates Context hygiene notices into one turn summary', () => {
    const first = routeConversationNotice(
      'Context hygiene: compacted 1 older tool result, omitting 1800 characters from live context.',
      baseState,
    )
    const second = routeConversationNotice(
      'Context hygiene: compacted 2 older tool results, omitting 3700 characters from live context.',
      first.nextState,
    )

    expect(first.transcriptEntry).toBeNull()
    expect(second.transcriptEntry).toBeNull()
    expect(second.footerNotice).toContain('Context hygiene:')
    const summary = summarizeLoopNoise(second.nextState)
    expect(summary).toHaveLength(1)
    expect(summary[0]).toContain('compacted 3 tool results')
    expect(summary[0]).toContain('~5.5k characters')
  })

  it('routes Production gate notices to the footer without writing them to the transcript', () => {
    const routed = routeConversationNotice(
      'Production gate: 3 distinct files read across 5 iterations under a durable-artifact task with 0 deliverables.',
      baseState,
    )

    expect(routed.footerNotice).toContain('Production gate:')
    expect(routed.transcriptEntry).toBeNull()
    expect(routed.workflowPhase).toBeUndefined()
    expect(routed.nextState).toEqual({ ...baseState, compactionCount: 1 })
  })

  it('routes Max-tokens continuation notices to BOTH footer and transcript (0.13.64)', () => {
    const routed = routeConversationNotice(
      'Max-tokens continuation (1× truncated, inject 1/2): nudging the model to resume from the cut-off point or switch to file-based delivery.',
      baseState,
    )

    expect(routed.footerNotice).toContain('Max-tokens continuation')
    expect(routed.transcriptEntry).toContain('Max-tokens continuation')
    // shares compactionCount counter
    expect(routed.nextState).toEqual({ ...baseState, compactionCount: 1 })
  })

  it('routes Output bloat notices to BOTH footer and transcript (0.13.63)', () => {
    const routed = routeConversationNotice(
      'Output bloat (3× ≥15K chars): nudging the model to stop re-dumping inline content and emit a tool call or specific question.',
      baseState,
    )

    expect(routed.footerNotice).toContain('Output bloat')
    expect(routed.transcriptEntry).toContain('Output bloat')
    // shares compactionCount counter
    expect(routed.nextState).toEqual({ ...baseState, compactionCount: 1 })
  })

  it('routes Heap pressure compaction notices to BOTH footer and transcript (0.13.62)', () => {
    const routed = routeConversationNotice(
      'Heap pressure compaction: heap 82% used, compacted 50 → 10 turns to prevent OOM.',
      baseState,
    )

    expect(routed.footerNotice).toContain('Heap pressure compaction')
    expect(routed.transcriptEntry).toContain('Heap pressure compaction')
    // shares compactionCount counter with token-window compact
    expect(routed.nextState).toEqual({ ...baseState, compactionCount: 1 })
  })

  it('routes Context pressure nudges to BOTH footer and transcript (0.13.58)', () => {
    const routed = routeConversationNotice(
      'Context pressure (60%): nudging the model toward terse, evidence-led replies (now 62% of 1M).',
      baseState,
    )

    expect(routed.footerNotice).toContain('Context pressure (60%)')
    expect(routed.transcriptEntry).toContain('Context pressure (60%)')
    // reuses compactionCount as the rollup counter
    expect(routed.nextState).toEqual({ ...baseState, compactionCount: 1 })
  })

  it('routes Context limit hit notices to the footer without writing them to the transcript', () => {
    const routed = routeConversationNotice(
      'Context limit hit - compacted 36 -> 18 turns, retrying.',
      baseState,
    )

    expect(routed.footerNotice).toContain('Context limit hit')
    expect(routed.transcriptEntry).toBeNull()
    expect(routed.nextState).toEqual({ ...baseState, compactionCount: 1 })
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

    expect(summary).toHaveLength(8)
    expect(summary[0]).toContain('Loop budget trimmed older tool results 3× during this turn')
    expect(summary[1]).toContain('Prompted the model to produce a text summary after tool-only loops')
    expect(summary[2]).toContain('Runtime paused additional file-discovery tools until the assistant summarized')
    expect(summary[3]).toContain('Context compaction ran in the background during this turn')
    expect(summary[4]).toContain('Runtime narrowed exploration to one final targeted verification')
    expect(summary[5]).toContain('Runtime moved the task into synthesis mode')
    expect(summary[6]).toContain('Runtime retried with a tighter fallback synthesis packet')
    expect(summary[7]).toContain('Runtime reached a hard stop after synthesis could not be recovered')
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

describe('loop-noise routing — model-internal prompting nudges (2026-05-27)', () => {
  // These cover the 9 nudge prefixes that pre-2026-05-27 fell through to the
  // default transcript path and polluted user-visible scrollback. Each must
  // route footer-only with no state mutation. See loop-noise.ts comment for
  // why the user shouldn't see these.

  const cases: Array<[string, string]> = [
    ['Task-step nudge (create_plan)', 'Task-step nudge (create_plan): no structured execution plan is active — nudging the model to create one.'],
    ['Task-step nudge (open_step)', 'Task-step nudge (open_step): task task-1 has open required steps — nudging the model to continue.'],
    ['Continue-while-open', 'Continue-while-open: task still looks active, nudging the model to keep executing (1/3)'],
    ['Delivery check', 'Delivery check: completion claim detected with 4 touched path(s); nudging the model to call DeliveryAudit before concluding (1/2).'],
    ['Probe coverage check', 'Probe coverage check: 2 unsatisfied probe(s) — nudging the model to emit them before summary (1/3).'],
    ['Probe coverage (satisfied)', 'Probe coverage: gap-1, gap-2 satisfied by this turn\'s tool calls.'],
    ['task no-progress suppressed', 'task no-progress suppressed (read-only review intent): 12 iterations / 0 touched paths. Continuing to observe.'],
    ['Summary gate still pending', 'Summary gate still pending (violation 1/3). Prompting the model again for a text summary.'],
    ['Task realign', 'Task realign: keeping 2 tool calls and deferring 3 extra calls until the model re-centers on the contract'],
    ['Artifact repair', 'Artifact repair: ArtifactVerify failed for /tmp/foo/deck.html; injecting repair prompt (1/3).'],
  ]

  for (const [label, message] of cases) {
    it(`routes "${label}" to footer-only and does not mutate state`, () => {
      const routed = routeConversationNotice(message, baseState)
      expect(routed.transcriptEntry).toBeNull()
      expect(routed.footerNotice).toContain(message.split(':')[0]!.split(' (')[0]!)
      expect(routed.workflowPhase).toBeUndefined()
      expect(routed.nextState).toEqual(baseState)
    })
  }

  it('disambiguates Probe coverage check from Probe coverage satisfied', () => {
    // Both go footer-only but the "check" variant is a pre-summary nudge and
    // the bare form is a post-turn satisfaction note. Order in the if-chain
    // must keep them distinct so future routing rules can split them apart
    // without one regex accidentally catching the other.
    const checkRouted = routeConversationNotice(
      'Probe coverage check: 1 unsatisfied probe(s) — nudging the model to emit them before summary (1/3).',
      baseState,
    )
    const satRouted = routeConversationNotice(
      'Probe coverage: alpha, beta satisfied by this turn\'s tool calls.',
      baseState,
    )
    expect(checkRouted.transcriptEntry).toBeNull()
    expect(satRouted.transcriptEntry).toBeNull()
    expect(checkRouted.footerNotice).toContain('Probe coverage check')
    expect(satRouted.footerNotice).toContain('Probe coverage:')
    expect(satRouted.footerNotice).not.toContain('check')
  })
})
