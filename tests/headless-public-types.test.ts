import { describe, expect, it } from 'vitest'
import * as headless from '../src/headless.js'
import type { TaskRunStatus, OperatingMode, HeadlessResult } from '../src/headless.js'

// The public barrel must expose the types that HeadlessResult references, so an
// external TS consumer can name result.taskStatus / result.mode without importing
// internal ./native/* modules. The type usages below are compile-checked.
describe('owlcoda/headless public surface', () => {
  it('exposes runHeadless and the types HeadlessResult references', () => {
    expect(typeof headless.runHeadless).toBe('function')

    const status: TaskRunStatus = 'blocked'
    const mode: OperatingMode = 'normal'
    const result: Pick<HeadlessResult, 'taskStatus'> = { taskStatus: status }

    expect(result.taskStatus).toBe('blocked')
    expect(mode).toBe('normal')
  })
})
