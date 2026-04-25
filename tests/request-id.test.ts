import { describe, it, expect, beforeEach } from 'vitest'
import { assignRequestId, logWithId } from '../src/middleware/request-id.js'

describe('request-id middleware', () => {
  it('generates UUID v4 format', () => {
    const fakeRes = { setHeader: () => {} } as any
    const id = assignRequestId(fakeRes)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('sets x-request-id header on response', () => {
    let headerName = ''
    let headerValue = ''
    const fakeRes = {
      setHeader: (name: string, value: string) => {
        headerName = name
        headerValue = value
      },
    } as any
    const id = assignRequestId(fakeRes)
    expect(headerName).toBe('x-request-id')
    expect(headerValue).toBe(id)
  })

  it('generates unique IDs per call', () => {
    const fakeRes = { setHeader: () => {} } as any
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(assignRequestId(fakeRes))
    }
    expect(ids.size).toBe(100)
  })

  it('logWithId prefixes message with request ID', () => {
    const messages: string[] = []
    const originalError = console.error
    console.error = (...args: any[]) => messages.push(args.join(' '))

    logWithId('abc-123', 'test message', 42)
    expect(messages[0]).toContain('[abc-123]')
    expect(messages[0]).toContain('test message')
    expect(messages[0]).toContain('42')

    console.error = originalError
  })
})
