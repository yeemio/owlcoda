import { describe, test, expect } from 'vitest'
import {
  scrubHostPaths,
  isPlaceholderHomeName,
  transformPublicFile,
} from '../src/public-mirror/transform.js'

describe('scrubHostPaths — normalize maintainer real-name home paths', () => {
  test('rewrites a real maintainer home path to a generic placeholder', () => {
    expect(scrubHostPaths('see /Users/realuser/AI/gitrep/owlcoda for setup')).toBe(
      'see /Users/you/AI/gitrep/owlcoda for setup',
    )
  })

  test('rewrites /home/<name> too', () => {
    expect(scrubHostPaths('cd /home/jesse/proj')).toBe('cd /home/you/proj')
  })

  test('leaves hidden app directories under /home untouched', () => {
    expect(scrubHostPaths('/home/.owlcoda/daemon.log')).toBe('/home/.owlcoda/daemon.log')
  })

  test('leaves generic placeholder usernames untouched', () => {
    expect(scrubHostPaths('/Users/test/x and /Users/bob/y')).toBe('/Users/test/x and /Users/bob/y')
  })

  test('is idempotent (already-scrubbed stays scrubbed)', () => {
    expect(scrubHostPaths('/Users/you/x')).toBe('/Users/you/x')
  })

  test('rewrites every occurrence', () => {
    expect(scrubHostPaths('/Users/realuser/a\n/Users/realuser/b')).toBe('/Users/you/a\n/Users/you/b')
  })
})

describe('isPlaceholderHomeName', () => {
  test('treats known generic names as placeholders', () => {
    for (const n of ['you', 'test', 'bob', 'me', 'alice', 'johndoe']) {
      expect(isPlaceholderHomeName(n)).toBe(true)
    }
  })

  test('treats real maintainer names as non-placeholders', () => {
    expect(isPlaceholderHomeName('realuser')).toBe(false)
    expect(isPlaceholderHomeName('jesse')).toBe(false)
  })

  test('treats punctuation-only elisions as placeholders', () => {
    expect(isPlaceholderHomeName('...')).toBe(true)
  })
})

describe('transformPublicFile — public source specific cleanup', () => {
  test('replaces the private historical changelog with a public release ledger', () => {
    const competitorName = ['Claude', 'Code'].join(' ')
    const legacyName = `Owl${'CC'}`
    const out = transformPublicFile(
      'CHANGELOG.md',
      `# Changelog\n\n## [0.15.0] — 2026-06-04\n\nGPL line.\n\n## [0.14.99]\n\n${competitorName} / ${legacyName} private notes.\n`,
    )
    expect(out).toContain('## [0.15.0] — 2026-06-04')
    expect(out).not.toMatch(new RegExp(`${competitorName}|${legacyName}|${legacyName.toLowerCase()}|${['claude', 'code'].join('-')}`, 'i'))
  })

  test('drops the private repository-history section from NOTICE', () => {
    const legacyName = `owl${'cc'}`
    const out = transformPublicFile(
      'NOTICE.md',
      `# NOTICE\n\n## Third-Party Source Attributions\n\nok\n\n## Repository History\n\nold ${legacyName} name\n`,
    )
    expect(out).toContain('## Third-Party Source Attributions')
    expect(out).not.toContain('Repository History')
    expect(out).not.toContain(legacyName)
  })

  test('removes legacy private working-directory entries from public .gitignore', () => {
    const legacyDir = `.owl${'cc'}/`
    const out = transformPublicFile('.gitignore', `dist/\n${legacyDir}\n.tmp/\n`)
    expect(out).toContain('dist/')
    expect(out).toContain('.tmp/')
    expect(out).not.toContain(legacyDir)
  })

  test('neutralizes competitor/provenance wording in public comments and descriptions', () => {
    const competitorName = ['Claude', 'Code'].join(' ')
    const competitorSlug = ['claude', 'code'].join('-')
    const legacyName = `Owl${'CC'}`
    const out = transformPublicFile(
      'src/native/example.ts',
      `// matches ${competitorName} and ${competitorSlug}#4277; old ${legacyName} upstream note\n`,
    )
    expect(out).not.toMatch(new RegExp(`${competitorName}|${competitorSlug}|${legacyName}|${legacyName.toLowerCase()}`, 'i'))
    expect(out).toContain('coding-assistant')
  })

  test('scrubs real home paths in tests without turning them into placeholder-user paths', () => {
    const out = transformPublicFile(
      'tests/native/task-state.test.ts',
      "const prompt = 'Write to /Users/realuser/work/ppt/output/owlcoda/deck.html'\n",
    )
    expect(out).toContain('/Users/publicuser/work/ppt/output/owlcoda/deck.html')
    expect(out).not.toContain('/Users/realuser')
    expect(out).not.toContain('/Users/you/work/ppt')
  })

  test('removes private-machine realpath assumptions from transformed tests', () => {
    const out = transformPublicFile(
      'tests/native/task-state.test.ts',
      "expect(path.includes('/work/PPT/output/owlcoda')).toBe(true)\n",
    )
    expect(out).toContain("/work/ppt/output/owlcoda")
    expect(out).not.toContain('/work/PPT/output/owlcoda')
  })

  test('keeps generic /Users/you scrub for non-test public docs and source', () => {
    const out = transformPublicFile('README.md', 'cd /Users/realuser/AI/gitrep/owlcoda\n')
    expect(out).toContain('/Users/you/AI/gitrep/owlcoda')
    expect(out).not.toContain('/Users/publicuser')
  })
})
