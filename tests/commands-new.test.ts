import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsSource = readFileSync(join(__dirname, '..', 'src', 'frontend', 'commands.ts'), 'utf-8')

describe('/cost command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/cost'")
  })

  it('calls getTokenUsage', () => {
    expect(commandsSource).toContain('getTokenUsage()')
  })

  it('shows token breakdown keywords', () => {
    expect(commandsSource).toContain('Input tokens')
    expect(commandsSource).toContain('Output tokens')
    expect(commandsSource).toContain('Total tokens')
  })
})

describe('/dashboard command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/dashboard'")
  })

  it('calls getMetrics', () => {
    expect(commandsSource).toContain('getMetrics()')
  })

  it('shows uptime and requests', () => {
    expect(commandsSource).toContain('Uptime')
    expect(commandsSource).toContain('Total requests')
    expect(commandsSource).toContain('Active requests')
  })
})

describe('/ratelimit command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/ratelimit'")
  })

  it('calls getRateLimitStats', () => {
    expect(commandsSource).toContain('getRateLimitStats()')
  })

  it('shows remaining/total format', () => {
    expect(commandsSource).toContain('remaining')
  })
})
