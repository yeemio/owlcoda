/**
 * URL normalization for OpenAI/Anthropic-compatible base URLs.
 *
 * Leaf module — no imports — so both `config.ts` and `model-registry.ts` can
 * share the single canonical normalization rule without a circular import
 * (`config.ts` imports from `model-registry.ts`, so `model-registry.ts` must
 * not import back from `config.ts`). `config.ts` re-exports
 * `normalizeRouterBaseUrl` for backward compatibility with existing importers.
 */

/**
 * Normalize a router/base URL to the canonical bare-base form.
 *
 * Consumers (resolveModelRoute, probeRuntimeSurface, detectRouterModels, the
 * native conversation send path) all append the API path themselves —
 * `/v1/chat/completions`, `/v1/models`, `/v1/messages`. A base that already
 * ends in `/v1` (a natural mistake — the OpenAI-compatible base most local
 * runtimes document IS `…:11434/v1`) doubles to `/v1/v1/...` and 404s. Strip a
 * single trailing `/v1` segment plus any trailing slashes so the stored base
 * is unambiguous. Lenient by design: never throws — malformed input flows
 * through (minus trailing slash/v1) so downstream validation owns the error.
 */
export function normalizeRouterBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/v1$/, '')
}

/**
 * Build the Anthropic-compatible `/v1/messages` endpoint URL from a base URL.
 *
 * Normalizes the base first so a base that already carries `/v1` (the Ollama
 * footgun: `http://localhost:11434/v1`) does not double to `/v1/v1/messages`.
 * Used by the native conversation loop's client send path so programmatic
 * callers that pass a `/v1`-suffixed `apiBaseUrl` route correctly instead of
 * 404ing every request and spinning to `max_iterations`.
 */
export function buildAnthropicMessagesUrl(apiBaseUrl: string): string {
  return `${normalizeRouterBaseUrl(apiBaseUrl)}/v1/messages`
}
