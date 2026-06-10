import { describe, it, expect, beforeEach } from 'vitest'
import { createSendMessageTool, clearMessageQueues, getMessageQueue } from '../../../src/native/tools/send-message.js'

describe('SendMessage tool', () => {
  const tool = createSendMessageTool('leader')

  beforeEach(() => clearMessageQueues())

  it('has correct name', () => {
    expect(tool.name).toBe('SendMessage')
  })

  it('sends a message to a recipient', async () => {
    const r = await tool.execute({ to: 'worker', message: 'do the thing' })
    expect(r.isError).toBe(false)
    expect(r.output).toContain('worker')
    const q = getMessageQueue('worker')
    expect(q).toHaveLength(1)
    expect(q[0]!.from).toBe('leader')
    expect(q[0]!.message).toBe('do the thing')
  })

  it('returns error without recipient', async () => {
    const r = await tool.execute({ to: '', message: 'hello' })
    expect(r.isError).toBe(true)
  })

  it('returns error without message', async () => {
    const r = await tool.execute({ to: 'worker', message: '' })
    expect(r.isError).toBe(true)
  })

  it('handles object messages', async () => {
    const r = await tool.execute({ to: 'worker', message: { type: 'shutdown_request' } as any })
    expect(r.isError).toBe(false)
    const q = getMessageQueue('worker')
    expect(q[0]!.message).toEqual({ type: 'shutdown_request' })
  })

  it('uses summary in output when provided', async () => {
    const r = await tool.execute({ to: 'worker', message: 'long text...', summary: 'brief' })
    expect(r.output).toContain('brief')
  })
})
