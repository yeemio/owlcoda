import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
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
}

export interface AppServerListenOptions {
  host: string
  port: number
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576

export function createAppServer(options: AppServerHttpOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const eventBus = options.eventBus ?? createAppServerEventBus()
  const registry = createMethodRegistry({ ...options, eventBus })

  return createServer((req, res) => {
    void handleHttpRequest(req, res, { registry, maxBodyBytes, eventBus })
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
  },
): Promise<void> {
  setCorsHeaders(res)

  if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/healthz' && (req.method ?? '').toUpperCase() === 'GET') {
    const response = await handleRequest(context.registry, {
      jsonrpc: '2.0',
      id: 'healthz',
      method: 'diagnostic/health',
      params: {},
    })
    const status = 'result' in response ? 200 : 500
    sendJson(res, status, 'result' in response ? response.result : response)
    return
  }

  if ((url.pathname === '/desktop' || url.pathname === '/desktop/') && (req.method ?? '').toUpperCase() === 'GET') {
    sendHtml(res, 200, renderDesktopRenderer({ appServerUrl: requestOrigin(req) }))
    return
  }

  if (url.pathname === '/events' && (req.method ?? '').toUpperCase() === 'GET') {
    openEventStream(req, res, context.eventBus)
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

function openEventStream(req: IncomingMessage, res: ServerResponse, eventBus: AppServerEventBus): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  const unsubscribe = eventBus.subscribe(event => {
    res.write(formatServerSentEvent(event))
  })
  req.on('close', unsubscribe)
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

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function requestOrigin(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1'
  const proto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'] : 'http'
  return `${proto}://${host}`
}

function sendJson(res: ServerResponse, statusCode: number, body: JsonRpcResponse | JsonRpcErrorResponse | unknown): void {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}
