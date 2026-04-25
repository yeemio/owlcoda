import { describe, it, expect } from 'vitest'
import { createWorkflowTool, WORKFLOW_TOOL_NAME } from '../../../src/native/tools/workflow.js'

describe('Workflow tool (stub)', () => {
  const tool = createWorkflowTool()

  it('returns not-available error', async () => {
    const result = await tool.execute({})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not available')
  })

  it('has correct name', () => {
    expect(tool.name).toBe('Workflow')
  })

  it('exports constant name', () => {
    expect(WORKFLOW_TOOL_NAME).toBe('Workflow')
  })
})
