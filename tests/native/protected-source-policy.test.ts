/**
 * Tests for protected-source-policy.
 *
 * Pin the destructive-write detection on real-world handoff / GOAL_CONTRACT
 * / CHANGELOG patterns and ensure append-only edits never trip.
 */
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkProtectedWrite,
  formatProtectedRefusal,
} from '../../src/native/tools/protected-source-policy.js'

const HANDOFF_OLD = `# Next Thread Handoff

## Goal
Finish the delivery quality work.

## Source of Truth
\`docs/handoff/2026-05-06-delivery.md\` is the canonical reference.

## Suggested Commands
- npm test
- npm run build
- owlcoda --resume <id>

## Runtime
Node 20.20.1, darwin arm64.

## Deployment
Manual. Run npm run build then npm publish.

## Open Questions
- Do we ship 0.13.43 with just the SOT guard or batch with audit?
`

describe('protected-source-policy: scope', () => {
  it('default basenames are protected anywhere in the tree', () => {
    const v = checkProtectedWrite(
      '/abs/path/anywhere/NEXT_THREAD_HANDOFF.md',
      'tiny',
      HANDOFF_OLD,
      { workspaceRoot: '/abs/path' },
    )
    expect(v.protected).toBe(true)
  })

  it('CHANGELOG.md is protected (real-world handoff lossage)', () => {
    const v = checkProtectedWrite('/repo/CHANGELOG.md', 'x', 'old\nlong\ncontent\n'.repeat(10), {
      workspaceRoot: '/repo',
    })
    expect(v.protected).toBe(true)
  })

  it('docs/handoff/** is protected by directory prefix', () => {
    const v = checkProtectedWrite(
      '/repo/docs/handoff/2026-05-06.md',
      'x',
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
  })

  it('arbitrary file under docs/ is NOT protected', () => {
    const v = checkProtectedWrite('/repo/docs/api.md', 'x', 'old', {
      workspaceRoot: '/repo',
    })
    expect(v.protected).toBe(false)
  })

  it('OWLCODA_PROTECTED_PATHS env var extends the list', () => {
    const v = checkProtectedWrite(
      '/repo/AGENTS.md',
      'short',
      'old\nlong\ncontent\nlots\nmore\nstuff\n',
      {
        workspaceRoot: '/repo',
        envProtectedPaths: 'AGENTS.md',
      },
    )
    expect(v.protected).toBe(true)
  })

  it('env-var directory prefixes (trailing slash) protect contents', () => {
    const v = checkProtectedWrite(
      '/repo/notes/foo.md',
      'short',
      'old\nlong\ncontent\nlots\nmore\nstuff\n',
      {
        workspaceRoot: '/repo',
        envProtectedPaths: 'notes/',
      },
    )
    expect(v.protected).toBe(true)
  })
})

describe('protected-source-policy: destructive detection', () => {
  it('append-only writes are never destructive', () => {
    const newContent = HANDOFF_OLD + '\n## Update 2026-05-06\nAdded SOT guard.\n'
    const v = checkProtectedWrite(
      '/repo/NEXT_THREAD_HANDOFF.md',
      newContent,
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
    expect(v.destructive).toBe(false)
  })

  it('compressing 200-line handoff into 5 lines is destructive', () => {
    const collapsed = '# Next Thread Handoff\n\nDone. See git log.\n'
    const v = checkProtectedWrite(
      '/repo/NEXT_THREAD_HANDOFF.md',
      collapsed,
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
    expect(v.destructive).toBe(true)
    expect(v.reason).toMatch(/removed/)
  })

  it('removing the Suggested Commands section is destructive even if line ratio passes', () => {
    // Keep most lines but drop the named section.
    const withoutSuggestedCommands = HANDOFF_OLD
      .replace(
        /## Suggested Commands\n[\s\S]*?\n(?=## )/,
        '',
      )
    const v = checkProtectedWrite(
      '/repo/NEXT_THREAD_HANDOFF.md',
      withoutSuggestedCommands,
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
    expect(v.destructive).toBe(true)
    expect(v.removedSections).toContain('Suggested Commands')
  })

  it('dropping ≥2 markdown headers is destructive', () => {
    // Old has 6 headers; new keeps 3 → drop of 3
    const reduced = `# Next Thread Handoff
## Goal
Finish.
`
    const v = checkProtectedWrite(
      '/repo/NEXT_THREAD_HANDOFF.md',
      reduced,
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
    expect(v.destructive).toBe(true)
  })

  it('creating a fresh protected file (oldContent=null) is never destructive', () => {
    const v = checkProtectedWrite(
      '/repo/NEXT_THREAD_HANDOFF.md',
      HANDOFF_OLD,
      null,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
    expect(v.destructive).toBe(false)
  })

  it('reformatting (line splits, no content loss) below threshold is not destructive', () => {
    // Add some blank lines, no real content removed.
    const reformatted = HANDOFF_OLD.replace(/\n## /g, '\n\n## ')
    const v = checkProtectedWrite(
      '/repo/NEXT_THREAD_HANDOFF.md',
      reformatted,
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
    expect(v.destructive).toBe(false)
  })
})

describe('protected-source-policy: refusal message', () => {
  it('includes path, reason, and removed sections', () => {
    const collapsed = '# Done.\n'
    const v = checkProtectedWrite(
      '/repo/NEXT_THREAD_HANDOFF.md',
      collapsed,
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    const msg = formatProtectedRefusal('/repo/NEXT_THREAD_HANDOFF.md', v)
    expect(msg).toMatch(/Refusing to overwrite protected source file/)
    expect(msg).toMatch(/NEXT_THREAD_HANDOFF/)
    expect(msg).toMatch(/replaceProtected: true/)
    expect(msg).toMatch(/Suggested Commands|Source of Truth/)
  })
})

describe('protected-source-policy: tilde + workspace edge cases', () => {
  it('relative path is resolved against workspace before matching', () => {
    const v = checkProtectedWrite(
      'NEXT_THREAD_HANDOFF.md',
      'x',
      HANDOFF_OLD,
      { workspaceRoot: '/repo' },
    )
    expect(v.protected).toBe(true)
  })

  it('tilde-prefixed protected file resolves against home', () => {
    const v = checkProtectedWrite(
      '~/NEXT_THREAD_HANDOFF.md',
      'x',
      HANDOFF_OLD,
      { workspaceRoot: tmpdir(), homeDir: join(tmpdir(), 'fake-home') },
    )
    expect(v.protected).toBe(true)
  })
})
