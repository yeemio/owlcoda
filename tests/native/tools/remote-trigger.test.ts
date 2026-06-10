import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRemoteTriggerTool } from '../../../src/native/tools/remote-trigger.js'
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * RemoteTrigger uses ~/.owlcoda/triggers/ by default but honours
 * OWLCODA_TRIGGERS_DIR for tests. We point every test at an isolated
 * tmp dir so we never touch (or read from) the user's real store.
 */
describe('RemoteTrigger tool', () => {
  const tool = createRemoteTriggerTool()
  let tmpDir: string
  const prevEnv = process.env.OWLCODA_TRIGGERS_DIR

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'owlcoda-triggers-'))
    process.env.OWLCODA_TRIGGERS_DIR = tmpDir
  })

  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.OWLCODA_TRIGGERS_DIR
    else process.env.OWLCODA_TRIGGERS_DIR = prevEnv
    await rm(tmpDir, { recursive: true, force: true })
  })

  // ----- existing behaviour -----

  it('creates a trigger', async () => {
    const id = `test-trigger-${Date.now()}`
    const result = await tool.execute({ action: 'create', body: { id, description: 'test' } })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(id)
  })

  it('lists triggers (empty store)', async () => {
    const result = await tool.execute({ action: 'list' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No triggers found')
  })

  it('gets a trigger by id', async () => {
    const id = `test-get-${Date.now()}`
    await tool.execute({ action: 'create', body: { id, description: 'get test' } })
    const result = await tool.execute({ action: 'get', trigger_id: id })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(id)
  })

  it('updates a trigger', async () => {
    const id = `test-upd-${Date.now()}`
    await tool.execute({ action: 'create', body: { id, description: 'orig' } })
    const result = await tool.execute({
      action: 'update',
      trigger_id: id,
      body: { description: 'changed' },
    })
    expect(result.isError).toBe(false)
    const after = await tool.execute({ action: 'get', trigger_id: id })
    expect(after.output).toContain('changed')
  })

  it('runs a trigger', async () => {
    const id = `test-run-${Date.now()}`
    await tool.execute({ action: 'create', body: { id, description: 'run test' } })
    const result = await tool.execute({ action: 'run', trigger_id: id })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Triggered')
  })

  it('requires action', async () => {
    const result = await tool.execute({} as any)
    expect(result.isError).toBe(true)
  })

  it('has correct name', () => {
    expect(tool.name).toBe('RemoteTrigger')
  })

  // ----- new: list limit / filters -----

  async function seed(ids: string[], opts: { createdAt?: (i: number) => string } = {}) {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]
      const data: Record<string, unknown> = { id, description: `seeded ${id}` }
      data.createdAt = opts.createdAt ? opts.createdAt(i) : new Date().toISOString()
      await writeFile(join(tmpDir, `${id}.json`), JSON.stringify(data, null, 2), 'utf-8')
    }
  }

  it('list applies default limit of 50 with truncation hint', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `bulk-${String(i).padStart(4, '0')}`)
    await seed(ids)

    const result = await tool.execute({ action: 'list' })
    expect(result.isError).toBe(false)
    expect(result.metadata?.shown).toBe(50)
    expect(result.metadata?.totalAll).toBe(120)
    expect(result.metadata?.totalMatching).toBe(120)
    expect(result.metadata?.truncated).toBe(true)
    expect(result.output).toContain('120 total')
    expect(result.output).toContain('showing 50')
    // hint mentions limit/prefix/since/cleanup
    expect(result.output).toMatch(/limit/)
    expect(result.output).toMatch(/prefix|since/)
  })

  it('list respects custom limit', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`)
    await seed(ids)
    const result = await tool.execute({ action: 'list', limit: 10 })
    expect(result.metadata?.shown).toBe(10)
    expect(result.metadata?.truncated).toBe(true)
  })

  it('list filters by prefix', async () => {
    await seed(['real-alpha', 'real-beta', 'test-1', 'test-2', 'test-3'])
    const result = await tool.execute({ action: 'list', prefix: 'real-' })
    expect(result.isError).toBe(false)
    expect(result.metadata?.totalMatching).toBe(2)
    expect(result.metadata?.totalAll).toBe(5)
    const ids = (result.metadata?.triggers as Array<{ id: string }>).map(t => t.id).sort()
    expect(ids).toEqual(['real-alpha', 'real-beta'])
  })

  it('list filters by since', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    await seed(['old-1', 'old-2', 'new-1', 'new-2'], {
      createdAt: i => new Date(now - (i < 2 ? 40 : 1) * day).toISOString(),
    })
    const cutoff = new Date(now - 10 * day).toISOString()
    const result = await tool.execute({ action: 'list', since: cutoff })
    expect(result.metadata?.totalMatching).toBe(2)
    const ids = (result.metadata?.triggers as Array<{ id: string }>).map(t => t.id).sort()
    expect(ids).toEqual(['new-1', 'new-2'])
  })

  it('list combines prefix + limit and reports both totals', async () => {
    const real = Array.from({ length: 5 }, (_, i) => `prod-${i}`)
    const noisy = Array.from({ length: 200 }, (_, i) => `test-${i}`)
    await seed([...real, ...noisy])
    const result = await tool.execute({ action: 'list', prefix: 'test-', limit: 20 })
    expect(result.metadata?.totalAll).toBe(205)
    expect(result.metadata?.totalMatching).toBe(200)
    expect(result.metadata?.shown).toBe(20)
    expect(result.metadata?.truncated).toBe(true)
    expect(result.output).toContain('205 total')
    expect(result.output).toContain('test-')
  })

  it('list reports filter mismatch when nothing matches', async () => {
    await seed(['only-prod'])
    const result = await tool.execute({ action: 'list', prefix: 'nope-' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('No triggers match filter')
    expect(result.output).toContain('Total in store: 1')
  })

  it('list does not truncate when matching count <= limit', async () => {
    await seed(['a', 'b', 'c'])
    const result = await tool.execute({ action: 'list' })
    expect(result.metadata?.truncated).toBe(false)
    expect(result.metadata?.shown).toBe(3)
    expect(result.output).not.toContain('total, showing')
  })

  // ----- new: cleanup -----

  it('cleanup requires a filter', async () => {
    await seed(['x'])
    const result = await tool.execute({ action: 'cleanup' })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/requires at least one filter/)
  })

  it('cleanup is dry-run by default and does not delete', async () => {
    await seed(['test-a', 'test-b', 'real-c'])
    const result = await tool.execute({ action: 'cleanup', prefix: 'test-' })
    expect(result.isError).toBe(false)
    expect(result.metadata?.dryRun).toBe(true)
    expect(result.metadata?.matched).toBe(2)
    expect(result.output).toMatch(/dry-run/i)
    expect(result.output).toMatch(/confirm: true/)
    // files still there
    const files = await readdir(tmpDir)
    expect(files.length).toBe(3)
  })

  it('cleanup with confirm=true and prefix deletes matching files', async () => {
    await seed(['test-a', 'test-b', 'real-c'])
    const result = await tool.execute({ action: 'cleanup', prefix: 'test-', confirm: true })
    expect(result.isError).toBe(false)
    expect(result.metadata?.dryRun).toBe(false)
    expect(result.metadata?.deleted).toEqual(expect.arrayContaining(['test-a', 'test-b']))
    expect((result.metadata?.deleted as string[]).length).toBe(2)
    const files = (await readdir(tmpDir)).sort()
    expect(files).toEqual(['real-c.json'])
  })

  it('cleanup with olderThanDays deletes only old triggers', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    await seed(['stale-1', 'stale-2', 'fresh-1'], {
      createdAt: i => new Date(now - (i < 2 ? 40 : 1) * day).toISOString(),
    })
    const result = await tool.execute({
      action: 'cleanup',
      olderThanDays: 30,
      confirm: true,
    })
    expect(result.isError).toBe(false)
    expect((result.metadata?.deleted as string[]).sort()).toEqual(['stale-1', 'stale-2'])
    const files = await readdir(tmpDir)
    expect(files).toEqual(['fresh-1.json'])
  })

  it('cleanup combines prefix + olderThanDays', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    await seed(['test-old-1', 'test-old-2', 'test-new-1', 'real-old-1'], {
      createdAt: i => {
        // 0,1,3 -> 40d ago; 2 -> 1d ago
        const old = i === 2 ? 1 : 40
        return new Date(now - old * day).toISOString()
      },
    })
    const result = await tool.execute({
      action: 'cleanup',
      prefix: 'test-',
      olderThanDays: 30,
      confirm: true,
    })
    expect(result.isError).toBe(false)
    const deleted = (result.metadata?.deleted as string[]).sort()
    expect(deleted).toEqual(['test-old-1', 'test-old-2'])
    const files = (await readdir(tmpDir)).sort()
    expect(files).toEqual(['real-old-1.json', 'test-new-1.json'])
  })

  it('cleanup with `before` ISO date works', async () => {
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    await seed(['old-1', 'new-1'], {
      createdAt: i => new Date(now - (i === 0 ? 40 : 1) * day).toISOString(),
    })
    const before = new Date(now - 10 * day).toISOString()
    const result = await tool.execute({ action: 'cleanup', before, confirm: true })
    expect(result.isError).toBe(false)
    expect(result.metadata?.deleted).toEqual(['old-1'])
  })

  it('cleanup rejects invalid `before`', async () => {
    await seed(['x'])
    const result = await tool.execute({ action: 'cleanup', before: 'not-a-date', confirm: true })
    expect(result.isError).toBe(true)
    expect(result.output).toMatch(/invalid `before`/)
  })
})
