import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { createConversation, addUserMessage } from '../../src/native/conversation.js'
import { approveTaskWriteScope, ensureTaskExecutionState, markTaskCompleted } from '../../src/native/task-state.js'
import { createRunWorkspace } from '../../src/native/run-workspace.js'
import type { EvidencePersistenceFailure, TaskExecutionState } from '../../src/native/protocol/types.js'
import { buildRuntimeEventContractDiagnostics, recordEvidencePersistenceFailureEvent } from '../../src/native/runtime-events.js'

describe('dispatch RunWorkspace evidence persistence', () => {
  let root = ''
  let previousAllowRoots: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'owlcoda-run002-evidence-'))
    previousAllowRoots = process.env['OWLCODA_ALLOW_FS_ROOTS']
    process.env['OWLCODA_ALLOW_FS_ROOTS'] = `${root}:${tmpdir()}`
  })

  afterEach(async () => {
    if (previousAllowRoots === undefined) delete process.env['OWLCODA_ALLOW_FS_ROOTS']
    else process.env['OWLCODA_ALLOW_FS_ROOTS'] = previousAllowRoots
    await rm(root, { recursive: true, force: true })
  })

  function taskStateFor(runWorkspace: NonNullable<TaskExecutionState['run']['runWorkspace']>): TaskExecutionState {
    const conversation = createConversation({ system: 'test', model: 'test-model' })
    addUserMessage(conversation, `Write the requested output to ${runWorkspace.outputRoot}/`)
    const taskState = ensureTaskExecutionState(conversation, root)
    taskState.run.runWorkspace = runWorkspace
    return taskState
  }

  it('makes a failed TodoWrite mirror visible without converting primary success to tool failure', async () => {
    const outputRoot = join(root, 'output')
    await mkdir(outputRoot)
    const runDir = '/dev/null'
    const taskState = taskStateFor({
      runId: 'run002-todo',
      outputRoot,
      runDir,
      manifestPath: join(runDir, 'manifest.json'),
      artifactsPath: join(runDir, 'artifacts.json'),
      eventsPath: join(runDir, 'events.jsonl'),
      createdAt: new Date().toISOString(),
    })
    const failures: EvidencePersistenceFailure[] = []
    const result = await new ToolDispatcher().executeTool(
      {
        type: 'tool_use',
        id: 'todo-failure',
        name: 'TodoWrite',
        input: {
          todos: [{ content: 'Record evidence', status: 'in_progress', activeForm: 'Recording evidence' }],
        },
      },
      { taskState, onEvidencePersistenceFailure: (failure) => failures.push(failure) },
    )

    expect(result.result.isError).toBe(false)
    expect(result.result.metadata).toMatchObject({
      evidencePersistenceFailure: {
        operation: 'todo_mirror',
        runId: 'run002-todo',
        runDir,
        outputRoot,
        toolUseId: 'todo-failure',
        toolName: 'TodoWrite',
        evidenceCompleteness: 'incomplete',
        acceptanceImpact: 'blocking',
      },
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ operation: 'todo_mirror', toolUseId: 'todo-failure' })
    expect(taskState.run.status).toBe('drifted')
  })

  it('makes a failed artifact record visible without converting primary write success to tool failure', async () => {
    const outputRootPath = join(root, 'output')
    await mkdir(outputRootPath)
    const outputRoot = await realpath(outputRootPath)
    const runDir = '/dev/null'
    const taskState = taskStateFor({
      runId: 'run002-artifact',
      outputRoot,
      runDir,
      manifestPath: join(runDir, 'manifest.json'),
      artifactsPath: join(runDir, 'artifacts.json'),
      eventsPath: join(runDir, 'events.jsonl'),
      createdAt: new Date().toISOString(),
    })
    const failures: EvidencePersistenceFailure[] = []
    const result = await new ToolDispatcher().executeTool(
      {
        type: 'tool_use',
        id: 'artifact-failure',
        name: 'write',
        input: { path: join(outputRoot, 'answer.txt'), content: 'current source' },
      },
      { taskState, onEvidencePersistenceFailure: (failure) => failures.push(failure) },
    )

    expect(result.result.isError).toBe(false)
    expect(result.result.metadata).toMatchObject({
      evidencePersistenceFailure: {
        operation: 'artifact_record',
        runId: 'run002-artifact',
        runDir,
        outputRoot,
        toolUseId: 'artifact-failure',
        toolName: 'write',
        evidenceCompleteness: 'incomplete',
        acceptanceImpact: 'blocking',
      },
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ operation: 'artifact_record', toolName: 'write' })
    expect(taskState.run.status).toBe('drifted')
  })

  it('keeps an artifact failure bound to its tool use across unrelated writes', async () => {
    const outputRootPath = join(root, 'output')
    await mkdir(outputRootPath)
    const outputRoot = await realpath(outputRootPath)
    const runDir = join(outputRoot, '.owlcoda-run')
    const taskState = taskStateFor({
      runId: 'run002-artifact-sequence',
      outputRoot,
      runDir,
      manifestPath: join(runDir, 'manifest.json'),
      artifactsPath: join(runDir, 'artifacts.json'),
      eventsPath: join(runDir, 'events.jsonl'),
      createdAt: new Date().toISOString(),
    })
    const failures: EvidencePersistenceFailure[] = []
    const dispatcher = new ToolDispatcher()

    // Inject a ledger-only failure while the primary write itself remains successful.
    const artifactA = await dispatcher.executeTool(
      {
        type: 'tool_use',
        id: 'artifact-a',
        name: 'write',
        input: { path: join(outputRoot, 'artifact-a.txt'), content: 'artifact A' },
      },
      { taskState, onEvidencePersistenceFailure: (failure) => failures.push(failure) },
    )

    expect(artifactA.result.isError).toBe(false)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ operation: 'artifact_record', toolUseId: 'artifact-a' })

    // Restore only the evidence ledger at the same run identity; this models
    // a retry after the persistence outage without changing tool-use scope.
    await createRunWorkspace({ outputRoot, runId: 'run002-artifact-sequence' })

    // A successful write outside outputRoot is not an artifact-record repair.
    const outsideOutputPath = join(root, 'outside-output.txt')
    expect(approveTaskWriteScope(taskState, outsideOutputPath)).toBe(true)
    const outsideOutput = await dispatcher.executeTool(
      {
        type: 'tool_use',
        id: 'outside-write',
        name: 'write',
        input: { path: outsideOutputPath, content: 'not an artifact' },
      },
      { taskState, onEvidencePersistenceFailure: (failure) => failures.push(failure) },
    )

    expect(outsideOutput.result.isError).toBe(false)
    expect(taskState.run.evidencePersistenceFailures).toHaveLength(1)
    expect(taskState.run.evidencePersistenceFailures?.[0]).toMatchObject({
      operation: 'artifact_record',
      toolUseId: 'artifact-a',
    })

    // A distinct successfully recorded artifact also must not repair artifact A.
    const artifactB = await dispatcher.executeTool(
      {
        type: 'tool_use',
        id: 'artifact-b',
        name: 'write',
        input: { path: join(outputRoot, 'artifact-b.txt'), content: 'artifact B' },
      },
      { taskState, onEvidencePersistenceFailure: (failure) => failures.push(failure) },
    )

    expect(artifactB.result.isError).toBe(false)
    expect(taskState.run.evidencePersistenceFailures).toHaveLength(1)
    expect(taskState.run.evidencePersistenceFailures?.[0]).toMatchObject({
      operation: 'artifact_record',
      toolUseId: 'artifact-a',
    })

    const repairedArtifactA = await dispatcher.executeTool(
      {
        type: 'tool_use',
        id: 'artifact-a',
        name: 'write',
        input: { path: join(outputRoot, 'artifact-a.txt'), content: 'artifact A repaired' },
      },
      { taskState, onEvidencePersistenceFailure: (failure) => failures.push(failure) },
    )

    expect(repairedArtifactA.result.isError).toBe(false)
    expect(taskState.run.evidencePersistenceFailures).toHaveLength(0)
    markTaskCompleted(taskState, 'artifact B recorded')
    expect(taskState.run.status).toBe('completed')
  })

  it('retains distinct artifact persistence failures instead of replacing them by operation', async () => {
    const outputRootPath = join(root, 'output')
    await mkdir(outputRootPath)
    const outputRoot = await realpath(outputRootPath)
    const runDir = join(outputRoot, '.owlcoda-run')
    const taskState = taskStateFor({
      runId: 'run002-artifact-multiple',
      outputRoot,
      runDir,
      manifestPath: join(runDir, 'manifest.json'),
      artifactsPath: join(runDir, 'artifacts.json'),
      eventsPath: join(runDir, 'events.jsonl'),
      createdAt: new Date().toISOString(),
    })
    const failures: EvidencePersistenceFailure[] = []
    const dispatcher = new ToolDispatcher()
    taskState.run.runWorkspace!.runDir = '/dev/null'

    for (const [toolUseId, fileName] of [['artifact-a-failure', 'artifact-a.txt'], ['artifact-b-failure', 'artifact-b.txt']]) {
      const result = await dispatcher.executeTool(
        {
          type: 'tool_use',
          id: toolUseId,
          name: 'write',
          input: { path: join(outputRoot, fileName), content: toolUseId },
        },
        { taskState, onEvidencePersistenceFailure: (failure) => failures.push(failure) },
      )
      expect(result.result.isError).toBe(false)
    }

    expect(failures).toHaveLength(2)
    expect(taskState.run.evidencePersistenceFailures?.map((failure) => failure.toolUseId)).toEqual([
      'artifact-a-failure',
      'artifact-b-failure',
    ])
  })

  it('does not allow completion to claim evidence-complete success after a blocking persistence failure', async () => {
    const outputRoot = join(root, 'output')
    await mkdir(outputRoot)
    const runDir = '/dev/null'
    const taskState = taskStateFor({
      runId: 'run002-completion',
      outputRoot,
      runDir,
      manifestPath: join(runDir, 'manifest.json'),
      artifactsPath: join(runDir, 'artifacts.json'),
      eventsPath: join(runDir, 'events.jsonl'),
      createdAt: new Date().toISOString(),
    })
    const result = await new ToolDispatcher().executeTool(
      {
        type: 'tool_use',
        id: 'todo-completion-failure',
        name: 'TodoWrite',
        input: {
          todos: [{ content: 'Complete only with evidence', status: 'completed', activeForm: 'Completing with evidence' }],
        },
      },
      { taskState },
    )
    expect(result.result.isError).toBe(false)

    markTaskCompleted(taskState, 'primary tool succeeded')

    expect(taskState.run.status).not.toBe('completed')
    expect(taskState.run.lastGuardReason).toContain('evidence_incomplete')
  })

  it('records evidence failure through the existing runtime intervention contract', () => {
    const conversation = createConversation({ system: 'test', model: 'test-model' })
    const failure: EvidencePersistenceFailure = {
      operation: 'artifact_record',
      runId: 'run002-event',
      runDir: '/tmp/run002-event/.owlcoda-run',
      outputRoot: '/tmp/run002-event',
      toolUseId: 'write-event',
      toolName: 'write',
      error: { name: 'Error', message: 'ledger unavailable' },
      evidenceCompleteness: 'incomplete',
      acceptanceImpact: 'blocking',
      at: '2026-08-01T00:00:00.000Z',
    }

    const event = recordEvidencePersistenceFailureEvent(conversation, failure)
    const diagnostics = buildRuntimeEventContractDiagnostics([event], { limit: null })

    expect(event.kind).toBe('runtime_intervention')
    expect(event.payload).toMatchObject({
      intervention_kind: 'evidence_persistence_failure',
      operation: 'artifact_record',
      evidence_completeness: 'incomplete',
      acceptance_impact: 'blocking',
    })
    expect(diagnostics.valid_event_count).toBe(1)
    expect(diagnostics.malformed_event_count).toBe(0)
  })
})
