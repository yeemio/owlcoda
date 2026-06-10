/**
 * Data quality scorer tests.
 */
import { describe, it, expect } from 'vitest'
import { scoreSession, aggregateQualityReport, type QualityScore } from '../src/data/quality.js'
import type { Session, SessionMessage } from '../src/history/sessions.js'

function makeSession(messages: SessionMessage[]): Session {
  return {
    meta: {
      id: 'test',
      model: 'test-model',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:10:00Z',
      messageCount: messages.length,
      preview: 'test',
      cwd: '/tmp',
    },
    messages,
  }
}

describe('data quality scorer', () => {
  it('scores a minimal session low', () => {
    const session = makeSession([
      { role: 'user', content: 'Hi', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: '' },
    ])
    const score = scoreSession(session)
    expect(score.overall).toBeLessThan(50)
    expect(score.dimensions.coherence).toBeGreaterThan(0)
  })

  it('scores a complex session higher', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'Fix the eslint configuration in my TypeScript project', timestamp: '' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me check your eslint config.' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'cat .eslintrc.json' } },
      ], timestamp: '' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: '{ "parser": "@typescript-eslint/parser" }' },
      ], timestamp: '' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Found the issue. Let me fix it.' },
        { type: 'tool_use', id: 't2', name: 'write', input: { path: '.eslintrc.json', content: '{}' } },
      ], timestamp: '' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't2', content: 'written' },
      ], timestamp: '' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Done! The eslint config is now fixed. ✓' },
      ], timestamp: '' },
    ]
    const session = makeSession(messages)
    const score = scoreSession(session)
    expect(score.overall).toBeGreaterThan(30)
    expect(score.dimensions.toolRichness).toBeGreaterThan(0)
    expect(score.dimensions.completeness).toBeGreaterThan(0.5)
  })

  it('penalizes sessions starting with assistant', () => {
    const session = makeSession([
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: '' },
      { role: 'user', content: 'Hi', timestamp: '' },
    ])
    const score = scoreSession(session)
    expect(score.issues.some(i => i.includes('does not start with user'))).toBe(true)
  })

  it('penalizes sessions ending without assistant', () => {
    const session = makeSession([
      { role: 'user', content: 'Hello', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], timestamp: '' },
      { role: 'user', content: 'Bye', timestamp: '' },
    ])
    const score = scoreSession(session)
    expect(score.issues.some(i => i.includes('ended on user message'))).toBe(true)
  })

  it('rewards error recovery patterns', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'Run the build', timestamp: '' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm run build' } },
      ], timestamp: '' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't1', content: 'Error: module not found', is_error: true },
      ], timestamp: '' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me fix the import.' },
        { type: 'tool_use', id: 't2', name: 'bash', input: { command: 'npm install missing-pkg' } },
      ], timestamp: '' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't2', content: 'added 1 package' },
      ], timestamp: '' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 't3', name: 'bash', input: { command: 'npm run build' } },
      ], timestamp: '' },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 't3', content: 'Build successful' },
      ], timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Build is now passing! ✅' }], timestamp: '' },
    ]
    const session = makeSession(messages)
    const score = scoreSession(session)
    expect(score.dimensions.toolRichness).toBeGreaterThan(0.3)
  })

  it('returns overall 0-100', () => {
    const session = makeSession([
      { role: 'user', content: 'X', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Y' }], timestamp: '' },
    ])
    const score = scoreSession(session)
    expect(score.overall).toBeGreaterThanOrEqual(0)
    expect(score.overall).toBeLessThanOrEqual(100)
  })

  it('all dimensions are 0-1', () => {
    const session = makeSession([
      { role: 'user', content: 'Hello world test message', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Response with content' }], timestamp: '' },
    ])
    const score = scoreSession(session)
    for (const [, val] of Object.entries(score.dimensions)) {
      expect(val).toBeGreaterThanOrEqual(0)
      expect(val).toBeLessThanOrEqual(1)
    }
  })

  it('handles single-message session', () => {
    const session = makeSession([{ role: 'user', content: 'Hello', timestamp: '' }])
    const score = scoreSession(session)
    expect(score.overall).toBeLessThan(15)
  })

  it('text-only conversation gets moderate tool richness', () => {
    const session = makeSession([
      { role: 'user', content: 'Tell me about TypeScript', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'TypeScript is a typed superset of JavaScript...' }], timestamp: '' },
    ])
    const score = scoreSession(session)
    expect(score.dimensions.toolRichness).toBe(0.3)
    expect(score.issues.some(i => i.includes('No tool calls'))).toBe(true)
  })
})

describe('aggregateQualityReport', () => {

  function fakeScore(overall: number, issues: string[] = []): QualityScore {
    return {
      overall,
      dimensions: { coherence: 0.8, informativeness: 0.7, toolRichness: 0.6, completeness: 0.9, complexity: 0.5 },
      issues,
    }
  }

  it('returns zeroed report for empty input', () => {
    const report = aggregateQualityReport([])
    expect(report.totalSessions).toBe(0)
    expect(report.averageQuality).toBe(0)
    expect(report.distribution.excellent).toBe(0)
  })

  it('calculates correct distribution', () => {
    const scores = [fakeScore(90), fakeScore(70), fakeScore(50), fakeScore(30)]
    const report = aggregateQualityReport(scores)
    expect(report.distribution.excellent).toBe(1) // 90
    expect(report.distribution.good).toBe(1)      // 70
    expect(report.distribution.fair).toBe(1)       // 50
    expect(report.distribution.poor).toBe(1)       // 30
    expect(report.averageQuality).toBe(60)
    expect(report.medianQuality).toBe(60) // median of [30,50,70,90]
  })

  it('aggregates top issues', () => {
    const scores = [
      fakeScore(50, ['No tool calls', 'Short content']),
      fakeScore(60, ['No tool calls']),
      fakeScore(70, ['Short content']),
    ]
    const report = aggregateQualityReport(scores)
    expect(report.topIssues[0].issue).toBe('No tool calls')
    expect(report.topIssues[0].count).toBe(2)
  })

  it('calculates average dimensions', () => {
    const scores = [fakeScore(80), fakeScore(60)]
    const report = aggregateQualityReport(scores)
    expect(report.averageDimensions.coherence).toBe(0.8)
    expect(report.averageDimensions.complexity).toBe(0.5)
  })
})
