import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsSource = readFileSync(join(__dirname, '..', 'src', 'frontend', 'commands.ts'), 'utf-8')

describe('/metrics command', () => {
  it('is registered in COMMANDS', () => {
    expect(commandsSource).toContain("'/metrics'")
  })

  it('imports renderMetrics', () => {
    expect(commandsSource).toContain('renderMetrics')
  })

  it('calls renderMetrics()', () => {
    expect(commandsSource).toContain('renderMetrics()')
  })

  it('has description', () => {
    expect(commandsSource).toContain('Prometheus')
  })
})
