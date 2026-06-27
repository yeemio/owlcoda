import { describe, expect, it } from 'vitest'
import { describeAppServerProtocol, type AppServerProtocolDescription } from '../../../src/native/app-server/protocol-contract.js'
import { bootstrapDesktopProductShell } from '../../../src/native/app-server/desktop-product-shell.js'

describe('desktop product shell bootstrap', () => {
  it('boots through protocol/describe and DesktopCapabilityGate without binding debug-only methods', async () => {
    const calls: string[] = []
    const result = await bootstrapDesktopProductShell({
      baseUrl: 'http://app-server.test/',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown; method: string; params: unknown }
        calls.push(request.method)
        if (request.method === 'diagnostic/health') throw new Error('product shell must not call diagnostic/health')
        expect(request.method).toBe('protocol/describe')
        expect(request.params).toEqual({})
        return jsonRpcResponse(request.id, describeAppServerProtocol())
      },
    })

    expect(calls).toEqual(['protocol/describe'])
    expect(result).toMatchObject({
      boundary: 'external-product-shell',
      ready: true,
      protocolVersion: 'v1',
      productSurface: 'desktop-product-shell',
      capabilityGate: {
        ok: true,
        errors: [],
        debugOnlyMethods: ['diagnostic/health'],
      },
    })
    expect(result.stableMethods).toContain('runtimeTranscript/read')
    expect(result.experimentalMethods).toContain('runtimeFacts/read')
    expect(result.debugOnlyMethods).toEqual(['diagnostic/health'])
  })

  it('returns a blocked bootstrap result when the product capability gate fails', async () => {
    const protocol = withoutMethod(describeAppServerProtocol(), 'runtimeTranscript/read')
    const result = await bootstrapDesktopProductShell({
      baseUrl: 'http://app-server.test',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body ?? '{}')) as { id: unknown }
        return jsonRpcResponse(request.id, protocol)
      },
    })

    expect(result.ready).toBe(false)
    expect(result.capabilityGate.ok).toBe(false)
    expect(result.errors).toEqual(expect.arrayContaining([
      'required stable method missing: runtimeTranscript/read',
    ]))
    expect(result.stableMethods).not.toContain('runtimeTranscript/read')
  })
})

function jsonRpcResponse(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    result,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function withoutMethod(
  protocol: AppServerProtocolDescription,
  removedMethod: string,
): AppServerProtocolDescription {
  return {
    ...protocol,
    methods: protocol.methods.filter(method => method.method !== removedMethod),
  }
}
