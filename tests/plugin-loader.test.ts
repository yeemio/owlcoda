/**
 * Plugin loader edge tests — loading from temp dir, hook execution, validation.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string
let pluginDir: string

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-plugin-test-'))
  pluginDir = join(tempDir, 'plugins')
  await mkdir(pluginDir, { recursive: true })
  vi.stubEnv('OWLCODA_HOME', tempDir)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await rm(tempDir, { recursive: true, force: true }).catch(() => {})
})

describe('plugin loader', () => {
  it('returns empty array when plugins dir is empty', async () => {
    const { loadPlugins } = await import('../src/plugins/loader.js')
    const result = await loadPlugins()
    expect(result).toEqual([])
  })

  it('loads a valid plugin with hooks', async () => {
    // Create a plugin directory with index.js
    const testPluginDir = join(pluginDir, 'test-plugin')
    await mkdir(testPluginDir, { recursive: true })
    await writeFile(join(testPluginDir, 'index.js'), `
      module.exports = {
        metadata: { name: 'test-plugin', version: '1.0.0', description: 'Test' },
        onRequest: async (ctx) => { /* noop */ },
      };
    `)

    const { loadPlugins, getLoadedPlugins } = await import('../src/plugins/loader.js')
    const plugins = await loadPlugins()
    expect(plugins.length).toBeGreaterThanOrEqual(1)
    const testPlugin = plugins.find(p => p.plugin.metadata.name === 'test-plugin')
    expect(testPlugin).toBeDefined()
    expect(testPlugin!.hookCount).toBe(1)
    expect(getLoadedPlugins().length).toBeGreaterThanOrEqual(1)
  })

  it('runs request hooks without error', async () => {
    const { loadPlugins, runRequestHooks } = await import('../src/plugins/loader.js')
    await loadPlugins()
    // Should not throw
    await runRequestHooks({
      method: 'POST',
      endpoint: '/v1/messages',
      model: 'test',
      messageCount: 1,
      body: {},
    })
  })

  it('runs response hooks without error', async () => {
    const { loadPlugins, runResponseHooks } = await import('../src/plugins/loader.js')
    await loadPlugins()
    await runResponseHooks({
      method: 'POST',
      endpoint: '/v1/messages',
      model: 'test',
      statusCode: 200,
      durationMs: 100,
      inputTokens: 10,
      outputTokens: 20,
    })
  })

  it('runs error hooks without error', async () => {
    const { loadPlugins, runErrorHooks } = await import('../src/plugins/loader.js')
    await loadPlugins()
    await runErrorHooks({
      error: new Error('test error'),
      endpoint: '/v1/messages',
      model: 'test',
    })
  })

  it('unloadPlugins clears loaded plugins', async () => {
    const { loadPlugins, unloadPlugins, getLoadedPlugins } = await import('../src/plugins/loader.js')
    await loadPlugins()
    expect(getLoadedPlugins().length).toBeGreaterThanOrEqual(0)
    await unloadPlugins()
    expect(getLoadedPlugins()).toEqual([])
  })

  it('skips files that are not directories in plugins dir', async () => {
    await writeFile(join(pluginDir, 'not-a-dir.txt'), 'just a file')
    const { loadPlugins } = await import('../src/plugins/loader.js')
    // Should not crash
    const result = await loadPlugins()
    // The result should contain our test-plugin but not not-a-dir.txt
    const names = result.map(p => p.plugin.metadata.name)
    expect(names).not.toContain('not-a-dir.txt')
  })

  it('skips plugin directories without index.js', async () => {
    const emptyPluginDir = join(pluginDir, 'empty-plugin')
    await mkdir(emptyPluginDir, { recursive: true })
    await writeFile(join(emptyPluginDir, 'readme.md'), '# empty')
    const { loadPlugins } = await import('../src/plugins/loader.js')
    const result = await loadPlugins()
    const names = result.map(p => p.plugin.metadata.name)
    expect(names).not.toContain('empty-plugin')
  })
})
