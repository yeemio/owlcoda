/**
 * Training data export tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, saveMessage } from '../src/history/sessions.js'
import {
  sessionToJsonl,
  sessionToShareGpt,
  sessionToInsight,
  exportTrainingData,
} from '../src/data/export.js'
import type { SessionMeta } from '../src/history/sessions.js'
import type { AnalyzedTrace } from '../src/skills/trace-analyzer.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'owlcoda-export-'))
  process.env['OWLCODA_HOME'] = tmpDir
})

afterEach(async () => {
  delete process.env['OWLCODA_HOME']
  await rm(tmpDir, { recursive: true, force: true })
})

const MOCK_META: SessionMeta = {
  id: 'test-session',
  model: 'test-model',
  createdAt: '2025-01-01T00:00:00Z',
  updatedAt: '2025-01-01T00:10:00Z',
  messageCount: 4,
  preview: 'test',
  cwd: '/tmp',
}

describe('sessionToJsonl', () => {
  it('converts simple messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]
    const line = sessionToJsonl(messages)
    expect(line).not.toBeNull()
    const parsed = JSON.parse(line!)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0].role).toBe('user')
    expect(parsed.messages[1].role).toBe('assistant')
  })

  it('extracts text from content blocks', () => {
    const messages = [
      { role: 'user', content: 'Help me' },
      { role: 'assistant', content: [{ type: 'text', text: 'Sure!' }, { type: 'tool_use', id: 'x', name: 'bash' }] },
    ]
    const line = sessionToJsonl(messages)
    const parsed = JSON.parse(line!)
    expect(parsed.messages[1].content).toBe('Sure!')
  })

  it('returns null for too few messages', () => {
    const line = sessionToJsonl([{ role: 'user', content: 'Hello' }])
    expect(line).toBeNull()
  })

  it('skips empty content', () => {
    const messages = [
      { role: 'user', content: '  ' },
      { role: 'assistant', content: 'Hi' },
    ]
    const line = sessionToJsonl(messages)
    expect(line).toBeNull()
  })
})

describe('sessionToShareGpt', () => {
  it('converts to ShareGPT format', () => {
    const messages = [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: '4' },
    ]
    const line = sessionToShareGpt(MOCK_META, messages)
    const parsed = JSON.parse(line!)
    expect(parsed.conversations).toHaveLength(2)
    expect(parsed.conversations[0].from).toBe('human')
    expect(parsed.conversations[1].from).toBe('gpt')
    expect(parsed.id).toBe('test-session')
    expect(parsed.model).toBe('test-model')
  })

  it('returns null for insufficient turns', () => {
    const line = sessionToShareGpt(MOCK_META, [{ role: 'user', content: 'Hi' }])
    expect(line).toBeNull()
  })
})

describe('sessionToInsight', () => {
  it('includes trace metrics and quality', () => {
    const trace: AnalyzedTrace = {
      toolCalls: [{ name: 'bash', input: { cmd: 'ls' }, output: '', isError: false, index: 0 }],
      errorRecoveries: [],
      workflow: [{ category: 'shell', tools: ['bash'], stepCount: 1 }],
      keywords: ['typescript', 'eslint'],
      toolsUsed: ['bash'],
      complexity: 42,
    }
    const messages = [
      { role: 'user', content: 'test' },
      { role: 'assistant', content: 'response' },
    ]
    const line = sessionToInsight(MOCK_META, trace, messages)
    const parsed = JSON.parse(line)
    expect(parsed.sessionId).toBe('test-session')
    expect(parsed.complexity).toBe(42)
    expect(parsed.toolCallCount).toBe(1)
    expect(parsed.topKeywords).toEqual(['typescript', 'eslint'])
    expect(parsed.quality).toBeTypeOf('number')
    expect(parsed.qualityDimensions).toBeDefined()
  })
})

describe('exportTrainingData', () => {
  it('exports sessions in JSONL format', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Hello')
    await saveMessage(id, 'assistant', [{ type: 'text', text: 'Hi!' }])

    const result = await exportTrainingData({ format: 'jsonl' })
    expect(result.format).toBe('jsonl')
    expect(result.sessionCount).toBe(1)
    expect(result.lines).toHaveLength(1)
    const parsed = JSON.parse(result.lines[0])
    expect(parsed.messages).toHaveLength(2)
  })

  it('exports in ShareGPT format', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Question')
    await saveMessage(id, 'assistant', [{ type: 'text', text: 'Answer' }])

    const result = await exportTrainingData({ format: 'sharegpt' })
    expect(result.sessionCount).toBe(1)
    const parsed = JSON.parse(result.lines[0])
    expect(parsed.conversations).toHaveLength(2)
  })

  it('exports insights format', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Help me fix eslint')
    await saveMessage(id, 'assistant', [{ type: 'text', text: 'Sure' }])

    const result = await exportTrainingData({ format: 'insights' })
    expect(result.sessionCount).toBe(1)
    const parsed = JSON.parse(result.lines[0])
    expect(parsed.complexity).toBeTypeOf('number')
  })

  it('filters by minComplexity', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Hello')
    await saveMessage(id, 'assistant', [{ type: 'text', text: 'Hi' }])

    const result = await exportTrainingData({ format: 'jsonl', minComplexity: 50 })
    expect(result.sessionCount).toBe(0)
    expect(result.skippedCount).toBe(1)
  })

  it('filters by toolCallsOnly', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Hello')
    await saveMessage(id, 'assistant', [{ type: 'text', text: 'Hi' }])

    const result = await exportTrainingData({ format: 'jsonl', toolCallsOnly: true })
    expect(result.sessionCount).toBe(0)
    expect(result.skippedCount).toBe(1)
  })

  it('handles empty session list', async () => {
    const result = await exportTrainingData({ format: 'jsonl' })
    expect(result.sessionCount).toBe(0)
    expect(result.lines).toHaveLength(0)
  })

  it('respects limit', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await createSession('test-model', '/tmp')
      await saveMessage(id, 'user', `Question ${i}`)
      await saveMessage(id, 'assistant', [{ type: 'text', text: `Answer ${i}` }])
    }

    const result = await exportTrainingData({ format: 'jsonl', limit: 2 })
    expect(result.sessionCount).toBeLessThanOrEqual(2)
  })

  it('filters by minQuality', async () => {
    const id = await createSession('test-model', '/tmp')
    await saveMessage(id, 'user', 'Hi')
    await saveMessage(id, 'assistant', [{ type: 'text', text: 'Hello' }])

    // Simple sessions have low quality — should be filtered out with high threshold
    const result = await exportTrainingData({ format: 'jsonl', minQuality: 90 })
    expect(result.sessionCount).toBe(0)
    expect(result.skippedCount).toBe(1)
  })
})
