/**
 * vLLM backend adapter.
 *
 * vLLM exposes an OpenAI-compatible API:
 *   - GET /v1/models — list served models
 *   - POST /v1/chat/completions — chat completions
 *   - GET /health — health check
 *
 * Default port: 8000
 */

import { get as httpGet } from 'node:http'
import type { BackendAdapter, DiscoveredModel, BackendType } from './types.js'

export class VLLMAdapter implements BackendAdapter {
  readonly name: BackendType = 'vllm'
  readonly defaultPort = 8000
  readonly baseUrl: string

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? `http://127.0.0.1:${this.defaultPort}`).replace(/\/+$/, '')
  }

  async isReachable(timeoutMs = 3000): Promise<boolean> {
    return httpProbe(`${this.baseUrl}/health`, timeoutMs)
  }

  async discover(timeoutMs = 5000): Promise<DiscoveredModel[]> {
    const data = await httpGetJson(`${this.baseUrl}/v1/models`, timeoutMs)
    if (!data || !Array.isArray(data.data)) return []

    return data.data.map((m: VLLMModel) => ({
      id: m.id,
      label: formatVLLMLabel(m.id),
      backend: 'vllm' as BackendType,
      baseUrl: this.baseUrl,
      quantization: undefined,
      parameterSize: extractParamSize(m.id),
      contextWindow: m.max_model_len,
    }))
  }

  chatCompletionsUrl(): string {
    return `${this.baseUrl}/v1/chat/completions`
  }

  headers(): Record<string, string> {
    return { 'Content-Type': 'application/json' }
  }
}

// ─── vLLM types ───

interface VLLMModel {
  id: string
  object: string
  owned_by?: string
  max_model_len?: number
}

// ─── Helpers ───

function formatVLLMLabel(id: string): string {
  // vLLM model IDs are usually HuggingFace paths like "Qwen/Qwen2.5-72B-Instruct"
  const parts = id.split('/')
  return parts[parts.length - 1] ?? id
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
