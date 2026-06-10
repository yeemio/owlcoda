/**
 * Structured JSON logging — all log output is one JSON object per line on stderr.
 * Optionally also writes to a log file (if initLogFile was called).
 * Respects logLevel from config: debug < info < warn < error.
 */

import { writeLogLine } from './log-file.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

let minLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  minLevel = level
}

export function getLogLevel(): LogLevel {
  return minLevel
}

function emit(level: LogLevel, component: string, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
  }
  if (data && Object.keys(data).length > 0) {
    entry.data = data
  }
  const jsonLine = JSON.stringify(entry) + '\n'
  process.stderr.write(jsonLine)
  writeLogLine(jsonLine)
}

export function log(level: LogLevel, component: string, msg: string, data?: Record<string, unknown>): void {
  emit(level, component, msg, data)
}

export function logDebug(component: string, msg: string, data?: Record<string, unknown>): void {
  emit('debug', component, msg, data)
}

export function logInfo(component: string, msg: string, data?: Record<string, unknown>): void {
  emit('info', component, msg, data)
}

export function logWarn(component: string, msg: string, data?: Record<string, unknown>): void {
  emit('warn', component, msg, data)
}

export function logError(component: string, msg: string, data?: Record<string, unknown>): void {
  emit('error', component, msg, data)
}
