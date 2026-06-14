import { describe, expect, it } from 'vitest'
import { parseResultOutput } from '../server/review/result.js'

describe('parseResultOutput (owlcoda --json -> MatchResult fields)', () => {
  it('extracts a fenced JSON verdict + source urls', () => {
    const stdout = `noise {"text":"最终比分\\n\\u0060\\u0060\\u0060json\\n{\\"home_goals\\":2,\\"away_goals\\":0,\\"status\\":\\"final\\"}\\n\\u0060\\u0060\\u0060","tool_calls":[{"tool":"WebSearch","output":"1. ESPN\\n   https://espn.com/x"}]}`
    const r = parseResultOutput(stdout, 'Mexico', 'South Africa')
    expect(r.home_goals).toBe(2)
    expect(r.away_goals).toBe(0)
    expect(r.outcome).toBe('home')
    expect(r.status).toBe('final')
    expect(r.source_urls).toContain('https://espn.com/x')
    expect(r.confidence).toBe('supported')
  })
  it('marks unsupported when no parseable score', () => {
    const stdout = `{"text":"未找到可靠比分","tool_calls":[]}`
    const r = parseResultOutput(stdout, 'Mexico', 'South Africa')
    expect(r.status).toBe('unsupported')
    expect(r.home_goals).toBeNull()
    expect(r.outcome).toBeNull()
    expect(r.confidence).toBe('unsupported')
  })
  it('reads an inline (un-fenced) score object from text', () => {
    const stdout = `{"text":"终场 {\\"home_goals\\":1,\\"away_goals\\":1,\\"status\\":\\"final\\"}","tool_calls":[]}`
    const r = parseResultOutput(stdout, 'Mexico', 'South Africa')
    expect(r.status).toBe('final')
    expect(r.outcome).toBe('draw')
  })
  it('returns unsupported (no throw) on malformed / non-JSON stdout', () => {
    expect(() => parseResultOutput('not json at all', 'A', 'B')).not.toThrow()
    expect(parseResultOutput('not json at all', 'A', 'B').status).toBe('unsupported')
    expect(() => parseResultOutput('garbage { broken', 'A', 'B')).not.toThrow()
    expect(parseResultOutput('garbage { broken', 'A', 'B').status).toBe('unsupported')
  })
})
