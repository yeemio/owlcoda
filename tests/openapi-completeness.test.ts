/**
 * Tests that OpenAPI spec covers all endpoints declared in api-info.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')
const openapiSource = readFileSync(join(__dirname, '..', 'src', 'openapi.ts'), 'utf-8')

// Extract endpoint paths from the api-info discovery block in server.ts
function extractApiInfoPaths(): string[] {
  const matches = serverSource.matchAll(/path:\s*'([^']+)'/g)
  return [...matches].map(m => m[1]!)
}

describe('OpenAPI completeness', () => {
  const apiInfoPaths = extractApiInfoPaths()

  it('api-info declares at least 10 endpoints', () => {
    expect(apiInfoPaths.length).toBeGreaterThanOrEqual(10)
  })

  for (const path of apiInfoPaths) {
    it(`OpenAPI spec documents ${path}`, () => {
      expect(openapiSource).toContain(`'${path}'`)
    })
  }

  it('OpenAPI includes /events/metrics SSE endpoint', () => {
    expect(openapiSource).toContain("'/events/metrics'")
    expect(openapiSource).toContain('text/event-stream')
  })

  it('OpenAPI includes /v1/usage with pricingNote', () => {
    expect(openapiSource).toContain("'/v1/usage'")
    expect(openapiSource).toContain('pricingNote')
  })

  it('OpenAPI includes /v1/api-info', () => {
    expect(openapiSource).toContain("'/v1/api-info'")
  })

  it('server.ts routes are all discoverable via api-info', () => {
    // Key routes that must appear in api-info
    const keyRoutes = ['/v1/messages', '/v1/models', '/healthz', '/health', '/metrics', '/dashboard']
    for (const route of keyRoutes) {
      expect(apiInfoPaths).toContain(route)
    }
  })
})
