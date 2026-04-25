import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import {
  loadConfig,
  resolveModel,
  reverseModel,
  resolveConfiguredModel,
  responseModelName,
  listConfiguredModels,
  getDefaultConfiguredModel,
  overlayAvailability,
} from '../src/config.js'
import type { OwlCodaConfig, ConfiguredModel } from '../src/config.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = join(import.meta.dirname, '_fixtures')

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env['OWLCODA_PORT']
  delete process.env['OWLCODA_ROUTER_URL']
  delete process.env['OWLCODA_LOG_LEVEL']
  delete process.env['OWLCODA_CATALOG_PATH']
  delete process.env['KIMI_API_KEY']
})

describe('loadConfig', () => {
  it('returns defaults when no file and no catalog', () => {
    // Set catalog path to a non-existent location to prevent catalog loading
    process.env['OWLCODA_CATALOG_PATH'] = join(TEST_DIR, 'no-catalog.json')
    // Redirect home config to prevent loading user's real config
    process.env['OWLCODA_HOME'] = TEST_DIR
    const original = process.cwd()
    process.chdir(TEST_DIR)
    try {
      const cfg = loadConfig()
      expect(cfg.port).toBe(8019)
      expect(cfg.host).toBe('127.0.0.1')
      expect(cfg.routerUrl).toBe('http://127.0.0.1:8009')
      expect(cfg.routerTimeoutMs).toBe(600_000)
      expect(cfg.logLevel).toBe('info')
      expect(cfg.models).toEqual([])
      expect(cfg.responseModelStyle).toBe('platform')
    } finally {
      process.chdir(original)
      delete process.env['OWLCODA_HOME']
    }
  })

  it('loads new registry format from explicit file', () => {
    const configFile = join(TEST_DIR, 'test-config.json')
    writeFileSync(configFile, JSON.stringify({
      port: 9999,
      host: '0.0.0.0',
      models: [
        { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy', default: true }
      ],
    }))

    const cfg = loadConfig(configFile)
    expect(cfg.port).toBe(9999)
    expect(cfg.host).toBe('0.0.0.0')
    expect(cfg.models).toHaveLength(1)
    expect(cfg.models[0].id).toBe('gpt-oss-120b-MXFP4-Q4')
    expect(cfg.models[0].backendModel).toBe('gpt-oss-120b-MXFP4-Q4')
    // Backward compat modelMap built from models
    expect(cfg.modelMap['gpt-oss-120b-MXFP4-Q4']).toBe('gpt-oss-120b-MXFP4-Q4')
    expect(cfg.modelMap['heavy']).toBe('gpt-oss-120b-MXFP4-Q4')
  })

  it('loads direct endpoint models with apiKeyEnv and custom headers', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-from-env'
    const configFile = join(TEST_DIR, 'kimi-config.json')
    writeFileSync(configFile, JSON.stringify({
      models: [
        {
          id: 'kimi-code',
          label: 'Kimi Code',
          backendModel: 'kimi-k2',
          endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
          apiKeyEnv: 'KIMI_API_KEY',
          headers: {
            'User-Agent': 'KimiCLI/1.33.0',
            'X-Msh-Platform': 'kimi_cli',
          },
          aliases: ['kimi'],
          tier: 'production',
          default: true,
        },
      ],
    }))

    const cfg = loadConfig(configFile)
    expect(cfg.models).toHaveLength(1)
    expect(cfg.models[0].apiKeyEnv).toBe('KIMI_API_KEY')
    expect(cfg.models[0].apiKey).toBe('sk-kimi-from-env')
    expect(cfg.models[0].headers).toEqual({
      'User-Agent': 'KimiCLI/1.33.0',
      'X-Msh-Platform': 'kimi_cli',
    })
  })

  it('auto-appends built-in Kimi model when KIMI_API_KEY is set', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-auto'
    process.env['OWLCODA_CATALOG_PATH'] = join(TEST_DIR, 'no-catalog.json')
    process.env['OWLCODA_HOME'] = TEST_DIR
    const original = process.cwd()
    process.chdir(TEST_DIR)
    try {
      const cfg = loadConfig()
      const kimi = cfg.models.find(m => m.id === 'kimi-code')
      expect(kimi).toBeDefined()
      expect(kimi?.label).toBe('Kimi Code')
      expect(kimi?.endpoint).toBe('https://api.kimi.com/coding')
      expect(kimi?.apiKey).toBe('sk-kimi-auto')
      expect(kimi?.aliases).toContain('kimi')
      expect(kimi?.contextWindow).toBe(256000)
      // X-Msh-Platform intentionally omitted by default since 0.12.21
      // (see src/config.ts comment block) — opting in via OWLCODA_KIMI_PLATFORM.
      expect(kimi?.headers).toEqual({
        'User-Agent': 'KimiCLI/1.33.0',
      })
      expect(cfg.modelMap['kimi']).toBe(kimi?.backendModel)
    } finally {
      process.chdir(original)
      delete process.env['OWLCODA_HOME']
    }
  })

  it('does not duplicate built-in Kimi when user config already defines it', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-auto'
    const configFile = join(TEST_DIR, 'user-kimi-config.json')
    writeFileSync(configFile, JSON.stringify({
      models: [
        {
          id: 'kimi-code',
          label: 'My Kimi',
          backendModel: 'kimi-custom',
          endpoint: 'https://api.kimi.com/coding/v1/chat/completions',
          aliases: ['kimi'],
          tier: 'production',
          default: true,
        },
      ],
    }))

    const cfg = loadConfig(configFile)
    const kimiModels = cfg.models.filter(m => m.id === 'kimi-code')
    expect(kimiModels).toHaveLength(1)
    expect(kimiModels[0].label).toBe('My Kimi')
    expect(kimiModels[0].backendModel).toBe('kimi-custom')
  })

  it('does not leak modelMap state across repeated loadConfig calls', () => {
    process.env['KIMI_API_KEY'] = 'sk-kimi-auto'
    const firstConfig = join(TEST_DIR, 'first-config.json')
    writeFileSync(firstConfig, JSON.stringify({
      models: [
        { id: 'first-model', label: 'First', backendModel: 'first-backend', aliases: ['first'], tier: 'general', default: true },
      ],
    }))

    const first = loadConfig(firstConfig)
    expect(first.modelMap['first']).toBe('first-backend')

    process.env['OWLCODA_CATALOG_PATH'] = join(TEST_DIR, 'no-catalog.json')
    process.env['OWLCODA_HOME'] = TEST_DIR
    const original = process.cwd()
    process.chdir(TEST_DIR)
    try {
      const second = loadConfig()
      expect(second.modelMap['first']).toBeUndefined()
      expect(second.modelMap['kimi']).toBe('kimi-for-coding')
    } finally {
      process.chdir(original)
      delete process.env['OWLCODA_HOME']
    }
  })

  it('migrates legacy modelMap to models array', () => {
    const configFile = join(TEST_DIR, 'legacy-config.json')
    writeFileSync(configFile, JSON.stringify({
      modelMap: {
        heavy: 'gpt-oss-120b',
        default: 'distilled-27b',
      },
      defaultModel: 'distilled-27b',
    }))

    const cfg = loadConfig(configFile)
    expect(cfg.models.length).toBeGreaterThan(0)
    // Check that models were created from modelMap
    const heavyModel = cfg.models.find(m => m.aliases.includes('heavy'))
    expect(heavyModel).toBeDefined()
    expect(heavyModel!.backendModel).toBe('gpt-oss-120b')
  })

  it('overrides with OWLCODA_PORT env var', () => {
    const configFile = join(TEST_DIR, 'env-config.json')
    writeFileSync(configFile, JSON.stringify({ port: 1234 }))

    process.env['OWLCODA_PORT'] = '5555'
    const cfg = loadConfig(configFile)
    expect(cfg.port).toBe(5555)
  })

  it('overrides with OWLCODA_ROUTER_URL env var', () => {
    process.env['OWLCODA_ROUTER_URL'] = 'http://other:9000'
    process.env['OWLCODA_CATALOG_PATH'] = join(TEST_DIR, 'no-catalog.json')
    const original = process.cwd()
    process.chdir(TEST_DIR)
    try {
      const cfg = loadConfig()
      expect(cfg.routerUrl).toBe('http://other:9000')
    } finally {
      process.chdir(original)
    }
  })

  it('overrides with OWLCODA_LOG_LEVEL env var', () => {
    process.env['OWLCODA_LOG_LEVEL'] = 'debug'
    process.env['OWLCODA_CATALOG_PATH'] = join(TEST_DIR, 'no-catalog.json')
    const original = process.cwd()
    process.chdir(TEST_DIR)
    try {
      const cfg = loadConfig()
      expect(cfg.logLevel).toBe('debug')
    } finally {
      process.chdir(original)
    }
  })

  it('throws on explicit missing config file', () => {
    expect(() => loadConfig(join(TEST_DIR, 'nope.json'))).toThrow('Config file not found or invalid')
  })

  it('accepts legacy owlcoda responseModelStyle as platform', () => {
    const configFile = join(TEST_DIR, 'legacy-style.json')
    writeFileSync(configFile, JSON.stringify({ responseModelStyle: 'owlcoda' }))
    const cfg = loadConfig(configFile)
    expect(cfg.responseModelStyle).toBe('platform')
  })
})

function makeRegistryConfig(models: ConfiguredModel[], overrides?: Partial<OwlCodaConfig>): OwlCodaConfig {
  return {
    port: 8019, host: '127.0.0.1', routerUrl: 'http://127.0.0.1:8009',
    routerTimeoutMs: 600000, logLevel: 'info' as const,
    models,
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {}, defaultModel: '', reverseMapInResponse: true,
    ...overrides,
  }
}

describe('resolveConfiguredModel', () => {
  const models: ConfiguredModel[] = [
    { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy' },
    { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['default', 'distilled'], tier: 'production', default: true },
  ]

  it('matches by platform ID', () => {
    const cfg = makeRegistryConfig(models)
    const result = resolveConfiguredModel(cfg, 'gpt-oss-120b-MXFP4-Q4')
    expect(result.id).toBe('gpt-oss-120b-MXFP4-Q4')
    expect(result.backendModel).toBe('gpt-oss-120b-MXFP4-Q4')
  })

  it('matches by alias', () => {
    const cfg = makeRegistryConfig(models)
    const result = resolveConfiguredModel(cfg, 'default')
    expect(result.id).toBe('qwen2.5-coder:32b')
  })

  it('matches neutral alias', () => {
    const cfg = makeRegistryConfig(models)
    const result = resolveConfiguredModel(cfg, 'heavy')
    expect(result.id).toBe('gpt-oss-120b-MXFP4-Q4')
  })

  it('matches by partial name (substring)', () => {
    const cfg = makeRegistryConfig(models)
    const result = resolveConfiguredModel(cfg, 'distilled')
    expect(result.id).toBe('qwen2.5-coder:32b')
  })

  it('falls back to default for unknown model', () => {
    const cfg = makeRegistryConfig(models)
    const result = resolveConfiguredModel(cfg, 'unknown-model')
    expect(result.id).toBe('qwen2.5-coder:32b') // default
  })
})

describe('responseModelName', () => {
  const models: ConfiguredModel[] = [
    { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy', default: true },
  ]

  it('returns platform ID when style is platform', () => {
    const cfg = makeRegistryConfig(models, { responseModelStyle: 'platform' })
    expect(responseModelName(cfg, 'heavy')).toBe('gpt-oss-120b-MXFP4-Q4')
  })

  it('returns requested name when style is requested', () => {
    const cfg = makeRegistryConfig(models, { responseModelStyle: 'requested' })
    expect(responseModelName(cfg, 'heavy')).toBe('heavy')
  })
})

describe('listConfiguredModels', () => {
  it('returns all models from registry', () => {
    const models: ConfiguredModel[] = [
      { id: 'model-a', label: 'A', backendModel: 'a', aliases: [], tier: 'heavy' },
      { id: 'model-b', label: 'B', backendModel: 'b', aliases: [], tier: 'fast' },
    ]
    const cfg = makeRegistryConfig(models)
    expect(listConfiguredModels(cfg)).toHaveLength(2)
  })
})

describe('getDefaultConfiguredModel', () => {
  it('returns model marked as default', () => {
    const models: ConfiguredModel[] = [
      { id: 'model-a', label: 'A', backendModel: 'a', aliases: [], tier: 'heavy' },
      { id: 'model-b', label: 'B', backendModel: 'b', aliases: [], tier: 'fast', default: true },
    ]
    const cfg = makeRegistryConfig(models)
    const def = getDefaultConfiguredModel(cfg)
    expect(def?.id).toBe('model-b')
  })

  it('returns first model when none marked default', () => {
    const models: ConfiguredModel[] = [
      { id: 'model-a', label: 'A', backendModel: 'a', aliases: [], tier: 'heavy' },
    ]
    const cfg = makeRegistryConfig(models)
    const def = getDefaultConfiguredModel(cfg)
    expect(def?.id).toBe('model-a')
  })

  it('returns null when no models', () => {
    const cfg = makeRegistryConfig([])
    expect(getDefaultConfiguredModel(cfg)).toBeNull()
  })
})

describe('resolveModel (legacy compat)', () => {
  it('resolves via registry when models present', () => {
    const models: ConfiguredModel[] = [
      { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy', default: true },
    ]
    const cfg = makeRegistryConfig(models)
    expect(resolveModel(cfg, 'heavy')).toBe('gpt-oss-120b-MXFP4-Q4')
  })
})

describe('reverseModel (legacy compat)', () => {
  it('returns platform ID when models present', () => {
    const models: ConfiguredModel[] = [
      { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy', default: true },
    ]
    const cfg = makeRegistryConfig(models)
    expect(reverseModel(cfg, 'heavy')).toBe('gpt-oss-120b-MXFP4-Q4')
  })
})

describe('overlayAvailability', () => {
  function makeConfig(): OwlCodaConfig {
    return makeRegistryConfig([
      { id: 'model-a', label: 'A', backendModel: 'model-a', aliases: [], tier: 'production', default: true },
      { id: 'model-b', label: 'B', backendModel: 'model-b', aliases: [], tier: 'heavy' },
      { id: 'model-c', label: 'C', backendModel: 'alias-c', aliases: [], tier: 'lab' },
    ])
  }

  it('marks models as available when found in router set', () => {
    const cfg = makeConfig()
    overlayAvailability(cfg, new Set(['model-a', 'alias-c']))
    expect(cfg.models[0]!.availability).toBe('available')
    expect(cfg.models[1]!.availability).toBe('unavailable')
    expect(cfg.models[2]!.availability).toBe('available')
  })

  it('marks all unknown when router set is empty', () => {
    const cfg = makeConfig()
    overlayAvailability(cfg, new Set())
    for (const m of cfg.models) {
      expect(m.availability).toBe('unknown')
    }
  })

  it('matches on both id and backendModel', () => {
    const cfg = makeConfig()
    overlayAvailability(cfg, new Set(['model-b']))
    expect(cfg.models[1]!.availability).toBe('available')
  })

  it('matches exact alias in router set', () => {
    const cfg = makeRegistryConfig([
      { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['distilled', 'default'], tier: 'production', default: true },
      { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['heavy'], tier: 'heavy' },
    ])
    overlayAvailability(cfg, new Set(['distilled', 'gpt-oss-120b-MXFP4-Q4']))
    expect(cfg.models[0]!.availability).toBe('available')
    expect(cfg.models[1]!.availability).toBe('available')
  })

  it('matches router alias with prefix-dash rule (distilled-27b → alias distilled)', () => {
    const cfg = makeRegistryConfig([
      { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['distilled', 'default'], tier: 'production', default: true },
      { id: 'Nemotron-Cascade-2-30B-A3B-4bit', label: 'Nemotron Cascade', backendModel: 'Nemotron-Cascade-2-30B-A3B-4bit', aliases: ['nemotron'], tier: 'production' },
    ])
    // Router reports suffixed aliases, not the exact catalog aliases
    overlayAvailability(cfg, new Set(['distilled-27b', 'nemotron-cascade']))
    expect(cfg.models[0]!.availability).toBe('available')
    expect(cfg.models[1]!.availability).toBe('available')
  })

  it('marks unavailable when no match via any rule', () => {
    const cfg = makeRegistryConfig([
      { id: 'Qwen3.5-122B-A10B-4bit', label: 'Qwen 122B', backendModel: 'Qwen3.5-122B-A10B-4bit', aliases: ['qwen122'], tier: 'candidate' },
    ])
    overlayAvailability(cfg, new Set(['distilled-27b', 'gpt-oss-120b-MXFP4-Q4']))
    expect(cfg.models[0]!.availability).toBe('unavailable')
  })

  it('handles real live router model set with mixed aliases and platform IDs', () => {
    const cfg = makeRegistryConfig([
      { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', backendModel: 'qwen2.5-coder:32b', aliases: ['distilled', 'default'], tier: 'production', default: true },
      { id: 'Qwen3.5-35B-A3B-4bit', label: 'Qwen 35B', backendModel: 'Qwen3.5-35B-A3B-4bit', aliases: ['qwen35'], tier: 'production' },
      { id: 'gpt-oss-120b-MXFP4-Q4', label: 'GPT-OSS 120B', backendModel: 'gpt-oss-120b-MXFP4-Q4', aliases: ['oss120', 'heavy'], tier: 'heavy' },
      { id: 'Qwen3.5-122B-A10B-4bit', label: 'Qwen 122B', backendModel: 'Qwen3.5-122B-A10B-4bit', aliases: ['qwen122'], tier: 'candidate' },
    ])
    // Simulated live router: distilled-27b (alias), Qwen3.5-35B-A3B-4bit (direct ID), gpt-oss-120b-MXFP4-Q4 (direct ID)
    overlayAvailability(cfg, new Set(['distilled-27b', 'Qwen3.5-35B-A3B-4bit', 'gpt-oss-120b-MXFP4-Q4']))
    expect(cfg.models[0]!.availability).toBe('available')   // via prefix match distilled-
    expect(cfg.models[1]!.availability).toBe('available')   // via direct id
    expect(cfg.models[2]!.availability).toBe('available')   // via direct id
    expect(cfg.models[3]!.availability).toBe('unavailable') // not in router
  })
})
