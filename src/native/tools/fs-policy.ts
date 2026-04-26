/**
 * Filesystem write policy — defense-in-depth guard for native write/edit tools.
 *
 * Background — issue #3 (private):
 *   `write.ts`, `edit.ts`, and `notebook-edit.ts` previously called
 *   `path.resolve(input.path)` and went straight to `writeFile`. They
 *   trusted the conversation layer's task-scope approval to be the only
 *   safety net. That works when the only caller is a humans-in-the-loop
 *   REPL session, but every new caller (headless mode, sub-agents, MCP
 *   bridges, future remote tools) inherits the assumption silently. The
 *   tools themselves were not defensive.
 *
 *   This module is the per-tool last line of defense: even if an upstream
 *   approval layer said yes, the path itself must still survive the
 *   guard.
 *
 * Rules — small, deterministic, no policy DSL:
 *   1. Reject empty / non-string / whitespace-only paths.
 *   2. Resolve to an absolute path; reject anything outside the configured
 *      workspace root after resolution. Default root = `process.cwd()` at
 *      call time. Extra allowed roots may be added via the env var
 *      `OWLCODA_ALLOW_FS_ROOTS=<root1>:<root2>` (POSIX `:` separator).
 *   3. Reject sensitive locations regardless of workspace overlap:
 *      ~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, /etc, /var, /usr, /bin,
 *      /sbin, /System (macOS), /Library (macOS system), /boot, and
 *      OWLCODA_HOME itself (don't let an agent rewrite its own config).
 *   4. Resolve symlinks on every existing parent component and reject
 *      when the real path leaves the allowed root. New files (whose own
 *      target doesn't exist yet) are still validated by walking up to
 *      the nearest existing parent.
 *
 * What this is NOT:
 *   - Not an approval system. It can only say allow/deny based on the
 *     target path itself; it does not see who is calling.
 *   - Not a replacement for task-scope approval (`evaluateWriteGuard`).
 *     They run independently — task-scope at the conversation loop,
 *     this one inside the tool itself.
 */

import { realpathSync, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

export interface FsPolicyOptions {
  /** Workspace root that writes must stay inside. Default: `process.cwd()`. */
  workspaceRoot?: string
  /** Extra allowed roots beyond the workspace. Useful for tests / future task-contract bridges. */
  allowedRoots?: string[]
  /** Override the env-var lookup (test seam). */
  envAllowFsRoots?: string | undefined
  /** Override OWLCODA_HOME lookup (test seam). */
  owlcodaHome?: string | undefined
  /** Override homedir lookup (test seam). */
  homeDir?: string
  /** Override platform lookup (test seam). */
  platformName?: NodeJS.Platform
}

export type FsPolicyResult =
  | { allowed: true; resolvedPath: string }
  | { allowed: false; reason: string; attemptedPath: string }

/**
 * Evaluate whether a write to `targetPath` should be allowed under the
 * current policy. Pure: never mutates the filesystem, never throws —
 * always returns a structured decision.
 *
 * Callers are expected to short-circuit on `allowed: false` and surface
 * `reason` to the caller (or LLM) without performing the underlying
 * `writeFile`/`rename`/`unlink`/etc. This is the contract the tests
 * pin: rejection happens BEFORE mutation.
 */
export function checkWritePathAllowed(
  targetPath: unknown,
  opts: FsPolicyOptions = {},
): FsPolicyResult {
  if (typeof targetPath !== 'string') {
    return { allowed: false, reason: 'Path must be a non-empty string', attemptedPath: String(targetPath ?? '') }
  }
  const trimmed = targetPath.trim()
  if (!trimmed) {
    return { allowed: false, reason: 'Path must be a non-empty string', attemptedPath: targetPath }
  }
  if (trimmed.includes('\0')) {
    return { allowed: false, reason: 'Path contains a NUL byte', attemptedPath: trimmed }
  }

  const home = opts.homeDir ?? homedir()
  const workspaceRoot = normalizeRoot(opts.workspaceRoot ?? process.cwd())
  const envAllowed = opts.envAllowFsRoots !== undefined
    ? opts.envAllowFsRoots
    : process.env['OWLCODA_ALLOW_FS_ROOTS']
  const owlcodaHome = opts.owlcodaHome !== undefined
    ? opts.owlcodaHome
    : process.env['OWLCODA_HOME']
  const plat = opts.platformName ?? platform()

  const extraRoots = parseAllowedRoots(envAllowed)
  // tmpdir is intentionally NOT included by default. The atomic-write tool
  // drops a sibling temp file in the same dir as the target (already inside
  // the workspace), so we don't need to whitelist tmpdir for normal use.
  // Allowing it would silently extend write scope to anywhere inside
  // /private/var/folders on macOS, which defeats the purpose of having a
  // workspace boundary at all.
  const allowedRoots = dedupe([
    workspaceRoot,
    ...(opts.allowedRoots ?? []).map(normalizeRoot),
    ...extraRoots,
  ])

  const resolvedRaw = isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceRoot, trimmed)
  const resolvedReal = realpathParents(resolvedRaw)

  const sensitive = sensitiveDeny(resolvedReal, { home, owlcodaHome, plat })
  if (sensitive) {
    return { allowed: false, reason: sensitive, attemptedPath: resolvedReal }
  }

  for (const root of allowedRoots) {
    if (isWithin(resolvedReal, root)) {
      return { allowed: true, resolvedPath: resolvedReal }
    }
  }

  const summary = allowedRoots.slice(0, 3).join(', ')
  const more = allowedRoots.length > 3 ? ` (+${allowedRoots.length - 3} more)` : ''
  return {
    allowed: false,
    reason:
      `Path resolves outside the allowed workspace. ` +
      `Resolved: ${resolvedReal}. ` +
      `Allowed roots: ${summary}${more}. ` +
      `To extend the allowed set, set OWLCODA_ALLOW_FS_ROOTS=<root>[:<root>...].`,
    attemptedPath: resolvedReal,
  }
}

function normalizeRoot(p: string): string {
  // Resolve trailing-slash + symlink edge cases on the root itself so the
  // `isWithin` comparison is stable. Falling back to plain resolve when
  // the root doesn't exist (rare during tests).
  try { return realpathSync(resolve(p)) } catch { return resolve(p) }
}

function parseAllowedRoots(env: string | undefined): string[] {
  if (!env) return []
  // Use `:` on every platform (POSIX). Tests stub OWLCODA_ALLOW_FS_ROOTS
  // directly so this stays predictable.
  return env.split(':').map(s => s.trim()).filter(Boolean).map(normalizeRoot)
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const it of items) {
    if (seen.has(it)) continue
    seen.add(it)
    out.push(it)
  }
  return out
}

/**
 * Walk up the candidate path until we find an existing component, then
 * realpath that. New files (whose target doesn't exist yet) are validated
 * via the deepest existing parent, then re-joined with the missing tail.
 * This catches "write to ./inside/../../outside/file" and "write to
 * symlinked-dir/file" while still allowing genuine creates.
 */
function realpathParents(absPath: string): string {
  let cur = absPath
  let suffix = ''
  // Bound the loop by walking up while a dirname change is possible.
  for (let i = 0; i < 64; i++) {
    try {
      statSync(cur)
      // Component exists — realpath it and rejoin the missing suffix.
      const real = realpathSync(cur)
      return suffix ? join(real, suffix) : real
    } catch {
      const parent = dirname(cur)
      if (parent === cur) {
        // Reached filesystem root without finding any existing component;
        // give up and return the original resolved path. The allowed-root
        // comparison will still reject if it's outside.
        return absPath
      }
      const tail = cur.slice(parent.length).replace(/^[\\/]+/, '')
      suffix = suffix ? join(tail, suffix) : tail
      cur = parent
    }
  }
  return absPath
}

function isWithin(child: string, root: string): boolean {
  const r = normalize(root)
  const c = normalize(child)
  if (c === r) return true
  const rel = relative(r, c)
  if (!rel) return true
  if (rel.startsWith('..')) return false
  if (isAbsolute(rel)) return false
  // Defensive: ensure we don't sit on the root boundary literally
  return !rel.split(sep).includes('..')
}

interface SensitiveContext {
  home: string
  owlcodaHome: string | undefined
  plat: NodeJS.Platform
}

function sensitiveDeny(absPath: string, ctx: SensitiveContext): string | null {
  const candidates: Array<{ path: string; label: string }> = [
    { path: join(ctx.home, '.ssh'), label: '~/.ssh (SSH credentials)' },
    { path: join(ctx.home, '.aws'), label: '~/.aws (AWS credentials)' },
    { path: join(ctx.home, '.gnupg'), label: '~/.gnupg (GPG keys)' },
    { path: join(ctx.home, '.config', 'gh'), label: '~/.config/gh (GitHub CLI auth)' },
    { path: join(ctx.home, '.docker'), label: '~/.docker (Docker auth)' },
    { path: join(ctx.home, '.kube'), label: '~/.kube (Kubernetes config)' },
    { path: join(ctx.home, '.npmrc'), label: '~/.npmrc (npm auth)' },
    { path: join(ctx.home, '.pypirc'), label: '~/.pypirc (PyPI auth)' },
    { path: join(ctx.home, '.netrc'), label: '~/.netrc (network auth)' },
  ]

  if (ctx.plat === 'darwin' || ctx.plat === 'linux' || ctx.plat === 'freebsd' || ctx.plat === 'openbsd') {
    candidates.push(
      { path: '/etc', label: '/etc (system config)' },
      { path: '/usr', label: '/usr (system binaries)' },
      { path: '/bin', label: '/bin (system binaries)' },
      { path: '/sbin', label: '/sbin (system binaries)' },
      { path: '/boot', label: '/boot (boot files)' },
      // macOS quirk: /etc is a symlink to /private/etc and realpath() on
      // /etc/foo on macOS returns /private/etc/foo, so we deny both forms.
      // Listing them on every POSIX-family platform is harmless on Linux
      // (no such directory) and prevents a subtle macOS-only escape where
      // the resolved real path slips past a /etc-only check.
      // /var is intentionally NOT in the deny list: macOS puts user temp
      // dirs under /private/var/folders/..., so blanket-denying /var
      // would block all writes to mkdtempSync() output and most CI
      // workspaces. System-runtime concerns we'd want to block here are
      // already covered by /usr, /etc, /bin, /sbin, and OWLCODA_HOME.
      { path: '/private/etc', label: '/etc (system config)' },
    )
  }
  if (ctx.plat === 'darwin') {
    candidates.push(
      { path: '/System', label: '/System (macOS system)' },
      { path: '/Library/LaunchDaemons', label: '/Library/LaunchDaemons (macOS daemons)' },
    )
  }
  if (ctx.owlcodaHome) {
    candidates.push({ path: ctx.owlcodaHome, label: `OWLCODA_HOME (${ctx.owlcodaHome}) — agent must not rewrite its own config` })
  }

  for (const { path, label } of candidates) {
    // Normalize through realpath when the candidate exists, so a symlink
    // chain like /etc → /private/etc is matched no matter which side the
    // resolved write target landed on.
    const normalizedRoot = normalizeRoot(path)
    if (isWithin(absPath, normalizedRoot)) {
      return `Refusing to write to sensitive location: ${label}`
    }
    if (normalizedRoot !== normalize(path) && isWithin(absPath, normalize(path))) {
      return `Refusing to write to sensitive location: ${label}`
    }
  }
  return null
}
