import {
  interruptTraceStack,
  summarizeRuntimeForInterruptTrace,
  summarizeTaskForInterruptTrace,
  traceInterruptEvent,
} from './interrupt-trace.js'

export type ReplPhase =
  | 'idle'
  | 'composing'
  | 'awaiting_model'
  | 'tool_execution'
  | 'interrupted'
  | 'failed'
  | 'completed'

export interface ReplTaskState {
  taskId: number
  phase: Exclude<ReplPhase, 'idle' | 'composing'>
  aborted: boolean
  completed: boolean
  outputGateToken: number
  startedAt: number
  activeToolName?: string
}

export interface ReplRuntimeState {
  phase: ReplPhase
  nextTaskId: number
  nextOutputGateToken: number
  activeTask: ReplTaskState | null
}

export type ReplInterruptAction = 'interrupt_task' | 'cancel_multiline' | 'exit'

export function createReplRuntimeState(): ReplRuntimeState {
  return {
    phase: 'idle',
    nextTaskId: 1,
    nextOutputGateToken: 1,
    activeTask: null,
  }
}

export function startReplTask(runtime: ReplRuntimeState): ReplTaskState {
  const task: ReplTaskState = {
    taskId: runtime.nextTaskId++,
    phase: 'awaiting_model',
    aborted: false,
    completed: false,
    outputGateToken: runtime.nextOutputGateToken++,
    startedAt: Date.now(),
  }
  runtime.activeTask = task
  runtime.phase = task.phase
  return task
}

export function setReplTaskPhase(
  runtime: ReplRuntimeState,
  task: ReplTaskState,
  phase: ReplTaskState['phase'],
  activeToolName?: string,
): void {
  if (runtime.activeTask?.taskId !== task.taskId) return
  task.phase = phase
  task.activeToolName = activeToolName
  runtime.phase = phase
}

export function interruptReplTask(runtime: ReplRuntimeState): ReplTaskState | null {
  const task = runtime.activeTask
  if (!task || task.completed) {
    traceInterruptEvent('repl-state.interrupt.no-active-task', {
      ...summarizeRuntimeForInterruptTrace(runtime),
      ...summarizeTaskForInterruptTrace(task),
      stack: interruptTraceStack('interruptReplTask.no-active-task'),
    })
    return null
  }
  traceInterruptEvent('repl-state.interrupt.before', {
    ...summarizeRuntimeForInterruptTrace(runtime),
    ...summarizeTaskForInterruptTrace(task),
    stack: interruptTraceStack('interruptReplTask.before'),
  })
  task.aborted = true
  task.phase = 'interrupted'
  task.activeToolName = undefined
  runtime.phase = 'interrupted'
  runtime.nextOutputGateToken++
  traceInterruptEvent('repl-state.interrupt.after', {
    ...summarizeRuntimeForInterruptTrace(runtime),
    ...summarizeTaskForInterruptTrace(task),
  })
  return task
}

export function finishReplTask(
  runtime: ReplRuntimeState,
  task: ReplTaskState,
  phase: 'interrupted' | 'failed' | 'completed',
): void {
  traceInterruptEvent('repl-state.finish.before', {
    requestedPhase: phase,
    ...summarizeRuntimeForInterruptTrace(runtime),
    ...summarizeTaskForInterruptTrace(task),
  })
  task.completed = true
  task.phase = phase
  task.activeToolName = undefined
  if (runtime.activeTask?.taskId === task.taskId) {
    runtime.activeTask = null
    runtime.phase = phase
  }
  traceInterruptEvent('repl-state.finish.after', {
    requestedPhase: phase,
    ...summarizeRuntimeForInterruptTrace(runtime),
    ...summarizeTaskForInterruptTrace(task),
  })
}

export function setReplComposing(runtime: ReplRuntimeState, composing: boolean): void {
  if (runtime.activeTask) return
  runtime.phase = composing ? 'composing' : 'idle'
}

export function resetReplToIdle(runtime: ReplRuntimeState): void {
  traceInterruptEvent('repl-state.reset-idle.before', {
    ...summarizeRuntimeForInterruptTrace(runtime),
    ...summarizeTaskForInterruptTrace(runtime.activeTask),
  })
  if (runtime.activeTask) return
  runtime.phase = 'idle'
  traceInterruptEvent('repl-state.reset-idle.after', {
    ...summarizeRuntimeForInterruptTrace(runtime),
  })
}

export function canWriteTaskOutput(runtime: ReplRuntimeState, task: ReplTaskState): boolean {
  return runtime.activeTask?.taskId === task.taskId
    && runtime.activeTask.outputGateToken === task.outputGateToken
    && !task.aborted
    && !task.completed
}

export function getVisibleReplPhase(runtime: ReplRuntimeState): string | undefined {
  const task = runtime.activeTask
  if (task?.phase === 'tool_execution') {
    return task.activeToolName ? `tool:${task.activeToolName}` : 'tool'
  }

  switch (runtime.phase) {
    case 'composing':
      return 'compose'
    case 'awaiting_model':
      return 'model'
    case 'interrupted':
      return 'interrupted'
    case 'failed':
      return 'failed'
    case 'completed':
      return 'completed'
    default:
      return undefined
  }
}

export function decideInterruptAction(
  runtime: ReplRuntimeState,
  inMultiline: boolean,
): ReplInterruptAction {
  if (runtime.activeTask && !runtime.activeTask.completed) return 'interrupt_task'
  if (inMultiline) return 'cancel_multiline'
  return 'exit'
}
