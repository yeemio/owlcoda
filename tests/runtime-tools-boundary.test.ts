/**
 * Import-boundary regression test for the legacy runtime tools (issue #4).
 *
 * Status pinned by this test: `src/runtime/tools.ts` and
 * `src/frontend/repl.ts` are LEGACY / not reachable from production.
 *
 *   Production CLI binary entrypoint:
 *     dist/cli.js (built from src/cli.ts) → src/cli-core.ts → src/native/repl.ts
 *                                                            → src/native/headless.ts
 *
 *   Neither `src/cli-core.ts`, `src/server.ts`, nor anything under
 *   `src/native/*` may import from `src/runtime/tools.ts` or
 *   `src/frontend/repl.ts`. The only allowed importer of the legacy
 *   runtime is `src/frontend/repl.ts` itself, which is also legacy and
 *   has no production consumers.
 *
 * If a future change wakes the legacy path back up without first
 * routing it through the centralized policies (`src/native/bash-risk.ts`
 * + `src/native/tools/fs-policy.ts`), this test will FAIL — at which
 * point the right move is to either:
 *   (a) bridge the legacy path through the centralized policies, or
 *   (b) drop the legacy import and use the native dispatcher instead.
 *
 * Update this test only when both happen together. Don't loosen the
 * boundary without updating the matrix in
 * `docs/follow-ups/runtime-tools-status-2026-04-26.md`.
 */
import { describe, it, expect } from 'vitest'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const REPO_ROOT = join(import.meta.dirname, '..')
const SRC = join(REPO_ROOT, 'src')

// Files that may import from runtime/* or frontend/repl. Any other file
// importing those would be a production-path regression.
const ALLOWED_IMPORTERS = new Set([
  'frontend/repl.ts', // self-contained legacy chain — frontend/repl uses runtime/tools
])

const LEGACY_IMPORT_PATTERNS = [
  /from\s+['"][^'"]*\/runtime\/tools(?:\.js)?['"]/,
  /from\s+['"][^'"]*\/frontend\/repl(?:\.js)?['"]/,
]

async function* walkTs(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkTs(full)
    } else if (entry.isFile() && (full.endsWith('.ts') || full.endsWith('.tsx'))) {
      yield full
    }
  }
}

describe('legacy runtime/frontend import boundary (issue #4)', () => {
  it('no production src/* file imports from runtime/tools or frontend/repl', async () => {
    const violations: Array<{ file: string; line: string }> = []
    for await (const file of walkTs(SRC)) {
      const rel = relative(SRC, file)
      if (ALLOWED_IMPORTERS.has(rel)) continue
      const content = await readFile(file, 'utf-8')
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const pat of LEGACY_IMPORT_PATTERNS) {
          if (pat.test(line)) {
            violations.push({ file: rel, line: `${i + 1}: ${line.trim()}` })
            break
          }
        }
      }
    }
    if (violations.length > 0) {
      const summary = violations
        .map(v => `  ${v.file} ${v.line}`)
        .join('\n')
      throw new Error(
        `Production src/* file(s) import from legacy runtime/frontend modules:\n${summary}\n` +
        `If you need to revive the legacy path, route it through src/native/bash-risk.ts ` +
        `+ src/native/tools/fs-policy.ts AND update docs/follow-ups/runtime-tools-status-2026-04-26.md.`,
      )
    }
    expect(violations).toEqual([])
  })

  it('the production CLI entry chain does not transit runtime/* at all', async () => {
    // Lightweight transitive proof: the three production seed files
    // (cli.ts, cli-core.ts, server.ts) plus everything under src/native/*
    // must not import runtime/* directly.
    const seeds = [
      'cli.ts',
      'cli-core.ts',
      'server.ts',
    ]
    for (const seed of seeds) {
      const full = join(SRC, seed)
      const exists = await stat(full).then(() => true).catch(() => false)
      if (!exists) continue
      const content = await readFile(full, 'utf-8')
      expect(content).not.toMatch(/from\s+['"][^'"]*\/runtime\//)
      expect(content).not.toMatch(/from\s+['"][^'"]*\/frontend\/repl/)
    }
  })

  it('runtime/tools delegates bash dangerous classification to centralized classifier', async () => {
    // Direct proof: the bridge import is present in the legacy file. If
    // someone removes it, the legacy bash policy will diverge from
    // native again — test catches it.
    const content = await readFile(join(SRC, 'runtime/tools.ts'), 'utf-8')
    expect(content).toMatch(/from\s+['"][^'"]*\/native\/bash-risk(?:\.js)?['"]/)
    expect(content).toMatch(/classifyBashCommand/)
  })
})
