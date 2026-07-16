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

  it('reports the project license', () => {
    expect(spec.info.license).toEqual({
      name: 'GPL-3.0-or-later',
      url: 'https://www.gnu.org/licenses/gpl-3.0.html',
    })
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

  it('documents typed structured-output budget exhaustion', () => {
    const response = spec.components.schemas.StructuredOutputResponse
    const failureReason = spec.components.schemas.StructuredOutputFailureReason
    expect(failureReason.enum).toContain('output_budget_exhausted')
    expect(response.properties.failureReason.$ref).toBe('#/components/schemas/StructuredOutputFailureReason')
    expect(response.properties.unusableReason.$ref).toBe('#/components/schemas/StructuredOutputFailureReason')
    expect(spec.components.schemas.StructuredOutputAttempt.properties.failureReason.$ref)
      .toBe('#/components/schemas/StructuredOutputFailureReason')
    expect(response.properties.stopReason).toMatchObject({ type: 'string', nullable: true })
  })

  it('documents execution economics, idempotency, and task-budget stop responses', () => {
    const request = spec.components.schemas.StructuredOutputRequest
    const response = spec.components.schemas.StructuredOutputResponse
    expect(request.properties.executionBudget.$ref).toBe('#/components/schemas/StructuredOutputExecutionBudget')
    expect(request.properties.idempotencyKey).toMatchObject({ type: 'string', minLength: 8 })
    expect(response.properties.executionCounts.$ref).toBe('#/components/schemas/StructuredOutputExecutionCounts')
    expect(response.properties.executionEconomics.$ref).toBe('#/components/schemas/StructuredOutputExecutionEconomics')
    const economics = spec.components.schemas.StructuredOutputExecutionEconomics
    expect(economics.properties.current.$ref).toBe('#/components/schemas/StructuredOutputExecutionTotals')
    expect(economics.properties.cumulative.$ref).toBe('#/components/schemas/StructuredOutputExecutionTotals')
    expect(economics.properties.reservation.$ref).toBe('#/components/schemas/StructuredOutputBudgetReservation')
    expect(economics.properties.stopReceipt.$ref).toBe('#/components/schemas/StructuredOutputBudgetStopReceipt')
    expect(spec.paths['/v1/structured-output'].post.responses['409']).toBeDefined()
    expect(spec.paths['/v1/structured-output'].post.responses['429']).toBeDefined()
    expect(spec.components.schemas.ErrorResponse.properties.error.properties.type.enum)
      .toEqual(expect.arrayContaining(['idempotency_conflict', 'task_budget_contract_mismatch', 'task_budget_exhausted']))
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
