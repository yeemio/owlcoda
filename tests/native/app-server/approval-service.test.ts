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
    })
    const liveApproval = broker.listApprovals().approvals[0]

    expect(liveApproval).toMatchObject({
      kind: 'tool_approval',
      source: 'live',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'bash',
      input: { command: 'npm test' },
      status: 'pending',
    })

    const restoredBroker = createAppServerApprovalBroker({ storagePath })
    expect(restoredBroker.listInteractions().interactions).toEqual([
      expect.objectContaining({
        id: liveApproval.id,
        kind: 'tool_approval',
        source: 'restored',
        status: 'pending',
      }),
    ])

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
})

function temporaryStoragePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'owlcoda-app-server-approval-'))
  temporaryRoots.push(root)
  return join(root, 'approvals.json')
}
