/**
 * owlcoda init — interactive config setup wizard.
 * Creates config.json from template with optional model auto-detection.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { get as httpGet } from 'node:http'
import { getOwlcodaConfigPath } from './paths.js'

export interface InitOptions {
  routerUrl?: string
  port?: number
  force?: boolean
}

export interface InitResult {
  created: boolean
  configPath: string
  message: string
  modelsDetected?: string[]
}

function httpGetJson(url: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, { timeout: timeoutMs }, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()))
        } catch {
          reject(new Error('Invalid JSON response'))
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

interface DetectedModel {
  id: string
  object?: string
}

async function detectRouterModels(routerUrl: string): Promise<string[]> {
  try {
    const data = await httpGetJson(`${routerUrl}/v1/models`) as { data?: DetectedModel[] }
    if (data?.data && Array.isArray(data.data)) {
      return data.data.map((m: DetectedModel) => m.id).filter(Boolean)
    }
  } catch {
    // Router not available — not an error for init
  }
  return []
}

/**
 * Default candidate backends, probed in order when the user does not pass
 * --router. First responder wins. Covers the three OpenAI-compatible local
 * runtimes most users actually run.
 *
 * The legacy :8009 router is intentionally not probed here — `owlcoda doctor`
 * downgrades it to `deprecated_router_models`, so auto-selecting it would put
 * fresh users on the deprecated path on their very first run.
 */
const DEFAULT_ROUTER_CANDIDATES: { url: string; label: string }[] = [
  { url: 'http://127.0.0.1:11434/v1', label: 'Ollama' },
  { url: 'http://127.0.0.1:1234/v1', label: 'LM Studio' },
  { url: 'http://127.0.0.1:8000/v1', label: 'vLLM' },
]

interface ProbeResult {
  routerUrl: string
  routerLabel: string
  models: string[]
}

async function probeDefaultRouters(): Promise<ProbeResult> {
  for (const candidate of DEFAULT_ROUTER_CANDIDATES) {
    const models = await detectRouterModels(candidate.url)
    if (models.length > 0) {
      return { routerUrl: candidate.url, routerLabel: candidate.label, models }
    }
  }
  // Nothing answered — keep Ollama as the most-likely default the user will
  // install next, and let buildConfigFromModels fall back to a placeholder.
  return {
    routerUrl: DEFAULT_ROUTER_CANDIDATES[0]!.url,
    routerLabel: DEFAULT_ROUTER_CANDIDATES[0]!.label,
    models: [],
  }
}

function inferTier(modelId: string, index: number, total: number): 'heavy' | 'balanced' | 'fast' {
  const id = modelId.toLowerCase()
  // Size-based heuristics
  if (id.includes('70b') || id.includes('72b') || id.includes('65b') || id.includes('large')) return 'heavy'
  if (id.includes('7b') || id.includes('8b') || id.includes('3b') || id.includes('small') || id.includes('mini')) return 'fast'
  // Position-based fallback
  if (total >= 3) {
    if (index === 0) return 'balanced'
    if (index === total - 1) return 'fast'
    return 'heavy'
  }
  return 'balanced'
}

function isEmbeddingShaped(modelId: string): boolean {
  const id = modelId.toLowerCase()
  return id.includes('embedding') || id.includes('embed') || id.includes('rerank') || id.includes('bge-')
}

function buildConfigFromModels(models: string[], routerUrl: string, port: number): Record<string, unknown> {
  // Filter out embedding / rerank models from the chat model list entirely.
  // They cannot generate chat responses, and surfacing them in the /model
  // picker only causes new users to pick one and get a cryptic failure on
  // their first prompt. If the router exposes ONLY embedding models we keep
  // them as a last resort so the user at least sees what was discovered.
  const chatCapable = models.filter(id => !isEmbeddingShaped(id))
  const usableModels = chatCapable.length > 0 ? chatCapable : models

  const modelConfigs = usableModels.map((id, i) => {
    const tier = inferTier(id, i, usableModels.length)
    return {
      id,
      label: id,
      backendModel: id,
      aliases: [],
      tier,
      default: i === 0,
    }
  })

  return {
    port,
    host: '127.0.0.1',
    routerUrl,
    routerTimeoutMs: 600000,
    responseModelStyle: 'platform',
    models: modelConfigs.length > 0 ? modelConfigs : [
      {
        id: 'your-default-model',
        label: 'Default Model',
        backendModel: 'your-default-model',
        aliases: [],
        tier: 'balanced',
        default: true,
      },
    ],
    logLevel: 'info',
    // L3 training-data collection — opt-in. Set to true to enable per-session
    // quality scoring and JSONL collection under ~/.owlcoda/training/.
    // Env OWLCODA_TRAINING_COLLECTION=1 overrides per process.
    trainingCollection: false,
  }
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const configPath = getOwlcodaConfigPath()
  const port = options.port ?? 8019

  // Check if config already exists
  if (existsSync(configPath) && !options.force) {
    return {
      created: false,
      configPath,
      message: `Config already exists at ${configPath}. Use --force to overwrite.`,
    }
  }

  // Resolve router + models. If the user passed --router, honor it as their
  // explicit choice (single probe). Otherwise sweep the well-known local
  // OpenAI-compatible endpoints and pick the first responder.
  let routerUrl: string
  let detectedModels: string[]
  let routerLabel: string | undefined

  if (options.routerUrl) {
    routerUrl = options.routerUrl
    detectedModels = await detectRouterModels(routerUrl)
  } else {
    const probe = await probeDefaultRouters()
    routerUrl = probe.routerUrl
    detectedModels = probe.models
    routerLabel = probe.models.length > 0 ? probe.routerLabel : undefined
  }

  // Build config
  const config = buildConfigFromModels(detectedModels, routerUrl, port)

  // Ensure parent directory exists so first-run with a fresh OWLCODA_HOME
  // (or ~/.owlcoda/ missing on a clean system) doesn't ENOENT here.
  const parentDir = dirname(configPath)
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true })
  }

  // Write config
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')

  const modelMsg = detectedModels.length > 0
    ? `Auto-detected ${detectedModels.length} model(s)${routerLabel ? ` from ${routerLabel}` : ' from router'} (${routerUrl})`
    : `No local backend reachable. Wrote placeholder config pointing at ${routerUrl}. Edit config.json to set your models, or rerun with --router <url>.`

  return {
    created: true,
    configPath,
    message: `Created ${configPath}\n${modelMsg}`,
    modelsDetected: detectedModels.length > 0 ? detectedModels : undefined,
  }
}

export function formatInitResult(result: InitResult): string {
  const lines: string[] = []

  if (result.created) {
    lines.push(`✅ ${result.message}`)
    lines.push('')
    lines.push('Next steps:')
    if (!result.modelsDetected) {
      lines.push('  1. Edit config.json — set your model IDs and router URL')
    }
    lines.push(`  ${result.modelsDetected ? '1' : '2'}. Run: owlcoda doctor   — verify your environment`)
    lines.push(`  ${result.modelsDetected ? '2' : '3'}. Run: owlcoda          — start using OwlCoda`)
    lines.push('')
    lines.push('OwlCoda native mode is ready:')
    lines.push('  · 42+ tools available — run /tools to see them')
    lines.push('  · /skills to discover coding skills')
    lines.push('  · /model to switch between local and cloud models')
    lines.push('  · /dashboard for system health monitoring')
    lines.push('  · /why-native to see what makes OwlCoda different')
    lines.push('')
    lines.push('Privacy:')
    lines.push('  · Training-data collection is OFF by default. Sessions stay local-only.')
    lines.push('  · To opt in: set "trainingCollection": true in config.json,')
    lines.push('    or run with OWLCODA_TRAINING_COLLECTION=1. Collected data')
    lines.push('    is PII-sanitized and stays in ~/.owlcoda/training/.')
  } else {
    lines.push(`⚠️  ${result.message}`)
  }

  return lines.join('\n')
}
