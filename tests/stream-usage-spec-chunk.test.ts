import { describe, it, expect } from 'vitest'
import { StreamTranslator } from '../src/translate/stream.js'

// Per the OpenAI streaming spec, usage is delivered (when stream_options
// include_usage is set) in a TRAILING chunk whose `choices` is []. The translator
// bailed on `if (!choice) return []` before capturing chunk.usage, so for any
// spec-conformant upstream (vLLM, OpenAI itself) the real input/output/cache was
// dropped and getFinalUsage fell back to char/4 estimates.
describe('StreamTranslator — spec-form usage-only chunk (choices: [])', () => {
  it('captures usage from a trailing chunk whose choices is empty', () => {
    const t = new StreamTranslator('default', 999) // estimate, deliberately != real
    t.processLine(JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }))
    t.processLine(JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 30, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 20 } },
    }))
    const u = t.getFinalUsage()
    expect(u.outputTokens).toBe(50)
    expect(u.inputTokens).toBe(10) // prompt(30) - cached(20), kept disjoint
    expect(u.cacheReadTokens).toBe(20)
  })
})
