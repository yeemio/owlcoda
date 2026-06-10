import { describe, it, expect } from 'vitest'
import { createSleepTool } from '../../src/native/tools/sleep.js'

describe('Sleep Tool', () => {
  it('has name Sleep', () => {
    const tool = createSleepTool()
    expect(tool.name).toBe('Sleep')
  })

  it('sleeps for the requested duration', async () => {
    const tool = createSleepTool()
    const start = Date.now()
    const result = await tool.execute({ durationSeconds: 0.1 })
    const elapsed = Date.now() - start
    expect(result.isError).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(80)  // allow some jitter
    expect(result.output).toContain('Slept for')
  })

  it('returns metadata with timing', async () => {
    const tool = createSleepTool()
    const result = await tool.execute({ durationSeconds: 0.05 })
    expect(result.metadata).toHaveProperty('requestedSeconds', 0.05)
    expect(result.metadata).toHaveProperty('actualSeconds')
  })

  it('rejects zero duration', async () => {
    const tool = createSleepTool()
    const result = await tool.execute({ durationSeconds: 0 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('positive number')
  })

  it('rejects negative duration', async () => {
    const tool = createSleepTool()
    const result = await tool.execute({ durationSeconds: -5 })
    expect(result.isError).toBe(true)
  })

  it('rejects excessive duration', async () => {
    const tool = createSleepTool()
    const result = await tool.execute({ durationSeconds: 999 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('maximum')
  })

  it('rejects non-number input', async () => {
    const tool = createSleepTool()
    const result = await tool.execute({ durationSeconds: 'five' as any })
    expect(result.isError).toBe(true)
  })
})
