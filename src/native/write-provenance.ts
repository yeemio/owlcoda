import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { classifyBashCommand } from './bash-risk.js'
import type {
  AdmissionResult,
  ExtractedWriteTarget,
  ProvenanceLedgerData,
  ProvenanceTargetEvaluation,
  ProvenanceRecord,
  SkippedGlobDeny,
  ToolResultPathExtraction,
  UserMessageExtractionResult,
  UserPathExtraction,
} from './protocol/write-provenance-types.js'

export function isGateProvenanceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env['OWLCODA_GATE_PROVENANCE']?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function createEmptyProvenanceLedgerData(): ProvenanceLedgerData {
  return {
    version: 1,
    recordsByPath: {},
  }
}

export function canonicalizeProvenancePath(
  targetPath: string,
  cwd: string,
  opts: { homeDir?: string } = {},
): string {
  const trimmed = targetPath.trim()
  const home = opts.homeDir ?? homedir()
  const expanded = expandTilde(trimmed, home)
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
  return realpathExistingParent(absolute)
}

function expandTilde(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(home, path.slice(2))
  }
  return path
}

function realpathExistingParent(absPath: string): string {
  let cur = absPath
  let suffix = ''
  for (let i = 0; i < 64; i++) {
    try {
      statSync(cur)
      const real = realpathSync(cur)
      return suffix ? join(real, suffix) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) return absPath
      const tail = cur.slice(parent.length).replace(/^[\\/]+/, '')
      suffix = suffix ? join(tail, suffix) : tail
      cur = parent
    }
  }
  return absPath
}

// ---------------------------------------------------------------------------
// Ledger admission helpers (S0-2.1)
//
// Pure-ish functions over `ProvenanceLedgerData`. The data shape is what
// `TaskExecutionState` stores — runtime classes are forbidden in the state
// snapshot, per spec §4.3.
//
// Callers are expected to pass canonical paths (run through
// `canonicalizeProvenancePath` first). These helpers do not canonicalize.
// ---------------------------------------------------------------------------

/**
 * Identity key for record dedupe. Two records on the same path that share
 * `(kind, originIteration, originalString)` are treated as the same
 * observation; ts may differ across re-extractions and is not part of the
 * dedupe key. This matches plan S0-2.1's requirement that repeated
 * `deriveTaskExecutionState(...)` calls do not inflate user-message records.
 */
function recordDedupeKey(record: ProvenanceRecord): string {
  return `${record.kind}|${record.originIteration}|${record.originalString}`
}

/**
 * Append `record` under `path`. If a record with the same dedupe key already
 * exists on the path, the new record is dropped (first writer wins).
 * Mutates `data` in place.
 */
export function admit(
  data: ProvenanceLedgerData,
  path: string,
  record: ProvenanceRecord,
): void {
  const existing = data.recordsByPath[path]
  if (!existing) {
    data.recordsByPath[path] = [record]
    return
  }
  const key = recordDedupeKey(record)
  for (const r of existing) {
    if (recordDedupeKey(r) === key) return
  }
  existing.push(record)
}

/**
 * Return all records admitted under the exact canonical path.
 * Returns the internal array (callers must not mutate); empty array for
 * unknown paths.
 */
export function records(
  data: ProvenanceLedgerData,
  path: string,
): ProvenanceRecord[] {
  return data.recordsByPath[path] ?? []
}

/**
 * Return all records admitted under `dirname(path)` — i.e. the immediate
 * parent directory of `path`. Used by new-file admission to check for
 * `parent_listing` evidence.
 */
export function parentRecords(
  data: ProvenanceLedgerData,
  path: string,
): ProvenanceRecord[] {
  const parent = dirname(path)
  if (parent === path) return [] // root has no parent
  return data.recordsByPath[parent] ?? []
}

/**
 * Total record count across all paths. For telemetry / dogfood diagnostics.
 */
export function size(data: ProvenanceLedgerData): number {
  let total = 0
  for (const path of Object.keys(data.recordsByPath)) {
    total += data.recordsByPath[path].length
  }
  return total
}

/**
 * Deep-copy a `ProvenanceLedgerData` value. Used for subagent inheritance
 * (parent snapshots ledger at spawn; subagent gets isolated copy that does
 * not write back). Records are shallow-cloned because `ProvenanceRecord` is
 * a flat structure with primitive fields.
 *
 * Per spec §4.3: subagents inherit but do not propagate back; this clone
 * is the boundary.
 */
export function cloneProvenanceLedgerData(
  data: ProvenanceLedgerData,
): ProvenanceLedgerData {
  const cloned: ProvenanceLedgerData = {
    version: data.version,
    recordsByPath: {},
  }
  for (const path of Object.keys(data.recordsByPath)) {
    cloned.recordsByPath[path] = data.recordsByPath[path].map(r => ({ ...r }))
  }
  return cloned
}

/**
 * Walk ancestor directories of `path` and return all `user_explicit_deny`
 * records whose `denyScope === 'subtree'`, tagged with the canonical
 * `sourcePath` they were admitted under. Does NOT include denies on the
 * exact path itself — caller handles those via `records(path)`.
 *
 * Used by `evaluateAdmission` Step 1 to implement subtree deny precedence:
 * if any ancestor directory has an active subtree deny, the write to a
 * descendant is blocked regardless of the descendant's own records. The
 * `sourcePath` is required so the caller can look up revoke records on
 * the deny's own path (revokes are scope-matched per spec §16.5).
 *
 * Bounded to 64 levels of ancestry to avoid pathological loops.
 */
export interface AncestorDenyHit {
  sourcePath: string
  record: ProvenanceRecord
}

export function ancestorDenies(
  data: ProvenanceLedgerData,
  path: string,
): AncestorDenyHit[] {
  const result: AncestorDenyHit[] = []
  let cur = path
  for (let i = 0; i < 64; i++) {
    const parent = dirname(cur)
    if (parent === cur) break // reached filesystem root
    const parentRecs = data.recordsByPath[parent]
    if (parentRecs) {
      for (const r of parentRecs) {
        if (r.kind === 'user_explicit_deny' && r.denyScope === 'subtree') {
          result.push({ sourcePath: parent, record: r })
        }
      }
    }
    cur = parent
  }
  return result
}

/**
 * Latest `user_explicit_revoke` timestamp on the given canonical path,
 * or `-Infinity` if no revoke is present. Used by the admission deny check
 * to decide whether a deny has been lifted: a deny is "active" iff its
 * timestamp is strictly greater than the latest revoke on the SAME canonical
 * path it was admitted under (spec §16.5 — scope-matched revoke).
 */
function latestRevokeTsOnPath(data: ProvenanceLedgerData, path: string): number {
  const recs = data.recordsByPath[path]
  if (!recs) return -Infinity
  let max = -Infinity
  for (const r of recs) {
    if (r.kind === 'user_explicit_revoke' && r.ts > max) max = r.ts
  }
  return max
}

/**
 * Optional input channel for synthetic records — used by PERM-4 to inject
 * settings-driven permission rules into the admission decision without
 * mutating the actual ledger. Synthetic records get prepended to the live
 * records so they're seen first by Step 1 (deny) and Step 2 (admit).
 *
 * Synthetic records with `permanent: true` bypass the revoke-ts check in
 * Step 1 entirely — a conversation-level "算了 改吧 X" cannot lift a deny
 * that came from a settings.json rule.
 */
export interface AdmissionOptions {
  syntheticPathRecords?: ProvenanceRecord[]
  syntheticParentRecords?: ProvenanceRecord[]
}

/**
 * Core admission decision for a write target.
 *
 * STEP 1 — deny precedence (always runs first):
 *   1a. Collect candidate denies:
 *       - exact-scope denies on `path` itself (live + synthetic)
 *       - subtree-scope denies on any ancestor directory (via `ancestorDenies`)
 *   1b. For each candidate, look up revokes on the DENY'S OWN PATH
 *       (not the write target). A deny is "active" iff its ts > latest revoke ts
 *       on the same path. EXCEPTION: records with `permanent: true` skip the
 *       revoke check entirely — settings-driven denies cannot be lifted by
 *       conversation-level revoke (PERM-5).
 *   1c. If any active deny remains, return blocked with `denyActive=true` and
 *       the most recently-timestamped active deny as `activeDenyRecord`.
 *
 * STEP 2 — admit rules (only if no active deny):
 *   - `user_declared_target` on path → admit (live or synthetic)
 *   - new file: `parent_listing` on parent → admit
 *   - existing file: `tool_confirmed_existing` on path → admit
 *   - else block (with diagnostic `availableRecords`)
 *
 * `path` must be canonical (pass through `canonicalizeProvenancePath` first).
 */
export function evaluateAdmission(
  data: ProvenanceLedgerData,
  path: string,
  isNewFile: boolean,
  opts: AdmissionOptions = {},
): AdmissionResult {
  // Synthetic records (PERM-4) come first so Step 1 / Step 2 see them
  // ahead of live records. This matches the "rules act as baseline
  // evidence" semantic.
  const syntheticPath = opts.syntheticPathRecords ?? []
  const syntheticParent = opts.syntheticParentRecords ?? []
  const pathRecs = [...syntheticPath, ...records(data, path)]
  const parentRecs = isNewFile
    ? [...syntheticParent, ...parentRecords(data, path)]
    : []

  // ===== STEP 1: deny precedence =====
  const activeDenies: ProvenanceRecord[] = []

  // 1a-i: exact denies on the write target's own path; revokes also on same path
  const latestRevokeOnTarget = latestRevokeTsOnPath(data, path)
  for (const r of pathRecs) {
    if (r.kind !== 'user_explicit_deny') continue
    if ((r.denyScope ?? 'exact') !== 'exact') continue
    if (r.permanent === true) {
      // Permanent (rule-driven) denies bypass the revoke check entirely.
      activeDenies.push(r)
      continue
    }
    if (r.ts > latestRevokeOnTarget) {
      activeDenies.push(r)
    }
  }

  // 1a-ii: subtree denies on ancestors; each has its own sourcePath for revoke lookup
  for (const hit of ancestorDenies(data, path)) {
    if (hit.record.permanent === true) {
      activeDenies.push(hit.record)
      continue
    }
    const latestRevokeOnAncestor = latestRevokeTsOnPath(data, hit.sourcePath)
    if (hit.record.ts > latestRevokeOnAncestor) {
      activeDenies.push(hit.record)
    }
  }

  if (activeDenies.length > 0) {
    // Pick the latest — but permanent records use -Infinity ts, so they
    // never out-rank non-permanent ones by ts alone. Bias toward permanent
    // when both exist so the diagnostic surfaces the rule-driven block
    // (clearer "fix your settings.json" guidance for the user).
    const latest = activeDenies.reduce((best, r) => {
      if (r.permanent && !best.permanent) return r
      if (!r.permanent && best.permanent) return best
      return r.ts > best.ts ? r : best
    })
    return {
      admitted: false,
      denyActive: true,
      activeDenyRecord: latest,
      availableRecords: { path: pathRecs, parent: parentRecs },
    }
  }

  // ===== STEP 2: admit rules =====
  const declared = pathRecs.find(r => r.kind === 'user_declared_target')
  if (declared) {
    return { admitted: true, via: 'user_declared_target', record: declared }
  }

  if (isNewFile) {
    const parentListing = parentRecs.find(r => r.kind === 'parent_listing')
    if (parentListing) {
      return { admitted: true, via: 'parent_listing', record: parentListing }
    }
  } else {
    const confirmed = pathRecs.find(r => r.kind === 'tool_confirmed_existing')
    if (confirmed) {
      return { admitted: true, via: 'tool_confirmed_existing', record: confirmed }
    }
  }

  return {
    admitted: false,
    availableRecords: { path: pathRecs, parent: parentRecs },
  }
}

// ---------------------------------------------------------------------------
// Error formatter (S2-2)
//
// Produces the human-readable diagnostic strings the gate hands back to the
// model in the `tool_result.output` field. Per spec §5.5, the formatter
// distinguishes:
//
//   - Active deny  — quotes the deny iteration and original wording, names
//                    the path explicitly, and tells the model the deny
//                    cannot be undone by later declared_target alone
//                    (revoke must use the same path by name).
//   - Existing-no-records — suggests Read/Glob to confirm OR ask user.
//   - Existing-with-reference-only — names the record kinds present so the
//                    model can see WHY they don't authorize.
//   - New-file-no-admission — names the parent dir and prompts ls / Glob /
//                    mkdir to admit it.
//   - Multi-target — aggregates per-target diagnostics with a header.
//
// Deny diagnostics ALWAYS render first when present (matches §5.5: "Deny
// block always rendered first"), regardless of input order.
// ---------------------------------------------------------------------------

/**
 * Build a histogram-style description of the records currently associated
 * with a scope (eg. "this path" or "parent `/abs/dist`"). Used by the
 * non-deny diagnostic paths so the model can see which kinds it has and
 * which kinds it's missing.
 */
function formatRecordHistogram(recs: ProvenanceRecord[], scope: string): string {
  const counts: Record<string, number> = {}
  for (const r of recs) {
    counts[r.kind] = (counts[r.kind] ?? 0) + 1
  }
  const kinds = Object.keys(counts).sort()
  if (kinds.length === 0) return ''
  const lines = [`Records I have for ${scope}:`]
  for (const kind of kinds) {
    const n = counts[kind]
    let note = ''
    switch (kind) {
      case 'user_reference':
        note = ' (mentioned in user messages but not as a write target —\n      eg. existential references or quoted log lines)'
        break
      case 'tool_confirmed_existing':
        note = ' (some files in this scope were Read/Glob/Grep-confirmed, but no listing of the directory itself authorized creating new files inside it)'
        break
      case 'parent_listing':
        note = ' (parent dir was listed; for an EXISTING file the path itself still needs path-level evidence)'
        break
      case 'user_explicit_deny':
        note = ' (explicit prohibition — rendered above)'
        break
      case 'user_explicit_revoke':
        note = ' (lifted a prior deny; does not by itself authorize a write)'
        break
    }
    lines.push(`  - ${n} × ${kind}${note}`)
  }
  return lines.join('\n')
}

/**
 * Per-failure diagnostic block.
 */
function formatSingleFailure(f: ProvenanceTargetEvaluation): string {
  const path = f.canonical

  if (f.admission.denyActive && f.admission.activeDenyRecord) {
    const deny = f.admission.activeDenyRecord
    return [
      `I cannot write to \`${path}\`.`,
      ``,
      `The user explicitly prohibited this path in turn ${deny.originIteration}:`,
      `  > "${deny.originalString}"`,
      ``,
      `This deny is still active. To proceed I need either:`,
      `  - the user to explicitly lift the deny — eg. "算了 改吧 ${path}" / "actually edit ${path}"`,
      `  - or honor the deny: don't write to this path`,
      ``,
      `A user_declared_target later in the conversation does NOT override an explicit deny.`,
      `The deny stays until the user explicitly revokes it by name (path-exact match).`,
    ].join('\n')
  }

  if (f.isNewFile) {
    const parent = dirname(path)
    const parentRecs = f.admission.availableRecords?.parent ?? []
    const histogram = formatRecordHistogram(parentRecs, `parent \`${parent}\``)
    const lines = [
      `I'd be creating \`${path}\` (new file), but neither the path nor its parent`,
      `\`${parent}\` has admission evidence.`,
    ]
    if (histogram) {
      lines.push('', histogram)
    }
    lines.push(
      ``,
      `Models frequently default to cwd when the actual artifact lives elsewhere.`,
      `To proceed I need either:`,
      `  - user_declared_target — the user explicitly says to write this path`,
      `  - parent_listing — Run \`ls ${parent}\` or \`Glob '${parent}/*'\` or \`mkdir -p ${parent}\``,
      `                     first to confirm this is the intended location`,
      ``,
      `Or ask the user for the explicit destination path.`,
    )
    return lines.join('\n')
  }

  // Existing file branch
  const pathRecs = f.admission.availableRecords?.path ?? []
  if (pathRecs.length === 0) {
    return [
      `I don't have evidence that \`${path}\` is the file the user wants changed.`,
      `The path hasn't appeared in any user message or successful Read/Glob/Grep/find result`,
      `in this conversation.`,
      ``,
      `To proceed:`,
      `  - Run \`Read ${path}\` or \`Glob '<pattern>'\` to confirm, OR`,
      `  - Ask the user for the explicit path.`,
    ].join('\n')
  }
  return [
    `I don't have evidence that \`${path}\` is the file the user wants changed.`,
    ``,
    formatRecordHistogram(pathRecs, 'this path'),
    ``,
    `These records do NOT authorize a write — user_reference is an existential mention, not an instruction.`,
    `To proceed I need either:`,
    `  - user_declared_target — the user explicitly says to write/edit this path`,
    `  - tool_confirmed_existing — Run \`Read ${path}\` first to confirm it's the right file`,
    ``,
    `Or ask the user for the explicit path.`,
  ].join('\n')
}

/**
 * Top-level error formatter. Renders deny failures first (highest
 * precedence), then non-deny failures. For multi-target calls, adds a
 * header naming the target count and a closing "resolve each" reminder.
 *
 * Returns the empty string when `failures` is empty so callers can use
 * it unconditionally without an extra length check.
 */
export function formatProvenanceError(
  failures: ProvenanceTargetEvaluation[],
  context: { command?: string } = {},
): string {
  if (failures.length === 0) return ''

  const denies = failures.filter(f => f.admission.denyActive === true)
  const others = failures.filter(f => f.admission.denyActive !== true)
  const ordered = [...denies, ...others]

  const isMulti = failures.length > 1
  const parts: string[] = []
  if (isMulti) {
    const cmd = context.command ? `\`${context.command}\` ` : ''
    parts.push(`Command ${cmd}writes to ${failures.length} paths; ${failures.length} lack admission:`)
  }
  for (const f of ordered) {
    parts.push(formatSingleFailure(f))
  }
  if (isMulti) {
    parts.push('Resolve each before retry. See per-path guidance above.')
  }
  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// User-message extractor (S0-3)
//
// Classifies each path-like token in a user message into one of four
// `UserPathExtraction.kind` values via 4-stage priority:
//
//   Stage A — `user_explicit_deny`     (prohibition pattern; §16)
//   Stage B — `user_explicit_revoke` + dual `user_declared_target`
//   Stage C — `user_declared_target`   (verb-paired write target)
//   Stage D — `user_reference`         (default fallback)
//
// Path-token regex captures absolute, relative, and `~/`-form paths with
// at least one `/` and at least one alphabetic segment. URLs and version
// strings are excluded.
// ---------------------------------------------------------------------------

/**
 * Path-like token regex. Two alternations:
 *   - **Anchored**: starts with `/`, `~/`, `./`, or `../` plus 1+ segments.
 *     Catches `/a.ts`, `/tmp/x.ts`, `~/notes`, `./script.sh`.
 *   - **Unanchored relative**: 2+ segments separated by `/`. Catches
 *     `src/a.ts` but rejects bare `README.md` (no slash).
 *
 * URLs, pure version strings, and single-segment unanchored tokens are
 * filtered post-match by `isPathLikeToken`.
 */
const PATH_TOKEN_RE =
  /(?<![\w.\-_])(?:(?:~\/|\.{1,2}\/|\/)[\w.\-_]+(?:\/[\w.\-_]+)*|[\w.\-_]+(?:\/[\w.\-_]+)+)/g

/** Characters stripped from the end of a captured path (sentence punctuation). */
const TRAILING_PUNCT_RE = /[.,;:!?)\]}'"`]+$/

function isPathLikeToken(token: string): boolean {
  // Must contain at least one slash (filters out version strings like 1.2.3).
  if (!token.includes('/')) return false
  // Reject anything that looks like a URL.
  if (/^https?:\/\//i.test(token)) return false
  // At least one segment must contain a letter or underscore — filters out
  // strings of pure digits/dots/dashes like "1.2.3/4.5.6".
  const segments = token.split('/').filter(Boolean)
  return segments.some(s => /[a-zA-Z_]/.test(s))
}

/**
 * Strip ASCII trailing punctuation that the regex may have greedily
 * captured (eg. trailing `.` in "/tmp/x.ts." becomes "/tmp/x.ts").
 * Defensive: leaves trailing `/` alone.
 */
function stripTrailingPunct(token: string): string {
  return token.replace(TRAILING_PUNCT_RE, '')
}

/**
 * Find every path-like token in `text` and return its raw form, the
 * post-punctuation-strip cleaned form, and the offset within `text`.
 * Skips tokens that fail `isPathLikeToken` and skips matches that look
 * like the path portion of a URL (eg. captured `/foo/bar` from
 * `https://example.com/foo/bar` is suppressed via the URL-prefix check).
 */
interface PathTokenMatch {
  raw: string         // original text captured by the regex
  cleaned: string     // after trailing-punctuation strip
  offset: number      // index into `text`
}

function findPathTokens(text: string): PathTokenMatch[] {
  if (!text) return []
  const hits: PathTokenMatch[] = []
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    if (m.index == null) continue
    const raw = m[0]
    if (!isPathLikeToken(raw)) continue

    // Reject path captured as part of a URL. The path-regex may consume the
    // second `/` of `://` as its leading slash, so we check for three
    // distinct boundary patterns in a 16-char window before the match:
    //   - `://` fully present (eg. regex started mid-domain, not at the slash)
    //   - ends in `:/` or `://` (regex started AT the second slash of `://`)
    //   - ends in `https:` or `http:` (regex started after the scheme colon)
    const before = text.slice(Math.max(0, m.index - 16), m.index)
    if (before.includes('://')) continue
    if (/:\/{1,2}$/.test(before)) continue
    if (/https?:$/i.test(before)) continue

    hits.push({ raw, cleaned: stripTrailingPunct(raw), offset: m.index })
  }
  return hits
}

/**
 * Build a contextual `originalString` window around a token match. Keeps
 * 16 chars of surrounding context on each side (trimmed to text bounds).
 */
function contextWindow(text: string, offset: number, tokenLength: number): string {
  const start = Math.max(0, offset - 16)
  const end = Math.min(text.length, offset + tokenLength + 16)
  return text.slice(start, end)
}

/**
 * Window size (in characters) for verb / deny / revoke pattern detection
 * before a path-like token. Spec §5.3.1.
 */
const CLASSIFIER_WINDOW = 30

/**
 * Implementation verbs that promote a path-like token to `user_declared_target`.
 * Two capture groups: group 1 for Chinese (no word boundary), group 2 for
 * English (with \b boundary so "writeable" does not trigger "write").
 *
 * Longer Chinese alternatives appear before shorter ones so "改一下" matches
 * the suffix-form first rather than stripping to bare "改".
 */
const IMPL_VERB_RE_G =
  /(改一下|修一下|修改|改进|修复|创建|编辑|更新|实施|落地|动手|重构|改|修|写|加|删)|\b(implement|refactor|modify|update|create|remove|deploy|delete|patch|merge|build|write|edit|fix|add|ship)\b/gi

/**
 * Return the rightmost (= closest to the end of the window) implementation
 * verb match within `window`, or null if none.
 */
function findClosestVerbInWindow(window: string): string | null {
  let last: string | null = null
  for (const m of window.matchAll(IMPL_VERB_RE_G)) {
    last = m[1] ?? m[2] ?? null
  }
  return last
}

/**
 * Prohibition markers that promote a path-like token to `user_explicit_deny`.
 * Chinese markers optionally accept a follow-up action verb (`改|动|碰|删|写|加`).
 * English `don't|do not|never|must not` optionally accepts a mutating verb.
 *
 * Stage A runs before Stage C so phrases like `不要改 X` register as deny
 * rather than as declared_target (`改` would otherwise match the impl verb
 * regex).
 */
const DENY_MARKER_RE_G =
  /(?:不要|别|不许|禁止|不能|不可以|不准|千万别)\s*[改动碰删写加]?|\b(?:don'?t|do not|never|must not)(?:\s+(?:modify|touch|change|edit|delete|write|alter))?/gi

function findClosestDenyMarkerInWindow(window: string): string | null {
  let last: string | null = null
  for (const m of window.matchAll(DENY_MARKER_RE_G)) {
    last = m[0]
  }
  return last
}

/**
 * Decide `denyScope` from on-disk state of the canonical target path.
 * Existing directories → `subtree` (deny applies to all descendants).
 * Existing files OR non-existent paths → `exact` (deny applies only to
 * that literal canonical path).
 */
function detectDenyScope(canonical: string): 'exact' | 'subtree' {
  try {
    const stat = statSync(canonical)
    return stat.isDirectory() ? 'subtree' : 'exact'
  } catch {
    return 'exact'
  }
}

/**
 * Revoke markers — explicit "I changed my mind" / "go ahead" words — that
 * MUST be paired with a separate implementation verb in the same window to
 * emit Stage B's dual record. Per spec §16.3, the marker list is **only the
 * pure revoke words**; verb-imperatives like `改吧` / `动吧` belong in the
 * verb list, not here, so that bare `改吧 X` (without a `算了` / `撤回` / etc.
 * marker) classifies as `user_declared_target` only, not revoke.
 *
 * Bare marker without a verb still does NOT trigger revoke (conservative
 * bias: revoke false-positive is more costly than false-negative, §5.3.1).
 */
const REVOKE_MARKER_RE_G =
  /(?:算了吧|算了|撤回|不算)|\b(?:actually|scratch\s+that|never\s+mind|go\s+ahead|you\s+can\s+now|on\s+second\s+thought)\b/gi

function findClosestRevokeMarkerInWindow(window: string): string | null {
  let last: string | null = null
  for (const m of window.matchAll(REVOKE_MARKER_RE_G)) {
    last = m[0]
  }
  return last
}

/**
 * Detect whether the text immediately following a matched path token continues
 * into a glob expression (eg. `/foo` followed by `/*.ts` → `/foo/*.ts` is a
 * glob, not a literal path). Used to suppress emission of the literal prefix
 * when the user intent was glob-shaped.
 */
function isGlobContinuationAfter(text: string, matchEnd: number): boolean {
  const after = text.slice(matchEnd, matchEnd + 4)
  // Matches `/*` or `/?` (glob continuation) OR a bare `*`/`?` directly
  // continuing the token without slash (rare but possible).
  return /^\/[*?]|^[*?]/.test(after)
}

/**
 * Scan the user message for deny phrases followed by glob-shaped tokens.
 * Glob denies are out of scope for v1 (spec §16.5 / OQ10) — instead of
 * emitting a literal deny, we report them via `skippedGlobDenies` so the
 * wired caller can emit `path_provenance_deny_pattern_skipped` telemetry.
 *
 * A "glob-shaped token" here means: contains `*` or `?`, plus either has
 * a `/` separator or starts with `~/` / `./` / `../`. Standalone wildcards
 * without path structure are out of scope.
 */
function findSkippedGlobDenies(text: string): SkippedGlobDeny[] {
  const result: SkippedGlobDeny[] = []
  // Use a fresh regex instance — matchAll doesn't rely on .lastIndex but
  // we want isolation from any captured state on the module-level regex.
  const denyRe = new RegExp(DENY_MARKER_RE_G.source, 'gi')
  for (const m of text.matchAll(denyRe)) {
    if (m.index == null) continue
    const markerEnd = m.index + m[0].length
    const after = text.slice(markerEnd, markerEnd + 64)
    const tokenMatch = after.match(/^\s*(\S+)/)
    if (!tokenMatch || !tokenMatch[1]) continue
    const rawToken = tokenMatch[1]
    const token = rawToken.replace(/[.,;:!?]+$/, '')
    if (!/[*?]/.test(token)) continue
    const pathLike =
      token.includes('/') || /^~\//.test(token) || /^\.{1,2}\//.test(token)
    if (!pathLike) continue
    const ctxStart = Math.max(0, m.index - 8)
    const ctxEnd = Math.min(text.length, markerEnd + tokenMatch[0].length + 8)
    result.push({
      pattern: token,
      originalString: text.slice(ctxStart, ctxEnd),
    })
  }
  return result
}

/**
 * Narrow escape hatch for explicit deny phrases such as `不要改 existingDir`.
 *
 * The general user-message extractor intentionally ignores bare single-segment
 * tokens to avoid turning ordinary words into file references. Explicit deny is
 * the one place where the user may naturally name a local directory/file
 * without `./`; even there we only accept the token if it already exists on
 * disk under cwd. Non-existent bare words stay invisible.
 */
function findBareExistingDenyTargets(
  text: string,
  opts: { cwd: string; homeDir?: string },
): UserPathExtraction[] {
  const result: UserPathExtraction[] = []
  const denyRe = new RegExp(DENY_MARKER_RE_G.source, 'gi')
  for (const m of text.matchAll(denyRe)) {
    if (m.index == null) continue
    const marker = m[0]
    const markerEnd = m.index + marker.length
    const after = text.slice(markerEnd)
    const leading = after.match(/^\s*/)?.[0] ?? ''
    let tokenStart = markerEnd + leading.length
    let rest = text.slice(tokenStart)
    let quote: string | null = null
    if (rest[0] === '`' || rest[0] === '"' || rest[0] === "'") {
      quote = rest[0]
      tokenStart += 1
      rest = rest.slice(1)
    }

    const rawToken = quote
      ? rest.slice(0, rest.indexOf(quote) >= 0 ? rest.indexOf(quote) : undefined)
      : rest.match(/^[A-Za-z0-9_.-]+/)?.[0] ?? ''
    const token = stripTrailingPunct(rawToken.trim())
    if (!token) continue
    if (token === '.' || token === '..') continue
    if (token.includes('/') || token.includes('\\') || token.startsWith('~')) continue
    if (token.startsWith('-')) continue
    if (!/[A-Za-z_]/.test(token)) continue

    const canonical = canonicalizeProvenancePath(token, opts.cwd, {
      homeDir: opts.homeDir,
    })
    try {
      statSync(canonical)
    } catch {
      continue
    }

    result.push({
      path: canonical,
      originalString: contextWindow(text, tokenStart, token.length),
      kind: 'user_explicit_deny',
      denyMarker: marker,
      denyScope: detectDenyScope(canonical),
    })
  }
  return result
}

/**
 * Extract path classifications from a user-originated text message.
 *
 * v1 of this function implements Stage D only (default `user_reference`).
 * Stages A (deny), B (revoke), and C (declared_target) will be layered on
 * in subsequent commits per the S0-3 plan; the public signature is stable.
 *
 * Caller is responsible for:
 * - only calling on user-originated text (assistant text never enters the
 *   ledger per spec §16.6 anti-pattern guard)
 * - building `ProvenanceRecord`s from the returned extractions, stamping
 *   the `ts` / `originIteration` they pass in `opts` onto each record
 *
 * Skipped glob-shaped denies (eg. `不要改 src/*.ts`) are surfaced via the
 * result's `skippedGlobDenies` field for wired telemetry. v1 returns
 * an empty array here; Stage A landing will populate it.
 */
export function extractPathsFromUserMessage(
  text: string,
  opts: {
    cwd: string
    ts: number
    originIteration: number
    homeDir?: string
  },
): UserMessageExtractionResult {
  if (!text) return { extractions: [], skippedGlobDenies: [] }

  const extractions: UserPathExtraction[] = []
  const skippedGlobDenies = findSkippedGlobDenies(text)
  extractions.push(...findBareExistingDenyTargets(text, opts))
  for (const hit of findPathTokens(text)) {
    // Suppress emission when the matched token is the literal prefix of a
    // glob expression (eg. `/tmp/foo` in `/tmp/foo/*.ts`). The glob context
    // is already captured by `findSkippedGlobDenies` for deny contexts;
    // non-deny glob mentions are silently skipped (out of scope for v1).
    if (isGlobContinuationAfter(text, hit.offset + hit.raw.length)) {
      continue
    }
    const canonical = canonicalizeProvenancePath(hit.cleaned, opts.cwd, {
      homeDir: opts.homeDir,
    })
    const originalString = contextWindow(text, hit.offset, hit.raw.length)
    const before = text.slice(Math.max(0, hit.offset - CLASSIFIER_WINDOW), hit.offset)

    // Stage A: prohibition marker within CLASSIFIER_WINDOW chars before path.
    // Runs before Stage C so `不要改 X` is deny, not declared_target.
    const denyMarker = findClosestDenyMarkerInWindow(before)
    if (denyMarker) {
      extractions.push({
        path: canonical,
        originalString,
        kind: 'user_explicit_deny',
        denyMarker,
        denyScope: detectDenyScope(canonical),
      })
      continue
    }

    // Stage C verb pre-compute (also used by Stage B).
    const verb = findClosestVerbInWindow(before)

    // Stage B: revoke marker + implementation verb within window → DUAL emit
    // (user_explicit_revoke + synthetic user_declared_target). Bare marker
    // without verb falls through to Stage C/D.
    const revokeMarker = findClosestRevokeMarkerInWindow(before)
    if (revokeMarker && verb) {
      extractions.push({
        path: canonical,
        originalString,
        kind: 'user_explicit_revoke',
        revokeMarker,
        verbContext: verb,
      })
      extractions.push({
        path: canonical,
        originalString,
        kind: 'user_declared_target',
        verbContext: verb,
      })
      continue
    }

    // Stage C: implementation verb within CLASSIFIER_WINDOW chars before path.
    if (verb) {
      extractions.push({
        path: canonical,
        originalString,
        kind: 'user_declared_target',
        verbContext: verb,
      })
      continue
    }

    // Stage D: default fallback
    extractions.push({
      path: canonical,
      originalString,
      kind: 'user_reference',
    })
  }
  return { extractions, skippedGlobDenies }
}

// ---------------------------------------------------------------------------
// Tool-result extractor (S0-4)
//
// Per-tool dispatch on successful results:
//
//   Read   → input path as `tool_confirmed_existing` (does NOT admit parent)
//   Glob   → each match as `tool_confirmed_existing` + longest static parent
//            as `parent_listing` (no parent admit for full-tree patterns)
//   Grep   → each matched file as `tool_confirmed_existing` (no parent)
//   Bash   → ls/find/tree: queried dir + matched lines
//            mkdir / mkdir -p: each created dir as `parent_listing`
//
// Spec §5.3.2: `isError=true` returns `[]` always — failed locators admit
// nothing. This is the Article failure-mode safeguard (F24).
// ---------------------------------------------------------------------------

interface ToolResultExtractorOpts {
  cwd: string
  ts: number
  originIteration: number
  homeDir?: string
}

export function extractPathsFromToolResult(
  toolName: string,
  // input shape varies per tool; callers pass the parsed `input` object
  // directly. Type as Record so the extractor inspects fields defensively.
  input: Record<string, unknown>,
  // Tool result text. For Read this is file content; for Glob/Grep/Bash this
  // is the stdout/stderr text. v1 doesn't differentiate stream — wired caller
  // is expected to pass the visible result text.
  result: string,
  isError: boolean,
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  // Spec §5.3.2 — failed locators admit nothing.
  if (isError) return []
  void result

  const normalized = toolName.toLowerCase()

  switch (normalized) {
    case 'read':
      return extractFromRead(toolName, input, opts)
    case 'glob':
      return extractFromGlob(toolName, input, result, opts)
    case 'grep':
      return extractFromGrep(toolName, input, result, opts)
    case 'bash':
      return extractFromBash(toolName, input, result, opts)
    default:
      return []
  }
}

/**
 * Read tool: admits the input `path` as `tool_confirmed_existing`.
 * `file_path` is accepted as a compatibility alias for older fixtures/spec
 * wording, but native OwlCoda tools use `path`.
 *
 * Critical invariant (spec §5.3.2, F25): Read does NOT admit the parent
 * directory. Knowing a sibling file exists doesn't authorize creating new
 * files in the same dir — model must explicitly `ls` or `Glob` the parent.
 */
function extractFromRead(
  toolName: string,
  input: Record<string, unknown>,
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  const filePath = firstStringField(input, ['path', 'file_path'])
  if (typeof filePath !== 'string' || filePath.length === 0) return []
  const canonical = canonicalizeProvenancePath(filePath, opts.cwd, {
    homeDir: opts.homeDir,
  })
  return [
    {
      path: canonical,
      originalString: filePath,
      kind: 'tool_confirmed_existing',
      toolName,
      toolSucceeded: true,
    },
  ]
}

/**
 * Glob meta-chars used to delimit the static prefix of a pattern. A segment
 * that contains any of these is the first non-literal segment; everything
 * before it is the static prefix.
 */
const GLOB_META_RE = /[*?[{]/

/**
 * Compute the longest static (no-wildcard) prefix of a glob pattern. Returns
 * `null` when:
 *   - the pattern has no meta chars at all (treated as a literal lookup —
 *     spec only admits parent_listing for glob queries, not literal probes)
 *   - the first segment already contains a meta char (eg. `**` / `*.ts` —
 *     static prefix is empty and admitting it would be too broad)
 *
 * Otherwise returns the joined static segments. Preserves a leading `/` for
 * absolute patterns.
 */
function longestStaticGlobPrefix(pattern: string): string | null {
  if (!GLOB_META_RE.test(pattern)) return null
  const isAbsolute = pattern.startsWith('/')
  const segments = pattern.split('/')
  const staticSegs: string[] = []
  let hitMeta = false
  for (const seg of segments) {
    if (GLOB_META_RE.test(seg)) {
      hitMeta = true
      break
    }
    staticSegs.push(seg)
  }
  if (!hitMeta) return null
  // Strip leading empty produced by absolute path split; we'll re-prepend `/`.
  const meaningful = isAbsolute ? staticSegs.slice(1) : staticSegs
  if (meaningful.length === 0) return null
  const joined = meaningful.join('/')
  return isAbsolute ? '/' + joined : joined
}

/**
 * Glob tool: admits matched lines as `tool_confirmed_existing` and the
 * pattern's longest static parent prefix as `parent_listing`.
 *
 * Per spec §5.3.2: full-tree patterns (leading globstar / leading wildcard)
 * admit no parent because the static prefix is empty — emitting cwd as
 * parent_listing would be too broad. See `longestStaticGlobPrefix` for
 * the prefix logic.
 *
 * Empty Glob result (zero matches) still admits parent_listing — the dir was
 * queried even if no files matched.
 */
function extractFromGlob(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  const pattern = input['pattern']
  if (typeof pattern !== 'string' || pattern.length === 0) return []
  const out: ToolResultPathExtraction[] = []
  const prefix = longestStaticGlobPrefix(pattern)
  if (prefix !== null) {
    out.push({
      path: canonicalizeProvenancePath(prefix, opts.cwd, { homeDir: opts.homeDir }),
      originalString: pattern,
      kind: 'parent_listing',
      toolName,
      toolSucceeded: true,
    })
  }
  for (const rawLine of result.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // Tolerant: only treat lines that look path-shaped as matches.
    if (!line.includes('/') && !line.startsWith('~')) continue
    out.push({
      path: canonicalizeProvenancePath(line, opts.cwd, { homeDir: opts.homeDir }),
      originalString: line,
      kind: 'tool_confirmed_existing',
      toolName,
      toolSucceeded: true,
    })
  }
  return out
}

/**
 * Path-prefix extractor for Grep result lines. Handles both:
 *   - `path/to/file.ts` (paths-only mode)
 *   - `path/to/file.ts:42:matched line content` (-n mode)
 *   - `path/to/file.ts-42-context line` (-A/-B mode separator)
 *
 * Returns the path portion or null if the line doesn't look path-shaped.
 * The leading segment must contain `/` or start with `~` to qualify.
 */
function grepLinePathPrefix(line: string): string | null {
  // Match: leading non-colon-non-space run that contains / or is ~-prefixed.
  // Strip any `:digit:` or `-digit-` line-number suffix.
  const m = line.match(/^([^\s:]+(?:[/][^\s:]+)*)/)
  if (!m) return null
  const candidate = m[1]
  if (!candidate.includes('/') && !candidate.startsWith('~')) return null
  return candidate
}

/**
 * Grep tool: admits each matched file path as `tool_confirmed_existing`.
 * Distinct paths are deduped within a single result; non-path lines (headers,
 * summaries) are skipped.
 *
 * Critical: Grep does NOT admit any parent directory. It's a content search,
 * not a listing — same principle as Read (§5.3.2).
 */
function extractFromGrep(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  const pattern = input['pattern']
  if (typeof pattern !== 'string' || pattern.length === 0) return []
  const seen = new Set<string>()
  const out: ToolResultPathExtraction[] = []
  for (const rawLine of result.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const candidate = grepLinePathPrefix(line)
    if (!candidate) continue
    const canonical = canonicalizeProvenancePath(candidate, opts.cwd, {
      homeDir: opts.homeDir,
    })
    if (seen.has(canonical)) continue
    seen.add(canonical)
    out.push({
      path: canonical,
      originalString: candidate,
      kind: 'tool_confirmed_existing',
      toolName,
      toolSucceeded: true,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Bash dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Tokenize a bash command into rough args. Handles single + double quoted
 * runs and backslash-escapes. Not a full shell parser — operators like `|`,
 * `&&`, `>`, `;` are returned as their own tokens but not interpreted.
 * Sufficient for extracting the queried directory in `ls/find/tree/mkdir`.
 */
function tokenizeBashCommand(command: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < command.length) {
    const c = command[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        cur += command[i + 1]
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
        i++
        continue
      }
      cur += c
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      i++
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += command[i + 1]
      i += 2
      continue
    }
    if (/\s/.test(c)) {
      if (cur) {
        tokens.push(cur)
        cur = ''
      }
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur) tokens.push(cur)
  return tokens
}

/**
 * Pick the directory argument from a discovery-command tokenization.
 * Skips flag tokens (starting with `-`) and command-specific flag values
 * (`-name <glob>` etc). Returns the first non-flag positional, or `null`
 * if none found.
 */
function pickDirArg(tokens: string[]): string | null {
  // tokens[0] is the command name; start at 1.
  let i = 1
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.startsWith('-')) {
      // Some long flags eat the next arg (`-name <pat>`, `-type <c>`,
      // `-maxdepth <n>`). v1 conservative: assume any `-X` consumes the
      // next token when it looks like a value.
      const flagsThatEatNext = new Set(['-name', '-iname', '-type', '-maxdepth', '-mindepth', '-path', '-regex', '-not'])
      if (flagsThatEatNext.has(t) && i + 1 < tokens.length) {
        i += 2
        continue
      }
      i++
      continue
    }
    return t
  }
  return null
}

/**
 * Strip a single trailing slash from a path (`/abs/dir/` → `/abs/dir`)
 * while leaving root `/` alone.
 */
function stripTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1)
  return p
}

/**
 * Parse `ls` output. Detects:
 *   - `ls` (basic) — basenames, one per line
 *   - `ls -l` / `ls -la` — first line `total N`, subsequent lines start with
 *     permission bits and end with the basename
 * Returns extracted basenames; caller joins them with the queried dir.
 */
function parseLsLines(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (/^total\s+\d+$/.test(line.trim())) continue
    // `ls -l` format: starts with one of [-dlbcps] followed by 9 mode chars.
    const lsLong = line.match(/^[-dlbcps][-rwxsStT]{9}[+@.]?\s.*\s(\S+)\s*$/)
    if (lsLong) {
      const name = lsLong[1]
      if (name === '.' || name === '..') continue
      out.push(name)
      continue
    }
    // Plain `ls`: line is the basename (or full path). Skip dot entries.
    const trimmed = line.trim()
    if (trimmed === '.' || trimmed === '..') continue
    out.push(trimmed)
  }
  return out
}

/**
 * Bash dispatch: recognizes discovery commands and emits parent_listing for
 * the queried dir plus tool_confirmed_existing for matched entries. Other
 * commands (echo, cat, etc.) yield `[]` — write-target extraction for `>`,
 * `tee`, `sed -i`, `cp`, `mv`, `rm`, heredoc, etc. is S0-5 scope.
 *
 * Per spec §7.4: does NOT recursively admit subdirectories. `ls dist/`
 * admits `dist` and entries directly under it, but a subdirectory `dist/sub`
 * is only `tool_confirmed_existing` (as an entry), not `parent_listing`.
 */
function extractFromBash(
  toolName: string,
  input: Record<string, unknown>,
  result: string,
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  const command = input['command']
  if (typeof command !== 'string' || command.length === 0) return []
  const tokens = tokenizeBashCommand(command.trim())
  if (tokens.length === 0) return []
  const head = tokens[0].toLowerCase()
  switch (head) {
    case 'ls':
      return extractBashLs(toolName, tokens, result, opts)
    case 'find':
      return extractBashFind(toolName, tokens, result, opts)
    case 'tree':
      return extractBashTree(toolName, tokens, opts)
    case 'mkdir':
      return extractBashMkdir(toolName, tokens, opts)
    default:
      return []
  }
}

function extractBashLs(
  toolName: string,
  tokens: string[],
  result: string,
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  const dirArgRaw = pickDirArg(tokens)
  const dirArg = dirArgRaw ?? '.'
  const queriedDir = canonicalizeProvenancePath(stripTrailingSlash(dirArg), opts.cwd, {
    homeDir: opts.homeDir,
  })
  const out: ToolResultPathExtraction[] = [
    {
      path: queriedDir,
      originalString: dirArgRaw ?? '.',
      kind: 'parent_listing',
      toolName,
      toolSucceeded: true,
    },
  ]
  const basenames = parseLsLines(result.split('\n'))
  for (const name of basenames) {
    // ls may emit either a basename or a full path (with -R, etc.).
    // canonicalize either form against the queried dir.
    const joined = name.startsWith('/') || name.startsWith('~')
      ? name
      : join(queriedDir, name)
    out.push({
      path: canonicalizeProvenancePath(joined, opts.cwd, { homeDir: opts.homeDir }),
      originalString: name,
      kind: 'tool_confirmed_existing',
      toolName,
      toolSucceeded: true,
    })
  }
  return out
}

function extractBashFind(
  toolName: string,
  tokens: string[],
  result: string,
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  const dirArgRaw = pickDirArg(tokens)
  const dirArg = dirArgRaw ?? '.'
  const queriedDir = canonicalizeProvenancePath(stripTrailingSlash(dirArg), opts.cwd, {
    homeDir: opts.homeDir,
  })
  const out: ToolResultPathExtraction[] = [
    {
      path: queriedDir,
      originalString: dirArgRaw ?? '.',
      kind: 'parent_listing',
      toolName,
      toolSucceeded: true,
    },
  ]
  for (const rawLine of result.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (!line.includes('/') && !line.startsWith('~')) continue
    out.push({
      path: canonicalizeProvenancePath(line, opts.cwd, { homeDir: opts.homeDir }),
      originalString: line,
      kind: 'tool_confirmed_existing',
      toolName,
      toolSucceeded: true,
    })
  }
  return out
}

function extractBashTree(
  toolName: string,
  tokens: string[],
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  const dirArgRaw = pickDirArg(tokens)
  const dirArg = dirArgRaw ?? '.'
  const queriedDir = canonicalizeProvenancePath(stripTrailingSlash(dirArg), opts.cwd, {
    homeDir: opts.homeDir,
  })
  // v1: tree formatting (├──, │, └──) is hard to parse; admit dir only.
  return [
    {
      path: queriedDir,
      originalString: dirArgRaw ?? '.',
      kind: 'parent_listing',
      toolName,
      toolSucceeded: true,
    },
  ]
}

/**
 * Enumerate the path segments of `pathArg` as a chain of cumulative
 * prefixes. For `a/b/c` returns `['a', 'a/b', 'a/b/c']`. For `/abs/x/y`
 * returns `['/abs', '/abs/x', '/abs/x/y']`. Each segment is the path the
 * user typed; canonicalization happens later.
 */
function pathChainSegments(pathArg: string): string[] {
  const trimmed = stripTrailingSlash(pathArg)
  const isAbsolute = trimmed.startsWith('/')
  const parts = trimmed.split('/').filter(p => p.length > 0)
  if (parts.length === 0) return []
  const out: string[] = []
  let acc = isAbsolute ? '' : ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : (isAbsolute ? `/${p}` : p)
    out.push(acc)
  }
  return out
}

/**
 * Bash `mkdir` / `mkdir -p` dispatch. Plain mkdir admits only the explicit
 * target dirs. `mkdir -p` walks the path chain of each target so that every
 * intermediate ancestor the command would create also gets admitted as
 * `parent_listing` (spec §5.3.2).
 *
 * Multi-target mkdir emits one record per target dir; each `-p` chain is
 * expanded independently. No cross-chain dedupe — repeated `/abs` records
 * from different chains stay as distinct emissions and let the ledger
 * dedupe by `(kind, originIteration, originalString)` if appropriate.
 */
function extractBashMkdir(
  toolName: string,
  tokens: string[],
  opts: ToolResultExtractorOpts,
): ToolResultPathExtraction[] {
  // Collect flag-set + positionals. mkdir has few flags; `-p` is the one we
  // care about, but tolerate combined short flags like `-pv`.
  let hasP = false
  const positionals: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('--')) {
      if (t === '--parents') hasP = true
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      if (t.includes('p')) hasP = true
      continue
    }
    positionals.push(t)
  }
  if (positionals.length === 0) return []
  const out: ToolResultPathExtraction[] = []
  for (const target of positionals) {
    const segments = hasP ? pathChainSegments(target) : [stripTrailingSlash(target)]
    for (const seg of segments) {
      out.push({
        path: canonicalizeProvenancePath(seg, opts.cwd, { homeDir: opts.homeDir }),
        originalString: seg,
        kind: 'parent_listing',
        toolName,
        toolSucceeded: true,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Write-target extractor (S0-5)
//
// Returns the array of destinations a tool call would write to. Used by
// `evaluateWriteTargetProvenance` to ask the ledger whether each target has
// admission evidence.
//
// Per-tool dispatch:
//   Write / Edit       → input.path          (single target, kind=write|edit)
//   NotebookEdit       → input.notebook_path (single target, kind=notebook_edit)
//   Bash               → command parsed for write shapes (multi-target):
//       > / >>         → kind=redirect_stdout
//       2>             → kind=redirect_stderr
//       tee a b        → kind=tee (multi-target)
//       sed -i a b     → kind=sed_inplace (destructive)
//       cp src dst     → kind=cp (dst only; sources are reads)
//       mv src dst     → kind=mv (destructive when overwrite)
//       rm a b c       → kind=rm (destructive)
//       cat <<EOF > p  → kind=heredoc (target = redirect dest)
//       mkdir a b      → kind=mkdir
//
// Returns `[]` when the bash command is unparseable or doesn't match any
// known write shape (spec §7.2 fail-open) — gate passes the call through
// rather than producing a false-positive block on legitimate bash.
// ---------------------------------------------------------------------------

export function extractWriteTargets(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  opts: { homeDir?: string } = {},
): ExtractedWriteTarget[] {
  const normalized = toolName.toLowerCase()
  switch (normalized) {
    case 'write':
      return simpleFileTarget(input, ['path', 'file_path'], 'write', cwd, opts)
    case 'edit':
      return simpleFileTarget(input, ['path', 'file_path'], 'edit', cwd, opts)
    case 'notebookedit':
      return simpleFileTarget(input, ['notebook_path'], 'notebook_edit', cwd, opts)
    case 'bash':
      return extractBashWriteTargets(input, cwd, opts)
    case 'taskcreate':
      // TaskCreate's `command` field spawns a bash process inside a subagent.
      // The gate treats it as the same write-shape category as a top-level
      // bash call, so we reuse the bash extractor. Subject-only TaskCreate
      // (planning op, no command) extracts nothing → fail-open / passes.
      return extractBashWriteTargets(input, cwd, opts)
    default:
      return []
  }
}

export interface WriteTargetProvenanceCheck {
  targets: ExtractedWriteTarget[]
  evaluations: ProvenanceTargetEvaluation[]
  failures: ProvenanceTargetEvaluation[]
  bashUnparseable: boolean
}

/**
 * Optional input channel for settings-driven permission rules (PERM-6).
 * Caller (conversation dispatch) loads `ResolvedPermissions` once per task
 * via `loadResolvedPermissions` and passes it on every gate call. The gate
 * compiles per-target synthetic records via the rule compiler and injects
 * them into `evaluateAdmission` for this one decision.
 *
 * Decoupled via a function-callback so write-provenance.ts can stay free
 * of an import cycle with permission-rules.ts (the rule compiler depends
 * on `canonicalizeProvenancePath` from this module).
 */
export interface WriteTargetProvenanceOptions {
  homeDir?: string
  /**
   * Returns synthetic records to inject for this (toolName, canonicalPath)
   * pair. When omitted, no rule-driven evidence is consulted (back-compat
   * with pre-PERM-6 callers).
   */
  compileRules?: (
    toolName: string,
    canonicalPath: string,
  ) => { pathRecords: ProvenanceRecord[] }
}

export function evaluateWriteTargetProvenance(
  toolName: string,
  input: Record<string, unknown>,
  ledger: ProvenanceLedgerData,
  cwd: string,
  opts: WriteTargetProvenanceOptions = {},
): WriteTargetProvenanceCheck {
  const targets = extractWriteTargets(toolName, input, cwd, opts)
  const evaluations: ProvenanceTargetEvaluation[] = []
  for (const target of targets) {
    const canonical = target.path
    const isNewFile = !pathExists(canonical)
    const synthetic = opts.compileRules
      ? opts.compileRules(toolName, canonical)
      : { pathRecords: [] }
    evaluations.push({
      target,
      canonical,
      isNewFile,
      admission: evaluateAdmission(ledger, canonical, isNewFile, {
        syntheticPathRecords: synthetic.pathRecords,
      }),
    })
  }

  const command = input['command']
  const bashUnparseable =
    toolName.toLowerCase() === 'bash' &&
    targets.length === 0 &&
    typeof command === 'string' &&
    command.trim().length > 0 &&
    classifyBashCommand(command).mutatesFilesystem

  return {
    targets,
    evaluations,
    failures: evaluations.filter(e => !e.admission.admitted),
    bashUnparseable,
  }
}

function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Pull a single non-destructive write target from a tool input record.
 * Reads `input[fieldName]`; if it's a non-empty string, canonicalize and
 * emit. Used for Write/Edit/NotebookEdit which always have exactly one
 * target field.
 */
function simpleFileTarget(
  input: Record<string, unknown>,
  fieldNames: string[],
  kind: ExtractedWriteTarget['kind'],
  cwd: string,
  opts: { homeDir?: string },
): ExtractedWriteTarget[] {
  const raw = firstStringField(input, fieldNames)
  if (typeof raw !== 'string' || raw.length === 0) return []
  return [
    {
      path: canonicalizeProvenancePath(raw, cwd, opts),
      kind,
      destructive: false,
    },
  ]
}

function firstStringField(input: Record<string, unknown>, fieldNames: string[]): string | undefined {
  for (const fieldName of fieldNames) {
    const raw = input[fieldName]
    if (typeof raw === 'string') return raw
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Bash write-target extraction
// ---------------------------------------------------------------------------

/**
 * Parse a bash command string for redirect operators. Walks the command
 * character-by-character so we can ignore `>` inside quoted strings and
 * support no-space forms like `>file`.
 *
 * Recognizes:
 *   `>`, `1>`        → stdout redirect (overwrite)
 *   `>>`, `1>>`      → stdout redirect (append)
 *   `2>`, `2>>`      → stderr redirect
 *   `&>`, `&>>`      → both stdout + stderr (emitted as two targets)
 *
 * Returns one entry per redirect-target pair; multiple redirects in one
 * command (`cmd > a 2> b`) produce multiple entries.
 */
interface BashRedirectHit {
  /** `redirect_stdout` or `redirect_stderr` */
  kind: 'redirect_stdout' | 'redirect_stderr'
  /** verbatim target token as captured from the command string */
  target: string
  /** Whether the redirect truncates/replaces its target instead of appending. */
  destructive: boolean
}

function findBashRedirects(command: string): BashRedirectHit[] {
  const out: BashRedirectHit[] = []
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < command.length) {
    const c = command[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
        i++
        continue
      }
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      i++
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      i += 2
      continue
    }
    // Try redirect operators in priority order (longer first so `>>` beats `>`).
    const opMatch = matchRedirectOp(command, i)
    if (opMatch) {
      const targetStart = skipSpaces(command, i + opMatch.opLen)
      const targetEnd = readBashWord(command, targetStart)
      if (targetEnd > targetStart) {
        const targetToken = command.slice(targetStart, targetEnd)
        const unquoted = stripQuotes(targetToken)
        if (opMatch.combined) {
          out.push({ kind: 'redirect_stdout', target: unquoted, destructive: opMatch.destructive })
          out.push({ kind: 'redirect_stderr', target: unquoted, destructive: opMatch.destructive })
        } else {
          out.push({ kind: opMatch.kind, target: unquoted, destructive: opMatch.destructive })
        }
        i = targetEnd
        continue
      }
    }
    i++
  }
  return out
}

/**
 * Match a bash redirect operator at position `i`. Returns op metadata or
 * null. Recognized operators (longest first to disambiguate `>>` vs `>`):
 *   `&>>` `&>` → combined stdout+stderr (will emit two targets)
 *   `2>>` `2>` → stderr
 *   `1>>` `1>` → stdout (explicit fd)
 *   `>>`  `>`  → stdout (implicit fd)
 *
 * Does NOT match `<` (input redirect — that's a read, not a write).
 */
function matchRedirectOp(command: string, i: number):
  | { opLen: number; kind: 'redirect_stdout' | 'redirect_stderr'; combined: boolean; destructive: boolean }
  | null {
  const c = command[i]
  // Combined &> / &>>
  if (c === '&' && command[i + 1] === '>') {
    const opLen = command[i + 2] === '>' ? 3 : 2
    return { opLen, kind: 'redirect_stdout', combined: true, destructive: opLen === 2 }
  }
  // Stderr 2> / 2>>
  if (c === '2' && command[i + 1] === '>') {
    const append = command[i + 2] === '>'
    const force = command[i + 2] === '|'
    const opLen = append || force ? 3 : 2
    return { opLen, kind: 'redirect_stderr', combined: false, destructive: !append }
  }
  // Explicit stdout 1> / 1>>
  if (c === '1' && command[i + 1] === '>') {
    const append = command[i + 2] === '>'
    const force = command[i + 2] === '|'
    const opLen = append || force ? 3 : 2
    return { opLen, kind: 'redirect_stdout', combined: false, destructive: !append }
  }
  // Implicit stdout > / >>
  if (c === '>') {
    const append = command[i + 1] === '>'
    const force = command[i + 1] === '|'
    const opLen = append || force ? 2 : 1
    return { opLen, kind: 'redirect_stdout', combined: false, destructive: !append }
  }
  return null
}

/**
 * Skip ASCII whitespace at `command[i..]`; return the index of the first
 * non-whitespace char (or `command.length`).
 */
function skipSpaces(command: string, i: number): number {
  while (i < command.length && /\s/.test(command[i])) i++
  return i
}

/**
 * Read a single bash "word" starting at `i` — runs until next unquoted
 * whitespace or shell terminator (`;`, `|`, `&`, `<`, `>`). Handles
 * `"..."` and `'...'` quoted spans by consuming them entirely. Returns
 * the index immediately after the word (`i` if no word at that position).
 */
function readBashWord(command: string, i: number): number {
  let j = i
  let quote: '"' | "'" | null = null
  while (j < command.length) {
    const c = command[j]
    if (quote) {
      if (c === '\\' && quote === '"' && j + 1 < command.length) {
        j += 2
        continue
      }
      if (c === quote) {
        quote = null
        j++
        continue
      }
      j++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      j++
      continue
    }
    if (c === '\\' && j + 1 < command.length) {
      j += 2
      continue
    }
    // Word terminators outside quotes.
    if (/\s/.test(c) || c === ';' || c === '|' || c === '&' || c === '<' || c === '>') {
      break
    }
    j++
  }
  return j
}

/**
 * Strip a single layer of surrounding `"..."` or `'...'` quotes if present.
 * Used after `readBashWord` to get the literal path token.
 */
function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0]
    const last = token[token.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1)
    }
  }
  return token
}

/**
 * Split a bash command on unquoted command-separator operators, returning
 * each segment as a string. Splits on: `|` (pipeline), `||` (logical OR),
 * `&&` (logical AND), `;` (sequence). Respects quoted strings and
 * backslash escapes. Newlines are NOT separators — bash treats them as
 * such only outside compound commands, but for v1 we keep them inside
 * the current segment (heredoc bodies live in the same segment as the
 * heredoc opener).
 *
 * Used by per-command dispatchers (`tee`, `sed`, `cp`, etc.) to find
 * each pipeline/chain segment's head independently.
 */
function splitBashCommands(command: string): string[] {
  const segments: string[] = []
  let cur = ''
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < command.length) {
    const c = command[i]
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        cur += command[i + 1]
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      cur += c
      quote = c
      i++
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[i + 1]
      i += 2
      continue
    }
    // Two-char operators first: && / ||
    if (c === '&' && command[i + 1] === '&') {
      segments.push(cur)
      cur = ''
      i += 2
      continue
    }
    if (c === '|' && command[i + 1] === '|') {
      segments.push(cur)
      cur = ''
      i += 2
      continue
    }
    // Single-char operators: | / ;
    if ((c === '|' && command[i - 1] !== '>') || c === ';') {
      segments.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  if (cur) segments.push(cur)
  return segments
}

/**
 * Detect whether a bash command segment contains an unquoted heredoc
 * opener (`<<WORD` or `<<-WORD`). Used to reclassify subsequent stdout
 * redirects in the same segment as kind=heredoc.
 *
 * Heredoc bodies are removed before command dispatch so their literal shell
 * text cannot be mistaken for executable redirects or tool invocations.
 */
function segmentHasHeredoc(seg: string): boolean {
  let i = 0
  let quote: '"' | "'" | null = null
  while (i < seg.length - 1) {
    const c = seg[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < seg.length) {
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      i++
      continue
    }
    if (c === '\\' && i + 1 < seg.length) {
      i += 2
      continue
    }
    if (c === '<' && seg[i + 1] === '<') return true
    i++
  }
  return false
}

/** Remove heredoc bodies before scanning redirects so body text cannot invent targets. */
function stripHeredocBodies(seg: string): string {
  const lines = seg.split('\n')
  const kept: string[] = []
  const pending: Array<{ delimiter: string; stripTabs: boolean }> = []
  for (const line of lines) {
    if (pending.length > 0) {
      const current = pending[0]
      const candidate = current.stripTabs ? line.replace(/^\t+/, '') : line
      if (candidate.trimEnd() === current.delimiter) pending.shift()
      continue
    }
    kept.push(line)
    const heredocPattern = /<<(-)?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/g
    let match: RegExpExecArray | null
    while ((match = heredocPattern.exec(line)) !== null) {
      pending.push({ delimiter: match[3], stripTabs: match[1] === '-' })
    }
  }
  return kept.join('\n')
}

/**
 * Tokenize then strip a leading set of word-tokens that match `head`.
 * Used by per-command dispatchers to confirm a pipeline segment starts
 * with a specific command (eg. `tee`, `sed`). Returns the remaining
 * tokens (excluding the head), or `null` if the segment doesn't start
 * with `head`.
 */
function tokensAfterHead(segment: string, head: string): string[] | null {
  const tokens = tokenizeBashCommand(segment.trim())
  if (tokens.length === 0) return null
  if (tokens[0] !== head) return null
  return tokens.slice(1)
}

/**
 * Returns true when `tok` is a pure shell operator that the tokenizer
 * surfaced as its own token (eg. `>`, `>>`, `2>`, `<`). Used by per-command
 * positional walkers to stop scanning at redirect / chaining boundaries —
 * the redirect handler picks those up separately.
 */
function isShellOperatorToken(tok: string): boolean {
  return (
    tok === '>' ||
    tok === '>>' ||
    tok === '2>' ||
    tok === '2>>' ||
    tok === '1>' ||
    tok === '1>>' ||
    tok === '&>' ||
    tok === '&>>' ||
    tok === '<' ||
    tok === ';' ||
    tok === '&' ||
    tok === '&&' ||
    tok === '||'
  )
}

/**
 * `tee` extractor. Recognizes `tee [-a] file1 [file2 ...]`. Each positional
 * file becomes a separate target. The `-a` (append) flag is non-destructive
 * but still emitted as kind=tee.
 *
 * Stops at redirect / chaining operators so `tee a > b` extracts only `a`
 * as a tee target; the redirect handler separately picks up `b`.
 *
 * Returns the verbatim file tokens (caller canonicalizes).
 */
function findBashTeeTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of splitBashCommands(command)) {
    const args = tokensAfterHead(seg, 'tee')
    if (!args) continue
    for (let i = 0; i < args.length; i++) {
      const t = args[i]
      if (t.startsWith('-')) continue
      if (t.length === 0) continue
      // Operator token (redirect, chaining) marks end of tee positionals.
      if (isShellOperatorToken(t)) {
        // Skip the operator AND its target (handled by redirect scanner).
        i++
        continue
      }
      out.push(t)
    }
  }
  return out
}

/**
 * `sed -i` extractor. Returns the file paths sed will modify in-place.
 *
 * Detection:
 *   - Pipeline segment whose head is `sed`.
 *   - Contains `-i` or `-i<suffix>` (eg. `-i.bak`) as a flag token.
 *   - When `-e <script>` / `-f <file>` flags supply scripts via flag, all
 *     positionals are files. Otherwise the first positional is the inline
 *     script and remaining positionals are files (GNU sed convention).
 *
 * Sed without `-i` writes to stdout — no in-place target, returns [].
 *
 * BSD compatibility note: `sed -i '' 's/...' file` is supported because the
 * empty `''` between `-i` and the script gets swallowed by the tokenizer
 * (it's an empty quoted string), so token order becomes
 * `['sed', '-i', 's/...', 'file']` which the GNU-style parser handles
 * correctly. Explicit `-i.bak` form is also detected.
 */
function findBashSedInplaceTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of splitBashCommands(command)) {
    const args = tokensAfterHead(seg, 'sed')
    if (!args) continue

    let hasInplace = false
    let hasFlagScript = false
    const positionals: string[] = []
    let i = 0
    while (i < args.length) {
      const t = args[i]
      if (t === '-e' || t === '--expression' || t === '-f' || t === '--file') {
        hasFlagScript = true
        i += 2
        continue
      }
      if (t === '-i') {
        hasInplace = true
        // BSD form `-i <suffix>` where suffix may be empty or `.bak`-shaped.
        // Tokenizer drops empty `''`, so the only case to detect here is
        // when the next token starts with `.` and looks like a suffix.
        const next = args[i + 1]
        if (typeof next === 'string' && next.startsWith('.') && !next.includes('/')) {
          i += 2
          continue
        }
        i++
        continue
      }
      if (t.startsWith('-i')) {
        // `-iSUFFIX` form (eg. `-i.bak`).
        hasInplace = true
        i++
        continue
      }
      if (t.startsWith('-')) {
        i++
        continue
      }
      positionals.push(t)
      i++
    }
    if (!hasInplace) continue
    const files = hasFlagScript ? positionals : positionals.slice(1)
    for (const f of files) {
      out.push(f)
    }
  }
  return out
}

/**
 * Walk `args` (tokens after the command head) accumulating non-flag
 * positionals. Stops at shell operator tokens (redirects / chaining) so
 * downstream operators don't contaminate the positional set. Recognizes
 * a small allowlist of flags that consume their next token (eg. `-t dir`
 * for cp/mv).
 */
function collectPositionals(
  args: string[],
  flagsThatEatNext: Set<string> = new Set(),
): { positionals: string[]; flagDirValue: string | null } {
  const positionals: string[] = []
  let flagDirValue: string | null = null
  let i = 0
  while (i < args.length) {
    const t = args[i]
    if (isShellOperatorToken(t)) {
      // Skip operator and its target (redirect handler picks those up).
      i += 2
      continue
    }
    if (flagsThatEatNext.has(t) && i + 1 < args.length) {
      flagDirValue = args[i + 1]
      i += 2
      continue
    }
    // Long-flag form: --target-directory=DIR
    if (t.startsWith('--target-directory=')) {
      flagDirValue = t.slice('--target-directory='.length)
      i++
      continue
    }
    if (t.startsWith('-')) {
      i++
      continue
    }
    if (t.length === 0) {
      i++
      continue
    }
    positionals.push(t)
    i++
  }
  return { positionals, flagDirValue }
}

/**
 * Strip a single trailing `/` from a path token (eg. `/tmp/dst/` →
 * `/tmp/dst`) so canonical comparison matches what the ledger admitted.
 * Mirrors `stripTrailingSlash` used by ls dispatcher.
 */
function normalizeBashPathArg(p: string): string {
  return stripTrailingSlash(p)
}

/**
 * `cp` extractor. Returns the destination path(s):
 *   - `cp src dst`               → [dst]
 *   - `cp src1 src2 dst/`        → [dst]   (last positional is dest dir)
 *   - `cp -t DIR src1 src2`      → [DIR]   (explicit target dir flag)
 *   - `cp src` (1 positional)    → []      (invalid, fail-open)
 *
 * Skips shell operator tokens and `-r` / `-a` / `-v` style flags.
 */
function findBashCpTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of splitBashCommands(command)) {
    const args = tokensAfterHead(seg, 'cp')
    if (!args) continue
    const eatNext = new Set(['-t', '--target-directory'])
    const { positionals, flagDirValue } = collectPositionals(args, eatNext)
    if (flagDirValue) {
      out.push(normalizeBashPathArg(flagDirValue))
      continue
    }
    if (positionals.length < 2) continue   // cp needs ≥ src + dst
    out.push(normalizeBashPathArg(positionals[positionals.length - 1]))
  }
  return out
}

/**
 * `mv` extractor. Returns the destination path(s) — same shape as cp.
 * Always destructive (mv overwrites the destination silently).
 */
function findBashMvTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of splitBashCommands(command)) {
    const args = tokensAfterHead(seg, 'mv')
    if (!args) continue
    const eatNext = new Set(['-t', '--target-directory'])
    const { positionals, flagDirValue } = collectPositionals(args, eatNext)
    if (flagDirValue) {
      out.push(normalizeBashPathArg(flagDirValue))
      continue
    }
    if (positionals.length < 2) continue
    out.push(normalizeBashPathArg(positionals[positionals.length - 1]))
  }
  return out
}

/**
 * `rm` extractor. ALL non-flag positionals are deletion targets; each
 * becomes a separate destructive record.
 */
function findBashRmTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of splitBashCommands(command)) {
    const args = tokensAfterHead(seg, 'rm')
    if (!args) continue
    const { positionals } = collectPositionals(args)
    for (const p of positionals) {
      out.push(normalizeBashPathArg(p))
    }
  }
  return out
}

/**
 * `mkdir` write-target extractor. Recognizes:
 *   - `mkdir <dir>` → [<dir>]
 *   - `mkdir a b c` → [a, b, c]
 *   - `mkdir -p a/b/c` → [a, a/b, a/b/c]  (each segment as separate target)
 *
 * Reuses `pathChainSegments` from the S0-4 tool-result mkdir helper so the
 * `-p` chain semantics match between write-target and parent_listing
 * admissions.
 */
function findBashMkdirTargets(command: string): string[] {
  const out: string[] = []
  for (const seg of splitBashCommands(command)) {
    const args = tokensAfterHead(seg, 'mkdir')
    if (!args) continue
    let hasP = false
    const positionals: string[] = []
    for (const t of args) {
      if (t === '--parents') {
        hasP = true
        continue
      }
      if (t.startsWith('--')) continue
      if (t.startsWith('-') && t.length > 1) {
        if (t.includes('p')) hasP = true
        continue
      }
      if (isShellOperatorToken(t)) continue
      if (t.length === 0) continue
      positionals.push(t)
    }
    for (const target of positionals) {
      const chain = hasP ? pathChainSegments(target) : [stripTrailingSlash(target)]
      for (const c of chain) {
        if (c.length > 0) out.push(c)
      }
    }
  }
  return out
}

/**
 * Top-level Bash dispatch for write-target extraction. Recognized shapes:
 *   - Redirect operators (`>`, `>>`, `2>`, `&>`, `1>`) → kind=redirect_* or
 *     kind=heredoc when the same chain segment opens a heredoc with `<<`
 *   - `tee [-a] file1 file2`                         → kind=tee
 *   - `sed -i[.bak] 's/...' file1 file2`             → kind=sed_inplace (destructive)
 *   - `cp src dst` / `cp -t DIR src..`                → kind=cp
 *   - `mv src dst` / `mv -t DIR src..`                → kind=mv (destructive)
 *   - `rm a b c` / `rm -rf dir`                       → kind=rm (destructive)
 *   - `mkdir [-p] a b c`                              → kind=mkdir
 *
 * Per spec §7.2 fail-open: if no recognized write shape is found, returns
 * `[]` so the gate passes the call through rather than over-block.
 */
function extractBashWriteTargets(
  input: Record<string, unknown>,
  cwd: string,
  opts: { homeDir?: string },
): ExtractedWriteTarget[] {
  const command = input['command']
  if (typeof command !== 'string' || command.length === 0) return []
  const commandForExtraction = stripHeredocBodies(command)
  const out: ExtractedWriteTarget[] = []
  // Redirects are scanned per-segment so heredoc reclassification stays
  // segment-local (a heredoc in segment 1 does not affect redirects in
  // segment 2 of `cmdA; cmdB`).
  for (const seg of splitBashCommands(commandForExtraction)) {
    const hasHeredoc = segmentHasHeredoc(seg)
    for (const hit of findBashRedirects(seg)) {
      const kind = hasHeredoc && hit.kind === 'redirect_stdout' ? 'heredoc' : hit.kind
      out.push({
        path: canonicalizeProvenancePath(hit.target, cwd, opts),
        kind,
        destructive: hit.destructive,
      })
    }
  }
  for (const target of findBashTeeTargets(commandForExtraction)) {
    out.push({
      path: canonicalizeProvenancePath(target, cwd, opts),
      kind: 'tee',
      destructive: false,
    })
  }
  for (const target of findBashSedInplaceTargets(commandForExtraction)) {
    out.push({
      path: canonicalizeProvenancePath(target, cwd, opts),
      kind: 'sed_inplace',
      destructive: true,
    })
  }
  for (const target of findBashCpTargets(commandForExtraction)) {
    out.push({
      path: canonicalizeProvenancePath(target, cwd, opts),
      kind: 'cp',
      destructive: false,
    })
  }
  for (const target of findBashMvTargets(commandForExtraction)) {
    out.push({
      path: canonicalizeProvenancePath(target, cwd, opts),
      kind: 'mv',
      destructive: true,
    })
  }
  for (const target of findBashRmTargets(commandForExtraction)) {
    out.push({
      path: canonicalizeProvenancePath(target, cwd, opts),
      kind: 'rm',
      destructive: true,
    })
  }
  for (const target of findBashMkdirTargets(commandForExtraction)) {
    out.push({
      path: canonicalizeProvenancePath(target, cwd, opts),
      kind: 'mkdir',
      destructive: false,
    })
  }
  return out
}
