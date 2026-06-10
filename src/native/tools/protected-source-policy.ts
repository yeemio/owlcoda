/**
 * Protected source-of-truth policy.
 *
 * Background — issue #6 (private):
 *   OwlCoda kept silently rewriting "source of truth" markdown files —
 *   `NEXT_THREAD_HANDOFF.md`, `GOAL_CONTRACT.md`, `SOURCE_OF_TRUTH.md`,
 *   `docs/handoff/**`, `CHANGELOG.md` — every time the model felt like
 *   "tightening" the doc. Sections like "Suggested Commands",
 *   "Runtime", "Deployment" disappeared mid-turn. Operators reported
 *   re-explaining the same context 5 turns later because the handoff
 *   had been compressed into a 200-byte summary.
 *
 *   This module is the dual of `fs-policy.ts`:
 *   - fs-policy says "this PATH must not be written, period."
 *   - protected-source-policy says "this PATH should be append-only.
 *     A destructive overwrite needs an explicit `replaceProtected` flag."
 *
 * What counts as "destructive"?
 *   1. >30% of existing lines removed in the new content.
 *   2. ≥2 top-level `## ` markdown headers disappear.
 *   3. Specific named sections disappear (Suggested Commands, Runtime,
 *      Deployment, Source of Truth — these are the ones we've actually
 *      seen lost in the wild).
 *
 *   Any one of those flips the verdict to destructive. Append-only
 *   writes (new content includes the old verbatim, plus extra at the
 *   end) never trip.
 *
 * What this is NOT:
 *   - Not a write blocker. The fix is opt-in via `replaceProtected: true`,
 *     because real rewrites do happen (releasing 0.13.x means rewriting
 *     CHANGELOG.md's top entry, etc.). The flag forces the model to
 *     name the destruction out loud.
 *   - Not a content-correctness check. We can't tell whether the
 *     replacement is good or bad — only whether it lost material.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export interface ProtectedSourceOptions {
  /** Workspace root used for matching `docs/handoff/**` style globs. */
  workspaceRoot?: string
  /** Override the env-var lookup (test seam). */
  envProtectedPaths?: string | undefined
  /** Override homedir lookup (test seam). */
  homeDir?: string
}

export interface ProtectedSourceVerdict {
  /** Is this path on the protected list at all? */
  protected: boolean
  /** When protected: is the proposed change destructive? */
  destructive: boolean
  /** Human-readable reason when destructive (for the refusal message). */
  reason?: string
  /** Specific sections that disappear in the new content. */
  removedSections?: string[]
  /** Old line count (informational). */
  oldLineCount?: number
  /** New line count (informational). */
  newLineCount?: number
  /** Lines removed (informational). */
  removedLineCount?: number
}

/**
 * Default protected paths. Matched case-insensitively and as
 * substrings on the resolved path. Custom additions come from
 * `OWLCODA_PROTECTED_PATHS=<path1>:<path2>:...` (POSIX `:` separator).
 *
 * The list is intentionally small — every entry here is a real file
 * that has been silently destroyed in the past. Adding noise to this
 * list trains operators to ignore the warnings.
 */
const DEFAULT_PROTECTED_FILE_BASENAMES = [
  'NEXT_THREAD_HANDOFF.md',
  'GOAL_CONTRACT.md',
  'SOURCE_OF_TRUTH.md',
  'CHANGELOG.md',
]

/** Directory prefixes (workspace-relative) whose contents are all protected. */
const DEFAULT_PROTECTED_DIR_PREFIXES = [
  'docs/handoff/',
]

/**
 * Section titles that, when present in the old content but absent in
 * the new content, mark the change as destructive. Heuristic — matches
 * `## Title` and `### Title` markdown headers.
 *
 * These titles come from the actual classes of section we've seen go
 * missing. Add new entries when a new class emerges.
 */
const NAMED_SECTION_TITLES = [
  'Suggested Commands',
  'Runtime',
  'Deployment',
  'Source of Truth',
  'Recovery',
  'Open Questions',
  'Acceptance Criteria',
]

const DESTRUCTIVE_LINE_DROP_RATIO = 0.30
const DESTRUCTIVE_HEADER_DROP_THRESHOLD = 2

/**
 * Decide whether `targetPath` is a protected source-of-truth file and,
 * if so, whether the proposed `newContent` would destroy material from
 * the existing file. Pure: no fs reads, no mutations.
 *
 * `oldContent === null` means the file is new (creation), which is
 * never destructive even on a protected path.
 */
export function checkProtectedWrite(
  targetPath: string,
  newContent: string,
  oldContent: string | null,
  opts: ProtectedSourceOptions = {},
): ProtectedSourceVerdict {
  const home = opts.homeDir ?? homedir()
  const workspace = opts.workspaceRoot ?? process.cwd()
  const env = opts.envProtectedPaths !== undefined
    ? opts.envProtectedPaths
    : process.env['OWLCODA_PROTECTED_PATHS']

  const expanded = expandTilde(targetPath, home)
  const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded)
  const relToWorkspace = relative(workspace, resolved)
  const protectedHit = isProtectedPath(resolved, relToWorkspace, env, workspace)
  if (!protectedHit) {
    return { protected: false, destructive: false }
  }

  // New-file creation is never destructive.
  if (oldContent === null) {
    return { protected: true, destructive: false }
  }

  // Append-only short-circuit: if the new content fully contains the
  // old content as a prefix or substring, nothing was lost.
  if (newContent.includes(oldContent)) {
    return { protected: true, destructive: false }
  }

  const oldLines = oldContent.split('\n')
  const newLines = newContent.split('\n')
  const oldLineCount = oldLines.length
  const newLineCount = newLines.length
  // Use a simple set-difference on non-empty trimmed lines as a
  // first-order "did material disappear" signal. False negatives
  // possible (re-ordering would still trip later checks); false
  // positives possible on heavy reformatting (acceptable — the user
  // just adds `replaceProtected: true`).
  const oldLineSet = new Set(oldLines.map(l => l.trim()).filter(l => l.length > 0))
  const newLineSet = new Set(newLines.map(l => l.trim()).filter(l => l.length > 0))
  let removedLineCount = 0
  for (const line of oldLineSet) {
    if (!newLineSet.has(line)) removedLineCount += 1
  }
  const ratio = oldLineSet.size > 0 ? removedLineCount / oldLineSet.size : 0

  const oldHeaders = extractHeaders(oldContent)
  const newHeaders = extractHeaders(newContent)
  const headerDrop = Math.max(0, oldHeaders.size - newHeaders.size)

  const removedSections = findRemovedNamedSections(oldHeaders, newHeaders)

  let destructive = false
  const reasons: string[] = []
  if (ratio >= DESTRUCTIVE_LINE_DROP_RATIO) {
    destructive = true
    reasons.push(
      `${removedLineCount}/${oldLineSet.size} unique lines (${Math.round(ratio * 100)}%) ` +
      `removed (threshold ${Math.round(DESTRUCTIVE_LINE_DROP_RATIO * 100)}%)`,
    )
  }
  if (headerDrop >= DESTRUCTIVE_HEADER_DROP_THRESHOLD) {
    destructive = true
    reasons.push(`${headerDrop} markdown headers dropped`)
  }
  if (removedSections.length > 0) {
    destructive = true
    reasons.push(`named sections removed: ${removedSections.join(', ')}`)
  }

  return {
    protected: true,
    destructive,
    reason: destructive ? reasons.join('; ') : undefined,
    removedSections: removedSections.length > 0 ? removedSections : undefined,
    oldLineCount,
    newLineCount,
    removedLineCount,
  }
}

/**
 * Format the refusal message a write/edit tool should surface when
 * `checkProtectedWrite` returns `{protected: true, destructive: true}`
 * and the operator did not pass `replaceProtected: true`.
 */
export function formatProtectedRefusal(
  targetPath: string,
  verdict: ProtectedSourceVerdict,
): string {
  const sections = verdict.removedSections && verdict.removedSections.length > 0
    ? `\n  Removed sections: ${verdict.removedSections.join(', ')}`
    : ''
  return (
    `Refusing to overwrite protected source file ${targetPath}. ` +
    `${verdict.reason ?? 'destructive change detected'}.${sections}\n` +
    `If you genuinely intend to replace this file rather than append/patch it, ` +
    `re-issue the write with replaceProtected: true and acknowledge the removal in your response.`
  )
}

// ─── helpers ───────────────────────────────────────────────────

function expandTilde(p: string, home: string): string {
  if (!p) return p
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return join(home, p.slice(2))
  }
  return p
}

function isProtectedPath(
  resolvedAbsPath: string,
  relToWorkspace: string,
  envProtectedPaths: string | undefined,
  workspace: string,
): boolean {
  const basename = resolvedAbsPath.split(/[/\\]/).pop() ?? ''

  if (DEFAULT_PROTECTED_FILE_BASENAMES.some(b => b.toLowerCase() === basename.toLowerCase())) {
    return true
  }

  // Workspace-relative dir-prefix match (only when the file is inside
  // the workspace at all).
  if (!relToWorkspace.startsWith('..') && !isAbsolute(relToWorkspace)) {
    const normalized = normalize(relToWorkspace).replace(/\\/g, '/')
    if (DEFAULT_PROTECTED_DIR_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
      return true
    }
  }

  if (envProtectedPaths) {
    const extras = envProtectedPaths.split(':').map(s => s.trim()).filter(Boolean)
    for (const entry of extras) {
      const entryAbs = isAbsolute(entry) ? entry : resolve(workspace, entry)
      if (resolvedAbsPath === entryAbs) return true
      // Treat env entries ending in `/` as directory prefixes.
      if (entry.endsWith('/') || entry.endsWith(sep)) {
        if (resolvedAbsPath.startsWith(entryAbs)) return true
      }
    }
  }

  return false
}

/** Map of `header text → header level (2|3|...)` extracted from markdown. */
function extractHeaders(content: string): Map<string, number> {
  const headers = new Map<string, number>()
  const lines = content.split('\n')
  for (const line of lines) {
    const match = /^(#{2,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (!match) continue
    const level = match[1]!.length
    const text = match[2]!.trim()
    if (text.length === 0) continue
    headers.set(text, level)
  }
  return headers
}

function findRemovedNamedSections(
  oldHeaders: Map<string, number>,
  newHeaders: Map<string, number>,
): string[] {
  const removed: string[] = []
  for (const named of NAMED_SECTION_TITLES) {
    const lower = named.toLowerCase()
    const inOld = [...oldHeaders.keys()].some(h => h.toLowerCase() === lower)
    const inNew = [...newHeaders.keys()].some(h => h.toLowerCase() === lower)
    if (inOld && !inNew) removed.push(named)
  }
  return removed
}
