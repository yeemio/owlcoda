import { describe, it, expect } from 'vitest'
import { resolveModel, resolveConfiguredModel } from '../src/config.js'
import type { OwlCodaConfig, ConfiguredModel } from '../src/config.js'

function makeConfig(models: ConfiguredModel[]): OwlCodaConfig {
  return {
    port: 8019, host: '127.0.0.1', routerUrl: 'http://127.0.0.1:8009',
    routerTimeoutMs: 600000, logLevel: 'info' as const,
    models,
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {}, defaultModel: '', reverseMapInResponse: true,
  }
}

const testModels: ConfiguredModel[] = [
  { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy' },
  { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['default', 'distilled'], tier: 'production', default: true },
  { id: 'Qwen3.5-35B-A3B-4bit', label: 'Qwen 35B MoE', backendModel: 'Qwen3.5-35B-A3B-4bit', aliases: ['qwen35', 'fast'], tier: 'production' },
]

describe('resolveModel with registry', () => {
  it('exact match by alias', () => {
    const cfg = makeConfig(testModels)
    expect(resolveModel(cfg, 'default')).toBe('qwen2.5-coder:32b')
  })

  it('falls back to default for unknown model', () => {
    const cfg = makeConfig(testModels)
    expect(resolveModel(cfg, 'totally-unknown-99')).toBe('qwen2.5-coder:32b')
  })

  it('passes through exact platform model IDs', () => {
    const cfg = makeConfig(testModels)
    expect(resolveModel(cfg, 'gpt-oss-120b-MXFP4-Q4')).toBe('gpt-oss-120b-MXFP4-Q4')
  })

  it('resolves partial match by substring', () => {
    const cfg = makeConfig(testModels)
    expect(resolveModel(cfg, 'distilled')).toBe('qwen2.5-coder:32b')
  })
})
