export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(tag: string, msg: string): void
  info(tag: string, msg: string): void
  warn(tag: string, msg: string): void
  error(tag: string, msg: string, err?: Error): void
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export function createLogger(level: LogLevel): Logger {
  const threshold = LEVEL_ORDER[level]

  function emit(lvl: LogLevel, tag: string, msg: string, err?: Error): void {
    if (LEVEL_ORDER[lvl] < threshold) return
    const ts = new Date().toISOString()
    const label = lvl.toUpperCase()
    console.error(`[${ts}] [${label}] [${tag}] ${msg}`)
    if (err) {
      console.error(err.stack ?? err.message)
    }
  }

  return {
    debug: (tag, msg) => emit('debug', tag, msg),
    info: (tag, msg) => emit('info', tag, msg),
    warn: (tag, msg) => emit('warn', tag, msg),
    error: (tag, msg, err?) => emit('error', tag, msg, err),
  }
}
