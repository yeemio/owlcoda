import { openSync, writeSync } from 'fs'
import type { FrameEvent } from '../ink/frame.js'

const configuredPath = process.env.OWLCODA_TRACE_RENDER?.trim()
const tracePath = configuredPath && configuredPath !== '0' && configuredPath.toLowerCase() !== 'false'
  ? configuredPath === '1'
    ? `/tmp/owlcoda-render-trace-${process.pid}.jsonl`
    : configuredPath
  : ''

let fd: number | null = null

function getTraceFd(): number | null {
  if (!tracePath) return null
  if (fd !== null) return fd
  try {
    fd = openSync(tracePath, 'a')
    writeSync(fd, `${JSON.stringify({
      type: 'render-trace-open',
      pid: process.pid,
      ts: new Date().toISOString(),
    })}\n`)
    return fd
  } catch {
    fd = null
    return null
  }
}

export function traceRenderEvent(type: string, data: Record<string, unknown> = {}): void {
  const out = getTraceFd()
  if (out === null) return
  try {
    writeSync(out, `${JSON.stringify({
      type,
      ts: Date.now(),
      ...data,
    })}\n`)
  } catch {
    // Render tracing is diagnostic-only and must never affect REPL input.
  }
}

export function traceRenderFrame(event: FrameEvent): void {
  traceRenderEvent('frame', {
    durationMs: Number(event.durationMs.toFixed(3)),
    phases: event.phases
      ? {
          renderer: Number(event.phases.renderer.toFixed(3)),
          diff: Number(event.phases.diff.toFixed(3)),
          optimize: Number(event.phases.optimize.toFixed(3)),
          write: Number(event.phases.write.toFixed(3)),
          patches: event.phases.patches,
          yoga: Number(event.phases.yoga.toFixed(3)),
          commit: Number(event.phases.commit.toFixed(3)),
          yogaVisited: event.phases.yogaVisited,
          yogaMeasured: event.phases.yogaMeasured,
          yogaCacheHits: event.phases.yogaCacheHits,
          yogaLive: event.phases.yogaLive,
        }
      : undefined,
  })
}
