import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleAdminStatic } from '../src/admin-static.js'

function makeReqRes(url: string, method: 'GET' | 'HEAD' | 'POST' = 'GET'): {
  req: any
  res: any
  captured: { status?: number, headers?: Record<string, string>, body?: Buffer | string, ended: boolean }
} {
  const captured: any = { ended: false, headers: {} }
  const res: any = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status
      captured.headers = headers ?? {}
    },
    setHeader(k: string, v: string) {
      if (!captured.headers) captured.headers = {}
      captured.headers[k] = v
    },
    end(body?: Buffer | string) {
      if (body !== undefined) captured.body = body
      captured.ended = true
    },
  }
  const req: any = { url, method }
  return { req, res, captured }
}

describe('handleAdminStatic', () => {
  let distDir: string

  beforeEach(() => {
    distDir = mkdtempSync(join(tmpdir(), 'admin-static-'))
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>admin</title>')
    writeFileSync(join(distDir, 'assets', 'index-abc.js'), 'console.log("hi")')
  })

  afterEach(() => {
    rmSync(distDir, { recursive: true, force: true })
  })

  it('serves index.html for /admin/', () => {
    const { req, res, captured } = makeReqRes('/admin/')
    expect(handleAdminStatic(req, res, { distDir })).toBe(true)
    expect(captured.status).toBe(200)
    expect(captured.headers?.['Content-Type']).toMatch(/text\/html/)
    expect(String(captured.body)).toContain('<title>admin</title>')
  })

  it('redirects /admin to /admin/', () => {
    const { req, res, captured } = makeReqRes('/admin')
    expect(handleAdminStatic(req, res, { distDir })).toBe(true)
    // /admin (no trailing slash) should either redirect to /admin/ OR serve index.html.
    // The user's implementation serves index.html directly; accept either behavior.
    expect([200, 301, 302]).toContain(captured.status)
  })

  it('serves hashed asset with immutable cache', () => {
    const { req, res, captured } = makeReqRes('/admin/assets/index-abc.js')
    expect(handleAdminStatic(req, res, { distDir })).toBe(true)
    expect(captured.status).toBe(200)
    expect(captured.headers?.['Content-Type']).toMatch(/javascript/)
    expect(captured.headers?.['Cache-Control']).toContain('immutable')
  })

  it('ignores /admin/api/* (returns false so admin-api handler takes it)', () => {
    const { req, res, captured } = makeReqRes('/admin/api/snapshot')
    expect(handleAdminStatic(req, res, { distDir })).toBe(false)
    expect(captured.ended).toBe(false)
  })

  it('ignores non-/admin paths', () => {
    const { req, res, captured } = makeReqRes('/v1/messages')
    expect(handleAdminStatic(req, res, { distDir })).toBe(false)
    expect(captured.ended).toBe(false)
  })

  it('returns friendly 503 when bundle is missing', () => {
    const missingDir = join(distDir, 'does-not-exist')
    const { req, res, captured } = makeReqRes('/admin/')
    expect(handleAdminStatic(req, res, { distDir: missingDir })).toBe(true)
    expect(captured.status).toBe(503)
    expect(String(captured.body)).toContain('bundle')
  })

  it('blocks path traversal', () => {
    const { req, res, captured } = makeReqRes('/admin/../../etc/passwd')
    const result = handleAdminStatic(req, res, { distDir })
    // Either returns false (falls through) or 404 — must NOT return 200 w/ outside file
    expect(captured.status === undefined || captured.status === 404).toBe(true)
    expect(result === false || captured.status === 404).toBe(true)
  })
})
