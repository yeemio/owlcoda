import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runInit, formatInitResult, type InitResult } from '../src/init.js'

describe('init module', () => {
  let tmpDir: string
  let isolatedHome: string
  let isolatedOwlcodaHome: string
  let previousHome: string | undefined
  let previousOwlcodaHome: string | undefined
  let detectedModels: string[]
  let routerServer: Server
  let routerUrl: string

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'owlcoda-init-'))
    isolatedHome = join(tmpDir, 'home')
    isolatedOwlcodaHome = join(tmpDir, '.owlcoda')
    previousHome = process.env['HOME']
    previousOwlcodaHome = process.env['OWLCODA_HOME']
    detectedModels = []

    mkdirSync(isolatedHome, { recursive: true })
    process.env['HOME'] = isolatedHome
    process.env['OWLCODA_HOME'] = isolatedOwlcodaHome

    routerServer = createServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: detectedModels.map(id => ({ id })) }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })

    await new Promise<void>((resolve, reject) => {
      routerServer.listen(0, '127.0.0.1', err => {
        if (err) reject(err)
        else resolve()
      })
    })
    const address = routerServer.address()
    if (!address || typeof address === 'string') throw new Error('Failed to start fake router')
    routerUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => routerServer.close(() => resolve()))
    if (previousHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = previousHome
    if (previousOwlcodaHome === undefined) delete process.env['OWLCODA_HOME']
    else process.env['OWLCODA_HOME'] = previousOwlcodaHome
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('runInit creates config with expected structure', async () => {
    detectedModels = ['test-backend']
    const configPath = join(isolatedOwlcodaHome, 'config.json')

    const result = await runInit({ routerUrl })
    expect(result.created).toBe(true)
    expect(result.configPath).toBe(configPath)
    expect(existsSync(result.configPath)).toBe(true)

    const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(config.port).toBe(8019)
    expect(config.host).toBe('127.0.0.1')
    expect(config.routerUrl).toBe(routerUrl)
    expect(config.models).toHaveLength(1)
    expect(config.models[0].id).toBe('test-backend')
    expect(config.logLevel).toBe('info')
  }, 10_000)

  it('refuses to overwrite without --force', async () => {
    // First init
    const first = await runInit({ routerUrl })
    expect(first.created).toBe(true)

    // Second init without force
    const second = await runInit({ routerUrl })
    expect(second.created).toBe(false)
    expect(second.message).toContain('already exists')
  })

  it('overwrites with --force', async () => {
    await runInit({ routerUrl })
    const result = await runInit({ force: true, port: 9999, routerUrl })
    expect(result.created).toBe(true)

    const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(config.port).toBe(9999)
  })

  it('custom port is reflected in config', async () => {
    const result = await runInit({ port: 7777, routerUrl })
    expect(result.created).toBe(true)
    const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(config.port).toBe(7777)
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

  it('writes empty models[] when no local backend reachable (no placeholder default)', async () => {
    // The fake router returns no models to simulate the fresh install case.
    // Fresh init must not write the old sticky placeholder default.
    const result = await runInit({ routerUrl })
    expect(result.created).toBe(true)
    const config = JSON.parse(readFileSync(result.configPath, 'utf-8'))
    expect(Array.isArray(config.models)).toBe(true)
    expect(config.models).toEqual([])
    expect(JSON.stringify(config)).not.toContain('your-default-model')
  })

  it('formatInitResult points users at admin / cloud onboarding when no models detected', () => {
    const result: InitResult = {
      created: true,
      configPath: '/tmp/config.json',
      message: 'Created /tmp/config.json\nNo local backend reachable. Add a cloud provider in Admin or start a local runtime.',
    }
    const output = formatInitResult(result)
    expect(output).toContain('owlcoda admin')
    expect(output).not.toContain('Edit config.json')
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
