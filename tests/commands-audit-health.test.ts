import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsSource = readFileSync(join(__dirname, '..', 'src', 'frontend', 'commands.ts'), 'utf-8')

describe('/audit command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/audit'")
  })

  it('calls readAuditLog', () => {
    expect(commandsSource).toContain('readAuditLog')
  })

  it('shows audit log header', () => {
    expect(commandsSource).toContain('Audit Log')
  })
})

describe('/health command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/health'")
  })

  it('shows model health header', () => {
    expect(commandsSource).toContain('Model Health')
  })

  it('shows circuit breaker state', () => {
    expect(commandsSource).toContain('circuit:')
  })
})
