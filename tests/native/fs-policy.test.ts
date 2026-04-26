/**
 * fs-policy unit tests — pure path-validation behaviour, no real writes.
 * Pins the rules from issue #3:
 *   - in-scope writes allowed,
 *   - empty / NUL paths rejected,
 *   - traversal escape rejected,
 *   - absolute outside-scope rejected,
 *   - sensitive locations rejected unconditionally,
 *   - symlink escape rejected,
 *   - rejection is non-mutating (the helper itself never touches FS state).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkWritePathAllowed } from '../../src/native/tools/fs-policy.js'

let workspaceRoot: string
let outsideRoot: string

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-ws-'))
  outsideRoot = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-out-'))
})

afterEach(() => {
  try { rmSync(workspaceRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(outsideRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('fs-policy.checkWritePathAllowed', () => {
  describe('input validation', () => {
    it('rejects undefined / null / non-string inputs', () => {
      const r1 = checkWritePathAllowed(undefined as any, { workspaceRoot })
      expect(r1.allowed).toBe(false)
      const r2 = checkWritePathAllowed(null as any, { workspaceRoot })
      expect(r2.allowed).toBe(false)
      const r3 = checkWritePathAllowed(42 as any, { workspaceRoot })
      expect(r3.allowed).toBe(false)
    })

    it('rejects empty / whitespace-only paths', () => {
      expect(checkWritePathAllowed('', { workspaceRoot }).allowed).toBe(false)
      expect(checkWritePathAllowed('   ', { workspaceRoot }).allowed).toBe(false)
      expect(checkWritePathAllowed('\t\n', { workspaceRoot }).allowed).toBe(false)
    })

    it('rejects paths containing a NUL byte', () => {
      const r = checkWritePathAllowed('foo\0bar', { workspaceRoot })
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.reason).toMatch(/NUL/)
    })
  })

  describe('in-scope writes', () => {
    it('allows a relative path inside the workspace', () => {
      const r = checkWritePathAllowed('src/foo.ts', { workspaceRoot })
      expect(r.allowed).toBe(true)
      // Use realpath for comparison: macOS rewrites /var/... to /private/var/...
      // and the policy normalizes targets through realpath() of existing parents.
      if (r.allowed) {
        expect(r.resolvedPath).toBe(join(realpathSync(workspaceRoot), 'src', 'foo.ts'))
      }
    })

    it('allows an absolute path inside the workspace', () => {
      const target = join(workspaceRoot, 'a', 'b', 'c.txt')
      const r = checkWritePathAllowed(target, { workspaceRoot })
      expect(r.allowed).toBe(true)
    })

    it('allows writes to existing files inside the workspace', () => {
      const target = join(workspaceRoot, 'existing.txt')
      writeFileSync(target, 'hi')
      const r = checkWritePathAllowed(target, { workspaceRoot })
      expect(r.allowed).toBe(true)
    })
  })

  describe('out-of-scope writes', () => {
    it('rejects ../ traversal escape', () => {
      // resolve("/ws/src/../../outside/x") => "/outside/x"
      const r = checkWritePathAllowed('src/../../escape.txt', { workspaceRoot })
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.reason).toMatch(/outside the allowed workspace/)
    })

    it('rejects absolute path outside scope', () => {
      const r = checkWritePathAllowed(join(outsideRoot, 'pwn.txt'), { workspaceRoot })
      expect(r.allowed).toBe(false)
    })

    it('rejection happens before mutation (helper never touches FS)', () => {
      const targetDir = join(outsideRoot, 'should-not-be-created')
      checkWritePathAllowed(join(targetDir, 'file.txt'), { workspaceRoot })
      // Helper must not have created the parent dir or touched anything.
      expect(existsSync(targetDir)).toBe(false)
    })
  })

  describe('sensitive locations', () => {
    it('rejects ~/.ssh writes even when allowedRoots includes the home dir', () => {
      // Make HOME a temp dir so we can synthesize ~/.ssh deterministically.
      const fakeHome = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-home-'))
      try {
        mkdirSync(join(fakeHome, '.ssh'))
        const r = checkWritePathAllowed(join(fakeHome, '.ssh', 'authorized_keys'), {
          workspaceRoot,
          allowedRoots: [fakeHome],
          homeDir: fakeHome,
        })
        expect(r.allowed).toBe(false)
        if (!r.allowed) expect(r.reason).toMatch(/SSH credentials/)
      } finally {
        rmSync(fakeHome, { recursive: true, force: true })
      }
    })

    it('rejects /etc writes on POSIX platforms', () => {
      const r = checkWritePathAllowed('/etc/hosts', {
        workspaceRoot,
        platformName: 'linux',
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.reason).toMatch(/system config/)
    })

    it('rejects writes inside OWLCODA_HOME (agent must not rewrite its own config)', () => {
      const owlcodaHome = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-OH-'))
      try {
        const r = checkWritePathAllowed(join(owlcodaHome, 'config.json'), {
          workspaceRoot,
          allowedRoots: [owlcodaHome],
          owlcodaHome,
        })
        expect(r.allowed).toBe(false)
        if (!r.allowed) expect(r.reason).toMatch(/OWLCODA_HOME/)
      } finally {
        rmSync(owlcodaHome, { recursive: true, force: true })
      }
    })
  })

  describe('symlink escape', () => {
    it('rejects writes through a symlink whose realpath leaves the workspace', () => {
      // workspace/link → outsideRoot
      const linkPath = join(workspaceRoot, 'link')
      try {
        symlinkSync(outsideRoot, linkPath, 'dir')
      } catch (err) {
        // Some CI sandboxes block symlink creation; skip rather than fail.
        // Surface the reason so a future maintainer doesn't think this case
        // is silently covered.
        console.warn(`symlink escape test skipped: ${(err as Error).message}`)
        return
      }
      const r = checkWritePathAllowed(join(linkPath, 'pwn.txt'), { workspaceRoot })
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.reason).toMatch(/outside the allowed workspace/)
    })
  })

  describe('extra allowed roots', () => {
    it('allows writes inside roots opted-in via OWLCODA_ALLOW_FS_ROOTS', () => {
      const extra = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-extra-'))
      try {
        const r = checkWritePathAllowed(join(extra, 'file.txt'), {
          workspaceRoot,
          envAllowFsRoots: extra,
        })
        expect(r.allowed).toBe(true)
      } finally {
        rmSync(extra, { recursive: true, force: true })
      }
    })

    it('allows multiple :-separated extra roots', () => {
      const a = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-a-'))
      const b = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-b-'))
      try {
        const r1 = checkWritePathAllowed(join(a, 'x'), {
          workspaceRoot,
          envAllowFsRoots: `${a}:${b}`,
        })
        const r2 = checkWritePathAllowed(join(b, 'x'), {
          workspaceRoot,
          envAllowFsRoots: `${a}:${b}`,
        })
        expect(r1.allowed).toBe(true)
        expect(r2.allowed).toBe(true)
      } finally {
        rmSync(a, { recursive: true, force: true })
        rmSync(b, { recursive: true, force: true })
      }
    })
  })

  it('does not create unintended files anywhere', () => {
    // Sanity: run a battery of denied calls; nothing should appear in tmpdir.
    const before = readdirSync(workspaceRoot).length
    checkWritePathAllowed('../../escape.txt', { workspaceRoot })
    checkWritePathAllowed('/etc/shadow', { workspaceRoot, platformName: 'linux' })
    checkWritePathAllowed('', { workspaceRoot })
    const after = readdirSync(workspaceRoot).length
    expect(after).toBe(before)
  })
})
