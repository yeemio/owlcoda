import { EventEmitter as NodeEventEmitter } from 'events'
import { Event } from './event.js'
import { isInputLatencyTraceEnabled, traceInputLatencyCheckpoint } from '../input-latency-trace.js'

// Similar to node's builtin EventEmitter, but is also aware of our `Event`
// class, and so `emit` respects `stopImmediatePropagation()`.
export class EventEmitter extends NodeEventEmitter {
  constructor() {
    super()
    // Disable the default maxListeners warning. In React, many components
    // can legitimately listen to the same event (e.g., useInput hooks).
    // The default limit of 10 causes spurious warnings.
    this.setMaxListeners(0)
  }

  override emit(type: string | symbol, ...args: unknown[]): boolean {
    // Delegate to node for `error`, since it's not treated like a normal event
    if (type === 'error') {
      return super.emit(type, ...args)
    }

    const listeners = this.rawListeners(type)

    if (listeners.length === 0) {
      return false
    }

    const ccEvent = args[0] instanceof Event ? args[0] : null

    const traceInput = type === 'input' && isInputLatencyTraceEnabled()
    if (traceInput) {
      traceInputLatencyCheckpoint('input-emit-start', {
        listenerCount: listeners.length,
      })
    }

    let index = 0
    for (const listener of listeners) {
      const t0 = traceInput ? performance.now() : 0
      listener.apply(this, args)
      if (traceInput && t0 > 0) {
        const durationMs = performance.now() - t0
        if (durationMs >= 0.5) {
          traceInputLatencyCheckpoint('input-listener', {
            index,
            durationMs: Number(durationMs.toFixed(3)),
            name: listener.name || '(anonymous)',
          })
        }
      }

      if (ccEvent?.didStopImmediatePropagation()) {
        break
      }
      index += 1
    }

    if (traceInput) {
      traceInputLatencyCheckpoint('input-emit-end', {
        listenerCount: listeners.length,
      })
    }

    return true
  }
}
