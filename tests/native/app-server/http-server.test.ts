import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppServer, listenAppServer } from '../../../src/native/app-server/http-server.js'
import { deleteSession } from '../../../src/native/session.js'
import { runCli as runRunKitCore } from '../../../scripts/runkit-contract/runkit-cli.mjs'

const servers: Server[] = []
const createdSessions: string[] = []
const temporaryProjectRoots: string[] = []

afterEach(async () => {
  for (const id of createdSessions.splice(0)) deleteSession(id)
  for (const root of temporaryProjectRoots.splice(0)) rmSync(root, { recursive: true, force: true })
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
    const projectRoot = await makeInitializedRunKitProject()
    const server = await startServer({ projectRoot })
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
      result: {
        projectId: string
        freshness: string
        source: string
        summary: { schemaVersion: string; releaseAuthorization: boolean }
      }
    }
    expect(body.result.projectId).toBeTruthy()
    expect(body.result.freshness).toBe('fresh')
    expect(body.result.source).toBe('owlcoda_runkit_inspect_summary')
    expect(body.result.summary).toMatchObject({
      schemaVersion: 'OwlCodaRunKitInspectSummaryV1',
      releaseAuthorization: false,
    })
  })

  it('serves project/get aggregate through JSON-RPC POST /rpc', async () => {
    const projectRoot = await makeInitializedRunKitProject()
    const server = await startServer({ projectRoot })
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
    expect(body.result.project.root).toBe(projectRoot)
    expect(body.result.rail.projectId).toBe(body.result.project.id)
    expect(body.result.rail.freshness).toBe('fresh')
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

  it('accepts a normal pasted-image request envelope above the legacy one-megabyte limit', async () => {
    const server = await startServer()
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'attachment-size-1',
        method: 'attachment/store',
        params: { name: 'large.png', mediaType: 'image/png', dataBase64: `${'x'.repeat(1_099_999)}!` },
      }),
    })

    expect(response.status).toBe(500)
    const body = await response.json() as { error: { code: number; message: string } }
    expect(body.error).toMatchObject({ code: -32602, message: 'Attachment data is not valid base64' })
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
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('keeps the unconfigured same-origin debug renderer compatible without wildcard CORS', async () => {
    const server = await startServer()
    const url = baseUrl(server)
    const response = await fetch(`${url}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: url,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'protocol/describe', params: {} }),
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('rejects DNS-rebinding style manual requests that spoof Host as Origin', async () => {
    const server = await startServer()
    const response = await rawHttpRequest(`${baseUrl(server)}/rpc`, {
      host: 'attacker.example',
      origin: 'http://attacker.example',
      'content-type': 'application/json',
    }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'protocol/describe', params: {} }))

    expect(response.statusCode).toBe(403)
  })

  it.each(['127.attacker.example', '127.0.0.1.nip.io'])(
    'does not treat loopback-looking hostname %s as a loopback IP',
    async (hostname) => {
      const server = await startServer()
      const response = await rawHttpRequest(`${baseUrl(server)}/rpc`, {
        host: hostname,
        origin: `http://${hostname}`,
        'content-type': 'application/json',
      }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'protocol/describe', params: {} }))

      expect(response.statusCode).toBe(403)
    },
  )


  it('requires the managed bearer token for RPC without exposing it', async () => {
    const token = 'desktop-secret-token'
    const server = await startServer({ managedToken: token })
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'protocol/describe', params: {} }),
    })

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(token)
  })

  it('requires the managed bearer token for the event stream', async () => {
    const server = await startServer({ managedToken: 'desktop-secret-token' })
    const response = await fetch(`${baseUrl(server)}/events`, {
      headers: { authorization: 'Bearer wrong-token' },
    })

    expect(response.status).toBe(401)
  })

  it('keeps healthz minimal and secret-free in managed mode', async () => {
    const token = 'desktop-secret-token'
    const server = await startServer({ managedToken: token })
    const response = await fetch(`${baseUrl(server)}/healthz`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('allows an authorized managed RPC request', async () => {
    const token = 'desktop-secret-token'
    const server = await startServer({ managedToken: token })
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'protocol/describe', params: {} }),
    })

    expect(response.status).toBe(200)
  })

  it('rejects origins outside the managed allowlist', async () => {
    const token = 'desktop-secret-token'
    const server = await startServer({ managedToken: token, allowedOrigins: ['app://owlcoda'] })
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        origin: 'https://untrusted.example',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'protocol/describe', params: {} }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('echoes only an explicitly allowed managed origin', async () => {
    const token = 'desktop-secret-token'
    const server = await startServer({ managedToken: token, allowedOrigins: ['app://owlcoda'] })
    const response = await fetch(`${baseUrl(server)}/rpc`, {
      method: 'OPTIONS',
      headers: { origin: 'app://owlcoda' },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('app://owlcoda')
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
    expect(html).not.toContain('proof/append')
    expect(html).not.toContain('gate/confirm')
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
    expect(html).toContain('Current execution')
    expect(html).toContain('Latest closeout')
    expect(html).toContain('Model resources')
    expect(html).toContain('resourcePreflight')
    expect(html).toContain('Dominant gap')
    expect(html).toContain('Next allowed action')
    expect(html).toContain('activeRunIds')
    expect(html).toContain('activeReceiptSha256')
    expect(html).toContain('Git authorization')
    expect(html).toContain('Release authorization')
    expect(html).not.toContain('data-surface="runkit-truth-actions"')
    expect(html).not.toContain('function confirmCurrentGate')
    expect(html).not.toContain('function appendManualProof')
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
    expect(html).not.toContain("events.addEventListener('proof.appended'")
    expect(html).not.toContain("events.addEventListener('gate.confirmed'")
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

async function startServer(options: Parameters<typeof createAppServer>[0] = {}): Promise<Server> {
  const server = createAppServer({ projectRoot: process.cwd(), ...options })
  await listenAppServer(server, { host: '127.0.0.1', port: 0 })
  servers.push(server)
  return server
}

async function makeInitializedRunKitProject(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-http-runkit-'))
  temporaryProjectRoots.push(root)
  expect((await runRunKitCore(['init', '--workspace', root])).exitCode).toBe(0)
  return root
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

function rawHttpRequest(url: string, headers: Record<string, string>, body: string): Promise<{ statusCode?: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}
