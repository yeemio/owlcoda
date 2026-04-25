import { describe, it, expect } from 'vitest'
import { createExitPlanModeTool } from '../../../src/native/tools/exit-plan-mode.js'
import type { PlanModeState } from '../../../src/native/tools/enter-plan-mode.js'

describe('ExitPlanMode tool', () => {
  function makeTool(planMode = true) {
    const state: PlanModeState = { inPlanMode: planMode }
    return { tool: createExitPlanModeTool(state), state }
  }

  it('has correct name and description', () => {
    const { tool } = makeTool()
    expect(tool.name).toBe('ExitPlanMode')
    expect(tool.description).toContain('plan')
  })

  it('sets inPlanMode to false', async () => {
    const { tool, state } = makeTool(true)
    await tool.execute({})
    expect(state.inPlanMode).toBe(false)
  })

  it('returns implementation go-ahead', async () => {
    const { tool } = makeTool(true)
    const result = await tool.execute({})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Exited plan mode')
    expect(result.output).toContain('proceed with implementation')
  })

  it('errors when not in plan mode', async () => {
    const { tool, state } = makeTool(false)
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Not currently in plan mode')
    expect(state.inPlanMode).toBe(false)
  })

  it('includes allowedPrompts in output when provided', async () => {
    const { tool } = makeTool(true)
    const result = await tool.execute({
      allowedPrompts: [
        { tool: 'Bash', prompt: 'run tests' },
        { tool: 'Write', prompt: 'create config' },
      ],
    })
    expect(result.output).toContain('Bash: run tests')
    expect(result.output).toContain('Write: create config')
    expect(result.metadata).toHaveProperty('allowedPrompts')
  })

  it('returns normal mode metadata', async () => {
    const { tool } = makeTool(true)
    const result = await tool.execute({})
    expect(result.metadata).toHaveProperty('mode', 'normal')
  })
})
