import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAppServerApprovalBroker } from '../../../src/native/app-server/approval-service.js'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('app-server interaction broker persistence', () => {
  it('persists pending approvals so a restarted broker can list the interaction', async () => {
    const storagePath = temporaryStoragePath()
    const broker = createAppServerApprovalBroker({ storagePath })

    const pending = broker.requestApproval({
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'bash',
      toolInput: { command: 'npm test' },
      riskClass: 'mutating',
      riskReason: 'npm test requires explicit approval',
    })
    const liveApproval = broker.listApprovals().approvals[0]

    expect(liveApproval).toMatchObject({
      kind: 'tool_approval',
      source: 'live',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'bash',
      input: { command: 'npm test' },
      riskClass: 'mutating',
      riskReason: 'npm test requires explicit approval',
      status: 'pending',
    })

    const restoredBroker = createAppServerApprovalBroker({ storagePath })
    expect(restoredBroker.listInteractions().interactions).toEqual([
      expect.objectContaining({
        id: liveApproval.id,
        kind: 'tool_approval',
        source: 'restored',
        riskClass: 'mutating',
        riskReason: 'npm test requires explicit approval',
        status: 'pending',
      }),
    ])
    expect(restoredBroker.resolveApproval({ approvalId: liveApproval.id, decision: 'approve' })).toBeNull()
    expect(restoredBroker.respondInteraction({ interactionId: liveApproval.id, decision: 'approve' })).toBeNull()
    expect(restoredBroker.listInteractions().interactions).toHaveLength(1)

    const resolved = broker.resolveApproval({ approvalId: liveApproval.id, decision: 'approve' })
    await expect(pending).resolves.toBe(true)
    expect(resolved).toMatchObject({
      interactionId: liveApproval.id,
      approvalId: liveApproval.id,
      status: 'approved',
      source: 'live',
    })
    expect(JSON.parse(readFileSync(storagePath, 'utf8'))).toMatchObject({ interactions: [] })
  })

  it('records a denied user question as denied while cancelling the waiting tool', async () => {
    const resolved: unknown[] = []
    const broker = createAppServerApprovalBroker({
      onResolved: result => resolved.push(result),
    })

    const pending = broker.requestUserQuestion({
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'AskUserQuestion',
      question: 'Continue?',
    })
    const interaction = broker.listInteractions().interactions[0]!

    expect(broker.respondInteraction({
      interactionId: interaction.id,
      decision: 'deny',
    })).toMatchObject({
      interactionId: interaction.id,
      kind: 'user_question',
      status: 'denied',
    })
    await expect(pending).resolves.toBe('')
    expect(resolved).toEqual([
      expect.objectContaining({
        interactionId: interaction.id,
        status: 'denied',
      }),
    ])
  })
})

function temporaryStoragePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-app-server-approval-'))
  temporaryRoots.push(root)
  return join(root, 'approvals.json')
}
