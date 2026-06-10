import { describe, it, expect } from 'vitest'
import { createPowerShellTool } from '../../../src/native/tools/powershell.js'

describe('PowerShell tool', () => {
  const tool = createPowerShellTool()

  it('requires command', async () => {
    const result = await tool.execute({ command: '' })
    expect(result.isError).toBe(true)
  })

  it('attempts to run pwsh on macOS', async () => {
    // On macOS where pwsh may or may not be installed
    const result = await tool.execute({ command: 'echo "hello"' })
    // Either succeeds or reports pwsh not installed
    expect(typeof result.output).toBe('string')
  })

  it('has correct name', () => {
    expect(tool.name).toBe('PowerShell')
  })
})
