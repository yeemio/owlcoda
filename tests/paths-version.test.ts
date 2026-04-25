/**
 * Paths + version utility tests.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  getOwlcodaDir,
  getOwlcodaConfigPath,
  getOwlcodaPidPath,
  getOwlcodaRuntimeMetaPath,
  getOwlcodaRuntimeProfileDir,
} from '../src/paths.js'
import { VERSION } from '../src/version.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('paths', () => {
  it('getOwlcodaDir resolves the OwlCoda config root', () => {
    vi.stubEnv('OWLCODA_HOME', '')
    delete process.env['OWLCODA_HOME']
    const result = getOwlcodaDir()
    expect(result.endsWith('/.owlcoda')).toBe(true)
  })

  it('getOwlcodaDir respects OWLCODA_HOME env', () => {
    vi.stubEnv('OWLCODA_HOME', '/custom/path')
    expect(getOwlcodaDir()).toBe('/custom/path')
  })

  it('getOwlcodaConfigPath is under owlcoda dir', () => {
    vi.stubEnv('OWLCODA_HOME', '/test')
    expect(getOwlcodaConfigPath()).toBe('/test/config.json')
  })

  it('getOwlcodaPidPath is under owlcoda dir', () => {
    vi.stubEnv('OWLCODA_HOME', '/test')
    expect(getOwlcodaPidPath()).toBe('/test/owlcoda.pid')
  })

  it('getOwlcodaRuntimeMetaPath is under owlcoda dir', () => {
    vi.stubEnv('OWLCODA_HOME', '/test')
    expect(getOwlcodaRuntimeMetaPath()).toBe('/test/runtime.json')
  })

  it('getOwlcodaRuntimeProfileDir is under owlcoda dir', () => {
    vi.stubEnv('OWLCODA_HOME', '/test')
    expect(getOwlcodaRuntimeProfileDir()).toBe('/test/runtime-profile')
  })
})

describe('VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof VERSION).toBe('string')
    expect(VERSION.length).toBeGreaterThan(0)
  })

  it('matches semver pattern', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('matches package.json version', async () => {
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'))
    expect(VERSION).toBe(pkg.version)
  })
})
