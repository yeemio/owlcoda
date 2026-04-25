import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/cli-core.js'

describe('serve command', () => {
  it('parseArgs recognizes serve command', () => {
    const result = parseArgs(['node', 'cli.js', 'serve'])
    expect(result.command).toBe('serve')
  })

  it('parseArgs serve with --port', () => {
    const result = parseArgs(['node', 'cli.js', 'serve', '--port', '9999'])
    expect(result.command).toBe('serve')
    expect(result.port).toBe(9999)
  })

  it('parseArgs serve with --router', () => {
    const result = parseArgs(['node', 'cli.js', 'serve', '--router', 'http://localhost:5000'])
    expect(result.command).toBe('serve')
    expect(result.routerUrl).toBe('http://localhost:5000')
  })
})
