import { describe, test, expect } from 'vitest'
import { scanContent, scanAllowlist, scanPublicTree } from '../src/public-mirror/scan.js'

const allowSrcOnly = (p: string): boolean => p.startsWith('src/')

describe('scanContent — content leak detection on the generated public tree', () => {
  test('flags host home paths with a real (non-placeholder) name', () => {
    const v = scanContent([
      { path: 'docs/x.md', content: 'see /Users/realuser/AI/gitrep/owlcoda for setup\n' },
    ])
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ path: 'docs/x.md', line: 1, rule: 'host-path' })
    expect(v[0].match).toContain('/Users/realuser')
  })

  test('ignores generic placeholder usernames (not a real leak)', () => {
    const v = scanContent([{ path: 'd.md', content: 'see /Users/test/project\n' }])
    expect(v.filter((x) => x.rule === 'host-path')).toEqual([])
  })

  test('flags forbidden competitor/provenance terms (case-insensitive)', () => {
    const competitorName = ['Claude', 'Code'].join(' ')
    const v = scanContent([
      { path: 'src/a.ts', content: `// integrate with ${competitorName} here\n` },
    ])
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ path: 'src/a.ts', line: 1, rule: 'forbidden-term' })
  })

  test('flags stale public-repo posture phrases', () => {
    const v = scanContent([
      { path: 'docs/arch.md', content: 'line one\nthe public repo is a router, not source truth\n' },
    ])
    expect(v.some((x) => x.rule === 'stale-posture' && x.line === 2)).toBe(true)
  })

  test('flags internal QA snapshot phrasing that must not ship in public UI', () => {
    const lane = ['Lane', 'A'].join(' ')
    const internalReportWord = ['sign', 'off'].join('')
    const longStress = ['long', 'stress'].join('-')
    const guardFix = ['guard', 'fix'].join(' ')
    const rerun = ['rerun', 'still', 'required'].join(' ')
    const v = scanContent([
      {
        path: 'admin/src/pages/RunsPage.tsx',
        content: `${lane} ${longStress} ${internalReportWord}; ${guardFix} patched, ${rerun}\n`,
      },
    ])
    expect(v.map((x) => x.rule)).toContain('internal-qa-snapshot')
  })

  test('allows generic QA signoff wording that is not an internal snapshot', () => {
    const internalReportWord = ['sign', 'off'].join('')
    const v = scanContent([
      {
        path: 'skills/playwright-interactive/SKILL.md',
        content: `Before ${internalReportWord}, verify the UI with real controls.\n`,
      },
    ])
    expect(v.filter((x) => x.rule === 'internal-qa-snapshot')).toEqual([])
  })

  test('allows generic remaining-blocker headings that are not internal snapshots', () => {
    const heading = ['Remaining', 'blockers'].join(' ')
    const v = scanContent([
      {
        path: 'skills/phase-prompting/SKILL.md',
        content: `### ${heading}\nList open product risks before delivery.\n`,
      },
    ])
    expect(v.filter((x) => x.rule === 'internal-qa-snapshot')).toEqual([])
  })

  test('flags api-key-shaped secrets', () => {
    const v = scanContent([
      { path: 'config.json', content: 'KEY=sk-ant-api03-abcdEFGH1234ZZ\n' },
    ])
    expect(v).toHaveLength(1)
    expect(v[0].rule).toBe('secret-prefix')
  })

  test('allows exact reviewed fake secret fixtures in sanitizer tests', () => {
    const v = scanContent([
      {
        path: 'tests/data-sanitize.test.ts',
        content: "const fake = 'sk-abc123def456ghi789jkl012mno345'\n",
      },
      {
        path: 'tests/runtime-profile.test.ts',
        content: "const fake = 'sk-ant-this-is-a-very-long-api-key-12345678901234567890'\n",
      },
    ])
    expect(v.filter((x) => x.rule === 'secret-prefix')).toEqual([])
  })

  test('does not flag the public-mirror scanner fixture surface itself', () => {
    const competitorSlug = ['claude', 'code'].join('-')
    const v = scanContent([
      { path: 'src/public-mirror/scan.ts', content: `const term = '${competitorSlug}'\n` },
      { path: 'tests/public-mirror-build.test.ts', content: "const path = '/Users/realuser/x'\n" },
    ])
    expect(v).toEqual([])
  })

  test('reports the correct 1-based line number', () => {
    const v = scanContent([
      { path: 'd.md', content: 'clean\nclean\n/Users/realuser/x\n' },
    ])
    expect(v[0].line).toBe(3)
  })

  test('returns no violations for clean content', () => {
    const v = scanContent([
      { path: 'src/ok.ts', content: 'export const x = 1\n' },
      { path: 'README.md', content: '# OwlCoda\nLocal-first AI coding.\n' },
    ])
    expect(v).toEqual([])
  })
})

describe('scanAllowlist — default-deny path membership', () => {
  test('flags files outside the allowlist as whole-file (line 0)', () => {
    const v = scanAllowlist([{ path: 'internal/secret.md', content: 'x' }], allowSrcOnly)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ path: 'internal/secret.md', line: 0, rule: 'not-allowlisted' })
  })

  test('passes allowlisted files', () => {
    expect(scanAllowlist([{ path: 'src/cli.ts', content: 'x' }], allowSrcOnly)).toEqual([])
  })
})

describe('scanPublicTree — combines allowlist + content checks', () => {
  test('returns both not-allowlisted and content violations', () => {
    const v = scanPublicTree(
      [
        { path: 'internal/x.md', content: 'clean' },
        { path: 'src/a.ts', content: 'path /Users/privateuser/x\n' },
      ],
      allowSrcOnly,
    )
    const rules = v.map((x) => x.rule)
    expect(rules).toContain('not-allowlisted')
    expect(rules).toContain('host-path')
  })
})
