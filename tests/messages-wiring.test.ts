import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const messagesSource = readFileSync(join(__dirname, '..', 'src', 'endpoints', 'messages.ts'), 'utf-8')

describe('messages.ts retry wiring', () => {
  it('imports withRetry', () => {
    expect(messagesSource).toContain("import { withRetry }")
  })

  it('wraps non-streaming fetch with withRetry', () => {
    // Should find at least two withRetry calls (non-streaming + streaming)
    const matches = messagesSource.match(/withRetry\(\(\) => fetch\(/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })
})

describe('messages.ts rate-limit wiring', () => {
  it('imports checkRateLimit', () => {
    expect(messagesSource).toContain("import { checkRateLimit }")
  })

  it('calls checkRateLimit before forwarding', () => {
    const matches = messagesSource.match(/checkRateLimit\(route\.backendModel/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2) // non-streaming + streaming
  })

  it('returns 429 with Anthropic error shape when rate limited', () => {
    expect(messagesSource).toContain('rate_limit_error')
    expect(messagesSource).toContain('Retry-After')
  })
})

describe('messages.ts fallback wiring', () => {
  it('imports buildFallbackChain and withFallback', () => {
    expect(messagesSource).toContain('buildFallbackChain')
    expect(messagesSource).toContain('withFallback')
  })

  it('imports circuit breaker functions', () => {
    expect(messagesSource).toContain('recordSuccess')
    expect(messagesSource).toContain('recordFailure')
    expect(messagesSource).toContain('isCircuitOpen')
  })

  it('sets x-owlcoda-served-by header', () => {
    expect(messagesSource).toContain('x-owlcoda-served-by')
  })

  it('sets x-owlcoda-fallback header when fallback used', () => {
    expect(messagesSource).toContain('x-owlcoda-fallback')
  })
})

describe('messages.ts validation wiring', () => {
  it('imports validateMessagesBody', () => {
    expect(messagesSource).toContain('validateMessagesBody')
  })

  it('imports recordOutcome for error budget', () => {
    expect(messagesSource).toContain('recordOutcome')
  })

  it('reads middleware config', () => {
    expect(messagesSource).toContain('config.middleware')
  })

  it('respects fallbackEnabled config', () => {
    expect(messagesSource).toContain('fallbackEnabled')
  })

  it('imports createTrace for request tracing', () => {
    expect(messagesSource).toContain('createTrace')
  })

  it('sets x-owlcoda-duration-ms header', () => {
    expect(messagesSource).toContain('x-owlcoda-duration-ms')
  })
})

describe('messages.ts cloud model passthrough', () => {
  it('streaming cloud path preserves full Anthropic body via spread', () => {
    // Cloud models (!modelRoute.translate) should spread ...body to include system, tools, etc.
    expect(messagesSource).toContain('...body,')
  })

  it('streaming cloud path pipes raw bytes (no parseSSEStream)', () => {
    // Cloud SSE is already Anthropic format — pipe through raw, don't re-parse
    const streamFunc = messagesSource.slice(messagesSource.indexOf('handleMessagesStream'))
    expect(streamFunc).toContain('rawReader')
    expect(streamFunc).toContain('rawDecoder')
  })

  it('non-streaming cloud path uses spread for full body', () => {
    // Non-streaming cloud should also spread body (appears before the streaming handler)
    // The spread appears at least twice (non-streaming + streaming)
    const matches = messagesSource.match(/\.\.\.body,/g)
    expect(matches).not.toBeNull()
    expect(matches!.length).toBeGreaterThanOrEqual(2)
  })
})

describe('messages.ts streaming tracing', () => {
  it('creates trace in streaming path', () => {
    // handleMessagesStream should use createTrace
    const streamFunc = messagesSource.slice(messagesSource.indexOf('handleMessagesStream'))
    expect(streamFunc).toContain('createTrace')
  })

  it('marks stream_start phase', () => {
    expect(messagesSource).toContain("stream_start")
  })

  it('marks stream_end phase', () => {
    expect(messagesSource).toContain("stream_end")
  })

  it('logs structured output', () => {
    // Streaming path records durationMs from trace
    expect(messagesSource).toContain('durationMs')
  })
})
