/**
 * Tests for the /backends REPL command.
 * Verifies output formatting for discovery results.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { handleCommand, type CommandContext } from '../src/frontend/commands.js'
import type { OwlCodaConfig } from '../src/config.js'

function startMockServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  return new Promise(resolve => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

function makeCtx(configOverrides?: Partial<OwlCodaConfig>): CommandContext {
  return {
    config: {
      port: 8019,
      host: '127.0.0.1',
      routerUrl: 'http://127.0.0.1:8009',
      routerTimeoutMs: 600_000,
      models: [],
      responseModelStyle: 'platform',
      logLevel: 'info',
      catalogLoaded: false,
      middleware: {},
      modelMap: {},
      defaultModel: '',
      reverseMapInResponse: true,
      ...configOverrides,
    },
    currentModel: 'test-model',
    sessionId: null,
    messageCount: 0,
    autoApprove: false,
    setModel: () => {},
    setAutoApprove: () => {},
    clearMessages: () => {},
    quit: () => {},
    resumeSession: async () => null,
  }
}

describe('/backends command', () => {
  let ollamaMock: { server: Server; url: string }

  beforeAll(async () => {
    ollamaMock = await startMockServer((req, res) => {
      if (req.url === '/api/version') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ version: '0.6.2' }))
      } else if (req.url === '/api/tags') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          models: [
            {
              name: 'llama3:8b',
              model: 'llama3:8b',
              modified_at: '',
              size: 0,
              digest: '',
              details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
            },
          ],
        }))
      } else { res.writeHead(404); res.end() }
    })
  })

  afterAll(() => ollamaMock.server.close())

  it('shows discovered backends with models', async () => {
    const ctx = makeCtx({
      backends: [{ type: 'ollama', baseUrl: ollamaMock.url, enabled: true }],
    })
    const result = await handleCommand('/backends', ctx)
    expect(result.handled).toBe(true)
    expect(result.output).toContain('Backend Discovery')
    expect(result.output).toContain('ollama')
    expect(result.output).toContain('llama3')
    expect(result.output).toContain('8B')
  })

  it('shows "no backends" when none are reachable', async () => {
    const ctx = makeCtx({
      backends: [{ type: 'vllm', baseUrl: 'http://127.0.0.1:1', enabled: true }],
    })
    const result = await handleCommand('/backends', ctx)
    expect(result.handled).toBe(true)
    expect(result.output).toContain('No local backends detected')
  })

  it('shows duration in output', async () => {
    const ctx = makeCtx({
      backends: [{ type: 'ollama', baseUrl: ollamaMock.url, enabled: true }],
    })
    const result = await handleCommand('/backends', ctx)
    expect(result.output).toMatch(/\d+ms/)
  })

  it('shows quantization info', async () => {
    const ctx = makeCtx({
      backends: [{ type: 'ollama', baseUrl: ollamaMock.url, enabled: true }],
    })
    const result = await handleCommand('/backends', ctx)
    expect(result.output).toContain('Q4_K_M')
  })

  it('uses default backends when config has no backends field', async () => {
    const ctx = makeCtx() // no backends field
    const result = await handleCommand('/backends', ctx)
    expect(result.handled).toBe(true)
    // All defaults unreachable → shows "no backends"
    expect(result.output).toContain('Backend Discovery')
  })
})
