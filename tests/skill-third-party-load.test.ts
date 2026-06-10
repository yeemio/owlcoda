import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeTreeIntegrity } from '../src/skills/vendor.js'
import { writeManifest } from '../src/skills/manifest.js'
import { loadVendoredThirdPartySkills } from '../src/skills/third-party.js'

let root: string
function vendorSkill(id: string, body: string) {
  const dir = join(root, '.owlcoda', 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), body)
  return dir
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'tp-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('loadVendoredThirdPartySkills', () => {
  it('loads a vendored skill with origin=third-party when integrity matches', async () => {
    const dir = vendorSkill('vendor-x', '# Vendor X\n\n> does X\n')
    const integrity = computeTreeIntegrity(dir)
    writeManifest(root, { version: 1, skills: [{
      id: 'vendor-x', source: 'https://e/r.git', requestedRef: 'v1', pinnedRef: 'sha',
      integrity, vendoredPath: '.owlcoda/skills/vendor-x', origin: 'third-party', addedAt: 'x',
    }]})
    const skills = await loadVendoredThirdPartySkills(root)
    expect(skills).toHaveLength(1)
    expect(skills[0].id).toBe('vendor-x')
    expect(skills[0].origin).toBe('third-party')
  })

  it('refuses to load on integrity mismatch', async () => {
    const dir = vendorSkill('vendor-y', '# Vendor Y\n')
    const integrity = computeTreeIntegrity(dir)
    writeFileSync(join(dir, 'SKILL.md'), '# Tampered\n')
    writeManifest(root, { version: 1, skills: [{
      id: 'vendor-y', source: 'https://e/r.git', requestedRef: 'v1', pinnedRef: 'sha',
      integrity, vendoredPath: '.owlcoda/skills/vendor-y', origin: 'third-party', addedAt: 'x',
    }]})
    const skills = await loadVendoredThirdPartySkills(root)
    expect(skills).toHaveLength(0)
  })

  it('refuses to load vendoredPath entries outside the managed skills directory', async () => {
    const dir = join(root, '.owlcoda', 'outside')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '# Outside\n')
    const integrity = computeTreeIntegrity(dir)
    writeManifest(root, { version: 1, skills: [{
      id: 'vendor-z', source: 'https://e/r.git', requestedRef: 'v1', pinnedRef: 'sha',
      integrity, vendoredPath: '.owlcoda/skills/../outside', origin: 'third-party', addedAt: 'x',
    }]})
    const skills = await loadVendoredThirdPartySkills(root)
    expect(skills).toHaveLength(0)
  })
})
