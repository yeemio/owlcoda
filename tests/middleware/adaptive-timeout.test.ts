/**
 * Unit tests for the adaptive timeout helper.
 *
 * Goal: lock the contract small=base / medium=+120s / large=+300s /
 * disable=base / cap=cap, and verify the body estimator handles the
 * shapes that actually fly across /v1/messages.
 */
import { describe, it, expect } from 'vitest'
import {
  computeAdaptiveTimeoutMs,
  estimateInputChars,
  estimateInputTokens,
  DEFAULT_ADAPTIVE_EXTENSION_PER_10K_MS,
  DEFAULT_ADAPTIVE_CAP_MS,
  type EstimatableBody,
} from '../../src/middleware/adaptive-timeout.js'

function repeat(c: string, n: number): string {
  return c.repeat(n)
}

describe('estimateInputChars — body shape coverage', () => {
  it('counts string system + string-content messages', () => {
    const body: EstimatableBody = {
      system: 'sys-prompt-' + repeat('a', 100),
      messages: [{ role: 'user', content: repeat('b', 200) }],
    }
    expect(estimateInputChars(body)).toBe(11 + 100 + 200)
  })

  it('counts system-as-array (text blocks)', () => {
    const body: EstimatableBody = {
      system: [
        { type: 'text', text: 'abcde' },
        { type: 'text', text: 'fghij' },
      ],
    }
    expect(estimateInputChars(body)).toBe(10)
  })

  it('counts text content blocks inside messages', () => {
    const body: EstimatableBody = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      }],
    }
    expect(estimateInputChars(body)).toBe(10)
  })

  it('counts tool_result string content', () => {
    const body: EstimatableBody = {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'x', content: 'result-output-' + repeat('z', 50) }],
      }],
    }
    expect(estimateInputChars(body)).toBe(14 + 50)
  })

  it('counts tool_result array-of-blocks content', () => {
    const body: EstimatableBody = {
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'x',
          content: [
            { type: 'text', text: 'a'.repeat(30) },
            { type: 'text', text: 'b'.repeat(40) },
          ],
        }],
      }],
    }
    expect(estimateInputChars(body)).toBe(70)
  })

  it('counts tool_use input as serialized JSON length', () => {
    const body: EstimatableBody = {
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x', name: 'edit', input: { path: '/foo/bar', text: 'abc' } }],
      }],
    }
    const expected = JSON.stringify({ path: '/foo/bar', text: 'abc' }).length
    expect(estimateInputChars(body)).toBe(expected)
  })

  it('ignores unknown / malformed entries safely', () => {
    const body = {
      system: 42,                      // not a string or array
      messages: [
        null,
        { role: 'user' },              // no content
        { role: 'user', content: 99 }, // content not string/array
        { role: 'user', content: [null, { type: 'image' }, { type: 'text', text: 'real' }] },
      ],
    } as unknown as EstimatableBody
    expect(estimateInputChars(body)).toBe(4)
  })

  it('handles empty body', () => {
    expect(estimateInputChars({})).toBe(0)
  })
})

describe('estimateInputTokens', () => {
  it('divides chars by 4 (ceiling)', () => {
    expect(estimateInputTokens({ system: 'a' })).toBe(1)
    expect(estimateInputTokens({ system: 'a'.repeat(4) })).toBe(1)
    expect(estimateInputTokens({ system: 'a'.repeat(5) })).toBe(2)
    expect(estimateInputTokens({ system: 'a'.repeat(40_000) })).toBe(10_000)
  })
})

describe('computeAdaptiveTimeoutMs — disable path', () => {
  it('returns baseMs unchanged when adaptiveTimeoutEnabled=false', () => {
    const body: EstimatableBody = { system: 'a'.repeat(200_000) }  // 50K tokens
    const result = computeAdaptiveTimeoutMs({
      baseMs: 120_000,
      body,
      middleware: { adaptiveTimeoutEnabled: false },
    })
    expect(result.timeoutMs).toBe(120_000)
    expect(result.extensionMs).toBe(0)
    expect(result.estimatedInputTokens).toBe(0)
    expect(result.cappedAtMaxMs).toBe(false)
  })

  it('defaults to enabled when flag is missing', () => {
    const body: EstimatableBody = { system: 'a'.repeat(120_000) }  // 30K tokens
    const result = computeAdaptiveTimeoutMs({
      baseMs: 120_000,
      body,
      middleware: {},
    })
    // 30K tokens / 10K = 3 blocks * 90s (0.14.3 default) = +270s → 390_000
    expect(result.timeoutMs).toBe(390_000)
    expect(result.extensionMs).toBe(270_000)
  })

  it('defaults to enabled when middleware is undefined', () => {
    const body: EstimatableBody = { system: 'a'.repeat(120_000) }
    const result = computeAdaptiveTimeoutMs({ baseMs: 120_000, body, middleware: undefined })
    // 30K tokens × 90s (0.14.3 default) = 270s extension, base 120s → 390_000
    expect(result.timeoutMs).toBe(390_000)
  })
})

describe('computeAdaptiveTimeoutMs — scaling tiers', () => {
  it('small input (<10K tokens) returns baseMs (no extension)', () => {
    // 5K tokens = 20_000 chars
    const body: EstimatableBody = { system: 'a'.repeat(20_000) }
    const result = computeAdaptiveTimeoutMs({ baseMs: 120_000, body, middleware: {} })
    expect(result.estimatedInputTokens).toBe(5_000)
    expect(result.extensionMs).toBe(0)
    expect(result.timeoutMs).toBe(120_000)
  })

  it('medium input (17K tokens, original 0.14.1 user-reported case) extends by 1 block', () => {
    // 17K tokens = ~68K chars. 0.14.3: 1 block × 90s = +90s → 210_000
    const body: EstimatableBody = { system: 'a'.repeat(68_000) }
    const result = computeAdaptiveTimeoutMs({ baseMs: 120_000, body, middleware: {} })
    expect(result.estimatedInputTokens).toBe(17_000)
    expect(result.extensionMs).toBe(DEFAULT_ADAPTIVE_EXTENSION_PER_10K_MS)
    expect(result.timeoutMs).toBe(210_000)
  })

  it('33.7K tokens (the second user-reported case, 0.14.1 cut off at exactly 300s)', () => {
    // 33.7K ≈ 134_800 chars → 33_700 tokens → 3 full 10K blocks
    // 0.14.1 (60s/10K): 120 + 180 = 300s ← cut off at 300.5s
    // 0.14.3 (90s/10K): 120 + 270 = 390s ← 90s headroom over the failure point
    const body: EstimatableBody = { system: 'a'.repeat(134_800) }
    const result = computeAdaptiveTimeoutMs({ baseMs: 120_000, body, middleware: {} })
    expect(result.estimatedInputTokens).toBe(33_700)
    expect(result.timeoutMs).toBe(390_000)
  })

  it('large input (50K tokens) extends by 5 blocks', () => {
    // 0.14.3: 5 × 90s = +450s → 570_000 (still under 600s cap)
    const body: EstimatableBody = { system: 'a'.repeat(200_000) }
    const result = computeAdaptiveTimeoutMs({ baseMs: 120_000, body, middleware: {} })
    expect(result.estimatedInputTokens).toBe(50_000)
    expect(result.extensionMs).toBe(5 * DEFAULT_ADAPTIVE_EXTENSION_PER_10K_MS)
    expect(result.timeoutMs).toBe(570_000)
  })

  it('massive input (200K tokens) clamps at cap', () => {
    const body: EstimatableBody = { system: 'a'.repeat(800_000) }
    const result = computeAdaptiveTimeoutMs({ baseMs: 120_000, body, middleware: {} })
    expect(result.estimatedInputTokens).toBe(200_000)
    expect(result.cappedAtMaxMs).toBe(true)
    expect(result.timeoutMs).toBe(DEFAULT_ADAPTIVE_CAP_MS)
  })
})

describe('computeAdaptiveTimeoutMs — custom config', () => {
  it('honors custom extensionPer10kMs', () => {
    const body: EstimatableBody = { system: 'a'.repeat(40_000) }  // 10K tokens
    const result = computeAdaptiveTimeoutMs({
      baseMs: 120_000,
      body,
      middleware: { adaptiveTimeoutExtensionPer10kMs: 30_000 },  // 30s per 10K
    })
    expect(result.extensionMs).toBe(30_000)
    expect(result.timeoutMs).toBe(150_000)
  })

  it('honors custom cap', () => {
    const body: EstimatableBody = { system: 'a'.repeat(800_000) }  // 200K tokens
    const result = computeAdaptiveTimeoutMs({
      baseMs: 120_000,
      body,
      middleware: { adaptiveTimeoutCapMs: 300_000 },
    })
    expect(result.cappedAtMaxMs).toBe(true)
    expect(result.timeoutMs).toBe(300_000)
  })

  it('works for streaming first-token base (90s)', () => {
    const body: EstimatableBody = { system: 'a'.repeat(68_000) }  // 17K tokens
    const result = computeAdaptiveTimeoutMs({ baseMs: 90_000, body, middleware: {} })
    // 0.14.3: base 90s + 1 block × 90s = 180s
    expect(result.timeoutMs).toBe(180_000)
  })
})
