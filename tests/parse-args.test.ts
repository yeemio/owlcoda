/**
 * CLI parseArgs unit tests — argument parsing without side effects.
 */
import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/cli-core.js'

// parseArgs expects argv from index 2 (like process.argv)
function parse(...args: string[]) {
  return parseArgs(['node', 'owlcoda', ...args])
}

describe('parseArgs', () => {
  it('defaults to launch command', () => {
    expect(parse().command).toBe('launch')
  })

  it('parses start command', () => {
    expect(parse('start').command).toBe('start')
  })

  it('parses stop command', () => {
    expect(parse('stop').command).toBe('stop')
  })

  it('parses status command', () => {
    expect(parse('status').command).toBe('status')
  })

  it('parses clients command', () => {
    expect(parse('clients').command).toBe('clients')
  })

  it('parses serve command', () => {
    expect(parse('serve').command).toBe('serve')
  })

  it('parses run command', () => {
    expect(parse('run').command).toBe('run')
  })

  it('parses ui command', () => {
    expect(parse('ui').command).toBe('ui')
  })

  it('parses admin alias as ui command', () => {
    expect(parse('admin').command).toBe('ui')
  })

  it('parses server command', () => {
    expect(parse('server').command).toBe('server')
  })

  it('parses --help flag', () => {
    expect(parse('--help').command).toBe('help')
  })

  it('parses -h flag', () => {
    expect(parse('-h').command).toBe('help')
  })

  it('parses --version flag', () => {
    expect(parse('--version').command).toBe('version')
  })

  it('parses -v flag', () => {
    expect(parse('-v').command).toBe('version')
  })

  it('parses --port', () => {
    expect(parse('--port', '9000').port).toBe(9000)
  })

  it('parses --config / -c', () => {
    expect(parse('--config', '/path/to/config.json').configPath).toBe('/path/to/config.json')
    expect(parse('-c', '/other.json').configPath).toBe('/other.json')
  })

  it('parses --router / -r', () => {
    expect(parse('--router', 'http://localhost:8009').routerUrl).toBe('http://localhost:8009')
    expect(parse('-r', 'http://x').routerUrl).toBe('http://x')
  })

  it('parses --model / -m', () => {
    expect(parse('--model', 'gpt-4').model).toBe('gpt-4')
    expect(parse('-m', 'llama').model).toBe('llama')
  })

  it('parses --daemon-only flag', () => {
    expect(parse('--daemon-only').daemonOnly).toBe(true)
  })

  it('parses --prompt', () => {
    expect(parse('--prompt', 'hello world').prompt).toBe('hello world')
  })

  it('parses --json flag', () => {
    expect(parse('--json').jsonOutput).toBe(true)
  })

  it('parses --auto-approve flag', () => {
    expect(parse('--auto-approve').autoApprove).toBe(true)
  })

  it('parses --resume with explicit session id', () => {
    expect(parse('--resume', '20260401-abc123').resumeSession).toBe('20260401-abc123')
  })

  it('parses --resume without value defaults to last', () => {
    // When --resume is last arg, args[++i] is undefined → falls back to 'last'
    expect(parse('--resume').resumeSession).toBe('last')
  })

  it('collects unknown args as passthroughArgs', () => {
    const result = parse('--unknown-flag', 'some-value')
    expect(result.passthroughArgs).toContain('--unknown-flag')
    expect(result.passthroughArgs).toContain('some-value')
  })

  it('passes args after -- as passthroughArgs', () => {
    const result = parse('start', '--', '--some-owl-flag', 'value')
    expect(result.command).toBe('start')
    expect(result.passthroughArgs).toContain('--some-owl-flag')
    expect(result.passthroughArgs).toContain('value')
  })

  it('combines multiple flags', () => {
    const result = parse('serve', '--port', '9001', '--router', 'http://r', '--daemon-only')
    expect(result.command).toBe('serve')
    expect(result.port).toBe(9001)
    expect(result.routerUrl).toBe('http://r')
    expect(result.daemonOnly).toBe(true)
  })

  it('parses logs command', () => {
    expect(parse('logs').command).toBe('logs')
  })

  it('parses config command', () => {
    expect(parse('config').command).toBe('config')
  })

  it('parses doctor command', () => {
    expect(parse('doctor').command).toBe('doctor')
  })

  it('passes clients subcommand args through', () => {
    const result = parse('clients', 'detach', 'client-123', '--force')
    expect(result.command).toBe('clients')
    expect(result.force).toBe(true)
    expect(result.passthroughArgs).toEqual(['detach', 'client-123'])
  })

  it('parses init command', () => {
    expect(parse('init').command).toBe('init')
  })

  it('parses --force flag', () => {
    const result = parse('init', '--force')
    expect(result.command).toBe('init')
    expect(result.force).toBe(true)
  })

  it('parses --dry-run flag', () => {
    const result = parse('--dry-run')
    expect(result.command).toBe('launch')
    expect(result.dryRun).toBe(true)
  })

  it('parses --print-url flag', () => {
    const result = parse('ui', '--print-url')
    expect(result.command).toBe('ui')
    expect(result.printUrl).toBe(true)
  })

  it('parses --open-browser flag', () => {
    const result = parse('ui', '--open-browser')
    expect(result.command).toBe('ui')
    expect(result.openBrowser).toBe(true)
  })

  it('parses --route, --select, and --view for ui handoff', () => {
    const result = parse('ui', '--route', 'orphans', '--select', 'kimi-code', '--view', 'issues')
    expect(result.command).toBe('ui')
    expect(result.route).toBe('orphans')
    expect(result.select).toBe('kimi-code')
    expect(result.view).toBe('issues')
  })
})
