import { describe, it, expect, beforeEach } from 'vitest'
import { auditRequest, queryAudit, getAuditSummary, resetAudit, formatAuditEntries } from '../src/audit-log.js'

describe('audit-log', () => {
  beforeEach(() => {
    resetAudit()
  })

  it('records and retrieves entries', () => {
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'test', statusCode: 200, durationMs: 50 })
    const entries = queryAudit()
    expect(entries).toHaveLength(1)
    expect(entries[0].method).toBe('POST')
    expect(entries[0].id).toMatch(/^req-/)
  })

  it('filters by model', () => {
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'a', statusCode: 200, durationMs: 10 })
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'b', statusCode: 200, durationMs: 20 })
    const filtered = queryAudit({ model: 'a' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].model).toBe('a')
  })

  it('filters by status range', () => {
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'x', statusCode: 200, durationMs: 10 })
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'x', statusCode: 500, durationMs: 20 })
    const errors = queryAudit({ minStatus: 400 })
    expect(errors).toHaveLength(1)
    expect(errors[0].statusCode).toBe(500)
  })

  it('filters by minimum duration', () => {
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'x', statusCode: 200, durationMs: 10 })
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'x', statusCode: 200, durationMs: 1000 })
    const slow = queryAudit({ minDurationMs: 500 })
    expect(slow).toHaveLength(1)
    expect(slow[0].durationMs).toBe(1000)
  })

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      auditRequest({ method: 'POST', path: '/v1/messages', model: 'x', statusCode: 200, durationMs: i })
    }
    const limited = queryAudit({ limit: 3 })
    expect(limited).toHaveLength(3)
  })

  it('returns most recent first', () => {
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'x', statusCode: 200, durationMs: 1 })
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'x', statusCode: 200, durationMs: 2 })
    const entries = queryAudit()
    expect(entries[0].durationMs).toBe(2) // Most recent first
  })

  it('caps at 500 entries', () => {
    for (let i = 0; i < 600; i++) {
      auditRequest({ method: 'GET', path: '/healthz', model: '-', statusCode: 200, durationMs: 1 })
    }
    expect(queryAudit().length).toBe(500)
  })

  it('getAuditSummary returns correct stats', () => {
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'a', statusCode: 200, durationMs: 100 })
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'b', statusCode: 500, durationMs: 200 })
    const summary = getAuditSummary()
    expect(summary.totalEntries).toBe(2)
    expect(summary.uniqueModels).toContain('a')
    expect(summary.uniqueModels).toContain('b')
    expect(summary.errorCount).toBe(1)
    expect(summary.avgDurationMs).toBe(150)
  })

  it('formatAuditEntries produces readable output', () => {
    auditRequest({ method: 'POST', path: '/v1/messages', model: 'test', statusCode: 200, durationMs: 42 })
    const output = formatAuditEntries(queryAudit())
    expect(output).toContain('POST')
    expect(output).toContain('/v1/messages')
    expect(output).toContain('42ms')
  })

  it('formatAuditEntries handles empty', () => {
    expect(formatAuditEntries([])).toContain('No audit entries')
  })
})
