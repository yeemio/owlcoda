import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLASH_COMMANDS } from '../../src/native/slash-commands.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', '..', 'src', 'native', 'slash-commands.ts'), 'utf-8')

describe('/copy registration', () => {
  it('is declared in SLASH_COMMANDS', () => {
    expect(SLASH_COMMANDS).toContain('/copy')
  })
  it('is advertised in the help text', () => {
    expect(source).toMatch(/\/copy\s+Copy last assistant response to clipboard/)
  })
})
