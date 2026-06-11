/**
 * Settings-driven permission rules (Slice 3 / PERM track).
 *
 * The schema mirrors external coding-assistant's `settings.json` `permissions` block:
 *
 *   {
 *     "permissions": {
 *       "allow": ["Edit(src/**)", "Write(./output/**)"],
 *       "deny":  ["*(~/.ssh/**)", "Read(./.env)"],
 *       "ask":   []
 *     }
 *   }
 *
 * OwlCoda adds one sugar: `*(pattern)` matches any tool, equivalent to
 * writing every Tool-form individually. Bare strings (no `Tool(...)` wrapper)
 * are rejected at parse time to keep the grammar unambiguous.
 *
 * Loaded from three files in precedence order (rules MERGE; deny across any
 * layer always wins):
 *   1. `~/.owlcoda/settings.json`             — user-level
 *   2. `<cwd>/.owlcoda/settings.json`          — project shared
 *   3. `<cwd>/.owlcoda/settings.local.json`    — project local (gitignored)
 *
 * v1 enforcement scope (PERM track): path-shape rules compiled into baseline
 * provenance ledger evidence and consulted by the existing admission gate.
 * `Bash(...)` command-pattern rules are PARSED but NOT ENFORCED — they emit
 * a load-time warning so users who paste a CC `settings.json` over know
 * what's been ignored. See spec §17 for the full enforcement matrix.
 */

/**
 * Tools that can appear as the head of a permission rule. `*` is the
 * OwlCoda-specific sugar meaning "applies to any tool". Bash is parsed
 * for forward-compat with CC syntax but not enforced in v1.
 */
export type PermissionTool =
  | 'Read'
  | 'Edit'
  | 'Write'
  | 'NotebookEdit'
  | 'Glob'
  | 'Grep'
  | 'TaskCreate'
  | 'Bash'
  | '*'

/**
 * The effective behavior of a rule after parsing. `ask` is collapsed into
 * `deny` at parse time (and a warning is emitted) because v1 has no
 * interactive approval path. See §17.4.
 */
export type PermissionEffect = 'allow' | 'deny'

/**
 * A parsed rule. `enforced=false` records that the rule was loaded but is
 * intentionally inert — currently only true for `Bash(...)` rules in v1.
 * Downstream code consults `enforced` before applying.
 */
export interface PermissionRule {
  /** Verbatim "Tool(pattern)" string as read from settings.json. */
  raw: string
  tool: PermissionTool
  /** Trimmed content inside the parens. */
  pattern: string
  /** Effective effect after parse (ask → deny + warning). */
  effect: PermissionEffect
  /** False for Bash rules in v1; otherwise true. */
  enforced: boolean
  /** Provenance: which settings file produced this rule. */
  source?: PermissionRuleSource
}

/** Which settings file a rule came from. Used for warning messages and
 * debugging. */
export type PermissionRuleSource = 'user' | 'project' | 'local' | 'inline'

/**
 * Reasons a rule string failed to parse OR produced an enforcement caveat.
 * The wired caller emits these as telemetry so we can see what users are
 * trying to write that we don't fully support.
 */
export type PermissionWarningReason =
  /** `Bash(command-pattern)` parses but is not enforced by the v1 gate. */
  | 'bash_not_enforced'
  /** ToolName not in `PermissionTool` whitelist. */
  | 'unknown_tool'
  /** Missing `Tool(...)` wrapper — bare paths/strings are rejected. */
  | 'bare_string'
  /** Tool name found but `()` group empty/whitespace-only. */
  | 'empty_pattern'
  /** Closing paren missing or other shape issue. */
  | 'malformed'
  /** `ask:` rules are stored but treated as `deny:` in v1. */
  | 'ask_treated_as_deny'

export interface PermissionWarning {
  /** Verbatim input string that produced this warning. */
  raw: string
  reason: PermissionWarningReason
  /** Human-readable explanation for telemetry / display. */
  message: string
  /** Which settings file this came from, if known. */
  source?: PermissionRuleSource
}

/**
 * The fully resolved permissions for a conversation: rules merged across
 * the three settings layers, plus all warnings collected during the merge.
 * Consumers iterate `allow`/`deny` and act on rules where `enforced=true`.
 */
export interface ResolvedPermissions {
  allow: PermissionRule[]
  deny: PermissionRule[]
  /** v1: empty after parse; ask rules end up in `deny` with a warning. */
  ask: PermissionRule[]
  warnings: PermissionWarning[]
}
