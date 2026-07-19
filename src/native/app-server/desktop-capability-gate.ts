import {
  APP_SERVER_PROTOCOL_VERSION,
  type AppServerMethodContract,
  type AppServerProtocolDescription,
} from './protocol-contract.js'

export type DesktopCapabilityMethodStatus =
  | 'available'
  | 'missing'
  | 'wrong_stability'
  | 'debug_only_forbidden'

export interface DesktopCapabilityGatePolicy {
  protocolVersion: string
  requiredStableMethods: string[]
  optionalExperimentalMethods: string[]
  forbiddenDebugOnlyMethods: string[]
}

export interface DesktopCapabilityMethodCheck {
  method: string
  status: DesktopCapabilityMethodStatus
  stability?: AppServerMethodContract['stability']
}

export interface DesktopCapabilityGateResult {
  ok: boolean
  protocolVersion: string | null
  requiredStableMethods: DesktopCapabilityMethodCheck[]
  optionalExperimentalMethods: DesktopCapabilityMethodCheck[]
  debugOnlyMethods: string[]
  errors: string[]
  warnings: string[]
}

export const DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY: DesktopCapabilityGatePolicy = {
  protocolVersion: APP_SERVER_PROTOCOL_VERSION,
  requiredStableMethods: [
    'protocol/describe',
    'project/list',
    'project/get',
    'thread/list',
    'thread/start',
    'thread/resume',
    'runtimeTranscript/read',
    'approval/list',
    'approval/resolve',
    'interaction/list',
    'interaction/respond',
    'review/list',
    'review/statusList',
    'review/statusUpdate',
    'job/list',
    'job/get',
    'job/cancel',
  ],
  optionalExperimentalMethods: [
    'event/subscribe',
    'turn/start',
    'turn/status',
    'turn/recover',
    'turn/interrupt',
    'runtimeRail/read',
    'runtimeFacts/read',
    'runtimeScorecard/read',
    'structuredOutputArtifacts/read',
    'benchmark/providerEvalReport/read',
    'review/preflight',
    'review/apply',
    'review/revert',
    'review/batchPreflight',
    'review/batchApply',
    'review/batchRevert',
    'review/hunkApply',
    'review/hunkRevert',
  ],
  forbiddenDebugOnlyMethods: [
    'diagnostic/health',
  ],
}

export function evaluateDesktopCapabilityGate(
  protocol: AppServerProtocolDescription | null | undefined,
  policy: DesktopCapabilityGatePolicy = DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY,
): DesktopCapabilityGateResult {
  const methods = protocol?.methods ?? []
  const methodByName: Map<string, AppServerMethodContract> = new Map(methods.map(method => [method.method, method]))
  const errors: string[] = []
  const warnings: string[] = []

  if (!protocol) {
    errors.push('protocol description missing')
  } else if (protocol.protocolVersion !== policy.protocolVersion) {
    errors.push(`unsupported protocol version ${protocol.protocolVersion}; expected ${policy.protocolVersion}`)
  }

  const requiredStableMethods = policy.requiredStableMethods.map(method =>
    checkRequiredStableMethod(method, methodByName, errors))
  const optionalExperimentalMethods = policy.optionalExperimentalMethods.map(method =>
    checkOptionalExperimentalMethod(method, methodByName, errors, warnings))

  for (const method of policy.forbiddenDebugOnlyMethods) {
    const contract = methodByName.get(method)
    if (contract?.stability !== 'debug-only') continue
    if (policy.requiredStableMethods.includes(method) || policy.optionalExperimentalMethods.includes(method)) {
      errors.push(`product policy cannot bind debug-only method: ${method}`)
    }
  }

  const debugOnlyMethods = methods
    .filter(method => method.stability === 'debug-only')
    .map(method => method.method)
    .sort()

  return {
    ok: errors.length === 0,
    protocolVersion: protocol?.protocolVersion ?? null,
    requiredStableMethods,
    optionalExperimentalMethods,
    debugOnlyMethods,
    errors,
    warnings,
  }
}

function checkRequiredStableMethod(
  method: string,
  methodByName: Map<string, AppServerMethodContract>,
  errors: string[],
): DesktopCapabilityMethodCheck {
  const contract = methodByName.get(method)
  if (!contract) {
    errors.push(`required stable method missing: ${method}`)
    return { method, status: 'missing' }
  }
  if (contract.stability === 'debug-only') {
    errors.push(`product policy cannot bind debug-only method: ${method}`)
    return { method, status: 'debug_only_forbidden', stability: contract.stability }
  }
  if (contract.stability !== 'stable') {
    errors.push(`required stable method has stability ${contract.stability}: ${method}`)
    return { method, status: 'wrong_stability', stability: contract.stability }
  }
  return { method, status: 'available', stability: contract.stability }
}

function checkOptionalExperimentalMethod(
  method: string,
  methodByName: Map<string, AppServerMethodContract>,
  errors: string[],
  warnings: string[],
): DesktopCapabilityMethodCheck {
  const contract = methodByName.get(method)
  if (!contract) return { method, status: 'missing' }
  if (contract.stability === 'debug-only') {
    errors.push(`product policy cannot bind debug-only method: ${method}`)
    return { method, status: 'debug_only_forbidden', stability: contract.stability }
  }
  if (contract.stability === 'experimental') {
    warnings.push(`optional experimental method available: ${method}`)
  }
  return { method, status: 'available', stability: contract.stability }
}
