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
import { checkReadPathAllowed, checkWritePathAllowed } from '../../src/native/tools/fs-policy.js'

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

    it('guides rejected temp artifact writes back to workspace-owned outputs', () => {
      const r = checkWritePathAllowed(join(tmpdir(), 'owlcoda-report.md'), { workspaceRoot })
      expect(r.allowed).toBe(false)
      if (!r.allowed) {
        expect(r.reason).toContain('current workspace')
        expect(r.reason).toContain('RunWorkspace')
        expect(r.reason).toContain('OWLCODA_ALLOW_FS_ROOTS')
      }
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

  describe('tilde expansion (CVE: literal `~/.ssh/x` bypassed sensitive-path check)', () => {
    let fakeHome: string
    beforeEach(() => {
      fakeHome = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-tildehome-'))
      mkdirSync(join(fakeHome, '.ssh'))
      mkdirSync(join(fakeHome, '.aws'))
      mkdirSync(join(fakeHome, '.gnupg'))
    })
    afterEach(() => {
      try { rmSync(fakeHome, { recursive: true, force: true }) } catch { /* ignore */ }
    })

    it('blocks `~/.ssh/<x>` (the original P0 — must resolve to <home>/.ssh, hit sensitiveDeny)', () => {
      const r = checkWritePathAllowed('~/.ssh/authorized_keys', {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) {
        expect(r.reason).toMatch(/SSH credentials/)
        // Must NOT have been treated as a literal `~` directory inside cwd.
        expect(r.attemptedPath).not.toMatch(/[\\/]~[\\/]/)
        expect(r.attemptedPath).toBe(join(realpathSync(fakeHome), '.ssh', 'authorized_keys'))
      }
    })

    it('blocks `~/.aws/credentials`', () => {
      const r = checkWritePathAllowed('~/.aws/credentials', {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.reason).toMatch(/AWS credentials/)
    })

    it('blocks `~/.gnupg/<x>`', () => {
      const r = checkWritePathAllowed('~/.gnupg/secring.gpg', {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.reason).toMatch(/GPG keys/)
    })

    it('expanded home outside workspace falls through boundary check (still rejected)', () => {
      // ~/normal-file.txt should resolve to <fakeHome>/normal-file.txt, which is
      // outside workspaceRoot and not in any allowedRoots → boundary reject.
      const r = checkWritePathAllowed('~/normal-file.txt', {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) {
        expect(r.reason).toMatch(/outside the allowed workspace/)
        expect(r.attemptedPath).toBe(join(realpathSync(fakeHome), 'normal-file.txt'))
      }
    })

    it('expanded home inside allowedRoots is allowed (e.g. ~/work-area/x when home is in allowedRoots)', () => {
      const r = checkWritePathAllowed('~/normal-file.txt', {
        workspaceRoot,
        homeDir: fakeHome,
        allowedRoots: [fakeHome],
      })
      expect(r.allowed).toBe(true)
      if (r.allowed) {
        expect(r.resolvedPath).toBe(join(realpathSync(fakeHome), 'normal-file.txt'))
      }
    })

    it('absolute literal `<home>/.ssh/x` still blocked (regression — pre-existing behaviour)', () => {
      const r = checkWritePathAllowed(join(fakeHome, '.ssh', 'id_rsa'), {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) expect(r.reason).toMatch(/SSH credentials/)
    })

    it('mid-path `~` is NOT expanded (`./~tilde-name.txt` is a legal filename)', () => {
      // `./~tilde-name.txt` resolves to a workspace-relative file with a
      // literal `~` in the basename — must be allowed.
      const r = checkWritePathAllowed('./~tilde-name.txt', {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(true)
      if (r.allowed) {
        expect(r.resolvedPath).toBe(join(realpathSync(workspaceRoot), '~tilde-name.txt'))
      }
    })

    it('`~user/file` (named-user form) is NOT expanded — treated as literal relative path', () => {
      // We don't query the user database; `~bob/file` becomes a literal
      // workspace-relative path `<workspaceRoot>/~bob/file`, which is
      // inside scope and therefore allowed (the user can still write a
      // file with `~bob` in its name). The point of this test is to pin
      // that we do NOT silently expand to /Users/bob and bypass the
      // boundary check.
      const r = checkWritePathAllowed('~bob/file.txt', {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(true)
      if (r.allowed) {
        expect(r.resolvedPath).toBe(join(realpathSync(workspaceRoot), '~bob', 'file.txt'))
      }
    })

    it('bare `~` expands to home dir', () => {
      const r = checkWritePathAllowed('~', {
        workspaceRoot,
        homeDir: fakeHome,
        allowedRoots: [fakeHome],
      })
      // `~` itself is a directory write, but the boundary/sensitive checks
      // only see a path. With fakeHome in allowedRoots and not on any
      // sensitive list, this should be allowed.
      expect(r.allowed).toBe(true)
      if (r.allowed) {
        expect(r.resolvedPath).toBe(realpathSync(fakeHome))
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

  describe('externalScopes — file vs directory kind semantics', () => {
    it('external file scope: exact path is allowed', () => {
      const target = join(outsideRoot, 'out.html')
      const r = checkWritePathAllowed(target, {
        workspaceRoot,
        externalScopes: [{ path: target, kind: 'file' }],
      })
      expect(r.allowed).toBe(true)
    })

    it('external file scope: descendant path is denied (key regression)', () => {
      const filePath = join(outsideRoot, 'out.html')
      const childPath = join(outsideRoot, 'out.html', 'child.txt')
      const r = checkWritePathAllowed(childPath, {
        workspaceRoot,
        externalScopes: [{ path: filePath, kind: 'file' }],
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) {
        expect(r.reason).toMatch(/outside the allowed workspace/)
      }
    })

    it('external directory scope: descendant path is allowed', () => {
      const dirPath = join(outsideRoot, 'output')
      mkdirSync(dirPath, { recursive: true })
      const childPath = join(dirPath, 'anything.html')
      const r = checkWritePathAllowed(childPath, {
        workspaceRoot,
        externalScopes: [{ path: dirPath, kind: 'directory' }],
      })
      expect(r.allowed).toBe(true)
    })

    it('external directory scope: exact directory path is allowed', () => {
      const dirPath = join(outsideRoot, 'output2')
      mkdirSync(dirPath, { recursive: true })
      const r = checkWritePathAllowed(dirPath, {
        workspaceRoot,
        externalScopes: [{ path: dirPath, kind: 'directory' }],
      })
      expect(r.allowed).toBe(true)
    })

    it('env var OWLCODA_ALLOW_FS_ROOTS continues to allow descendants (directory semantics)', () => {
      const envRoot = outsideRoot
      const targetFile = join(envRoot, 'foo', 'bar.txt')
      const r = checkWritePathAllowed(targetFile, {
        workspaceRoot,
        envAllowFsRoots: envRoot,
      })
      expect(r.allowed).toBe(true)
    })

    it('env var OWLCODA_ALLOW_FS_ROOTS does not interfere with externalScopes file-kind deny', () => {
      // externalScopes has a file-kind scope; env var covers a different root
      const filePath = join(outsideRoot, 'out.html')
      const childPath = join(outsideRoot, 'out.html', 'child.txt')
      const r = checkWritePathAllowed(childPath, {
        workspaceRoot,
        externalScopes: [{ path: filePath, kind: 'file' }],
        // env var covers workspaceRoot — child is outside both
        envAllowFsRoots: workspaceRoot,
      })
      expect(r.allowed).toBe(false)
    })
  })
})

describe('fs-policy.checkReadPathAllowed', () => {
  it('allows absolute reads outside the workspace when not sensitive', () => {
    const target = join(outsideRoot, 'diagnostic.txt')
    writeFileSync(target, 'ok')
    const r = checkReadPathAllowed(target, { workspaceRoot })
    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.resolvedPath).toBe(realpathSync(target))
  })

  it('does not misclassify macOS /home data-volume paths as /System reads', () => {
    const r = checkReadPathAllowed('/home/sieracclaw/.openclaw/agents/main/agent/models.json', {
      workspaceRoot,
      platformName: 'darwin',
    })

    expect(r.allowed).toBe(true)
    if (r.allowed) expect(r.resolvedPath).toMatch(/\/home\/sieracclaw|\/System\/Volumes\/Data\/home\/sieracclaw/)
  })

  it('rejects sensitive home paths even when the home dir is otherwise readable', () => {
    const fakeHome = mkdtempSync(join(tmpdir(), 'owlcoda-fs-policy-read-home-'))
    try {
      mkdirSync(join(fakeHome, '.ssh'))
      const r = checkReadPathAllowed('~/.ssh/id_rsa', {
        workspaceRoot,
        homeDir: fakeHome,
      })
      expect(r.allowed).toBe(false)
      if (!r.allowed) {
        expect(r.reason).toMatch(/Refusing to read/)
        expect(r.reason).toMatch(/SSH credentials/)
        expect(r.attemptedPath).toBe(join(realpathSync(fakeHome), '.ssh', 'id_rsa'))
      }
    } finally {
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('rejects /etc reads on POSIX platforms before OS permissions decide', () => {
    const r = checkReadPathAllowed('/etc/shadow', {
      workspaceRoot,
      platformName: 'linux',
    })
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.reason).toMatch(/Refusing to read/)
      expect(r.reason).toMatch(/system config/)
    }
  })
})
