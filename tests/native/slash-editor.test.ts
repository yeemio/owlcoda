import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation } from '../../src/native/conversation.js'
import { handleSlashCommand } from '../../src/native/repl.js'
import { UsageTracker } from '../../src/native/usage.js'

describe('/editor dispatch', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let usage: UsageTracker
  beforeEach(() => { logSpy = vi.spyOn(console, 'log').mockImplementation(() => {}); usage = new UsageTracker() })
  afterEach(() => { logSpy.mockRestore() })

  it('emits an open_editor side-effect carrying the initial content', async () => {
    const effects: unknown[] = []
    const convo = createConversation({ system: 'test', model: 'minimax-m27' })
    await handleSlashCommand(
      '/editor hello world', convo, usage,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { onSideEffect: (e) => effects.push(e) },
    )
    expect(effects).toEqual([{ kind: 'open_editor', initialContent: 'hello world' }])
  })

  it('without a side-effect channel, returns true and does not throw', async () => {
    const convo = createConversation({ system: 'test', model: 'minimax-m27' })
    const res = await handleSlashCommand('/editor', convo, usage)
    expect(res).toBe(true)
  })
})
