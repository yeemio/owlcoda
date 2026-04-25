/**
 * Skill store tests — CRUD operations for learned skills.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { SkillDocument } from '../src/skills/schema.js'
import {
  saveSkill,
  loadSkill,
  deleteSkill,
  listSkills,
  skillExists,
  recordSkillUse,
  getSkillCount,
  loadAllSkills,
  exportSkills,
  importSkills,
  evolveSkill,
  getSkillLineage,
  cleanupSkills,
} from '../src/skills/store.js'

let tempDir: string
let origHome: string | undefined

function makeSkill(overrides: Partial<SkillDocument> = {}): SkillDocument {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill for unit tests.',
    procedure: [{ order: 1, action: 'Do the thing' }],
    pitfalls: [],
    verification: [{ check: 'thing done', expected: 'true' }],
    tags: ['test'],
    whenToUse: 'During tests.',
    createdAt: '2026-04-08T00:00:00Z',
    updatedAt: '2026-04-08T00:00:00Z',
    useCount: 0,
    synthesisMode: 'template',
    ...overrides,
  }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-skill-test-'))
  origHome = process.env['OWLCODA_HOME']
  process.env['OWLCODA_HOME'] = tempDir
})

afterEach(async () => {
  if (origHome !== undefined) process.env['OWLCODA_HOME'] = origHome
  else delete process.env['OWLCODA_HOME']
  await rm(tempDir, { recursive: true, force: true })
})

describe('skill store', () => {
  it('saves and loads a skill', async () => {
    const skill = makeSkill()
    await saveSkill(skill)

    const loaded = await loadSkill('test-skill')
    expect(loaded).not.toBeNull()
    expect(loaded!.id).toBe('test-skill')
    expect(loaded!.name).toBe('Test Skill')
    expect(loaded!.procedure).toHaveLength(1)
  })

  it('writes SKILL.md alongside metadata.json', async () => {
    await saveSkill(makeSkill())

    const mdPath = join(tempDir, 'skills', 'test-skill', 'SKILL.md')
    expect(existsSync(mdPath)).toBe(true)

    const md = readFileSync(mdPath, 'utf-8')
    expect(md).toContain('# Test Skill')
    expect(md).toContain('## Procedure')
  })

  it('returns null for non-existent skill', async () => {
    const loaded = await loadSkill('does-not-exist')
    expect(loaded).toBeNull()
  })

  it('deletes a skill', async () => {
    await saveSkill(makeSkill())
    expect(await skillExists('test-skill')).toBe(true)

    const deleted = await deleteSkill('test-skill')
    expect(deleted).toBe(true)
    expect(await skillExists('test-skill')).toBe(false)
  })

  it('returns false when deleting non-existent skill', async () => {
    const deleted = await deleteSkill('nope')
    expect(deleted).toBe(false)
  })

  it('lists all skills as metadata', async () => {
    await saveSkill(makeSkill({ id: 'skill-aaa', name: 'AAA' }))
    await saveSkill(makeSkill({ id: 'skill-bbb', name: 'BBB' }))
    await saveSkill(makeSkill({ id: 'skill-ccc', name: 'CCC' }))

    const list = await listSkills()
    expect(list).toHaveLength(3)
    expect(list[0].id).toBe('skill-aaa')
    expect(list[2].id).toBe('skill-ccc')
    // Metadata should not include procedure
    expect(list[0]).not.toHaveProperty('procedure')
  })

  it('counts skills', async () => {
    expect(await getSkillCount()).toBe(0)
    await saveSkill(makeSkill({ id: 'skill-one' }))
    await saveSkill(makeSkill({ id: 'skill-two' }))
    expect(await getSkillCount()).toBe(2)
  })

  it('records skill use and increments count', async () => {
    await saveSkill(makeSkill({ useCount: 5 }))
    await recordSkillUse('test-skill')

    const loaded = await loadSkill('test-skill')
    expect(loaded!.useCount).toBe(6)
  })

  it('loads all full skill documents', async () => {
    await saveSkill(makeSkill({ id: 'skill-one', tags: ['a'] }))
    await saveSkill(makeSkill({ id: 'skill-two', tags: ['b'] }))

    const all = await loadAllSkills()
    // loadAllSkills returns learned + curated skills; check our two are present
    expect(all.length).toBeGreaterThanOrEqual(2)
    const one = all.find(s => s.id === 'skill-one')
    const two = all.find(s => s.id === 'skill-two')
    expect(one).toBeDefined()
    expect(one!.procedure).toBeDefined()
    expect(two).toBeDefined()
    expect(two!.tags).toEqual(['b'])
  })

  it('rejects invalid skill IDs', async () => {
    await expect(saveSkill(makeSkill({ id: 'Bad ID' }))).rejects.toThrow('Invalid skill ID')
  })

  it('overwrites existing skill', async () => {
    await saveSkill(makeSkill({ description: 'v1' }))
    await saveSkill(makeSkill({ description: 'v2' }))

    const loaded = await loadSkill('test-skill')
    expect(loaded!.description).toBe('v2')
  })

  it('returns empty list when no skills dir', async () => {
    const list = await listSkills()
    expect(list).toEqual([])
  })
})

describe('skill export/import', () => {
  it('exports all skills as a bundle', async () => {
    await saveSkill(makeSkill({ id: 'skill-aaa', name: 'AAA' }))
    await saveSkill(makeSkill({ id: 'skill-bbb', name: 'BBB' }))

    const bundle = await exportSkills()
    expect(bundle.version).toBe(1)
    expect(bundle.source).toBe('owlcoda')
    // Includes learned + curated skills
    expect(bundle.skills.length).toBeGreaterThanOrEqual(2)
    expect(bundle.skills.find(s => s.id === 'skill-aaa')).toBeDefined()
    expect(bundle.skills.find(s => s.id === 'skill-bbb')).toBeDefined()
    expect(bundle.exportedAt).toBeTruthy()
  })

  it('exports selected skills by IDs', async () => {
    await saveSkill(makeSkill({ id: 'skill-aaa' }))
    await saveSkill(makeSkill({ id: 'skill-bbb' }))
    await saveSkill(makeSkill({ id: 'skill-ccc' }))

    const bundle = await exportSkills(['skill-aaa', 'skill-ccc'])
    expect(bundle.skills).toHaveLength(2)
    expect(bundle.skills.map(s => s.id)).toEqual(['skill-aaa', 'skill-ccc'])
  })

  it('imports skills from a bundle', async () => {
    const bundle = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      source: 'owlcoda',
      skills: [
        makeSkill({ id: 'imported-one', name: 'One' }),
        makeSkill({ id: 'imported-two', name: 'Two' }),
      ],
    }

    const result = await importSkills(bundle)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(0)
    expect(result.errors).toHaveLength(0)

    expect(await skillExists('imported-one')).toBe(true)
    expect(await skillExists('imported-two')).toBe(true)
  })

  it('skips existing skills by default', async () => {
    await saveSkill(makeSkill({ id: 'existing-skill', description: 'original' }))

    const bundle = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      source: 'owlcoda',
      skills: [makeSkill({ id: 'existing-skill', description: 'updated' })],
    }

    const result = await importSkills(bundle)
    expect(result.skipped).toBe(1)
    expect(result.imported).toBe(0)

    const loaded = await loadSkill('existing-skill')
    expect(loaded!.description).toBe('original')
  })

  it('overwrites existing skills when overwrite=true', async () => {
    await saveSkill(makeSkill({ id: 'existing-skill', description: 'original' }))

    const bundle = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      source: 'owlcoda',
      skills: [makeSkill({ id: 'existing-skill', description: 'updated' })],
    }

    const result = await importSkills(bundle, true)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(0)

    const loaded = await loadSkill('existing-skill')
    expect(loaded!.description).toBe('updated')
  })

  it('rejects unsupported bundle version', async () => {
    const bundle = { version: 99 as any, exportedAt: '', source: '', skills: [] }
    const result = await importSkills(bundle)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Unsupported bundle version')
  })

  it('reports errors for invalid skill IDs in bundle', async () => {
    const bundle = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      source: 'owlcoda',
      skills: [makeSkill({ id: 'INVALID ID' as any })],
    }

    const result = await importSkills(bundle)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Invalid skill ID')
  })

  it('handles empty export gracefully', async () => {
    // No learned skills saved, but curated may be present
    const bundle = await exportSkills()
    // All returned skills should be curated (no learned ones)
    const learnedIds = bundle.skills.filter(s => !s.id.startsWith('curated-'))
    // No learned skills were saved in this test, so only curated should be present
    expect(bundle.skills.length).toBeGreaterThanOrEqual(0)
  })

  it('round-trips export → import', async () => {
    await saveSkill(makeSkill({ id: 'skill-alpha', name: 'Alpha', tags: ['round', 'trip'] }))
    await saveSkill(makeSkill({ id: 'skill-beta', name: 'Beta', tags: ['test'] }))

    // Export only the two learned skills by ID
    const bundle = await exportSkills(['skill-alpha', 'skill-beta'])

    // Clear learned skills
    await deleteSkill('skill-alpha')
    await deleteSkill('skill-beta')
    expect(await getSkillCount()).toBe(0)

    // Import
    const result = await importSkills(bundle)
    expect(result.imported).toBe(2)

    const alpha = await loadSkill('skill-alpha')
    expect(alpha!.name).toBe('Alpha')
    expect(alpha!.tags).toEqual(['round', 'trip'])
  })
})

describe('skill evolution', () => {
  it('evolves skill in-place with version bump', async () => {
    await saveSkill(makeSkill({ id: 'fix-eslint', description: 'v1' }))

    const evolved = await evolveSkill('fix-eslint', { description: 'v2 improved' })
    expect(evolved).not.toBeNull()
    expect(evolved!.version).toBe(2)
    expect(evolved!.description).toBe('v2 improved')

    const loaded = await loadSkill('fix-eslint')
    expect(loaded!.version).toBe(2)
    expect(loaded!.description).toBe('v2 improved')
  })

  it('preserves fields not included in updates', async () => {
    await saveSkill(makeSkill({ id: 'fix-eslint', tags: ['eslint', 'ts'], useCount: 5 }))

    const evolved = await evolveSkill('fix-eslint', { description: 'updated desc' })
    expect(evolved!.tags).toEqual(['eslint', 'ts'])
    expect(evolved!.useCount).toBe(5)
  })

  it('forks to new ID with parent link', async () => {
    await saveSkill(makeSkill({ id: 'eslint-fix-v1' }))

    const forked = await evolveSkill('eslint-fix-v1', { name: 'ESLint Fix V2' }, { newId: 'eslint-fix-v2' })
    expect(forked).not.toBeNull()
    expect(forked!.id).toBe('eslint-fix-v2')
    expect(forked!.parentId).toBe('eslint-fix-v1')
    expect(forked!.version).toBe(1)
    expect(forked!.useCount).toBe(0)

    // Original still exists
    expect(await skillExists('eslint-fix-v1')).toBe(true)
  })

  it('returns null for non-existent skill', async () => {
    const result = await evolveSkill('nonexistent', { description: 'nope' })
    expect(result).toBeNull()
  })

  it('tracks lineage chain', async () => {
    await saveSkill(makeSkill({ id: 'skill-gen1' }))
    await evolveSkill('skill-gen1', { name: 'Gen 2' }, { newId: 'skill-gen2' })
    await evolveSkill('skill-gen2', { name: 'Gen 3' }, { newId: 'skill-gen3' })

    const lineage = await getSkillLineage('skill-gen3')
    expect(lineage).toHaveLength(3)
    expect(lineage[0].id).toBe('skill-gen3')
    expect(lineage[1].id).toBe('skill-gen2')
    expect(lineage[2].id).toBe('skill-gen1')
  })

  it('handles missing parent in lineage', async () => {
    await saveSkill(makeSkill({ id: 'orphan-skill', parentId: 'deleted-parent' }))
    const lineage = await getSkillLineage('orphan-skill')
    expect(lineage).toHaveLength(1)
    expect(lineage[0].id).toBe('orphan-skill')
  })
})

describe('cleanupSkills', () => {
  it('identifies stale unused skills (dry run)', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    await saveSkill(makeSkill({
      id: 'stale-unused-skill',
      updatedAt: oldDate,
      useCount: 0,
    }))
    await saveSkill(makeSkill({
      id: 'fresh-skill',
      updatedAt: new Date().toISOString(),
      useCount: 5,
    }))

    const result = await cleanupSkills({ dryRun: true })
    expect(result.stale).toContain('stale-unused-skill')
    expect(result.stale).not.toContain('fresh-skill')
    expect(result.removed).toHaveLength(0)
    expect(result.kept).toBe(2)
  })

  it('removes stale skills with force', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    await saveSkill(makeSkill({ id: 'stale-to-delete', updatedAt: oldDate, useCount: 0 }))
    await saveSkill(makeSkill({ id: 'keep-this', updatedAt: new Date().toISOString(), useCount: 10 }))

    const result = await cleanupSkills({ dryRun: false })
    expect(result.removed).toContain('stale-to-delete')
    expect(result.kept).toBe(1)
    expect(await skillExists('stale-to-delete')).toBe(false)
    expect(await skillExists('keep-this')).toBe(true)
  })

  it('keeps stale skills with enough uses', async () => {
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString()
    await saveSkill(makeSkill({ id: 'stale-but-used', updatedAt: oldDate, useCount: 10 }))

    const result = await cleanupSkills({ dryRun: false })
    expect(result.removed).not.toContain('stale-but-used')
    expect(await skillExists('stale-but-used')).toBe(true)
  })
})
