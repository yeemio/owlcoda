import { describe, expect, it } from 'vitest'
import {
  canWriteTaskOutput,
  createReplRuntimeState,
  decideInterruptAction,
  finishReplTask,
  getVisibleReplPhase,
  interruptReplTask,
  resetReplToIdle,
  setReplComposing,
  startReplTask,
} from '../../src/native/repl-state.js'

describe('Native REPL state runtime', () => {
  it('treats Ctrl+C as interrupt while a task is active', () => {
    const runtime = createReplRuntimeState()
    const task = startReplTask(runtime)

    expect(decideInterruptAction(runtime, false)).toBe('interrupt_task')
    expect(canWriteTaskOutput(runtime, task)).toBe(true)
    expect(getVisibleReplPhase(runtime)).toBe('model')

    interruptReplTask(runtime)

    expect(decideInterruptAction(runtime, false)).toBe('interrupt_task')
    expect(canWriteTaskOutput(runtime, task)).toBe(false)
    expect(getVisibleReplPhase(runtime)).toBe('interrupted')
  })

  it('returns to idle only after task cleanup completes', () => {
    const runtime = createReplRuntimeState()
    const task = startReplTask(runtime)

    interruptReplTask(runtime)
    finishReplTask(runtime, task, 'interrupted')
    expect(decideInterruptAction(runtime, false)).toBe('exit')

    resetReplToIdle(runtime)
    expect(getVisibleReplPhase(runtime)).toBeUndefined()
  })

  it('keeps compose state separate from exit semantics', () => {
    const runtime = createReplRuntimeState()
    setReplComposing(runtime, true)

    expect(getVisibleReplPhase(runtime)).toBe('compose')
    expect(decideInterruptAction(runtime, true)).toBe('cancel_multiline')
  })

  // ─── Stabilization: interrupt → idle → new task cycle ────────

  it('supports full interrupt → idle → new task cycle without stale state', () => {
    const runtime = createReplRuntimeState()

    // Start task 1
    const task1 = startReplTask(runtime)
    expect(runtime.phase).toBe('awaiting_model')
    expect(canWriteTaskOutput(runtime, task1)).toBe(true)

    // Interrupt task 1
    interruptReplTask(runtime)
    expect(canWriteTaskOutput(runtime, task1)).toBe(false)
    expect(runtime.phase).toBe('interrupted')

    // Finish task 1 cleanup
    finishReplTask(runtime, task1, 'interrupted')
    resetReplToIdle(runtime)
    expect(runtime.phase).toBe('idle')
    expect(runtime.activeTask).toBeNull()

    // Start task 2 — should be a clean slate
    const task2 = startReplTask(runtime)
    expect(runtime.phase).toBe('awaiting_model')
    expect(canWriteTaskOutput(runtime, task2)).toBe(true)
    expect(task2.taskId).toBeGreaterThan(task1.taskId)

    // Complete task 2 normally
    finishReplTask(runtime, task2, 'completed')
    resetReplToIdle(runtime)
    expect(runtime.phase).toBe('idle')
  })

  it('prevents stale task from writing after a newer task starts', () => {
    const runtime = createReplRuntimeState()

    const task1 = startReplTask(runtime)
    interruptReplTask(runtime)
    finishReplTask(runtime, task1, 'interrupted')
    resetReplToIdle(runtime)

    const task2 = startReplTask(runtime)

    // Task 1 should NOT be able to write output even though it has a reference
    expect(canWriteTaskOutput(runtime, task1)).toBe(false)
    // Task 2 should be able to write
    expect(canWriteTaskOutput(runtime, task2)).toBe(true)
  })

  it('output gate token prevents interrupted task callbacks from writing', () => {
    const runtime = createReplRuntimeState()

    const task = startReplTask(runtime)
    const originalGateToken = task.outputGateToken

    interruptReplTask(runtime)

    // After interrupt, the runtime's nextOutputGateToken has been incremented
    // so the task's gate token no longer matches
    expect(task.outputGateToken).toBe(originalGateToken)
    expect(canWriteTaskOutput(runtime, task)).toBe(false)
  })

  it('setReplComposing is ignored while a task is active', () => {
    const runtime = createReplRuntimeState()
    startReplTask(runtime)

    setReplComposing(runtime, true)
    // Should still be in task phase, not composing
    expect(runtime.phase).toBe('awaiting_model')
  })

  it('resetReplToIdle is ignored while a task is active', () => {
    const runtime = createReplRuntimeState()
    startReplTask(runtime)

    resetReplToIdle(runtime)
    // Should still be in task phase, not idle
    expect(runtime.phase).toBe('awaiting_model')
  })

  it('getVisibleReplPhase shows tool name during tool execution', () => {
    const runtime = createReplRuntimeState()
    const task = startReplTask(runtime)

    expect(getVisibleReplPhase(runtime)).toBe('model')

    // Simulate tool start
    task.phase = 'tool_execution'
    task.activeToolName = 'bash'
    runtime.phase = 'tool_execution'

    expect(getVisibleReplPhase(runtime)).toBe('tool:bash')
  })

  it('multiple rapid interrupts do not corrupt state', () => {
    const runtime = createReplRuntimeState()
    const task = startReplTask(runtime)

    // First interrupt
    const result1 = interruptReplTask(runtime)
    expect(result1).toBe(task)

    // Second interrupt attempt — task already interrupted
    const result2 = interruptReplTask(runtime)
    // Still returns the task because it's not completed yet
    expect(result2).toBe(task)

    // After finish, interrupt returns null
    finishReplTask(runtime, task, 'interrupted')
    const result3 = interruptReplTask(runtime)
    expect(result3).toBeNull()
  })
})
