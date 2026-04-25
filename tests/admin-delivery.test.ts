import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  adminHandoffFailureHint,
  buildAdminHandoffHash,
  buildAdminHandoffUrl,
  buildAdminUrl,
  createOneShotAdminToken,
  getAdminBearerToken,
  getAdminBundleStatus,
  verifyOneShotAdminToken,
} from '../src/admin-delivery.js'
import { handleAdminStatic } from '../src/admin-static.js'

interface MockResult {
  statusCode: number
  headers: Record<string, string>
  body: string
}

function createMockRes(): { res: ServerResponse; getResult: () => MockResult } {
  const socket = new Socket()
  const res = new ServerResponse(new IncomingMessage(socket))
  let body = ''
  let statusCode = 200
  const headers: Record<string, string> = {}

  const origSetHeader = res.setHeader.bind(res)
  res.setHeader = function (name: string, value: any) {
    headers[name.toLowerCase()] = String(value)
    return origSetHeader(name, value)
  } as any

  const origWriteHead = res.writeHead.bind(res)
  res.writeHead = function (code: number, ...args: any[]) {
    statusCode = code
    const maybeHeaders = typeof args[0] === 'string' ? args[1] : args[0]
    if (maybeHeaders) {
      for (const [name, value] of Object.entries(maybeHeaders)) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
      }
    }
    return origWriteHead(code, ...args)
  } as any

  const origEnd = res.end.bind(res)
  res.end = function (data?: any) {
    if (data) body = typeof data === 'string' ? data : data.toString('utf-8')
    return origEnd(data)
  } as any

  return { res, getResult: () => ({ statusCode, body, headers }) }
}

function createMockReq(url: string, method: string = 'GET'): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.url = url
  req.method = method
  return req
}

describe('admin delivery helpers', () => {
  let workdir: string
  const originalCwd = process.cwd()

  beforeEach(() => {
    workdir = mkdtempSync('/tmp/owlcoda-admin-delivery-')
    process.chdir(workdir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(workdir, { recursive: true, force: true })
  })

  it('builds and verifies one-shot admin URLs', () => {
    const secret = getAdminBearerToken({ adminToken: 'secret-token', port: 8019 })
    const token = createOneShotAdminToken(secret, { now: () => 1234, nonce: 'abc123' })
    const url = buildAdminUrl('http://127.0.0.1:8019', token)

    expect(url).toBe(`http://127.0.0.1:8019/admin/?token=${encodeURIComponent(token)}`)
    expect(verifyOneShotAdminToken(secret, token, { now: () => 1234, maxAgeMs: 60_000 })).toBe(true)
    expect(verifyOneShotAdminToken('wrong-secret', token, { now: () => 1234, maxAgeMs: 60_000 })).toBe(false)
  })

  it('builds browser handoff hash and URL with route/select/view context', () => {
    const secret = getAdminBearerToken({ adminToken: 'secret-token', port: 8019 })
    const token = createOneShotAdminToken(secret, { now: () => 1234, nonce: 'ctx123' })

    expect(buildAdminHandoffHash({ route: 'models', select: 'kimi', view: 'issues' })).toBe('#/models?select=kimi&view=issues')
    expect(buildAdminHandoffHash({ route: 'catalog' })).toBe('#/catalog')
    expect(buildAdminHandoffUrl('http://127.0.0.1:8019', token, {
      route: 'aliases',
      select: 'claude',
    })).toBe(`http://127.0.0.1:8019/admin/?token=${encodeURIComponent(token)}#/aliases?select=claude`)
  })

  it('reports admin bundle status from dist/admin/index.html', () => {
    // Tests pass an explicit projectRoot to stay hermetic — the no-arg default
    // resolves relative to the module file (so the installed CLI finds its own
    // bundle regardless of cwd).
    expect(getAdminBundleStatus(workdir).available).toBe(false)
    mkdirSync(join(workdir, 'dist', 'admin'), { recursive: true })
    writeFileSync(join(workdir, 'dist', 'admin', 'index.html'), '<!doctype html>')
    expect(getAdminBundleStatus(workdir).available).toBe(true)
  })

  it('serves /admin and /admin/assets/* from the compiled bundle', () => {
    const distDir = join(workdir, 'dist', 'admin')
    mkdirSync(join(distDir, 'assets'), { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Admin</title>')
    writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("admin")')

    const root = createMockRes()
    const handledRoot = handleAdminStatic(createMockReq('/admin'), root.res, { distDir })
    expect(handledRoot).toBe(true)
    expect(root.getResult().statusCode).toBe(200)
    expect(root.getResult().headers['content-type']).toContain('text/html')

    const asset = createMockRes()
    const handledAsset = handleAdminStatic(createMockReq('/admin/assets/app.js'), asset.res, { distDir })
    expect(handledAsset).toBe(true)
    expect(asset.getResult().statusCode).toBe(200)
    expect(asset.getResult().headers['content-type']).toContain('application/javascript')
  })

  it('returns a friendly bundle-missing page for /admin', () => {
    const distDir = join(workdir, 'dist', 'admin')
    mkdirSync(distDir, { recursive: true })
    const result = createMockRes()

    const handled = handleAdminStatic(createMockReq('/admin/'), result.res, { distDir })

    expect(handled).toBe(true)
    expect(result.getResult().statusCode).toBe(503)
    expect(result.getResult().body).toContain('Admin bundle is not built yet')
  })

  it('falls through for legacy non-static /admin paths and unrelated /v1 paths', () => {
    const distDir = join(workdir, 'dist', 'admin')
    mkdirSync(distDir, { recursive: true })

    expect(handleAdminStatic(createMockReq('/admin/config'), createMockRes().res, { distDir })).toBe(false)
    expect(handleAdminStatic(createMockReq('/v1/models'), createMockRes().res, { distDir })).toBe(false)
  })

  it('exposes a clear token failure hint string', () => {
    expect(adminHandoffFailureHint()).toContain('rerun')
    expect(adminHandoffFailureHint()).toContain('auth failed')
  })
})
