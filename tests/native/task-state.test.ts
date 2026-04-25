import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, realpath, symlink, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import {
  approveTaskWriteScope,
  buildTaskRealignPrompt,
  ensureTaskExecutionState,
  markTaskBlocked,
  markTaskWriteScopeBlocked,
  shouldTreatTaskRunStatusAsFailure,
} from '../../src/native/task-state.js'

describe('native task state', () => {
  it('derives explicit write scope from user-mentioned paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-explicit-'))
    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(
        conversation,
        'Update `src/native/conversation.ts` and keep `tests/native/conversation.test.ts` aligned.',
      )

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'tests', 'native'),
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps the previous objective across pure continuation turns', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-continue')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Refactor `src/native/dispatch.ts` and adjust tests.')
    const initial = ensureTaskExecutionState(conversation, cwd)

    addUserMessage(conversation, '继续')
    const continued = ensureTaskExecutionState(conversation, cwd)

    expect(continued.contract.objective).toBe(initial.contract.objective)
    expect(continued.contract.sourceTurnHash).toBe(initial.contract.sourceTurnHash)
    expect(continued.contract.allowedWritePaths).toEqual(initial.contract.allowedWritePaths)
  })

  it('tailors the realign prompt when user approval is required', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-wait')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Only edit `src/native/dispatch.ts`.')
    const taskState = ensureTaskExecutionState(conversation, cwd)
    taskState.run.status = 'waiting_user'
    taskState.run.lastGuardReason = 'User denied write; waiting for approval.'

    const prompt = buildTaskRealignPrompt(taskState)

    expect(prompt).toContain('[Runtime task contract]')
    expect(prompt).toContain('User denied write; waiting for approval.')
    expect(prompt).toContain('Ask the user one concise question')
  })

  it('marks runtime auto-retry exhaustion as blocked without pretending the task is still open', () => {
    const cwd = join(tmpdir(), 'owlcoda-task-state-blocked')
    const conversation = createConversation({ system: 'test', model: 'm' })
    addUserMessage(conversation, 'Finish the delivery packet and write the docs.')
    const taskState = ensureTaskExecutionState(conversation, cwd)

    markTaskBlocked(taskState, 'Runtime auto-continue stopped after 8 attempts.', 'Waiting for explicit retry')

    expect(taskState.run.status).toBe('blocked')
    expect(taskState.run.lastGuardReason).toBe('Runtime auto-continue stopped after 8 attempts.')
    expect(taskState.run.currentFocus).toBe('Waiting for explicit retry')
  })

  it('treats blocked and waiting-user task states as non-completed terminal outcomes', () => {
    expect(shouldTreatTaskRunStatusAsFailure('open')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('blocked')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('waiting_user')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('drifted')).toBe(true)
    expect(shouldTreatTaskRunStatusAsFailure('completed')).toBe(false)
    expect(shouldTreatTaskRunStatusAsFailure(undefined)).toBe(false)
  })

  it('expands a blocked write scope after explicit user approval without replacing the objective', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-approval-'))
    try {
      const allowedPath = join(cwd, 'prompt.md')
      const blockedPath = join(cwd, 'docs', 'result.md')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `按 \`${allowedPath}\` 执行。`)
      const taskState = ensureTaskExecutionState(conversation, cwd)

      markTaskWriteScopeBlocked(
        taskState,
        `Task contract blocked write to ${blockedPath}.`,
        blockedPath,
      )
      addUserMessage(conversation, '确认可以，继续写入这个结果文件。')
      const approved = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(approved.run.status).toBe('open')
      expect(approved.run.lastGuardReason).toBeNull()
      expect(approved.run.pendingWriteApproval).toBeNull()
      expect(approved.contract.objective).toContain(allowedPath)
      expect(approved.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'docs', 'result.md'),
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('can approve a pending write scope directly from the runtime approval UI', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-runtime-approval-'))
    try {
      const allowedPath = join(cwd, 'prompt.md')
      const blockedPath = join(cwd, 'scripts', 'gate.sh')
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `按 \`${allowedPath}\` 执行。`)
      const taskState = ensureTaskExecutionState(conversation, cwd)

      markTaskWriteScopeBlocked(
        taskState,
        `Task contract blocked write to ${blockedPath}.`,
        blockedPath,
      )

      expect(approveTaskWriteScope(taskState, blockedPath)).toBe(true)
      const canonicalCwd = await realpath(cwd)
      expect(taskState.run.status).toBe('open')
      expect(taskState.run.lastGuardReason).toBeNull()
      expect(taskState.run.pendingWriteApproval).toBeNull()
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'scripts', 'gate.sh') && scope.origin === 'user_approved',
      )).toBe(true)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('expands write scope from bootstrap packet allowlists without importing forbidden paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-packet-'))
    const packetPath = join(cwd, 'docs', 'executor-packet.md')
    const allowedCodePath = join(cwd, 'src', 'native', 'dispatch.ts')
    const allowedTestPath = join(cwd, 'tests', 'native', 'dispatch.test.ts')
    const forbiddenPath = join(cwd, 'README.md')

    await mkdir(join(cwd, 'docs'), { recursive: true })
    await writeFile(packetPath, [
      '# Round Packet',
      '',
      '- `允许写入的文件或目录`',
      `  - \`${allowedCodePath}\``,
      `  - \`${allowedTestPath}\``,
      '- `禁止改动的文件或目录`',
      `  - \`${forbiddenPath}\``,
      '',
      '- `最终输出格式`',
      '  - `本轮目标`',
    ].join('\n'))

    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `请按这个执行包继续：\`${packetPath}\``)

      const taskState = ensureTaskExecutionState(conversation, cwd)
      const canonicalCwd = await realpath(cwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native', 'dispatch.ts'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'src', 'native'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'tests', 'native', 'dispatch.test.ts'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path === join(canonicalCwd, 'README.md'),
      )).toBe(false)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps packet bootstrap inside scope when the user path goes through a symlink', async () => {
    const realCwd = await mkdtemp(join(tmpdir(), 'owlcoda-task-state-real-'))
    const linkedCwd = `${realCwd}-link`
    const packetPath = join(linkedCwd, 'docs', 'executor-packet.md')
    const allowedPath = join(linkedCwd, 'src', 'native', 'dispatch.ts')

    await mkdir(join(realCwd, 'docs'), { recursive: true })
    await mkdir(join(realCwd, 'src', 'native'), { recursive: true })
    await symlink(realCwd, linkedCwd)
    await writeFile(join(realCwd, 'docs', 'executor-packet.md'), [
      '# Round Packet',
      '',
      '- `允许写入的文件或目录`',
      `  - \`${allowedPath}\``,
    ].join('\n'))

    try {
      const conversation = createConversation({ system: 'test', model: 'm' })
      addUserMessage(conversation, `请按这个执行包继续：\`${packetPath}\``)

      const taskState = ensureTaskExecutionState(conversation, realCwd)

      expect(taskState.contract.scopeMode).toBe('explicit_paths')
      expect(taskState.contract.explicitWriteTargets.some(
        (target) => target.endsWith('/docs/executor-packet.md'),
      )).toBe(true)
      expect(taskState.contract.allowedWritePaths.some(
        (scope) => scope.path.endsWith('/src/native/dispatch.ts'),
      )).toBe(true)
    } finally {
      await rm(linkedCwd, { recursive: true, force: true })
      await rm(realCwd, { recursive: true, force: true })
    }
  })
})
