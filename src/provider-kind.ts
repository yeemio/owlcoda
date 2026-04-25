import type { ConfiguredModel } from './model-registry.js'

export type ProviderKind = 'anthropic' | 'openai-compat' | 'kimi' | 'moonshot' | 'custom'

export function normalizeProviderKind(model: Pick<ConfiguredModel, 'endpoint' | 'headers'> & { provider?: string }): ProviderKind {
  const explicit = typeof model.provider === 'string' ? model.provider.trim().toLowerCase() : ''
  if (explicit === 'anthropic') return 'anthropic'
  if (explicit === 'openrouter') return 'openai-compat'
  if (explicit === 'bailian') return 'openai-compat'
  if (explicit === 'openai-compat' || explicit === 'openai' || explicit === 'openai_compat') return 'openai-compat'
  if (explicit === 'kimi') return 'kimi'
  if (explicit === 'moonshot') return 'moonshot'
  if (explicit === 'minimax-anthropic' || explicit === 'minimax') return 'anthropic'
  if (explicit === 'custom') return 'custom'

  const endpoint = model.endpoint?.toLowerCase() ?? ''
  if (endpoint.includes('anthropic.com')) return 'anthropic'
  if (endpoint.includes('/anthropic')) return 'anthropic'
  if (endpoint.includes('/v1/messages')) return 'anthropic'
  if (endpoint.includes('api.kimi.com')) return 'kimi'
  if (endpoint.includes('moonshot')) return 'moonshot'
  if (endpoint.includes('openai.com')) return 'openai-compat'
  if (endpoint.includes('/v1')) return 'openai-compat'
  return 'custom'
}
