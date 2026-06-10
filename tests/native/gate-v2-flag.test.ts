import { afterEach, describe, expect, it } from 'vitest'
import { isGateV2Enabled } from '../../src/native/gate-v2-flag.js'

describe('isGateV2Enabled', () => {
  const original = process.env['OWLCODA_GATE_V2']

  afterEach(() => {
    if (original === undefined) delete process.env['OWLCODA_GATE_V2']
    else process.env['OWLCODA_GATE_V2'] = original
  })

  it('returns false when unset', () => {
    delete process.env['OWLCODA_GATE_V2']
    expect(isGateV2Enabled()).toBe(false)
  })

  it.each(['1', 'true', 'yes', 'TRUE', 'Yes'])('returns true for truthy value %s', (value) => {
    process.env['OWLCODA_GATE_V2'] = value
    expect(isGateV2Enabled()).toBe(true)
  })

  it.each(['0', 'false', 'off', '', 'no'])('returns false for falsy or unknown value %s', (value) => {
    process.env['OWLCODA_GATE_V2'] = value
    expect(isGateV2Enabled()).toBe(false)
  })
})
