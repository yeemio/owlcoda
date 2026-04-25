/**
 * Tests for GET /v1/cost endpoint.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { handleCost } from '../src/endpoints/cost.js'
import { recordRequestMetrics, resetModelMetrics } from '../src/perf-tracker.js'
import { resetTokenUsage, addTokenUsage } from '../src/trace.js'

function createMockReqRes(): { req: IncomingMessage; res: ServerResponse & { _body: string; _statusCode: number } } {
  const socket = new Socket()
  const req = new IncomingMessage(socket)
  const res = new ServerResponse(req) as ServerResponse & { _body: string; _statusCode: number }
  res._body = ''
  res._statusCode = 0

  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = function (statusCode: number, ...args: any[]) {
    res._statusCode = statusCode
    return origWriteHead(statusCode, ...args)
  } as any

  const origEnd = res.end.bind(res)
  res.end = function (chunk?: any) {
    if (chunk) res._body = typeof chunk === 'string' ? chunk : chunk.toString()
    return origEnd(chunk)
  } as any

  return { req, res }
}

beforeEach(() => {
  resetModelMetrics()
  resetTokenUsage()
})

describe('GET /v1/cost', () => {
  it('returns empty data with no metrics', () => {
    const { req, res } = createMockReqRes()
    handleCost(req, res)
    expect(res._statusCode).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.data).toEqual([])
    expect(body.total_cost).toBe(0)
    expect(body.session).toBeTruthy()
  })

  it('returns per-model cost breakdown', () => {
    recordRequestMetrics({ modelId: 'qwen2.5-7B', inputTokens: 5000, outputTokens: 2000, durationMs: 500, success: true })
    recordRequestMetrics({ modelId: 'llama3.3-70B', inputTokens: 3000, outputTokens: 1500, durationMs: 1200, success: true })

    const { req, res } = createMockReqRes()
    handleCost(req, res)
    const body = JSON.parse(res._body)

    expect(body.data).toHaveLength(2)
    expect(body.total_cost).toBeGreaterThan(0)
    expect(body.unit).toBe('¥')
    expect(body.data[0].model_id).toBeTruthy()
    expect(body.data[0].cost).toBeGreaterThanOrEqual(0)
    expect(body.data[0].source).toBeTruthy()
  })

  it('includes real TPS from perf data', () => {
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 100, outputTokens: 500, durationMs: 1000, success: true })

    const { req, res } = createMockReqRes()
    handleCost(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0].real_tps).toBe(500)
  })

  it('includes session token totals', () => {
    addTokenUsage(10000, 5000)
    addTokenUsage(3000, 1500)

    const { req, res } = createMockReqRes()
    handleCost(req, res)
    const body = JSON.parse(res._body)

    expect(body.session.total_input_tokens).toBe(13000)
    expect(body.session.total_output_tokens).toBe(6500)
    expect(body.session.request_count).toBe(2)
  })

  it('returns request_count per model', () => {
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 100, outputTokens: 50, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 200, outputTokens: 100, durationMs: 200, success: true })
    recordRequestMetrics({ modelId: 'model-7B', inputTokens: 300, outputTokens: 150, durationMs: 300, success: true })

    const { req, res } = createMockReqRes()
    handleCost(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0].request_count).toBe(3)
    expect(body.data[0].input_tokens).toBe(600)
    expect(body.data[0].output_tokens).toBe(300)
  })
})
