import { describe, it, expect } from 'vitest'
import { isConfigWatching } from '../src/config-watcher.js'

describe('config-watcher', () => {
  it('starts in non-watching state', () => {
    expect(isConfigWatching()).toBe(false)
  })

  it('module exports expected functions', async () => {
    const mod = await import('../src/config-watcher.js')
    expect(typeof mod.startConfigWatcher).toBe('function')
    expect(typeof mod.stopConfigWatcher).toBe('function')
    expect(typeof mod.isConfigWatching).toBe('function')
  })
})
