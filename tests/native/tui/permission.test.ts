import { describe, it, expect } from 'vitest'
import {
  renderPermissionDialog,
  renderInlinePermission,
  renderTopBorderDialog,
  renderBashPermission,
  renderFilePermission,
  renderWebPermission,
  detectDestructiveCommand,
} from '../../../src/native/tui/permission.js'
import { stripAnsi } from '../../../src/native/tui/colors.js'

describe('renderPermissionDialog', () => {
  it('produces bordered output with title', () => {
    const result = renderPermissionDialog({
      toolName: 'Bash',
      action: 'execute a command',
      detail: 'ls -la',
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('Permission Required')
    expect(plain).toContain('Bash')
    expect(plain).toContain('execute a command')
    expect(plain).toContain('ls -la')
    // Has box borders
    expect(plain).toContain('╭')
    expect(plain).toContain('╰')
  })

  it('includes default choices', () => {
    const result = renderPermissionDialog({
      toolName: 'Write',
      action: 'write a file',
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('[Y]')
    expect(plain).toContain('[N]')
    expect(plain).toContain('[A]')
    expect(plain).toContain('Approve')
    expect(plain).toContain('Reject')
  })

  it('supports custom choices', () => {
    const result = renderPermissionDialog({
      toolName: 'Test',
      action: 'test',
      choices: [{ key: 'x', label: 'Execute', isDefault: true }],
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('[X]')
    expect(plain).toContain('Execute')
  })
})

describe('renderTopBorderDialog', () => {
  it('renders top border with title', () => {
    const result = renderTopBorderDialog({
      title: 'My Dialog',
      content: ['line one', 'line two'],
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('╭')
    expect(plain).toContain('╮')
    expect(plain).toContain('My Dialog')
    expect(plain).toContain('line one')
    expect(plain).toContain('line two')
  })

  it('does NOT have bottom border', () => {
    const result = renderTopBorderDialog({
      title: 'Top Only',
      content: ['content'],
    })
    const plain = stripAnsi(result)
    // Only top border chars, no bottom
    expect(plain).not.toContain('╰')
    expect(plain).not.toContain('╯')
  })

  it('includes subtitle when provided', () => {
    const result = renderTopBorderDialog({
      title: 'Title',
      subtitle: 'A subtitle note',
      content: ['body'],
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('A subtitle note')
  })
})

describe('renderBashPermission', () => {
  it('shows command with $ prefix', () => {
    const result = renderBashPermission('rm -rf /tmp/old')
    const plain = stripAnsi(result)
    expect(plain).toContain('$ rm -rf /tmp/old')
    expect(plain).toContain('Bash')
    expect(plain).toContain('[Y]')
  })

  it('shows cwd when provided', () => {
    const result = renderBashPermission('ls', '/home/user')
    const plain = stripAnsi(result)
    expect(plain).toContain('/home/user')
  })

  it('truncates long commands', () => {
    const longCmd = 'echo ' + 'x'.repeat(200)
    const result = renderBashPermission(longCmd)
    // Should render without error
    expect(result).toBeTruthy()
  })
})

describe('renderFilePermission', () => {
  it('shows file path and action', () => {
    const result = renderFilePermission('/src/main.ts', 'edit')
    const plain = stripAnsi(result)
    expect(plain).toContain('/src/main.ts')
    expect(plain).toContain('Edit file')
    expect(plain).toContain('File')
  })

  it('uses correct labels for different actions', () => {
    expect(stripAnsi(renderFilePermission('/a', 'read'))).toContain('Read file')
    expect(stripAnsi(renderFilePermission('/a', 'write'))).toContain('Write file')
    expect(stripAnsi(renderFilePermission('/a', 'create'))).toContain('Create file')
  })
})

describe('renderWebPermission', () => {
  it('shows URL and method', () => {
    const result = renderWebPermission('https://example.com/api', 'POST')
    const plain = stripAnsi(result)
    expect(plain).toContain('https://example.com/api')
    expect(plain).toContain('POST')
    expect(plain).toContain('Web')
  })

  it('defaults to GET method', () => {
    const result = renderWebPermission('https://example.com')
    const plain = stripAnsi(result)
    expect(plain).toContain('GET')
  })
})

describe('renderInlinePermission', () => {
  it('produces vertical permission prompt with three labelled choices', () => {
    const result = renderInlinePermission('Bash', 'ls -la')
    const plain = stripAnsi(result)
    expect(plain).toContain('Bash')
    expect(plain).toContain('ls -la')
    expect(plain).toContain('[Y]')
    expect(plain).toContain('[N]')
    expect(plain).toContain('[A]')
  })

  it('works without detail', () => {
    const result = renderInlinePermission('Edit')
    const plain = stripAnsi(result)
    expect(plain).toContain('Edit')
    expect(plain).toContain('[Y]')
    expect(plain).toContain('[N]')
  })
})

describe('detectDestructiveCommand', () => {
  it('detects rm -rf with wildcard', () => {
    expect(detectDestructiveCommand('rm -rf /*')).toBeTruthy()
  })

  it('detects sudo rm', () => {
    expect(detectDestructiveCommand('sudo rm /important/file')).toBeTruthy()
  })

  it('returns null for safe commands', () => {
    expect(detectDestructiveCommand('ls -la')).toBeNull()
    expect(detectDestructiveCommand('cat file.txt')).toBeNull()
    expect(detectDestructiveCommand('echo hello')).toBeNull()
  })

  it('detects dd with of=/', () => {
    expect(detectDestructiveCommand('dd if=/dev/zero of=/dev/sda')).toBeTruthy()
  })

  it('shows warning in bash permission for dangerous commands', () => {
    const output = renderBashPermission('rm -rf /tmp/*', '/home/user')
    const plain = stripAnsi(output)
    expect(plain).toContain('⚠')
  })
})
