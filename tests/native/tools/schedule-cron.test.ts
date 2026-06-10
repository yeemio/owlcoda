import { describe, it, expect, beforeEach } from 'vitest'
import { createScheduleCronTool, resetCronStore } from '../../../src/native/tools/schedule-cron.js'

describe('ScheduleCron tool', () => {
  const tool = createScheduleCronTool()

  beforeEach(() => resetCronStore())

  it('creates a cron job', async () => {
    const result = await tool.execute({
      action: 'create',
      schedule: '0 2 * * *',
      command: 'tar czf backup.tar.gz /data',
    })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('cron-')
  })

  it('lists cron jobs', async () => {
    await tool.execute({ action: 'create', schedule: '* * * * *', command: 'echo hi' })
    const result = await tool.execute({ action: 'list' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('cron-')
  })

  it('deletes a cron job', async () => {
    await tool.execute({ action: 'create', schedule: '* * * * *', command: 'echo' })
    const result = await tool.execute({ action: 'delete', cron_id: 'cron-1' })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Deleted')
  })

  it('fails to delete non-existent job', async () => {
    const result = await tool.execute({ action: 'delete', cron_id: 'nope' })
    expect(result.isError).toBe(true)
  })

  it('requires action', async () => {
    const result = await tool.execute({} as any)
    expect(result.isError).toBe(true)
  })

  it('has correct name', () => {
    expect(tool.name).toBe('ScheduleCron')
  })
})
