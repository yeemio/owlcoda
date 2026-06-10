/**
 * Ollama backend adapter.
 *
 * Ollama exposes:
 *   - GET /api/tags — list loaded models
 *   - POST /v1/chat/completions — OpenAI-compatible chat (since v0.1.14)
 *   - GET /api/version — version check
 *
 * Default port: 11434
 */

import { get as httpGet } from 'node:http'
import type { BackendAdapter, DiscoveredModel, BackendType } from './types.js'

export class OllamaAdapter implements BackendAdapter {
  readonly name: BackendType = 'ollama'
  readonly defaultPort = 11434
  readonly baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? `http://127.0.0.1:${this.defaultPort}`).replace(/\/+$/, '')
  }

  async isReachable(timeoutMs = 3000): Promise<boolean> {
    return httpProbe(`${this.baseUrl}/api/version`, timeoutMs)
  }

  async discover(timeoutMs = 5000): Promise<DiscoveredModel[]> {
    const data = await httpGetJson(`${this.baseUrl}/api/tags`, timeoutMs)
    if (!data || !Array.isArray(data.models)) return []

    return data.models.map((m: OllamaModel) => ({
      id: m.name,
      label: formatOllamaLabel(m),
      backend: 'ollama' as BackendType,
      baseUrl: this.baseUrl,
      quantization: m.details?.quantization_level,
      parameterSize: m.details?.parameter_size,
      contextWindow: undefined, // Ollama doesn't expose this in /api/tags
    }))
  }

  chatCompletionsUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`
  }

  headers(): Record<string, string> {
    return { 'Content-Type': 'application/json' }
  }
}

// ─── Ollama-specific types ───

interface OllamaModel {
  name: string
  model: string
  modified_at: string
  size: number
  digest: string
  details?: {
    parent_model?: string
    format?: string
    family?: string
    families?: string[]
    parameter_size?: string
    quantization_level?: string
  }
}

// ─── Helpers ───

function formatOllamaLabel(m: OllamaModel): string {
  const base = m.name.split(':')[0] ?? m.name
  const parts = [base]
  if (m.details?.parameter_size) parts.push(m.details.parameter_size)
  if (m.details?.quantization_level) parts.push(m.details.quantization_level)
  return parts.join(' ')
}

function httpProbe(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpGet(url, res => {
      res.resume() // drain
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false) })
  })
}

function httpGetJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise(resolve => {
    const req = httpGet(url, res => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('error', () => resolve(null))
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null) })
  })
}
