import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SLASH_COMMANDS } from '../../src/native/slash-commands.js'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', '..', 'src', 'native', 'slash-commands.ts'), 'utf-8')
const handled = new Set([...source.matchAll(/case\s+'(\/[a-z-]+)'/g)].map((m) => m[1]!))

// Commands intentionally handled but kept out of completion/help. Empty by design;
// adding entries here is a conscious choice, not a silent escape hatch.
const HIDDEN_ALLOWLIST = new Set<string>([])

describe('slash-command completeness', () => {
  it('every declared command has a dispatch case', () => {
    const missing = SLASH_COMMANDS.filter((c) => !handled.has(c))
    expect(missing).toEqual([])
  })

  it('every dispatch case is declared (or explicitly hidden)', () => {
    const declared = new Set(SLASH_COMMANDS)
    const undeclared = [...handled].filter((c) => !declared.has(c) && !HIDDEN_ALLOWLIST.has(c))
    expect(undeclared).toEqual([])
  })

  it('no command handler is a "not yet available" stub', () => {
    expect(source).not.toContain('not yet available in native mode')
    expect(source.toLowerCase()).not.toContain('coming soon')
  })
})
