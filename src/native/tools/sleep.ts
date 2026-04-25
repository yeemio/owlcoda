/**
 * OwlCoda Native Sleep Tool
 *
 * Simple delay/sleep tool. Preferred over `bash(sleep N)` because
 * it doesn't hold a shell process.
 */

import type { NativeToolDef, ToolResult } from './types.js'

export interface SleepInput {
  /** Duration in seconds to sleep */
  durationSeconds: number
}

const MAX_SLEEP_SECONDS = 300

export function createSleepTool(): NativeToolDef<SleepInput> {
  return {
    name: 'Sleep',
    description:
      'Wait for a specified duration in seconds. Preferred over bash sleep as it does not hold a shell process.',

    async execute(input: SleepInput): Promise<ToolResult> {
      const { durationSeconds } = input

      if (typeof durationSeconds !== 'number' || durationSeconds <= 0) {
        return { output: 'Error: durationSeconds must be a positive number', isError: true }
      }

      if (durationSeconds > MAX_SLEEP_SECONDS) {
        return { output: `Error: maximum sleep duration is ${MAX_SLEEP_SECONDS}s`, isError: true }
      }

      const start = Date.now()
      await new Promise<void>(resolve => setTimeout(resolve, durationSeconds * 1000))
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)

      return {
        output: `Slept for ${elapsed}s`,
        isError: false,
        metadata: { requestedSeconds: durationSeconds, actualSeconds: parseFloat(elapsed) },
      }
    },
  }
}
