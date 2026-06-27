import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { createAppServer, listenAppServer } from '../../../src/native/app-server/http-server.js'
import { deleteSession } from '../../../src/native/session.js'

const servers: Server[] = []
const createdSessions: string[] = []

afterEach(async () => {
  for (const id of createdSessions.splice(0)) deleteSession(id)
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })))
})

describe('app-server http boundary', () => {
  it('serves diagnostic health through JSON-RPC POST /rpc', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'health-1',
        method: 'diagnostic/health',
        params: {},
      }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = await response.json() as {
      jsonrpc: '2.0'
      id: string
      result: { status: string; methods: string[] }
    }
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe('health-1')
    expect(body.result.status).toBe('ok')
    expect(body.result.methods).toContain('runtimeRail/read')
  })

  it('serves runtimeRail/read without demo data', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'runtimeRail/read',
        params: { projectId: 'owlcoda' },
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      result: { projectId: string; freshness: string; packet: unknown; proofs: unknown[] }
    }
    expect(body.result.projectId).toBe('owlcoda')
    expect(body.result.freshness).toBe('missing')
    expect(body.result.packet).toBeNull()
    expect(body.result.proofs).toEqual([])
  })

  it('serves project/get aggregate through JSON-RPC POST /rpc', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'project-get-1',
        method: 'project/get',
        params: {},
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      result: { project: { id: string; root: string }; rail: { projectId: string; freshness: string } }
    }
    expect(body.result.project.id).toBeTruthy()
    expect(body.result.project.root).toBe(process.cwd())
    expect(body.result.rail.projectId).toBe(body.result.project.id)
    expect(body.result.rail.freshness).toBe('missing')
  })

  it('maps malformed JSON to a JSON-RPC parse error', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32700)
    expect(body.error.message).toContain('Parse error')
  })

  it('rejects non-POST /rpc requests with JSON error', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/rpc`)

    expect(response.status).toBe(405)
    const body = await response.json() as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32600)
    expect(body.error.message).toContain('POST')
  })

  it('answers CORS preflight for desktop renderer clients', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/rpc`, { method: 'OPTIONS' })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('serves the desktop renderer shell from structured App Server methods', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/desktop`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('id="owlcoda-desktop-shell"')
    expect(html).toContain('data-surface="app-server-protocol-contract"')
    expect(html).toContain('data-product-boundary="debug-renderer"')
    expect(html).toContain('data-debug-scope="operator-smoke"')
    expect(html).toContain('data-not-product-ui="true"')
    expect(html).toContain('diagnostic/health')
    expect(html).toContain('protocol/describe')
    expect(html).toContain('data-surface="project-thread-nav"')
    expect(html).toContain('data-surface="runtime-workspace"')
    expect(html).toContain('data-surface="runkit-runtime-rail"')
    expect(html).toContain('runtimeTranscript/read')
    expect(html).toContain('review/list')
    expect(html).toContain('review/batchPreflight')
    expect(html).toContain('review/batchApply')
    expect(html).toContain('review/batchRevert')
    expect(html).toContain('review/hunkApply')
    expect(html).toContain('review/hunkRevert')
    expect(html).toContain('function renderBashProvenance')
    expect(html).toContain('bashProvenance')
    expect(html).toContain('approval/list')
    expect(html).toContain('interaction/list')
    expect(html).toContain('interaction/respond')
    expect(html).toContain('proof/append')
    expect(html).toContain('gate/confirm')
    expect(html).toContain('runtimeRail/read')
    expect(html).toContain('runtimeFacts/read')
    expect(html).toContain('data-surface="runtime-facts-summary"')
    expect(html).toContain('function renderRuntimeFactsSummary')
    expect(html).toContain('structuredOutputArtifacts/read')
    expect(html).toContain('data-surface="structured-output-artifacts"')
    expect(html).toContain('function renderStructuredOutputArtifacts')
    expect(html).toContain('function latestRunIdFromTranscript')
    expect(html).toContain('benchmark/providerEvalReport/read')
    expect(html).toContain('data-surface="provider-eval-report"')
    expect(html).toContain('function renderProviderEvalReport')
    expect(html).toContain('data-surface="model-comparison-panel"')
    expect(html).toContain('function renderModelComparisonPanel')
    expect(html).toContain('caseMatrix')
    expect(html).toContain('providerEvalReport')
    expect(html).toContain('function renderRailClaim')
    expect(html).toContain('rail.claim')
    expect(html).toContain('data-surface="runkit-truth-actions"')
    expect(html).toContain('function confirmCurrentGate')
    expect(html).toContain('function appendManualProof')
    expect(html).toContain('thread/list')
    expect(html).toContain('turn/start')
    expect(html).toContain('id="tabApprovals"')
    expect(html).toContain('data-surface="approval-center"')
    expect(html).toContain('data-surface="interaction-center"')
    expect(html).toContain('data-surface="live-runtime-events"')
    expect(html).toContain('data-surface="live-runtime-item"')
    expect(html).toContain('data-surface="tool-output-delta"')
    expect(html).toContain('id="liveEventStream"')
    expect(html).toContain('liveRuntimeState: createLiveRuntimeState()')
    expect(html).toContain('liveEvents: []')
    expect(html).toContain('function appendLiveEvent')
    expect(html).toContain('function reduceLiveRuntimeEvent')
    expect(html).toContain('function renderLiveRuntimeItem')
    expect(html).toContain("events.addEventListener('turn.started'")
    expect(html).toContain("events.addEventListener('assistant.delta'")
    expect(html).toContain("events.addEventListener('tool.started'")
    expect(html).toContain("events.addEventListener('tool.delta'")
    expect(html).toContain("events.addEventListener('tool.completed'")
    expect(html).toContain("events.addEventListener('turn.interrupted'")
    expect(html).toContain("events.addEventListener('approval.requested'")
    expect(html).toContain("events.addEventListener('approval.resolved'")
    expect(html).toContain("events.addEventListener('interaction.requested'")
    expect(html).toContain("events.addEventListener('interaction.resolved'")
    expect(html).toContain("events.addEventListener('proof.appended'")
    expect(html).toContain("events.addEventListener('gate.confirmed'")
    expect(html).toContain("events.addEventListener('review.batchCompleted'")
    expect(html).not.toContain('xterm')
  })

  it('streams structured turn events from turn/start', async () => {
    const server = await startServer()
    const url = baseUrl(server)
    const abort = new AbortController()
    const streamResponse = await fetch(`${url}/events`, { signal: abort.signal })
    expect(streamResponse.status).toBe(200)

    const reader = streamResponse.body!.getReader()
    try {
      const connected = await readChunk(reader)
      expect(connected).toContain(': connected')

      const started = await rpc(url, 'thread/start', {
        title: 'HTTP streamed thread',
        model: 'http-test-model',
      }) as { thread: { id: string } }
      createdSessions.push(started.thread.id)

      await rpc(url, 'turn/start', {
        threadId: started.thread.id,
        input: 'stream me',
      })

      let chunk = ''
      for (let attempts = 0; attempts < 5 && !chunk.includes('event: turn.started'); attempts += 1) {
        chunk += await readChunk(reader)
      }

      expect(chunk).toContain('event: turn.started')
      expect(chunk).toContain('"threadId"')
      expect(chunk).toContain(started.thread.id)
    } finally {
      abort.abort()
      await reader.cancel().catch(() => {})
    }
  })
})

async function startServer(): Promise<Server> {
  const server = createAppServer({ projectRoot: process.cwd() })
  await listenAppServer(server, { host: '127.0.0.1', port: 0 })
  servers.push(server)
  return server
}

function baseUrl(server: Server): string {
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('server did not bind to a TCP address')
  }
  return `http://127.0.0.1:${address.port}`
}

async function rpc(url: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${url}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params,
    }),
  })
  expect(response.status).toBe(200)
  const body = await response.json() as { result: unknown }
  return body.result
}

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value } = await reader.read()
  return new TextDecoder().decode(value)
}
