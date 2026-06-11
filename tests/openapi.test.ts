import { describe, it, expect } from 'vitest'
import { getOpenApiSpec } from '../src/openapi.js'

describe('OpenAPI spec', () => {
  const spec = getOpenApiSpec() as any

  it('has valid OpenAPI version', () => {
    expect(spec.openapi).toBe('3.0.3')
  })

  it('has title and version', () => {
    expect(spec.info.title).toBe('OwlCoda Proxy API')
    expect(spec.info.version).toBeTruthy()
  })

  it('includes /v1/messages path', () => {
    expect(spec.paths['/v1/messages']).toBeDefined()
    expect(spec.paths['/v1/messages'].post).toBeDefined()
  })

  it('includes /v1/models path', () => {
    expect(spec.paths['/v1/models']).toBeDefined()
    expect(spec.paths['/v1/models'].get).toBeDefined()
  })

  it('includes /healthz path', () => {
    expect(spec.paths['/healthz']).toBeDefined()
  })

  it('includes /dashboard path', () => {
    expect(spec.paths['/dashboard']).toBeDefined()
  })

  it('includes /openapi.json self-reference', () => {
    expect(spec.paths['/openapi.json']).toBeDefined()
  })

  it('has MessagesRequest schema', () => {
    expect(spec.components.schemas.MessagesRequest).toBeDefined()
    expect(spec.components.schemas.MessagesRequest.required).toContain('model')
    expect(spec.components.schemas.MessagesRequest.required).toContain('messages')
  })

  it('has ErrorResponse schema', () => {
    expect(spec.components.schemas.ErrorResponse).toBeDefined()
    expect(spec.components.schemas.ErrorResponse.required).toContain('type')
    expect(spec.components.schemas.ErrorResponse.required).toContain('error')
  })

  it('has MessagesResponse schema', () => {
    expect(spec.components.schemas.MessagesResponse).toBeDefined()
  })

  it('includes /metrics path', () => {
    expect(spec.paths['/metrics']).toBeDefined()
    expect(spec.paths['/metrics'].get).toBeDefined()
  })

  it('includes admin paths', () => {
    expect(spec.paths['/admin/reset-circuit-breakers']).toBeDefined()
    expect(spec.paths['/admin/config']).toBeDefined()
    expect(spec.paths['/admin/requests']).toBeDefined()
  })
})
