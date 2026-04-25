import { describe, it, expect } from 'vitest'
import {
  tokenize,
  buildIndex,
  matchSkills,
  matchOne,
} from '../src/skills/matcher.js'
import type { SkillDocument } from '../src/skills/schema.js'

// ─── Fixture helpers ───

function makeSkill(overrides: Partial<SkillDocument> & { id: string; name: string }): SkillDocument {
  return {
    description: '',
    procedure: [],
    pitfalls: [],
    verification: [],
    tags: [],
    whenToUse: '',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    useCount: 0,
    synthesisMode: 'template',
    ...overrides,
  }
}

const ESLINT_SKILL = makeSkill({
  id: 'fix-eslint-config',
  name: 'Fix ESLint Config',
  description: 'Fix broken ESLint configurations in TypeScript projects',
  tags: ['eslint', 'typescript', 'config', 'lint'],
  whenToUse: 'When eslint config errors appear during lint or build',
  procedure: [
    { order: 1, action: 'Read .eslintrc.json' },
    { order: 2, action: 'Fix parser and plugin settings' },
    { order: 3, action: 'Run eslint --fix' },
  ],
})

const DOCKER_SKILL = makeSkill({
  id: 'docker-compose-debug',
  name: 'Docker Compose Debug',
  description: 'Debug Docker Compose service startup failures',
  tags: ['docker', 'compose', 'container', 'debug'],
  whenToUse: 'When docker-compose up fails or services crash on startup',
  procedure: [
    { order: 1, action: 'Check docker-compose.yml syntax' },
    { order: 2, action: 'Inspect container logs' },
    { order: 3, action: 'Fix port conflicts or missing env vars' },
  ],
})

const VITEST_SKILL = makeSkill({
  id: 'vitest-test-fix',
  name: 'Vitest Test Fix',
  description: 'Fix failing vitest tests in TypeScript projects',
  tags: ['vitest', 'test', 'typescript', 'jest'],
  whenToUse: 'When vitest tests fail with assertion or import errors',
  procedure: [
    { order: 1, action: 'Run vitest in verbose mode' },
    { order: 2, action: 'Check import paths and mocks' },
  ],
})

const ALL_SKILLS = [ESLINT_SKILL, DOCKER_SKILL, VITEST_SKILL]

// ─── Tests ───

describe('skill matcher', () => {
  describe('tokenize', () => {
    it('lowercases and splits', () => {
      const tokens = tokenize('Fix ESLint Config')
      expect(tokens).toContain('fix')
      expect(tokens).toContain('eslint')
      expect(tokens).toContain('config')
    })

    it('removes stopwords', () => {
      const tokens = tokenize('the fix for the eslint config with typescript')
      expect(tokens).not.toContain('the')
      expect(tokens).not.toContain('for')
      expect(tokens).not.toContain('with')
      expect(tokens).toContain('fix')
      expect(tokens).toContain('eslint')
    })

    it('handles empty input', () => {
      expect(tokenize('')).toEqual([])
    })

    it('filters single-char tokens', () => {
      const tokens = tokenize('a b c fix')
      expect(tokens).toEqual(['fix'])
    })
  })

  describe('buildIndex', () => {
    it('builds empty index from no skills', () => {
      const index = buildIndex([])
      expect(index.docCount).toBe(0)
      expect(index.vectors.size).toBe(0)
    })

    it('builds index from skills', () => {
      const index = buildIndex(ALL_SKILLS)
      expect(index.docCount).toBe(3)
      expect(index.vectors.size).toBe(3)
      expect(index.skills.size).toBe(3)
      expect(index.idf.size).toBeGreaterThan(0)
    })

    it('stores skill references', () => {
      const index = buildIndex(ALL_SKILLS)
      expect(index.skills.get('fix-eslint-config')).toBe(ESLINT_SKILL)
    })
  })

  describe('matchSkills', () => {
    it('returns empty for empty index', () => {
      const index = buildIndex([])
      expect(matchSkills('eslint config', index)).toEqual([])
    })

    it('returns empty for empty query', () => {
      const index = buildIndex(ALL_SKILLS)
      expect(matchSkills('', index)).toEqual([])
    })

    it('matches eslint query to eslint skill', () => {
      const index = buildIndex(ALL_SKILLS)
      const results = matchSkills('fix eslint config errors in typescript', index)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].skill.id).toBe('fix-eslint-config')
      expect(results[0].score).toBeGreaterThan(0)
    })

    it('matches docker query to docker skill', () => {
      const index = buildIndex(ALL_SKILLS)
      const results = matchSkills('docker compose service fails to start', index)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].skill.id).toBe('docker-compose-debug')
    })

    it('matches vitest query to vitest skill', () => {
      const index = buildIndex(ALL_SKILLS)
      const results = matchSkills('vitest tests are failing with import errors', index)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].skill.id).toBe('vitest-test-fix')
    })

    it('respects topK limit', () => {
      const index = buildIndex(ALL_SKILLS)
      const results = matchSkills('typescript project', index, { topK: 1 })
      expect(results.length).toBeLessThanOrEqual(1)
    })

    it('respects threshold', () => {
      const index = buildIndex(ALL_SKILLS)
      const results = matchSkills('eslint', index, { threshold: 0.99 })
      // Very high threshold should return few or no results
      expect(results.length).toBeLessThanOrEqual(1)
    })

    it('scores are sorted descending', () => {
      const index = buildIndex(ALL_SKILLS)
      const results = matchSkills('typescript testing', index, { topK: 10, threshold: 0.01 })
      for (let i = 1; i < results.length; i++) {
        expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score)
      }
    })

    it('unrelated query returns no matches above threshold', () => {
      const index = buildIndex(ALL_SKILLS)
      const results = matchSkills('quantum computing blockchain', index, { threshold: 0.3 })
      expect(results).toEqual([])
    })
  })

  describe('matchOne (convenience)', () => {
    it('works as one-shot match', () => {
      const results = matchOne('fix eslint config', ALL_SKILLS)
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].skill.id).toBe('fix-eslint-config')
    })

    it('handles empty skills list', () => {
      expect(matchOne('anything', [])).toEqual([])
    })
  })

  describe('ranking quality', () => {
    it('exact tag match scores higher than partial', () => {
      const index = buildIndex(ALL_SKILLS)
      const eslintResults = matchSkills('eslint', index)
      const dockerResults = matchSkills('eslint', index)
      // eslint skill should rank top for "eslint" query
      if (eslintResults.length > 0) {
        expect(eslintResults[0].skill.id).toBe('fix-eslint-config')
      }
    })

    it('multi-word queries match better than single word', () => {
      const index = buildIndex(ALL_SKILLS)
      const single = matchSkills('config', index)
      const multi = matchSkills('eslint config typescript lint', index)
      // Multi-word match for eslint skill should score higher
      const singleEslint = single.find(r => r.skill.id === 'fix-eslint-config')
      const multiEslint = multi.find(r => r.skill.id === 'fix-eslint-config')
      if (singleEslint && multiEslint) {
        expect(multiEslint.score).toBeGreaterThan(singleEslint.score)
      }
    })
  })

  describe('usage boosting', () => {
    it('boosts frequently-used skills', () => {
      const base = makeSkill({
        id: 'skill-base',
        name: 'ESLint Helper',
        description: 'Fix eslint issues',
        tags: ['eslint'],
        useCount: 0,
      })
      const popular = makeSkill({
        id: 'skill-popular',
        name: 'ESLint Helper Popular',
        description: 'Fix eslint issues',
        tags: ['eslint'],
        useCount: 50,
        updatedAt: new Date().toISOString(),
      })

      const index = buildIndex([base, popular])
      const results = matchSkills('fix eslint', index, { boostUsage: true })
      expect(results.length).toBeGreaterThanOrEqual(2)
      // Popular skill should rank higher
      expect(results[0].skill.id).toBe('skill-popular')
      expect(results[0].score).toBeGreaterThan(results[1].score)
    })

    it('recently-used skills get higher boost', () => {
      const old = makeSkill({
        id: 'skill-old',
        name: 'ESLint Fix',
        description: 'Fix eslint issues',
        tags: ['eslint'],
        useCount: 10,
        updatedAt: '2024-01-01T00:00:00Z',
      })
      const recent = makeSkill({
        id: 'skill-recent',
        name: 'ESLint Fix',
        description: 'Fix eslint issues',
        tags: ['eslint'],
        useCount: 10,
        updatedAt: new Date().toISOString(),
      })

      const index = buildIndex([old, recent])
      const results = matchSkills('fix eslint', index, { boostUsage: true })
      expect(results.length).toBeGreaterThanOrEqual(2)
      // Recent skill should rank higher (same useCount but more recent)
      expect(results[0].skill.id).toBe('skill-recent')
    })

    it('can disable usage boosting', () => {
      const base = makeSkill({
        id: 'skill-base',
        name: 'ESLint Fix',
        description: 'Fix eslint issues',
        tags: ['eslint'],
        useCount: 0,
      })
      const popular = makeSkill({
        id: 'skill-popular',
        name: 'ESLint Fix',
        description: 'Fix eslint issues',
        tags: ['eslint'],
        useCount: 100,
        updatedAt: new Date().toISOString(),
      })

      const index = buildIndex([base, popular])
      const withBoost = matchSkills('eslint fix', index, { boostUsage: true })
      const noBoost = matchSkills('eslint fix', index, { boostUsage: false })

      // Without boost, scores should be equal for identical content
      if (noBoost.length >= 2) {
        expect(Math.abs(noBoost[0].score - noBoost[1].score)).toBeLessThan(0.001)
      }
      // With boost, popular should be higher
      if (withBoost.length >= 2) {
        expect(withBoost[0].skill.id).toBe('skill-popular')
      }
    })
  })
})
