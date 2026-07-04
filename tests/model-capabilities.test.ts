import { describe, expect, it } from 'vitest'
import {
  resolveModelCapabilities,
  resolveVisionCapability,
} from '../src/model-capabilities.js'

describe('model vision capability', () => {
  it('marks Kimi K2.7 Code as image-input capable', () => {
    const capability = resolveVisionCapability({
      id: 'kimi-k2.7-code',
      backendModel: 'kimi-k2.7-code',
      provider: 'moonshot',
    })

    expect(capability.status).toBe('supported')
    expect(capability.inputImages).toBe(true)
    expect(capability.source).toBe('known')
    expect(capability.labels).toContain('vision')
  })

  it('respects explicit supportsImages config over inference', () => {
    const supported = resolveModelCapabilities({
      id: 'private-vl-model',
      backendModel: 'custom-model',
      supportsImages: true,
    })
    expect(supported.vision.status).toBe('supported')
    expect(supported.vision.source).toBe('configured')

    const disabled = resolveVisionCapability({
      id: 'kimi-k2.7-code',
      backendModel: 'kimi-k2.7-code',
      supportsImages: false,
    })
    expect(disabled.status).toBe('unsupported')
    expect(disabled.inputImages).toBe(false)
    expect(disabled.source).toBe('configured')
  })

  it('leaves unknown models as unknown instead of enabling images blindly', () => {
    const capability = resolveVisionCapability({
      id: 'text-only-ish',
      backendModel: 'some-provider-model',
    })

    expect(capability.status).toBe('unknown')
    expect(capability.inputImages).toBe(false)
    expect(capability.labels).toEqual([])
  })
})

describe('model structured output capability', () => {
  it('resolves configured structured output support and output token budget without provider-name rules', () => {
    const capabilities = resolveModelCapabilities({
      id: 'private-json-model',
      backendModel: 'private-json-model',
      contextWindow: 128_000,
      supportsStructuredOutput: true,
      maxOutputTokens: 640,
    } as any)

    expect(capabilities.structuredOutput).toMatchObject({
      jsonMode: { status: 'supported', source: 'declared' },
      maxContextTokens: { tokens: 128_000, source: 'declared' },
      maxOutputTokens: { tokens: 640, source: 'declared' },
      streaming: { status: 'unknown', source: 'fallback' },
      thinking: { behavior: 'unknown', source: 'fallback' },
    })
  })

  it('marks explicit structured output disablement as declared unsupported', () => {
    const capabilities = resolveModelCapabilities({
      id: 'prose-only-model',
      backendModel: 'prose-only-model',
      supportsStructuredOutput: false,
    } as any)

    expect(capabilities.structuredOutput.jsonMode).toMatchObject({
      status: 'unsupported',
      source: 'declared',
    })
  })

  it('respects explicit provider streaming support without provider-name rules', () => {
    const supported = resolveModelCapabilities({
      id: 'streaming-json-model',
      backendModel: 'streaming-json-model',
      supportsStreaming: true,
    })
    expect(supported.structuredOutput.streaming).toMatchObject({
      status: 'supported',
      source: 'declared',
    })

    const disabled = resolveModelCapabilities({
      id: 'non-streaming-json-model',
      backendModel: 'non-streaming-json-model',
      supportsStreaming: false,
    })
    expect(disabled.structuredOutput.streaming).toMatchObject({
      status: 'unsupported',
      source: 'declared',
    })
  })

  it('does not bake project-specific Kimi output budgets into global capabilities', () => {
    const capabilities = resolveModelCapabilities({
      id: 'kimi-code',
      backendModel: 'kimi-for-coding',
      provider: 'kimi',
    })

    expect(capabilities.structuredOutput.maxOutputTokens).toMatchObject({
      tokens: 4096,
      source: 'fallback',
    })
  })
})
