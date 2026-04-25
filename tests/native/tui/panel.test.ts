import { describe, it, expect } from 'vitest'
import {
  renderMcpPanel,
  renderSessionInfoPanel,
  renderSessionsPanel,
  renderSettingsPanel,
} from '../../../src/native/tui/panel.js'
import { stripAnsi, visibleWidth } from '../../../src/native/tui/colors.js'

const session = {
  id: 'conv-1234567890',
  title: 'Terminal redesign',
  turns: [{}, {}],
  createdAt: '2026-04-24T00:00:00.000Z',
  updatedAt: '2026-04-24T01:00:00.000Z',
  model: 'minimax-m27',
}

describe('fullscreen panel renderers', () => {
  it('renders sessions as a compact scannable panel', () => {
    const result = renderSessionsPanel([{ ...session, title: 'Terminal\nredesign' }], { columns: 80 })
    const plain = stripAnsi(result)
    expect(plain).toContain('OC /sessions')
    expect(plain).toContain('Terminal redesign')
    expect(plain).not.toContain('Terminal\nredesign')
    expect(plain).toContain('/resume')
    expect(plain).not.toContain('╭')
  })

  it('renders session info without overflowing 80 columns', () => {
    const result = renderSessionInfoPanel(session, 80)
    expect(stripAnsi(result)).toContain('minimax-m27')
    for (const line of result.split('\n')) {
      expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(80)
    }
  })

  it('renders mcp empty state and connected server state', () => {
    expect(stripAnsi(renderMcpPanel([], 80))).toContain('No MCP servers configured')
    const result = renderMcpPanel([
      {
        name: 'repo-tools',
        status: 'connected',
        serverInfo: { name: 'repo-tools', version: '1.0.0' },
        tools: [{ name: 'search' }, { name: 'read' }],
        resources: [{}],
      },
    ], 80)
    const plain = stripAnsi(result)
    expect(plain).toContain('repo-tools')
    expect(plain).toContain('tools 2')
    expect(plain).toContain('/mcp reconnect')
  })

  it('renders settings panel with commands and approval mode', () => {
    const result = renderSettingsPanel({
      version: '0.12.30',
      model: 'minimax-m27',
      maxTokens: 4096,
      mode: 'native',
      trace: false,
      owlcodaHome: '~/.owlcoda',
      apiBaseUrl: 'http://127.0.0.1:9999',
      approveMode: 'ask-before-execute',
      theme: 'dark',
      alwaysApprovedTools: ['read'],
      columns: 80,
    })
    const plain = stripAnsi(result)
    expect(plain).toContain('OC /settings')
    expect(plain).toContain('ask-before-execute')
    expect(plain).toContain('/theme')
    expect(plain).toContain('read')
  })
})
