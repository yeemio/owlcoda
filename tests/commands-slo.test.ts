import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsSource = readFileSync(join(__dirname, '..', 'src', 'frontend', 'commands.ts'), 'utf-8')

describe('/slo command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/slo'")
  })

  it('imports getAllBudgets', () => {
    expect(commandsSource).toContain('getAllBudgets')
  })

  it('shows SLO target', () => {
    expect(commandsSource).toContain('SLO target')
  })

  it('shows Error Budget header', () => {
    expect(commandsSource).toContain('Error Budget')
  })
})
