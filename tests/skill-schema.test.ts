/**
 * Skill schema tests — SkillDocument types, rendering, ID validation.
 */
import { describe, it, expect } from 'vitest'
import {
  toMetadata,
  renderSkillMd,
  isValidSkillId,
  nameToId,
  type SkillDocument,
} from '../src/skills/schema.js'

function makeSkill(overrides: Partial<SkillDocument> = {}): SkillDocument {
  return {
    id: 'fix-eslint-config',
    name: 'Fix ESLint Config',
    description: 'Resolve common ESLint configuration errors in TypeScript projects.',
    procedure: [
      { order: 1, action: 'Check .eslintrc', detail: 'Verify extends and plugins fields' },
      { order: 2, action: 'Run eslint --debug', detail: 'Capture config resolution output' },
    ],
    pitfalls: [
      { description: 'Flat config vs legacy', mitigation: 'Check ESLint version — v9+ uses flat config by default' },
    ],
    verification: [
      { check: 'eslint . runs clean', expected: 'No errors or warnings' },
    ],
    tags: ['eslint', 'typescript', 'config'],
    whenToUse: 'When eslint throws configuration errors or rule conflicts.',
    createdFrom: '20260402-abc123',
    createdAt: '2026-04-02T10:00:00Z',
    updatedAt: '2026-04-02T10:00:00Z',
    useCount: 0,
    synthesisMode: 'template',
    ...overrides,
  }
}

describe('skill schema', () => {
  describe('toMetadata', () => {
    it('extracts metadata from full document', () => {
      const skill = makeSkill()
      const meta = toMetadata(skill)
      expect(meta.id).toBe('fix-eslint-config')
      expect(meta.name).toBe('Fix ESLint Config')
      expect(meta.tags).toEqual(['eslint', 'typescript', 'config'])
      expect(meta.useCount).toBe(0)
      expect(meta).not.toHaveProperty('procedure')
      expect(meta).not.toHaveProperty('pitfalls')
    })
  })

  describe('renderSkillMd', () => {
    it('renders all sections', () => {
      const md = renderSkillMd(makeSkill())
      expect(md).toContain('# Fix ESLint Config')
      expect(md).toContain('> Resolve common ESLint')
      expect(md).toContain('## Procedure')
      expect(md).toContain('1. **Check .eslintrc**')
      expect(md).toContain('## Pitfalls')
      expect(md).toContain('⚠️ **Flat config vs legacy**')
      expect(md).toContain('## Verification')
      expect(md).toContain('eslint . runs clean')
      expect(md).toContain('## Tags')
      expect(md).toContain('`eslint`')
    })

    it('omits empty sections', () => {
      const md = renderSkillMd(makeSkill({
        pitfalls: [],
        verification: [],
      }))
      expect(md).toContain('## Procedure')
      expect(md).not.toContain('## Pitfalls')
      expect(md).not.toContain('## Verification')
    })

    it('omits whenToUse if empty', () => {
      const md = renderSkillMd(makeSkill({ whenToUse: '' }))
      expect(md).not.toContain('## When to Use')
    })
  })

  describe('isValidSkillId', () => {
    it('accepts valid kebab-case IDs', () => {
      expect(isValidSkillId('fix-eslint')).toBe(true)
      expect(isValidSkillId('a-b')).toBe(true) // 3 chars is minimum
      expect(isValidSkillId('ab')).toBe(false) // 2 chars too short
      expect(isValidSkillId('abc')).toBe(true)
      expect(isValidSkillId('fix-typescript-eslint-config')).toBe(true)
    })

    it('rejects invalid IDs', () => {
      expect(isValidSkillId('')).toBe(false)
      expect(isValidSkillId('Fix-Eslint')).toBe(false) // uppercase
      expect(isValidSkillId('-fix')).toBe(false) // starts with dash
      expect(isValidSkillId('fix-')).toBe(false) // ends with dash
      expect(isValidSkillId('fix eslint')).toBe(false) // space
    })
  })

  describe('nameToId', () => {
    it('converts names to kebab-case IDs', () => {
      expect(nameToId('Fix ESLint Config')).toBe('fix-eslint-config')
      expect(nameToId('Handle  spaces  and---dashes')).toBe('handle-spaces-and-dashes')
      expect(nameToId('TypeScript + React')).toBe('typescript-react')
    })

    it('trims to 80 chars', () => {
      const long = 'A'.repeat(100)
      expect(nameToId(long).length).toBeLessThanOrEqual(80)
    })
  })
})
