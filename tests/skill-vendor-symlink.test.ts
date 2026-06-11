import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeTreeIntegrity } from '../src/skills/vendor.js'

// A malicious third-party skill repo can contain symlinks. The tree walk used
// statSync (follows links), so a symlink cycle infinite-recursed and a symlink
// escaping the tree got its target hashed/read. lstatSync makes a symlink count
// as neither a dir (no recursion) nor a file (not hashed). The same statSync
// pattern in third-party.ts listMarkdownFiles is fixed alongside.
describe('computeTreeIntegrity — symlink safety', () => {
  const roots: string[] = []
  afterEach(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })
  function setup(): string {
    const r = mkdtempSync(join(tmpdir(), 'owlcoda-tree-'))
    roots.push(r)
    return r
  }

  it('does not follow a symlink cycle (statSync would infinite-recurse)', () => {
    const root = setup()
    writeFileSync(join(root, 'SKILL.md'), '# s\n')
    symlinkSync(root, join(root, 'loop')) // loop -> root
    expect(() => computeTreeIntegrity(root)).not.toThrow()
  })

  it('does not read/hash the target of a symlink escaping the tree', () => {
    const outside = setup()
    writeFileSync(join(outside, 'secret.txt'), 'SECRETCONTENT')
    const root = setup()
    writeFileSync(join(root, 'SKILL.md'), '# s\n')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'leak')) // escapes the tree

    const withLink = computeTreeIntegrity(root)

    // An equivalent tree WITHOUT the symlink must produce the same hash — i.e.
    // the symlink contributed nothing (its target was never read).
    const plain = setup()
    writeFileSync(join(plain, 'SKILL.md'), '# s\n')
    expect(withLink).toBe(computeTreeIntegrity(plain))
  })
})
