import { describe, test, expect } from 'vitest'
import { isPublicPath } from '../src/public-mirror/manifest.js'

describe('isPublicPath — default-deny allowlist for the public source tree', () => {
  test('allows the source / admin / tests / branding / examples subtrees', () => {
    expect(isPublicPath('src/cli.ts')).toBe(true)
    expect(isPublicPath('admin/server/index.ts')).toBe(true)
    expect(isPublicPath('tests/foo.test.ts')).toBe(true)
    expect(isPublicPath('assets/branding/owlcoda-logo.svg')).toBe(true)
    expect(isPublicPath('examples/plugins/demo/x.ts')).toBe(true)
  })

  test('allows the curated root files', () => {
    for (const f of [
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
    ]) {
      expect(isPublicPath(f)).toBe(true)
    }
  })

  test('allows the build/test config needed for a self-contained public tree', () => {
    expect(isPublicPath('tsconfig.json')).toBe(true)
    expect(isPublicPath('vitest.config.ts')).toBe(true)
    expect(isPublicPath('.gitignore')).toBe(true)
  })

  test('allows only selected scripts + the mirror tooling subtree', () => {
    expect(isPublicPath('scripts/postbuild.mjs')).toBe(true)
    expect(isPublicPath('scripts/public-mirror/build.ts')).toBe(true)
    expect(isPublicPath('scripts/swebench-lite-run.ts')).toBe(true)
    // Imported by published tests (ink-write-boundary.test.ts,
    // fitness-tier1-fault-injection.test.ts) — tests/ ships wholesale, so its
    // script dependencies must ship too or the public tree's suite breaks.
    expect(isPublicPath('scripts/ink-write-boundary.mjs')).toBe(true)
    // Referenced as Tier-1 fitness-matrix currentEvidence (existence asserted
    // by fitness-tier1-fault-injection.test.ts in the published suite).
    expect(isPublicPath('scripts/check-imported-untracked.mjs')).toBe(true)
    expect(isPublicPath('scripts/eval-packet.ts')).toBe(false)
  })

  test('denies private / internal trees by default', () => {
    expect(isPublicPath('internal/notes.md')).toBe(false)
    expect(isPublicPath('docs/PUBLIC-RELEASE-MAP.md')).toBe(false)
    expect(isPublicPath('docs/RELEASE-CHECKLIST.md')).toBe(false)
    expect(isPublicPath('node_modules/react/index.js')).toBe(false)
    expect(isPublicPath('dist/cli.js')).toBe(false)
    expect(isPublicPath('config.json')).toBe(false)
    expect(isPublicPath('.git/config')).toBe(false)
  })

  test('allows bundled skills because npm package files ships skills/', () => {
    expect(isPublicPath('skills/cloudflare-deploy/SKILL.md')).toBe(true)
    expect(isPublicPath('skills/screenshot/LICENSE.txt')).toBe(true)
  })

  test('denies ALL of docs/ — v0.15.0 source-open boundary publishes no docs', () => {
    // Release decision 2026-06-09: the public source tree carries zero docs/
    // files. docs/TOOLS.md was the last allowlisted doc; it goes too. Any
    // future docs/** addition must be an explicit, reviewed allowlist change.
    expect(isPublicPath('docs/TOOLS.md')).toBe(false)
    expect(isPublicPath('docs/architecture/system-architecture.md')).toBe(false)
    expect(isPublicPath('docs/PUBLIC-RELEASE-MAP.md')).toBe(false)
    expect(isPublicPath('docs/handoff/anything.md')).toBe(false)
    expect(isPublicPath('docs/execution-prompts/anything.md')).toBe(false)
    expect(isPublicPath('docs/dd/anything.md')).toBe(false)
    expect(isPublicPath('docs/README.md')).toBe(false)
  })

  test('denies admin build artifacts even though admin/ is allowed', () => {
    expect(isPublicPath('admin/node_modules/x/index.js')).toBe(false)
    expect(isPublicPath('admin/dist/bundle.js')).toBe(false)
  })

  test('normalizes a leading ./ or /', () => {
    expect(isPublicPath('./src/cli.ts')).toBe(true)
    expect(isPublicPath('/src/cli.ts')).toBe(true)
  })
})
