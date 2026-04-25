import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { loadPermissions, savePermissions, addGlobalPermission, removeGlobalPermission, clearGlobalPermissions } from '../../src/native/permissions.js'
import { existsSync, unlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Mock getOwlcodaDir to use a temp directory
vi.mock('../../src/paths.js', () => ({
  getOwlcodaDir: () => '/tmp/owlcoda-test-perms',
  getOwlcodaDirLabel: () => '~/.owlcoda-test',
}))

import { mkdirSync, rmSync } from 'node:fs'

const TEST_DIR = '/tmp/owlcoda-test-perms'
const PERMS_FILE = join(TEST_DIR, 'permissions.json')

describe('Persistent Permissions', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true })
    if (existsSync(PERMS_FILE)) unlinkSync(PERMS_FILE)
  })

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true })
  })

  it('loadPermissions returns empty set when no file', () => {
    const perms = loadPermissions()
    expect(perms.size).toBe(0)
  })

  it('savePermissions and loadPermissions round-trip', () => {
    savePermissions(new Set(['bash', 'edit', 'write']))
    const loaded = loadPermissions()
    expect(loaded.size).toBe(3)
    expect(loaded.has('bash')).toBe(true)
    expect(loaded.has('edit')).toBe(true)
    expect(loaded.has('write')).toBe(true)
  })

  it('addGlobalPermission adds incrementally', () => {
    addGlobalPermission('bash')
    addGlobalPermission('edit')
    const perms = loadPermissions()
    expect(perms.size).toBe(2)
    expect(perms.has('bash')).toBe(true)
    expect(perms.has('edit')).toBe(true)
  })

  it('removeGlobalPermission removes and returns true', () => {
    addGlobalPermission('bash')
    addGlobalPermission('edit')
    const removed = removeGlobalPermission('bash')
    expect(removed).toBe(true)
    const perms = loadPermissions()
    expect(perms.size).toBe(1)
    expect(perms.has('bash')).toBe(false)
  })

  it('removeGlobalPermission returns false for missing', () => {
    const removed = removeGlobalPermission('nonexistent')
    expect(removed).toBe(false)
  })

  it('clearGlobalPermissions empties the file', () => {
    addGlobalPermission('bash')
    addGlobalPermission('edit')
    clearGlobalPermissions()
    const perms = loadPermissions()
    expect(perms.size).toBe(0)
  })

  it('permissions file is sorted JSON', () => {
    addGlobalPermission('write')
    addGlobalPermission('bash')
    addGlobalPermission('edit')
    const raw = JSON.parse(readFileSync(PERMS_FILE, 'utf-8'))
    expect(raw.globalApprove).toEqual(['bash', 'edit', 'write'])
  })
})
