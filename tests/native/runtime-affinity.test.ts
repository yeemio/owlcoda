import { describe, expect, it } from 'vitest'
import { classifyRuntimeBinding } from '../../src/native/runtime-affinity.js'

const expected = {
  pid: 101,
  runtimeToken: 'tok-expected',
  host: '127.0.0.1',
  port: 18139,
  routerUrl: 'http://127.0.0.1:8009',
}

describe('classifyRuntimeBinding', () => {
  it('reports healthy when healthz still matches the original daemon binding', () => {
    const result = classifyRuntimeBinding(expected, {
      status: 'healthy',
      version: '0.10.0',
      pid: 101,
      runtimeToken: 'tok-expected',
      host: '127.0.0.1',
      port: 18139,
      routerUrl: 'http://127.0.0.1:8009',
    }, expected)

    expect(result.kind).toBe('healthy')
    expect(result.summary).toContain('Proxy healthy')
  })

  it('detects proxy replacement when healthz answers with a different daemon identity', () => {
    const result = classifyRuntimeBinding(expected, {
      status: 'healthy',
      version: '0.10.0',
      pid: 202,
      runtimeToken: 'tok-new',
      host: '127.0.0.1',
      port: 18153,
      routerUrl: 'http://127.0.0.1:8009',
    }, {
      ...expected,
      pid: 202,
      runtimeToken: 'tok-new',
      port: 18153,
    })

    expect(result.kind).toBe('proxy_changed')
    expect(result.detail).toContain('Expected http://127.0.0.1:18139 PID 101')
  })

  it('detects runtime drift from runtime.json even when old proxy is already gone', () => {
    const result = classifyRuntimeBinding(expected, null, {
      ...expected,
      pid: 303,
      runtimeToken: 'tok-drift',
      port: 18153,
    })

    expect(result.kind).toBe('proxy_changed')
    expect(result.detail).toContain('Session state now points to http://127.0.0.1:18153')
  })

  it('reports daemon unavailable when nothing responds and runtime state still points to the original daemon', () => {
    const result = classifyRuntimeBinding(expected, null, expected)

    expect(result.kind).toBe('daemon_unavailable')
    expect(result.detail).toContain('Proxy at http://127.0.0.1:18139 is unreachable')
  })
})
