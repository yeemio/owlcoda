import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAllSkills } from '../src/skills/store.js'

let foreignRoot: string
beforeEach(() => { foreignRoot = mkdtempSync(join(tmpdir(), 'foreign-proj-')) })  // a project with NO skills/ dir
afterEach(() => { rmSync(foreignRoot, { recursive: true, force: true }) })

describe('curated skills are package-relative, not project-relative', () => {
  it('loads the bundled first-party skills even when projectRoot is a foreign dir', async () => {
    const skills = await loadAllSkills(foreignRoot)
    // The bundled first-party set must still be present regardless of projectRoot.
    expect(skills.length).toBeGreaterThanOrEqual(40)
    expect(skills.some(s => s.id === 'test-driven-development')).toBe(true)
  })
})
