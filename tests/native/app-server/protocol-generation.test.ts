import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

describe('App Server generated contract artifacts', () => {
  it('keeps the generated TypeScript client and JSON Schema in sync with the protocol contract', () => {
    const result = spawnSync('npm', ['run', 'app-server:contract:check'], {
      cwd: resolve(import.meta.dirname, '../../..'),
      encoding: 'utf8',
    })

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    const clientPath = resolve(import.meta.dirname, '../../../src/native/app-server/generated/client.ts')
    const schemaPath = resolve(import.meta.dirname, '../../../src/native/app-server/generated/protocol.schema.json')
    expect(existsSync(clientPath)).toBe(true)
    expect(existsSync(schemaPath)).toBe(true)
    expect(readFileSync(clientPath, 'utf8')).toContain("'thread/read'")
    expect(JSON.parse(readFileSync(schemaPath, 'utf8')).properties.method.enum).toContain('event/snapshot')
  })
})
