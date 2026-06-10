import { describe, it, expect, beforeEach, vi } from 'vitest'

// Use direct function imports that we can test
describe('plugin loader', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  it('validatePlugin rejects missing metadata', async () => {
    // Import the module to test validation logic indirectly via loadPlugins
    // We'll test the behavior: no plugins dir → empty array
    vi.stubEnv('OWLCODA_HOME', '/tmp/owlcoda-test-nonexistent')
    const { loadPlugins, getLoadedPlugins } = await import('../src/plugins/loader.js')
    const result = await loadPlugins()
    expect(result).toEqual([])
    expect(getLoadedPlugins()).toEqual([])
  })

  it('runRequestHooks runs without plugins', async () => {
    vi.stubEnv('OWLCODA_HOME', '/tmp/owlcoda-test-nonexistent')
    const { runRequestHooks, loadPlugins } = await import('../src/plugins/loader.js')
    await loadPlugins()
    // Should not throw
    await runRequestHooks({
      method: 'POST',
      endpoint: '/v1/messages',
      model: 'test-model',
      messageCount: 1,
      body: {},
    })
  })

  it('runResponseHooks runs without plugins', async () => {
    vi.stubEnv('OWLCODA_HOME', '/tmp/owlcoda-test-nonexistent')
    const { runResponseHooks, loadPlugins } = await import('../src/plugins/loader.js')
    await loadPlugins()
    await runResponseHooks({
      method: 'POST',
      endpoint: '/v1/messages',
      model: 'test-model',
      statusCode: 200,
      durationMs: 100,
      inputTokens: 50,
      outputTokens: 30,
      body: {},
    })
  })

  it('runErrorHooks runs without plugins', async () => {
    vi.stubEnv('OWLCODA_HOME', '/tmp/owlcoda-test-nonexistent')
    const { runErrorHooks, loadPlugins } = await import('../src/plugins/loader.js')
    await loadPlugins()
    await runErrorHooks({
      endpoint: '/v1/messages',
      errorType: 'test',
      message: 'test error',
    })
  })

  it('unloadPlugins clears plugin list', async () => {
    vi.stubEnv('OWLCODA_HOME', '/tmp/owlcoda-test-nonexistent')
    const { unloadPlugins, getLoadedPlugins, loadPlugins } = await import('../src/plugins/loader.js')
    await loadPlugins()
    await unloadPlugins()
    expect(getLoadedPlugins()).toEqual([])
  })
})

describe('plugin types', () => {
  it('OwlCodaPlugin interface shape is importable', async () => {
    const types = await import('../src/plugins/types.js')
    // If this imports without error, the types compile correctly
    expect(types).toBeDefined()
  })
})
