import { describe, it, expect } from 'vitest'
import { getConfigDisplay, formatConfigDisplay, type ConfigDisplay } from '../src/config-display.js'

describe('config-display module', () => {
  it('getConfigDisplay returns expected structure', () => {
    const display = getConfigDisplay()
    expect(display).toHaveProperty('configPath')
    expect(display).toHaveProperty('configExists')
    expect(display).toHaveProperty('version')
    expect(display).toHaveProperty('listen')
    expect(display).toHaveProperty('routerUrl')
    expect(display).toHaveProperty('models')
    expect(display).toHaveProperty('launchMode')
    expect(display).toHaveProperty('skillInjection')
    expect(typeof display.configPath).toBe('string')
    expect(typeof display.version).toBe('string')
    expect(Array.isArray(display.models)).toBe(true)
  })

  it('launchMode reflects native-first with available options', () => {
    const display = getConfigDisplay()
    expect(display.launchMode).toMatch(/^native/)
  })

  it('version is non-empty', () => {
    const display = getConfigDisplay()
    expect(display.version.length).toBeGreaterThan(0)
  })

  it('formatConfigDisplay produces readable output', () => {
    const display: ConfigDisplay = {
      configPath: '/tmp/config.json',
      configExists: true,
      version: '1.0.3',
      listen: '127.0.0.1:8019',
      routerUrl: 'http://127.0.0.1:8009',
      models: [
        { id: 'gpt-4', label: 'GPT-4', backendModel: 'gpt-4', tier: 'balanced', isDefault: true, aliases: ['default'] },
        { id: 'gpt-3.5', label: 'GPT-3.5', backendModel: 'gpt-3.5-turbo', tier: 'fast', isDefault: false, aliases: ['fast'] },
      ],
      launchMode: 'native',
      skillInjection: true,
      nativeToolCount: 42,
      sessionCount: 3,
    }
    const output = formatConfigDisplay(display)
    expect(output).toContain('owlcoda config')
    expect(output).toContain('127.0.0.1:8019')
    expect(output).toContain('http://127.0.0.1:8009')
    expect(output).toContain('native')
    expect(output).toContain('gpt-4')
    expect(output).toContain('gpt-3.5')
    expect(output).toContain('Models (2)')
    expect(output).toContain('▸') // default marker
    expect(output).toContain('Skill inject: on')
    expect(output).toContain('Tools:     42+ native tools')
  })

  it('formatConfigDisplay handles no models', () => {
    const display: ConfigDisplay = {
      configPath: '/tmp/config.json',
      configExists: false,
      version: '1.0.3',
      listen: '127.0.0.1:8019',
      routerUrl: 'http://127.0.0.1:8009',
      models: [],
      launchMode: 'native',
      skillInjection: false,
      nativeToolCount: 42,
      sessionCount: 0,
    }
    const output = formatConfigDisplay(display)
    expect(output).toContain('not found')
    expect(output).toContain('none configured')
    expect(output).toContain('Skill inject: off')
  })

  it('config command is wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'config'])
    expect(result.command).toBe('config')
  })
})
