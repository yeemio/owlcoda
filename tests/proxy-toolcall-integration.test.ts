/**
 * Proxy integration test: tool calls flow through the full pipeline.
 * Tests Anthropic tool_use → OpenAI tool_calls translation end-to-end.
 *
 * Uses a real OwlCoda HTTP server + mock router backend.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'node:http'
import { startServer } from '../src/server.js'
import type { OwlCodaConfig } from '../src/config.js'
import { resetCache } from '../src/response-cache.js'
import { resetRateLimits } from '../src/middleware/rate-limit.js'
import { resetBudgets } from '../src/error-budget.js'

// ─── Mock Router ───

let mockRouter: http.Server
let mockRouterPort: number
let lastRouterBody: Record<string, unknown> | null = null
let mockRouterHandler: ((req: http.IncomingMessage, res: http.ServerResponse) => void) | null = null

function startMockRouter(): Promise<void> {
  return new Promise(resolve => {
    mockRouter = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try { lastRouterBody = JSON.parse(Buffer.concat(chunks).toString()) } catch { lastRouterBody = null }

        // Probe endpoints: return proper responses for protocol detection
        const url = req.url ?? '/'
        if (url === '/v1/runtime/status') {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end('{"error":"not found"}')
          return
        }
        if (url === '/v1/models') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'test-backend' }] }))
          return
        }

        if (mockRouterHandler) {
          mockRouterHandler(req, res)
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl-tool', object: 'chat.completion',
            model: lastRouterBody?.model ?? 'test',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_abc123',
                  type: 'function',
                  function: { name: 'Bash', arguments: '{"command":"ls -la"}' },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
          }))
        }
      })
    })
    mockRouter.listen(0, '127.0.0.1', () => {
      const addr = mockRouter.address()
      mockRouterPort = typeof addr === 'object' && addr ? addr.port : 0
      resolve()
    })
  })
}

// ─── OwlCoda Server ───

let owlcodaServer: http.Server
let owlcodaPort: number

function makeConfig(): OwlCodaConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    routerUrl: `http://127.0.0.1:${mockRouterPort}`,
    routerTimeoutMs: 5000,
    models: [
      { id: 'test-model', label: 'Test Model', backendModel: 'test-model', aliases: ['default', 'balanced'], tier: 'production', default: true },
    ],
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: 'test-model',
    reverseMapInResponse: true,
    logLevel: 'error',
    middleware: {},
  } as OwlCodaConfig
}

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const response = await fetch(`http://127.0.0.1:${owlcodaPort}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try { parsed = JSON.parse(text) } catch { parsed = { _raw: text } }
  return { status: response.status, body: parsed, headers: response.headers }
}

beforeAll(async () => {
  await startMockRouter()
  const config = makeConfig()
  owlcodaServer = startServer(config)
  await new Promise<void>(resolve => {
    owlcodaServer.on('listening', () => {
      owlcodaPort = (owlcodaServer.address() as { port: number }).port
      resolve()
    })
  })
})

afterAll(() => {
  owlcodaServer?.close()
  mockRouter?.close()
})

beforeEach(() => {
  mockRouterHandler = null
  lastRouterBody = null
  resetCache()
  resetRateLimits()
  resetBudgets()
})

describe('proxy — tool call round-trip', () => {
  it('translates Anthropic tool definitions to OpenAI format', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }))
    }

    await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'List files' }],
      max_tokens: 1024,
      tools: [
        { name: 'Bash', description: 'Run a bash command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
        { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      ],
    })

    expect(lastRouterBody).toBeTruthy()
    const tools = lastRouterBody!.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>
    expect(tools).toHaveLength(2)
    expect(tools[0]!.type).toBe('function')
    expect(tools[0]!.function.name).toBe('Bash')
    expect(tools[0]!.function.parameters).toEqual({ type: 'object', properties: { command: { type: 'string' } }, required: ['command'] })
  })

  it('returns tool_use blocks from OpenAI tool_calls response', async () => {
    // Default handler returns tool_calls
    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'Run ls' }],
      max_tokens: 1024,
    })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('message')
    expect(res.body.stop_reason).toBe('tool_use')

    const content = res.body.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>
    expect(content).toHaveLength(1)
    expect(content[0]!.type).toBe('tool_use')
    expect(content[0]!.id).toBe('call_abc123')
    expect(content[0]!.name).toBe('Bash')
    expect(content[0]!.input).toEqual({ command: 'ls -la' })
  })

  it('translates tool_result messages to OpenAI format', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-2', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Files listed.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 3, total_tokens: 33 },
      }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [
        { role: 'user', content: 'Run ls' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc123', name: 'Bash', input: { command: 'ls' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_abc123', content: 'file1.txt\nfile2.txt' }] },
      ],
      max_tokens: 1024,
    })

    expect(res.status).toBe(200)
    expect(res.body.type).toBe('message')

    // Verify the forwarded request translated tool_result correctly
    expect(lastRouterBody).toBeTruthy()
    const messages = lastRouterBody!.messages as Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }>
    // Should have: user, assistant (with tool_calls), tool (result)
    expect(messages.length).toBeGreaterThanOrEqual(3)
  })

  it('handles multiple tool calls in single response', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-multi', object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
              { id: 'call_2', type: 'function', function: { name: 'Read', arguments: '{"path":"README.md"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
      }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'Check directory and readme' }],
      max_tokens: 1024,
    })

    expect(res.status).toBe(200)
    const content = res.body.content as Array<{ type: string; name?: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe('tool_use')
    expect(content[0]!.name).toBe('Bash')
    expect(content[1]!.type).toBe('tool_use')
    expect(content[1]!.name).toBe('Read')
  })

  it('handles text + tool_calls mixed response', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-mixed', object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'I\'ll run that for you.',
            tool_calls: [
              { id: 'call_mix', type: 'function', function: { name: 'Bash', arguments: '{"command":"date"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'What time is it?' }],
      max_tokens: 1024,
    })

    expect(res.status).toBe(200)
    const content = res.body.content as Array<{ type: string; text?: string; name?: string }>
    expect(content).toHaveLength(2)
    expect(content[0]!.type).toBe('text')
    expect(content[0]!.text).toBe('I\'ll run that for you.')
    expect(content[1]!.type).toBe('tool_use')
  })
})

describe('proxy — model resolution', () => {
  it('resolves configured alias to configured model', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-alias', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }))
    }

    await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })

    expect(lastRouterBody).toBeTruthy()
    expect(lastRouterBody!.model).toBe('test-model')
  })

  it('response model name reflects configured ID', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-name', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    })

    expect(res.body.model).toBe('test-model')
  })
})

describe('proxy — usage tracking', () => {
  it('preserves token counts through translation', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-usage', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'counted' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
      }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 100,
    })

    const usage = res.body.usage as { input_tokens: number; output_tokens: number }
    expect(usage.input_tokens).toBe(123)
    expect(usage.output_tokens).toBe(45)
  })

  it('defaults to 0 when upstream has no usage', async () => {
    mockRouterHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-nousage', object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'no usage' }, finish_reason: 'stop' }],
      }))
    }

    const res = await post('/v1/messages', {
      model: 'default',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 100,
    })

    const usage = res.body.usage as { input_tokens: number; output_tokens: number }
    expect(usage.input_tokens).toBe(0)
    expect(usage.output_tokens).toBe(0)
  })
})
