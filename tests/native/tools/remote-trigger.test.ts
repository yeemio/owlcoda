import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRemoteTriggerTool } from '../../../src/native/tools/remote-trigger.js'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * RemoteTrigger uses ~/.owlcoda/triggers/ by default.
 * We test with the default (it creates the dir if needed)
 * but use unique trigger_ids to avoid collisions.
 */
describe('RemoteTrigger tool', () => {
  const tool = createRemoteTriggerTool()
  const testIds: string[] = []

  afterEach(async () => {
    // Clean up triggers created during tests
    for (const id of testIds) {
      await tool.execute({ action: 'run', trigger_id: id }).catch(() => {})
    }
    testIds.length = 0
  })

  it('creates a trigger', async () => {
    const id = `test-trigger-${Date.now()}`
    testIds.push(id)
    const result = await tool.execute({ action: 'create', body: { id, description: 'test' } })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(id)
  })

  it('lists triggers', async () => {
    const result = await tool.execute({ action: 'list' })
    expect(result.isError).toBe(false)
  })

  it('gets a trigger by id', async () => {
    const id = `test-get-${Date.now()}`
    testIds.push(id)
    await tool.execute({ action: 'create', body: { id, description: 'get test' } })
    const result = await tool.execute({ action: 'get', trigger_id: id })
    expect(result.isError).toBe(false)
    expect(result.output).toContain(id)
  })

  it('runs a trigger', async () => {
    const id = `test-run-${Date.now()}`
    testIds.push(id)
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
})
