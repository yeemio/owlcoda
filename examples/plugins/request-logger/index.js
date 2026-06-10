/**
 * OwlCoda Example Plugin: Request Logger
 *
 * Logs every API request's model and message count to a file.
 *
 * Install:
 *   cp -r examples/plugins/request-logger ~/.owlcoda/plugins/
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const LOG_FILE = join(process.env.OWLCODA_HOME || join(homedir(), '.owlcoda'), 'logs', 'request-log.jsonl')

function ensureLogDir() {
  const dir = dirname(LOG_FILE)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export const metadata = {
  name: 'request-logger',
  version: '1.0.0',
  description: 'Logs API requests to ~/.owlcoda/logs/request-log.jsonl',
}

export function onRequest(ctx) {
  ensureLogDir()
  const entry = {
    timestamp: new Date().toISOString(),
    model: ctx.model,
    messageCount: ctx.messageCount,
    endpoint: ctx.endpoint,
  }
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
}

export function onResponse(ctx) {
  ensureLogDir()
  const entry = {
    timestamp: new Date().toISOString(),
    type: 'response',
    model: ctx.model,
    statusCode: ctx.statusCode,
    durationMs: ctx.durationMs,
    inputTokens: ctx.inputTokens,
    outputTokens: ctx.outputTokens,
  }
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
}

export function onError(ctx) {
  ensureLogDir()
  const entry = {
    timestamp: new Date().toISOString(),
    type: 'error',
    endpoint: ctx.endpoint,
    errorType: ctx.errorType,
    message: ctx.message,
  }
  appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
}
