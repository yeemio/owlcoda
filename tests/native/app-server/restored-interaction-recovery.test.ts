import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversation } from '../../../src/native/conversation.js'
import { appendRuntimeEvent } from '../../../src/native/runtime-events.js'
import { deleteSession, saveSession } from '../../../src/native/session.js'
import { readTurnStatus } from '../../../src/native/app-server/turn-status-service.js'
import type { AppServerInteractionRequest } from '../../../src/native/app-server/approval-service.js'

const sessions: string[] = []
let projectRoot = ''
let owlcodaHome = ''
const originalOwlCodaHome = process.env['OWLCODA_HOME']

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'owlcoda-restored-interaction-project-'))
  owlcodaHome = mkdtempSync(join(tmpdir(), 'owlcoda-restored-interaction-home-'))
  process.env['OWLCODA_HOME'] = owlcodaHome
})

afterEach(() => {
  for (const sessionId of sessions.splice(0)) deleteSession(sessionId)
  rmSync(projectRoot, { recursive: true, force: true })
  rmSync(owlcodaHome, { recursive: true, force: true })
  if (originalOwlCodaHome === undefined) delete process.env['OWLCODA_HOME']
  else process.env['OWLCODA_HOME'] = originalOwlCodaHome
})

describe('restored interaction recovery truth', () => {
  it('reports a restored interaction without a continuation as stale and retryable', () => {
    mkdirSync(join(projectRoot, '.owlcoda'), { recursive: true })
    writeFileSync(join(projectRoot, '.owlcoda', '.keep'), '', 'utf8')
    const conversation = createConversation({ system: 'restored interaction system', model: 'cloud-model' })
    conversation.turns.push({
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: 'Run the saved task' }],
    })
    appendRuntimeEvent(conversation, {
      kind: 'turn_started',
      at: '2026-07-18T00:00:00.000Z',
      turnId: 'turn-restored-1',
    })
    saveSession(conversation, 'Restored interaction', { cwd: projectRoot })
    sessions.push(conversation.id)

    const interaction: AppServerInteractionRequest = {
      id: 'approval-restored-1',
      kind: 'tool_approval',
      source: 'restored',
      projectId: 'project-restored',
      threadId: conversation.id,
      toolName: 'bash',
      input: { command: 'npm test' },
      status: 'pending',
      createdAt: 1,
    }
    const status = readTurnStatus({
      projectRoot,
      projectId: interaction.projectId,
      threadId: conversation.id,
      interactions: [interaction],
    })

    expect(status).toMatchObject({
      status: 'stale',
      reason: 'restored_interaction_without_continuation',
      pendingInteractionCount: 1,
      lastInteraction: { id: interaction.id, source: 'restored' },
      failure: { kind: 'restored_interaction_without_continuation', retryable: true },
      resumeHint: { action: 'inspect_transcript_before_retry' },
    })
  })
})
