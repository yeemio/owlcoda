import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ModelsDisplay } from '../src/models-display.js'

// We test formatModelsDisplay directly (no config/router dependency)
describe('models display', () => {
  let formatModelsDisplay: (display: ModelsDisplay) => string

  beforeEach(async () => {
    const mod = await import('../src/models-display.js')
    formatModelsDisplay = mod.formatModelsDisplay
  })

  it('formats models grouped by tier', () => {
    const display: ModelsDisplay = {
      models: [
        { id: 'llama-3.1-70b', tier: 'heavy' },
        { id: 'qwen2.5-32b', tier: 'balanced' },
        { id: 'llama-3.1-8b', tier: 'fast' },
      ],
      routerUrl: 'http://localhost:8009',
      routerReachable: false,
      routerModels: [],
    }

    const out = formatModelsDisplay(display)
    expect(out).toContain('HEAVY')
    expect(out).toContain('llama-3.1-70b')
    expect(out).toContain('BALANCED')
    expect(out).toContain('qwen2.5-32b')
    expect(out).toContain('FAST')
    expect(out).toContain('llama-3.1-8b')
    expect(out.indexOf('HEAVY')).toBeLessThan(out.indexOf('FAST'))
  })

  it('shows alias and backend', () => {
    const display: ModelsDisplay = {
      models: [
        { id: 'gpt-4', tier: 'balanced', alias: 'default', backend: 'openai' },
      ],
      routerUrl: 'http://localhost:8009',
      routerReachable: false,
      routerModels: [],
    }
    const out = formatModelsDisplay(display)
    expect(out).toContain('alias: default')
    expect(out).toContain('[openai]')
  })

  it('shows router models when reachable', () => {
    const display: ModelsDisplay = {
      models: [
        { id: 'qwen2.5-32b', tier: 'balanced' },
      ],
      routerUrl: 'http://localhost:8009',
      routerReachable: true,
      routerModels: ['qwen2.5-32b', 'llama-3.1-8b'],
    }
    const out = formatModelsDisplay(display)
    expect(out).toContain('2 model(s)')
    expect(out).toContain('✓ qwen2.5-32b')
    expect(out).toContain('  llama-3.1-8b') // not configured, no check
  })

  it('shows unreachable router warning', () => {
    const display: ModelsDisplay = {
      models: [],
      routerUrl: 'http://localhost:8009',
      routerReachable: false,
      routerModels: [],
    }
    const out = formatModelsDisplay(display)
    expect(out).toContain('Local runtime unreachable')
    expect(out).toContain('(none configured)')
  })

  it('models command is wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'models'])
    expect(result.command).toBe('models')
  })

  it('completions include models command', async () => {
    const { generateBashCompletion, generateFishCompletion } = await import('../src/completions.js')
    expect(generateBashCompletion()).toContain('models')
    expect(generateFishCompletion()).toContain('models')
  })
})
