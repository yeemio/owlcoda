import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

interface PackageJson {
  scripts?: Record<string, string>
}

function readPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as PackageJson
  return pkg.scripts ?? {}
}

describe('release npm scripts', () => {
  it('runs the full release gate before npm publish', () => {
    const scripts = readPackageScripts()

    expect(scripts['release:prepublish-gate']).toBeDefined()
    expect(scripts['prepublishOnly']).toBe('npm run release:prepublish-gate')
  })

  it('keeps release smoke, package audit, and install smoke as explicit sub-gates', () => {
    const scripts = readPackageScripts()

    expect(scripts['release:install-smoke']).toBeDefined()
    expect(scripts['release:readiness']).toBeDefined()
    expect(scripts['release:surface-readiness']).toBeDefined()
    expect(scripts['release:prepublish-gate']).toContain('release:smoke')
    expect(scripts['release:prepublish-gate']).toContain('release:package-audit')
    expect(scripts['release:prepublish-gate']).toContain('release:install-smoke')
  })
})
