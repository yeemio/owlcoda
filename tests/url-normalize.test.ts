/**
 * Anthropic `/v1/messages` endpoint URL construction.
 *
 * Open Coding Lab dogfood (2026-06-09): a base URL that already carries `/v1`
 * — e.g. Ollama's documented `http://localhost:11434/v1` — doubled to
 * `/v1/v1/messages` on the native conversation loop's client send path,
 * 404ing every request and spinning the loop to `max_iterations` with no work
 * done. `normalizeRouterBaseUrl` already guarded the router/probe/detect paths
 * (see router-url-normalize.test.ts) but the client send path appended raw.
 *
 * `buildAnthropicMessagesUrl` normalizes the base (a single trailing `/v1`
 * plus any trailing slashes) before appending `/v1/messages`, sharing the
 * canonical rule with `normalizeRouterBaseUrl` via the leaf `url-normalize`
 * module so config.ts and model-registry.ts cannot drift.
 */
import { describe, it, expect } from 'vitest'
import { buildAnthropicMessagesUrl, normalizeRouterBaseUrl } from '../src/url-normalize.js'

describe('buildAnthropicMessagesUrl', () => {
  it('appends /v1/messages to a clean base (the daemon case)', () => {
    expect(buildAnthropicMessagesUrl('http://127.0.0.1:9999')).toBe('http://127.0.0.1:9999/v1/messages')
  })

  it('does NOT double /v1 when the base already carries it (the Ollama footgun)', () => {
    expect(buildAnthropicMessagesUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/messages')
  })

  it('collapses a trailing slash after /v1', () => {
    expect(buildAnthropicMessagesUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1/messages')
  })

  it('collapses a bare trailing slash on a clean base', () => {
    expect(buildAnthropicMessagesUrl('http://127.0.0.1:9999/')).toBe('http://127.0.0.1:9999/v1/messages')
  })

  it('preserves a path-prefixed base while stripping only a trailing /v1', () => {
    expect(buildAnthropicMessagesUrl('http://gw.local/anthropic/v1')).toBe('http://gw.local/anthropic/v1/messages')
  })

  it('re-exports the canonical normalizeRouterBaseUrl (single source of truth)', () => {
    expect(normalizeRouterBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434')
  })
})
