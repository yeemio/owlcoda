import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, expect } from 'vitest'
import { buildPublicMirrorTree } from '../src/public-mirror/build.js'

function write(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

describe('buildPublicMirrorTree — staging tree generator', () => {
  test('copies only allowlisted files, applies transforms, and reports a clean scan', () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'owlcoda-public-source-'))
    const outDir = mkdtempSync(join(tmpdir(), 'owlcoda-public-out-'))
    try {
      const competitorName = ['Claude', 'Code'].join(' ')
      const legacyName = `Owl${'CC'}`
      const legacyLower = legacyName.toLowerCase()
      const legacyDir = `.${legacyLower}/`
      write(sourceRoot, 'package.json', '{"name":"owlcoda","version":"0.15.0","license":"GPL-3.0-or-later"}\n')
      write(sourceRoot, 'SOURCE.md', 'source tag v0.15.0\n')
      write(sourceRoot, 'src/example.ts', `// ${competitorName} comparison and /Users/realuser/private\nexport const x = 1\n`)
      write(sourceRoot, 'skills/demo/SKILL.md', '# demo skill\n')
      write(sourceRoot, 'CHANGELOG.md', `# Changelog\n\n## [0.15.0] — 2026-06-04\n\nGPL.\n\n${legacyName} private note\n`)
      write(sourceRoot, 'NOTICE.md', `# NOTICE\n\n## Third-Party Source Attributions\n\nok\n\n## Repository History\n\nold ${legacyLower} name\n`)
      write(sourceRoot, '.gitignore', `dist/\n${legacyDir}\n.tmp/\n`)
      write(sourceRoot, 'internal/secret.md', '/Users/realuser/private\n')

      const report = buildPublicMirrorTree({
        sourceRoot,
        outDir,
        candidateFiles: [
          'package.json',
          'SOURCE.md',
          'src/example.ts',
          'skills/demo/SKILL.md',
          'CHANGELOG.md',
          'NOTICE.md',
          '.gitignore',
          'internal/secret.md',
        ],
      })

      expect(report.violations).toEqual([])
      expect(report.included).toContain('skills/demo/SKILL.md')
      expect(report.excluded).toContain('internal/secret.md')
      expect(existsSync(join(outDir, 'internal/secret.md'))).toBe(false)
      expect(readFileSync(join(outDir, 'src/example.ts'), 'utf8')).not.toMatch(new RegExp(`${competitorName}|yeemio`))
      expect(readFileSync(join(outDir, 'NOTICE.md'), 'utf8')).not.toContain('Repository History')
      expect(readFileSync(join(outDir, '.gitignore'), 'utf8')).not.toContain(legacyDir)
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true })
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})
