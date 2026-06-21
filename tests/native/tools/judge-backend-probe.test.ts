import { afterEach, describe, expect, it, vi } from 'vitest'

import { createJudgeBackendProbeTool } from '../../../src/native/tools/judge-backend-probe.js'

describe('JudgeBackendProbe tool', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs fixed judge prompts and returns machine-readable fallback telemetry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '{"score":1,"reason":"ok"}' } }],
      }), { status: 200 }),
    ))

    const result = await createJudgeBackendProbeTool().execute({
      endpoint: 'http://127.0.0.1:8019/v1/chat/completions',
      models: ['kimi-code'],
      prompts: ['probe-a', 'probe-b', 'probe-c'],
      timeoutMs: 100,
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('recommended_model=kimi-code')
    expect(result.output).toContain('json_ok=3/3')
    expect(result.metadata?.['result']).toMatchObject({
      recommendedModel: 'kimi-code',
    })
  })
})
