import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import { isIP } from 'node:net'
import {
  createJsonRpcFailure,
  JsonRpcError,
  parseJsonRpcRequest,
  type JsonRpcErrorResponse,
  type JsonRpcResponse,
} from './json-rpc.js'
import { createMethodRegistry, handleRequest, type MethodRegistryOptions } from './methods.js'
import {
  createAppServerEventBus,
  formatServerSentEvent,
  type AppServerEventBus,
} from './event-stream.js'
import { renderDesktopRenderer } from './desktop-renderer.js'

export interface AppServerHttpOptions extends MethodRegistryOptions {
  maxBodyBytes?: number
  eventBus?: AppServerEventBus
  managedToken?: string
  allowedOrigins?: readonly string[]
}

export interface AppServerListenOptions {
  host: string
  port: number
}

const DEFAULT_MAX_BODY_BYTES = 12_582_912

export function createAppServer(options: AppServerHttpOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const eventBus = options.eventBus ?? createAppServerEventBus()
  const registry = createMethodRegistry({ ...options, eventBus })
  const managedToken = options.managedToken ?? process.env['OWLCODA_APP_SERVER_TOKEN']
  const allowedOrigins = new Set(options.allowedOrigins ?? [])

  return createServer((req, res) => {
    void handleHttpRequest(req, res, { registry, maxBodyBytes, eventBus, managedToken, allowedOrigins })
  })
}

export function listenAppServer(server: Server, options: AppServerListenOptions): Promise<Server> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(options.port, options.host)
  })
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: {
    registry: ReturnType<typeof createMethodRegistry>
    maxBodyBytes: number
    eventBus: AppServerEventBus
    managedToken?: string
    allowedOrigins: ReadonlySet<string>
  },
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/healthz' && (req.method ?? '').toUpperCase() === 'GET') {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
  const loopbackRequest = isLoopbackRequest(req)
  if (!loopbackRequest && (!origin || context.managedToken)) {
    sendJson(res, 403, { error: 'loopback_required' })
    return
  }
  const allowlistedOrigin = origin ? context.allowedOrigins.has(origin) : false
  const trustedManualSameOrigin = origin
    && !context.managedToken
    && loopbackRequest
    && isLoopbackHost(req.headers.host)
    && origin === requestOrigin(req)
  if (origin && !allowlistedOrigin && !trustedManualSameOrigin) {
    sendJson(res, 403, { error: 'origin_not_allowed' })
    return
  }
  setCorsHeaders(res, allowlistedOrigin ? origin : undefined)

  if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if ((url.pathname === '/desktop' || url.pathname === '/desktop/') && (req.method ?? '').toUpperCase() === 'GET') {
    sendHtml(res, 200, renderDesktopRenderer({ appServerUrl: requestOrigin(req) }))
    return
  }

  if (url.pathname === '/events' && (req.method ?? '').toUpperCase() === 'GET') {
    if (!hasManagedAuthorization(req, context.managedToken)) {
      sendUnauthorized(res)
      return
    }
    const afterSequence = parseAfterSequence(req, url)
    if (afterSequence === null) {
      sendJson(res, 400, { error: 'invalid_after_sequence' })
      return
    }
    openEventStream(req, res, context.eventBus, afterSequence)
    return
  }

  if (url.pathname !== '/rpc') {
    sendJson(res, 404, createJsonRpcFailure(null, new JsonRpcError(-32601, `Route not found: ${url.pathname}`)))
    return
  }

  if ((req.method ?? '').toUpperCase() !== 'POST') {
    sendJson(res, 405, createJsonRpcFailure(null, new JsonRpcError(-32600, 'App Server /rpc requires POST')))
    return
  }

  if (!hasManagedAuthorization(req, context.managedToken)) {
    sendUnauthorized(res)
    return
  }

  let rawBody: string
  try {
    rawBody = await readRequestBody(req, context.maxBodyBytes)
  } catch (error) {
    sendJson(res, 413, createJsonRpcFailure(null, new JsonRpcError(
      -32600,
      error instanceof Error ? error.message : 'Request body too large',
    )))
    return
  }

  let parsed: unknown
  try {
    parsed = rawBody.trim() ? JSON.parse(rawBody) : null
  } catch {
    sendJson(res, 400, createJsonRpcFailure(null, new JsonRpcError(-32700, 'Parse error: invalid JSON')))
    return
  }

  let response: JsonRpcResponse
  try {
    const request = parseJsonRpcRequest(parsed)
    response = await handleRequest(context.registry, request)
  } catch (error) {
    response = createJsonRpcFailure(null, error instanceof JsonRpcError
      ? error
      : new JsonRpcError(-32603, error instanceof Error ? error.message : 'Internal error'))
  }

  sendJson(res, httpStatusForJsonRpc(response), response)
}

function openEventStream(
  req: IncomingMessage,
  res: ServerResponse,
  eventBus: AppServerEventBus,
  afterSequence?: number,
): void {
  const replay = afterSequence === undefined ? null : eventBus.replay(afterSequence)
  if (replay && !replay.available) {
    sendJson(res, 409, { error: 'snapshot_required', cursor: replay.cursor })
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  for (const event of replay?.events ?? []) res.write(formatServerSentEvent(event))
  const unsubscribe = eventBus.subscribe(event => {
    res.write(formatServerSentEvent(event))
  })
  req.on('close', unsubscribe)
}

function parseAfterSequence(req: IncomingMessage, url: URL): number | undefined | null {
  const value = url.searchParams.get('afterSequence') ?? req.headers['last-event-id']
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null
  return parsed
}

function httpStatusForJsonRpc(response: JsonRpcResponse): number {
  if (!('error' in response)) return 200
  if (response.error.code === -32700 || response.error.code === -32600) return 400
  if (response.error.code === -32601) return 404
  return 500
}

function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        req.destroy()
        reject(new Error(`Request body too large (>${maxBytes} bytes)`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function setCorsHeaders(res: ServerResponse, origin?: string): void {
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, last-event-id')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function hasManagedAuthorization(req: IncomingMessage, managedToken?: string): boolean {
  if (!managedToken) return true
  return req.headers.authorization === `Bearer ${managedToken}`
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress
  return typeof address === 'string' && (
    address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.')
  )
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (hostname === 'localhost' || hostname === '::1') return true
    return isIP(hostname) === 4 && hostname.split('.')[0] === '127'
  } catch {
    return false
  }
}

function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1'
  return `http://${host}`
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, createJsonRpcFailure(null, new JsonRpcError(-32001, 'Unauthorized')))
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonRpcResponse | JsonRpcErrorResponse | unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}
