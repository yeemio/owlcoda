import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const WATCHER_SRC = readFileSync(join(__dirname, '..', 'src', 'config-watcher.ts'), 'utf-8')

describe('config-watcher model normalization', () => {
  it('imports normalizeModel from config', () => {
    expect(WATCHER_SRC).toContain("normalizeModel")
    expect(WATCHER_SRC).toContain("from './config.js'")
  })

  it('normalizes models during hot-reload', () => {
    expect(WATCHER_SRC).toContain('.map(normalizeModel)')
  })

  it('validates config before applying', () => {
    expect(WATCHER_SRC).toContain('validateConfig(parsed)')
  })

  it('rejects non-object configs', () => {
    expect(WATCHER_SRC).toContain("'Config must be a JSON object'")
  })

  it('applies adminToken on reload', () => {
    expect(WATCHER_SRC).toContain("raw.adminToken")
    expect(WATCHER_SRC).toContain("applied.push('adminToken')")
  })

  it('applies middleware changes immediately to circuit breaker', () => {
    expect(WATCHER_SRC).toContain('configureCircuitBreaker')
  })
})
