import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { prepareProfileAt } from '../src/runtime-profile.js'
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DIR = join(import.meta.dirname, '_fixtures_profile')

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('prepareProfileAt', () => {
  it('creates profile directory', () => {
    const profileDir = join(TEST_DIR, 'profile-1')
    prepareProfileAt(profileDir, 'owlcoda-local-key-8019')
    expect(existsSync(profileDir)).toBe(true)
  })

  it('writes settings.json with customApiKeyResponses', () => {
    const profileDir = join(TEST_DIR, 'profile-2')
    prepareProfileAt(profileDir, 'owlcoda-local-key-8019')

    const settingsPath = join(profileDir, 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(settings.customApiKeyResponses).toBeDefined()
    expect(settings.customApiKeyResponses.approved).toContain('lcoda-local-key-8019')
    expect(settings.customApiKeyResponses.rejected).toEqual([])
  })

  it('creates settings.local.json', () => {
    const profileDir = join(TEST_DIR, 'profile-3')
    prepareProfileAt(profileDir, 'test-key-12345')

    const localPath = join(profileDir, 'settings.local.json')
    expect(existsSync(localPath)).toBe(true)
  })

  it('stores last 20 chars of API key as approval', () => {
    const profileDir = join(TEST_DIR, 'profile-4')
    const longKey = 'sk-ant-this-is-a-very-long-api-key-12345678901234567890'
    prepareProfileAt(profileDir, longKey)

    const settings = JSON.parse(readFileSync(join(profileDir, 'settings.json'), 'utf-8'))
    const expected = longKey.slice(-20)
    expect(settings.customApiKeyResponses.approved).toContain(expected)
  })

  it('is idempotent — does not duplicate approval entries', () => {
    const profileDir = join(TEST_DIR, 'profile-5')
    const key = 'owlcoda-local-key-8019'

    prepareProfileAt(profileDir, key)
    prepareProfileAt(profileDir, key)
    prepareProfileAt(profileDir, key)

    const settings = JSON.parse(readFileSync(join(profileDir, 'settings.json'), 'utf-8'))
    const matches = settings.customApiKeyResponses.approved.filter((k: string) => k === key.slice(-20))
    expect(matches).toHaveLength(1)
  })

  it('preserves existing settings when re-running', () => {
    const profileDir = join(TEST_DIR, 'profile-6')
    const { profileDir: dir } = prepareProfileAt(profileDir, 'key-one-1234567890ab')

    // Manually add extra setting
    const settingsPath = join(dir, 'settings.json')
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    settings.customSetting = 'keepme'
    writeFileSync(settingsPath, JSON.stringify(settings), 'utf-8')

    // Re-run with different key
    prepareProfileAt(profileDir, 'key-two-abcdef1234567890')

    const updated = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(updated.customSetting).toBe('keepme')
    expect(updated.customApiKeyResponses.approved).toHaveLength(2)
  })

  it('does not touch any third-party profile directory', () => {
    const profileDir = join(TEST_DIR, 'profile-7')
    const result = prepareProfileAt(profileDir, 'test-key')
    expect(result.profileDir).toBe(profileDir)
    expect(result.profileDir).not.toContain('/.config/')
  })

  it('writes profile.json for workspace trust state', () => {
    const profileDir = join(TEST_DIR, 'profile-8')
    prepareProfileAt(profileDir, 'test-key')
    expect(existsSync(join(profileDir, 'profile.json'))).toBe(true)
  })
})
