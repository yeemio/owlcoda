import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runValidation, formatValidationResult } from '../src/validate.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('validate command', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `owlcoda-validate-cmd-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports FILE_NOT_FOUND for missing config', () => {
    const result = runValidation(join(tmpDir, 'nonexistent.json'))
    expect(result.exists).toBe(false)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].code).toBe('FILE_NOT_FOUND')
  })

  it('reports INVALID_JSON for broken JSON', () => {
    const path = join(tmpDir, 'bad.json')
    writeFileSync(path, '{broken')
    const result = runValidation(path)
    expect(result.exists).toBe(true)
    expect(result.parseable).toBe(false)
    expect(result.issues[0].code).toBe('INVALID_JSON')
  })

  it('reports NOT_OBJECT for array config', () => {
    const path = join(tmpDir, 'array.json')
    writeFileSync(path, '[]')
    const result = runValidation(path)
    expect(result.issues[0].code).toBe('NOT_OBJECT')
  })

  it('reports schema issues for minimal config', () => {
    const path = join(tmpDir, 'minimal.json')
    writeFileSync(path, '{}')
    const result = runValidation(path)
    const codes = result.issues.map(i => i.code)
    expect(codes).toContain('MISSING_ROUTER_URL')
    expect(codes).toContain('NO_MODELS')
  })

  it('passes validation for valid config', () => {
    const path = join(tmpDir, 'good.json')
    writeFileSync(path, JSON.stringify({
      routerUrl: 'http://127.0.0.1:8009',
      port: 8019,
      defaultModel: 'qwen3:32b',
      models: [
        { id: 'qwen3:32b', tier: 'balanced' },
        { id: 'qwen3:8b', tier: 'fast' },
      ],
    }))
    const result = runValidation(path)
    const errors = result.issues.filter(i => i.level === 'error')
    expect(errors).toHaveLength(0)
  })

  it('detects semantic issues like trailing slash', () => {
    const path = join(tmpDir, 'semantic.json')
    writeFileSync(path, JSON.stringify({
      routerUrl: 'http://127.0.0.1:8009/',
      port: 8019,
      models: [
        { id: 'model-a', tier: 'balanced' },
        { id: 'model-b', tier: 'balanced' },
      ],
    }))
    const result = runValidation(path)
    const codes = result.issues.map(i => i.code)
    expect(codes).toContain('TRAILING_SLASH')
  })

  it('formatValidationResult shows success for valid config', () => {
    const path = join(tmpDir, 'good.json')
    writeFileSync(path, JSON.stringify({
      routerUrl: 'http://127.0.0.1:8009',
      port: 8019,
      defaultModel: 'qwen3:32b',
      models: [
        { id: 'qwen3:32b', tier: 'balanced' },
        { id: 'qwen3:8b', tier: 'fast' },
      ],
    }))
    const result = runValidation(path)
    const output = formatValidationResult(result)
    expect(output).toContain('✅')
  })

  it('formatValidationResult shows error for missing file', () => {
    const result = runValidation(join(tmpDir, 'missing.json'))
    const output = formatValidationResult(result)
    expect(output).toContain('❌')
    expect(output).toContain('owlcoda init')
  })
})
