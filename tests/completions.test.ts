import { describe, it, expect } from 'vitest'
import { generateBashCompletion, generateZshCompletion, generateFishCompletion, generateCompletion } from '../src/completions.js'

describe('shell completions', () => {
  it('bash completion includes commands and flags', () => {
    const output = generateBashCompletion()
    expect(output).toContain('_owlcoda_completions')
    expect(output).toContain('complete -F')
    expect(output).toContain('doctor')
    expect(output).toContain('ui')
    expect(output).toContain('admin')
    expect(output).toContain('clients')
    expect(output).toContain('init')
    expect(output).toContain('--daemon-only')
    expect(output).toContain('--print-url')
    expect(output).toContain('--open-browser')
    expect(output).toContain('--dry-run')
  })

  it('zsh completion includes descriptions', () => {
    const output = generateZshCompletion()
    expect(output).toContain('#compdef owlcoda')
    expect(output).toContain('doctor:Diagnose environment')
    expect(output).toContain('ui:Print browser admin URL')
    expect(output).toContain('admin:Alias for ui')
    expect(output).toContain('clients:List or detach live REPL clients')
    expect(output).toContain('init:Create config.json')
    expect(output).toContain("'--print-url[Print the admin URL without opening a browser]'")
    expect(output).toContain("'--open-browser[Launch the admin URL in your browser]'")
    expect(output).toContain("'--daemon-only[Proxy daemon only]'")
  })

  it('fish completion includes all commands', () => {
    const output = generateFishCompletion()
    expect(output).toContain('complete -c owlcoda')
    expect(output).toContain("'doctor'")
    expect(output).toContain("'ui'")
    expect(output).toContain("'admin'")
    expect(output).toContain("'clients'")
    expect(output).toContain("'init'")
    expect(output).toContain("'logs'")
    expect(output).toContain("'print-url'")
    expect(output).toContain("'open-browser'")
    expect(output).toContain("'route'")
    expect(output).toContain("'select'")
    expect(output).toContain("'view'")
    expect(output).toContain("'daemon-only'")
    expect(output).toContain("'dry-run'")
  })

  it('generateCompletion dispatches correctly', () => {
    expect(generateCompletion('bash')).toContain('_owlcoda_completions')
    expect(generateCompletion('zsh')).toContain('#compdef')
    expect(generateCompletion('fish')).toContain('complete -c owlcoda')
  })

  it('completions command is wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'completions', 'bash'])
    expect(result.command).toBe('completions')
    expect(result.passthroughArgs).toContain('bash')
  })

  it('ui command and print-url/open-browser flags are wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'admin', '--print-url', '--open-browser'])
    expect(result.command).toBe('ui')
    expect(result.printUrl).toBe(true)
    expect(result.openBrowser).toBe(true)
  })

  it('ui route/select/view flags are wired into parseArgs', async () => {
    const { parseArgs } = await import('../src/cli-core.js')
    const result = parseArgs(['node', 'owlcoda', 'ui', '--route', 'catalog', '--select', 'foo', '--view', 'issues'])
    expect(result.command).toBe('ui')
    expect(result.route).toBe('catalog')
    expect(result.select).toBe('foo')
    expect(result.view).toBe('issues')
  })
})
