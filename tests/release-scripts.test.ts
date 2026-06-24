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

function readProjectFile(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
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

  it('forces nested npm pack to write a tarball during npm publish dry-run', () => {
    const scripts = readPackageScripts()
    const prepublishGate = scripts['release:prepublish-gate'] ?? ''

    expect(prepublishGate).toMatch(/(?:npm_config_dry_run=false|env -u npm_config_dry_run) npm pack/)
  })

  it('forces release install smoke to install the tarball during npm publish dry-run', () => {
    const installSmoke = readProjectFile('scripts/release-install-smoke.ts')

    expect(installSmoke).toContain("npm_config_dry_run: 'false'")
  })
})
