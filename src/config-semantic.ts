/**
 * Semantic config validation — detects logical issues beyond schema correctness.
 * Catches common mistakes that won't crash but will cause confusing behavior.
 */

export interface SemanticWarning {
  level: 'warn' | 'error'
  code: string
  message: string
}

export function validateSemantics(config: Record<string, unknown>): SemanticWarning[] {
  const warnings: SemanticWarning[] = []

  const models = Array.isArray(config.models) ? config.models as Record<string, unknown>[] : []

  // Check: no models configured
  if (models.length === 0) {
    warnings.push({
      level: 'error',
      code: 'NO_MODELS',
      message: 'No models configured. Run `owlcoda init` or add models to config.json.',
    })
    return warnings
  }

  // Check: duplicate aliases across models
  const aliasMap = new Map<string, string>()
  for (const m of models) {
    const modelId = typeof m.id === 'string' ? m.id : 'unknown'
    const aliases = Array.isArray(m.aliases) ? m.aliases.filter((a): a is string => typeof a === 'string') : []
    for (const alias of aliases) {
      if (aliasMap.has(alias)) {
        warnings.push({
          level: 'warn',
          code: 'DUPLICATE_ALIAS',
          message: `Alias "${alias}" used by both "${aliasMap.get(alias)}" and "${modelId}". First match wins.`,
        })
      } else {
        aliasMap.set(alias, modelId)
      }
    }
  }

  // Check: no default model
  const hasDefault = models.some(m => m.default === true) || typeof config['defaultModel'] === 'string'
  if (!hasDefault) {
    warnings.push({
      level: 'warn',
      code: 'NO_DEFAULT_MODEL',
      message: 'No model marked as default. First model will be used as fallback.',
    })
  }

  // Check: routerUrl looks wrong
  const routerUrl = typeof config.routerUrl === 'string' ? config.routerUrl : ''
  if (routerUrl && !routerUrl.startsWith('http')) {
    warnings.push({
      level: 'error',
      code: 'INVALID_ROUTER_URL',
      message: `routerUrl "${routerUrl}" should start with http:// or https://`,
    })
  }
  if (routerUrl.endsWith('/')) {
    warnings.push({
      level: 'warn',
      code: 'TRAILING_SLASH',
      message: 'routerUrl has trailing slash — may cause double-slash in forwarded URLs.',
    })
  }

  // Check: port conflicts
  const port = typeof config.port === 'number' ? config.port : 0
  if (routerUrl.includes(`:${port}`) || routerUrl.includes(`:${port}/`)) {
    warnings.push({
      level: 'error',
      code: 'PORT_CONFLICT',
      message: `Proxy port ${port} appears to conflict with routerUrl "${routerUrl}".`,
    })
  }

  return warnings
}

export function formatSemanticWarnings(warnings: SemanticWarning[]): string {
  if (warnings.length === 0) return ''

  const lines: string[] = []
  const errors = warnings.filter(w => w.level === 'error')
  const warns = warnings.filter(w => w.level === 'warn')

  if (errors.length > 0) {
    lines.push('❌ Configuration errors:')
    for (const e of errors) {
      lines.push(`   [${e.code}] ${e.message}`)
    }
  }
  if (warns.length > 0) {
    lines.push('⚠️  Configuration warnings:')
    for (const w of warns) {
      lines.push(`   [${w.code}] ${w.message}`)
    }
  }

  return lines.join('\n')
}
