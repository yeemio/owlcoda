import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeTreeIntegrity, verifyTreeIntegrity, vendorSkillDir } from '../src/skills/vendor.js'

let src: string, dest: string
beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), 'skill-src-'))
  dest = mkdtempSync(join(tmpdir(), 'skill-dest-'))
  writeFileSync(join(src, 'SKILL.md'), '# Test skill\n')
  mkdirSync(join(src, 'scripts'))
  writeFileSync(join(src, 'scripts', 'run.sh'), 'echo hi\n')
})
afterEach(() => { rmSync(src, { recursive: true, force: true }); rmSync(dest, { recursive: true, force: true }) })

describe('vendor', () => {
  it('computes a deterministic integrity over the tree', () => {
    const a = computeTreeIntegrity(src)
    const b = computeTreeIntegrity(src)
    expect(a).toBe(b)
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
  it('detects tampering', () => {
    const before = computeTreeIntegrity(src)
    writeFileSync(join(src, 'SKILL.md'), '# Tampered\n')
    expect(verifyTreeIntegrity(src, before)).toBe(false)
  })
  it('vendors content excluding .git and node_modules', () => {
    mkdirSync(join(src, '.git')); writeFileSync(join(src, '.git', 'x'), 'no')
    mkdirSync(join(src, 'node_modules')); writeFileSync(join(src, 'node_modules', 'y'), 'no')
    vendorSkillDir(src, join(dest, 'vendored'))
    expect(existsSync(join(dest, 'vendored', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dest, 'vendored', 'scripts', 'run.sh'))).toBe(true)
    expect(existsSync(join(dest, 'vendored', '.git'))).toBe(false)
    expect(existsSync(join(dest, 'vendored', 'node_modules'))).toBe(false)
  })
})
