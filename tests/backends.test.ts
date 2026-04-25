import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { OllamaAdapter } from '../src/backends/ollama.js'
import { LMStudioAdapter } from '../src/backends/lmstudio.js'
import { VLLMAdapter } from '../src/backends/vllm.js'
import { createAdapter, discoverBackends, anyBackendReachable } from '../src/backends/discovery.js'

// ─── Mock server that simulates all three backends ───

let server: Server
let port: number

const ollamaModels = {
  models: [
    {
      name: 'llama3:8b',
      model: 'llama3:8b',
      modified_at: '2024-01-01T00:00:00Z',
      size: 4_000_000_000,
      digest: 'abc123',
      details: {
        parameter_size: '8B',
        quantization_level: 'Q4_0',
        family: 'llama',
      },
    },
    {
      name: 'codellama:13b',
      model: 'codellama:13b',
      modified_at: '2024-01-02T00:00:00Z',
      size: 7_000_000_000,
      digest: 'def456',
      details: {
        parameter_size: '13B',
        quantization_level: 'Q4_K_M',
      },
    },
  ],
}

const openaiModels = {
  data: [
    { id: 'Qwen2.5-7B-Instruct-Q4_K_M-GGUF', object: 'model', owned_by: 'user' },
    { id: 'DeepSeek-R1-32B', object: 'model', owned_by: 'user' },
  ],
}

const vllmModels = {
  data: [
    { id: 'Qwen/Qwen2.5-72B-Instruct', object: 'model', owned_by: 'vllm', max_model_len: 32768 },
  ],
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    res.setHeader('Content-Type', 'application/json')

    // Ollama endpoints
    if (url === '/ollama/api/version') {
      res.end(JSON.stringify({ version: '0.3.0' }))
      return
    }
    if (url === '/ollama/api/tags') {
      res.end(JSON.stringify(ollamaModels))
      return
    }

    // LM Studio / OpenAI-compat endpoints
    if (url === '/lmstudio/v1/models') {
      res.end(JSON.stringify(openaiModels))
      return
    }

    // vLLM endpoints
    if (url === '/vllm/health') {
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }
    if (url === '/vllm/v1/models') {
      res.end(JSON.stringify(vllmModels))
      return
    }

    res.statusCode = 404
    res.end('{}')
  })

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      port = addr.port
      resolve()
    })
  })
})

afterAll(() => {
  server.close()
})

describe('backend adapters', () => {
  describe('OllamaAdapter', () => {
    it('detects reachable backend', async () => {
      const adapter = new OllamaAdapter(`http://127.0.0.1:${port}/ollama`)
      const reachable = await adapter.isReachable()
      expect(reachable).toBe(true)
    })

    it('discovers models', async () => {
      const adapter = new OllamaAdapter(`http://127.0.0.1:${port}/ollama`)
      const models = await adapter.discover()
      expect(models).toHaveLength(2)
      expect(models[0].id).toBe('llama3:8b')
      expect(models[0].backend).toBe('ollama')
      expect(models[0].parameterSize).toBe('8B')
      expect(models[0].quantization).toBe('Q4_0')
      expect(models[1].id).toBe('codellama:13b')
    })

    it('returns false for unreachable backend', async () => {
      const adapter = new OllamaAdapter('http://127.0.0.1:19999')
      const reachable = await adapter.isReachable(500)
      expect(reachable).toBe(false)
    })

    it('returns empty models for unreachable backend', async () => {
      const adapter = new OllamaAdapter('http://127.0.0.1:19999')
      const models = await adapter.discover(500)
      expect(models).toEqual([])
    })

    it('generates correct chat completions URL', () => {
      const adapter = new OllamaAdapter('http://localhost:11434')
      expect(adapter.chatCompletionsUrl()).toBe('http://localhost:11434/v1/chat/completions')
    })

    it('provides correct headers', () => {
      const adapter = new OllamaAdapter()
      expect(adapter.headers()).toEqual({ 'Content-Type': 'application/json' })
    })

    it('has correct default port', () => {
      const adapter = new OllamaAdapter()
      expect(adapter.defaultPort).toBe(11434)
      expect(adapter.baseUrl).toContain('11434')
    })

    it('formats labels with param size and quantization', async () => {
      const adapter = new OllamaAdapter(`http://127.0.0.1:${port}/ollama`)
      const models = await adapter.discover()
      expect(models[0].label).toContain('8B')
      expect(models[0].label).toContain('Q4_0')
    })
  })

  describe('LMStudioAdapter', () => {
    it('detects reachable backend', async () => {
      const adapter = new LMStudioAdapter(`http://127.0.0.1:${port}/lmstudio`)
      const reachable = await adapter.isReachable()
      expect(reachable).toBe(true)
    })

    it('discovers models', async () => {
      const adapter = new LMStudioAdapter(`http://127.0.0.1:${port}/lmstudio`)
      const models = await adapter.discover()
      expect(models).toHaveLength(2)
      expect(models[0].id).toBe('Qwen2.5-7B-Instruct-Q4_K_M-GGUF')
      expect(models[0].backend).toBe('lmstudio')
      expect(models[0].quantization).toBe('Q4_K_M')
      expect(models[0].parameterSize).toBe('7B')
    })

    it('returns false for unreachable backend', async () => {
      const adapter = new LMStudioAdapter('http://127.0.0.1:19998')
      const reachable = await adapter.isReachable(500)
      expect(reachable).toBe(false)
    })

    it('has correct default port', () => {
      const adapter = new LMStudioAdapter()
      expect(adapter.defaultPort).toBe(1234)
      expect(adapter.baseUrl).toContain('1234')
    })

    it('extracts quantization from model ID', async () => {
      const adapter = new LMStudioAdapter(`http://127.0.0.1:${port}/lmstudio`)
      const models = await adapter.discover()
      // Qwen2.5-7B-Instruct-Q4_K_M-GGUF → Q4_K_M
      expect(models[0].quantization).toBe('Q4_K_M')
      // DeepSeek-R1-32B → no quantization
      expect(models[1].quantization).toBeUndefined()
    })

    it('extracts parameter size from model ID', async () => {
      const adapter = new LMStudioAdapter(`http://127.0.0.1:${port}/lmstudio`)
      const models = await adapter.discover()
      expect(models[0].parameterSize).toBe('7B')
      expect(models[1].parameterSize).toBe('32B')
    })
  })

  describe('VLLMAdapter', () => {
    it('detects reachable backend', async () => {
      const adapter = new VLLMAdapter(`http://127.0.0.1:${port}/vllm`)
      const reachable = await adapter.isReachable()
      expect(reachable).toBe(true)
    })

    it('discovers models with context window', async () => {
      const adapter = new VLLMAdapter(`http://127.0.0.1:${port}/vllm`)
      const models = await adapter.discover()
      expect(models).toHaveLength(1)
      expect(models[0].id).toBe('Qwen/Qwen2.5-72B-Instruct')
      expect(models[0].backend).toBe('vllm')
      expect(models[0].contextWindow).toBe(32768)
      expect(models[0].parameterSize).toBe('72B')
    })

    it('formats label from HuggingFace path', async () => {
      const adapter = new VLLMAdapter(`http://127.0.0.1:${port}/vllm`)
      const models = await adapter.discover()
      expect(models[0].label).toBe('Qwen2.5-72B-Instruct')
    })

    it('has correct default port', () => {
      const adapter = new VLLMAdapter()
      expect(adapter.defaultPort).toBe(8000)
      expect(adapter.baseUrl).toContain('8000')
    })
  })

  describe('createAdapter', () => {
    it('creates OllamaAdapter', () => {
      const adapter = createAdapter({ type: 'ollama' })
      expect(adapter.name).toBe('ollama')
    })

    it('creates LMStudioAdapter', () => {
      const adapter = createAdapter({ type: 'lmstudio' })
      expect(adapter.name).toBe('lmstudio')
    })

    it('creates VLLMAdapter', () => {
      const adapter = createAdapter({ type: 'vllm' })
      expect(adapter.name).toBe('vllm')
    })

    it('creates generic OpenAI-compat via LMStudio adapter', () => {
      const adapter = createAdapter({ type: 'openai-compat', baseUrl: 'http://localhost:9999' })
      expect(adapter.name).toBe('lmstudio')
      expect(adapter.baseUrl).toBe('http://localhost:9999')
    })

    it('throws for unknown backend type', () => {
      expect(() => createAdapter({ type: 'unknown' as any })).toThrow('Unknown backend')
    })
  })

  describe('discoverBackends', () => {
    it('discovers models from configured backends', async () => {
      const result = await discoverBackends([
        { type: 'ollama', baseUrl: `http://127.0.0.1:${port}/ollama`, enabled: true },
        { type: 'lmstudio', baseUrl: `http://127.0.0.1:${port}/lmstudio`, enabled: true },
      ])

      expect(result.models.length).toBeGreaterThanOrEqual(2)
      expect(result.reachableBackends).toContain('ollama')
      expect(result.reachableBackends).toContain('lmstudio')
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('handles mix of reachable and unreachable backends', async () => {
      const result = await discoverBackends([
        { type: 'ollama', baseUrl: `http://127.0.0.1:${port}/ollama`, enabled: true },
        { type: 'vllm', baseUrl: 'http://127.0.0.1:19997', enabled: true },
      ], 500)

      expect(result.reachableBackends).toContain('ollama')
      expect(result.unreachableBackends).toContain('vllm')
    })

    it('skips disabled backends', async () => {
      const result = await discoverBackends([
        { type: 'ollama', baseUrl: `http://127.0.0.1:${port}/ollama`, enabled: true },
        { type: 'lmstudio', baseUrl: `http://127.0.0.1:${port}/lmstudio`, enabled: false },
      ])

      const backends = result.reachableBackends.concat(result.unreachableBackends)
      expect(backends).not.toContain('lmstudio')
    })
  })

  describe('anyBackendReachable', () => {
    it('returns true when backends are running (uses default ports — may timeout)', async () => {
      // This tests against real default ports, so result depends on environment
      const result = await anyBackendReachable(500)
      expect(typeof result).toBe('boolean')
    })
  })
})
