/**
 * Public-mirror allowlist — the single source of truth for what enters the
 * public GPL source tree. Default-deny: a path is published only if it matches
 * an allow rule and no deny carve-out. A new, unlisted file is omitted (safe),
 * never leaked.
 *
 * Supersedes the drift between npm `files[]`, the RELEASE-CHECKLIST rsync
 * excludes, and the prep-doc include/exclude lists for the public *source* tree.
 */

/** Directory prefixes whose entire subtree is published. */
const ALLOW_DIRS = ['src/', 'admin/', 'tests/', 'skills/', 'assets/branding/', 'examples/']

/** Mirror tooling subtree (transparent in a GPL tree). */
const ALLOW_SCRIPT_DIRS = ['scripts/public-mirror/']

/** Selected scripts needed for a public build / release smoke. */
const ALLOW_SCRIPT_FILES = [
  'scripts/postbuild.mjs',
  'scripts/release-smoke.ts',
  'scripts/smoke-test.sh',
  'scripts/swebench-lite-run.ts',
  // Imported by published tests (tests/ ships wholesale, so its script
  // dependencies must ship too or the public tree's suite breaks):
  'scripts/ink-write-boundary.mjs',
  // Tier-1 fitness-matrix currentEvidence ref; the published suite asserts it exists:
  'scripts/check-imported-untracked.mjs',
]

/** Exact root files that are published. */
const ALLOW_FILES = [
  'package.json',
  'package-lock.json',
  'config.example.json',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'LICENSE',
  'NOTICE.md',
  'SOURCE.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'tsconfig.json',
  'vitest.config.ts',
  '.gitignore',
]

// v0.15.0 source-open boundary: the public tree publishes NO docs/ files.
// All of docs/ (handoffs, execution prompts, QA, DD reports, architecture
// notes, TOOLS.md) stays private. Re-adding any docs/** path must be an
// explicit, reviewed allowlist change.

/** Deny carve-outs that override an allow rule (deny wins). */
const DENY_PREFIXES = ['admin/node_modules/', 'admin/dist/']

function normalize(path: string): string {
  return path.replace(/^\.\//, '').replace(/^\/+/, '')
}

export function isPublicPath(rawPath: string): boolean {
  const path = normalize(rawPath)
  if (path === '') return false
  for (const d of DENY_PREFIXES) if (path.startsWith(d)) return false
  for (const d of ALLOW_DIRS) if (path.startsWith(d)) return true
  for (const d of ALLOW_SCRIPT_DIRS) if (path.startsWith(d)) return true
  if (ALLOW_FILES.includes(path)) return true
  if (ALLOW_SCRIPT_FILES.includes(path)) return true
  return false
}
