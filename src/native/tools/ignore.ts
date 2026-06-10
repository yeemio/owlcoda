/**
 * Centralized ignore list for exploratory tools (glob, grep, etc.).
 *
 * One source of truth so each tool prunes the same generated-artifact and
 * dep-cache directories. Keep this in sync with what every engine tier
 * (rg, fast-glob, native walker) actually excludes — otherwise broad
 * searches in large repos still get buried in build output.
 */

export const IGNORE_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  // Generated artifacts
  'dist',
  'dist-prod',
  'build',
  'target',
  'output',
  'out',
  'coverage',
  // Framework / bundler caches
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.vite',
  // Tooling
  '.gradle',
  '.venv',
  '__pycache__',
  // Workspace noise
  'tmp',
  'temp',
  'screenshots',
])

/** Glob patterns suitable for rg `-g '!<pattern>'` and fast-glob `ignore`. */
export const IGNORE_GLOB_PATTERNS: readonly string[] = Array.from(IGNORE_DIR_NAMES)
  .map((name) => `**/${name}/**`)
