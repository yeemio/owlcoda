/**
 * Backend adapter types — abstracts the discovery and connection
 * details for different local LLM backends (Ollama, LM Studio, vLLM, etc.)
 *
 * All adapters share the same chat completions protocol (OpenAI-compatible),
 * but differ in:
 *   1. How models are discovered
 *   2. Default port and base URL
 *   3. Model naming conventions
 *   4. Health check endpoint
 */

export interface DiscoveredModel {
  /** Model ID as the backend knows it */
  id: string
  /** Human-readable display name */
  label: string
  /** Backend type that discovered this model */
  backend: BackendType
  /** Base URL of the backend instance */
  baseUrl: string
  /** Quantization info if available (e.g. "Q4_K_M") */
  quantization?: string
  /** Parameter count if available (e.g. "7B") */
  parameterSize?: string
  /** Context window size if known */
  contextWindow?: number
}

export type BackendType = 'ollama' | 'lmstudio' | 'vllm' | 'openai-compat'

export interface BackendAdapter {
  /** Adapter name */
  readonly name: BackendType
  /** Default port for this backend */
  readonly defaultPort: number
  /** Base URL (e.g. "http://127.0.0.1:11434") */
  readonly baseUrl: string

  /** Check if the backend is reachable */
  isReachable(timeoutMs?: number): Promise<boolean>

  /** Discover available models */
  discover(timeoutMs?: number): Promise<DiscoveredModel[]>

  /** Return the chat completions endpoint URL */
  chatCompletionsUrl(): string

  /** Return any required headers for requests */
  headers(): Record<string, string>
}

export interface BackendConfig {
  /** Backend type */
  type: BackendType
  /** Override base URL (default: http://127.0.0.1:{defaultPort}) */
  baseUrl?: string
  /** API key if required */
  apiKey?: string
  /** Whether this backend is enabled for auto-discovery */
  enabled?: boolean
}

export interface DiscoveryResult {
  /** All discovered models across all backends */
  models: DiscoveredModel[]
  /** Which backends were reachable */
  reachableBackends: BackendType[]
  /** Which backends were unreachable */
  unreachableBackends: BackendType[]
  /** Discovery duration in ms */
  durationMs: number
}
