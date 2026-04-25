import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  extractUserQuery,
  injectSkills,
  invalidateSkillIndex,
  _resetIndex,
} from '../src/skills/injection.js'
import { saveSkill, deleteSkill } from '../src/skills/store.js'
import type { SkillDocument } from '../src/skills/schema.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── Fixture ───

function makeSkill(id: string, name: string, tags: string[]): SkillDocument {
  return {
    id,
    name,
    description: `Skill for ${name}`,
    procedure: [{ order: 1, action: 'Do the thing' }],
    pitfalls: [],
    verification: [],
    tags,
    whenToUse: `When you need ${name}`,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    useCount: 0,
    synthesisMode: 'template',
  }
}

// ─── Tests ───

describe('skill injection', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'owlcoda-injection-'))
    process.env.OWLCODA_HOME = tmpDir
    _resetIndex()
  })

  afterEach(async () => {
    delete process.env.OWLCODA_HOME
    await rm(tmpDir, { recursive: true, force: true })
  })

  describe('extractUserQuery', () => {
    it('extracts from string content', () => {
      const msgs = [
        { role: 'user', content: 'Fix the eslint config' },
        { role: 'assistant', content: [{ type: 'text', text: 'Sure!' }] },
        { role: 'user', content: 'Also add prettier' },
      ]
      const query = extractUserQuery(msgs)
      expect(query).toContain('eslint')
      expect(query).toContain('prettier')
    })

    it('extracts from content block arrays', () => {
      const msgs = [
        { role: 'user', content: [{ type: 'text', text: 'Hello world' }] },
      ]
      expect(extractUserQuery(msgs)).toContain('Hello world')
    })

    it('ignores assistant messages', () => {
      const msgs = [
        { role: 'assistant', content: 'I am assistant' },
        { role: 'user', content: 'user query' },
      ]
      const query = extractUserQuery(msgs)
      expect(query).not.toContain('assistant')
      expect(query).toContain('user query')
    })

    it('uses last 3 user messages', () => {
      const msgs = [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'user', content: 'third' },
        { role: 'user', content: 'fourth' },
      ]
      const query = extractUserQuery(msgs)
      expect(query).not.toContain('first')
      expect(query).toContain('second')
      expect(query).toContain('third')
      expect(query).toContain('fourth')
    })

    it('returns empty for no user messages', () => {
      expect(extractUserQuery([])).toBe('')
      expect(extractUserQuery([{ role: 'assistant', content: 'hi' }])).toBe('')
    })
  })

  describe('injectSkills', () => {
    it('returns unchanged when disabled (no learned skills)', async () => {
      const result = await injectSkills('original system', [
        { role: 'user', content: 'Fix eslint' },
      ], { disabled: true })
      expect(result.system).toBe('original system')
      expect(result.injectedIds).toEqual([])
    })

    it('returns unchanged when disabled (with learned skills)', async () => {
      await saveSkill(makeSkill('fix-eslint', 'Fix ESLint', ['eslint']))
      const result = await injectSkills('original', [
        { role: 'user', content: 'Fix eslint config' },
      ], { disabled: true })
      expect(result.system).toBe('original')
      expect(result.injectedIds).toEqual([])
    })

    it('injects matching skill into string system prompt', async () => {
      await saveSkill(makeSkill('fix-eslint', 'Fix ESLint', ['eslint', 'config', 'lint']))
      _resetIndex()

      const result = await injectSkills('You are a helpful assistant.', [
        { role: 'user', content: 'Fix the eslint config errors' },
      ])

      expect(result.injectedIds).toContain('fix-eslint')
      expect(typeof result.system).toBe('string')
      expect(result.system as string).toContain('learned_skills')
      expect(result.system as string).toContain('Fix ESLint')
      expect(result.system as string).toContain('You are a helpful assistant.')
    })

    it('injects into array system prompt', async () => {
      await saveSkill(makeSkill('fix-docker', 'Fix Docker', ['docker', 'compose', 'container']))
      _resetIndex()

      const system = [{ type: 'text', text: 'Base prompt' }]
      const result = await injectSkills(system, [
        { role: 'user', content: 'Docker compose fails to start' },
      ])

      expect(result.injectedIds).toContain('fix-docker')
      expect(Array.isArray(result.system)).toBe(true)
      const arr = result.system as Array<{ type: string; text: string }>
      expect(arr.length).toBe(2)
      expect(arr[1].text).toContain('Fix Docker')
    })

    it('creates system prompt when none exists', async () => {
      await saveSkill(makeSkill('fix-test', 'Fix Tests', ['test', 'vitest', 'jest']))
      _resetIndex()

      const result = await injectSkills(undefined, [
        { role: 'user', content: 'vitest tests are failing with import errors' },
      ])

      expect(result.injectedIds).toContain('fix-test')
      expect(typeof result.system).toBe('string')
      expect(result.system as string).toContain('Fix Tests')
    })

    it('returns matched skills with scores', async () => {
      await saveSkill(makeSkill('fix-eslint', 'Fix ESLint', ['eslint', 'config']))
      await saveSkill(makeSkill('fix-docker', 'Fix Docker', ['docker', 'compose']))
      _resetIndex()

      const result = await injectSkills('system', [
        { role: 'user', content: 'Fix the eslint config' },
      ])

      expect(result.matchedSkills.length).toBeGreaterThan(0)
      expect(result.matchedSkills[0].score).toBeGreaterThan(0)
    })

    it('respects topK option', async () => {
      await saveSkill(makeSkill('skill-one', 'Skill One', ['eslint', 'config']))
      await saveSkill(makeSkill('skill-two', 'Skill Two', ['eslint', 'lint']))
      await saveSkill(makeSkill('skill-three', 'Skill Three', ['eslint', 'fix']))
      _resetIndex()

      const result = await injectSkills('system', [
        { role: 'user', content: 'Fix the eslint config and lint errors' },
      ], { topK: 1 })

      expect(result.injectedIds.length).toBeLessThanOrEqual(1)
    })

    it('respects high threshold — filters low scores', async () => {
      await saveSkill(makeSkill('vague', 'Vague Skill', ['general']))
      _resetIndex()

      const result = await injectSkills('system', [
        { role: 'user', content: 'Fix the eslint config' },
      ], { threshold: 0.99 })

      expect(result.injectedIds).toEqual([])
    })
  })

  describe('invalidateSkillIndex', () => {
    it('forces re-index on next call', async () => {
      // First call builds index with 0 skills
      const result1 = await injectSkills('sys', [{ role: 'user', content: 'eslint' }])
      expect(result1.injectedIds).toEqual([])

      // Add skill and invalidate
      await saveSkill(makeSkill('fix-eslint', 'Fix ESLint', ['eslint', 'config', 'lint']))
      invalidateSkillIndex()

      // Now should find the skill
      const result2 = await injectSkills('sys', [
        { role: 'user', content: 'Fix the eslint config errors in the project' },
      ])
      expect(result2.injectedIds).toContain('fix-eslint')
    })
  })
})

import { afterEach } from 'vitest'
