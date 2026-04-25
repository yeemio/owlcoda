/**
 * LM Studio backend adapter.
 *
 * LM Studio exposes an OpenAI-compatible API:
 *   - GET /v1/models — list loaded models
 *   - POST /v1/chat/completions — chat completions
 *
 * Default port: 1234
 */

import { get as httpGet } from 'node:http'
import type { BackendAdapter, DiscoveredModel, BackendType } from './types.js'

export class LMStudioAdapter implements BackendAdapter {
  readonly name: BackendType = 'lmstudio'
  readonly defaultPort = 1234
  readonly baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? `http://127.0.0.1:${this.defaultPort}`).replace(/\/+$/, '')
  }

  async isReachable(timeoutMs = 3000): Promise<boolean> {
    return httpProbe(`${this.baseUrl}/v1/models`, timeoutMs)
  }

  async discover(timeoutMs = 5000): Promise<DiscoveredModel[]> {
    const data = await httpGetJson(`${this.baseUrl}/v1/models`, timeoutMs)
    if (!data || !Array.isArray(data.data)) return []

    return data.data.map((m: LMStudioModel) => ({
      id: m.id,
      label: formatLMStudioLabel(m.id),
      backend: 'lmstudio' as BackendType,
      baseUrl: this.baseUrl,
      quantization: extractQuantization(m.id),
      parameterSize: extractParamSize(m.id),
      contextWindow: undefined,
    }))
  }

  chatCompletionsUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`
  }

  headers(): Record<string, string> {
    return { 'Content-Type': 'application/json' }
  }
}

// ─── LM Studio types ───

interface LMStudioModel {
  id: string
  object: string
  owned_by?: string
}

// ─── Helpers ───

function formatLMStudioLabel(id: string): string {
  // LM Studio model IDs are often paths like "user/model-name-GGUF"
  const parts = id.split('/')
  const modelPart = parts[parts.length - 1] ?? id
  return modelPart.replace(/-GGUF$/i, '').replace(/_/g, ' ')
}

function extractQuantization(id: string): string | undefined {
  const match = id.match(/[_-](Q\d[_\w]*)/i)
  return match?.[1]
}

function extractParamSize(id: string): string | undefined {
  const match = id.match(/(\d+\.?\d*)[Bb]/)
  return match ? `${match[1]}B` : undefined
}

function httpProbe(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = httpGet(url, res => {
      res.resume()
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
