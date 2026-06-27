/**
 * detectRouterModels — Issue #2 dogfood: `owlcoda init` auto-detect must probe
 * the OpenAI-compatible visibility layer without doubling `/v1`, even when the
 * candidate / user `--endpoint` already carries a trailing `/v1`.
 */
import { describe, it, expect } from 'vitest'
import { detectRouterModels } from '../src/init.js'

describe('detectRouterModels', () => {
  it('probes the bare base + /v1/openai/models when input already ends in /v1', async () => {
    const calls: string[] = []
    const fetchJson = async (url: string) => {
      calls.push(url)
      return { data: [{ id: 'gemma3:1b' }, { id: 'qwen2.5:7b' }] }
    }
    const models = await detectRouterModels('http://127.0.0.1:11434/v1', fetchJson)
    expect(calls).toEqual(['http://127.0.0.1:11434/v1/openai/models'])
    expect(models).toEqual(['gemma3:1b', 'qwen2.5:7b'])
  })

  it('falls back to /v1/models for a clean bare base', async () => {
    const calls: string[] = []
    const fetchJson = async (url: string) => {
      calls.push(url)
      if (url.endsWith('/v1/openai/models')) throw new Error('not found')
      return { data: [] }
    }
    await detectRouterModels('http://127.0.0.1:11434', fetchJson)
    expect(calls).toEqual([
      'http://127.0.0.1:11434/v1/openai/models',
      'http://127.0.0.1:11434/v1/models',
    ])
  })

  it('uses owlmlx formal visibility when available', async () => {
    const calls: string[] = []
    const fetchJson = async (url: string) => {
      calls.push(url)
      return { data: [{ id: 'Qwen3.6-27B' }] }
    }
    const models = await detectRouterModels('http://127.0.0.1:8066', fetchJson)
    expect(calls).toEqual(['http://127.0.0.1:8066/v1/openai/models'])
    expect(models).toEqual(['Qwen3.6-27B'])
  })

  it('returns [] when the runtime is unreachable (fetcher throws)', async () => {
    const fetchJson = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await detectRouterModels('http://127.0.0.1:11434', fetchJson)).toEqual([])
  })
})
