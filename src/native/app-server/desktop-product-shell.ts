import {
  createAppServerClient,
  type AppServerClient,
  type AppServerClientOptions,
} from './client.js'
import {
  DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY,
  evaluateDesktopCapabilityGate,
  type DesktopCapabilityGatePolicy,
  type DesktopCapabilityGateResult,
} from './desktop-capability-gate.js'
import type {
  AppServerMethodContract,
  AppServerProtocolDescription,
} from './protocol-contract.js'

export interface DesktopProductShellBootstrapOptions extends AppServerClientOptions {
  capabilityPolicy?: DesktopCapabilityGatePolicy
}

export interface DesktopProductShellBootstrapResult {
  productSurface: 'desktop-product-shell'
  boundary: 'external-product-shell'
  ready: boolean
  protocolVersion: string | null
  client: AppServerClient
  protocol: AppServerProtocolDescription
  capabilityGate: DesktopCapabilityGateResult
  stableMethods: string[]
  experimentalMethods: string[]
  debugOnlyMethods: string[]
  errors: string[]
  warnings: string[]
}

export async function bootstrapDesktopProductShell(
  options: DesktopProductShellBootstrapOptions,
): Promise<DesktopProductShellBootstrapResult> {
  const client = createAppServerClient(options)
  const protocol = await client.protocolDescribe()
  const capabilityGate = evaluateDesktopCapabilityGate(
    protocol,
    options.capabilityPolicy ?? DEFAULT_DESKTOP_CAPABILITY_GATE_POLICY,
  )

  return {
    productSurface: 'desktop-product-shell',
    boundary: 'external-product-shell',
    ready: capabilityGate.ok,
    protocolVersion: capabilityGate.protocolVersion,
    client,
    protocol,
    capabilityGate,
    stableMethods: methodsByStability(protocol, 'stable'),
    experimentalMethods: methodsByStability(protocol, 'experimental'),
    debugOnlyMethods: capabilityGate.debugOnlyMethods,
    errors: [...capabilityGate.errors],
    warnings: [...capabilityGate.warnings],
  }
}

function methodsByStability(
  protocol: AppServerProtocolDescription,
  stability: AppServerMethodContract['stability'],
): string[] {
  return protocol.methods
    .filter(method => method.stability === stability)
    .map(method => method.method)
    .sort()
}
