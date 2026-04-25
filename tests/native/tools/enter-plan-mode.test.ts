import { describe, it, expect } from 'vitest'
import { createEnterPlanModeTool, type PlanModeState } from '../../../src/native/tools/enter-plan-mode.js'

describe('EnterPlanMode tool', () => {
  function makeTool() {
    const state: PlanModeState = { inPlanMode: false }
    return { tool: createEnterPlanModeTool(state), state }
  }

  it('has correct name and description', () => {
    const { tool } = makeTool()
    expect(tool.name).toBe('EnterPlanMode')
    expect(tool.description).toContain('plan mode')
  })

  it('sets inPlanMode to true', async () => {
    const { tool, state } = makeTool()
    expect(state.inPlanMode).toBe(false)
    await tool.execute({})
    expect(state.inPlanMode).toBe(true)
  })

  it('returns planning rules in output', async () => {
    const { tool } = makeTool()
    const result = await tool.execute({})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('plan mode')
    expect(result.output).toContain('DO NOT write or edit')
  })

  it('returns plan mode metadata', async () => {
    const { tool } = makeTool()
    const result = await tool.execute({})
    expect(result.metadata).toEqual({ mode: 'plan' })
  })

  it('returns idempotent message if already in plan mode', async () => {
    const { tool, state } = makeTool()
    state.inPlanMode = true
    const result = await tool.execute({})
    expect(result.output).toContain('Already in plan mode')
    expect(result.isError).toBe(false)
    expect(state.inPlanMode).toBe(true)
  })

  it('clears previous planText on entry', async () => {
    const { tool, state } = makeTool()
    state.planText = 'old plan'
    await tool.execute({})
    expect(state.planText).toBeUndefined()
  })
})
