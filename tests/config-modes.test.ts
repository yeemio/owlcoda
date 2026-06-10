import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { validateConfig } from '../src/config-validate.js'

describe('operating mode config', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads a persistent default mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owlcoda-mode-config-'))
    dirs.push(dir)
    const configPath = join(dir, 'config.json')
    writeFileSync(configPath, JSON.stringify({
      port: 8123,
      routerUrl: 'http://127.0.0.1:8009',
      mode: 'plan',
    }))

    expect(loadConfig(configPath).mode).toBe('plan')
  })

  it('validates allowed mode values', () => {
    expect(validateConfig({ port: 1, routerUrl: 'x', mode: 'auto' }).valid).toBe(true)
    const result = validateConfig({ port: 1, routerUrl: 'x', mode: 'yolo' })
    expect(result.valid).toBe(false)
    expect(result.errors.join('\n')).toContain('mode must be one of')
  })
})
