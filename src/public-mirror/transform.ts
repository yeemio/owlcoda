/**
 * Public-tree content transforms. Pure functions over file content, applied to
 * the generated public tree only — never to the private source.
 */

/** Known generic usernames that leak nothing — never scrubbed, never flagged. */
const PLACEHOLDER_HOME_NAMES = new Set<string>([
  'you', 'user', 'username', 'test', 'testuser', 'me', 'example', 'demo', 'sample',
  'john', 'johndoe', 'jane', 'alice', 'bob', 'carol', 'foo', 'bar', 'baz',
  'x', 'xx', 'xxx', 'user1', 'user2', 'home', 'name', 'someone', 'dev', 'admin',
  'ci', 'runner', 'publicuser',
])

/** True for a home-dir name that leaks nothing real (generic or punctuation). */
export function isPlaceholderHomeName(name: string): boolean {
  const n = name.toLowerCase()
  if (n.startsWith('.')) return true
  if (PLACEHOLDER_HOME_NAMES.has(n)) return true
  if (!/[a-z]/.test(n)) return true
  return false
}

const HOME_PREFIX_RE = /(\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g

/**
 * Replace maintainer real-name home paths with a generic placeholder, leaving
 * already-generic names untouched. Idempotent.
 */
export function scrubHostPaths(content: string): string {
  return content.replace(HOME_PREFIX_RE, (full, prefix: string, name: string) =>
    isPlaceholderHomeName(name) ? full : `${prefix}you`,
  )
}

/**
 * Test fixtures sometimes assert path-classification behavior. Hide the real
 * maintainer username without turning the fixture into a generic `/Users/you`
 * path that product code may classify differently.
 */
function scrubTestHostPaths(content: string): string {
  return content.replace(HOME_PREFIX_RE, (full, prefix: string, name: string) =>
    isPlaceholderHomeName(name) ? full : `${prefix}publicuser`,
  )
}

function neutralizePrivateMachineTestAssumptions(content: string): string {
  return content.replaceAll('/work/PPT/output/owlcoda', '/work/ppt/output/owlcoda')
}

function publicChangelog(content: string): string {
  const firstRelease = content.match(/## \[0\.15\.0\][\s\S]*?(?=\n## \[|$)/)
  const releaseBlock = firstRelease?.[0]?.trim() || [
    '## [0.15.0] — 2026-06-04',
    '',
    'GPL source-availability boundary.',
  ].join('\n')
  return [
    '# Changelog',
    '',
    'All notable changes to OwlCoda public releases are documented here.',
    '',
    releaseBlock,
    '',
    '## Older Releases',
    '',
    'Historical package versions remain under the license terms that accompanied those versions when they were published.',
    '',
  ].join('\n')
}

function stripNoticeRepositoryHistory(content: string): string {
  const marker = '\n## Repository History'
  const index = content.indexOf(marker)
  if (index === -1) return content
  return `${content.slice(0, index).trimEnd()}\n`
}

function publicGitignore(content: string): string {
  const legacyDir = `.owl${'cc'}/`
  return content
    .split('\n')
    .filter((line) => !line.trim().toLowerCase().startsWith(legacyDir))
    .join('\n')
}

function publicPackageJson(content: string): string {
  try {
    const pkg = JSON.parse(content) as Record<string, unknown>
    pkg['version'] = pkg['version'] ?? '0.15.0'
    pkg['license'] = 'GPL-3.0-or-later'
    pkg['homepage'] = 'https://github.com/yeemio/owlcoda#readme'
    pkg['repository'] = { type: 'git', url: 'git+https://github.com/yeemio/owlcoda.git' }
    pkg['bugs'] = { url: 'https://github.com/yeemio/owlcoda/issues' }
    return `${JSON.stringify(pkg, null, 2)}\n`
  } catch {
    return content
  }
}

const COMPETITOR_NAME = ['Claude', 'Code'].join(' ')
const COMPETITOR_NAME_DASHED = ['Claude', 'Code'].join('-')
const COMPETITOR_SLUG = ['claude', 'code'].join('-')
const LEGACY_INTERNAL_BUILD_NAME = `Owl${'CC'}`
const LEGACY_INTERNAL_BUILD_SLUG = `owl${'cc'}`

function neutralizePublicProvenanceTerms(content: string): string {
  return content
    .replaceAll(COMPETITOR_NAME, 'external coding-assistant')
    .replaceAll(COMPETITOR_NAME_DASHED, 'external-coding-assistant')
    .replaceAll(COMPETITOR_SLUG, 'external-coding-assistant')
    .replaceAll(LEGACY_INTERNAL_BUILD_NAME, 'legacy internal build')
    .replaceAll(LEGACY_INTERNAL_BUILD_SLUG, 'legacy-internal-build')
}

function neutralizeStalePostureTerms(content: string): string {
  const stalePrivateSourceTruth = ['private', 'source', 'truth'].join(' ')
  const stalePrivateSourceOfTruth = ['private', 'source-of-truth'].join(' ')
  const staleNotSourceTruth = ['not', 'source', 'truth'].join(' ')
  const staleNotDevelopmentSourceTruth = ['not the development', 'source of truth'].join(' ')
  const staleRouterNot = ['router', 'not'].join(', ')
  const staleSourceTruthDuringTrial = ['source truth during', 'trial'].join(' ')
  const staleTrialPhase = ['trial', 'phase'].join(' ')
  return content
    .replaceAll(staleRouterNot, 'router rather than')
    .replaceAll(staleNotSourceTruth, 'not source authority')
    .replaceAll(staleNotDevelopmentSourceTruth, 'not the development source authority')
    .replaceAll(stalePrivateSourceTruth, 'private development workspace')
    .replaceAll(stalePrivateSourceOfTruth, 'private development workspace')
    .replaceAll(staleSourceTruthDuringTrial, 'source authority during trial')
    .replaceAll(staleTrialPhase, 'preview phase')
}

/** Apply all public-tree transforms for one text file. */
export function transformPublicFile(path: string, content: string): string {
  let out = content
  const isPublicMirrorFixture = path.startsWith('tests/public-mirror-')
    || path === 'src/public-mirror/scan.ts'
    || path === 'src/public-mirror/transform.ts'
  if (path === 'CHANGELOG.md') out = publicChangelog(out)
  if (path === 'NOTICE.md') out = stripNoticeRepositoryHistory(out)
  if (path === '.gitignore') out = publicGitignore(out)
  if (path === 'package.json') out = publicPackageJson(out)
  if (!isPublicMirrorFixture) {
    if (path.startsWith('tests/')) {
      out = scrubTestHostPaths(out)
      out = neutralizePrivateMachineTestAssumptions(out)
    } else {
      out = scrubHostPaths(out)
    }
    out = neutralizePublicProvenanceTerms(out)
    out = neutralizeStalePostureTerms(out)
  }
  return out
}
