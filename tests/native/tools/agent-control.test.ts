import { beforeEach, describe, expect, it } from 'vitest'

import { resetRunLifecycleForTesting } from '../../../src/native/run-lifecycle.js'
import { buildAgentControlSnapshot } from '../../../src/native/agent-control.js'
import { __resetAgentRunHistoryForTesting, restoreAgentRunHistory } from '../../../src/native/tools/agent.js'
import { createAgentControlGetTool, createAgentControlListTool } from '../../../src/native/tools/agent-control.js'

describe('AgentControl inspection tools', () => {
  beforeEach(() => {
    __resetAgentRunHistoryForTesting()
    resetRunLifecycleForTesting()
  })

  it('projects Agent run history into a parent/child control snapshot', async () => {
    restoreAgentRunHistory({
      schemaVersion: 1,
      records: [{
        agentId: 'agent-D1',
        description: 'Audit runtime truth',
        agentType: 'Explore',
        status: 'running',
        startedAt: '2026-06-22T00:00:00.000Z',
        updatedAt: '2026-06-22T00:00:02.000Z',
        conversationId: 'conv-agent-control',
        parentTaskId: 'task-9',
        parentStepId: 'step-2',
        touchedPaths: [],
      }],
    }, undefined, 'conv-agent-control')

    const snapshot = buildAgentControlSnapshot({ conversationId: 'conv-agent-control' })
    expect(snapshot).toMatchObject({
      schema_version: 1,
      agents: [
        expect.objectContaining({
          agent_id: 'agent-D1',
          run_id: 'agent:agent-D1',
          parent_run_id: 'task:task-9',
          status: 'incomplete',
          recovery: expect.objectContaining({
            strategy: 'inspect_before_retry',
            next_command: 'AgentRunGet agentId=agent-D1',
          }),
        }),
      ],
    })

    const list = await createAgentControlListTool().execute({}, { conversationId: 'conv-agent-control' })
    expect(list.isError).toBe(false)
    expect(list.output).toContain('agent-D1')
    expect(list.output).toContain('parent=task:task-9')
    expect(list.output).toContain('status=incomplete')

    const get = await createAgentControlGetTool().execute(
      { agentId: 'agent-D1' },
      { conversationId: 'conv-agent-control' },
    )
    expect(get.isError).toBe(false)
    expect(get.output).toContain('AgentControl agent-D1')
    expect(get.output).toContain('Inspect: AgentRunGet agentId=agent-D1')
    expect(get.metadata?.['agent']).toMatchObject({
      agent_id: 'agent-D1',
      parent_run_id: 'task:task-9',
    })
  })
})
