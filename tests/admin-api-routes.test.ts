import * as http from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Readable } from 'node:stream'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type OwlCodaConfig, type ConfiguredModel } from '../src/config.js'
import { ModelTruthAggregator } from '../src/model-truth.js'
import { ModelConfigMutator } from '../src/model-config-mutator.js'
import {
  ADMIN_API_SCHEMA_VERSION,
  AdminAuthManager,
  handleAdminApiRequest,
} from '../src/admin-api.js'
import type { PlatformCatalog } from '../src/models/catalog.js'
import type { DryRunProviderPayload, ProviderProbeResult } from '../src/provider-probe.js'

type ProbeInput = DryRunProviderPayload | ConfiguredModel

interface MockResponse {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function writeConfig(homeDir: string, content: Record<string, unknown>): string {
  const path = join(homeDir, 'config.json')
  writeFileSync(path, JSON.stringify(content, null, 2) + '\n', 'utf-8')
  return path
}

function createConfigFixture(): Record<string, unknown> {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:19999',
    routerTimeoutMs: 5000,
    responseModelStyle: 'platform',
    reverseMapInResponse: true,
    adminToken: 'test-admin-secret',
    modelMap: {},
    defaultModel: 'legacy-default',
    models: [
      {
        id: 'router-model',
        label: 'Router Model',
        backendModel: 'router-model',
        aliases: ['default'],
        tier: 'general',
        default: true,
      },
      {
        id: 'saved-cloud',
        label: 'Saved Cloud',
        backendModel: 'gpt-4.1',
        aliases: ['cloud'],
        tier: 'cloud',
        endpoint: 'https://api.example.com/v1',
        apiKey: 'super-secret',
        headers: { 'X-Test': '1' },
      },
    ],
  }
}

function makeCatalog(): PlatformCatalog {
  return {
    version: 1,
    default_model: 'catalog-default',
    intent_defaults: {},
    models: [
      {
        id: 'catalog-default',
        channel: 'stable',
        backend: 'router',
        priority_role: 'chat',
      },
    ],
    aliases: {
      chat: { target: 'catalog-default' },
    },
  }
}

function createProbeStub() {
  const calls: ProbeInput[] = []
  return {
    probe: {
      async test(input: ProbeInput): Promise<ProviderProbeResult> {
        calls.push(input)
        return {
          ok: true,
          status: 'ok',
          latencyMs: 12,
          detail: typeof (input as { id?: string }).id === 'string'
            ? `tested:${(input as { id: string }).id}`
            : `tested:${(input as DryRunProviderPayload).endpoint ?? 'none'}`,
        }
      },
    },
    calls,
  }
}

function createHarness(options: { discoveryModels?: Array<{ id: string, label?: string, backend?: string, baseUrl?: string }> } = {}) {
  const homeDir = mkdtempSync('/tmp/owlcoda-admin-api-')
  process.env['OWLCODA_HOME'] = homeDir
  const configPath = writeConfig(homeDir, createConfigFixture())
  let config = loadConfig(configPath)
  const truth = new ModelTruthAggregator(() => config, {
    ttlMs: 5_000,
    deps: {
      probeRuntimeSurface: async () => ({
        ok: true,
        source: 'runtime_status',
        modelIds: ['router-model'],
        modelCount: 1,
        localRuntimeProtocol: 'openai_chat',
        readiness: 'ready',
        backendHealthy: true,
      }),
      discoverBackends: async () => ({
        backends: [],
        models: options.discoveryModels ?? [],
        totalModels: options.discoveryModels?.length ?? 0,
        reachableBackends: (options.discoveryModels?.length ?? 0) > 0 ? ['ollama'] : [],
        unreachableBackends: [],
        durationMs: 1,
      }),
      loadCatalog: () => makeCatalog(),
    },
  })
  const probeStub = createProbeStub()
  const auth = new AdminAuthManager('test-admin-secret')
  const mutator = new ModelConfigMutator({
    configPath,
    onInvalidate: () => truth.invalidate(),
    onWrite: (models, rawConfig) => {
      config = {
        ...config,
        models,
        routerUrl: typeof rawConfig.routerUrl === 'string' ? rawConfig.routerUrl : config.routerUrl,
        localRuntimeProtocol: (
          rawConfig.localRuntimeProtocol === 'auto'
          || rawConfig.localRuntimeProtocol === 'openai_chat'
          || rawConfig.localRuntimeProtocol === 'anthropic_messages'
        )
          ? rawConfig.localRuntimeProtocol
          : config.localRuntimeProtocol,
        modelMap: (rawConfig.modelMap as Record<string, string>) ?? {},
        defaultModel: models.find(model => model.default)?.backendModel ?? models[0]?.backendModel ?? '',
      }
    },
  })

  return {
    homeDir,
    getConfig: () => config,
    probeCalls: probeStub.calls,
    auth,
    deps: {
      getConfig: () => config,
      getSnapshot: (options?: { skipCache?: boolean }) => truth.getSnapshot(options),
      getCatalog: () => makeCatalog(),
      mutator,
      providerProbe: probeStub.probe as never,
      auth,
    },
  }
}

async function invokeAdminRoute(
  deps: ReturnType<typeof createHarness>['deps'],
  path: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
  } = {},
): Promise<MockResponse> {
  const bodyText = init.body === undefined ? '' : JSON.stringify(init.body)
  const req = Readable.from(bodyText ? [bodyText] : []) as IncomingMessage & Readable
  req.method = init.method ?? 'GET'
  req.url = path
  req.headers = init.headers ?? {}
  Object.assign(req, { socket: { remoteAddress: '127.0.0.1' } })

  const socket = new Socket()
  const res = new ServerResponse(new IncomingMessage(socket))
  const headers: Record<string, string> = {}
  let statusCode = 200
  let body = ''

  const originalSetHeader = res.setHeader.bind(res)
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
    return originalSetHeader(name, value)
  }) as typeof res.setHeader

  const originalWriteHead = res.writeHead.bind(res)
  res.writeHead = ((code: number, reasonOrHeaders?: string | http.OutgoingHttpHeaders, headersArg?: http.OutgoingHttpHeaders) => {
    statusCode = code
    const candidateHeaders = typeof reasonOrHeaders === 'string' ? headersArg : reasonOrHeaders
    if (candidateHeaders) {
      for (const [name, value] of Object.entries(candidateHeaders)) {
        if (value !== undefined) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
        }
      }
    }
    return originalWriteHead(code, reasonOrHeaders as never, headersArg)
  }) as typeof res.writeHead

  const done = new Promise<MockResponse>(resolve => {
    const originalEnd = res.end.bind(res)
    res.end = ((chunk?: unknown, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
      if (chunk) {
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk)
      }
      const maybeCallback = typeof encoding === 'function' ? encoding : callback
      const returnValue = originalEnd(chunk as never, encoding as never, maybeCallback)
      resolve({ statusCode, headers, body })
      return returnValue
    }) as typeof res.end
  })

  const handled = await handleAdminApiRequest(req, res, deps)
  if (!handled) {
    throw new Error(`Route ${path} was not handled`)
  }
  return done
}

describe('admin api routes', () => {
  let previousHome: string | undefined

  beforeEach(() => {
    previousHome = process.env['OWLCODA_HOME']
  })

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env['OWLCODA_HOME']
    } else {
      process.env['OWLCODA_HOME'] = previousHome
    }
  })

  it('returns schemaVersion on all read endpoints and redacts config keys', async () => {
    const harness = createHarness()

    try {
      const headers = { authorization: 'Bearer test-admin-secret' }
      const [snapshotRes, configRes, catalogRes, providersRes] = await Promise.all([
        invokeAdminRoute(harness.deps, '/admin/api/snapshot', { headers }),
        invokeAdminRoute(harness.deps, '/admin/api/config', { headers }),
        invokeAdminRoute(harness.deps, '/admin/api/catalog', { headers }),
        invokeAdminRoute(harness.deps, '/admin/api/providers', { headers }),
      ])

      expect(snapshotRes.statusCode).toBe(200)
      expect(configRes.statusCode).toBe(200)
      expect(catalogRes.statusCode).toBe(200)
      expect(providersRes.statusCode).toBe(200)

      const snapshotBody = JSON.parse(snapshotRes.body)
      const configBody = JSON.parse(configRes.body)
      const catalogBody = JSON.parse(catalogRes.body)
      const providersBody = JSON.parse(providersRes.body)

      expect(snapshotBody.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
      expect(configBody.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
      expect(catalogBody.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
      expect(providersBody.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)

      const savedCloud = configBody.config.models.find((model: { id: string }) => model.id === 'saved-cloud')
      expect(savedCloud.apiKey).toEqual({ set: true })
      expect(JSON.stringify(snapshotBody)).not.toContain('super-secret')
    } finally {
      rmSync(harness.homeDir, { recursive: true, force: true })
    }
  })

  it('supports dry-run test-connection payloads and saved model probes', async () => {
    const harness = createHarness()

    try {
      const headers = {
        authorization: 'Bearer test-admin-secret',
        'x-owlcoda-token': 'unused-for-bearer',
      }
      const testSavedRes = await invokeAdminRoute(harness.deps, '/admin/api/models/saved-cloud/test', {
        method: 'POST',
        headers,
      })
      const dryRunRes = await invokeAdminRoute(harness.deps, '/admin/api/test-connection', {
        method: 'POST',
        headers,
        body: {
          provider: 'anthropic',
          endpoint: 'https://api.anthropic.com',
          apiKey: 'dry-run-key',
        },
      })

      expect(testSavedRes.statusCode).toBe(200)
      expect(dryRunRes.statusCode).toBe(200)
      expect(harness.probeCalls).toHaveLength(2)
      expect((harness.probeCalls[0] as { id: string }).id).toBe('saved-cloud')
      expect((harness.probeCalls[1] as DryRunProviderPayload).endpoint).toBe('https://api.anthropic.com')

      const dryRunBody = JSON.parse(dryRunRes.body)
      expect(dryRunBody.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
      expect(dryRunBody.result.ok).toBe(true)
    } finally {
      rmSync(harness.homeDir, { recursive: true, force: true })
    }
  })

  it('exchanges one-shot token for cookie auth and reflects writes in snapshot', async () => {
    const harness = createHarness()

    try {
      const oneShotToken = harness.auth.issueOneShotToken()
      const exchangeRes = await invokeAdminRoute(harness.deps, `/admin/api/auth/exchange?token=${encodeURIComponent(oneShotToken)}`)
      expect(exchangeRes.statusCode).toBe(200)
      const exchangeBody = JSON.parse(exchangeRes.body)
      const cookie = exchangeRes.headers['set-cookie']
      expect(cookie).toContain('owlcoda_admin_session=')
      expect(exchangeBody.csrfToken).toBeTruthy()

      const createRes = await invokeAdminRoute(harness.deps, '/admin/api/models', {
        method: 'POST',
        headers: {
          cookie,
          'x-owlcoda-token': exchangeBody.csrfToken,
        },
        body: {
          model: {
            id: 'new-endpoint',
            label: 'New Endpoint',
            backendModel: 'gpt-4.1-mini',
            aliases: ['mini'],
            endpoint: 'https://api.openai.com/v1',
            timeoutMs: 3000,
          },
        },
      })
      expect(createRes.statusCode).toBe(201)
      const createBody = JSON.parse(createRes.body)
      expect(createBody.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
      expect(createBody.snapshot.byModelId['new-endpoint']).toBeTruthy()

      const defaultRes = await invokeAdminRoute(harness.deps, '/admin/api/default', {
        method: 'POST',
        headers: {
          cookie,
          'x-owlcoda-token': exchangeBody.csrfToken,
        },
        body: { modelId: 'new-endpoint' },
      })
      expect(defaultRes.statusCode).toBe(200)

      const snapshotRes = await invokeAdminRoute(harness.deps, '/admin/api/snapshot', {
        headers: { cookie },
      })
      const snapshotBody = JSON.parse(snapshotRes.body)
      expect(snapshotBody.snapshot.byModelId['new-endpoint'].isDefault).toBe(true)
      expect(harness.getConfig().defaultModel).toBe('gpt-4.1-mini')
    } finally {
      rmSync(harness.homeDir, { recursive: true, force: true })
    }
  })

  it('updates, binds, and removes models with batch-friendly mutation response shape', async () => {
    const harness = createHarness()

    try {
      const headers = {
        authorization: 'Bearer test-admin-secret',
        'x-owlcoda-token': 'unused-for-bearer',
      }

      const patchRes = await invokeAdminRoute(harness.deps, '/admin/api/models/saved-cloud', {
        method: 'PATCH',
        headers,
        body: {
          patch: {
            label: 'Updated Cloud',
            aliases: ['updated-cloud'],
            endpoint: 'https://api.example.com/v2',
          },
        },
      })
      expect(patchRes.statusCode).toBe(200)
      const patchBody = JSON.parse(patchRes.body)
      expect(patchBody.results).toEqual([{ id: 'saved-cloud', ok: true }])

      const keyRes = await invokeAdminRoute(harness.deps, '/admin/api/models/saved-cloud/key', {
        method: 'POST',
        headers,
        body: { apiKeyEnv: 'UPDATED_API_KEY' },
      })
      expect(keyRes.statusCode).toBe(200)

      const bindRes = await invokeAdminRoute(harness.deps, '/admin/api/models/discovered-local/bind-discovered', {
        method: 'POST',
        headers,
        body: {
          patch: {
            label: 'Discovered Local',
            backendModel: 'discovered-local',
            aliases: ['local'],
            endpoint: 'http://127.0.0.1:11434/v1/chat/completions',
          },
        },
      })
      expect(bindRes.statusCode).toBe(200)

      const deleteRes = await invokeAdminRoute(harness.deps, '/admin/api/models/saved-cloud', {
        method: 'DELETE',
        headers,
      })
      expect(deleteRes.statusCode).toBe(200)
      const deleteBody = JSON.parse(deleteRes.body)
      expect(deleteBody.results).toEqual([{ id: 'saved-cloud', ok: true }])
      expect(harness.getConfig().models.some(model => model.id === 'saved-cloud')).toBe(false)
      expect(harness.getConfig().models.some(model => model.id === 'discovered-local')).toBe(true)
    } finally {
      rmSync(harness.homeDir, { recursive: true, force: true })
    }
  })

  it('updates runtime settings via PATCH /admin/api/config/runtime and refreshes snapshot', async () => {
    const harness = createHarness()

    try {
      const headers = {
        authorization: 'Bearer test-admin-secret',
        'x-owlcoda-token': 'unused-for-bearer',
      }

      const patchRes = await invokeAdminRoute(harness.deps, '/admin/api/config/runtime', {
        method: 'PATCH',
        headers,
        body: {
          patch: {
            routerUrl: 'http://127.0.0.1:11435/v1/',
            localRuntimeProtocol: 'openai_chat',
          },
        },
      })

      expect(patchRes.statusCode).toBe(200)
      const body = JSON.parse(patchRes.body)
      expect(body.results).toEqual([{ id: 'runtime-settings', ok: true }])
      expect(harness.getConfig().routerUrl).toBe('http://127.0.0.1:11435/v1')
      expect(harness.getConfig().localRuntimeProtocol).toBe('openai_chat')
    } finally {
      rmSync(harness.homeDir, { recursive: true, force: true })
    }
  })

  // ─── δ: bulk endpoints ─────────────────────────────────────────────

  describe('bulk endpoints (Phase δ)', () => {
    const headers = {
      authorization: 'Bearer test-admin-secret',
      'x-owlcoda-token': 'unused-for-bearer',
    }

    it('POST /admin/api/bulk/patch applies each item and returns per-item results + snapshot', async () => {
      const harness = createHarness()
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/patch', {
          method: 'POST',
          headers,
          body: {
            items: [
              { id: 'router-model', patch: { label: 'Router Primary' } },
              { id: 'saved-cloud', patch: { aliases: ['cloud-alt'] } },
            ],
          },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
        expect(body.ok).toBe(true)
        expect(body.results).toEqual([
          { id: 'router-model', ok: true },
          { id: 'saved-cloud', ok: true },
        ])
        expect(body.snapshot).toBeDefined()
        const updated = harness.getConfig().models.find(m => m.id === 'router-model')!
        expect(updated.label).toBe('Router Primary')
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('POST /admin/api/bulk/patch returns 207 partial with per-item errors on mixed outcomes', async () => {
      const harness = createHarness()
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/patch', {
          method: 'POST',
          headers,
          body: {
            items: [
              { id: 'router-model', patch: { label: 'OK' } },
              { id: 'does-not-exist', patch: { label: 'Boom' } },
            ],
          },
        })
        expect(res.statusCode).toBe(207)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(false)
        expect(body.results).toHaveLength(2)
        expect(body.results[0]).toEqual({ id: 'router-model', ok: true })
        expect(body.results[1].id).toBe('does-not-exist')
        expect(body.results[1].ok).toBe(false)
        expect(body.results[1].error).toBeDefined()
        expect(body.snapshot).toBeDefined()
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('POST /admin/api/bulk/patch returns 422 when every item fails', async () => {
      const harness = createHarness()
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/patch', {
          method: 'POST',
          headers,
          body: {
            items: [
              { id: 'nope-1', patch: { label: 'A' } },
              { id: 'nope-2', patch: { label: 'B' } },
            ],
          },
        })
        expect(res.statusCode).toBe(422)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(false)
        expect(body.results.every((r: { ok: boolean }) => !r.ok)).toBe(true)
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('POST /admin/api/bulk/bind-discovered runs multiple bind operations', async () => {
      const harness = createHarness()
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/bind-discovered', {
          method: 'POST',
          headers,
          body: {
            items: [
              { discoveredId: 'local-a', patch: { label: 'Local A', backendModel: 'local-a' } },
              { discoveredId: 'local-b', patch: { label: 'Local B' } },
            ],
          },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.results).toEqual([
          { id: 'local-a', ok: true },
          { id: 'local-b', ok: true },
        ])
        const ids = harness.getConfig().models.map(m => m.id)
        expect(ids).toContain('local-a')
        expect(ids).toContain('local-b')
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('binds a discovered model onto an existing config model and snapshot reflects the merge', async () => {
      const harness = createHarness({
        discoveryModels: [
          { id: 'local-a', label: 'Local A', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
        ],
      })
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/models/local-a/bind-discovered', {
          method: 'POST',
          headers,
          body: {
            patch: {
              targetModelId: 'router-model',
              label: 'Router Local',
              aliases: ['default', 'router-local'],
            },
          },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.schemaVersion).toBe(ADMIN_API_SCHEMA_VERSION)
        expect(body.results).toEqual([{ id: 'local-a', ok: true }])
        expect(body.snapshot.byModelId['router-model'].presentIn.discovered).toBe(true)
        expect(body.snapshot.byModelId['router-model'].raw.config.backendModel).toBe('local-a')
        expect(body.snapshot.byModelId['local-a']).toBeUndefined()
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('POST /admin/api/bulk/bind-discovered supports mixed own-bind and existing-target bind', async () => {
      const harness = createHarness({
        discoveryModels: [
          { id: 'local-a', label: 'Local A', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
          { id: 'local-b', label: 'Local B', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
        ],
      })
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/bind-discovered', {
          method: 'POST',
          headers,
          body: {
            items: [
              { discoveredId: 'local-a', patch: { label: 'Own Local A' } },
              { discoveredId: 'local-b', patch: { targetModelId: 'router-model', label: 'Bound Router' } },
            ],
          },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.results).toEqual([
          { id: 'local-a', ok: true },
          { id: 'local-b', ok: true },
        ])
        expect(body.snapshot.byModelId['local-a'].presentIn.config).toBe(true)
        expect(body.snapshot.byModelId['router-model'].presentIn.discovered).toBe(true)
        expect(body.snapshot.byModelId['router-model'].raw.config.backendModel).toBe('local-b')
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('does not attach discovered models to alias-only matches when no backendModel relationship exists', async () => {
      const harness = createHarness({
        discoveryModels: [
          { id: 'local-a', label: 'Local A', backend: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
        ],
      })
      try {
        const patchRes = await invokeAdminRoute(harness.deps, '/admin/api/models/router-model', {
          method: 'PATCH',
          headers,
          body: {
            patch: {
              aliases: ['default', 'local-a'],
              backendModel: 'router-model',
            },
          },
        })
        expect(patchRes.statusCode).toBe(200)

        const snapshotRes = await invokeAdminRoute(harness.deps, '/admin/api/snapshot', {
          method: 'GET',
          headers: { authorization: 'Bearer test-admin-secret' },
        })
        expect(snapshotRes.statusCode).toBe(200)
        const body = JSON.parse(snapshotRes.body)
        expect(body.snapshot.byModelId['router-model'].presentIn.discovered).toBe(false)
        expect(body.snapshot.byModelId['router-model'].raw.discovered).toBeUndefined()
        expect(body.snapshot.byModelId['local-a'].presentIn.discovered).toBe(true)
        expect(body.snapshot.byModelId['local-a'].presentIn.config).toBe(false)
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('POST /admin/api/bulk/bind-discovered returns readable per-item errors for invalid targetModelId', async () => {
      const harness = createHarness()
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/bind-discovered', {
          method: 'POST',
          headers,
          body: {
            items: [
              { discoveredId: 'local-a', patch: { label: 'Own Local A' } },
              { discoveredId: 'local-b', patch: { targetModelId: 'missing-model' } },
            ],
          },
        })
        expect(res.statusCode).toBe(207)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(false)
        expect(body.results[0]).toEqual({ id: 'local-a', ok: true })
        expect(body.results[1]).toMatchObject({
          id: 'local-b',
          ok: false,
          error: {
            code: 'mutation_failed',
          },
        })
        expect(body.results[1].error.message).toContain('missing-model')
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('POST /admin/api/bulk/create imports multiple catalog entries as endpoint models', async () => {
      const harness = createHarness()
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/create', {
          method: 'POST',
          headers,
          body: {
            items: [
              { model: { id: 'new-one', endpoint: 'https://api.example.com/v1', label: 'New One' } },
              { model: { id: 'new-two', endpoint: 'https://api.example.com/v1', label: 'New Two' } },
            ],
          },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.results.map((r: { id: string }) => r.id)).toEqual(['new-one', 'new-two'])
        const ids = harness.getConfig().models.map(m => m.id)
        expect(ids).toContain('new-one')
        expect(ids).toContain('new-two')
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })

    it('bulk endpoint rejects non-array items field', async () => {
      const harness = createHarness()
      try {
        const res = await invokeAdminRoute(harness.deps, '/admin/api/bulk/patch', {
          method: 'POST',
          headers,
          body: { items: 'not-an-array' },
        })
        expect(res.statusCode).toBe(400)
        const body = JSON.parse(res.body)
        expect(body.error.code).toBe('invalid_request')
      } finally {
        rmSync(harness.homeDir, { recursive: true, force: true })
      }
    })
  })
})
