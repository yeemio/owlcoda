import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createConfigTool } from '../../../src/native/tools/config.js'

describe('Config tool', () => {
  const tool = createConfigTool()
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    savedEnv.OWLCODA_VERBOSE = process.env.OWLCODA_VERBOSE
    savedEnv.OWLCODA_AUTO_COMPACT = process.env.OWLCODA_AUTO_COMPACT
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('has correct name and description', () => {
    expect(tool.name).toBe('Config')
    expect(tool.description).toContain('setting')
  })

  // --- READ operations ---

  it('reads theme setting', async () => {
    const result = await tool.execute({ setting: 'theme' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('theme =')
    expect(result.output).toContain('options:')
  })

  it('reads verbose setting', async () => {
    delete process.env.OWLCODA_VERBOSE
    const result = await tool.execute({ setting: 'verbose' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('verbose = false')
  })

  it('reads autoCompact setting', async () => {
    const result = await tool.execute({ setting: 'autoCompact' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('autoCompact =')
  })

  it('reads model setting', async () => {
    const result = await tool.execute({ setting: 'model' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('model =')
  })

  // --- SET operations ---

  it('sets verbose to true', async () => {
    const result = await tool.execute({ setting: 'verbose', value: 'true' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Set verbose')
    expect(process.env.OWLCODA_VERBOSE).toBe('true')
  })

  it('sets autoCompact to false', async () => {
    const result = await tool.execute({ setting: 'autoCompact', value: 'false' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Set autoCompact')
    expect(process.env.OWLCODA_AUTO_COMPACT).toBe('false')
  })

  // --- Error cases ---

  it('rejects unknown setting', async () => {
    const result = await tool.execute({ setting: 'nonexistent' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Unknown setting')
    expect(result.output).toContain('Known settings:')
  })

  it('rejects write to read-only setting', async () => {
    const result = await tool.execute({ setting: 'model', value: 'gpt-4' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('read-only')
  })

  it('rejects invalid theme value', async () => {
    const result = await tool.execute({ setting: 'theme', value: 'neon' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid value')
  })

  // --- Metadata ---

  it('get includes metadata with operation and value', async () => {
    const result = await tool.execute({ setting: 'verbose' })
    expect(result.metadata).toHaveProperty('operation', 'get')
    expect(result.metadata).toHaveProperty('setting', 'verbose')
  })

  it('set includes metadata with previous and new value', async () => {
    const result = await tool.execute({ setting: 'verbose', value: 'true' })
    expect(result.metadata).toHaveProperty('operation', 'set')
    expect(result.metadata).toHaveProperty('previousValue')
    expect(result.metadata).toHaveProperty('newValue')
  })

  // --- autoApprove (yolo) programmatic toggle ---

  it('autoApprove read returns false when no setter is wired (default registration)', async () => {
    const result = await tool.execute({ setting: 'autoApprove' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('autoApprove = false')
  })

  it('autoApprove write rejected when no setter is wired (default registration)', async () => {
    const result = await tool.execute({ setting: 'autoApprove', value: 'true' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('read-only')
  })

  it('autoApprove read/write works when wired with deps', async () => {
    let yolo = false
    const wired = createConfigTool({
      autoApprove: {
        get: () => yolo,
        set: (v: boolean) => { yolo = v },
      },
    })
    const r1 = await wired.execute({ setting: 'autoApprove' })
    expect(r1.output).toContain('autoApprove = false')

    const r2 = await wired.execute({ setting: 'autoApprove', value: 'true' })
    expect(r2.isError).toBe(false)
    expect(r2.output).toContain('Set autoApprove = true')
    expect(yolo).toBe(true)

    const r3 = await wired.execute({ setting: 'autoApprove' })
    expect(r3.output).toContain('autoApprove = true')

    const r4 = await wired.execute({ setting: 'autoApprove', value: 'false' })
    expect(r4.isError).toBe(false)
    expect(yolo).toBe(false)
  })

  // --- autoDeny (QA verification mode, 0.13.42) ---

  it('autoDeny read returns false when no setter is wired (default registration)', async () => {
    const result = await tool.execute({ setting: 'autoDeny' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('autoDeny = false')
  })

  it('autoDeny write rejected when no setter is wired (default registration)', async () => {
    const result = await tool.execute({ setting: 'autoDeny', value: 'true' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('read-only')
  })

  it('autoDeny read/write works when wired with deps', async () => {
    let denyAll = false
    const wired = createConfigTool({
      autoDeny: {
        get: () => denyAll,
        set: (v: boolean) => { denyAll = v },
      },
    })
    const r1 = await wired.execute({ setting: 'autoDeny' })
    expect(r1.output).toContain('autoDeny = false')

    const r2 = await wired.execute({ setting: 'autoDeny', value: 'true' })
    expect(r2.isError).toBe(false)
    expect(r2.output).toContain('Set autoDeny = true')
    expect(denyAll).toBe(true)

    const r3 = await wired.execute({ setting: 'autoDeny' })
    expect(r3.output).toContain('autoDeny = true')
  })
})
