import { IncomingMessage, ServerResponse } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { readBody } from '../server.js'

export async function handleCountTokens(
  req: IncomingMessage,
  res: ServerResponse,
  _config: OwlCodaConfig,
): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

  const rawBody = await readBody(req)
  let body: any
  try {
    body = JSON.parse(rawBody)
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }))
    return
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Request body must be a JSON object' } }))
    return
  }

  // Simple estimation: chars / 4
  let charCount = 0

  if (typeof body.system === 'string') charCount += body.system.length
  if (Array.isArray(body.system)) {
    for (const block of body.system) {
      if (block.type === 'text') charCount += (block.text?.length ?? 0)
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (typeof msg.content === 'string') charCount += msg.content.length
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') charCount += (block.text?.length ?? 0)
          if (block.type === 'tool_result' && typeof block.content === 'string') charCount += block.content.length
        }
      }
    }
  }

  if (Array.isArray(body.tools)) {
    charCount += JSON.stringify(body.tools).length
  }

  const estimatedTokens = Math.max(1, Math.ceil(charCount / 4))

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ input_tokens: estimatedTokens }))
}
