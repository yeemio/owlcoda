import { isPlaceholderHomeName } from './transform.js'

export interface PublicTreeFile {
  path: string
  content: string
}

export interface ScanViolation {
  path: string
  line: number
  rule: string
  match: string
}

/** Absolute host/home paths. Generic placeholder names are skipped (not leaks). */
const HOST_PATH_RE = /(?:\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g

/** API-key / token shapes. Conservative prefixes to avoid false positives. */
const SECRET_RES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[posru]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
]

const REVIEWED_FAKE_SECRETS: ReadonlyArray<{ path: string; match: string }> = [
  { path: 'tests/data-sanitize.test.ts', match: 'sk-abc123def456ghi789jkl012mno345' },
  { path: 'tests/data-sanitize.test.ts', match: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234' },
  { path: 'tests/data-sanitize.test.ts', match: 'AKIAIOSFODNN7EXAMPLE' },
  { path: 'tests/data-sanitize.test.ts', match: 'sk-abcdef1234567890abcdef1234' },
  {
    path: 'tests/runtime-profile.test.ts',
    match: 'sk-ant-this-is-a-very-long-api-key-12345678901234567890',
  },
]

const STALE_PRIVATE_SOURCE_TRUTH = ['private', 'source', 'truth'].join(' ')
const STALE_PRIVATE_SOURCE_OF_TRUTH = ['private', 'source-of-truth'].join(' ')
const STALE_NOT_SOURCE_TRUTH = ['not', 'source', 'truth'].join(' ')
const STALE_NOT_DEVELOPMENT_SOURCE_TRUTH = ['not the development', 'source of truth'].join(' ')
const STALE_ROUTER_NOT = ['router', 'not'].join(', ')
const STALE_SOURCE_TRUTH_DURING_TRIAL = ['source truth during', 'trial'].join(' ')
const STALE_TRIAL_PHASE = ['trial', 'phase'].join(' ')
const INTERNAL_QA_LANE_A = ['lane', 'a'].join(' ')
const INTERNAL_QA_LONG_STRESS = ['long', 'stress'].join('-')
const INTERNAL_QA_GUARD_FIX = ['guard', 'fix'].join(' ')
const INTERNAL_QA_RERUN_REQUIRED = ['rerun', 'still', 'required'].join(' ')
const INTERNAL_QA_PROJECT_LANE_TOKEN = ['owlcoda', 'lane'].join('_')

function phrasePattern(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')
  return new RegExp(`\\b${escaped}\\b`, 'i')
}

const REVIEWED_FIXTURE_VIOLATIONS: ReadonlyArray<{ path: string; rule: string; match: string }> = [
  { path: 'src/public-mirror/scan.ts', rule: 'secret-prefix', match: 'sk-abc123def456ghi789jkl012mno345' },
  { path: 'src/public-mirror/scan.ts', rule: 'secret-prefix', match: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234' },
  { path: 'src/public-mirror/scan.ts', rule: 'secret-prefix', match: 'AKIAIOSFODNN7EXAMPLE' },
  { path: 'src/public-mirror/scan.ts', rule: 'secret-prefix', match: 'sk-abcdef1234567890abcdef1234' },
  {
    path: 'src/public-mirror/scan.ts',
    rule: 'secret-prefix',
    match: 'sk-ant-this-is-a-very-long-api-key-12345678901234567890',
  },
  { path: 'src/public-mirror/scan.ts', rule: 'forbidden-term', match: ['claude', 'code'].join(' ') },
  { path: 'src/public-mirror/scan.ts', rule: 'forbidden-term', match: 'writesync interceptor' },
  { path: 'src/public-mirror/scan.ts', rule: 'forbidden-term', match: 'implicit competitor' },
  { path: 'src/public-mirror/scan.ts', rule: 'forbidden-term', match: 'competitor coupling' },
  { path: 'src/public-mirror/scan.ts', rule: 'stale-posture', match: STALE_PRIVATE_SOURCE_TRUTH },
  { path: 'src/public-mirror/scan.ts', rule: 'stale-posture', match: STALE_PRIVATE_SOURCE_OF_TRUTH },
  { path: 'src/public-mirror/scan.ts', rule: 'stale-posture', match: STALE_NOT_SOURCE_TRUTH },
  { path: 'src/public-mirror/scan.ts', rule: 'stale-posture', match: STALE_NOT_DEVELOPMENT_SOURCE_TRUTH },
  { path: 'src/public-mirror/scan.ts', rule: 'stale-posture', match: STALE_ROUTER_NOT },
  { path: 'src/public-mirror/scan.ts', rule: 'stale-posture', match: STALE_SOURCE_TRUTH_DURING_TRIAL },
  { path: 'src/public-mirror/scan.ts', rule: 'stale-posture', match: STALE_TRIAL_PHASE },
  { path: 'src/public-mirror/transform.ts', rule: 'forbidden-term', match: ['Claude', 'Code'].join(' ') },
  { path: 'src/public-mirror/transform.ts', rule: 'forbidden-term', match: ['Claude', 'Code'].join('-') },
  { path: 'src/public-mirror/transform.ts', rule: 'forbidden-term', match: ['claude', 'code'].join('-') },
  { path: 'src/public-mirror/transform.ts', rule: 'forbidden-term', match: `Owl${'CC'}` },
  { path: 'src/public-mirror/transform.ts', rule: 'forbidden-term', match: `owl${'cc'}` },
  { path: 'tests/public-mirror-scan.test.ts', rule: 'host-path', match: '/Users/realuser' },
  { path: 'tests/public-mirror-scan.test.ts', rule: 'host-path', match: '/Users/privateuser' },
  { path: 'tests/public-mirror-scan.test.ts', rule: 'secret-prefix', match: 'sk-ant-api03-abcdEFGH1234ZZ' },
  { path: 'tests/public-mirror-scan.test.ts', rule: 'secret-prefix', match: 'sk-abc123def456ghi789jkl012mno345' },
  {
    path: 'tests/public-mirror-scan.test.ts',
    rule: 'secret-prefix',
    match: 'sk-ant-this-is-a-very-long-api-key-12345678901234567890',
  },
  { path: 'tests/public-mirror-scan.test.ts', rule: 'stale-posture', match: 'not source truth' },
  { path: 'tests/public-mirror-scan.test.ts', rule: 'stale-posture', match: 'router, not' },
  { path: 'tests/public-mirror-transform.test.ts', rule: 'host-path', match: '/Users/realuser' },
  { path: 'tests/public-mirror-transform.test.ts', rule: 'forbidden-term', match: ['Claude', 'Code'].join(' ') },
  { path: 'tests/public-mirror-transform.test.ts', rule: 'forbidden-term', match: `Owl${'CC'}` },
  { path: 'tests/public-mirror-transform.test.ts', rule: 'forbidden-term', match: `owl${'cc'}` },
  { path: 'tests/public-mirror-transform.test.ts', rule: 'forbidden-term', match: ['claude', 'code'].join('-') },
  { path: 'tests/public-mirror-build.test.ts', rule: 'host-path', match: '/Users/realuser' },
  { path: 'tests/public-mirror-build.test.ts', rule: 'forbidden-term', match: `Owl${'CC'}` },
]

function isReviewedViolation(path: string, rule: string, match: string): boolean {
  if (REVIEWED_FAKE_SECRETS.some((entry) => entry.path === path && entry.match === match)) {
    return true
  }
  return REVIEWED_FIXTURE_VIOLATIONS.some((entry) =>
    entry.path === path && entry.rule === rule && entry.match === match)
}

function isScannerFixtureSurface(path: string): boolean {
  return path === 'src/public-mirror/scan.ts'
    || path === 'src/public-mirror/transform.ts'
    || path === 'src/public-mirror/build.ts'
    || path.startsWith('tests/public-mirror-')
}

/** Competitor-coupling / provenance terms the public tree must not carry. */
const FORBIDDEN_TERMS = [
  ['claude', 'code'].join(' '),
  ['claude', 'code'].join('-'),
  `owl${'cc'}`,
  'writesync interceptor',
  'implicit competitor',
  'competitor coupling',
]

/** Old distribution posture that contradicts the GPL public-source line. */
const STALE_POSTURE = [
  STALE_PRIVATE_SOURCE_TRUTH,
  STALE_PRIVATE_SOURCE_OF_TRUTH,
  STALE_NOT_SOURCE_TRUTH,
  STALE_NOT_DEVELOPMENT_SOURCE_TRUTH,
  STALE_ROUTER_NOT,
  STALE_SOURCE_TRUTH_DURING_TRIAL,
  STALE_TRIAL_PHASE,
]

/** Internal QA snapshot language must not become public admin/product copy. */
const INTERNAL_QA_SNAPSHOT_PATTERNS = [
  phrasePattern(INTERNAL_QA_LANE_A),
  phrasePattern(INTERNAL_QA_LONG_STRESS),
  phrasePattern(INTERNAL_QA_GUARD_FIX),
  phrasePattern(INTERNAL_QA_RERUN_REQUIRED),
  phrasePattern(INTERNAL_QA_PROJECT_LANE_TOKEN),
]

/**
 * Scan generated public-tree files for content that must never reach the public
 * repository. Pure: takes (path, content) pairs, returns one violation per hit
 * with a 1-based line number. Empty array means clean.
 */
export function scanContent(files: PublicTreeFile[]): ScanViolation[] {
  const violations: ScanViolation[] = []
  for (const file of files) {
    if (isScannerFixtureSurface(file.path)) continue
    const lines = file.content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]
      const line = i + 1
      const lower = text.toLowerCase()

      for (const m of text.matchAll(HOST_PATH_RE)) {
        if (isPlaceholderHomeName(m[1])) continue
        if (isReviewedViolation(file.path, 'host-path', m[0])) continue
        violations.push({ path: file.path, line, rule: 'host-path', match: m[0] })
      }
      for (const re of SECRET_RES) {
        for (const m of text.matchAll(re)) {
          if (isReviewedViolation(file.path, 'secret-prefix', m[0])) continue
          violations.push({ path: file.path, line, rule: 'secret-prefix', match: m[0] })
        }
      }
      for (const term of FORBIDDEN_TERMS) {
        let idx = lower.indexOf(term)
        while (idx !== -1) {
          const match = text.slice(idx, idx + term.length)
          if (isReviewedViolation(file.path, 'forbidden-term', match)) {
            idx = lower.indexOf(term, idx + term.length)
            continue
          }
          violations.push({
            path: file.path,
            line,
            rule: 'forbidden-term',
            match,
          })
          idx = lower.indexOf(term, idx + term.length)
        }
      }
      for (const phrase of STALE_POSTURE) {
        if (lower.includes(phrase)) {
          if (isReviewedViolation(file.path, 'stale-posture', phrase)) continue
          violations.push({ path: file.path, line, rule: 'stale-posture', match: phrase })
        }
      }
      for (const pattern of INTERNAL_QA_SNAPSHOT_PATTERNS) {
        const match = text.match(pattern)?.[0]
        if (match) {
          if (isReviewedViolation(file.path, 'internal-qa-snapshot', match)) continue
          violations.push({ path: file.path, line, rule: 'internal-qa-snapshot', match })
        }
      }
    }
  }
  return violations
}

/**
 * Flag any file whose path is not allowed into the public tree. Whole-file
 * violation (line 0). `isAllowed` is injected (the manifest's `isPublicPath`)
 * so the scanner stays pure and testable.
 */
export function scanAllowlist(
  files: PublicTreeFile[],
  isAllowed: (path: string) => boolean,
): ScanViolation[] {
  const violations: ScanViolation[] = []
  for (const file of files) {
    if (!isAllowed(file.path)) {
      violations.push({ path: file.path, line: 0, rule: 'not-allowlisted', match: file.path })
    }
  }
  return violations
}

/** Full scan: path membership (default-deny) plus content leak detection. */
export function scanPublicTree(
  files: PublicTreeFile[],
  isAllowed: (path: string) => boolean,
): ScanViolation[] {
  return [...scanAllowlist(files, isAllowed), ...scanContent(files)]
}
