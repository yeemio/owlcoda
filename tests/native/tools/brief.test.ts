import { describe, it, expect } from 'vitest'
import { createBriefTool } from '../../../src/native/tools/brief.js'

describe('Brief tool', () => {
  const tool = createBriefTool()

  it('returns message text', async () => {
    const result = await tool.execute({ message: 'Build succeeded.' })
    expect(result.isError).toBe(false)
    expect(result.output).toBe('Build succeeded.')
  })

  it('requires message', async () => {
    const result = await tool.execute({ message: '' })
    expect(result.isError).toBe(true)
  })

  it('validates attachments exist', async () => {
    const result = await tool.execute({ message: 'Hi', attachments: ['/nonexistent/file.txt'] })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('not accessible')
  })

  it('allows valid file attachments', async () => {
    const result = await tool.execute({ message: 'Results', attachments: [__filename] })
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Attachments')
  })

  it('has correct name', () => {
    expect(tool.name).toBe('Brief')
  })
})
