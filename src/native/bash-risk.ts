/**
 * Bash risk classifier — single shared truth source for command-level risk.
 *
 * Background — issue #2 (private):
 *   Three independent bash heuristics existed today and could drift:
 *     - src/native/tui/permission.ts::detectDestructiveCommand (TUI warning)
 *     - src/runtime/tools.ts::isDangerousBash (legacy runtime)
 *     - src/native/headless-approval.ts (treated ALL bash as unsafe)
 *   None shared a contract. Updating one without the others meant the
 *   interactive UI could call a command "destructive", the headless path
 *   could call it "needs approval", and the legacy runtime could call it
 *   "fine" — pick a surface, get a different policy.
 *
 *   This module replaces the three heuristics with one structured
 *   classifier. Each surface now consults the same function and surfaces
 *   the same level + reasons + side-effect flags.
 *
 * Design rules:
 *   - Deterministic: no I/O, no clock, no env. Same input → same output.
 *   - Structured: returns `{ level, reasons, mutatesFilesystem, ... }`,
 *     never just a boolean.
 *   - Fail-closed: anything we don't recognize returns `unknown`. Headless
 *     and approval surfaces MUST treat `unknown` as needs-approval (or
 *     deny when no approval channel exists). The classifier itself never
 *     guesses optimistically.
 *   - Compound-aware: `cmd1 && cmd2 | cmd3` is decomposed into chunks
 *     and the worst-risk chunk wins. A safe `ls` chained to a dangerous
 *     `rm -rf` classifies as dangerous.
 *   - Redirection-aware: `cmd > /tmp/x` is at least `needs_approval` for
 *     the redirect even when the underlying `cmd` is safe.
 *
 * Non-goals:
 *   - This is NOT a sandbox. It does not block execution; it produces a
 *     decision for the caller. Headless mode enforces the deny; the TUI
 *     uses the level for warning copy + border color.
 *   - This is NOT a full shell parser. We split on a small set of
 *     control operators and read the leading token of each chunk. A
 *     hand-crafted obfuscation (deep $(...) nesting, eval, base64 + sh)
 *     can hide the real intent — those land in `unknown` and get denied
 *     by the fail-closed default in headless.
 */

export type BashRiskLevel =
  | 'safe_readonly'
  | 'needs_approval'
  | 'dangerous'
  | 'unknown'

export interface BashRiskClassification {
  /** Worst level across all decomposed chunks. */
  level: BashRiskLevel
  /** Human-readable reasons, one per matched chunk/pattern. */
  reasons: string[]
  /** Whether any chunk mutates the filesystem (write/edit/delete/redirect). */
  mutatesFilesystem: boolean
  /** Whether any chunk reaches the network. */
  touchesNetwork: boolean
  /** Original input, normalized. */
  command: string
}

/**
 * Public entry point. Classify a single bash command string.
 *
 * Returns a `BashRiskClassification`. Empty / non-string inputs return
 * `unknown` so callers don't have to special-case them.
 */
export function classifyBashCommand(command: unknown): BashRiskClassification {
  if (typeof command !== 'string') {
    return emptyClassification('', 'unknown', ['command is not a string'])
  }
  const trimmed = command.trim()
  if (!trimmed) {
    return emptyClassification('', 'unknown', ['empty command'])
  }

  // Whole-command dangerous patterns — must run BEFORE chunk splitting so
  // we still see `curl <url> | sh` as a single dangerous pipeline rather
  // than two independent chunks (`curl <url>` + `sh`).
  for (const [pattern, reason] of WHOLE_COMMAND_DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        level: 'dangerous',
        reasons: [reason],
        mutatesFilesystem: true,
        touchesNetwork: true,
        command: trimmed,
      }
    }
  }

  const chunks = splitChunks(trimmed)
  let worst: BashRiskLevel = 'safe_readonly'
  const reasons: string[] = []
  let mutates = false
  let net = false

  for (const chunk of chunks) {
    const verdict = classifyChunk(chunk)
    if (rank(verdict.level) > rank(worst)) worst = verdict.level
    if (verdict.reason) reasons.push(verdict.reason)
    if (verdict.mutates) mutates = true
    if (verdict.network) net = true
  }

  // If we matched nothing useful for any chunk, the whole thing is
  // unknown (fail-closed). This catches obfuscated commands, exotic
  // builtins, and anything we haven't taught the classifier about.
  if (worst === 'safe_readonly' && reasons.length === 0) {
    return {
      level: 'unknown',
      reasons: ['no chunk matched a known-safe pattern'],
      mutatesFilesystem: false,
      touchesNetwork: false,
      command: trimmed,
    }
  }

  return {
    level: worst,
    reasons,
    mutatesFilesystem: mutates,
    touchesNetwork: net,
    command: trimmed,
  }
}

function emptyClassification(
  command: string,
  level: BashRiskLevel,
  reasons: string[],
): BashRiskClassification {
  return { level, reasons, mutatesFilesystem: false, touchesNetwork: false, command }
}

const RANK: Record<BashRiskLevel, number> = {
  safe_readonly: 0,
  needs_approval: 1,
  unknown: 2,
  dangerous: 3,
}
function rank(level: BashRiskLevel): number {
  return RANK[level]
}

// ─── Decomposition ────────────────────────────────────────────────────────
//
// Split on `;`, `&&`, `||`, `|` (but not `||` token starting `||=` etc.,
// which doesn't exist in bash). Pipes and conditionals all introduce a new
// command boundary. Backgrounding `&` is preserved on the chunk because
// the underlying command still runs and we still need to classify it.
//
// We stay out of quoted strings and `$(...)` / `` `...` `` substitutions.
// Inside those, splitting on the operators above would corrupt the
// command. So we tokenize with a tiny state machine first.

function splitChunks(input: string): string[] {
  const out: string[] = []
  let buf = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let parenDepth = 0
  let backtickDepth = 0
  while (i < input.length) {
    const ch = input[i]!
    const next = input[i + 1]
    if (!inSingle && !inDouble && parenDepth === 0 && backtickDepth === 0) {
      if (ch === ';') { flush(); i++; continue }
      if (ch === '|' && next !== '|') { flush(); i++; continue }
      if (ch === '|' && next === '|') { flush(); i += 2; continue }
      if (ch === '&' && next === '&') { flush(); i += 2; continue }
    }
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '`' && !inSingle && !inDouble) backtickDepth = backtickDepth === 0 ? 1 : 0
    else if (ch === '$' && next === '(' && !inSingle) { parenDepth++; buf += ch; i++; continue }
    else if (ch === ')' && !inSingle && parenDepth > 0) parenDepth--
    buf += ch
    i++
  }
  flush()
  return out.filter(s => s.length > 0)

  function flush() {
    const s = buf.trim()
    buf = ''
    if (s) out.push(s)
  }
}

// ─── Per-chunk classification ─────────────────────────────────────────────

interface ChunkVerdict {
  level: BashRiskLevel
  reason?: string
  mutates?: boolean
  network?: boolean
}

/**
 * Patterns that match the entire command string before chunk splitting.
 * Use sparingly — most rules are fine at chunk level. These are
 * specifically pipelines whose meaning would be destroyed by splitting
 * on `|` (e.g. `curl URL | sh`).
 */
const WHOLE_COMMAND_DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\bcurl\s+[^|]*\|\s*(?:bash|sh|zsh|fish)\b/, 'curl | shell'],
  [/\bwget\s+[^|]*\|\s*(?:bash|sh|zsh|fish)\b/, 'wget | shell'],
]

const DANGEROUS_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(?:--recursive\s+--force|--force\s+--recursive|-[a-zA-Z]*[rR][a-zA-Z]*[fF][a-zA-Z]*|-[a-zA-Z]*[fF][a-zA-Z]*[rR][a-zA-Z]*|-rf|-fr|-rF|-Rf|-RF|-fR)\b/, 'rm -rf / recursive force delete'],
  [/\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--force).*(\*|\/|~)/, 'rm with force on wildcard or root'],
  [/\bsudo\b/, 'sudo (privilege escalation)'],
  [/\bmkfs(?:\.[a-z0-9]+)?\b/, 'mkfs (filesystem format)'],
  [/\bfdisk\b/, 'fdisk (disk partition)'],
  [/\bdd\s+[^|;&]*\bof=\/(?:dev\/|$)/, 'dd of=/dev/* (raw disk write)'],
  [/>\s*\/dev\/(?:sd|nvme|hd|disk)/, 'redirect to disk device'],
  [/\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+777\b/, 'chmod -R 777 (recursive world-writable)'],
  [/\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+\//, 'chmod -R on absolute root path'],
  [/\bchown\s+-[a-zA-Z]*R[a-zA-Z]*\s+\//, 'chown -R on absolute root path'],
  [/\bkill\s+-9\b/, 'kill -9 (force kill)'],
  [/\bkillall\b/, 'killall (kills by name)'],
  [/\bpkill\b/, 'pkill (kills by pattern)'],
  [/:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, 'fork bomb'],
  [/\bgit\s+push\s+[^|;&]*--force(?:-with-lease)?\b/, 'git push --force'],
  [/\bgit\s+push\s+[^|;&]*-f\b/, 'git push -f'],
  [/\bgit\s+reset\s+[^|;&]*--hard\b/, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-zA-Z]*[fdx][a-zA-Z]*\b/, 'git clean -fd'],
  [/\bcurl\s+[^|;&]*\|\s*(?:bash|sh|zsh|fish)\b/, 'curl | shell'],
  [/\bwget\s+[^|;&]*\|\s*(?:bash|sh|zsh|fish)\b/, 'wget | shell'],
  [/>\s*\/etc\//, 'redirect into /etc/'],
  [/>\s*~\/\.ssh\//, 'redirect into ~/.ssh/'],
]

const NEEDS_APPROVAL_PATTERNS: Array<[RegExp, string, { mutates?: boolean; network?: boolean }?]> = [
  // File mutation (single-occurrence rm/mv/cp without recursive-force flags)
  [/\brm\s+/, 'rm (file deletion)', { mutates: true }],
  [/\bmv\s+/, 'mv (rename / move)', { mutates: true }],
  [/\bcp\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/, 'cp -r (recursive copy)', { mutates: true }],
  // Editing in place
  [/\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b/, 'sed -i (in-place edit)', { mutates: true }],
  [/\bperl\s+-[a-zA-Z]*i[a-zA-Z]*\b/, 'perl -i (in-place edit)', { mutates: true }],
  // Package installs
  [/\b(?:npm|pnpm|yarn)\s+(?:install|i|add)\b/, 'package install', { mutates: true, network: true }],
  [/\b(?:npm|pnpm|yarn)\s+(?:remove|rm|uninstall)\b/, 'package remove', { mutates: true }],
  [/\b(?:npm|pnpm|yarn)\s+(?:update|up|upgrade)\b/, 'package update', { mutates: true, network: true }],
  [/\bnpx\s+(?!--version)/, 'npx (executes arbitrary package)', { mutates: true, network: true }],
  [/\bpip3?\s+install\b/, 'pip install', { mutates: true, network: true }],
  [/\bpip3?\s+uninstall\b/, 'pip uninstall', { mutates: true }],
  [/\b(?:apt|apt-get|yum|dnf|brew)\s+(?:install|remove|update|upgrade)\b/, 'system package manager', { mutates: true, network: true }],
  [/\bcargo\s+(?:install|build|run|update)\b/, 'cargo install/build/run/update', { mutates: true, network: true }],
  [/\bgo\s+(?:install|build|run|get|mod\s+(?:download|tidy))\b/, 'go install/build/run/get/mod', { mutates: true, network: true }],
  // Git mutation
  [/\bgit\s+(?:checkout|switch)\b/, 'git checkout/switch (changes working tree)', { mutates: true }],
  [/\bgit\s+reset\b/, 'git reset (rewrites history)', { mutates: true }],
  [/\bgit\s+clean\b/, 'git clean (deletes files)', { mutates: true }],
  [/\bgit\s+commit\b/, 'git commit (writes commit)', { mutates: true }],
  [/\bgit\s+push\b/, 'git push (writes to remote)', { mutates: true, network: true }],
  [/\bgit\s+pull\b/, 'git pull (modifies working tree, network)', { mutates: true, network: true }],
  [/\bgit\s+merge\b/, 'git merge (modifies working tree)', { mutates: true }],
  [/\bgit\s+rebase\b/, 'git rebase (rewrites history)', { mutates: true }],
  [/\bgit\s+stash\b/, 'git stash (modifies working tree)', { mutates: true }],
  [/\bgit\s+tag\b/, 'git tag (writes refs)', { mutates: true }],
  [/\bgit\s+restore\b/, 'git restore (modifies working tree)', { mutates: true }],
  // Inline scripts that can write
  [/\bnode\s+-e\s+/, 'node -e (inline script)'],
  [/\bpython3?\s+-c\s+/, 'python -c (inline script)'],
  [/\bbash\s+-c\s+/, 'nested bash -c'],
  [/\bsh\s+-c\s+/, 'nested sh -c'],
  [/\beval\b/, 'eval (dynamic execution)'],
  // Network fetches (download, may execute)
  [/\bcurl\s+/, 'curl (network)', { network: true }],
  [/\bwget\s+/, 'wget (network)', { network: true }],
  [/\bssh\s+/, 'ssh (remote shell)', { network: true }],
  [/\bscp\s+/, 'scp (remote copy)', { network: true }],
  [/\brsync\s+/, 'rsync (mutates filesystem)', { mutates: true, network: true }],
  // Find with destructive actions
  [/\bfind\s+[^|;&]*-(?:exec|delete|execdir)\b/, 'find -exec/-delete (mutates)', { mutates: true }],
  // Tee writes
  [/\btee\b/, 'tee (writes to file)', { mutates: true }],
]

function classifyChunk(chunk: string): ChunkVerdict {
  // 1. Dangerous wins outright. Check first.
  for (const [pattern, reason] of DANGEROUS_PATTERNS) {
    if (pattern.test(chunk)) {
      return { level: 'dangerous', reason, mutates: true }
    }
  }

  // 2. File-mutating redirection (`>`, `>>`) — needs_approval at minimum.
  //    Detect after dangerous check so `> /dev/sd*` doesn't fall through.
  const redirect = detectMutatingRedirect(chunk)
  let redirectVerdict: ChunkVerdict | null = null
  if (redirect) {
    redirectVerdict = { level: 'needs_approval', reason: redirect, mutates: true }
  }

  // 3. Heredoc that writes (e.g. `cat <<EOF > file`). The redirect
  //    detector above already catches the `>` part; if a heredoc appears
  //    without a redirect we treat the heredoc itself as needs_approval
  //    only when paired with a write (cat, tee). Bare heredocs feeding
  //    `cat` to stdout are safe — but we play it safe and bump to
  //    needs_approval if any `<<` appears with a `tee` or a redirect.
  if (/<<-?\s*['"]?\w+['"]?/.test(chunk) && /\b(?:tee|>\s*\S+)/.test(chunk)) {
    return { level: 'needs_approval', reason: 'heredoc with write', mutates: true }
  }

  // 4. Specific needs_approval patterns.
  for (const [pattern, reason, flags] of NEEDS_APPROVAL_PATTERNS) {
    if (pattern.test(chunk)) {
      return {
        level: 'needs_approval',
        reason,
        mutates: flags?.mutates ?? false,
        network: flags?.network ?? false,
      }
    }
  }

  if (redirectVerdict) return redirectVerdict

  // 5. Read-only safe whitelist by leading token + subcommand sniffing.
  const safe = classifySafeRead(chunk)
  if (safe) return safe

  // 6. Unknown — fail closed.
  return { level: 'unknown', reason: `no rule matched for: ${chunk.slice(0, 60)}` }
}

/**
 * Return a reason if the chunk contains a mutating redirection
 * (`>`, `>>`, `<>` etc.) outside quotes. Process substitution
 * `>(cmd)` / `<(cmd)` is excluded — that doesn't write a file.
 */
function detectMutatingRedirect(chunk: string): string | null {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!
    const next = chunk[i + 1]
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (inSingle || inDouble) continue
    // Skip process substitution: `>(...)` and `<(...)`
    if ((ch === '>' || ch === '<') && next === '(') continue
    // Skip heredoc operator `<<` and here-string `<<<`
    if (ch === '<') continue
    if (ch === '>') {
      // Skip `2>&1` style fd duplication: if previous non-space was a
      // digit AND next is `&`, this is a duplication, not a write to a
      // file. (We still see `>file` as a write — the `2>&1` case has
      // `&` after the operator.)
      if (next === '&') continue
      return 'shell redirection (>)'
    }
  }
  return null
}

function classifySafeRead(chunk: string): ChunkVerdict | null {
  const tokens = tokenize(chunk)
  if (tokens.length === 0) return null
  const head = tokens[0]!.toLowerCase()
  const sub = tokens[1]?.toLowerCase()

  // Bare safe tokens (handled here so we can also re-check that they
  // don't have any unexpected suffix).
  if (head === 'pwd' || head === 'whoami' || head === 'hostname' ||
      head === 'date' || head === 'true' || head === 'false' ||
      head === 'uname' || head === 'env' || head === 'echo' || head === 'printf') {
    return { level: 'safe_readonly', reason: `${head} (read-only)` }
  }

  if (head === 'ls' || head === 'cat' || head === 'head' || head === 'tail' ||
      head === 'less' || head === 'more' || head === 'file' || head === 'stat' ||
      head === 'wc' || head === 'tree' || head === 'sort' || head === 'uniq' ||
      head === 'cut' || head === 'tr' || head === 'fold' || head === 'tac' ||
      head === 'nl' || head === 'paste' || head === 'comm' || head === 'diff' ||
      head === 'cmp' || head === 'xxd' || head === 'od' ||
      head === 'basename' || head === 'dirname' || head === 'realpath' ||
      head === 'readlink' || head === 'rg' || head === 'grep' ||
      head === 'egrep' || head === 'fgrep' || head === 'ack' ||
      head === 'which' || head === 'type' || head === 'jq' || head === 'yq') {
    return { level: 'safe_readonly', reason: `${head} (read-only)` }
  }

  // Tool subcommand carve-outs
  if (head === 'git') {
    if (sub && SAFE_GIT_SUBCMDS.has(sub)) {
      return { level: 'safe_readonly', reason: `git ${sub} (read-only)` }
    }
    // Other git subcommands — fall through to needs_approval/unknown via
    // the general patterns we already checked. Land on unknown so headless
    // fails closed.
    return null
  }

  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    if (sub && SAFE_PKG_SUBCMDS.has(sub)) {
      return { level: 'safe_readonly', reason: `${head} ${sub} (read-only)` }
    }
    if (tokens.includes('--version') || tokens.includes('-v')) {
      return { level: 'safe_readonly', reason: `${head} --version` }
    }
    return null
  }

  if ((head === 'node' || head === 'tsc' || head === 'python' || head === 'python3' ||
       head === 'go' || head === 'cargo' || head === 'rustc' || head === 'pip' || head === 'pip3') &&
      (tokens.includes('--version') || tokens.includes('-v') || tokens.includes('-V'))) {
    return { level: 'safe_readonly', reason: `${head} --version` }
  }

  // find without -exec/-delete/-execdir: SAFE_READ already handled the
  // dangerous variant via NEEDS_APPROVAL_PATTERNS. Plain `find . -name ...`
  // is read-only.
  if (head === 'find') {
    return { level: 'safe_readonly', reason: 'find (read-only traversal)' }
  }

  return null
}

const SAFE_GIT_SUBCMDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'tag', // tag with no args is read; tag <name> is mutating but caught earlier
  'remote', 'config', 'rev-parse', 'rev-list', 'shortlog', 'describe',
  'blame', 'grep', 'ls-files', 'ls-tree', 'cat-file', 'help',
  'reflog', 'fsck', 'count-objects', 'whatchanged',
])

const SAFE_PKG_SUBCMDS = new Set([
  'list', 'ls', 'view', 'show', 'info', 'outdated', 'audit', 'doctor',
  'config', 'help', 'why', 'pack', 'fund', 'token',
  'run', 'test', // common script aliases — tests/builds may write but are
                  // intentional user-initiated steps; we treat them as
                  // safe-ish here. If a project uses `npm test` to push,
                  // they should set OWLCODA policy explicitly.
])

/**
 * Tokenize on whitespace, respecting single and double quotes. Good enough
 * for risk classification — does NOT do parameter expansion or globbing.
 */
function tokenize(chunk: string): string[] {
  const out: string[] = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i]!
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (buf) { out.push(buf); buf = '' }
      continue
    }
    buf += ch
  }
  if (buf) out.push(buf)
  return out
}

/**
 * Convenience boolean for legacy bridge call sites that only need to know
 * "should we ask first?". Treats `unknown` and `dangerous` and
 * `needs_approval` as true (i.e. ask). Safe-read returns false.
 *
 * Don't use this in new code — prefer the structured `classifyBashCommand`
 * so callers can render real reasons. This exists so the legacy
 * `runtime/tools.ts::isDangerousBash` and the TUI's
 * `detectDestructiveCommand` can collapse to the shared truth source
 * without changing their public signature.
 */
export function isUnsafeBashCommand(command: unknown): boolean {
  return classifyBashCommand(command).level !== 'safe_readonly'
}
