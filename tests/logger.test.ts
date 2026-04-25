import { describe, it, expect, vi, beforeEach } from 'vitest'
import { log, logDebug, logInfo, logWarn, logError, setLogLevel, getLogLevel } from '../src/logger.js'

describe('Structured Logger', () => {
  let written: string[]

  beforeEach(() => {
    written = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    })
    setLogLevel('debug') // allow all levels
  })

  it('emits JSON with required fields', () => {
    logInfo('test', 'hello')
    expect(written.length).toBe(1)
    const entry = JSON.parse(written[0])
    expect(entry.ts).toBeTruthy()
    expect(entry.level).toBe('info')
    expect(entry.component).toBe('test')
    expect(entry.msg).toBe('hello')
  })

  it('includes data field when provided', () => {
    logWarn('server', 'timeout', { durationMs: 5000 })
    const entry = JSON.parse(written[0])
    expect(entry.data).toEqual({ durationMs: 5000 })
  })

  it('omits data field when empty', () => {
    logError('config', 'failed')
    const entry = JSON.parse(written[0])
    expect(entry.data).toBeUndefined()
  })

  it('respects log level filtering', () => {
    setLogLevel('warn')
    logDebug('x', 'nope')
    logInfo('x', 'nope')
    logWarn('x', 'yes')
    logError('x', 'yes')
    expect(written.length).toBe(2)
  })

  it('log() accepts explicit level', () => {
    log('error', 'comp', 'msg')
    const entry = JSON.parse(written[0])
    expect(entry.level).toBe('error')
  })

  it('getLogLevel returns current level', () => {
    setLogLevel('error')
    expect(getLogLevel()).toBe('error')
  })

  it('debug messages pass when level is debug', () => {
    setLogLevel('debug')
    logDebug('test', 'debug msg')
    expect(written.length).toBe(1)
    expect(JSON.parse(written[0]).level).toBe('debug')
  })

  it('each line is terminated with newline', () => {
    logInfo('a', 'b')
    expect(written[0].endsWith('\n')).toBe(true)
  })
})
