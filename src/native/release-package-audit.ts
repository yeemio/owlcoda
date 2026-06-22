export const REQUIRED_RELEASE_PACKAGE_FILES = [
  'dist/cli.js',
  'dist/build-info.json',
  'schemas/runtime-event-contract.v1.schema.json',
  'skills/goal-driven-project-loop/SKILL.md',
  'skills/openai-docs/SKILL.md',
  'skills/testing/test-driven-development/SKILL.md',
  'README.md',
  'README.zh.md',
  'CHANGELOG.md',
  'LICENSE',
  'SOURCE.md',
  'NOTICE.md',
  'assets/branding/admin-models.png',
  'scripts/postbuild.mjs',
  'config.example.json',
]

const FORBIDDEN_PREFIXES = [
  'src/',
  'tests/',
  'demo/',
  'docs/',
  'site/',
  'examples/',
  '.github/',
  'node_modules/',
  'admin/',
]

const FORBIDDEN_PATTERNS = [
  /\.map$/,
  /public-mirror\//,
  /\.codex\//,
  /\.git\//,
  /sessions?\//,
  /owlcoda-.*\.tgz$/,
]

export interface ReleasePackageAudit {
  passed: boolean
  entryCount: number
  missing: string[]
  forbidden: string[]
  required: string[]
  forbiddenPrefixes: string[]
  forbiddenPatterns: string[]
  hasSkillEntrypoints: number
  topLevel: string[]
}

export function auditReleasePackageFileList(files: string[]): ReleasePackageAudit {
  const normalizedFiles = files
    .map(normalizePackagePath)
    .filter((file) => file.length > 0)

  const fileSet = new Set(normalizedFiles)
  const missing = REQUIRED_RELEASE_PACKAGE_FILES.filter((file) => !fileSet.has(file))
  const forbidden = normalizedFiles.filter((file) => isForbiddenPackagePath(file))
  const hasSkillEntrypoints = normalizedFiles.filter((file) => /^skills\/.*\/SKILL\.md$/.test(file)).length
  const topLevel = Array.from(new Set(normalizedFiles.map((file) => file.split('/')[0] ?? file))).sort()

  return {
    passed: missing.length === 0 && forbidden.length === 0,
    entryCount: normalizedFiles.length,
    missing,
    forbidden,
    required: [...REQUIRED_RELEASE_PACKAGE_FILES],
    forbiddenPrefixes: [...FORBIDDEN_PREFIXES],
    forbiddenPatterns: FORBIDDEN_PATTERNS.map((pattern) => pattern.source),
    hasSkillEntrypoints,
    topLevel,
  }
}

function normalizePackagePath(file: string): string {
  return file.replace(/^package\//, '').replace(/^\.\//, '').trim()
}

function isForbiddenPackagePath(file: string): boolean {
  return FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix))
    || FORBIDDEN_PATTERNS.some((pattern) => pattern.test(file))
}
