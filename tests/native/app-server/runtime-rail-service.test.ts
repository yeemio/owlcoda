import { describe, it, expect } from 'vitest'
import {
  readRuntimeRail,
  RunKitRailState,
} from '../../../src/native/app-server/runtime-rail-service.js'

describe('runtime-rail-service', () => {
  it('returns a skeleton with explicit missing freshness', async () => {
    const state: RunKitRailState = await readRuntimeRail('nonexistent-project')
    expect(state).toHaveProperty('freshness')
    expect(state.freshness).toBe('missing')
  })

  it('returns rail shape without hard-coded demo data', async () => {
    const state: RunKitRailState = await readRuntimeRail('any-id')
    expect(state).toHaveProperty('projectId')
    expect(state.projectId).toBe('any-id')
    expect(state).toHaveProperty('packet')
    expect(state.packet).toBeNull()
    expect(state).toHaveProperty('gate')
    expect(state.gate).toBeNull()
    expect(state).toHaveProperty('claim')
    expect(state.claim).toBeNull()
    expect(state).toHaveProperty('proofs')
    expect(Array.isArray(state.proofs)).toBe(true)
    expect(state.proofs).toHaveLength(0)
    expect(state).toHaveProperty('rejectedPaths')
    expect(Array.isArray(state.rejectedPaths)).toBe(true)
    expect(state.rejectedPaths).toHaveLength(0)
    expect(state).toHaveProperty('nextAction')
    expect(state.nextAction).toBeNull()
  })

  it('does not include demo diff or demo proof entries', async () => {
    const state: RunKitRailState = await readRuntimeRail('demo-project')
    // No fake diff entries
    if (state.proofs && state.proofs.length > 0) {
      for (const proof of state.proofs) {
        expect(proof).not.toContain('demo')
        expect(proof).not.toContain('fake')
      }
    }
    // No fake tasks
    if (state.nextAction) {
      expect(state.nextAction).not.toContain('demo')
    }
  })

  it('does not parse terminal output', async () => {
    // This is a contract test: the service must never shell out to
    // terminal / git status / CLI output scraping and treat it as a
    // source of truth for rail state.
    const state: RunKitRailState = await readRuntimeRail('terminal-test')
    // Terminal parsing would produce some unstructured string; our
    // skeleton is strictly typed and null/empty where no real gate
    // or packet exists.
    expect(state.packet).toBeNull()
    expect(state.gate).toBeNull()
  })
})
