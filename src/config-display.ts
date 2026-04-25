/**
 * owlcoda config — display active configuration and resolved state.
 * Shows config path, listen address, router, models, and launch mode.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, type OwlCodaConfig, listConfiguredModels } from './config.js'
import { VERSION } from './version.js'
import { getOwlcodaConfigPath } from './paths.js'

export interface ConfigDisplay {
  configPath: string
  configExists: boolean
  version: string
  listen: string
  routerUrl: string
  models: Array<{
    id: string
    label: string
    backendModel: string
    tier: string
    isDefault: boolean
    aliases: string[]
  }>
  launchMode: string
  skillInjection: boolean
  nativeToolCount: number
  sessionCount: number
}

export function getConfigDisplay(configPath?: string): ConfigDisplay {
  const resolvedPath = configPath ?? getOwlcodaConfigPath()
  const configExists = existsSync(resolvedPath)

  let config: OwlCodaConfig | null = null
  try {
    config = loadConfig(configPath)
  } catch {
    // Config may not exist or be invalid
  }

  const models = config ? listConfiguredModels(config).map(m => ({
    id: m.id,
    label: m.label || m.id,
    backendModel: m.backendModel,
    tier: m.tier || 'balanced',
    isDefault: m.default === true,
    aliases: m.aliases || [],
  })) : []
  const launchMode = 'native'

  // Count native tools (static estimate from tool directory)
  let nativeToolCount = 42
  try {
    const toolDir = new URL('./native/tools/', import.meta.url).pathname
    const toolFiles = readdirSync(toolDir).filter(f => f.endsWith('.ts') && !f.startsWith('types') && !f.startsWith('index'))
    nativeToolCount = toolFiles.length
  } catch { /* fallback to static count */ }

  // Count sessions
  let sessionCount = 0
  try {
    const sessionDir = join(process.env['HOME'] ?? '', '.owlcoda', 'native-sessions')
    if (existsSync(sessionDir)) {
      sessionCount = readdirSync(sessionDir).filter(f => f.endsWith('.json')).length
    }
  } catch { /* ignore */ }

  return {
    configPath: resolvedPath,
    configExists,
    version: VERSION,
    listen: config ? `${config.host}:${config.port}` : '127.0.0.1:8019',
    routerUrl: config?.routerUrl ?? 'http://127.0.0.1:8009',
    models,
    launchMode,
    skillInjection: config?.skillInjection !== false,
    nativeToolCount,
    sessionCount,
  }
}

export function formatConfigDisplay(display: ConfigDisplay): string {
  const lines: string[] = [
    `\nowlcoda config v${display.version}`,
    '─'.repeat(50),
    `Config:       ${display.configPath} ${display.configExists ? '✅' : '❌ (not found)'}`,
    `Listen:       ${display.listen}`,
    `Local runtime: ${display.routerUrl}`,
    `Launch mode:  ${display.launchMode}`,
    `Skill inject: ${display.skillInjection ? 'on' : 'off'}`,
    '',
  ]

  if (display.models.length > 0) {
    lines.push(`Models (${display.models.length}):`)
    for (const m of display.models) {
      const tags: string[] = []
      if (m.isDefault) tags.push('default')
      if (m.tier) tags.push(m.tier)
      if (m.aliases.length > 0) tags.push(`aliases: ${m.aliases.join(', ')}`)
      const tagStr = tags.length > 0 ? ` [${tags.join(' · ')}]` : ''
      const name = m.id === m.backendModel ? m.id : `${m.id} → ${m.backendModel}`
      lines.push(`  ${m.isDefault ? '▸' : ' '} ${name}${tagStr}`)
    }
  } else {
    lines.push('Models: none configured')
  }

  lines.push('')
  lines.push('Native capabilities:')
  lines.push(`  Tools:     ${display.nativeToolCount}+ native tools`)
  lines.push(`  Commands:  69+ slash commands`)
  lines.push(`  Sessions:  ${display.sessionCount} stored session${display.sessionCount !== 1 ? 's' : ''}`)
  lines.push(`  Skills:    ${display.skillInjection ? 'active (L2 learning enabled)' : 'disabled'}`)

  lines.push('─'.repeat(50))
  return lines.join('\n')
}
