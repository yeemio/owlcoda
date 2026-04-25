/**
 * Backend adapter barrel export.
 */
export { OllamaAdapter } from './ollama.js'
export { LMStudioAdapter } from './lmstudio.js'
export { VLLMAdapter } from './vllm.js'
export { createAdapter, discoverBackends, anyBackendReachable } from './discovery.js'
export type {
  BackendAdapter,
  BackendConfig,
  BackendType,
  DiscoveredModel,
  DiscoveryResult,
} from './types.js'
