import { describe, it, expect } from 'vitest'
import { parseFrontmatter, curatedToDocument, loadCuratedSkills, getCuratedSkillsDir } from '../src/skills/curated.js'
import { existsSync } from 'node:fs'

// ─── parseFrontmatter ───

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter and body', () => {
    const content = `---
name: Test Skill
description: A test description
when_to_use: when testing
---

# Test Skill

Some body content.`

    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.name).toBe('Test Skill')
    expect(frontmatter.description).toBe('A test description')
    expect(frontmatter.when_to_use).toBe('when testing')
    expect(body).toContain('# Test Skill')
    expect(body).toContain('Some body content.')
  })

  it('returns empty frontmatter for content without frontmatter', () => {
    const content = '# No Frontmatter\n\nJust a body.'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter).toEqual({})
    expect(body).toBe(content)
  })

  it('handles multi-value frontmatter', () => {
    const content = `---
name: Multi Lang
languages: python, typescript
version: 2.0
---

Body.`

    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.name).toBe('Multi Lang')
    expect(frontmatter.languages).toBe('python, typescript')
    expect(frontmatter.version).toBe('2.0')
  })
})

// ─── curatedToDocument ───

describe('curatedToDocument', () => {
  it('converts SKILL.md content to SkillDocument', () => {
    const content = `---
name: Systematic Debugging
description: Four-phase debugging framework
when_to_use: when encountering any bug
---

# Systematic Debugging

## Phase 1: Observe
Collect information before acting.

## Phase 2: Hypothesize
Form a theory about the root cause.`

    const doc = curatedToDocument('systematic-debugging', 'debugging/systematic-debugging', content)

    expect(doc.id).toBe('systematic-debugging')
    expect(doc.name).toBe('Systematic Debugging')
    expect(doc.description).toBe('Four-phase debugging framework')
    expect(doc.whenToUse).toBe('when encountering any bug')
    expect(doc.synthesisMode).toBe('manual')
    expect(doc.useCount).toBe(0)
    expect(doc.tags).toContain('debugging')
    expect(doc.procedure.length).toBeGreaterThan(0)
  })

  it('derives name from ID when frontmatter has no name', () => {
    const doc = curatedToDocument('my-cool-skill', 'my-cool-skill', '# Content')
    expect(doc.name).toBe('My Cool Skill')
  })

  it('extracts category tag from nested path', () => {
    const doc = curatedToDocument('brainstorming', 'collaboration/brainstorming', '---\nname: Brainstorming\ndescription: x\n---\n# Body')
    expect(doc.tags).toContain('collaboration')
  })

  it('returns valid SkillDocument with all required fields', () => {
    const doc = curatedToDocument('test-skill', 'test-skill', '---\nname: Test\ndescription: Desc\n---\n# Body')
    expect(doc).toHaveProperty('id')
    expect(doc).toHaveProperty('name')
    expect(doc).toHaveProperty('description')
    expect(doc).toHaveProperty('procedure')
    expect(doc).toHaveProperty('pitfalls')
    expect(doc).toHaveProperty('verification')
    expect(doc).toHaveProperty('tags')
    expect(doc).toHaveProperty('whenToUse')
    expect(doc).toHaveProperty('createdAt')
    expect(doc).toHaveProperty('updatedAt')
    expect(doc).toHaveProperty('useCount')
    expect(doc).toHaveProperty('synthesisMode')
  })
})

// ─── loadCuratedSkills (integration) ───

describe('loadCuratedSkills', () => {
  it('loads skills from the project skills/ directory', async () => {
    const dir = getCuratedSkillsDir()
    if (!existsSync(dir)) {
      // Skip if running outside project
      return
    }

    const skills = await loadCuratedSkills()
    // Curated skill pack has at least 10 entries; lower bound is a
    // sanity check, not a quota.
    expect(skills.length).toBeGreaterThan(10)
    // Each skill has required fields
    for (const s of skills) {
      expect(s.id).toBeTruthy()
      expect(s.name).toBeTruthy()
      expect(typeof s.description).toBe('string')
      expect(Array.isArray(s.tags)).toBe(true)
      expect(Array.isArray(s.procedure)).toBe(true)
    }
  })

  it('produces unique IDs', async () => {
    const dir = getCuratedSkillsDir()
    if (!existsSync(dir)) return

    const skills = await loadCuratedSkills()
    const ids = skills.map(s => s.id)
    const unique = new Set(ids)
    expect(unique.size).toBe(ids.length)
  })
})

// ─── loadAllSkills merge (integration) ───

describe('loadAllSkills merge', () => {
  it('includes curated skills when no learned skills exist', async () => {
    const { loadAllSkills } = await import('../src/skills/store.js')
    const all = await loadAllSkills()
    // Should include curated skills
    expect(all.length).toBeGreaterThan(0)
    // Should include known curated skill IDs
    const ids = new Set(all.map(s => s.id))
    // At least some well-known curated skills should be present
    const wellKnown = ['systematic-debugging', 'test-driven-development', 'brainstorming']
    for (const wk of wellKnown) {
      expect(ids.has(wk)).toBe(true)
    }
  })
})
