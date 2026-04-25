/**
 * Models endpoint unit tests — handleModels response shape and edge cases.
 */
import { describe, it, expect } from 'vitest'
import { handleModels } from '../src/endpoints/models.js'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { OwlCodaConfig } from '../src/config.js'

interface MockResult { statusCode: number; body: string; headers: Record<string, string> }

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
    return origWriteHead(code, ...args)
  } as any

  const origEnd = res.end.bind(res)
  res.end = function (data?: any) {
    if (data) body = typeof data === 'string' ? data : data.toString()
    return origEnd(data)
  } as any

  return { res, getResult: () => ({ statusCode, body, headers }) }
}

function createMockReq(): IncomingMessage {
  return new IncomingMessage(new Socket())
}

function makeConfig(models: any[] = []): OwlCodaConfig {
  return {
    port: 8019,
    host: '127.0.0.1',
    routerUrl: 'http://127.0.0.1:9999',
    routerTimeoutMs: 5000,
    models,
    responseModelStyle: 'platform',
    catalogLoaded: false,
    modelMap: {},
    defaultModel: '',
    reverseMapInResponse: true,
    logLevel: 'error',
    contextWindow: 32768,
  } as unknown as OwlCodaConfig
}

describe('handleModels', () => {
  it('returns all configured models with correct shape', async () => {
    const config = makeConfig([
      { id: 'model-a', label: 'Model A', backendModel: 'model-a', aliases: [], tier: 'general', default: true, contextWindow: 32768, availability: 'available' },
      { id: 'model-b', label: 'Model B', backendModel: 'model-b', aliases: [], tier: 'heavy', contextWindow: 65536, availability: 'unavailable' },
    ])
    const { res, getResult } = createMockRes()
    await handleModels(createMockReq(), res, config)
    const r = getResult()
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.data).toHaveLength(2)
    expect(body.data[0]).toMatchObject({ id: 'model-a', display_name: 'Model A', type: 'model', availability: 'available' })
    expect(body.data[1]).toMatchObject({ id: 'model-b', display_name: 'Model B', type: 'model', availability: 'unavailable' })
  })

  it('availability defaults to unknown when not set', async () => {
    const config = makeConfig([
      { id: 'x', label: 'X', backendModel: 'x', aliases: [], tier: 'general', default: true, contextWindow: 32768 },
    ])
    const { res, getResult } = createMockRes()
    await handleModels(createMockReq(), res, config)
    const body = JSON.parse(getResult().body)
    expect(body.data[0].availability).toBe('unknown')
  })

  it('returns empty data array when no models configured', async () => {
    const config = makeConfig([])
    const { res, getResult } = createMockRes()
    await handleModels(createMockReq(), res, config)
    const body = JSON.parse(getResult().body)
    expect(body.data).toEqual([])
    expect(body.first_id).toBeNull()
    expect(body.last_id).toBeNull()
  })

  it('has_more is always false', async () => {
    const config = makeConfig([
      { id: 'a', label: 'A', backendModel: 'a', aliases: [], tier: 'general', default: true, contextWindow: 32768 },
    ])
    const { res, getResult } = createMockRes()
    await handleModels(createMockReq(), res, config)
    const body = JSON.parse(getResult().body)
    expect(body.has_more).toBe(false)
  })

  it('first_id and last_id reflect actual model list', async () => {
    const config = makeConfig([
      { id: 'first', label: 'F', backendModel: 'first', aliases: [], tier: 'general', contextWindow: 32768 },
      { id: 'middle', label: 'M', backendModel: 'middle', aliases: [], tier: 'general', contextWindow: 32768 },
      { id: 'last', label: 'L', backendModel: 'last', aliases: [], tier: 'general', contextWindow: 32768 },
    ])
    const { res, getResult } = createMockRes()
    await handleModels(createMockReq(), res, config)
    const body = JSON.parse(getResult().body)
    expect(body.first_id).toBe('first')
    expect(body.last_id).toBe('last')
  })

  it('sets CORS headers', async () => {
    const config = makeConfig([
      { id: 'x', label: 'X', backendModel: 'x', aliases: [], tier: 'general', default: true, contextWindow: 32768 },
    ])
    const { res, getResult } = createMockRes()
    await handleModels(createMockReq(), res, config)
    const r = getResult()
    expect(r.headers['access-control-allow-origin']).toBe('*')
    expect(r.headers['access-control-allow-headers']).toBe('*')
  })

  it('each model has created_at timestamp', async () => {
    const config = makeConfig([
      { id: 'x', label: 'X', backendModel: 'x', aliases: [], tier: 'general', default: true, contextWindow: 32768 },
    ])
    const { res, getResult } = createMockRes()
    await handleModels(createMockReq(), res, config)
    const body = JSON.parse(getResult().body)
    expect(body.data[0].created_at).toBe('2026-01-01T00:00:00Z')
  })
})
