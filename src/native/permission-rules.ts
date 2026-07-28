/**
 * Permission-rule parsing for the settings.json `permissions` block.
 *
 * The schema is CC-compatible:
 *
 *   {
 *     "permissions": {
 *       "allow": ["Edit(src/**)"],
 *       "deny":  ["*(~/.ssh/**)", "Read(./.env)"],
 *       "ask":   []
 *     }
 *   }
 *
 * Each entry is a `Tool(pattern)` or `*(pattern)` string. OwlCoda adds the
 * `*(pattern)` sugar which CC does not have; everything else matches CC
 * verbatim.
 *
 * `Bash(...)` rules PARSE but are NOT ENFORCED in v1 — they emit a load-time
 * warning so users who paste a CC `settings.json` know what's been skipped.
 * `ask:` rules are stored as deny + warning (no interactive approval path
 * in v1). Bare strings (no `Tool(...)` wrapper) are rejected at parse time
 * so the grammar stays unambiguous.
 *
 * See spec §17 for the full enforcement matrix.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { canonicalizeProvenancePath } from './write-provenance.js'
import type { ProvenanceRecord } from './protocol/write-provenance-types.js'
import type {
  PermissionEffect,
  PermissionRule,
  PermissionRuleSource,
  PermissionTool,
  PermissionWarning,
  ResolvedPermissions,
} from './protocol/permission-rule-types.js'

/**
 * Canonical-cased tool names accepted by the parser. Comparison is
 * case-insensitive but emitted in canonical case so downstream code can
 * switch on a single form.
 */
const KNOWN_TOOLS: PermissionTool[] = [
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'Glob',
  'Grep',
  'TaskCreate',
  'Bash',
  '*',
]

/**
 * Build a case-insensitive lookup map from tool-name to canonical form.
 * `*` stays `*`. The lowercase form for case-insensitive matching is the
 * key; the canonical-cased form is the value.
 */
const TOOL_LOOKUP: Map<string, PermissionTool> = (() => {
  const map = new Map<string, PermissionTool>()
  for (const t of KNOWN_TOOLS) {
    map.set(t.toLowerCase(), t)
  }
  return map
})()

/**
 * Result of parsing a single rule string. `rule` is present when parsing
 * produced a usable record (even with caveats — eg. Bash rules return a
 * rule with `enforced=false`). `warnings` lists every concern that
 * downstream telemetry should surface. An entirely unparseable input
 * returns `rule: undefined` plus at least one warning.
 */
export interface ParsePermissionRuleResult {
  rule?: PermissionRule
  warnings: PermissionWarning[]
}

/**
 * Parse one entry from a `permissions.{allow,deny,ask}` array.
 *
 * Grammar:
 *   ToolName ::= [A-Za-z][A-Za-z]* | "*"
 *   Pattern  ::= any chars (trimmed of surrounding whitespace)
 *   Rule     ::= ToolName "(" Pattern ")"
 *
 * `effect` is the section the rule was found under. `ask` collapses to
 * `deny` here so downstream code can treat all enforced effects as one of
 * the two `PermissionEffect` values; the collapse is logged.
 */
export function parsePermissionRule(
  raw: string,
  effect: 'allow' | 'deny' | 'ask',
): ParsePermissionRuleResult {
  const warnings: PermissionWarning[] = []

  // Structural shape check: `<head>(<body>)` with non-empty head.
  const trimmedRaw = raw.trim()
  if (trimmedRaw.length === 0) {
    return {
      warnings: [{
        raw,
        reason: 'malformed',
        message: 'Empty permission rule string',
      }],
    }
  }

  // Must contain `(` to be considered a Tool(pattern) form.
  const openIdx = trimmedRaw.indexOf('(')
  if (openIdx < 0) {
    return {
      warnings: [{
        raw,
        reason: 'bare_string',
        message:
          `Bare string "${raw}" is not a valid permission rule. ` +
          `Wrap it in Tool(pattern) or *(pattern), eg. *(~/.ssh/**).`,
      }],
    }
  }

  if (!trimmedRaw.endsWith(')')) {
    return {
      warnings: [{
        raw,
        reason: 'malformed',
        message: `Permission rule "${raw}" is missing the closing paren`,
      }],
    }
  }

  const headRaw = trimmedRaw.slice(0, openIdx).trim()
  const patternRaw = trimmedRaw.slice(openIdx + 1, -1).trim()

  if (headRaw.length === 0) {
    return {
      warnings: [{
        raw,
        reason: 'malformed',
        message: `Permission rule "${raw}" is missing the tool name before "("`,
      }],
    }
  }

  // Tool-name normalization. `*` is preserved as-is; everything else is
  // matched case-insensitively against the whitelist.
  const tool = TOOL_LOOKUP.get(headRaw.toLowerCase())
  if (!tool) {
    return {
      warnings: [{
        raw,
        reason: 'unknown_tool',
        message:
          `Unknown tool name "${headRaw}" in rule "${raw}". ` +
          `Expected one of: ${KNOWN_TOOLS.join(', ')}.`,
      }],
    }
  }

  if (patternRaw.length === 0) {
    return {
      warnings: [{
        raw,
        reason: 'empty_pattern',
        message: `Permission rule "${raw}" has an empty pattern`,
      }],
    }
  }

  // The rule passed structural validation. Now figure out enforcement +
  // caveat warnings.

  // Bash(...) rules parse but don't fire in v1.
  const enforced = tool !== 'Bash'
  if (!enforced) {
    warnings.push({
      raw,
      reason: 'bash_not_enforced',
      message:
        `Bash(...) permission rules are not enforced in v1. ` +
        `"${raw}" was parsed but will not block anything. ` +
        `Use *(path-glob) for path-based protections — eg. *(~/.ssh/**).`,
    })
  }

  // ask: rules collapse to deny + warning.
  let resolvedEffect: PermissionEffect
  if (effect === 'ask') {
    resolvedEffect = 'deny'
    warnings.push({
      raw,
      reason: 'ask_treated_as_deny',
      message:
        `"ask" permission rules are treated as "deny" in v1 ` +
        `(no interactive approval path). "${raw}" will block by default.`,
    })
  } else {
    resolvedEffect = effect
  }

  return {
    rule: {
      raw,
      tool,
      pattern: patternRaw,
      effect: resolvedEffect,
      enforced,
    },
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Path matcher (PERM-2)
//
// Translates a user-written rule pattern (`~/.ssh/**`, `./.env*`, `src/**`,
// `package-lock.json`) into a regex that can be tested against canonical
// absolute paths produced by `canonicalizeProvenancePath`.
//
// Steps:
//   1. Expand `~/` → homeDir; resolve relative patterns against projectRoot.
//   2. Canonicalize the wildcard-free prefix (handles macOS /tmp symlink).
//   3. Compile gitignore-style glob → RegExp.
//
// Gitignore-flavored semantics in v1:
//   *   → any chars EXCEPT path separator
//   **  → any chars (cross-segment); trailing `/**` is permissive ("dir AND
//         everything under it"); middle `/**/` collapses zero+ segments
//   ?   → exactly one char, not slash
//   .+^$|()[]\{} → escaped to literal
// ---------------------------------------------------------------------------

const WILDCARD_RE = /[*?[{]/

/**
 * Normalize a user-written pattern to an absolute canonical pattern. Splits
 * on the first wildcard char so the literal prefix can be realpath'd
 * (canonicalizeProvenancePath handles symlinks via realpathExistingParent).
 * The wildcard tail is preserved unchanged.
 *
 * Empty pattern returns the empty string (matchRulePattern guards against
 * this).
 */
function normalizeRulePattern(
  pattern: string,
  projectRoot: string,
  homeDir: string,
): string {
  if (pattern.length === 0) return ''

  // Step 1: home expansion + relative resolution.
  let absPattern: string
  if (pattern === '~') {
    absPattern = homeDir
  } else if (pattern.startsWith('~/')) {
    absPattern = join(homeDir, pattern.slice(2))
  } else if (isAbsolute(pattern)) {
    absPattern = pattern
  } else {
    absPattern = resolve(projectRoot, pattern)
  }

  // Step 2: canonicalize the wildcard-free prefix.
  const wildcardMatch = WILDCARD_RE.exec(absPattern)
  if (!wildcardMatch) {
    return canonicalizeProvenancePath(absPattern, projectRoot, { homeDir })
  }
  const wildIdx = wildcardMatch.index
  const lastSlashBeforeWild = absPattern.lastIndexOf('/', wildIdx)
  if (lastSlashBeforeWild < 0) {
    // Pattern starts with a wildcard at offset 0 — no prefix to canonicalize.
    return absPattern
  }
  const prefix = absPattern.slice(0, lastSlashBeforeWild)
  const tail = absPattern.slice(lastSlashBeforeWild)
  if (prefix.length === 0) {
    return absPattern
  }
  const canonicalPrefix = canonicalizeProvenancePath(prefix, projectRoot, { homeDir })
  return canonicalPrefix + tail
}

/**
 * Compile a normalized (already-absolute) glob pattern to a RegExp that
 * matches canonical absolute paths.
 *
 * Special-case trailing globstar at the END of a pattern so it matches
 * both the prefix dir itself AND everything under it (`/etc` + globstar
 * should cover `/etc` plus `/etc/passwd`). Middle globstar (slash + two
 * stars + slash) collapses zero+ segments — eg. `a/<gs>/b` covers
 * `a/b` and `a/x/b` and `a/x/y/b`.
 */
function compileNormalizedPatternToRegex(pattern: string): RegExp {
  let re = ''
  let i = 0
  const n = pattern.length
  while (i < n) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      const before = i > 0 ? pattern[i - 1] : ''
      const after = pattern[i + 2]
      if (before === '/' && after === '/') {
        // Middle "/**/" — collapse to "(?:.*/)?" and consume `**/`.
        re += '(?:.*/)?'
        i += 3
        continue
      }
      if (before === '/' && after === undefined) {
        // Trailing "/**" — match prefix dir alone OR with "/anything" tail.
        // Replace the already-emitted trailing slash with optional group.
        re = re.slice(0, -1)
        re += '(?:/.*)?'
        i += 2
        continue
      }
      // Anywhere else: `**` matches any chars including slash.
      re += '.*'
      i += 2
      continue
    }
    if (c === '*') {
      re += '[^/]*'
      i += 1
      continue
    }
    if (c === '?') {
      re += '[^/]'
      i += 1
      continue
    }
    if ('.+^$|()[]\\{}'.includes(c)) {
      re += '\\' + c
      i += 1
      continue
    }
    re += c
    i += 1
  }
  return new RegExp('^' + re + '$')
}

/**
 * Test whether a canonical absolute path matches a user-written rule
 * pattern. Empty pattern or empty path returns false.
 *
 * `projectRoot` resolves relative patterns; `homeDir` expands `~/`. Both
 * should be canonical (callers pass `taskState.contract.cwd` etc).
 */
export function matchRulePattern(
  pattern: string,
  canonicalPath: string,
  projectRoot: string,
  homeDir: string,
): boolean {
  if (pattern.length === 0 || canonicalPath.length === 0) return false
  const normalized = normalizeRulePattern(pattern, projectRoot, homeDir)
  if (normalized.length === 0) return false
  const re = compileNormalizedPatternToRegex(normalized)
  return re.test(canonicalPath)
}

// ---------------------------------------------------------------------------
// Settings loader (PERM-3)
//
// Reads up to three settings.json files in CC's precedence order and merges
// their `permissions.{allow,deny,ask}` arrays into a single ResolvedPermissions.
// All warnings collected at any layer are returned together so a wired
// caller can emit them as telemetry on conversation start.
//
//   1. `<owlcodaHome>/settings.json`            — user-level
//   2. `<projectRoot>/.owlcoda/settings.json`    — project shared (gitcheckin)
//   3. `<projectRoot>/.owlcoda/settings.local.json` — project local (gitignored)
//
// Missing files are silently skipped. Invalid JSON in any layer yields a
// warning tagged with that layer's source but does NOT prevent the other
// layers from loading.
// ---------------------------------------------------------------------------

export interface LoadPermissionsOptions {
  /** Project root for relative-pattern resolution. Required. */
  projectRoot: string
  /** Home directory for `~/` expansion. Defaults to `os.homedir()`. */
  homeDir?: string
  /** OwlCoda home for user-level settings. Defaults to `$OWLCODA_HOME` or `~/.owlcoda`. */
  owlcodaHome?: string
}

/** Per-section iteration helper — keeps the loader code DRY. */
const SECTIONS: Array<'allow' | 'deny' | 'ask'> = ['allow', 'deny', 'ask']

/**
 * Load and merge permission rules from the three settings.json files.
 *
 * The returned `allow` / `deny` / `ask` arrays carry rules in
 * (user → project → local) order. `warnings` includes every parse warning
 * AND every layer-load error encountered. `ask` rules collapse to `deny`
 * inside this function (carrying their warning) — so consumers can iterate
 * `result.deny` alone to find all denies.
 */
export function loadResolvedPermissions(opts: LoadPermissionsOptions): ResolvedPermissions {
  const homeDir = opts.homeDir ?? homedir()
  const owlcodaHome = opts.owlcodaHome ?? process.env['OWLCODA_HOME'] ?? join(homeDir, '.owlcoda')

  const layers: Array<{ path: string; source: PermissionRuleSource }> = [
    { path: join(owlcodaHome, 'settings.json'), source: 'user' },
    { path: join(opts.projectRoot, '.owlcoda', 'settings.json'), source: 'project' },
    { path: join(opts.projectRoot, '.owlcoda', 'settings.local.json'), source: 'local' },
  ]

  const allow: PermissionRule[] = []
  const deny: PermissionRule[] = []
  const ask: PermissionRule[] = []   // v1: stays empty (rules collapse to deny)
  const warnings: PermissionWarning[] = []

  for (const layer of layers) {
    const parsed = readLayer(layer.path, layer.source)
    if (parsed.warnings.length > 0) warnings.push(...parsed.warnings)
    if (!parsed.permissions) continue

    for (const section of SECTIONS) {
      const entries = parsed.permissions[section]
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (typeof entry !== 'string') {
          warnings.push({
            raw: String(entry),
            reason: 'malformed',
            message: `Permission rule entry must be a string, got ${typeof entry} in ${layer.source} settings`,
            source: layer.source,
          })
          continue
        }
        const result = parsePermissionRule(entry, section)
        for (const w of result.warnings) {
          warnings.push({ ...w, source: layer.source })
        }
        if (!result.rule) continue
        const taggedRule: PermissionRule = { ...result.rule, source: layer.source }
        // resolvedEffect after parsePermissionRule is 'allow' | 'deny'
        // (ask → deny). Distribute into the correct array.
        if (taggedRule.effect === 'deny') {
          deny.push(taggedRule)
        } else {
          allow.push(taggedRule)
        }
      }
    }
  }

  return { allow, deny, ask, warnings }
}

interface ParsedSettingsLayer {
  permissions?: {
    allow?: unknown
    deny?: unknown
    ask?: unknown
  }
  warnings: PermissionWarning[]
}

/**
 * Read a single settings.json layer. Returns the parsed `permissions` block
 * (if any) plus layer-level warnings (file read errors, JSON parse errors).
 * Missing files are silently skipped (no warning, no permissions).
 */
function readLayer(path: string, source: PermissionRuleSource): ParsedSettingsLayer {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    // ENOENT is the common case — file simply not present. No warning.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { warnings: [] }
    }
    return {
      warnings: [{
        raw: path,
        reason: 'malformed',
        message: `Failed to read settings file at ${path}: ${(err as Error).message}`,
        source,
      }],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return {
      warnings: [{
        raw: path,
        reason: 'malformed',
        message: `Failed to parse JSON in ${path}: ${(err as Error).message}`,
        source,
      }],
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      warnings: [{
        raw: path,
        reason: 'malformed',
        message: `Settings file ${path} must be a JSON object`,
        source,
      }],
    }
  }

  const obj = parsed as Record<string, unknown>
  const permissions = obj['permissions']
  if (permissions === undefined) return { warnings: [] }
  if (typeof permissions !== 'object' || permissions === null) {
    return {
      warnings: [{
        raw: path,
        reason: 'malformed',
        message: `Settings file ${path}: "permissions" must be an object`,
        source,
      }],
    }
  }

  return {
    permissions: permissions as ParsedSettingsLayer['permissions'],
    warnings: [],
  }
}

// ---------------------------------------------------------------------------
// Rule compiler (PERM-4)
//
// For a given write-target (toolName + canonical path), compile any
// applicable rules from `ResolvedPermissions` into synthetic ProvenanceRecord
// instances. These are injected into the admission decision via
// `evaluateAdmission`'s synthetic-record path so the existing Step 1 / Step 2
// logic handles them uniformly.
//
//   deny rule match  → synthetic user_explicit_deny with permanent=true.
//                      Step 1 short-circuits revoke (PERM-5 detail).
//   user/host-owned allow rule match
//                    → synthetic user_declared_target with permanent=true.
//                      Step 2 admits via declared_target.
//   project/local allow rule match
//                    → no authority record. Repository-controlled settings
//                      may narrow authority, but cannot impersonate the user.
//
// Non-enforced rules (Bash in v1) are skipped here — they were already
// warned about at load time.
//
// Rules are only checked at the path level. Subtree semantics live in the
// pattern itself (eg. `*(~/.ssh/**)` matches both `~/.ssh` and descendants
// via the matcher's trailing-globstar special-case).
// ---------------------------------------------------------------------------

export interface CompileRulesResult {
  pathRecords: ProvenanceRecord[]
}

export interface CompileRulesOptions {
  /** Synthetic record timestamp. Defaults to -Infinity (oldest possible). */
  ts?: number
}

/**
 * Return true when a rule's tool head applies to the given tool call.
 * `*` matches any; otherwise case-insensitive name match.
 */
function ruleToolMatches(ruleTool: PermissionTool, actualTool: string): boolean {
  if (ruleTool === '*') return true
  return ruleTool.toLowerCase() === actualTool.toLowerCase()
}

/**
 * Format a rule's origin for inclusion in `originalString` — used by the
 * formatter (`formatProvenanceError`) so model sees which settings file
 * the deny came from.
 */
function describeRuleSource(rule: PermissionRule): string {
  const source = rule.source ?? 'inline'
  return `settings.json (${source}): ${rule.raw}`
}

/**
 * Compile rules into synthetic provenance records for the given target.
 *
 * Caller passes the canonical write-target path (already through
 * `canonicalizeProvenancePath`) and the tool name from the live tool call.
 * Returns one synthetic record per matching enforced rule. The caller
 * (`evaluateWriteTargetProvenance` after PERM-6) feeds these into
 * `evaluateAdmission`'s synthetic-record channel.
 */
export function compileRulesForTarget(
  rules: ResolvedPermissions,
  toolName: string,
  canonicalPath: string,
  projectRoot: string,
  homeDir: string,
  opts: CompileRulesOptions = {},
): CompileRulesResult {
  const ts = opts.ts ?? Number.NEGATIVE_INFINITY
  const pathRecords: ProvenanceRecord[] = []

  for (const rule of rules.deny) {
    if (!rule.enforced) continue
    if (!ruleToolMatches(rule.tool, toolName)) continue
    if (!matchRulePattern(rule.pattern, canonicalPath, projectRoot, homeDir)) continue
    pathRecords.push({
      kind: 'user_explicit_deny',
      ts,
      originIteration: -1,
      originalString: describeRuleSource(rule),
      denyMarker: 'settings_rule',
      denyScope: 'exact',
      permanent: true,
    })
  }

  for (const rule of rules.allow) {
    if (rule.source === 'project' || rule.source === 'local') continue
    if (!rule.enforced) continue
    if (!ruleToolMatches(rule.tool, toolName)) continue
    if (!matchRulePattern(rule.pattern, canonicalPath, projectRoot, homeDir)) continue
    pathRecords.push({
      kind: 'user_declared_target',
      ts,
      originIteration: -1,
      originalString: describeRuleSource(rule),
      verbContext: 'settings_rule',
      permanent: true,
    })
  }

  return { pathRecords }
}
