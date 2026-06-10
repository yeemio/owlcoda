import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyzeMicrocompact,
  isMicrocompactShadowEnabled,
  buildMicrocompactShadowEvent,
  recordMicrocompactShadow,
  summarizeMicrocompactShadow,
  buildMicrocompactShadowSummary,
} from '../src/native/microcompact.js'
import type { ConversationTurn } from '../src/native/protocol/types.js'

function readTurn(id: string, path: string): ConversationTurn {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { path } }], timestamp: 0 }
}
function editTurn(id: string, path: string): ConversationTurn {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Edit', input: { path } }], timestamp: 0 }
}
function resultTurn(id: string, content: string): ConversationTurn {
  return { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }], timestamp: 0 }
}

describe('analyzeMicrocompact', () => {
  it('reports nothing for an empty conversation', () => {
    const a = analyzeMicrocompact([])
    expect(a).toEqual({ totalReads: 0, supersededReads: 0, strippableTokens: 0, candidates: [] })
  })

  it('keeps a single read (it is the latest snapshot of its path)', () => {
    const a = analyzeMicrocompact([readTurn('r1', '/a.ts'), resultTurn('r1', 'content')])
    expect(a.totalReads).toBe(1)
    expect(a.supersededReads).toBe(0)
  })

  it('flags an earlier read superseded by a later read of the same path', () => {
    const turns = [
      readTurn('r1', '/a.ts'), resultTurn('r1', 'OLD CONTENT '.repeat(20)),
      readTurn('r2', '/a.ts'), resultTurn('r2', 'NEW'),
    ]
    const a = analyzeMicrocompact(turns)
    expect(a.totalReads).toBe(2)
    expect(a.supersededReads).toBe(1)
    expect(a.candidates[0]!.toolUseId).toBe('r1')
    expect(a.candidates[0]!.reason).toBe('superseded_by_read')
    expect(a.strippableTokens).toBeGreaterThan(0)
  })

  it('flags a read superseded by a later edit of the same path', () => {
    const turns = [
      readTurn('r1', '/a.ts'), resultTurn('r1', 'stale snapshot'),
      editTurn('e1', '/a.ts'), resultTurn('e1', 'ok'),
    ]
    const a = analyzeMicrocompact(turns)
    expect(a.supersededReads).toBe(1)
    expect(a.candidates[0]!.reason).toBe('superseded_by_edit')
  })

  it('does not cross paths: a read of B does not supersede a read of A', () => {
    const turns = [
      readTurn('r1', '/a.ts'), resultTurn('r1', 'a'),
      readTurn('r2', '/b.ts'), resultTurn('r2', 'b'),
    ]
    expect(analyzeMicrocompact(turns).supersededReads).toBe(0)
  })

  it('measures strippable tokens from the superseded read result via estimateTokens', () => {
    const big = 'x'.repeat(400) // ~100 tokens at ~4 chars/token
    const turns = [
      readTurn('r1', '/a.ts'), resultTurn('r1', big),
      readTurn('r2', '/a.ts'), resultTurn('r2', 'small'),
    ]
    expect(analyzeMicrocompact(turns).strippableTokens).toBe(100)
  })
})

describe('isMicrocompactShadowEnabled', () => {
  it('defaults OFF (opt-in) when unset', () => {
    expect(isMicrocompactShadowEnabled({})).toBe(false)
  })
  it('honors truthy and falsy values', () => {
    expect(isMicrocompactShadowEnabled({ OWLCODA_MICROCOMPACT_SHADOW: 'on' })).toBe(true)
    expect(isMicrocompactShadowEnabled({ OWLCODA_MICROCOMPACT_SHADOW: '0' })).toBe(false)
  })
})

describe('buildMicrocompactShadowEvent', () => {
  it('builds an observe-decision envelope carrying the strip measurement', () => {
    const ev = buildMicrocompactShadowEvent({
      totalReads: 3, supersededReads: 2, strippableTokens: 250, candidates: [],
    })
    expect(ev.eventType).toBe('microcompact_shadow')
    expect(ev.decision).toBe('observe')
    expect((ev.attributes as Record<string, unknown>).strippableTokens).toBe(250)
    expect((ev.attributes as Record<string, unknown>).supersededReads).toBe(2)
  })
})

describe('summarizeMicrocompactShadow', () => {
  const ev = (strippableTokens: number, supersededReads: number, totalReads: number, eventType = 'microcompact_shadow') =>
    ({ eventType, attributes: { strippableTokens, supersededReads, totalReads } } as never)

  it('tallies samples, totals, and average strippable tokens', () => {
    const s = summarizeMicrocompactShadow([ev(100, 2, 5), ev(300, 4, 8)])
    expect(s.samples).toBe(2)
    expect(s.totalStrippableTokens).toBe(400)
    expect(s.avgStrippableTokens).toBe(200)
    expect(s.totalSupersededReads).toBe(6)
  })

  it('ignores non-microcompact envelope events', () => {
    expect(summarizeMicrocompactShadow([ev(100, 1, 1, 'model_routing_shadow')]).samples).toBe(0)
  })
})

describe('buildMicrocompactShadowSummary (end-to-end)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'owlcoda-mc-sum-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('records an enabled shadow sample and reads it back', () => {
    const env = { OWLCODA_HOME: dir, OWLCODA_MICROCOMPACT_SHADOW: '1' } as never
    const turns = [
      readTurn('r1', '/a.ts'), resultTurn('r1', 'OLD '.repeat(40)),
      readTurn('r2', '/a.ts'), resultTurn('r2', 'new'),
    ]
    recordMicrocompactShadow(turns, env)
    const s = buildMicrocompactShadowSummary({ home: dir })
    expect(s.samples).toBe(1)
    expect(s.totalSupersededReads).toBe(1)
    expect(s.totalStrippableTokens).toBeGreaterThan(0)
  })
})
