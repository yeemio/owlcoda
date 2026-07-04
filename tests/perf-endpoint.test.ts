/**
 * Tests for GET /v1/perf endpoint.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { handlePerf } from '../src/endpoints/perf.js'
import { recordRequestMetrics, resetModelMetrics } from '../src/perf-tracker.js'
import { auditRequest, resetAudit } from '../src/audit-log.js'

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
  resetAudit()
})

describe('GET /v1/perf', () => {
  it('returns empty data when no metrics recorded', () => {
    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    expect(res._statusCode).toBe(200)
    const body = JSON.parse(res._body)
    expect(body.data).toEqual([])
  })

  it('returns metrics for recorded models', () => {
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 1000, outputTokens: 500, durationMs: 400, success: true })
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 2000, outputTokens: 1000, durationMs: 600, success: true })

    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    const body = JSON.parse(res._body)

    expect(body.data).toHaveLength(1)
    const m = body.data[0]
    expect(m.model_id).toBe('model-a')
    expect(m.request_count).toBe(2)
    expect(m.avg_duration_ms).toBe(500)
    expect(m.success_rate).toBe(1)
  })

  it('sorts by request count descending', () => {
    recordRequestMetrics({ modelId: 'less-used', inputTokens: 100, outputTokens: 50, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'more-used', inputTokens: 100, outputTokens: 50, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'more-used', inputTokens: 100, outputTokens: 50, durationMs: 100, success: true })

    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0].model_id).toBe('more-used')
    expect(body.data[1].model_id).toBe('less-used')
  })

  it('includes timestamps', () => {
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })

    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0].first_request_at).toBeTruthy()
    expect(body.data[0].last_request_at).toBeTruthy()
  })

  it('computes output TPS correctly', () => {
    // 200 output tokens in 1000ms = 200 tok/s
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 100, outputTokens: 200, durationMs: 1000, success: true })

    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0].avg_output_tps).toBe(200)
  })

  it('reports success rate with failures', () => {
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: false })

    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0].success_rate).toBe(0.5)
  })

  it('exposes usable output quality separately from HTTP success', () => {
    recordRequestMetrics({ modelId: 'qwen-local', inputTokens: 100, outputTokens: 2, durationMs: 100, success: true })
    recordRequestMetrics({ modelId: 'qwen-local', inputTokens: 100, outputTokens: 0, durationMs: 1000, success: true })
    recordRequestMetrics({ modelId: 'qwen-local', inputTokens: 100, outputTokens: 20, durationMs: 30_000, success: true })

    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0]).toMatchObject({
      model_id: 'qwen-local',
      success_rate: 1,
      usable_output_rate: 0,
      zero_output_count: 1,
      thin_output_count: 1,
      slow_output_count: 1,
    })
    expect(body.warnings).toContain('model_output_quality_degraded')
  })

  it('exposes gateway audit health so auth failures cannot hide behind model success rate', () => {
    recordRequestMetrics({ modelId: 'model-a', inputTokens: 100, outputTokens: 50, durationMs: 200, success: true })
    auditRequest({ method: 'POST', path: '/v1/messages', model: '/v1/messages', statusCode: 200, durationMs: 20 })
    auditRequest({ method: 'POST', path: '/v1/messages', model: '/v1/messages', statusCode: 401, durationMs: 10 })

    const { req, res } = createMockReqRes()
    handlePerf(req, res)
    const body = JSON.parse(res._body)

    expect(body.data[0].success_rate).toBe(1)
    expect(body.gateway).toMatchObject({
      total_entries: 2,
      error_count: 1,
      auth_failure_count: 1,
      gateway_success_rate: 0.5,
      status_counts: { '200': 1, '401': 1 },
    })
    expect(body.warnings).toContain('gateway_auth_failures_present')
  })
})
