import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readManifest, writeManifest, manifestPath, type ThirdPartySkillEntry } from '../src/skills/manifest.js'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'skill-proj-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const entry: ThirdPartySkillEntry = {
  id: 'vendor-web-design', source: 'https://example.com/repo.git', requestedRef: 'v1', pinnedRef: 'abc123',
  skillPath: 'skills/web-design', integrity: 'sha256:deadbeef', vendoredPath: '.owlcoda/skills/vendor-web-design',
  origin: 'third-party', addedAt: '2026-06-04T00:00:00.000Z',
}

describe('manifest', () => {
  it('returns empty manifest when absent', () => {
    expect(readManifest(root)).toEqual({ version: 1, skills: [] })
  })
  it('round-trips an entry and creates .owlcoda', () => {
    writeManifest(root, { version: 1, skills: [entry] })
    expect(existsSync(manifestPath(root))).toBe(true)
    expect(readManifest(root).skills[0].id).toBe('vendor-web-design')
  })
  it('rejects a malformed manifest', () => {
    writeManifest(root, { version: 1, skills: [entry] })
    writeFileSync(manifestPath(root), '{"version":2}')
    expect(() => readManifest(root)).toThrow(/Invalid/)
  })
})
