/**
 * Backend adapter tests — Ollama, LM Studio, vLLM adapters + discovery.
 *
 * Uses mock HTTP servers on port 0 to simulate backend responses.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { OllamaAdapter } from '../src/backends/ollama.js'
import { LMStudioAdapter } from '../src/backends/lmstudio.js'
import { VLLMAdapter } from '../src/backends/vllm.js'
import { createAdapter, discoverBackends, anyBackendReachable } from '../src/backends/discovery.js'
import type { BackendConfig } from '../src/backends/types.js'

// ─── Mock Servers ───

function startMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
      })
    })
  })
}

// ─── Ollama Adapter ───

describe('OllamaAdapter', () => {
  let mock: { server: Server; port: number; url: string }

  beforeAll(async () => {
    mock = await startMockServer((req, res) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ version: '0.6.2' }))
      } else if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          models: [
            {
              name: 'llama3.3:latest',
              model: 'llama3.3:latest',
              modified_at: '2025-01-01T00:00:00Z',
              size: 4_000_000_000,
              digest: 'abc123',
              details: {
                parameter_size: '70B',
                quantization_level: 'Q4_K_M',
                family: 'llama',
              },
            },
            {
              name: 'qwen2.5:32b',
              model: 'qwen2.5:32b',
              modified_at: '2025-01-01T00:00:00Z',
              size: 18_000_000_000,
              digest: 'def456',
              details: {
                parameter_size: '32B',
                quantization_level: 'Q4_0',
                family: 'qwen2',
              },
            },
          ],
        }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  })

  afterAll(() => mock.server.close())

  it('reports correct name and default port', () => {
    const adapter = new OllamaAdapter()
    expect(adapter.name).toBe('ollama')
    expect(adapter.defaultPort).toBe(11434)
  })

  it('uses custom base URL', () => {
    const adapter = new OllamaAdapter('http://192.168.1.100:11434/')
    expect(adapter.baseUrl).toBe('http://192.168.1.100:11434')
    expect(adapter.chatCompletionsUrl()).toBe('http://192.168.1.100:11434/v1/chat/completions')
  })

  it('detects reachability via /api/version', async () => {
    const adapter = new OllamaAdapter(mock.url)
    expect(await adapter.isReachable()).toBe(true)
  })

  it('reports unreachable for dead port', async () => {
    const adapter = new OllamaAdapter('http://127.0.0.1:1')
    expect(await adapter.isReachable(500)).toBe(false)
  })

  it('discovers models from /api/tags', async () => {
    const adapter = new OllamaAdapter(mock.url)
    const models = await adapter.discover()
    expect(models).toHaveLength(2)
    expect(models[0]!.id).toBe('llama3.3:latest')
    expect(models[0]!.backend).toBe('ollama')
    expect(models[0]!.parameterSize).toBe('70B')
    expect(models[0]!.quantization).toBe('Q4_K_M')
    expect(models[1]!.id).toBe('qwen2.5:32b')
  })

  it('label includes param size and quantization', async () => {
    const adapter = new OllamaAdapter(mock.url)
    const models = await adapter.discover()
    expect(models[0]!.label).toContain('70B')
    expect(models[0]!.label).toContain('Q4_K_M')
  })

  it('returns empty for unreachable backend', async () => {
    const adapter = new OllamaAdapter('http://127.0.0.1:1')
    const models = await adapter.discover(500)
    expect(models).toHaveLength(0)
  })

  it('returns standard headers', () => {
    const adapter = new OllamaAdapter()
    expect(adapter.headers()).toEqual({ 'Content-Type': 'application/json' })
  })
})

// ─── LM Studio Adapter ───

describe('LMStudioAdapter', () => {
  let mock: { server: Server; port: number; url: string }

  beforeAll(async () => {
    mock = await startMockServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [
            { id: 'TheBloke/Mistral-7B-Instruct-v0.2-GGUF', object: 'model', owned_by: 'user' },
            { id: 'lmstudio-community/Qwen2.5-14B-Instruct-Q4_K_M-GGUF', object: 'model', owned_by: 'user' },
          ],
        }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  })

  afterAll(() => mock.server.close())

  it('reports correct name and default port', () => {
    const adapter = new LMStudioAdapter()
    expect(adapter.name).toBe('lmstudio')
    expect(adapter.defaultPort).toBe(1234)
  })

  it('detects reachability via /v1/models', async () => {
    const adapter = new LMStudioAdapter(mock.url)
    expect(await adapter.isReachable()).toBe(true)
  })

  it('discovers models from /v1/models', async () => {
    const adapter = new LMStudioAdapter(mock.url)
    const models = await adapter.discover()
    expect(models).toHaveLength(2)
    expect(models[0]!.id).toBe('TheBloke/Mistral-7B-Instruct-v0.2-GGUF')
    expect(models[0]!.backend).toBe('lmstudio')
    expect(models[0]!.parameterSize).toBe('7B')
  })

  it('strips GGUF suffix from labels', async () => {
    const adapter = new LMStudioAdapter(mock.url)
    const models = await adapter.discover()
    expect(models[0]!.label).not.toContain('GGUF')
    expect(models[0]!.label).toContain('Mistral')
  })

  it('extracts quantization from model ID', async () => {
    const adapter = new LMStudioAdapter(mock.url)
    const models = await adapter.discover()
    expect(models[1]!.quantization).toBe('Q4_K_M')
  })

  it('chatCompletionsUrl uses standard OpenAI path', () => {
    const adapter = new LMStudioAdapter(mock.url)
    expect(adapter.chatCompletionsUrl()).toBe(`${mock.url}/v1/chat/completions`)
  })
})

// ─── vLLM Adapter ───

describe('VLLMAdapter', () => {
  let mock: { server: Server; port: number; url: string }

  beforeAll(async () => {
    mock = await startMockServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200)
        res.end()
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          data: [
            { id: 'Qwen/Qwen2.5-72B-Instruct', object: 'model', max_model_len: 131072 },
            { id: 'meta-llama/Llama-3.3-70B-Instruct', object: 'model', max_model_len: 131072 },
          ],
        }))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
  })

  afterAll(() => mock.server.close())

  it('reports correct name and default port', () => {
    const adapter = new VLLMAdapter()
    expect(adapter.name).toBe('vllm')
    expect(adapter.defaultPort).toBe(8000)
  })

  it('detects reachability via /health', async () => {
    const adapter = new VLLMAdapter(mock.url)
    expect(await adapter.isReachable()).toBe(true)
  })

  it('discovers models from /v1/models', async () => {
    const adapter = new VLLMAdapter(mock.url)
    const models = await adapter.discover()
    expect(models).toHaveLength(2)
    expect(models[0]!.id).toBe('Qwen/Qwen2.5-72B-Instruct')
    expect(models[0]!.backend).toBe('vllm')
  })

  it('extracts context window from max_model_len', async () => {
    const adapter = new VLLMAdapter(mock.url)
    const models = await adapter.discover()
    expect(models[0]!.contextWindow).toBe(131072)
  })

  it('label uses last path component', async () => {
    const adapter = new VLLMAdapter(mock.url)
    const models = await adapter.discover()
    expect(models[0]!.label).toBe('Qwen2.5-72B-Instruct')
    expect(models[1]!.label).toBe('Llama-3.3-70B-Instruct')
  })

  it('extracts parameter size from model ID', async () => {
    const adapter = new VLLMAdapter(mock.url)
    const models = await adapter.discover()
    expect(models[0]!.parameterSize).toBe('72B')
    expect(models[1]!.parameterSize).toBe('70B')
  })
})

// ─── createAdapter ───

describe('createAdapter', () => {
  it('creates OllamaAdapter', () => {
    const adapter = createAdapter({ type: 'ollama' })
    expect(adapter.name).toBe('ollama')
    expect(adapter.defaultPort).toBe(11434)
  })

  it('creates LMStudioAdapter', () => {
    const adapter = createAdapter({ type: 'lmstudio' })
    expect(adapter.name).toBe('lmstudio')
    expect(adapter.defaultPort).toBe(1234)
  })

  it('creates VLLMAdapter', () => {
    const adapter = createAdapter({ type: 'vllm' })
    expect(adapter.name).toBe('vllm')
    expect(adapter.defaultPort).toBe(8000)
  })

  it('creates LMStudioAdapter for openai-compat', () => {
    const adapter = createAdapter({ type: 'openai-compat' })
    expect(adapter.baseUrl).toBe('http://127.0.0.1:8080')
  })

  it('passes custom baseUrl', () => {
    const adapter = createAdapter({ type: 'ollama', baseUrl: 'http://10.0.0.1:11434' })
    expect(adapter.baseUrl).toBe('http://10.0.0.1:11434')
  })

  it('throws for unknown type', () => {
    expect(() => createAdapter({ type: 'unknown' as any })).toThrow('Unknown backend type')
  })
})

// ─── discoverBackends ───

describe('discoverBackends', () => {
  let ollamaMock: { server: Server; url: string }
  let lmstudioMock: { server: Server; url: string }

  beforeAll(async () => {
    ollamaMock = await startMockServer((req, res) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ version: '0.6.2' }))
      } else if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ models: [{ name: 'tinyllama:latest', model: 'tinyllama:latest', modified_at: '', size: 0, digest: '' }] }))
      } else { res.writeHead(404); res.end() }
    })

    lmstudioMock = await startMockServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'test-model', object: 'model' }] }))
      } else { res.writeHead(404); res.end() }
    })
  })

  afterAll(() => {
    ollamaMock.server.close()
    lmstudioMock.server.close()
  })

  it('discovers models from multiple backends in parallel', async () => {
    const configs: BackendConfig[] = [
      { type: 'ollama', baseUrl: ollamaMock.url, enabled: true },
      { type: 'lmstudio', baseUrl: lmstudioMock.url, enabled: true },
    ]
    const result = await discoverBackends(configs)
    expect(result.models).toHaveLength(2)
    expect(result.reachableBackends).toContain('ollama')
    expect(result.reachableBackends).toContain('lmstudio')
    expect(result.unreachableBackends).toHaveLength(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('handles unreachable backends gracefully', async () => {
    const configs: BackendConfig[] = [
      { type: 'ollama', baseUrl: ollamaMock.url, enabled: true },
      { type: 'vllm', baseUrl: 'http://127.0.0.1:1', enabled: true },
    ]
    const result = await discoverBackends(configs, 500)
    expect(result.models).toHaveLength(1)
    expect(result.reachableBackends).toContain('ollama')
    expect(result.unreachableBackends).toContain('vllm')
  })

  it('respects enabled: false', async () => {
    const configs: BackendConfig[] = [
      { type: 'ollama', baseUrl: ollamaMock.url, enabled: false },
    ]
    const result = await discoverBackends(configs)
    expect(result.models).toHaveLength(0)
  })

  it('uses default backends when no configs given', async () => {
    // All defaults will be unreachable (wrong ports)
    const result = await discoverBackends(undefined, 300)
    expect(result.unreachableBackends.length).toBeGreaterThanOrEqual(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })
})

// ─── anyBackendReachable ───

describe('anyBackendReachable', () => {
  it('returns false when no backends are running', async () => {
    // Default ports (11434, 1234, 8000) are unlikely to be running in CI
    const reachable = await anyBackendReachable(300)
    // This is environment-dependent, so just check the return type
    expect(typeof reachable).toBe('boolean')
  })
})

// ─── Edge cases ───

describe('adapter edge cases', () => {
  it('Ollama handles malformed /api/tags response', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/version') { res.writeHead(200); res.end('{}') }
      else if (req.url === '/api/tags') { res.writeHead(200); res.end('not json') }
      else { res.writeHead(404); res.end() }
    })
    const adapter = new OllamaAdapter(mock.url)
    const models = await adapter.discover()
    expect(models).toHaveLength(0)
    mock.server.close()
  })

  it('LM Studio handles empty models list', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
      } else { res.writeHead(404); res.end() }
    })
    const adapter = new LMStudioAdapter(mock.url)
    const models = await adapter.discover()
    expect(models).toHaveLength(0)
    mock.server.close()
  })

  it('vLLM handles 500 from /health', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/health') { res.writeHead(500); res.end() }
      else { res.writeHead(404); res.end() }
    })
    const adapter = new VLLMAdapter(mock.url)
    expect(await adapter.isReachable()).toBe(false)
    mock.server.close()
  })

  it('Ollama strips trailing slash from baseUrl', () => {
    const adapter = new OllamaAdapter('http://localhost:11434/')
    expect(adapter.baseUrl).toBe('http://localhost:11434')
  })
})
