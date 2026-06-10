import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ADMIN_DISPLAY_VERSION } from '../src/lib/version'

const here = dirname(fileURLToPath(import.meta.url))

describe('ADMIN_DISPLAY_VERSION', () => {
  it('matches root package.json#version — admin header must not lie about the shipped product version', () => {
    const pkgRaw = readFileSync(join(here, '..', '..', 'package.json'), 'utf-8')
    const pkg = JSON.parse(pkgRaw) as { name?: string, version?: string }
    expect(pkg.name).toBe('owlcoda')
    expect(typeof pkg.version).toBe('string')
    expect(ADMIN_DISPLAY_VERSION).toBe(pkg.version)
  })
})
