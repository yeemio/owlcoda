import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsSource = readFileSync(join(__dirname, '..', 'src', 'frontend', 'commands.ts'), 'utf-8')

describe('/traces command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/traces'")
  })

  it('imports getRecentTraces', () => {
    expect(commandsSource).toContain('getRecentTraces')
  })

  it('shows Recent Traces header', () => {
    expect(commandsSource).toContain('Recent Traces')
  })
})
