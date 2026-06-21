import { describe, expect, it, vi } from 'vitest'

import { runJudgeBackendProbe } from '../../src/native/judge-backend-probe.js'

describe('judge backend probe', () => {
  it('classifies empty, malformed, and timeout responses separately and selects a reliable fallback', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ content: string }> }
      const prompt = body.messages.at(-1)?.content ?? ''

      if (body.model === 'mimo-v2.5-pro' && prompt.includes('probe-1')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
      }
      if (body.model === 'mimo-v2.5-pro' && prompt.includes('probe-2')) {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] }), { status: 200 })
      }
      if (body.model === 'mimo-v2.5-pro' && prompt.includes('probe-3')) {
        const err = new Error('The operation was aborted')
        err.name = 'AbortError'
        throw err
      }

      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"score":1,"reason":"ok"}' } }],
      }), { status: 200 })
    })

    const result = await runJudgeBackendProbe({
      endpoint: 'http://127.0.0.1:8019/v1/chat/completions',
      models: ['mimo-v2.5-pro', 'kimi-code'],
      prompts: ['probe-1', 'probe-2', 'probe-3'],
      timeoutMs: 50,
    }, {
      fetch: fetchMock as unknown as typeof fetch,
      now: fakeClock([0, 5, 10, 20, 30, 60, 70, 90, 100, 120, 130, 160]),
    })

    expect(result.recommendedModel).toBe('kimi-code')
    expect(result.models['mimo-v2.5-pro']).toMatchObject({
      total: 3,
      jsonOk: 0,
      emptyResponse: 1,
      malformedJson: 1,
      timeout: 1,
      status: 'unhealthy',
    })
    expect(result.models['kimi-code']).toMatchObject({
      total: 3,
      jsonOk: 3,
      emptyResponse: 0,
      malformedJson: 0,
      timeout: 0,
      status: 'healthy',
    })
  })
})

function fakeClock(values: number[]): () => number {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)] ?? 0
}
