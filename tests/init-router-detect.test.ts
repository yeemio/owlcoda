/**
 * detectRouterModels — Issue #2 dogfood: `owlcoda init` auto-detect must probe
 * the OpenAI-compatible `/v1/models` exactly once, even when the candidate /
 * user `--endpoint` already carries a trailing `/v1`. The bundled
 * DEFAULT_ROUTER_CANDIDATES historically shipped `…:11434/v1`, so the probe hit
 * `/v1/v1/models` and silently found nothing on every fresh local install.
 */
import { describe, it, expect } from 'vitest'
import { detectRouterModels } from '../src/init.js'

describe('detectRouterModels', () => {
  it('probes the bare base + /v1/models when input already ends in /v1', async () => {
    const calls: string[] = []
    const fetchJson = async (url: string) => {
      calls.push(url)
      return { data: [{ id: 'gemma3:1b' }, { id: 'qwen2.5:7b' }] }
    }
    const models = await detectRouterModels('http://127.0.0.1:11434/v1', fetchJson)
    expect(calls).toEqual(['http://127.0.0.1:11434/v1/models'])
    expect(models).toEqual(['gemma3:1b', 'qwen2.5:7b'])
  })

  it('probes /v1/models for a clean bare base', async () => {
    const calls: string[] = []
    const fetchJson = async (url: string) => {
      calls.push(url)
      return { data: [] }
    }
    await detectRouterModels('http://127.0.0.1:11434', fetchJson)
    expect(calls).toEqual(['http://127.0.0.1:11434/v1/models'])
  })

  it('returns [] when the runtime is unreachable (fetcher throws)', async () => {
    const fetchJson = async () => {
      throw new Error('ECONNREFUSED')
    }
    expect(await detectRouterModels('http://127.0.0.1:11434', fetchJson)).toEqual([])
  })
})
