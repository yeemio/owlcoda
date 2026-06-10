import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsSource = readFileSync(join(__dirname, '..', 'src', 'frontend', 'commands.ts'), 'utf-8')

describe('/reset-circuits command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/reset-circuits'")
  })

  it('imports resetCircuitBreaker', () => {
    expect(commandsSource).toContain('resetCircuitBreaker')
  })

  it('calls resetCircuitBreaker()', () => {
    expect(commandsSource).toContain('resetCircuitBreaker()')
  })

  it('has description', () => {
    expect(commandsSource).toContain('Reset all circuit breakers')
  })
})

describe('/reset-budgets command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/reset-budgets'")
  })

  it('imports resetBudgets', () => {
    expect(commandsSource).toContain('resetBudgets')
  })

  it('calls resetBudgets()', () => {
    expect(commandsSource).toContain('resetBudgets()')
  })

  it('has description', () => {
    expect(commandsSource).toContain('Reset all error budget')
  })
})
