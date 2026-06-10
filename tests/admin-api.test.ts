import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverSource = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8')
const adminSource = readFileSync(join(__dirname, '..', 'src', 'routes', 'admin.ts'), 'utf-8')
const openapiSource = readFileSync(join(__dirname, '..', 'src', 'openapi.ts'), 'utf-8')

describe('Admin API endpoints (server.ts + routes/admin.ts)', () => {
  it('mounts /admin/api handler on the main server router', () => {
    expect(serverSource).toContain("url.startsWith('/admin/api/')")
    expect(serverSource).toContain('handleAdminApiRequest')
  })

  it('mounts /admin static handler ahead of legacy bearer-gated routes', () => {
    expect(serverSource).toContain('handleAdminStatic')
  })

  it('has POST /admin/reset-circuit-breakers', () => {
    expect(serverSource).toContain("'/admin/reset-circuit-breakers'")
    expect(adminSource).toContain('resetCircuitBreaker()')
  })

  it('has POST /admin/reset-budgets', () => {
    expect(serverSource).toContain("'/admin/reset-budgets'")
    expect(adminSource).toContain('resetBudgets()')
  })

  it('has POST /admin/reload-config', () => {
    expect(serverSource).toContain("'/admin/reload-config'")
    expect(adminSource).toContain('readFileSync')
    expect(adminSource).toContain('getOwlcodaConfigPath')
  })

  it('has GET /admin/config with key redaction', () => {
    expect(serverSource).toContain("'/admin/config'")
    expect(adminSource).toContain("'***'")
  })

  it('has GET /admin/requests with optional count param', () => {
    expect(serverSource).toContain("'/admin/requests'")
    expect(serverSource).toContain('getRecentTraces')
  })

  it('has GET /admin/audit with optional count param', () => {
    expect(serverSource).toContain("'/admin/audit'")
    expect(serverSource).toContain('readAuditLog')
  })

  it('imports resetCircuitBreaker', () => {
    expect(serverSource).toContain('resetCircuitBreaker')
  })

  it('imports resetBudgets', () => {
    expect(serverSource).toContain('resetBudgets')
  })

  it('imports readAuditLog', () => {
    expect(serverSource).toContain('readAuditLog')
  })
})

describe('Admin API in discovery endpoint', () => {
  it('lists admin endpoints in discovery', () => {
    expect(serverSource).toContain('/admin/reset-circuit-breakers')
    expect(serverSource).toContain('/admin/reload-config')
    expect(serverSource).toContain('/admin/config')
    expect(serverSource).toContain('/admin/requests')
    expect(serverSource).toContain('/admin/audit')
  })
})

describe('Admin API in OpenAPI spec', () => {
  it('documents reset-circuit-breakers', () => {
    expect(openapiSource).toContain('/admin/reset-circuit-breakers')
  })

  it('documents reset-budgets', () => {
    expect(openapiSource).toContain('/admin/reset-budgets')
  })

  it('documents reload-config', () => {
    expect(openapiSource).toContain('/admin/reload-config')
  })

  it('documents admin/config', () => {
    expect(openapiSource).toContain('/admin/config')
  })

  it('documents admin/requests', () => {
    expect(openapiSource).toContain('/admin/requests')
  })

  it('documents admin/audit', () => {
    expect(openapiSource).toContain('/admin/audit')
  })
})

describe('Admin API auth guard', () => {
  it('has auth guard checking adminToken', () => {
    expect(serverSource).toContain('config.adminToken')
  })

  it('returns validation warnings on reload-config', () => {
    expect(adminSource).toContain('warnings')
    expect(adminSource).toContain('validateConfigSchema')
  })
})
