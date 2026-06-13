import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation } from '../../src/native/conversation.js'
import { handleSlashCommand } from '../../src/native/repl.js'
import { UsageTracker } from '../../src/native/usage.js'
import { stripAnsi } from '../../src/native/tui/colors.js'

vi.mock('../../src/plugins/index.js', async (orig) => ({
  ...(await orig<typeof import('../../src/plugins/index.js')>()),
  getLoadedPlugins: vi.fn(() => []),
}))
vi.mock('../../src/native/tools/agent.js', async (orig) => ({
  ...(await orig<typeof import('../../src/native/tools/agent.js')>()),
  getRunningAgents: vi.fn(() => new Map()),
}))
vi.mock('../../src/native/tools/task-store.js', async (orig) => ({
  ...(await orig<typeof import('../../src/native/tools/task-store.js')>()),
  listTasks: vi.fn(() => []),
}))

import { getLoadedPlugins } from '../../src/plugins/index.js'
import { getRunningAgents } from '../../src/native/tools/agent.js'
import { listTasks } from '../../src/native/tools/task-store.js'

let logSpy: ReturnType<typeof vi.spyOn>
let usage: UsageTracker
beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  usage = new UsageTracker()
  vi.mocked(getLoadedPlugins).mockReturnValue([])
  vi.mocked(getRunningAgents).mockReturnValue(new Map())
  vi.mocked(listTasks).mockReturnValue([])
})
afterEach(() => { logSpy.mockRestore() })
function output(): string { return stripAnsi(logSpy.mock.calls.flat().join('\n')) }
const convo = () => createConversation({ system: 'test', model: 'minimax-m27' })

describe('/hooks', () => {
  it('shows an empty state and no stub when no plugins are loaded', async () => {
    await handleSlashCommand('/hooks', convo(), usage)
    expect(output()).toContain('No plugins loaded')
    expect(output()).not.toContain('not yet available')
  })

  it('groups runtime and lifecycle hooks with implementing plugins', async () => {
    vi.mocked(getLoadedPlugins).mockReturnValue([
      { plugin: { metadata: { name: 'demo', version: '1.0.0', description: '' }, onRequest() {}, onLoad() {} }, path: '/p', hookCount: 1 },
    ] as any)
    await handleSlashCommand('/hooks', convo(), usage)
    const out = output()
    expect(out).toContain('Runtime hooks')
    expect(out).toContain('onRequest')
    expect(out).toContain('demo')
    expect(out).toContain('Lifecycle hooks')
    expect(out).toContain('onLoad')
    expect(out).not.toContain('not yet available')
  })
})

describe('/tasks', () => {
  it('shows an empty state and no stub when nothing is active', async () => {
    await handleSlashCommand('/tasks', convo(), usage)
    expect(output()).toContain('No active tasks or running agents')
    expect(output()).not.toContain('not yet available')
  })

  it('lists running agents and tasks', async () => {
    vi.mocked(getRunningAgents).mockReturnValue(
      new Map([['a1', { description: 'indexing repo', startTime: Date.now() - 5000 }]]),
    )
    vi.mocked(listTasks).mockReturnValue([
      { id: 't1', subject: 'Build feature', description: '', status: 'in_progress', blocks: [], blockedBy: [], createdAt: '', updatedAt: '' },
    ] as any)
    await handleSlashCommand('/tasks', convo(), usage)
    const out = output()
    expect(out).toContain('indexing repo')
    expect(out).toContain('Build feature')
    expect(out).not.toContain('not yet available')
  })
})
