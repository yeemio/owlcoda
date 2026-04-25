/**
 * `owlcoda models` — Display configured models with tier assignments, aliases, and availability.
 */

import { loadConfig } from './config.js'
import type { ConfiguredModel } from './model-registry.js'
import { probeRuntimeSurface } from './runtime-probe.js'

export interface ModelInfo {
  id: string
  tier: string
  alias?: string
  backend?: string
}

export interface ModelsDisplay {
  models: ModelInfo[]
  routerUrl: string
  routerReachable: boolean
  routerModels: string[]
  runtimeSource?: string | null
  runtimeProbeDetail?: string
  loadedModels?: string[]
  deprecatedFallback?: boolean
}

interface RuntimeModelsProbe {
  reachable: boolean
  models: string[]
  detail: string
  source: string | null
  loadedModels: string[]
  deprecatedFallback: boolean
}

function getTier(model: ConfiguredModel): string {
  if (model.tier) return model.tier
  const id = model.id.toLowerCase()
  if (id.includes('large') || id.includes('70b') || id.includes('72b')) return 'heavy'
  if (id.includes('small') || id.includes('8b') || id.includes('7b')) return 'fast'
  return 'balanced'
}

async function probeRouter(routerUrl: string): Promise<RuntimeModelsProbe> {
  const probe = await probeRuntimeSurface(routerUrl, 3000)
  return {
    reachable: probe.ok,
    models: probe.modelIds,
    detail: probe.detail,
    source: probe.source,
    loadedModels: probe.loadedModelIds,
    deprecatedFallback: probe.platformVisibility?.deprecatedFallback === true,
  }
}

export async function getModelsDisplay(configPath?: string): Promise<ModelsDisplay> {
  const config = loadConfig(configPath)

  const models: ModelInfo[] = config.models.map(m => ({
    id: m.id,
    tier: getTier(m),
    alias: m.aliases?.[0],
    backend: m.channel,
  }))

  const router = await probeRouter(config.routerUrl)

  return {
    models,
    routerUrl: config.routerUrl,
    routerReachable: router.reachable,
    routerModels: router.models,
    runtimeSource: router.source,
    runtimeProbeDetail: router.detail,
    loadedModels: router.loadedModels,
    deprecatedFallback: router.deprecatedFallback,
  }
}

export function formatModelsDisplay(display: ModelsDisplay): string {
  const lines: string[] = []

  lines.push('📋 Configured Models')
  lines.push('─'.repeat(50))

  if (display.models.length === 0) {
    lines.push('  (none configured)')
  } else {
    const tierOrder = ['heavy', 'balanced', 'fast']
    const grouped = new Map<string, ModelInfo[]>()
    for (const m of display.models) {
      const tier = m.tier
      if (!grouped.has(tier)) grouped.set(tier, [])
      grouped.get(tier)!.push(m)
    }

    for (const tier of tierOrder) {
      const models = grouped.get(tier)
      if (!models) continue
      const icon = tier === 'heavy' ? '🟣' : tier === 'balanced' ? '🔵' : '🟢'
      lines.push(`  ${icon} ${tier.toUpperCase()}`)
      for (const m of models) {
        let line = `     ${m.id}`
        if (m.alias) line += ` (alias: ${m.alias})`
        if (m.backend) line += ` [${m.backend}]`
        lines.push(line)
      }
    }

    // Show any tiers not in standard order
    for (const [tier, models] of grouped) {
      if (tierOrder.includes(tier)) continue
      lines.push(`  ⚪ ${tier.toUpperCase()}`)
      for (const m of models) {
        let line = `     ${m.id}`
        if (m.alias) line += ` (alias: ${m.alias})`
        if (m.backend) line += ` [${m.backend}]`
        lines.push(line)
      }
    }
  }

  lines.push('')
  lines.push(`🔗 Local runtime: ${display.routerUrl}`)
  if (display.routerReachable) {
    if (display.runtimeProbeDetail) lines.push(`   Visibility: ${display.runtimeProbeDetail}`)
    lines.push(`   Visible: ${display.routerModels.length} model(s)`)
    if (display.deprecatedFallback) lines.push('   ⚠️  Deprecated router fallback is still in use')
    if (display.routerModels.length > 0 && display.routerModels.length <= 20) {
      for (const id of display.routerModels) {
        const configured = display.models.some(m => m.id === id)
        const mark = configured ? '✓' : ' '
        lines.push(`   ${mark} ${id}`)
      }
    } else if ((display.loadedModels?.length ?? 0) > 0) {
      lines.push(`   Loaded inventory only: ${display.loadedModels!.length} model(s)`)
    }
  } else {
    lines.push('   ⚠️  Local runtime unreachable')
    const placeholderOnly = display.models.length === 0
      || (display.models.length === 1 && display.models[0]?.id === 'your-default-model')
    if (placeholderOnly) {
      lines.push('')
      lines.push('   Next: install a local backend (Ollama / LM Studio / vLLM)')
      lines.push('   then rerun `owlcoda init` to auto-detect models.')
    } else {
      lines.push('   Start your local backend, then rerun `owlcoda models` to verify.')
    }
  }

  return lines.join('\n')
}
