/**
 * Structured per-request tracing with timing waterfall.
 * Zero allocation when not used — phases are only tracked when mark() is called.
 */

export interface TracePhase {
  name: string
  timestampMs: number
  durationMs: number // time since previous mark
}

export interface TraceResult {
  requestId: string
  phases: TracePhase[]
  totalMs: number
}

export interface RequestTrace {
  mark(phase: string): void
  end(): TraceResult
}

const BUFFER_SIZE = 50
const recentTraces: TraceResult[] = []

export function createTrace(requestId: string): RequestTrace {
  const marks: Array<{ name: string; time: number }> = []
  const startTime = Date.now()

  return {
    mark(phase: string) {
      marks.push({ name: phase, time: Date.now() })
    },

    end(): TraceResult {
      const endTime = Date.now()
      const phases: TracePhase[] = []

      for (let i = 0; i < marks.length; i++) {
        const prevTime = i === 0 ? startTime : marks[i - 1].time
        phases.push({
          name: marks[i].name,
          timestampMs: marks[i].time,
          durationMs: marks[i].time - prevTime,
        })
      }

      const result: TraceResult = {
        requestId,
        phases,
        totalMs: endTime - startTime,
      }

      // Store in circular buffer
      recentTraces.push(result)
      if (recentTraces.length > BUFFER_SIZE) {
        recentTraces.shift()
      }

      return result
    },
  }
}

export function getRecentTraces(count: number = 10): TraceResult[] {
  return recentTraces.slice(-count)
}

export function resetTraces(): void {
  recentTraces.length = 0
}
