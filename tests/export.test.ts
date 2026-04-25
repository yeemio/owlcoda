import { describe, it, expect } from 'vitest'
import { formatExport, type ExportResult, type ExportedConfig } from '../src/export.js'

describe('export', () => {
  const sampleResult: ExportResult = {
    config: {
      version: '1.0',
      routerUrl: 'http://localhost:8009',
      host: '127.0.0.1',
      port: 8019,
      models: [
        { id: 'qwen2.5-32b', tier: 'balanced', aliases: ['default'] },
        { id: 'llama-3.1-70b', tier: 'heavy', aliases: [] },
      ],
    },
    envVars: {
      OWLCODA_BASE_URL: 'http://127.0.0.1:8019',
      OWLCODA_ROUTER_URL: 'http://localhost:8009',
      OWLCODA_DEFAULT_BALANCED_MODEL: 'qwen2.5-32b',
      OWLCODA_DEFAULT_HEAVY_MODEL: 'llama-3.1-70b',
    },
    warnings: ['API key for qwen2.5-32b stripped from export'],
  }

  it('formats as text with warnings', () => {
    const out = formatExport(sampleResult, 'text')
    expect(out).toContain('Configuration Export')
    expect(out).toContain('Warnings')
    expect(out).toContain('stripped from export')
    expect(out).toContain('qwen2.5-32b')
    expect(out).toContain('OWLCODA_BASE_URL')
  })

  it('formats as JSON', () => {
    const out = formatExport(sampleResult, 'json')
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed).toHaveProperty('config')
    expect(parsed).toHaveProperty('envVars')
    const config = parsed.config as ExportedConfig
    expect(config.models).toHaveLength(2)
  })

  it('formats as env', () => {
    const out = formatExport(sampleResult, 'env')
    expect(out).toContain('OWLCODA_BASE_URL=http://127.0.0.1:8019')
    expect(out).toContain('OWLCODA_ROUTER_URL=http://localhost:8009')
    expect(out).toContain('OWLCODA_DEFAULT_BALANCED_MODEL=qwen2.5-32b')
  })

  it('handles no warnings', () => {
    const clean = { ...sampleResult, warnings: [] }
    const out = formatExport(clean, 'text')
    expect(out).not.toContain('Warnings')
  })

  it('export command is wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'export'])
    expect(result.command).toBe('export')
  })
})
