/**
 * Golden-fixture suite for the markdown renderer.
 *
 * Each subdirectory under `cases/` is one fixture. See `../README.md`.
 *
 * The runner verifies three things per fixture:
 *
 *   1. **Snapshot match** — the normalized output of the full-pass renderer
 *      equals `out.txt` (after the same normalization applied to both sides).
 *
 *   2. **Path equivalence** — full-pass / single-chunk stream / line-by-line
 *      stream / token-by-token stream all produce the same normalized output.
 *
 *   3. **Multi-width stability** — re-running at terminal widths 80 / 100 /
 *      120 produces output that, after normalization, equals `out.txt`. (If
 *      a fixture is intentionally width-sensitive, it must include a
 *      `out.<width>.txt` per width and set `meta.json` `widthSensitive: true`.)
 *
 * Regen helper: `OWLCODA_FIXTURE_REGEN=1 npx vitest run …` rewrites
 * every `out.txt` and any width-specific `out.<n>.txt` from the current
 * renderer's output. Always hand-diff before committing — a regen masks
 * regressions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderMarkdown, StreamingMarkdownRenderer } from '../../../src/native/markdown.js'
import { stripAnsi } from '../../../src/native/tui/colors.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CASES_DIR = join(__dirname, 'cases')
const REGEN = process.env.OWLCODA_FIXTURE_REGEN === '1'

type FixtureMeta = {
  /** Terminal widths to verify. Default `[80, 100, 120]`. */
  widths?: number[]
  /** Set when `out.txt` is allowed to differ between widths; the suite
   *  will look for `out.<width>.txt` per width instead. */
  widthSensitive?: boolean
  /** Paths to exclude from path-equivalence (rare; only for known
   *  acceptable divergences). One or more of:
   *  `full | stream-1chunk | stream-line | stream-token`. */
  skipPaths?: string[]
}

type FixturePath = 'full' | 'stream-1chunk' | 'stream-line' | 'stream-token'

/** Same normalization as `markdown-path-equivalence.test.ts` and the
 *  0.13.92 / 0.13.94 glue test files. Strip ANSI, trim trailing
 *  whitespace per line, collapse blank runs, drop leading/trailing blanks. */
function normalize(text: string): string {
  const lines = stripAnsi(text).split('\n').map(l => l.replace(/\s+$/, ''))
  const out: string[] = []
  let prevBlank = false
  for (const l of lines) {
    const blank = l === ''
    if (blank && prevBlank) continue
    out.push(l)
    prevBlank = blank
  }
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

function renderFull(input: string): string {
  return renderMarkdown(input)
}
function renderStream1Chunk(input: string): string {
  const r = new StreamingMarkdownRenderer()
  return r.push(input) + r.flush()
}
function renderStreamByLine(input: string): string {
  const r = new StreamingMarkdownRenderer()
  let out = ''
  // Preserve newlines: feed each '\n'-terminated chunk separately so the
  // stream sees real line breaks where the input has them.
  const lines = input.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const chunk = i < lines.length - 1 ? lines[i] + '\n' : lines[i]
    out += r.push(chunk)
  }
  out += r.flush()
  return out
}
function renderStreamByToken(input: string): string {
  const r = new StreamingMarkdownRenderer()
  let out = ''
  for (const c of input) out += r.push(c)
  out += r.flush()
  return out
}

const PATH_FNS: Record<FixturePath, (s: string) => string> = {
  'full': renderFull,
  'stream-1chunk': renderStream1Chunk,
  'stream-line': renderStreamByLine,
  'stream-token': renderStreamByToken,
}

function readMeta(caseDir: string): FixtureMeta {
  const metaPath = join(caseDir, 'meta.json')
  if (!existsSync(metaPath)) return {}
  return JSON.parse(readFileSync(metaPath, 'utf-8'))
}

function listCases(): string[] {
  if (!existsSync(CASES_DIR)) return []
  return readdirSync(CASES_DIR)
    .filter(name => statSync(join(CASES_DIR, name)).isDirectory())
    .sort()
}

// Width stubbing: `process.stdout.columns` is the only column source the
// markdown renderer reads. Save / restore around each width run so other
// tests aren't perturbed.
const ORIGINAL_COLUMNS = process.stdout.columns
function setColumns(n: number): void {
  Object.defineProperty(process.stdout, 'columns', {
    value: n,
    configurable: true,
    writable: true,
  })
}
beforeAll(() => { /* descriptor saved at module load */ })
afterAll(() => { setColumns(ORIGINAL_COLUMNS) })

describe('markdown fixture suite', () => {
  const caseNames = listCases()
  if (caseNames.length === 0) {
    it.skip('no fixtures found — add directories under tests/native/markdown-fixtures/cases/', () => { /* */ })
    return
  }

  for (const name of caseNames) {
    describe(name, () => {
      const caseDir = join(CASES_DIR, name)
      const inputPath = join(caseDir, 'in.md')
      const outputPath = join(caseDir, 'out.txt')
      const meta = readMeta(caseDir)
      const widths = meta.widths ?? [80, 100, 120]
      const skipPaths = new Set(meta.skipPaths ?? [])

      if (!existsSync(inputPath)) {
        it.skip(`missing in.md`, () => { /* */ })
        return
      }
      const input = readFileSync(inputPath, 'utf-8')

      // Snapshot test runs at the default (100 col) so the recorded out.txt
      // is reproducible. Width tests run separately.
      it('snapshot: full-pass output matches out.txt', () => {
        setColumns(100)
        const got = normalize(renderFull(input))
        if (REGEN) {
          writeFileSync(outputPath, got + '\n', 'utf-8')
          return
        }
        if (!existsSync(outputPath)) {
          throw new Error(
            `Missing ${outputPath}. Run with OWLCODA_FIXTURE_REGEN=1 to bootstrap.`,
          )
        }
        const expected = normalize(readFileSync(outputPath, 'utf-8'))
        expect(got).toBe(expected)
      })

      // Path equivalence: each non-skipped path must produce the same
      // normalized output as full-pass. This is the canonical contract —
      // streaming must not diverge from full-pass.
      const pathNames: FixturePath[] = ['full', 'stream-1chunk', 'stream-line', 'stream-token']
      for (const path of pathNames) {
        if (skipPaths.has(path)) continue
        if (path === 'full') continue
        it(`path equivalence: ${path} == full`, () => {
          setColumns(100)
          const ref = normalize(renderFull(input))
          const got = normalize(PATH_FNS[path](input))
          expect(got).toBe(ref)
        })
      }

      // Width sweep: same input rendered at multiple terminal widths.
      // Default expectation is "normalized output is width-independent" —
      // most renders are. If a fixture is genuinely width-sensitive
      // (boxed table column re-wrap), set meta.widthSensitive=true and
      // include `out.<n>.txt` per width.
      for (const width of widths) {
        it(`width ${width}: snapshot matches`, () => {
          setColumns(width)
          const got = normalize(renderFull(input))
          if (meta.widthSensitive) {
            const widthPath = join(caseDir, `out.${width}.txt`)
            if (REGEN) {
              writeFileSync(widthPath, got + '\n', 'utf-8')
              return
            }
            if (!existsSync(widthPath)) {
              throw new Error(
                `widthSensitive=true but missing ${widthPath}. ` +
                `Run with OWLCODA_FIXTURE_REGEN=1 to bootstrap.`,
              )
            }
            const expected = normalize(readFileSync(widthPath, 'utf-8'))
            expect(got).toBe(expected)
          } else {
            const expected = normalize(readFileSync(outputPath, 'utf-8'))
            expect(got).toBe(expected)
          }
        })
      }
    })
  }
})
