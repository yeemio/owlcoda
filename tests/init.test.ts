import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInit, formatInitResult, type InitResult } from '../src/init.js'

describe('init module', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'owlcoda-init-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runInit creates config with expected structure', async () => {
    // Use a custom config path via env override
    const configPath = join(tmpDir, 'config.json')
    process.env['OWLCODA_HOME'] = tmpDir
    try {
      const result = await runInit({ routerUrl: 'http://127.0.0.1:9999' })
      expect(result.created).toBe(true)
      expect(result.configPath).toContain('config.json')
      expect(existsSync(result.configPath)).toBe(true)

      const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
      expect(config.port).toBe(8019)
      expect(config.host).toBe('127.0.0.1')
      expect(config.routerUrl).toBe('http://127.0.0.1:9999')
      expect(Array.isArray(config.models)).toBe(true)
      expect(config.models.length).toBeGreaterThanOrEqual(1)
      expect(config.logLevel).toBe('info')
    } finally {
      delete process.env['OWLCODA_HOME']
    }
  })

  it('refuses to overwrite without --force', async () => {
    process.env['OWLCODA_HOME'] = tmpDir
    try {
      // First init
      const first = await runInit()
      expect(first.created).toBe(true)

      // Second init without force
      const second = await runInit()
      expect(second.created).toBe(false)
      expect(second.message).toContain('already exists')
    } finally {
      delete process.env['OWLCODA_HOME']
    }
  })

  it('overwrites with --force', async () => {
    process.env['OWLCODA_HOME'] = tmpDir
    try {
      await runInit()
      const result = await runInit({ force: true, port: 9999 })
      expect(result.created).toBe(true)

      const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
      expect(config.port).toBe(9999)
    } finally {
      delete process.env['OWLCODA_HOME']
    }
  })

  it('custom port is reflected in config', async () => {
    process.env['OWLCODA_HOME'] = tmpDir
    try {
      const result = await runInit({ port: 7777 })
      expect(result.created).toBe(true)
      const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
      expect(config.port).toBe(7777)
    } finally {
      delete process.env['OWLCODA_HOME']
    }
  })

  it('formatInitResult shows success message for created config', () => {
    const result: InitResult = {
      created: true,
      configPath: '/tmp/config.json',
      message: 'Created /tmp/config.json\nUsing placeholder model config',
    }
    const output = formatInitResult(result)
    expect(output).toContain('✅')
    expect(output).toContain('owlcoda doctor')
    expect(output).toContain('owlcoda')
  })

  it('formatInitResult shows warning for existing config', () => {
    const result: InitResult = {
      created: false,
      configPath: '/tmp/config.json',
      message: 'Config already exists at /tmp/config.json. Use --force to overwrite.',
    }
    const output = formatInitResult(result)
    expect(output).toContain('⚠️')
    expect(output).toContain('--force')
  })

  it('formatInitResult shows detected models', () => {
    const result: InitResult = {
      created: true,
      configPath: '/tmp/config.json',
      message: 'Created /tmp/config.json\nAuto-detected 2 model(s)',
      modelsDetected: ['model-a', 'model-b'],
    }
    const output = formatInitResult(result)
    expect(output).toContain('✅')
  })

  it('init command is wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'init'])
    expect(result.command).toBe('init')
  })

  it('--force flag is parsed', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'init', '--force'])
    expect(result.command).toBe('init')
    expect(result.force).toBe(true)
  })
})
