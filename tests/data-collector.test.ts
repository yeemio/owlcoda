/**
 * Training data collector tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { collectSession, configureCollector, resetCollectorConfig, onSessionEndCollect } from '../src/data/collector.js'
import type { Session, SessionMessage } from '../src/history/sessions.js'

let testDir: string

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'owlcoda-collector-'))
  // Training collection is opt-in (default off). Tests assert collection
  // behavior, so explicitly enable it here.
  configureCollector({ enabled: true, outputDir: testDir, minQuality: 30 })
})

afterEach(async () => {
  resetCollectorConfig()
  delete process.env.OWLCODA_TRAINING_COLLECTION
  await rm(testDir, { recursive: true, force: true })
})

function makeSession(messages: SessionMessage[]): Session {
  return {
    meta: {
      id: 'test-collect-session',
      model: 'test-model',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: '/tmp',
      messageCount: messages.length,
    },
    messages,
  }
}

describe('collectSession', () => {
  it('collects a qualifying session', async () => {
    const session = makeSession([
      { role: 'user', content: 'Build a Node.js REST API with Express and TypeScript', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will create the project structure with TypeScript configuration...' }], timestamp: '' },
      { role: 'user', content: 'Add authentication middleware', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Adding JWT authentication middleware with bcrypt password hashing...' }], timestamp: '' },
      { role: 'user', content: 'Add tests', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Here are the unit tests using Jest for the auth middleware...' }], timestamp: '' },
    ])
    const result = await collectSession(session)
    expect(result.collected).toBe(true)
    expect(result.quality).toBeGreaterThan(0)
    expect(result.path).toContain('collected.jsonl')

    // Verify file was written
    const content = await readFile(result.path!, 'utf-8')
    const parsed = JSON.parse(content.trim())
    expect(parsed.messages).toBeDefined()
    expect(parsed.messages.length).toBeGreaterThan(0)
  })

  it('skips sessions below quality threshold', async () => {
    configureCollector({ outputDir: testDir, minQuality: 95 })
    const session = makeSession([
      { role: 'user', content: 'Hi', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: '' },
      { role: 'user', content: 'Bye', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Goodbye' }], timestamp: '' },
    ])
    const result = await collectSession(session)
    expect(result.collected).toBe(false)
    expect(result.reason).toContain('Quality too low')
  })

  it('skips sessions with too few messages', async () => {
    const session = makeSession([
      { role: 'user', content: 'Hi', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello' }], timestamp: '' },
    ])
    const result = await collectSession(session)
    expect(result.collected).toBe(false)
    expect(result.reason).toContain('Too few messages')
  })

  it('updates manifest on collection', async () => {
    const session = makeSession([
      { role: 'user', content: 'Explain TypeScript generics with detailed examples', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'TypeScript generics allow you to write reusable components that work with multiple types. Here is a comprehensive explanation...' }], timestamp: '' },
      { role: 'user', content: 'Now show advanced patterns', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Advanced generic patterns include conditional types, mapped types, and template literal types...' }], timestamp: '' },
    ])
    await collectSession(session)

    const manifestRaw = await readFile(join(testDir, 'manifest.json'), 'utf-8')
    const manifest = JSON.parse(manifestRaw)
    expect(manifest.totalCollected).toBe(1)
    expect(manifest.averageQuality).toBeGreaterThan(0)
    expect(manifest.lastCollectedAt).toBeTruthy()
  })

  it('appends to existing file', async () => {
    const makeSessionN = (n: number) => makeSession([
      { role: 'user', content: `Question ${n}: explain something complex and detailed`, timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: `Answer ${n}: here is a detailed explanation with examples and code samples...` }], timestamp: '' },
      { role: 'user', content: `Follow-up ${n}: what about edge cases?`, timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: `Edge case ${n}: here are the important edge cases to consider...` }], timestamp: '' },
    ])

    await collectSession(makeSessionN(1))
    await collectSession(makeSessionN(2))

    const content = await readFile(join(testDir, 'collected.jsonl'), 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)
  })
})

describe('isTrainingCollectionEnabled gate (opt-in default)', () => {
  it('skips collection when gate is off', async () => {
    configureCollector({ enabled: false, outputDir: testDir, minQuality: 0 })
    const session = makeSession([
      { role: 'user', content: 'Build a Node.js REST API with Express and TypeScript', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will create the project structure with TypeScript configuration...' }], timestamp: '' },
      { role: 'user', content: 'Add tests', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Adding Jest tests for every endpoint...' }], timestamp: '' },
    ])
    const result = await collectSession(session)
    expect(result.collected).toBe(false)
    expect(result.reason).toMatch(/disabled/i)
  })

  it('env OWLCODA_TRAINING_COLLECTION=0 overrides config enabled=true', async () => {
    configureCollector({ enabled: true, outputDir: testDir, minQuality: 0 })
    process.env.OWLCODA_TRAINING_COLLECTION = '0'
    const session = makeSession([
      { role: 'user', content: 'Build a Node.js REST API with Express and TypeScript', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will create the project structure...' }], timestamp: '' },
      { role: 'user', content: 'Add tests', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Adding Jest tests...' }], timestamp: '' },
    ])
    const result = await collectSession(session)
    expect(result.collected).toBe(false)
    expect(result.reason).toMatch(/disabled/i)
  })

  it('env OWLCODA_TRAINING_COLLECTION=1 overrides config enabled=false', async () => {
    configureCollector({ enabled: false, outputDir: testDir, minQuality: 0 })
    process.env.OWLCODA_TRAINING_COLLECTION = '1'
    const session = makeSession([
      { role: 'user', content: 'Build a Node.js REST API with Express and TypeScript with comprehensive testing strategy', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'I will create the project structure with TypeScript configuration including tsconfig, package.json setup...' }], timestamp: '' },
      { role: 'user', content: 'Add authentication middleware with JWT support', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'Adding JWT authentication middleware with bcrypt password hashing and refresh tokens...' }], timestamp: '' },
    ])
    const result = await collectSession(session)
    expect(result.collected).toBe(true)
  })
})

describe('onSessionEndCollect', () => {
  it('never throws', async () => {
    configureCollector({ outputDir: '/nonexistent/path/that/cannot/exist', minQuality: 0 })
    const session = makeSession([
      { role: 'user', content: 'test', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'response' }], timestamp: '' },
      { role: 'user', content: 'test2', timestamp: '' },
      { role: 'assistant', content: [{ type: 'text', text: 'response2' }], timestamp: '' },
    ])
    // Should not throw even with impossible path
    const result = await onSessionEndCollect(session)
    expect(result.collected).toBe(false)
  })
})
