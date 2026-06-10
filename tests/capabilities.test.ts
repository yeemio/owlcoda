/**
 * Tests for src/capabilities.ts — capability declarations and honest status.
 */

import { describe, it, expect } from 'vitest'

import {
  CAPABILITIES,
  getCapabilitySummary,
  getSupportedCapabilities,
  getUnsupportedCapabilities,
  getCapabilitiesByStatus,
} from '../dist/capabilities.js'

describe('capabilities: CAPABILITIES array', () => {
  it('contains at least 10 declarations', () => {
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(10)
  })

  it('every entry has name, status, and detail', () => {
    for (const cap of CAPABILITIES) {
      expect(cap.name).toBeTruthy()
      expect(cap.status).toBeTruthy()
      expect(cap.detail).toBeTruthy()
    }
  })

  it('status values are all valid labels', () => {
    const validStatuses = ['supported', 'partial', 'best_effort', 'manual-only', 'blocked', 'unsupported']
    for (const cap of CAPABILITIES) {
      expect(validStatuses).toContain(cap.status)
    }
  })

  it('has at least one supported capability', () => {
    const supported = CAPABILITIES.filter(c => c.status === 'supported')
    expect(supported.length).toBeGreaterThan(0)
  })

  it('has at least one unsupported capability', () => {
    const unsupported = CAPABILITIES.filter(c => c.status === 'unsupported')
    expect(unsupported.length).toBeGreaterThan(0)
  })
})

describe('capabilities: getCapabilitySummary', () => {
  it('returns a non-empty string', () => {
    const summary = getCapabilitySummary()
    expect(typeof summary).toBe('string')
    expect(summary.length).toBeGreaterThan(0)
  })

  it('mentions supported count', () => {
    const summary = getCapabilitySummary()
    expect(summary).toMatch(/\d+/)
  })
})

describe('capabilities: filter functions', () => {
  it('getSupportedCapabilities returns only supported', () => {
    const supported = getSupportedCapabilities()
    for (const cap of supported) {
      expect(cap.status).toBe('supported')
    }
  })

  it('getUnsupportedCapabilities returns only unsupported', () => {
    const unsupported = getUnsupportedCapabilities()
    for (const cap of unsupported) {
      expect(cap.status).toBe('unsupported')
    }
  })

  it('getCapabilitiesByStatus returns matching entries', () => {
    const partial = getCapabilitiesByStatus('partial')
    for (const cap of partial) {
      expect(cap.status).toBe('partial')
    }
    expect(partial.length).toBeGreaterThan(0)
  })

  it('all filtered sets are subsets of CAPABILITIES', () => {
    const all = new Set(CAPABILITIES.map(c => c.name))
    const supported = getSupportedCapabilities()
    const unsupported = getUnsupportedCapabilities()
    const partial = getCapabilitiesByStatus('partial')
    const bestEffort = getCapabilitiesByStatus('best_effort')

    for (const cap of [...supported, ...unsupported, ...partial, ...bestEffort]) {
      expect(all.has(cap.name)).toBe(true)
    }
  })
})
