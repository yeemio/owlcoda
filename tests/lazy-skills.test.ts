import { afterEach, describe, expect, it } from 'vitest'
import { buildSkillCatalog, isLazySkillsEnabled } from '../src/skills/lazy-skills.js'
import { injectSkills, _resetIndex } from '../src/skills/injection.js'

const skills = [
  { id: 'using-git-worktrees', name: 'Using Git Worktrees', description: 'Isolate feature work in a worktree.', whenToUse: 'starting isolated work' },
  { id: 'systematic-debugging', name: 'Systematic Debugging', description: 'Find root cause before fixing.' },
]

describe('buildSkillCatalog', () => {
  it('lists every skill with id, name and description', () => {
    const m = buildSkillCatalog(skills)
    expect(m).toContain('using-git-worktrees')
    expect(m).toContain('Using Git Worktrees')
    expect(m).toContain('Isolate feature work in a worktree.')
    expect(m).toContain('systematic-debugging')
  })

  it('includes whenToUse when present', () => {
    expect(buildSkillCatalog(skills)).toContain('starting isolated work')
  })

  it('tells the model how to load a body on demand (reuses the Skill tool)', () => {
    const m = buildSkillCatalog(skills)
    expect(m).toContain('Skill(')
    expect(m).toContain('run')
  })

  it('handles an empty skill set without throwing', () => {
    expect(typeof buildSkillCatalog([])).toBe('string')
  })
})

describe('isLazySkillsEnabled', () => {
  it('defaults OFF (opt-in) when unset', () => {
    expect(isLazySkillsEnabled({})).toBe(false)
  })
  it('honors truthy and falsy values', () => {
    expect(isLazySkillsEnabled({ OWLCODA_LAZY_SKILLS: '1' })).toBe(true)
    expect(isLazySkillsEnabled({ OWLCODA_LAZY_SKILLS: 'off' })).toBe(false)
  })
})

describe('injectSkills — lazy mode wiring', () => {
  afterEach(() => _resetIndex())

  it('injects a name-only catalog of all skills when lazy is on', async () => {
    const r = await injectSkills('SYS', [{ role: 'user', content: 'help' }], {
      projectRoot: process.cwd(),
      lazy: true,
    })
    expect(String(r.system)).toContain('<skill_catalog>')
    expect(String(r.system)).toContain('Skill(')
    expect(r.injectedIds).toEqual(['skill-catalog'])
    expect(r.matchedSkills).toEqual([])
  })

  it('does NOT inject the catalog when lazy is off (eager path unchanged)', async () => {
    const r = await injectSkills('SYS', [{ role: 'user', content: 'help me debug a failing test' }], {
      projectRoot: process.cwd(),
      lazy: false,
    })
    expect(String(r.system ?? '')).not.toContain('<skill_catalog>')
  })
})
