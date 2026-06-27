import { describe, expect, it } from 'vitest'
import type { AppServerProtocolDescription } from '../../../src/native/app-server/protocol-contract.js'
import {
  DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY,
  evaluateDesktopCapabilityGate,
} from '../../../src/native/app-server/desktop-capability-gate.js'

describe('desktop capability gate', () => {
  it('passes when required product methods are stable and optional experimental methods are discoverable', () => {
    const result = evaluateDesktopCapabilityGate(protocol([
      ['protocol/describe', 'stable'],
      ['project/list', 'stable'],
      ['project/get', 'stable'],
      ['thread/list', 'stable'],
      ['thread/start', 'stable'],
      ['thread/resume', 'stable'],
      ['runtimeTranscript/read', 'stable'],
      ['review/list', 'stable'],
      ['review/statusList', 'stable'],
      ['review/statusUpdate', 'stable'],
      ['approval/list', 'stable'],
      ['approval/resolve', 'stable'],
      ['interaction/list', 'stable'],
      ['interaction/respond', 'stable'],
      ['job/list', 'stable'],
      ['job/get', 'stable'],
      ['job/cancel', 'stable'],
      ['turn/start', 'experimental'],
      ['turn/status', 'experimental'],
      ['turn/recover', 'experimental'],
      ['turn/interrupt', 'experimental'],
      ['runtimeRail/read', 'experimental'],
      ['runtimeFacts/read', 'experimental'],
      ['runtimeScorecard/read', 'experimental'],
      ['structuredOutputArtifacts/read', 'experimental'],
      ['benchmark/providerEvalReport/read', 'experimental'],
      ['review/batchPreflight', 'experimental'],
      ['review/batchApply', 'experimental'],
      ['review/batchRevert', 'experimental'],
      ['review/hunkApply', 'experimental'],
      ['review/hunkRevert', 'experimental'],
      ['proof/append', 'experimental'],
      ['gate/confirm', 'experimental'],
      ['event/subscribe', 'experimental'],
      ['diagnostic/health', 'debug-only'],
    ]))

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.requiredStableMethods.every(item => item.status === 'available')).toBe(true)
    expect(result.optionalExperimentalMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'runtimeRail/read',
        status: 'available',
        stability: 'experimental',
      }),
      expect.objectContaining({
        method: 'benchmark/providerEvalReport/read',
        status: 'available',
        stability: 'experimental',
      }),
      expect.objectContaining({
        method: 'structuredOutputArtifacts/read',
        status: 'available',
        stability: 'experimental',
      }),
      expect.objectContaining({
        method: 'review/hunkApply',
        status: 'available',
        stability: 'experimental',
      }),
      expect.objectContaining({
        method: 'review/hunkRevert',
        status: 'available',
        stability: 'experimental',
      }),
    ]))
    expect(result.warnings).toEqual(expect.arrayContaining([
      'optional experimental method available: runtimeRail/read',
      'optional experimental method available: benchmark/providerEvalReport/read',
      'optional experimental method available: structuredOutputArtifacts/read',
      'optional experimental method available: review/hunkApply',
      'optional experimental method available: review/hunkRevert',
    ]))
    expect(result.debugOnlyMethods).toEqual(['diagnostic/health'])
  })

  it('fails when a required stable method is missing or downgraded to experimental', () => {
    const result = evaluateDesktopCapabilityGate(protocol([
      ['protocol/describe', 'stable'],
      ['project/list', 'stable'],
      ['project/get', 'stable'],
      ['thread/start', 'stable'],
      ['thread/resume', 'stable'],
      ['runtimeTranscript/read', 'experimental'],
      ['review/list', 'stable'],
      ['review/statusList', 'stable'],
      ['review/statusUpdate', 'stable'],
      ['approval/list', 'stable'],
      ['approval/resolve', 'stable'],
      ['interaction/list', 'stable'],
      ['interaction/respond', 'stable'],
      ['job/list', 'stable'],
      ['job/get', 'stable'],
      ['job/cancel', 'stable'],
    ]))

    expect(result.ok).toBe(false)
    expect(result.requiredStableMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'runtimeTranscript/read',
        status: 'wrong_stability',
        stability: 'experimental',
      }),
      expect.objectContaining({
        method: 'review/list',
        status: 'available',
      }),
    ]))
    expect(result.errors).toEqual(expect.arrayContaining([
      'required stable method has stability experimental: runtimeTranscript/read',
      'required stable method missing: thread/list',
    ]))
  })

  it('fails when a product policy tries to bind a debug-only method', () => {
    const result = evaluateDesktopCapabilityGate(protocol([
      ['protocol/describe', 'stable'],
      ['project/list', 'stable'],
      ['diagnostic/health', 'debug-only'],
    ]), {
      ...DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY,
      requiredStableMethods: ['protocol/describe', 'diagnostic/health'],
      optionalExperimentalMethods: [],
    })

    expect(result.ok).toBe(false)
    expect(result.requiredStableMethods).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'diagnostic/health',
        status: 'debug_only_forbidden',
      }),
    ]))
    expect(result.errors).toEqual(expect.arrayContaining([
      'product policy cannot bind debug-only method: diagnostic/health',
    ]))
  })
})

type ProtocolMethodFixture = readonly [string, AppServerProtocolDescription['methods'][number]['stability']]

function protocol(methods: ProtocolMethodFixture[]): AppServerProtocolDescription {
  return {
    schemaVersion: 'v1',
    protocolVersion: 'v1',
    methods: methods.map(([method, stability]) => ({
      method: method as AppServerProtocolDescription['methods'][number]['method'],
      group: method.split('/')[0] as AppServerProtocolDescription['methods'][number]['group'],
      stability,
      requestType: 'Record<string, never>',
      responseType: 'Record<string, unknown>',
      requires: [],
      queryKeys: [],
    })),
  }
}
