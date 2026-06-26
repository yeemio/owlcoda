import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import { startServer } from '../src/server.js'
import type { OwlCodaConfig } from '../src/config.js'

let backend: http.Server
let backendUrl = ''
let app: http.Server
let appUrl = ''
const backendBodies: any[] = []

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => { raw += chunk.toString() })
    req.on('end', () => resolve(raw))
  })
}

beforeAll(async () => {
  backend = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    backendBodies.push(JSON.parse(raw))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '{"artifact":"evidence-digest.v1","summary":"Endpoint digest","confidence":0.88}',
        },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    }))
  })
  await new Promise<void>(resolve => backend.listen(0, '127.0.0.1', resolve))
  const backendAddr = backend.address() as { port: number }
  backendUrl = `http://127.0.0.1:${backendAddr.port}`

  const config: OwlCodaConfig = {
    port: 0,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:9999',
    routerTimeoutMs: 5000,
    models: [
      {
        id: 'test-model',
        label: 'Test Model',
        backendModel: 'upstream-model',
        aliases: [],
        tier: 'general',
        default: true,
        endpoint: `${backendUrl}/v1/chat/completions`,
      },
    ],
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'error',
    contextWindow: 32768,
  } as unknown as OwlCodaConfig

  app = startServer(config)
  await new Promise<void>(resolve => app.once('listening', resolve))
  const appAddr = app.address() as { port: number }
  appUrl = `http://127.0.0.1:${appAddr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => app.close(() => resolve()))
  await new Promise<void>(resolve => backend.close(() => resolve()))
})

describe('/v1/structured-output', () => {
  it('routes through the configured model and returns a structured artifact response', async () => {
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        schema: {
          type: 'object',
          required: ['artifact', 'summary', 'confidence'],
          properties: {
            artifact: { const: 'evidence-digest.v1' },
            summary: { type: 'string' },
            confidence: { type: 'number' },
          },
        },
        user: 'Digest this.',
        maxTokens: 500,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.schemaValid).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Endpoint digest',
      confidence: 0.88,
    })
    expect(body.attempts.map((a: any) => a.label)).toEqual(['primary', 'parse'])
    expect(backendBodies).toHaveLength(1)
    expect(backendBodies[0].model).toBe('upstream-model')
    expect(backendBodies[0].temperature).toBeUndefined()
    expect(backendBodies[0].messages[0].role).toBe('system')
    expect(backendBodies[0].messages[0].content).toContain('Return exactly one short JSON object')
  })
})
