import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest } from '../src/skills/manifest.js'
import { removeThirdPartySkill, listThirdPartySkills } from '../src/skills/third-party.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cli-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('skills list/remove', () => {
  it('remove drops the manifest entry and the vendored dir', async () => {
    const dir = join(root, '.owlcoda', 'skills', 'vendor-x'); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# x\n')
    writeManifest(root, { version: 1, skills: [{
      id: 'vendor-x', source: 's', requestedRef: 'r', pinnedRef: 'p', integrity: 'sha256:x',
      vendoredPath: '.owlcoda/skills/vendor-x', origin: 'third-party', addedAt: 'a',
    }]})
    expect(listThirdPartySkills(root)).toHaveLength(1)
    await removeThirdPartySkill(root, 'vendor-x')
    expect(readManifest(root).skills).toHaveLength(0)
    expect(existsSync(dir)).toBe(false)
  })
})
