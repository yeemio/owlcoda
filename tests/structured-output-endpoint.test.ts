import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/server.js'
import { resetStructuredOutputIdempotencyForTesting } from '../src/endpoints/structured-output.js'
import type { OwlCodaConfig } from '../src/config.js'
import { createRunWorkspace, readArtifactLedger } from '../src/native/run-workspace.js'

let backend: http.Server
let backendUrl = ''
let app: http.Server
let appUrl = ''
const backendBodies: any[] = []
let hardBudgetUpstreamClosed = false

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let raw = ''
    req.on('data', chunk => { raw += chunk.toString() })
    req.on('end', () => resolve(raw))
  })
}

function bodyContains(body: any, marker: string): boolean {
  return JSON.stringify(body.messages ?? []).includes(marker)
}

function writeSseChunk(res: http.ServerResponse, body: Record<string, unknown> | '[DONE]'): void {
  res.write(`data: ${typeof body === 'string' ? body : JSON.stringify(body)}\n\n`)
}

function writeAnthropicSseChunk(res: http.ServerResponse, body: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(body)}\n\n`)
}

function openAiChunk(body: any, delta: Record<string, unknown>, finishReason: string | null = null, usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'chatcmpl-stream-test',
    object: 'chat.completion.chunk',
    model: body.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

async function writeAnthropicStreamingResponse(res: http.ServerResponse, body: any): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  writeAnthropicSseChunk(res, {
    type: 'message_start',
    message: {
      usage: { input_tokens: 17 },
    },
  })
  await sleep(10)
  writeAnthropicSseChunk(res, {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: '{"artifact":"evidence-digest.v1",' },
  })
  await sleep(10)
  writeAnthropicSseChunk(res, {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: '"summary":"Anthropic streaming digest",' },
  })
  await sleep(10)
  writeAnthropicSseChunk(res, {
    type: 'content_block_delta',
    delta: { type: 'text_delta', text: '"confidence":0.93}' },
  })
  writeAnthropicSseChunk(res, {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 10 },
  })
  writeAnthropicSseChunk(res, { type: 'message_stop' })
  res.end()
}

async function writeStreamingResponse(res: http.ServerResponse, body: any): Promise<void> {
  if (body.model === 'anthropic-upstream-model') {
    await writeAnthropicStreamingResponse(res, body)
    return
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream' })

  if (bodyContains(body, 'slow-active')) {
    writeSseChunk(res, openAiChunk(body, { role: 'assistant', content: '' }))
    await sleep(100)
    writeSseChunk(res, openAiChunk(body, { content: '{"artifact":"evidence-digest.v1",' }))
    await sleep(100)
    writeSseChunk(res, openAiChunk(body, { content: '"summary":"Slow streaming digest",' }))
    await sleep(100)
    writeSseChunk(res, openAiChunk(body, { content: '"confidence":0.92}' }))
    await sleep(100)
    writeSseChunk(res, openAiChunk(body, {}, 'stop', {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
    }))
    writeSseChunk(res, '[DONE]')
    res.end()
    return
  }

  if (bodyContains(body, 'thinking-only')) {
    writeSseChunk(res, openAiChunk(body, { role: 'assistant', content: '' }))
    await sleep(10)
    writeSseChunk(res, openAiChunk(body, { reasoning_content: 'thinking evidence kept' }))
    await sleep(80)
    writeSseChunk(res, openAiChunk(body, {}, 'stop', {
      prompt_tokens: 11,
      completion_tokens: 0,
      total_tokens: 11,
    }))
    writeSseChunk(res, '[DONE]')
    res.end()
    return
  }

  if (bodyContains(body, 'heartbeat-only')) {
    writeSseChunk(res, openAiChunk(body, { role: 'assistant', content: '' }))
    await sleep(80)
    writeSseChunk(res, openAiChunk(body, {}, 'stop', {
      prompt_tokens: 11,
      completion_tokens: 0,
      total_tokens: 11,
    }))
    writeSseChunk(res, '[DONE]')
    res.end()
    return
  }

  if (bodyContains(body, 'partial-interrupt')) {
    writeSseChunk(res, openAiChunk(body, { role: 'assistant', content: '' }))
    writeSseChunk(res, openAiChunk(body, { content: '{"artifact":"evidence-digest.v1","summary":"partial stream' }))
    await sleep(10)
    res.destroy(new Error('simulated provider stream interruption'))
    return
  }

  writeSseChunk(res, openAiChunk(body, { role: 'assistant', content: '' }))
  await sleep(10)
  writeSseChunk(res, openAiChunk(body, { content: '{"artifact":"evidence-digest.v1",' }))
  await sleep(10)
  writeSseChunk(res, openAiChunk(body, { content: '"summary":"Streaming digest",' }))
  await sleep(10)
  writeSseChunk(res, openAiChunk(body, { content: '"confidence":0.91}' }))
  writeSseChunk(res, openAiChunk(body, {}, 'stop', {
    prompt_tokens: 13,
    completion_tokens: 9,
    total_tokens: 22,
    prompt_tokens_details: { cached_tokens: 2 },
  }))
  writeSseChunk(res, '[DONE]')
  res.end()
}

beforeAll(async () => {
  backend = http.createServer(async (req, res) => {
    const raw = await readBody(req)
    const body = JSON.parse(raw)
    backendBodies.push(body)
    if (bodyContains(body, 'Task hard abort probe')) {
      res.on('close', () => {
        if (!res.writableEnded) hardBudgetUpstreamClosed = true
      })
      await sleep(200)
      if (res.destroyed) return
    }
    if (body.stream === true) {
      await writeStreamingResponse(res, body)
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const outputBudgetExhausted = bodyContains(body, 'Budget exhaustion persistence probe')
    const content = bodyContains(body, 'Repair count probe')
      ? '```json\n{"artifact":"evidence-digest.v1","summary":"Repaired digest","confidence":0.66,}\n```'
      : bodyContains(body, 'Salvage count probe')
        ? 'artifact: evidence-digest.v1\nsummary: Salvaged digest\nconfidence: 0.58\n{broken'
      : outputBudgetExhausted
      ? '{"artifact":"evidence-digest.v1","summary":"Truncated before confidence"}'
      : bodyContains(body, 'OwlFootball custom contract example')
      ? '{"artifact":"owlfootball-evidence.v2","summary":"业务证据摘要。","confidence":0.88,"source_refs":[],"risks":[],"data_gaps":[]}'
      : bodyContains(body, 'Nested schema transport probe')
        ? '{"artifact":"nested-contract.v2","summary":"Nested schema.","evidence":{"status":"confirmed","sources":[{"kind":"report","label":"Primary"}]}}'
      : bodyContains(body, 'Built-in documentation example')
        ? '{"artifact":"evidence-digest.v1","summary":"简短的证据摘要。","confidence":0.88}'
        : '{"artifact":"evidence-digest.v1","summary":"Endpoint digest","confidence":0.88}'
    if (body.model === 'anthropic-nonstream-upstream') {
      res.end(JSON.stringify({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: content }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }))
      return
    }
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: outputBudgetExhausted ? 'length' : 'stop',
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
        supportsStreaming: true,
      },
      {
        id: 'kimi-matrix-model',
        label: 'Kimi Matrix Model',
        backendModel: 'upstream-model',
        aliases: [],
        tier: 'general',
        endpoint: `${backendUrl}/v1/chat/completions`,
        supportsStructuredOutput: true,
        supportsStreaming: false,
      },
      {
        id: 'anthropic-stream-model',
        label: 'Anthropic Stream Model',
        backendModel: 'anthropic-upstream-model',
        aliases: [],
        tier: 'general',
        endpoint: `${backendUrl}/v1/messages`,
        supportsStreaming: true,
      },
      {
        id: 'anthropic-nonstream-model',
        label: 'Anthropic Non-stream Model',
        backendModel: 'anthropic-nonstream-upstream',
        aliases: [],
        tier: 'general',
        endpoint: `${backendUrl}/v1/messages`,
        supportsStructuredOutput: true,
        supportsStreaming: false,
      },
      {
        id: 'non-streaming-model',
        label: 'Non Streaming Model',
        backendModel: 'non-streaming-upstream-model',
        aliases: [],
        tier: 'general',
        endpoint: `${backendUrl}/v1/chat/completions`,
        supportsStructuredOutput: true,
        supportsStreaming: false,
      },
      {
        id: 'prose-only-model',
        label: 'Prose Only Model',
        backendModel: 'prose-only-upstream-model',
        aliases: [],
        tier: 'general',
        endpoint: `${backendUrl}/v1/chat/completions`,
        supportsStructuredOutput: false,
      } as any,
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
    expect(backendBodies[0].messages[0].role).toBe('system')
    expect(backendBodies[0].messages[0].content).toContain('Return exactly one short JSON object')
    expect(backendBodies[0].messages[0].content).toContain('Required top-level keys: artifact, summary, confidence')
    expect(backendBodies[0].messages[0].content).toContain('Constant fields: artifact="evidence-digest.v1"')
    expect(backendBodies[0].response_format).toBeUndefined()
  })

  it('sends the full resolved nested schema to OpenAI-compatible upstream', async () => {
    const beforeCalls = backendBodies.length
    const schema = {
      type: 'object',
      required: ['artifact', 'summary', 'evidence'],
      additionalProperties: false,
      properties: {
        artifact: { const: 'nested-contract.v2' },
        summary: { type: 'string' },
        evidence: {
          type: 'object',
          required: ['status', 'sources'],
          additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['confirmed', 'rejected'] },
            sources: {
              type: 'array',
              items: {
                type: 'object',
                required: ['kind', 'label'],
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['report', 'dataset'] },
                  label: { type: 'string' },
                },
              },
            },
          },
        },
      },
    }
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'non-streaming-model',
        preset: 'nested-contract.v2',
        schemaId: 'nested-contract',
        schemaVersion: 'v2',
        schema,
        system: 'Return the nested contract as JSON.',
        policy: { maxArrayItems: 10, maxStringLength: 500 },
        maxTokens: 800,
        user: 'Nested schema transport probe',
      }),
    })

    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'nested-contract', strict: false, schema },
    })
  })

  it('sends the full resolved built-in schema to Anthropic Messages upstream', async () => {
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-nonstream-model',
        preset: 'evidence-digest.v1',
        user: 'Capture the Anthropic schema contract.',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(backendBodies.at(-1).output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: expect.objectContaining({
          type: 'object',
          required: ['artifact', 'summary', 'confidence'],
          properties: expect.objectContaining({ artifact: { const: 'evidence-digest.v1' } }),
        }),
      },
    })
  })

  it('streams provider chunks into structured output and records activity metadata', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        user: 'Digest this through provider streaming delta.',
        maxTokens: 500,
        idleTimeoutMs: 200,
        hardTimeoutMs: 1000,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.consumerReady).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Streaming digest',
      confidence: 0.91,
    })
    expect(body.rawText).toContain('Streaming digest')
    expect(body.lastOutputAt).toEqual(expect.any(String))
    expect(body.attempts[0]).toMatchObject({
      label: 'primary',
      streamingMode: 'streaming',
      streamDeltaSource: 'translated_sse',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).stream).toBe(true)
  })

  it('keeps streaming request alive when active text deltas cross the idle window', async () => {
    const beforeCalls = backendBodies.length
    const startedAt = Date.now()
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        user: 'slow-active structured output stream',
        maxTokens: 500,
        idleTimeoutMs: 300,
        hardTimeoutMs: 2000,
      }),
    })
    const elapsedMs = Date.now() - startedAt

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(elapsedMs).toBeGreaterThan(300)
    expect(body.ok).toBe(true)
    expect(body.consumerReady).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Slow streaming digest',
      confidence: 0.92,
    })
    expect(body.terminationKind).toBe('completed')
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).stream).toBe(true)
  })

  it('returns silent_timeout when provider stream emits no usable text delta', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        user: 'heartbeat-only structured output stream',
        maxTokens: 500,
        idleTimeoutMs: 30,
        hardTimeoutMs: 1000,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.consumerReady).toBe(false)
    expect(body.terminationKind).toBe('silent_timeout')
    expect(body.unusableReason).toBe('silent_timeout')
    expect(body.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      fallbackUsed: true,
      rawText: '',
      terminationKind: 'silent_timeout',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).stream).toBe(true)
  })

  it('preserves thinking-only stream evidence without counting it as usable output', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        user: 'thinking-only structured output stream',
        maxTokens: 500,
        idleTimeoutMs: 30,
        hardTimeoutMs: 1000,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.consumerReady).toBe(false)
    expect(body.terminationKind).toBe('silent_timeout')
    expect(body.rawText).toBe('')
    expect(body.rawThinkingText).toContain('thinking evidence kept')
    expect(body.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      fallbackUsed: true,
      rawText: '',
      rawThinkingText: expect.stringContaining('thinking evidence kept'),
      terminationKind: 'silent_timeout',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).stream).toBe(true)
  })

  it('preserves partial rawText when provider stream interrupts after text delta', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        user: 'partial-interrupt structured output stream',
        maxTokens: 500,
        idleTimeoutMs: 500,
        hardTimeoutMs: 1000,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.consumerReady).toBe(false)
    expect(body.terminationKind).toBe('provider_error')
    expect(body.rawText).toContain('partial stream')
    expect(body.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      fallbackUsed: true,
      rawText: expect.stringContaining('partial stream'),
      terminationKind: 'provider_error',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).stream).toBe(true)
  })

  it('streams Anthropic Messages SSE directly through the provider_sse path', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic-stream-model',
        preset: 'evidence-digest.v1',
        user: 'anthropic-provider-sse structured output stream',
        maxTokens: 500,
        idleTimeoutMs: 200,
        hardTimeoutMs: 1000,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.consumerReady).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Anthropic streaming digest',
      confidence: 0.93,
    })
    expect(body.attempts[0]).toMatchObject({
      streamingMode: 'streaming',
      streamDeltaSource: 'provider_sse',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).model).toBe('anthropic-upstream-model')
    expect(backendBodies.at(-1).stream).toBe(true)
  })

  it('keeps non-streaming JSON compatibility when streaming is unsupported', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'non-streaming-model',
        preset: 'evidence-digest.v1',
        user: 'Digest this with an idle timeout but no provider streaming support.',
        maxTokens: 500,
        idleTimeoutMs: 30,
        hardTimeoutMs: 1000,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.consumerReady).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'evidence-digest.v1',
      summary: 'Endpoint digest',
      confidence: 0.88,
    })
    expect(body.attempts[0]).toMatchObject({
      streamingMode: 'non_streaming',
      streamDeltaSource: 'none',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).model).toBe('non-streaming-upstream-model')
    expect(backendBodies.at(-1).stream).toBe(false)
  })

  it('passes caller-provided temperature through to the upstream provider', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        user: 'Digest this with provider-compatible controls.',
        maxTokens: 256,
        temperature: 1,
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.attempts[0]).toMatchObject({
      requestedTemperature: 1,
      appliedTemperature: 1,
      temperatureSource: 'request',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1).temperature).toBe(1)
  })

  it('sends the matched Kimi matrix controls to the real upstream request', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-matrix-model',
        preset: 'evidence-digest.v1',
        user: 'Resolve the Kimi effective request.',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect(backendBodies.at(-1)).toMatchObject({ max_tokens: 20_480, temperature: 0.2 })
    expect(body.providerMatrixProvenance).toMatchObject({
      providerMatrixEntryId: 'provider-preset-matrix.v1/evidence-digest.v1/kimi',
      matched: true,
      applied: true,
      appliedControls: expect.arrayContaining(['maxTokens', 'temperature', 'idleTimeoutMs', 'hardTimeoutMs', 'forceLocale']),
    })
  })

  it('rejects a built-in preset with a caller custom schema before upstream', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        schema: { type: 'object', required: ['custom'], properties: { custom: { type: 'string' } } },
        user: 'Reject this hybrid contract.',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('built-in preset cannot be combined with a custom schema')
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('rejects cross-contract built-in identity before upstream while allowing canonical identity', async () => {
    const beforeCalls = backendBodies.length
    const rejected = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-reasoner',
        preset: 'evidence-digest.v1',
        presetId: 'analyst-audit',
        presetVersion: 'v1',
        schemaId: 'custom-schema',
        schemaVersion: 'v9',
        user: 'Reject cross-contract identity.',
      }),
    })
    expect(rejected.status).toBe(400)
    expect((await rejected.json()).error.message).toContain('built-in preset identity conflicts with canonical contract')
    expect(backendBodies).toHaveLength(beforeCalls)

    const accepted = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'evidence-digest.v1',
        presetId: 'evidence-digest',
        presetVersion: 'v1',
        schemaId: 'evidence-digest',
        schemaVersion: 'v1',
        user: 'Accept canonical identity.',
      }),
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toMatchObject({
      presetId: 'evidence-digest',
      presetVersion: 'v1',
      schemaId: 'evidence-digest',
      schemaVersion: 'v1',
    })
    expect(backendBodies).toHaveLength(beforeCalls + 1)
  })

  it('rejects forged custom preset and built-in schema identities before upstream', async () => {
    const beforeCalls = backendBodies.length
    const customContract = {
      model: 'kimi-matrix-model',
      preset: 'owlfootball-evidence.v2',
      schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
      system: 'Return the caller schema.',
      policy: { maxArrayItems: 8 },
      maxTokens: 600,
      user: 'Reject forged custom identity.',
    }

    const forgedPreset = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...customContract,
        presetId: 'evidence-digest',
        presetVersion: 'v1',
        schemaId: 'owlfootball-evidence',
        schemaVersion: 'v2',
      }),
    })
    expect(forgedPreset.status).toBe(400)
    expect((await forgedPreset.json()).error.message).toContain('preset identity conflicts with canonical preset')

    const forgedSchema = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...customContract,
        schemaId: 'evidence-digest',
        schemaVersion: 'v1',
      }),
    })
    expect(forgedSchema.status).toBe(400)
    expect((await forgedSchema.json()).error.message).toContain('custom schema identity conflicts with built-in contract')
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('executes the built-in and OwlFootball custom documentation request contracts', async () => {
    const beforeCalls = backendBodies.length
    const builtIn = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-matrix-model',
        preset: 'evidence-digest.v1',
        system: 'Return only one JSON object. Do not include chain-of-thought.',
        user: 'Built-in documentation example',
        repairPolicy: { enabled: true, maxAttempts: 1 },
        salvagePolicy: { enabled: true, fields: ['artifact', 'summary', 'confidence', 'source_refs', 'risks'] },
        policy: { forbiddenPhrases: ['下注', '出票', '入串', 'EV', 'Kelly', 'fair odds'] },
      }),
    })
    expect(builtIn.status).toBe(200)
    expect(await builtIn.json()).toMatchObject({
      ok: true,
      presetId: 'evidence-digest',
      schemaId: 'evidence-digest',
      providerMatrixProvenance: { matched: true, applied: true },
    })
    expect(backendBodies.at(-1)).toMatchObject({ max_tokens: 20_480, temperature: 0.2 })

    const custom = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kimi-matrix-model',
        preset: 'owlfootball-evidence.v2',
        presetId: 'owlfootball-evidence',
        presetVersion: 'v2',
        schemaId: 'owlfootball-evidence-contract',
        schemaVersion: 'v2',
        schema: {
          type: 'object',
          required: ['artifact', 'summary', 'confidence', 'source_refs', 'risks'],
          properties: {
            artifact: { const: 'owlfootball-evidence.v2' },
            summary: { type: 'string' },
            confidence: { type: 'number' },
            source_refs: { type: 'array', items: { type: 'string' } },
            risks: { type: 'array', items: { type: 'string' } },
            data_gaps: { type: 'array', items: { type: 'string' } },
          },
        },
        system: 'Return only a compact JSON object. No chain-of-thought.',
        user: 'OwlFootball custom contract example',
        maxTokens: 1200,
        policy: { forbiddenPhrases: ['下注', '出票', '入串', 'EV', 'Kelly', 'fair odds'] },
      }),
    })
    expect(custom.status).toBe(200)
    expect(await custom.json()).toMatchObject({
      ok: true,
      presetId: 'owlfootball-evidence',
      presetVersion: 'v2',
      schemaId: 'owlfootball-evidence-contract',
      schemaVersion: 'v2',
      providerMatrixProvenance: { matched: false, applied: false },
    })
    expect(backendBodies.at(-1)).toMatchObject({ max_tokens: 1200 })
    expect(backendBodies).toHaveLength(beforeCalls + 2)
  })

  it('persists artifact and attempts into the RunWorkspace ledger when requested', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-ledger-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({
        outputRoot,
        cwd: dir,
        runId: 'run-structured-output-ledger',
      })

      const beforeCalls = backendBodies.length
      const res = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kimi-matrix-model',
          preset: 'evidence-digest.v1',
          user: 'Digest this and persist it.',
          maxTokens: 500,
          forceLocale: 'en-US',
          persist: true,
          runRef: outputRoot,
          role: 'evidence',
          threadId: 'thread-structured-output',
          turnId: 'turn-structured-output',
          taskId: 'task-structured-output',
          stepId: 'step-evidence',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.ok).toBe(true)
      expect(body.persisted).toBe(true)
      expect(body.artifactId).toMatch(/^structured-output-/)
      expect(body.attemptLedgerId).toBe(`${body.artifactId}-attempts`)
      expect(backendBodies).toHaveLength(beforeCalls + 1)

      const ledger = await readArtifactLedger(outputRoot)
      expect(ledger.artifacts).toHaveLength(2)
      const artifactRecord = ledger.artifacts.find(artifact => artifact.id === body.artifactId)!
      const attemptsRecord = ledger.artifacts.find(artifact => artifact.id === body.attemptLedgerId)!
      expect(artifactRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_artifact',
        threadId: 'thread-structured-output',
        turnId: 'turn-structured-output',
        runId: 'run-structured-output-ledger',
        taskId: 'task-structured-output',
        stepId: 'step-evidence',
        status: 'present',
      })
      expect(attemptsRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_attempts',
        runId: 'run-structured-output-ledger',
        participatesInFinal: false,
        status: 'present',
      })

      const artifactPayload = JSON.parse(await readFile(artifactRecord.path, 'utf8'))
      expect(artifactPayload).toMatchObject({
        version: 1,
        artifactKind: 'structured_output_artifact',
        role: 'evidence',
        model: 'kimi-matrix-model',
        preset: 'evidence-digest.v1',
        presetId: 'evidence-digest',
        presetVersion: 'v1',
        schemaId: 'evidence-digest',
        schemaVersion: 'v1',
        repairPolicyVersion: 'repair-policy.v1',
        providerMatrixVersion: 'provider-preset-matrix.v1',
        providerMatrixProvenance: {
          providerMatrixEntryId: 'provider-preset-matrix.v1/evidence-digest.v1/kimi',
          providerMatrixEntryHash: expect.stringMatching(/^sha256:/),
          matched: true,
          applied: true,
          appliedControls: expect.arrayContaining(['temperature', 'idleTimeoutMs', 'hardTimeoutMs']),
          overrides: {
            maxTokens: { source: 'request', value: 500, matrixValue: 20_480 },
            forceLocale: { source: 'request', value: 'en-US', matrixValue: 'zh-CN' },
          },
        },
        ok: true,
        usable: true,
        consumerReady: true,
        schemaValid: true,
        rawText: '{"artifact":"evidence-digest.v1","summary":"Endpoint digest","confidence":0.88}',
        artifact: {
          artifact: 'evidence-digest.v1',
          summary: 'Endpoint digest',
          confidence: 0.88,
        },
        artifactCompleteness: {
          expected: ['artifact', 'summary', 'confidence'],
          produced: ['artifact', 'summary', 'confidence'],
          missing: [],
          validationStatus: 'pass',
          fallbackStatus: 'none',
        },
        consumerReadiness: {
          consumerReady: true,
          blockers: [],
          requiredArtifactsMissing: [],
          fallbackUsed: false,
          usable: true,
        },
        capabilityGate: {
          ok: true,
          source: 'declared',
          requestedMaxTokens: 500,
          appliedMaxTokens: 500,
        },
      })
      expect(artifactPayload.requestFingerprint).toMatch(/^sha256:/)
      expect(artifactPayload.schemaHash).toMatch(/^sha256:/)

      const attemptsPayload = JSON.parse(await readFile(attemptsRecord.path, 'utf8'))
      expect(attemptsPayload).toMatchObject({
        version: 1,
        artifactKind: 'structured_output_attempts',
        artifactId: body.artifactId,
        attemptLedgerId: body.attemptLedgerId,
        presetId: 'evidence-digest',
        presetVersion: 'v1',
        schemaId: 'evidence-digest',
        schemaVersion: 'v1',
        providerMatrixProvenance: body.providerMatrixProvenance,
        capabilityGate: {
          ok: true,
          source: 'declared',
        },
      })
      expect(artifactPayload.providerMatrixProvenance).toEqual(body.providerMatrixProvenance)
      expect(attemptsPayload.providerMatrixProvenance).toEqual(body.providerMatrixProvenance)
      expect(attemptsPayload.attempts[0].providerMatrixProvenance).toEqual(body.providerMatrixProvenance)
      expect(attemptsPayload.attempts.map((attempt: any) => attempt.label)).toEqual(['primary', 'parse'])
      expect(attemptsPayload.executionCounts).toMatchObject({ providerCalls: 1, parseAttempts: 1, rerunAttempts: 0 })

      const eventsText = await readFile(join(outputRoot, '.owlcoda-run', 'events.jsonl'), 'utf8')
      expect(eventsText).toContain('structured_output_artifact_recorded')
      expect(eventsText).toContain(body.artifactId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists output_budget_exhausted in artifact and attempt receipts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-budget-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-output-budget' })
      const res = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'non-streaming-model',
          preset: 'evidence-digest.v1',
          user: 'Budget exhaustion persistence probe',
          maxTokens: 50,
          persist: true,
          runRef: outputRoot,
          role: 'evidence',
        }),
      })

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toMatchObject({
        ok: false,
        unusableReason: 'output_budget_exhausted',
        stopReason: 'max_tokens',
        persisted: true,
      })
      const ledger = await readArtifactLedger(outputRoot)
      const artifactRecord = ledger.artifacts.find(artifact => artifact.id === body.artifactId)!
      const attemptsRecord = ledger.artifacts.find(artifact => artifact.id === body.attemptLedgerId)!
      const artifactPayload = JSON.parse(await readFile(artifactRecord.path, 'utf8'))
      const attemptsPayload = JSON.parse(await readFile(attemptsRecord.path, 'utf8'))
      expect(artifactPayload).toMatchObject({
        unusableReason: 'output_budget_exhausted',
        stopReason: 'max_tokens',
        fallbackUsed: true,
      })
      expect(attemptsPayload.attempts.at(-1)).toMatchObject({
        label: 'fallback',
        failureReason: 'output_budget_exhausted',
        error: 'output_budget_exhausted',
        stopReason: 'max_tokens',
      })
      expect(attemptsPayload.failureReason).toBe('output_budget_exhausted')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects persist=true without runRef before calling upstream', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        user: 'Digest this.',
        persist: true,
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('runRef is required when persist=true')
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('rejects custom presets without an explicit schema before calling upstream', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        preset: 'custom-artifact.v1',
        user: 'Digest this.',
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.message).toContain('custom preset requires an explicit schema')
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('uses model capability routing to reject JSON-unsupported models before calling upstream', async () => {
    const beforeCalls = backendBodies.length
    const res = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'prose-only-model',
        preset: 'evidence-digest.v1',
        user: 'Digest this.',
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.fallbackUsed).toBe(true)
    expect(body.artifact).toMatchObject({
      artifact: 'failed_fallback.v1',
      failureReason: 'capability_json_unsupported',
      model: 'prose-only-model',
    })
    expect(body.capabilityGate).toMatchObject({
      ok: false,
      source: 'declared',
      errors: ['model capability jsonMode=unsupported source=declared'],
    })
    expect(backendBodies).toHaveLength(beforeCalls)
  })

  it('reruns a single role artifact from an inputRef and records lineage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-rerun-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({
        outputRoot,
        cwd: dir,
        runId: 'run-structured-output-rerun',
      })

      const first = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'shared-primary-rerun-key' },
        body: JSON.stringify({
          model: 'test-model',
          preset: 'evidence-digest.v1',
          user: 'Original long evidence payload.',
          maxTokens: 500,
          persist: true,
          runRef: outputRoot,
          role: 'evidence',
          threadId: 'thread-rerun',
          turnId: 'turn-original',
          taskId: 'task-rerun',
          stepId: 'step-evidence',
        }),
      })
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody.artifactId).toMatch(/^structured-output-/)

      const beforeRerunCalls = backendBodies.length
      const rerun = await fetch(`${appUrl}/v1/structured-output/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'shared-primary-rerun-key' },
        body: JSON.stringify({
          model: 'test-model',
          preset: 'evidence-digest.v1',
          maxTokens: 500,
          runRef: outputRoot,
          previousArtifactId: firstBody.artifactId,
          inputRef: firstBody.artifactId,
          role: 'evidence',
          threadId: 'thread-rerun',
          turnId: 'turn-rerun',
          taskId: 'task-rerun',
          stepId: 'step-evidence-rerun',
        }),
      })

      expect(rerun.status).toBe(200)
      const rerunBody = await rerun.json()
      expect(rerunBody).toMatchObject({
        ok: true,
        persisted: true,
        rerun: true,
        parentArtifactId: firstBody.artifactId,
        rerunOf: firstBody.artifactId,
      })
      expect(rerunBody.artifactId).toMatch(/^structured-output-/)
      expect(rerunBody.artifactId).not.toBe(firstBody.artifactId)
      expect(firstBody.idempotency.namespace).toBe('primary')
      expect(rerunBody.idempotency.namespace).toBe('rerun')
      expect(rerunBody.idempotency.replayed).toBe(false)
      expect(rerunBody.attemptLedgerId).toBe(`${rerunBody.artifactId}-attempts`)
      expect(rerunBody.executionCounts).toMatchObject({ providerCalls: 1, rerunAttempts: 1 })
      expect(backendBodies).toHaveLength(beforeRerunCalls + 1)
      const rerunUpstreamBody = backendBodies[backendBodies.length - 1]
      expect(JSON.stringify(rerunUpstreamBody.messages)).toContain(firstBody.artifactId)
      expect(JSON.stringify(rerunUpstreamBody.messages)).toContain('Endpoint digest')

      const ledger = await readArtifactLedger(outputRoot)
      expect(ledger.artifacts).toHaveLength(4)
      const rerunRecord = ledger.artifacts.find(artifact => artifact.id === rerunBody.artifactId)!
      const rerunAttemptsRecord = ledger.artifacts.find(artifact => artifact.id === rerunBody.attemptLedgerId)!
      expect(rerunRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_artifact',
        threadId: 'thread-rerun',
        turnId: 'turn-rerun',
        runId: 'run-structured-output-rerun',
        taskId: 'task-rerun',
        stepId: 'step-evidence-rerun',
        status: 'present',
      })
      expect(rerunRecord.factRefs?.coveredIds).toEqual(expect.arrayContaining([firstBody.artifactId]))
      expect(rerunAttemptsRecord).toMatchObject({
        origin: 'model_output_harness',
        artifactType: 'structured_output_attempts',
        participatesInFinal: false,
        status: 'present',
      })
      expect(rerunAttemptsRecord.factRefs?.coveredIds).toEqual(expect.arrayContaining([firstBody.artifactId, rerunBody.artifactId]))

      const rerunPayload = JSON.parse(await readFile(rerunRecord.path, 'utf8'))
      expect(rerunPayload).toMatchObject({
        artifactKind: 'structured_output_artifact',
        role: 'evidence',
        parentArtifactId: firstBody.artifactId,
        rerunOf: firstBody.artifactId,
        inputRef: firstBody.artifactId,
        rerun: {
          role: 'evidence',
          stepId: 'step-evidence-rerun',
          parentArtifactId: firstBody.artifactId,
          previousAttemptLedgerRef: `${firstBody.artifactId}-attempts`,
          reason: 'role_step_rerun',
        },
      })
      expect(rerunPayload.rerun.rerunId).toMatch(/^rerun-/)
      expect(rerunPayload.rerun.createdAt).toMatch(/\d{4}-\d{2}-\d{2}T/)
      expect(rerunPayload.factRefs.coveredIds).toEqual(expect.arrayContaining([firstBody.artifactId]))

      const attemptsPayload = JSON.parse(await readFile(rerunAttemptsRecord.path, 'utf8'))
      expect(attemptsPayload).toMatchObject({
        artifactKind: 'structured_output_attempts',
        artifactId: rerunBody.artifactId,
        parentArtifactId: firstBody.artifactId,
        rerunOf: firstBody.artifactId,
        rerun: {
          parentArtifactId: firstBody.artifactId,
          previousAttemptLedgerRef: `${firstBody.artifactId}-attempts`,
        },
      })
      expect(attemptsPayload.attempts.map((attempt: any) => attempt.label)).toEqual(['primary', 'parse'])
      expect(attemptsPayload.executionCounts).toMatchObject({ providerCalls: 1, parseAttempts: 1, rerunAttempts: 1 })

      const eventsText = await readFile(join(outputRoot, '.owlcoda-run', 'events.jsonl'), 'utf8')
      expect(eventsText).toContain('structured_output_artifact_rerun_recorded')
      expect(eventsText).toContain(firstBody.artifactId)
      expect(eventsText).toContain(rerunBody.artifactId)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects rerun requests without lineage or input before calling upstream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-rerun-invalid-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({
        outputRoot,
        cwd: dir,
        runId: 'run-structured-output-rerun-invalid',
      })

      const beforeCalls = backendBodies.length
      const missingLineage = await fetch(`${appUrl}/v1/structured-output/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          role: 'evidence',
          runRef: outputRoot,
          inputRef: 'structured-output-missing',
        }),
      })
      expect(missingLineage.status).toBe(400)
      expect((await missingLineage.json()).error.message).toContain('previousArtifactId is required')

      const missingInput = await fetch(`${appUrl}/v1/structured-output/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          role: 'evidence',
          runRef: outputRoot,
          previousArtifactId: 'structured-output-parent',
        }),
      })
      expect(missingInput.status).toBe(400)
      expect((await missingInput.json()).error.message).toContain('user, inputRef, or artifactRef is required')
      expect(backendBodies).toHaveLength(beforeCalls)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent and later requests with the same explicit idempotency key', async () => {
    const beforeCalls = backendBodies.length
    const request = () => fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'endpoint-idempotency-a' },
      body: JSON.stringify({ model: 'test-model', user: 'Idempotency primary probe' }),
    })

    const [first, concurrent] = await Promise.all([request(), request()])
    expect(first.status).toBe(200)
    expect(concurrent.status).toBe(200)
    const firstBody = await first.json()
    const concurrentBody = await concurrent.json()
    expect(backendBodies).toHaveLength(beforeCalls + 1)
    expect([firstBody.idempotency.replayed, concurrentBody.idempotency.replayed].sort()).toEqual([false, true])
    expect(concurrentBody.idempotency.requestHash).toBe(firstBody.idempotency.requestHash)

    const later = await request()
    expect(later.status).toBe(200)
    expect((await later.json()).idempotency.replayed).toBe(true)
    expect(backendBodies).toHaveLength(beforeCalls + 1)

    const conflict = await fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'endpoint-idempotency-a' },
      body: JSON.stringify({ model: 'test-model', user: 'Different request under the same key' }),
    })
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.type).toBe('idempotency_conflict')
    expect(backendBodies).toHaveLength(beforeCalls + 1)
  })

  it('replays a persisted idempotent result after the in-memory reservation cache is reset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-durable-idempotency-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-durable-idempotency' })
      const request = () => fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'durable-idempotency-key' },
        body: JSON.stringify({
          model: 'test-model',
          user: 'Durable idempotency probe',
          persist: true,
          runRef: outputRoot,
          taskId: 'task-durable-idempotency',
        }),
      })
      const beforeCalls = backendBodies.length
      const first = await request()
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody.idempotency.replayed).toBe(false)
      expect(backendBodies).toHaveLength(beforeCalls + 1)

      resetStructuredOutputIdempotencyForTesting()
      const replay = await request()
      expect(replay.status).toBe(200)
      const replayBody = await replay.json()
      expect(replayBody.idempotency.replayed).toBe(true)
      expect(replayBody.artifactId).toBe(firstBody.artifactId)
      expect(backendBodies).toHaveLength(beforeCalls + 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps unkeyed repeats intentional and reports independent execution counts', async () => {
    const beforeCalls = backendBodies.length
    const request = () => fetch(`${appUrl}/v1/structured-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        user: 'Intentional unkeyed repeat',
        intentionalRepeat: true,
      }),
    })
    const first = await request()
    const second = await request()
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(backendBodies).toHaveLength(beforeCalls + 2)
    expect((await first.json()).executionCounts).toEqual({
      providerCalls: 1,
      parseAttempts: 1,
      repairAttempts: 0,
      salvageAttempts: 0,
      rerunAttempts: 0,
    })
  })

  it('separates deterministic repair and salvage counts from provider calls', async () => {
    const request = async (user: string) => {
      const response = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', user }),
      })
      expect(response.status).toBe(200)
      return response.json()
    }

    const repaired = await request('Repair count probe')
    expect(repaired.executionCounts).toEqual({
      providerCalls: 1,
      parseAttempts: 1,
      repairAttempts: 1,
      salvageAttempts: 0,
      rerunAttempts: 0,
    })

    const salvaged = await request('Salvage count probe')
    expect(salvaged.executionCounts).toEqual({
      providerCalls: 1,
      parseAttempts: 1,
      repairAttempts: 0,
      salvageAttempts: 1,
      rerunAttempts: 0,
    })
  })

  it('enforces a cumulative task budget before the second provider call and persists a typed checkpoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-task-budget-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-task-budget' })
      const requestBody = {
        model: 'test-model',
        user: 'Task budget endpoint probe',
        persist: true,
        runRef: outputRoot,
        taskId: 'task-endpoint-budget',
        executionBudget: {
          maxProviderCalls: 1,
          maxInputTokens: 100_000,
          maxOutputTokens: 2_000,
          maxElapsedMs: 60_000,
        },
      }
      const beforeCalls = backendBodies.length
      const first = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      expect(first.status).toBe(200)
      const firstBody = await first.json()
      expect(firstBody.executionEconomics).toMatchObject({
        taskId: 'task-endpoint-budget',
        current: { providerCalls: 1, parseAttempts: 1 },
        cumulative: { providerCalls: 1, parseAttempts: 1 },
      })
      expect(firstBody.executionCounts).toMatchObject({ providerCalls: 1, parseAttempts: 1 })

      const second = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })
      expect(second.status).toBe(429)
      const secondBody = await second.json()
      expect(secondBody).toMatchObject({
        type: 'error',
        error: { type: 'task_budget_exhausted', dimension: 'provider_calls' },
      })
      expect(secondBody.error.stopReceipt.checkpointPath).toContain('execution-budget-stop-')
      expect(backendBodies).toHaveLength(beforeCalls + 1)

      const ledger = await readArtifactLedger(outputRoot)
      const artifact = ledger.artifacts.find(item => item.id === firstBody.artifactId)!
      const persisted = JSON.parse(await readFile(artifact.path, 'utf8'))
      expect(persisted.executionCounts).toMatchObject({ providerCalls: 1, parseAttempts: 1 })
      expect(persisted.executionEconomics.cumulative.providerCalls).toBe(1)
      const events = await readFile(join(outputRoot, '.owlcoda-run', 'events.jsonl'), 'utf8')
      expect(events).toContain('structured_output_task_budget_exhausted')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('applies the remaining task output budget to the upstream max token request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-budget-clamp-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-budget-clamp' })
      const response = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test-model',
          user: 'Budget clamp probe',
          maxTokens: 500,
          persist: true,
          runRef: outputRoot,
          taskId: 'task-budget-clamp',
          executionBudget: {
            maxProviderCalls: 3,
            maxInputTokens: 100_000,
            maxOutputTokens: 50,
            maxElapsedMs: 60_000,
          },
        }),
      })
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(backendBodies.at(-1).max_tokens).toBe(50)
      expect(body.capabilityGate.appliedMaxTokens).toBe(50)
      expect(body.executionEconomics.reservation.outputTokens).toBe(50)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('aborts the real upstream request when the remaining task elapsed budget expires', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-hard-budget-'))
    try {
      hardBudgetUpstreamClosed = false
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-hard-budget' })
      const response = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'non-streaming-model',
          user: 'Task hard abort probe',
          persist: true,
          runRef: outputRoot,
          taskId: 'task-hard-budget',
          executionBudget: {
            maxProviderCalls: 3,
            maxInputTokens: 100_000,
            maxOutputTokens: 2_000,
            maxElapsedMs: 40,
          },
        }),
      })
      expect(response.status).toBe(200)
      expect((await response.json()).terminationKind).toBe('hard_timeout')
      await sleep(30)
      expect(hardBudgetUpstreamClosed).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed or changing task budgets and keyed intentional repeats before upstream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'owlcoda-structured-output-budget-contract-'))
    try {
      const outputRoot = join(dir, 'run-output')
      await createRunWorkspace({ outputRoot, cwd: dir, runId: 'run-budget-contract' })
      const beforeCalls = backendBodies.length
      const base = {
        model: 'test-model',
        user: 'Budget contract validation probe',
        persist: true,
        runRef: outputRoot,
        taskId: 'task-budget-contract',
      }

      const malformed = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...base,
          executionBudget: {
            maxProviderCalls: 3,
            maxInputTokens: 100_000,
            maxOutputTokens: 5_000,
            maxElapsedMs: 60_000,
            maxCostUsd: 1,
          },
        }),
      })
      expect(malformed.status).toBe(400)
      expect((await malformed.json()).error.message).toContain('inputCostPerMillionUsd')

      const budget = {
        maxProviderCalls: 3,
        maxInputTokens: 100_000,
        maxOutputTokens: 5_000,
        maxElapsedMs: 60_000,
      }
      const first = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, executionBudget: budget }),
      })
      expect(first.status).toBe(200)

      const changed = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, executionBudget: { ...budget, maxProviderCalls: 4 } }),
      })
      expect(changed.status).toBe(409)
      expect((await changed.json()).error.type).toBe('task_budget_contract_mismatch')

      const contradictory = await fetch(`${appUrl}/v1/structured-output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'contradictory-repeat-key' },
        body: JSON.stringify({ model: 'test-model', user: 'Repeat contract', intentionalRepeat: true }),
      })
      expect(contradictory.status).toBe(400)
      expect((await contradictory.json()).error.message).toContain('intentionalRepeat')
      expect(backendBodies).toHaveLength(beforeCalls + 1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
