/**
 * Session insights endpoint tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { handleInsights, handleBatchInsights, type SessionInsight } from '../src/endpoints/insights.js'
import { createSession, saveMessage } from '../src/history/sessions.js'
import { _resetIndex } from '../src/skills/injection.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type * as http from 'node:http'

let tmpDir: string

function mockRes(): http.ServerResponse & { body: string; statusCode: number } {
  const res = new EventEmitter() as http.ServerResponse & { body: string; statusCode: number }
  res.body = ''
  res.statusCode = 0
  res.headersSent = false
  res.writeHead = vi.fn((code: number) => { res.statusCode = code; return res })
  res.end = vi.fn((data?: string) => { if (data) res.body = data; return res })
  res.setHeader = vi.fn()
  return res
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'owlcoda-insights-'))
  process.env['OWLCODA_HOME'] = tmpDir
  _resetIndex()
})

afterEach(async () => {
  delete process.env['OWLCODA_HOME']
  await rm(tmpDir, { recursive: true, force: true })
})

describe('insights endpoint', () => {
  it('returns 400 for empty session ID', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    await handleInsights(req, res, '')
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain('Session ID required')
  })

  it('returns 404 for non-existent session', async () => {
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    await handleInsights(req, res, 'nonexistent-session')
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('not found')
  })

  it('returns insight for a simple session', async () => {
    const sessionId = await createSession('test-model', '/tmp')
    await saveMessage(sessionId, 'user', 'Hello')
    await saveMessage(sessionId, 'assistant', [{ type: 'text', text: 'Hi!' }])

    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    await handleInsights(req, res, sessionId)

    expect(res.statusCode).toBe(200)
    const insight = JSON.parse(res.body) as SessionInsight
    expect(insight.sessionId).toBe(sessionId)
    expect(insight.messageCount).toBe(2)
    expect(insight.model).toBe('test-model')
    expect(insight.complexity).toBeTypeOf('number')
    expect(insight.toolsUsed).toEqual([])
    expect(insight.worthSynthesizing).toBe(false)
  })

  it('returns tool usage for complex session', async () => {
    const sessionId = await createSession('test-model', '/tmp')
    await saveMessage(sessionId, 'user', 'Fix the eslint config')
    await saveMessage(sessionId, 'assistant', [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'tu1', name: 'bash', input: { command: 'cat .eslintrc' } },
    ])
    await saveMessage(sessionId, 'user', [
      { type: 'tool_result', tool_use_id: 'tu1', content: '{ "parser": "wrong" }' },
    ])
    await saveMessage(sessionId, 'assistant', [
      { type: 'text', text: 'Found the issue.' },
      { type: 'tool_use', id: 'tu2', name: 'bash', input: { command: 'vim .eslintrc' } },
    ])
    await saveMessage(sessionId, 'user', [
      { type: 'tool_result', tool_use_id: 'tu2', content: 'saved' },
    ])
    await saveMessage(sessionId, 'assistant', [{ type: 'text', text: 'Done!' }])

    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    await handleInsights(req, res, sessionId)

    expect(res.statusCode).toBe(200)
    const insight = JSON.parse(res.body) as SessionInsight
    expect(insight.toolCallCount).toBe(2)
    expect(insight.toolsUsed).toContain('bash')
    expect(insight.topKeywords.length).toBeGreaterThanOrEqual(0)
  })

  it('includes matched skills in insight', async () => {
    // Save a skill first
    const { saveSkill } = await import('../src/skills/store.js')
    await saveSkill({
      id: 'eslint-fix',
      name: 'Fix ESLint Config',
      description: 'Fix broken ESLint configurations',
      procedure: [{ order: 1, action: 'Read .eslintrc' }],
      pitfalls: [],
      verification: [],
      tags: ['eslint', 'config'],
      whenToUse: 'When eslint config errors appear',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      useCount: 0,
      synthesisMode: 'template',
    })
    _resetIndex()

    const sessionId = await createSession('test-model', '/tmp')
    await saveMessage(sessionId, 'user', 'Fix the eslint configuration errors in my TypeScript project')
    await saveMessage(sessionId, 'assistant', [{ type: 'text', text: 'Sure.' }])

    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    await handleInsights(req, res, sessionId)

    expect(res.statusCode).toBe(200)
    const insight = JSON.parse(res.body) as SessionInsight
    expect(insight.matchedSkills.length).toBeGreaterThanOrEqual(1)
    expect(insight.matchedSkills[0].id).toBe('eslint-fix')
    expect(insight.matchedSkills[0].score).toBeGreaterThan(0)
  })
})

describe('handleBatchInsights', () => {

  it('returns summary for existing sessions', async () => {
    // handleBatchInsights reads from native session store, which may have
    // sessions in a different format than history/sessions. It gracefully
    // skips incompatible entries. This test verifies the endpoint doesn't crash.
    const req = new EventEmitter() as http.IncomingMessage
    const res = mockRes()
    await handleBatchInsights(req, res)

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.sessionCount).toBeTypeOf('number')
    expect(body.modelDistribution).toBeDefined()
    expect(body.sessions).toBeInstanceOf(Array)
  })
})
