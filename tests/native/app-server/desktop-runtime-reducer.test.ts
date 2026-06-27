import { describe, expect, it } from 'vitest'
import {
  createDesktopRuntimeState,
  reduceDesktopRuntimeEvent,
} from '../../../src/native/app-server/desktop-runtime-reducer.js'

describe('desktop runtime reducer', () => {
  it('folds command and diff events into explicit live runtime items', () => {
    let state = createDesktopRuntimeState()

    state = reduceDesktopRuntimeEvent(state, {
      type: 'command.started',
      projectId: 'project-1',
      threadId: 'thread-1',
      commandId: 'cmd-1',
      commandRef: 'command:thread-1:cmd-1',
      statusRef: 'command-status:thread-1:cmd-1',
      outputRef: 'command-output:thread-1:cmd-1',
      sourceRefs: [{
        sourceRef: 'bash-source:thread-1:cmd-1:0',
        path: '/workspace/out.txt',
        kind: 'redirect_stdout',
        captureStatus: 'pending',
      }],
      command: 'npm test',
      cwd: '/workspace',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'command.outputDelta',
      projectId: 'project-1',
      threadId: 'thread-1',
      commandId: 'cmd-1',
      lines: ['first'],
      delta: 'first',
      totalLines: 1,
      totalBytes: 5,
      elapsedMs: 10,
      statusRef: 'command-status:thread-1:cmd-1',
      outputRef: 'command-output:thread-1:cmd-1',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'command.completed',
      projectId: 'project-1',
      threadId: 'thread-1',
      commandId: 'cmd-1',
      result: 'ok',
      isError: false,
      durationMs: 20,
      exitCode: 0,
      commandRef: 'command:thread-1:cmd-1',
      statusRef: 'command-status:thread-1:cmd-1',
      outputRef: 'command-output:thread-1:cmd-1',
      sourceRefs: [{
        sourceRef: 'bash-source:thread-1:cmd-1:0',
        path: '/workspace/out.txt',
        kind: 'redirect_stdout',
        captureStatus: 'captured',
      }],
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'diff.started',
      projectId: 'project-1',
      threadId: 'thread-1',
      diffId: 'diff-1',
      toolName: 'edit',
      input: { path: 'src/app.ts' },
      path: 'src/app.ts',
      operation: 'update',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'diff.completed',
      projectId: 'project-1',
      threadId: 'thread-1',
      diffId: 'diff-1',
      toolName: 'edit',
      path: 'src/app.ts',
      operation: 'update',
      result: 'Edited src/app.ts',
      isError: false,
      durationMs: 30,
      preview: {
        path: 'src/app.ts',
        additions: 1,
        deletions: 0,
        hunks: [],
        truncated: false,
      },
    }, { projectId: 'project-1', threadId: 'thread-1' })

    expect(state.items).toEqual([
      expect.objectContaining({
        id: 'live-command:cmd-1',
        kind: 'command',
        status: 'running',
        command: 'npm test',
        cwd: '/workspace',
        commandRef: 'command:thread-1:cmd-1',
        statusRef: 'command-status:thread-1:cmd-1',
        outputRef: 'command-output:thread-1:cmd-1',
        sourceRefs: [
          expect.objectContaining({
            sourceRef: 'bash-source:thread-1:cmd-1:0',
            captureStatus: 'pending',
          }),
        ],
      }),
      expect.objectContaining({
        id: 'live-command-output:cmd-1',
        kind: 'command_output',
        status: 'running',
        output: 'first',
        totalLines: 1,
        statusRef: 'command-status:thread-1:cmd-1',
        outputRef: 'command-output:thread-1:cmd-1',
      }),
      expect.objectContaining({
        id: 'live-command-result:cmd-1',
        kind: 'command_result',
        status: 'completed',
        result: 'ok',
        exitCode: 0,
        commandRef: 'command:thread-1:cmd-1',
        statusRef: 'command-status:thread-1:cmd-1',
        outputRef: 'command-output:thread-1:cmd-1',
        sourceRefs: [
          expect.objectContaining({
            sourceRef: 'bash-source:thread-1:cmd-1:0',
            captureStatus: 'captured',
          }),
        ],
      }),
      expect.objectContaining({
        id: 'live-diff:diff-1',
        kind: 'diff',
        status: 'running',
        toolName: 'edit',
        path: 'src/app.ts',
        operation: 'update',
      }),
      expect.objectContaining({
        id: 'live-diff-result:diff-1',
        kind: 'diff_result',
        status: 'completed',
        result: 'Edited src/app.ts',
        path: 'src/app.ts',
        operation: 'update',
      }),
    ])
  })

  it('folds assistant deltas and tool lifecycle events into live runtime items', () => {
    let state = createDesktopRuntimeState()

    state = reduceDesktopRuntimeEvent(state, {
      type: 'turn.started',
      projectId: 'project-1',
      threadId: 'thread-1',
      turnIndex: 7,
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'assistant.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      text: 'Hello',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'assistant.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      text: ' world',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'tool.started',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'edit',
      input: { path: 'src/app.ts' },
      toolUseId: 'tool-1',
      itemId: 'tool-1',
      runtimeTurnId: 'runtime-turn-1',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'tool.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'edit',
      lines: ['opening file'],
      delta: 'opening file',
      totalLines: 1,
      totalBytes: 12,
      elapsedMs: 10,
      toolUseId: 'tool-1',
      itemId: 'tool-1',
      runtimeTurnId: 'runtime-turn-1',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'tool.delta',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'edit',
      lines: ['opening file', 'writing file'],
      delta: 'writing file',
      totalLines: 2,
      totalBytes: 24,
      elapsedMs: 18,
      toolUseId: 'tool-1',
      itemId: 'tool-1',
      runtimeTurnId: 'runtime-turn-1',
    }, { projectId: 'project-1', threadId: 'thread-1' })
    state = reduceDesktopRuntimeEvent(state, {
      type: 'tool.completed',
      projectId: 'project-1',
      threadId: 'thread-1',
      toolName: 'edit',
      result: 'Edited src/app.ts',
      isError: false,
      durationMs: 123,
      toolUseId: 'tool-1',
      itemId: 'tool-1',
      runtimeTurnId: 'runtime-turn-1',
    }, { projectId: 'project-1', threadId: 'thread-1' })

    expect(state.items).toEqual([
      expect.objectContaining({
        id: 'live-assistant:thread-1:7',
        kind: 'assistant',
        status: 'streaming',
        text: 'Hello world',
        turnIndex: 7,
      }),
      expect.objectContaining({
        id: 'live-tool:tool-1',
        kind: 'tool',
        status: 'completed',
        toolName: 'edit',
        input: { path: 'src/app.ts' },
        output: 'opening file\nwriting file',
        totalLines: 2,
        totalBytes: 24,
        elapsedMs: 18,
        result: 'Edited src/app.ts',
        durationMs: 123,
        runtimeTurnId: 'runtime-turn-1',
      }),
    ])
  })

  it('ignores events outside the selected project or thread', () => {
    const state = reduceDesktopRuntimeEvent(createDesktopRuntimeState(), {
      type: 'assistant.delta',
      projectId: 'other-project',
      threadId: 'thread-1',
      text: 'ignore me',
    }, { projectId: 'project-1', threadId: 'thread-1' })

    expect(state.items).toEqual([])
  })
})
