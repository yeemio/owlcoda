import { describe, it, expect } from 'vitest'
import { migrateConfig, needsMigration, formatMigrationResult, CURRENT_CONFIG_VERSION, MIGRATIONS } from '../src/config-migrate.js'

describe('config-migrate', () => {
  it('migrates a bare config from version 0', () => {
    const result = migrateConfig({
      routerUrl: 'http://127.0.0.1:8009/',
      models: [{ id: 'test-model', tier: 'balanced' }],
    })
    expect(result.fromVersion).toBe(0)
    expect(result.toVersion).toBe(CURRENT_CONFIG_VERSION)
    expect(result.applied.length).toBe(MIGRATIONS.length)
    expect(result.config.configVersion).toBe(CURRENT_CONFIG_VERSION)
  })

  it('normalizes trailing slash on routerUrl', () => {
    const result = migrateConfig({
      routerUrl: 'http://127.0.0.1:8009/',
      models: [],
    })
    expect(result.config.routerUrl).toBe('http://127.0.0.1:8009')
  })

  it('adds backendModel to models', () => {
    const result = migrateConfig({
      routerUrl: 'http://127.0.0.1:8009',
      models: [{ id: 'qwen3:32b', tier: 'balanced' }],
    })
    const models = result.config.models as Array<Record<string, unknown>>
    expect(models[0].backendModel).toBe('qwen3:32b')
  })

  it('preserves existing backendModel', () => {
    const result = migrateConfig({
      routerUrl: 'http://127.0.0.1:8009',
      models: [{ id: 'my-model', backendModel: 'custom-backend', tier: 'balanced' }],
    })
    const models = result.config.models as Array<Record<string, unknown>>
    expect(models[0].backendModel).toBe('custom-backend')
  })

  it('adds default port', () => {
    const result = migrateConfig({
      routerUrl: 'http://127.0.0.1:8009',
      models: [],
    })
    expect(result.config.port).toBe(8019)
  })

  it('preserves existing port', () => {
    const result = migrateConfig({
      routerUrl: 'http://127.0.0.1:8009',
      port: 9000,
      models: [],
    })
    expect(result.config.port).toBe(9000)
  })

  it('skips already-applied migrations', () => {
    const result = migrateConfig({
      routerUrl: 'http://127.0.0.1:8009',
      models: [],
      configVersion: CURRENT_CONFIG_VERSION,
    })
    expect(result.applied).toHaveLength(0)
  })

  it('needsMigration returns true for old config', () => {
    expect(needsMigration({})).toBe(true)
    expect(needsMigration({ configVersion: 0 })).toBe(true)
  })

  it('needsMigration returns false for current config', () => {
    expect(needsMigration({ configVersion: CURRENT_CONFIG_VERSION })).toBe(false)
  })

  it('formatMigrationResult shows applied migrations', () => {
    const result = migrateConfig({})
    const output = formatMigrationResult(result)
    expect(output).toContain('Migrated')
    expect(output).toContain('✓')
  })

  it('formatMigrationResult shows up-to-date message', () => {
    const result = migrateConfig({ configVersion: CURRENT_CONFIG_VERSION })
    const output = formatMigrationResult(result)
    expect(output).toContain('up to date')
  })
})
