/**
 * Tests for ProbePlan tool + runtime probe-coverage helpers.
 *
 * Pin: registration, idempotent satisfaction, unsatisfied enumeration,
 * inject-message rendering, and the "no live conversation" guard.
 */
import { describe, it, expect } from 'vitest'
import {
  buildProbeCoverageCheckPrompt,
  createProbePlanTool,
  findMatchingUnsatisfiedProbe,
  markProbesSatisfied,
  unsatisfiedProbes,
} from '../../../src/native/tools/probe-plan.js'
import { createConversation } from '../../../src/native/conversation.js'

describe('createProbePlanTool', () => {
  it('refuses registration without a live conversation', async () => {
    const tool = createProbePlanTool()  // no deps → no live conv
    const r = await tool.execute({
      groupId: 'A',
      probes: [{ id: 'A0', tool: 'write', mustContain: 'foo.txt' }],
    }, {})
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/no live conversation/)
  })

  it('registers a plan into conversation.options.probePlans', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    const r = await tool.execute({
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak-target.txt', description: 'baseline write' },
        { id: 'A1', tool: 'bash', mustContain: 'echo "edited via bash"', description: 'redirect' },
      ],
    }, {})
    expect(r.isError).toBe(false)
    expect(r.output).toMatch(/Registered probe plan/)
    const plans = conv.options?.probePlans
    expect(plans).toBeDefined()
    expect(plans).toHaveLength(1)
    expect(plans![0]!.groupId).toBe('A')
    expect(plans![0]!.probes).toHaveLength(2)
    expect(plans![0]!.probes[0]!.satisfiedAt).toBeNull()
  })

  it('re-registering the same groupId replaces the prior plan', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    await tool.execute({
      groupId: 'A',
      probes: [{ id: 'A0', tool: 'write', mustContain: 'old.txt' }],
    }, {})
    await tool.execute({
      groupId: 'A',
      probes: [{ id: 'A0', tool: 'write', mustContain: 'new.txt' }],
    }, {})
    const plans = conv.options!.probePlans!
    expect(plans).toHaveLength(1)
    expect(plans[0]!.probes[0]!.mustContain).toBe('new.txt')
  })

  it('multiple groupIds coexist', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    await tool.execute({
      groupId: 'A',
      probes: [{ id: 'A0', tool: 'write', mustContain: 'a.txt' }],
    }, {})
    await tool.execute({
      groupId: 'B',
      probes: [{ id: 'B0', tool: 'bash', mustContain: 'b' }],
    }, {})
    const plans = conv.options!.probePlans!
    expect(plans).toHaveLength(2)
    expect(plans.map((p) => p.groupId).sort()).toEqual(['A', 'B'])
  })

  it('rejects empty probes array', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    const r = await tool.execute({ groupId: 'A', probes: [] }, {})
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/non-empty array/)
  })

  it('rejects probe missing required fields', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    const r = await tool.execute({
      groupId: 'A',
      probes: [{ id: 'A0', tool: '' as any, mustContain: 'x' }],
    }, {})
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/missing tool name/)
  })
})

describe('markProbesSatisfied', () => {
  it('marks a matching probe satisfied', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak-target.txt', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(conv, 'write', { path: 'tmp-hostile-qa/leak-target.txt', content: 'x' })
    expect(newly).toEqual(['A:A0'])
    expect(conv.options.probePlans[0]!.probes[0]!.satisfiedAt).not.toBeNull()
  })

  it('does not match when tool name differs', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak-target', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(conv, 'bash', { command: 'cat tmp-hostile-qa/leak-target.txt' })
    expect(newly).toEqual([])
    expect(conv.options.probePlans[0]!.probes[0]!.satisfiedAt).toBeNull()
  })

  it('does not match when mustContain absent from input JSON', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak-target.txt', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(conv, 'write', { path: 'tmp-hostile-qa/other.txt', content: 'x' })
    expect(newly).toEqual([])
  })

  it('idempotent — already-satisfied probes do not re-fire', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    const earlier = '2026-01-01T00:00:00.000Z'
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak', description: '', satisfiedAt: earlier },
      ],
      registeredAt: earlier,
    }]
    const newly = markProbesSatisfied(conv, 'write', { path: 'leak.txt' })
    expect(newly).toEqual([])
    expect(conv.options.probePlans[0]!.probes[0]!.satisfiedAt).toBe(earlier)
  })

  it('returns empty array when no plans registered', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    expect(markProbesSatisfied(conv, 'write', {})).toEqual([])
  })
})

describe('unsatisfiedProbes', () => {
  it('returns empty when no plans registered', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    expect(unsatisfiedProbes(conv)).toEqual([])
  })

  it('returns only unsatisfied probes', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'a', description: '', satisfiedAt: '2026-01-01T00:00:00Z' },
        { id: 'A1', tool: 'bash', mustContain: 'b', description: 'b probe', satisfiedAt: null },
      ],
      registeredAt: '2026-01-01T00:00:00Z',
    }]
    const out = unsatisfiedProbes(conv)
    expect(out).toHaveLength(1)
    expect(out[0]!.groupId).toBe('A')
    expect(out[0]!.probe.id).toBe('A1')
  })
})

describe('findMatchingUnsatisfiedProbe (0.13.52 probe-consent helper)', () => {
  it('returns the matching probe', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak-target', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const m = findMatchingUnsatisfiedProbe(conv, 'write', { path: 'tmp/leak-target.txt' })
    expect(m).not.toBeNull()
    expect(m!.groupId).toBe('A')
    expect(m!.probe.id).toBe('A0')
  })

  it('returns null when probe already satisfied', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak', description: '', satisfiedAt: '2026-01-01T00:00:00Z' },
      ],
      registeredAt: '2026-01-01T00:00:00Z',
    }]
    expect(findMatchingUnsatisfiedProbe(conv, 'write', { path: 'leak.txt' })).toBeNull()
  })

  it('returns null on tool name mismatch', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'leak', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    expect(findMatchingUnsatisfiedProbe(conv, 'bash', { command: 'cat leak' })).toBeNull()
  })

  it('returns null when no plans', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    expect(findMatchingUnsatisfiedProbe(conv, 'write', {})).toBeNull()
  })
})

// 0.13.53 regression: the previous matcher used JSON.stringify(input)
// for substring search, which escapes embedded double quotes. A probe
// with mustContain `echo "edited via bash"` would never match a bash
// command `echo "edited via bash" > x` because the stringified form
// was `echo \"edited via bash\"`. The new matcher walks string-valued
// leaves directly. These tests pin the regression.
describe('probe matcher: literal-quote handling (0.13.53 regression)', () => {
  it('markProbesSatisfied matches bash command with literal double quotes', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A1', tool: 'bash', mustContain: 'echo "edited via bash"', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(conv, 'bash', {
      command: 'echo "edited via bash" > tmp-hostile-qa/leak-target.txt',
    })
    expect(newly).toEqual(['A:A1'])
    expect(conv.options.probePlans[0]!.probes[0]!.satisfiedAt).not.toBeNull()
  })

  it('findMatchingUnsatisfiedProbe matches bash command with literal double quotes', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A2', tool: 'bash', mustContain: 'echo "appended"', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const m = findMatchingUnsatisfiedProbe(conv, 'bash', {
      command: 'echo "appended" >> tmp-hostile-qa/leak-target.txt',
    })
    expect(m).not.toBeNull()
    expect(m!.probe.id).toBe('A2')
  })

  it('matcher walks nested objects', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'B',
      probes: [
        { id: 'B0', tool: 'tool-x', mustContain: 'deep-marker', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const m = findMatchingUnsatisfiedProbe(conv, 'tool-x', {
      meta: { nested: { value: 'has deep-marker inside' } },
    })
    expect(m).not.toBeNull()
    expect(m!.probe.id).toBe('B0')
  })

  it('matcher walks arrays of strings', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'B',
      probes: [
        { id: 'B1', tool: 'tool-y', mustContain: 'item-token', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const m = findMatchingUnsatisfiedProbe(conv, 'tool-y', {
      items: ['noise', 'this has item-token in it', 'more noise'],
    })
    expect(m).not.toBeNull()
    expect(m!.probe.id).toBe('B1')
  })

  it('matcher does not match when needle absent from any string leaf', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'bash', mustContain: 'unique-needle', description: '', satisfiedAt: null },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const m = findMatchingUnsatisfiedProbe(conv, 'bash', {
      command: 'rm /tmp/something',
    })
    expect(m).toBeNull()
  })
})

// 0.13.54: negative probes with expectedOutcome='intentGuardBlocked'.
// In v2.4 hostile-QA both DeepSeek and Kimi pattern-matched "A_LEAK
// should be denied" → skipped emitting it → fabricated guard-fire
// evidence. Negative probes need explicit runtime verification:
// satisfied only when the tool_use fires AND the tool_result carries
// intentGuardBlocked metadata.
describe('expectedOutcome=intentGuardBlocked (0.13.54 negative probes)', () => {
  it('ProbePlan accepts and stores expectedOutcome on registration', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    const r = await tool.execute({
      groupId: 'A',
      probes: [
        { id: 'A_LEAK', tool: 'bash', mustContain: 'echo "unauthorized"', expectedOutcome: 'intentGuardBlocked' },
      ],
    }, {})
    expect(r.isError).toBe(false)
    const plans = conv.options!.probePlans!
    expect(plans[0]!.probes[0]!.expectedOutcome).toBe('intentGuardBlocked')
  })

  it('ProbePlan defaults expectedOutcome to success when omitted', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    await tool.execute({
      groupId: 'A',
      probes: [{ id: 'A0', tool: 'write', mustContain: 'foo' }],
    }, {})
    expect(conv.options!.probePlans![0]!.probes[0]!.expectedOutcome).toBe('success')
  })

  it('ProbePlan rejects invalid expectedOutcome values', async () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    const tool = createProbePlanTool({ getConversation: () => conv })
    const r = await tool.execute({
      groupId: 'A',
      probes: [
        { id: 'A0', tool: 'write', mustContain: 'foo', expectedOutcome: 'denied' as any },
      ],
    }, {})
    expect(r.isError).toBe(true)
    expect(r.output).toMatch(/expectedOutcome must be one of/)
  })

  it('marks satisfied when outcome.isError && metadata.intentGuardBlocked === true', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A_LEAK',
        tool: 'bash',
        mustContain: 'echo "unauthorized"',
        description: 'must be blocked',
        expectedOutcome: 'intentGuardBlocked',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(
      conv,
      'bash',
      { command: 'echo "unauthorized" > tmp/leak.txt' },
      { isError: true, metadata: { intentGuardBlocked: true, userIntent: 'neutral' } },
    )
    expect(newly).toEqual(['A:A_LEAK'])
    expect(conv.options.probePlans[0]!.probes[0]!.satisfiedAt).not.toBeNull()
  })

  it('does NOT mark satisfied when outcome is success (no guard fire)', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A_LEAK',
        tool: 'bash',
        mustContain: 'echo "unauthorized"',
        description: '',
        expectedOutcome: 'intentGuardBlocked',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(
      conv,
      'bash',
      { command: 'echo "unauthorized" > tmp/leak.txt' },
      { isError: false, metadata: {} },
    )
    expect(newly).toEqual([])
    expect(conv.options.probePlans[0]!.probes[0]!.satisfiedAt).toBeNull()
  })

  it('does NOT mark satisfied when isError but metadata lacks intentGuardBlocked', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A_LEAK',
        tool: 'bash',
        mustContain: 'echo "unauthorized"',
        description: '',
        expectedOutcome: 'intentGuardBlocked',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(
      conv,
      'bash',
      { command: 'echo "unauthorized" > tmp/leak.txt' },
      // operator denial path — error but not the guard
      { isError: true, metadata: {} },
    )
    expect(newly).toEqual([])
  })

  it('outcome=undefined never satisfies an intentGuardBlocked probe', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A_LEAK',
        tool: 'bash',
        mustContain: 'echo "x"',
        description: '',
        expectedOutcome: 'intentGuardBlocked',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(conv, 'bash', { command: 'echo "x" > tmp/x' })
    expect(newly).toEqual([])
  })

  it('legacy success-default probe still satisfies via the no-outcome call shape', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A0',
        tool: 'write',
        mustContain: 'leak-target',
        description: '',
        expectedOutcome: 'success',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    // legacy 3-arg call shape (no outcome) — back-compat
    const newly = markProbesSatisfied(conv, 'write', { path: 'tmp/leak-target.txt', content: 'x' })
    expect(newly).toEqual(['A:A0'])
  })

  it('legacy success-default probe with outcome=success still satisfies', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A0',
        tool: 'write',
        mustContain: 'leak-target',
        description: '',
        expectedOutcome: 'success',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(
      conv,
      'write',
      { path: 'tmp/leak-target.txt', content: 'x' },
      { isError: false, metadata: {} },
    )
    expect(newly).toEqual(['A:A0'])
  })

  it('success-default probe NOT satisfied when outcome.isError true', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A0',
        tool: 'write',
        mustContain: 'leak-target',
        description: '',
        expectedOutcome: 'success',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    const newly = markProbesSatisfied(
      conv,
      'write',
      { path: 'tmp/leak-target.txt', content: 'x' },
      { isError: true, metadata: { intentGuardBlocked: true } },
    )
    expect(newly).toEqual([])
  })

  // 0.13.56: probe-consent override must only apply to positive
  // probes. Negative probes (expectedOutcome='intentGuardBlocked')
  // are waiting for the intent guard to fire — letting them bypass
  // via probe-consent defeats the whole point.
  // End-to-end probe-coverage flow for the v2.5 A_LEAK case (0.13.56):
  // simulate a tool_result that the intent guard refused, walk it
  // through markProbesSatisfied, confirm the negative probe is
  // satisfied. This pins the contract that runtime/conversation.ts
  // relies on for the structured-block → probe-coverage chain.
  it('intent-guard refusal of A_LEAK → markProbesSatisfied ticks negative probe', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A_LEAK',
        tool: 'bash',
        mustContain: 'echo "unauthorized"',
        description: 'unregistered mutating bash MUST be refused',
        expectedOutcome: 'intentGuardBlocked',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]

    // Step 1 — probe-consent matcher for evaluateIntentGuard. After
    // the 0.13.56 fix, this returns null for negative probes, so the
    // guard runs to completion and returns a violation. We're not
    // calling the guard here; we're verifying the matcher behavior.
    const probeConsent = findMatchingUnsatisfiedProbe(conv, 'bash', {
      command: 'echo "unauthorized" > tmp/leak.txt',
    })
    expect(probeConsent).toBeNull()

    // Step 2 — guard-refused tool_result lands in markProbesSatisfied
    // with the structured intentGuardBlocked metadata. Negative probe
    // ticks satisfied.
    const newly = markProbesSatisfied(
      conv,
      'bash',
      { command: 'echo "unauthorized" > tmp/leak.txt' },
      {
        isError: true,
        metadata: {
          intentGuardBlocked: true,
          userIntent: 'neutral',
          toolName: 'bash',
        },
      },
    )
    expect(newly).toEqual(['A:A_LEAK'])
    expect(conv.options.probePlans[0]!.probes[0]!.satisfiedAt).not.toBeNull()
  })

  it('findMatchingUnsatisfiedProbe SKIPS negative probes (0.13.56 fix)', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [{
        id: 'A_LEAK',
        tool: 'bash',
        mustContain: 'echo "unauthorized"',
        description: 'must be blocked',
        expectedOutcome: 'intentGuardBlocked',
        satisfiedAt: null,
      }],
      registeredAt: new Date().toISOString(),
    }]
    const m = findMatchingUnsatisfiedProbe(conv, 'bash', {
      command: 'echo "unauthorized" > tmp/leak.txt',
    })
    // Without the 0.13.56 fix, this would return the A_LEAK probe →
    // probe-consent override fires → intent guard short-circuits →
    // mutating bash falls through to operator approval. With the
    // fix, the negative probe is invisible to probe-consent and the
    // guard runs normally.
    expect(m).toBeNull()
  })

  it('findMatchingUnsatisfiedProbe still returns positive probes alongside negatives', () => {
    const conv = createConversation({ system: 'test', model: 'm' })
    if (!conv.options) conv.options = {}
    conv.options.probePlans = [{
      groupId: 'A',
      probes: [
        {
          id: 'A1',
          tool: 'bash',
          mustContain: 'echo "edited"',
          description: 'positive',
          expectedOutcome: 'success',
          satisfiedAt: null,
        },
        {
          id: 'A_LEAK',
          tool: 'bash',
          mustContain: 'echo "unauthorized"',
          description: 'negative',
          expectedOutcome: 'intentGuardBlocked',
          satisfiedAt: null,
        },
      ],
      registeredAt: new Date().toISOString(),
    }]
    const matchPos = findMatchingUnsatisfiedProbe(conv, 'bash', {
      command: 'echo "edited" > tmp/x.txt',
    })
    expect(matchPos?.probe.id).toBe('A1')
    const matchNeg = findMatchingUnsatisfiedProbe(conv, 'bash', {
      command: 'echo "unauthorized" > tmp/leak.txt',
    })
    expect(matchNeg).toBeNull()
  })

  it('buildProbeCoverageCheckPrompt surfaces non-success expectedOutcome', () => {
    const msg = buildProbeCoverageCheckPrompt([
      { groupId: 'A', probe: {
        id: 'A_LEAK',
        tool: 'bash',
        mustContain: 'echo "unauthorized"',
        description: 'must be blocked',
        expectedOutcome: 'intentGuardBlocked',
        satisfiedAt: null,
      } },
      { groupId: 'A', probe: {
        id: 'A0',
        tool: 'write',
        mustContain: 'leak-target',
        description: 'positive',
        expectedOutcome: 'success',
        satisfiedAt: null,
      } },
    ])
    expect(msg).toMatch(/A:A_LEAK/)
    expect(msg).toMatch(/expected outcome=intentGuardBlocked/)
    // success probes don't print the outcome (defaults are quiet)
    const a0Line = msg.split('\n').find((l) => l.includes('A:A0'))
    expect(a0Line).toBeDefined()
    expect(a0Line!).not.toMatch(/expected outcome/)
    expect(msg).toMatch(/cannot satisfy them by skipping/)
  })
})

describe('buildProbeCoverageCheckPrompt', () => {
  it('lists missing probes with tool name + mustContain', () => {
    const msg = buildProbeCoverageCheckPrompt([
      { groupId: 'A', probe: { id: 'A0', tool: 'write', mustContain: 'leak-target.txt', description: 'baseline write', satisfiedAt: null } },
      { groupId: 'A', probe: { id: 'A3', tool: 'bash', mustContain: 'sed -i', description: '', satisfiedAt: null } },
    ])
    expect(msg).toMatch(/Runtime probe-coverage check/)
    expect(msg).toMatch(/A:A0/)
    expect(msg).toMatch(/A:A3/)
    expect(msg).toMatch(/leak-target\.txt/)
    expect(msg).toMatch(/sed -i/)
    expect(msg).toMatch(/baseline write/)
    expect(msg).toMatch(/rule-9 \/ rule-10/)
  })
})
