/**
 * `owlcoda export` — Export a sanitized, shareable configuration bundle.
 * Strips API keys and secrets, outputs a config template + env instructions.
 */

import { loadConfig } from './config.js'
import type { ConfiguredModel } from './model-registry.js'

export interface ExportedConfig {
  version: string
  routerUrl: string
  host: string
  port: number
  models: Array<{
    id: string
    tier: string
    aliases: string[]
    backend?: string
  }>
}

export interface ExportResult {
  config: ExportedConfig
  envVars: Record<string, string>
  warnings: string[]
}

function sanitizeModel(m: ConfiguredModel): ExportedConfig['models'][0] {
  return {
    id: m.id,
    tier: m.tier || 'balanced',
    aliases: m.aliases || [],
    ...(m.channel ? { backend: m.channel } : {}),
  }
}

export function createExport(configPath?: string): ExportResult {
  const config = loadConfig(configPath)
  const warnings: string[] = []

  // Check for secrets that would be stripped
  for (const m of config.models) {
    if (m.apiKey) {
      warnings.push(`API key for ${m.id} stripped from export`)
    }
  }

  const exported: ExportedConfig = {
    version: '1.0',
    routerUrl: config.routerUrl,
    host: config.host,
    port: config.port,
    models: config.models.map(sanitizeModel),
  }

  // Compute the env vars needed to point tools at the OwlCoda proxy.
  const envVars: Record<string, string> = {
    OWLCODA_BASE_URL: `http://${config.host}:${config.port}`,
    OWLCODA_ROUTER_URL: config.routerUrl,
  }

  // Map model tiers to env vars
  for (const m of config.models) {
    const tier = m.tier?.toLowerCase() || 'balanced'
    if (tier === 'heavy') {
      envVars['OWLCODA_DEFAULT_HEAVY_MODEL'] = m.id
    } else if (tier === 'fast') {
      envVars['OWLCODA_DEFAULT_FAST_MODEL'] = m.id
    } else {
      envVars['OWLCODA_DEFAULT_BALANCED_MODEL'] = m.id
    }
  }

  return { config: exported, envVars, warnings }
}

export function formatExport(result: ExportResult, format: 'json' | 'env' | 'text' = 'text'): string {
  if (format === 'json') {
    return JSON.stringify({ config: result.config, envVars: result.envVars }, null, 2)
  }

  if (format === 'env') {
    return Object.entries(result.envVars)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  }

  // text format
  const lines: string[] = []
  lines.push('📦 OwlCoda Configuration Export')
  lines.push('─'.repeat(50))

  if (result.warnings.length > 0) {
    lines.push('')
    lines.push('⚠️  Warnings:')
    for (const w of result.warnings) {
      lines.push(`   ${w}`)
    }
  }

  lines.push('')
  lines.push('Config (config.json):')
  lines.push(JSON.stringify(result.config, null, 2))

  lines.push('')
  lines.push('Environment variables:')
  for (const [k, v] of Object.entries(result.envVars)) {
    lines.push(`  export ${k}="${v}"`)
  }

  lines.push('')
  lines.push('To use: copy the config above to ~/.owlcoda/config.json')
  lines.push('Or set the environment variables before starting OwlCoda or calling the local API.')

  return lines.join('\n')
}
