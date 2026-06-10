import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// Built-time git metadata, baked by scripts/postbuild.mjs into
// dist/build-info.json. Surfaced via --version and the REPL banner so users
// can verify they're running fresh code, not a stale binary.
type BuildInfo = { sha: string; dirty: boolean; builtAt: string }
function readBuildInfo(): BuildInfo {
  try {
    const raw = readFileSync(join(__dirname, 'build-info.json'), 'utf-8')
    const j = JSON.parse(raw) as Partial<BuildInfo>
    return {
      sha: typeof j.sha === 'string' ? j.sha : 'unknown',
      dirty: j.dirty === true,
      builtAt: typeof j.builtAt === 'string' ? j.builtAt : 'unknown',
    }
  } catch {
    // dev mode (tsx, no dist) or build-info.json missing.
    return { sha: 'dev', dirty: false, builtAt: 'dev' }
  }
}

export const VERSION = readVersion()
export const BUILD_INFO = readBuildInfo()

/** Short SHA + optional dirty marker for compact display. e.g. "ab12cd3" or
 *  "ab12cd3-dirty" or "dev". */
export function buildTag(): string {
  if (BUILD_INFO.sha === 'dev' || BUILD_INFO.sha === 'unknown') return BUILD_INFO.sha
  const short = BUILD_INFO.sha.slice(0, 7)
  return BUILD_INFO.dirty ? `${short}-dirty` : short
}

/** Freshness of a built binary relative to the source tree it claims to be:
 *  - `fresh`:   baked SHA matches HEAD and the build tree was clean.
 *  - `dirty`:   baked SHA matches HEAD but the build tree had uncommitted edits.
 *  - `stale`:   baked SHA differs from HEAD — old `dist/` masquerading as new code.
 *  - `unknown`: dev build (no `dist/build-info.json`) or no HEAD to compare. */
export type BinaryFreshness = 'fresh' | 'dirty' | 'stale' | 'unknown'

/** Pure classifier behind the F8 stale-binary CI gate. Compares the SHA baked
 *  into the binary at build time against the current HEAD. Tolerates short-vs-
 *  full SHA by prefix-matching on the shorter common length. */
export function classifyBinaryFreshness(
  builtSha: string,
  builtDirty: boolean,
  headSha: string,
): BinaryFreshness {
  const baked = builtSha.trim()
  const head = headSha.trim()
  if (baked === '' || baked === 'dev' || baked === 'unknown' || head === '') {
    return 'unknown'
  }
  const n = Math.min(baked.length, head.length)
  const matches = n > 0 && baked.slice(0, n) === head.slice(0, n)
  if (!matches) return 'stale'
  return builtDirty ? 'dirty' : 'fresh'
}
