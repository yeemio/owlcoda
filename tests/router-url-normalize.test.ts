/**
 * routerUrl base normalization (Issue #2 dogfood: Ollama + trailing /v1).
 *
 * Canonical convention: routerUrl is the bare base. Every consumer appends
 * the OpenAI/Anthropic path itself:
 *   - resolveModelRoute → `${routerUrl}/v1/chat/completions` (model-registry.ts)
 *   - probeRuntimeSurface → `${routerUrl}/v1/models` etc. (runtime-probe.ts)
 *   - detectRouterModels  → `${routerUrl}/v1/models` (init.ts)
 * A routerUrl that already ends in `/v1` therefore doubles to `/v1/v1/...`
 * and 404s across probe + chat + detect. Normalize the base so the user's
 * documented workaround (drop the trailing /v1) is what we store and route on.
 */
import { describe, it, expect } from 'vitest'
import { normalizeRouterBaseUrl } from '../src/config.js'

describe('normalizeRouterBaseUrl', () => {
  it('strips a trailing /v1 segment (the Ollama footgun)', () => {
    expect(normalizeRouterBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
  })

  it('strips /v1 with a trailing slash', () => {
    expect(normalizeRouterBaseUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434')
  })

  it('strips a bare trailing slash', () => {
    expect(normalizeRouterBaseUrl('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434')
  })

  it('leaves a clean base URL untouched', () => {
    expect(normalizeRouterBaseUrl('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434')
  })

  it('leaves the legacy router base (port 8009, no /v1) untouched', () => {
    expect(normalizeRouterBaseUrl('http://127.0.0.1:8009')).toBe('http://127.0.0.1:8009')
  })

  it('only strips a trailing /v1, not a mid-path segment', () => {
    expect(normalizeRouterBaseUrl('http://127.0.0.1:8080/openai')).toBe('http://127.0.0.1:8080/openai')
  })

  it('strips a trailing /v1 even behind a path prefix', () => {
    expect(normalizeRouterBaseUrl('http://gw.local/openai/v1')).toBe('http://gw.local/openai')
  })

  it('does not strip /v10 (only the exact /v1 segment)', () => {
    expect(normalizeRouterBaseUrl('http://h/v10')).toBe('http://h/v10')
  })

  it('is lenient with whitespace-only input', () => {
    expect(normalizeRouterBaseUrl('   ')).toBe('')
  })
})
