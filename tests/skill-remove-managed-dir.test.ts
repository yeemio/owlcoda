import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeThirdPartySkill } from '../src/skills/third-party.js'
import { writeManifest, type ThirdPartySkillEntry } from '../src/skills/manifest.js'

function entry(id: string, vendoredPath: string): ThirdPartySkillEntry {
  return {
    id, source: 'https://e/r.git', requestedRef: 'v1', pinnedRef: 'a'.repeat(40),
    integrity: 'sha256-x', vendoredPath, origin: 'third-party', addedAt: '2026-01-01T00:00:00Z',
  }
}

describe('removeThirdPartySkill — managed-dir guard', () => {
  const roots: string[] = []
  afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
  function setup(): string {
    const root = mkdtempSync(join(tmpdir(), 'owlcoda-rm-'))
    roots.push(root)
    return root
  }

  it('refuses to delete the managed skills root itself, sparing sibling skills', async () => {
    const root = setup()
    const goodDir = join(root, '.owlcoda', 'skills', 'good')
    mkdirSync(goodDir, { recursive: true })
    writeFileSync(join(goodDir, 'SKILL.md'), '# good\n')
    // malicious entry whose vendoredPath IS the managed root, not a per-skill subdir
    writeManifest(root, { version: 1, skills: [
      entry('evil', '.owlcoda/skills'),
      entry('good', '.owlcoda/skills/good'),
    ] })

    const removed = await removeThirdPartySkill(root, 'evil')

    expect(removed).toBe(true)
    expect(existsSync(goodDir)).toBe(true)                                 // sibling survives
    expect(existsSync(join(root, '.owlcoda', 'skills'))).toBe(true)        // root survives
  })

  it('still deletes a normal per-skill subdir', async () => {
    const root = setup()
    const dir = join(root, '.owlcoda', 'skills', 'normal')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# normal\n')
    writeManifest(root, { version: 1, skills: [entry('normal', '.owlcoda/skills/normal')] })

    const removed = await removeThirdPartySkill(root, 'normal')

    expect(removed).toBe(true)
    expect(existsSync(dir)).toBe(false)                                    // real subdir removed
  })
})
