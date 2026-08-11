import type { AgentRuntimeDriver, RuntimeExecutionTaskKind } from './types.js'

const trustedVendorDrivers = new WeakSet<AgentRuntimeDriver>()

export function trustBuiltInVendorDriver<T extends AgentRuntimeDriver>(driver: T): T {
  trustedVendorDrivers.add(driver)
  return driver
}

export function isTrustedBuiltInVendorDriver(
  driver: AgentRuntimeDriver,
  taskKind: RuntimeExecutionTaskKind,
): boolean {
  return trustedVendorDrivers.has(driver)
    && driver.family === 'vendor-native'
    && driver.capabilities.taskKinds.length === 1
    && driver.capabilities.taskKinds[0] === taskKind
}
