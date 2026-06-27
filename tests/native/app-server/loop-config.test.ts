import { describe, expect, it } from 'vitest'
import { resolveAppServerLoopConfig } from '../../../src/native/app-server/loop-config.js'
import type { OwlCodaConfig } from '../../../src/config.js'

describe('app-server loop config resolver', () => {
  it('resolves OwlCoda daemon loop options from the configured interactive model', () => {
    const config = testConfig({
      port: 8123,
      host: '127.0.0.1',
      models: [{
        id: 'desktop-model',
        label: 'Desktop Model',
        backendModel: 'backend-model',
        aliases: ['desktop'],
        provider: 'test',
        tier: 'local',
        contextWindow: 123456,
        default: true,
      } as any],
      middleware: {
        compactionModel: 'compact-model',
        compactionInputMaxTokens: 4567,
        requestTimeoutMs: 9876,
      },
    })

    const resolved = resolveAppServerLoopConfig(config)

    expect(resolved).toEqual({
      ok: true,
      model: 'desktop-model',
      loopOptions: {
        apiBaseUrl: 'http://127.0.0.1:8123',
        apiKey: 'owlcoda-local-key-8123',
        contextWindow: 123456,
        compactionModel: 'compact-model',
        compactionInputMaxTokens: 4567,
        requestTimeoutMs: 9876,
      },
    })
  })

  it('returns a structured missing result when no model is configured', () => {
    const resolved = resolveAppServerLoopConfig(testConfig({ models: [] }))

    expect(resolved).toEqual({
      ok: false,
      reason: 'no_interactive_model',
      message: 'No usable OwlCoda model is configured for App Server loop execution.',
    })
  })
})

function testConfig(overrides: Partial<OwlCodaConfig> = {}): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:8009',
    localRuntimeProtocol: 'auto',
    routerTimeoutMs: 600_000,
    models: [],
    responseModelStyle: 'platform',
    logLevel: 'info',
    catalogLoaded: false,
    middleware: {},
    skillInjection: true,
    trainingCollection: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    ...overrides,
  }
}
