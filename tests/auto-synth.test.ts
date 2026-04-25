import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  evaluateSession,
  onSessionEnd,
  configureAutoSynth,
  resetAutoSynthConfig,
  getAutoSynthConfig,
  findSimilarSkill,
} from '../src/skills/auto-synth.js'
import { loadSkill, saveSkill } from '../src/skills/store.js'
import { _resetIndex } from '../src/skills/injection.js'
import type { Session, SessionMessage } from '../src/history/sessions.js'
import type { SkillDocument } from '../src/skills/schema.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Fixture ───

function makeSession(
  messages: SessionMessage[],
  overrides?: Partial<Session['meta']>,
): Session {
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

const SIMPLE_SESSION = makeSession([
  { role: 'user', content: 'Hello', timestamp: '2025-01-01T00:00:00Z' },
  { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }], timestamp: '2025-01-01T00:00:01Z' },
])

const COMPLEX_SESSION = makeSession([
  { role: 'user', content: 'Fix the eslint config for typescript', timestamp: '2025-01-01T00:00:00Z' },
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
    content: [{ type: 'tool_result', tool_use_id: 'tc1', content: '{}', is_error: false }],
    timestamp: '2025-01-01T00:00:06Z',
  },
  {
    role: 'assistant',
    content: [
      { type: 'tool_use', id: 'tc2', name: 'file_write', input: { path: '.eslintrc.json', content: '{"rules":{}}' } },
    ],
    timestamp: '2025-01-01T00:00:10Z',
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tc2', content: 'ok', is_error: false }],
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
    content: [{ type: 'tool_result', tool_use_id: 'tc3', content: 'clean', is_error: false }],
    timestamp: '2025-01-01T00:00:20Z',
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
    content: [{ type: 'tool_result', tool_use_id: 'tc4', content: 'all passed', is_error: false }],
    timestamp: '2025-01-01T00:00:30Z',
  },
  { role: 'user', content: 'Great, thanks!', timestamp: '2025-01-01T00:01:00Z' },
])

// ─── Tests ───

describe('auto-synth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'owlcoda-auto-synth-'))
    process.env.OWLCODA_HOME = tmpDir
    _resetIndex()
    resetAutoSynthConfig()
  })

  afterEach(async () => {
    delete process.env.OWLCODA_HOME
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('configureAutoSynth', () => {
    it('applies partial overrides', () => {
      configureAutoSynth({ minComplexity: 50 })
      expect(getAutoSynthConfig().minComplexity).toBe(50)
      expect(getAutoSynthConfig().enabled).toBe(true)
    })

    it('can disable auto-synthesis', () => {
      configureAutoSynth({ enabled: false })
      expect(getAutoSynthConfig().enabled).toBe(false)
    })

    it('resetAutoSynthConfig restores defaults', () => {
      configureAutoSynth({ minComplexity: 99 })
      resetAutoSynthConfig()
      expect(getAutoSynthConfig().minComplexity).toBe(20)
    })
  })

  describe('evaluateSession', () => {
    it('skips when disabled', async () => {
      configureAutoSynth({ enabled: false })
      const result = await evaluateSession(COMPLEX_SESSION)
      expect(result.attempted).toBe(false)
      expect(result.reason).toContain('disabled')
    })

    it('skips simple sessions (too few messages)', async () => {
      const result = await evaluateSession(SIMPLE_SESSION)
      expect(result.attempted).toBe(false)
      expect(result.reason).toContain('Too few messages')
    })

    it('synthesizes from complex session', async () => {
      const result = await evaluateSession(COMPLEX_SESSION)
      expect(result.attempted).toBe(true)
      expect(result.saved).toBe(true)
      expect(result.skill).toBeDefined()
      expect(result.skill!.id.length).toBeGreaterThan(0)
      expect(result.skill!.synthesisMode).toBe('template')
    })

    it('saves skill to disk', async () => {
      const result = await evaluateSession(COMPLEX_SESSION)
      expect(result.saved).toBe(true)
      const loaded = await loadSkill(result.skill!.id)
      expect(loaded).toBeDefined()
      expect(loaded!.id).toBe(result.skill!.id)
    })

    it('skips duplicates by default', async () => {
      // First synthesis
      const first = await evaluateSession(COMPLEX_SESSION)
      expect(first.saved).toBe(true)

      _resetIndex()

      // Second synthesis — same session, same skill ID
      const second = await evaluateSession(COMPLEX_SESSION)
      expect(second.attempted).toBe(true)
      expect(second.saved).toBe(false)
      expect(second.reason).toContain('already exists')
    })

    it('respects minToolCalls threshold', async () => {
      configureAutoSynth({ minToolCalls: 100 })
      const result = await evaluateSession(COMPLEX_SESSION)
      expect(result.attempted).toBe(false)
      expect(result.reason).toContain('Too few tool calls')
    })

    it('respects minComplexity threshold', async () => {
      configureAutoSynth({ minComplexity: 100 })
      const result = await evaluateSession(COMPLEX_SESSION)
      expect(result.attempted).toBe(false)
      expect(result.reason).toContain('Complexity too low')
    })
  })

  describe('onSessionEnd', () => {
    it('synthesizes and logs result', async () => {
      const result = await onSessionEnd(COMPLEX_SESSION)
      expect(result.saved).toBe(true)
    })

    it('does not throw on error', async () => {
      // Force error by setting invalid home
      process.env.OWLCODA_HOME = '/nonexistent/path/that/cannot/be/created/deeply/nested'
      const result = await onSessionEnd(COMPLEX_SESSION)
      // Should not throw, just return error result
      expect(result.attempted).toBe(false)
      expect(result.reason).toContain('Error')
    })

    it('returns reason for simple session', async () => {
      const result = await onSessionEnd(SIMPLE_SESSION)
      expect(result.attempted).toBe(false)
      expect(result.saved).toBe(false)
    })
  })

  describe('findSimilarSkill', () => {
    function makeTestSkill(overrides: Partial<SkillDocument> & { id: string }): SkillDocument {
      return {
        name: 'Test Skill',
        description: 'A test skill',
        procedure: [{ order: 1, action: 'Do something' }],
        pitfalls: [],
        verification: [],
        tags: ['test'],
        whenToUse: 'When testing',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        useCount: 0,
        synthesisMode: 'template',
        ...overrides,
      }
    }

    it('returns null when no skills exist', async () => {
      const candidate = makeTestSkill({ id: 'new-skill' })
      const similar = await findSimilarSkill(candidate)
      expect(similar).toBeNull()
    })

    it('finds similar skill based on content', async () => {
      await saveSkill(makeTestSkill({
        id: 'eslint-fix',
        name: 'Fix ESLint Configuration',
        description: 'Fix broken ESLint configs in TypeScript projects',
        tags: ['eslint', 'typescript', 'config'],
        whenToUse: 'When eslint config errors appear',
      }))

      const candidate = makeTestSkill({
        id: 'eslint-config-fix',
        name: 'ESLint Config Repair',
        description: 'Repair broken ESLint configuration for TypeScript',
        tags: ['eslint', 'typescript', 'config'],
        whenToUse: 'When eslint configuration is broken',
      })

      const similar = await findSimilarSkill(candidate)
      expect(similar).not.toBeNull()
      expect(similar!.id).toBe('eslint-fix')
    })

    it('does not flag unrelated skills', async () => {
      await saveSkill(makeTestSkill({
        id: 'docker-debug',
        name: 'Debug Docker Compose',
        description: 'Debug Docker container startup failures',
        tags: ['docker', 'compose', 'container'],
        whenToUse: 'When docker containers fail to start',
      }))

      const candidate = makeTestSkill({
        id: 'eslint-fix',
        name: 'Fix ESLint Configuration',
        description: 'Fix broken ESLint configs in TypeScript projects',
        tags: ['eslint', 'typescript'],
        whenToUse: 'When eslint errors appear',
      })

      const similar = await findSimilarSkill(candidate)
      expect(similar).toBeNull()
    })
  })
})
