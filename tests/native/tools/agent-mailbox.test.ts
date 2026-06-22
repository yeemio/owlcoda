import { beforeEach, describe, expect, it } from 'vitest'

import { getRunLifecycleSnapshot, resetRunLifecycleForTesting } from '../../../src/native/run-lifecycle.js'
import { resetAgentMailboxForTesting } from '../../../src/native/agent-mailbox.js'
import {
  createAgentMailboxGetTool,
  createAgentMailboxListTool,
  createAgentMailboxResolveTool,
  createAgentMailboxSendTool,
} from '../../../src/native/tools/agent-mailbox.js'

describe('Agent mailbox tools', () => {
  beforeEach(() => {
    resetAgentMailboxForTesting()
    resetRunLifecycleForTesting()
  })

  it('stores parent/agent messages as lifecycle-backed mailbox records', async () => {
    const send = await createAgentMailboxSendTool().execute({
      author: 'root',
      recipient: 'agent:agent-D1',
      body: 'Inspect the saved watchdog timeout before retrying.',
      parentRunId: 'task:task-9',
      triggerTurn: true,
    })
    expect(send.isError).toBe(false)
    expect(send.output).toContain('AgentMailboxSend: queued mailbox-1')
    expect(send.metadata?.['message']).toMatchObject({
      messageId: 'mailbox-1',
      status: 'queued',
      author: 'root',
      recipient: 'agent:agent-D1',
      triggerTurn: true,
    })

    expect(getRunLifecycleSnapshot('mailbox:mailbox-1')).toMatchObject({
      kind: 'mailbox_message',
      status: 'waiting',
      parentRunId: 'task:task-9',
      owner: 'agent_mailbox',
      recoveryPolicy: expect.objectContaining({
        strategy: 'deliver_or_inspect',
      }),
    })

    const list = await createAgentMailboxListTool().execute({ recipient: 'agent:agent-D1' })
    expect(list.isError).toBe(false)
    expect(list.output).toContain('mailbox-1')
    expect(list.output).toContain('status=queued')
    expect(list.output).toContain('recipient=agent:agent-D1')

    const get = await createAgentMailboxGetTool().execute({ messageId: 'mailbox-1' })
    expect(get.isError).toBe(false)
    expect(get.output).toContain('Agent mailbox message mailbox-1')
    expect(get.output).toContain('Body: Inspect the saved watchdog timeout before retrying.')

    const resolve = await createAgentMailboxResolveTool().execute({
      messageId: 'mailbox-1',
      reason: 'Parent inspected the timeout and relaunched narrower work.',
    })
    expect(resolve.isError).toBe(false)
    expect(resolve.output).toContain('AgentMailboxResolve: resolved mailbox-1')
    expect(getRunLifecycleSnapshot('mailbox:mailbox-1')).toMatchObject({
      status: 'completed',
      evidence: expect.objectContaining({
        terminal_summary: 'Parent inspected the timeout and relaunched narrower work.',
      }),
    })
  })
})
