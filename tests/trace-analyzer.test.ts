import { describe, it, expect } from 'vitest'
import {
  analyzeSession,
  extractToolCalls,
  extractErrorRecoveries,
  buildWorkflow,
  extractKeywords,
  computeComplexity,
} from '../src/skills/trace-analyzer.js'
import type { Session } from '../src/history/sessions.js'

// ─── Fixtures ───

function makeSession(messages: Session['messages'], overrides?: Partial<Session['meta']>): Session {
  return {
    meta: {
      id: 'test-session-001',
      model: 'test-model',
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:10:00Z',
      messageCount: messages.length,
      preview: 'test session',
      cwd: '/tmp/test',
      ...overrides,
    },
    messages,
  }
}

const EMPTY_SESSION = makeSession([])

const TEXT_ONLY_SESSION = makeSession([
  { role: 'user', content: 'Hello world', timestamp: '2025-01-01T00:00:00Z' },
  { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }], timestamp: '2025-01-01T00:00:05Z' },
  { role: 'user', content: 'How are you?', timestamp: '2025-01-01T00:00:10Z' },
  { role: 'assistant', content: [{ type: 'text', text: 'Good!' }], timestamp: '2025-01-01T00:00:15Z' },
])

const TOOL_SESSION = makeSession([
  { role: 'user', content: 'Fix the eslint config', timestamp: '2025-01-01T00:00:00Z' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look at the config.' },
      { type: 'tool_use', id: 'tc1', name: 'file_read', input: { path: '.eslintrc.json' } },
    ],
    timestamp: '2025-01-01T00:00:05Z',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tc1', content: '{ "rules": {} }', is_error: false },
    ],
    timestamp: '2025-01-01T00:00:06Z',
  },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tc2', name: 'file_write', input: { path: '.eslintrc.json', content: '{ "rules": { "no-unused-vars": "warn" } }' } },
    ],
    timestamp: '2025-01-01T00:00:10Z',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tc2', content: 'ok', is_error: false },
    ],
    timestamp: '2025-01-01T00:00:11Z',
  },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tc3', name: 'bash', input: { command: 'npx eslint --fix .' } },
    ],
    timestamp: '2025-01-01T00:00:15Z',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tc3', content: 'All files clean', is_error: false },
    ],
    timestamp: '2025-01-01T00:00:20Z',
  },
  { role: 'user', content: 'Looks good, thanks!', timestamp: '2025-01-01T00:01:00Z' },
])

const ERROR_RECOVERY_SESSION = makeSession([
  { role: 'user', content: 'Run the tests', timestamp: '2025-01-01T00:00:00Z' },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tc1', name: 'bash', input: { command: 'npm test' } },
    ],
    timestamp: '2025-01-01T00:00:05Z',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tc1', content: 'FAIL: 3 tests failed', is_error: true },
    ],
    timestamp: '2025-01-01T00:00:10Z',
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me check the failing test.' },
      { type: 'tool_use', id: 'tc2', name: 'file_read', input: { path: 'tests/foo.test.ts' } },
    ],
    timestamp: '2025-01-01T00:00:15Z',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tc2', content: 'test code...', is_error: false },
    ],
    timestamp: '2025-01-01T00:00:16Z',
  },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tc3', name: 'file_write', input: { path: 'tests/foo.test.ts', content: 'fixed test' } },
    ],
    timestamp: '2025-01-01T00:00:20Z',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tc3', content: 'ok', is_error: false },
    ],
    timestamp: '2025-01-01T00:00:21Z',
  },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tc4', name: 'bash', input: { command: 'npm test' } },
    ],
    timestamp: '2025-01-01T00:00:25Z',
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tc4', content: 'All tests passed', is_error: false },
    ],
    timestamp: '2025-01-01T00:00:30Z',
  },
])

// ─── Tests ───

describe('trace analyzer', () => {
  describe('extractToolCalls', () => {
    it('returns empty for no-tool sessions', () => {
      expect(extractToolCalls(EMPTY_SESSION)).toEqual([])
      expect(extractToolCalls(TEXT_ONLY_SESSION)).toEqual([])
    })

    it('extracts tool calls in order', () => {
      const calls = extractToolCalls(TOOL_SESSION)
      expect(calls).toHaveLength(3)
      expect(calls[0].name).toBe('file_read')
      expect(calls[1].name).toBe('file_write')
      expect(calls[2].name).toBe('bash')
      expect(calls.every(c => !c.isError)).toBe(true)
    })

    it('marks error tool calls', () => {
      const calls = extractToolCalls(ERROR_RECOVERY_SESSION)
      expect(calls).toHaveLength(4)
      expect(calls[0].isError).toBe(true) // npm test failed
      expect(calls[1].isError).toBe(false)
      expect(calls[3].isError).toBe(false) // npm test succeeded
    })

    it('truncates long input values', () => {
      const session = makeSession([
        { role: 'user', content: 'test', timestamp: '2025-01-01T00:00:00Z' },
        {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'tc1',
            name: 'file_write',
            input: { path: 'a.txt', content: 'x'.repeat(500) },
          }],
          timestamp: '2025-01-01T00:00:01Z',
        },
      ])
      const calls = extractToolCalls(session)
      expect(calls[0].input.content).toHaveLength(201) // 200 + '…'
    })

    it('assigns sequential indices', () => {
      const calls = extractToolCalls(TOOL_SESSION)
      expect(calls.map(c => c.index)).toEqual([0, 1, 2])
    })
  })

  describe('extractErrorRecoveries', () => {
    it('returns empty when no errors', () => {
      const calls = extractToolCalls(TOOL_SESSION)
      expect(extractErrorRecoveries(calls)).toEqual([])
    })

    it('detects error → recovery pattern', () => {
      const calls = extractToolCalls(ERROR_RECOVERY_SESSION)
      const recoveries = extractErrorRecoveries(calls)
      expect(recoveries).toHaveLength(1)
      expect(recoveries[0].failedCall.name).toBe('bash')
      expect(recoveries[0].recovered).toBe(true)
      expect(recoveries[0].recoveryCalls).toHaveLength(3) // file_read, file_write, bash
    })
  })

  describe('buildWorkflow', () => {
    it('returns empty for no tool calls', () => {
      expect(buildWorkflow([])).toEqual([])
    })

    it('groups calls into workflow steps', () => {
      const calls = extractToolCalls(TOOL_SESSION)
      const wf = buildWorkflow(calls)
      expect(wf.length).toBeGreaterThanOrEqual(2)
      expect(wf[0].order).toBe(1)
      // Each step should have tools and description
      for (const step of wf) {
        expect(step.tools.length).toBeGreaterThan(0)
        expect(step.description.length).toBeGreaterThan(0)
      }
    })

    it('step numbers are sequential', () => {
      const calls = extractToolCalls(ERROR_RECOVERY_SESSION)
      const wf = buildWorkflow(calls)
      for (let i = 0; i < wf.length; i++) {
        expect(wf[i].order).toBe(i + 1)
      }
    })
  })

  describe('extractKeywords', () => {
    it('returns empty for empty session', () => {
      expect(extractKeywords(EMPTY_SESSION)).toEqual([])
    })

    it('extracts keywords from user messages', () => {
      const session = makeSession([
        { role: 'user', content: 'Fix the eslint config for typescript project', timestamp: '2025-01-01T00:00:00Z' },
        { role: 'assistant', content: [{ type: 'text', text: 'Sure' }], timestamp: '2025-01-01T00:00:01Z' },
        { role: 'user', content: 'Also add prettier integration with eslint', timestamp: '2025-01-01T00:00:02Z' },
      ])
      const kw = extractKeywords(session)
      expect(kw).toContain('eslint')
      expect(kw).toContain('config')
    })

    it('filters stopwords', () => {
      const session = makeSession([
        { role: 'user', content: 'the and for that this with from', timestamp: '2025-01-01T00:00:00Z' },
      ])
      const kw = extractKeywords(session)
      expect(kw).toEqual([])
    })
  })

  describe('computeComplexity', () => {
    it('empty session has zero complexity', () => {
      expect(computeComplexity([], [], 0)).toBe(0)
    })

    it('text-only session has low complexity (turns only)', () => {
      const score = computeComplexity([], [], 4)
      expect(score).toBeLessThan(20)
    })

    it('tool-heavy session has higher complexity', () => {
      const calls = extractToolCalls(TOOL_SESSION)
      const score = computeComplexity(calls, [], 8)
      expect(score).toBeGreaterThan(20)
    })

    it('error recovery increases complexity', () => {
      const calls = extractToolCalls(ERROR_RECOVERY_SESSION)
      const recoveries = extractErrorRecoveries(calls)
      const withRecovery = computeComplexity(calls, recoveries, 9)
      const withoutRecovery = computeComplexity(calls, [], 9)
      expect(withRecovery).toBeGreaterThan(withoutRecovery)
    })

    it('caps at 100', () => {
      const manyCalls = Array.from({ length: 100 }, (_, i) => ({
        index: i, name: `tool-${i % 10}`, input: {}, isError: i % 5 === 0, timestamp: '',
      }))
      const manyRecoveries = Array.from({ length: 20 }, () => ({
        failedCall: manyCalls[0], recoveryCalls: [], recovered: true,
      }))
      expect(computeComplexity(manyCalls, manyRecoveries, 50)).toBeLessThanOrEqual(100)
    })
  })

  describe('analyzeSession', () => {
    it('analyzes empty session', () => {
      const trace = analyzeSession(EMPTY_SESSION)
      expect(trace.sessionId).toBe('test-session-001')
      expect(trace.toolCalls).toEqual([])
      expect(trace.complexity).toBe(0)
      expect(trace.turnCount).toBe(0)
    })

    it('analyzes text-only session', () => {
      const trace = analyzeSession(TEXT_ONLY_SESSION)
      expect(trace.toolCalls).toEqual([])
      expect(trace.turnCount).toBe(4)
      expect(trace.durationSec).toBe(15) // 00:00 → 00:15
      expect(trace.complexity).toBeLessThan(20)
    })

    it('analyzes tool session with full data', () => {
      const trace = analyzeSession(TOOL_SESSION)
      expect(trace.toolCalls).toHaveLength(3)
      expect(trace.toolsUsed).toContain('bash')
      expect(trace.toolsUsed).toContain('file_read')
      expect(trace.workflow.length).toBeGreaterThan(0)
      expect(trace.durationSec).toBe(60) // 00:00 → 01:00
      expect(trace.complexity).toBeGreaterThan(0)
    })

    it('analyzes error recovery session', () => {
      const trace = analyzeSession(ERROR_RECOVERY_SESSION)
      expect(trace.errorRecoveries).toHaveLength(1)
      expect(trace.errorRecoveries[0].recovered).toBe(true)
      expect(trace.complexity).toBeGreaterThan(trace.toolCalls.length) // recovery bonus
    })

    it('extracts model from session meta', () => {
      const session = makeSession([], { model: 'qwen-27b' })
      const trace = analyzeSession(session)
      expect(trace.model).toBe('qwen-27b')
    })
  })
})
