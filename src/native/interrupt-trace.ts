import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

type TracePayload = Record<string, unknown>

function traceEnabled(): boolean {
  const value = process.env.OWLCODA_TRACE_INTERRUPT
  return value === '1' || value === 'true' || value === 'yes'
}

function tracePath(): string {
  const configured = process.env.OWLCODA_TRACE_INTERRUPT_PATH?.trim()
  return configured || join(tmpdir(), `owlcoda-trace-${process.pid}.log`)
}

export function interruptTraceStack(label: string): string | undefined {
  if (!traceEnabled()) return undefined
  return new Error(label).stack
}

export function traceInterruptEvent(event: string, payload: TracePayload = {}): void {
  if (!traceEnabled()) return
  try {
    appendFileSync(
      tracePath(),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...payload,
      })}\n`,
      'utf8',
    )
  } catch {
    // Trace must never perturb the REPL runtime.
  }
}

export function summarizeInterruptInput(input: string): TracePayload {
  return {
    inputJson: JSON.stringify(input),
    inputLength: input.length,
    inputUtf8Hex: Buffer.from(input, 'utf8').toString('hex'),
    inputCodeUnits: Array.from(input).map((ch) => ch.charCodeAt(0)),
    includesEtx: input.includes('\u0003'),
  }
}

export function summarizeKeyForInterruptTrace(key: {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  option?: boolean
  name?: string
  code?: string
  raw?: string
}): TracePayload {
  return {
    keyCtrl: Boolean(key.ctrl),
    keyMeta: Boolean(key.meta),
    keyShift: Boolean(key.shift),
    keyOption: Boolean(key.option),
    keyName: key.name,
    keyCode: key.code,
    keyRawJson: key.raw === undefined ? undefined : JSON.stringify(key.raw),
  }
}

export function summarizeTaskForInterruptTrace(task: {
  taskId?: number
  phase?: string
  aborted?: boolean
  completed?: boolean
  outputGateToken?: number
  startedAt?: number
  activeToolName?: string
} | null | undefined): TracePayload {
  if (!task) return { task: null }
  return {
    task: {
      taskId: task.taskId,
      phase: task.phase,
      aborted: task.aborted,
      completed: task.completed,
      outputGateToken: task.outputGateToken,
      startedAt: task.startedAt,
      activeToolName: task.activeToolName,
    },
  }
}

export function summarizeRuntimeForInterruptTrace(runtime: {
  phase?: string
  nextTaskId?: number
  nextOutputGateToken?: number
  activeTask?: unknown
}): TracePayload {
  return {
    runtimePhase: runtime.phase,
    nextTaskId: runtime.nextTaskId,
    nextOutputGateToken: runtime.nextOutputGateToken,
  }
}
