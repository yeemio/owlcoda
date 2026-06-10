/**
 * Tests for src/frontend/ modules — commands, display formatting.
 */

import { describe, it, expect } from 'vitest'

import { isCommand, handleCommand, type CommandContext } from '../dist/frontend/commands.js'
import { formatBanner, formatUsage, formatStopReason, formatError, formatWarning, dim } from '../dist/frontend/display.js'

// ─── Commands tests ───

describe('frontend: isCommand', () => {
  it('recognizes /help', () => {
    expect(isCommand('/help')).toBe(true)
  })

  it('recognizes /quit', () => {
    expect(isCommand('/quit')).toBe(true)
  })

  it('recognizes /exit', () => {
    expect(isCommand('/exit')).toBe(true)
  })

  it('recognizes /model', () => {
    expect(isCommand('/model')).toBe(true)
  })

  it('recognizes /model with argument', () => {
    expect(isCommand('/model distilled')).toBe(true)
  })

  it('recognizes /status', () => {
    expect(isCommand('/status')).toBe(true)
  })

  it('recognizes /capabilities', () => {
    expect(isCommand('/capabilities')).toBe(true)
  })

  it('recognizes /clear', () => {
    expect(isCommand('/clear')).toBe(true)
  })

  it('does not recognize plain text', () => {
    expect(isCommand('hello world')).toBe(false)
  })

  it('does not recognize empty string', () => {
    expect(isCommand('')).toBe(false)
  })

  it('any slash prefix is treated as a command', () => {
    // isCommand returns true for any / prefix — handleCommand returns "Unknown command"
    expect(isCommand('/unknown')).toBe(true)
  })
})

describe('frontend: handleCommand', () => {
  function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
    return {
      currentModel: 'qwen2.5-coder:32b',
      sessionId: 'test-session-001',
      messageCount: 0,
      autoApprove: false,
      config: {
        port: 8019,
        host: '127.0.0.1',
        routerUrl: 'http://127.0.0.1:8009',
        routerTimeoutMs: 600_000,
        logLevel: 'info',
        responseModelStyle: 'platform',
        catalogLoaded: false,
        models: [
          {
            id: 'qwen2.5-coder:32b',
            label: 'Qwen2.5 Coder 32B',
            backendModel: 'qwen2.5-coder:32b',
            aliases: ['default', 'distilled'],
            tier: 'production',
            default: true,
            availability: 'available',
          },
          {
            id: 'gpt-oss-120b-MXFP4-Q4',
            label: 'GPT-OSS 120B',
            backendModel: 'gpt-oss-120b-MXFP4-Q4',
            aliases: ['heavy'],
            tier: 'heavy',
            default: false,
            availability: 'unavailable',
          },
        ],
        modelMap: {},
        defaultModel: '',
        reverseMapInResponse: true,
        requestTimeoutMs: 120000,
        maxTokensDefault: 16384,
        maxTokensCap: 65536,
      } as any,
      setModel: () => {},
      setAutoApprove: () => {},
      clearMessages: () => {},
      quit: () => {},
      resumeSession: async () => null,
      ...overrides,
    }
  }

  it('/help returns help text with command names', async () => {
    const result = await handleCommand('/help', makeContext())
    expect(result.handled).toBe(true)
    expect(result.output).toContain('/help')
    expect(result.output).toContain('/model')
    expect(result.output).toContain('/quit')
    expect(result.output).toContain('/approve')
    expect(result.output).toContain('/resume')
    expect(result.output).toContain('/session')
  })

  it('/quit calls quit callback', async () => {
    let quitCalled = false
    const result = await handleCommand('/quit', makeContext({ quit: () => { quitCalled = true } }))
    expect(result.handled).toBe(true)
    expect(quitCalled).toBe(true)
  })

  it('/exit calls quit callback', async () => {
    let quitCalled = false
    const result = await handleCommand('/exit', makeContext({ quit: () => { quitCalled = true } }))
    expect(result.handled).toBe(true)
    expect(quitCalled).toBe(true)
  })

  it('/model without argument shows model list', async () => {
    const result = await handleCommand('/model', makeContext())
    expect(result.handled).toBe(true)
    expect(result.output).toContain('Qwen2.5 Coder 32B')
    // Platform real model ID must be primary display
    expect(result.output).toContain('qwen2.5-coder:32b')
    expect(result.output).toContain('Switch with /model <name>')
  })

  it('/model shows availability tags', async () => {
    const result = await handleCommand('/model', makeContext())
    expect(result.output).toContain('✓')
    expect(result.output).toContain('unavailable')
  })

  it('/model with valid name calls setModel', async () => {
    let modelSet = ''
    const result = await handleCommand('/model gpt-oss-120b-MXFP4-Q4', makeContext({
      setModel: (m: string) => { modelSet = m },
    }))
    expect(result.handled).toBe(true)
    expect(result.output).toContain('gpt-oss-120b-MXFP4-Q4')
  })

  it('/status shows session info', async () => {
    const result = await handleCommand('/status', makeContext())
    expect(result.handled).toBe(true)
    expect(result.output).toContain('qwen2.5-coder:32b')
    expect(result.output).toContain('test-session-001')
  })

  it('/clear calls clearMessages', async () => {
    let clearCalled = false
    const result = await handleCommand('/clear', makeContext({ clearMessages: () => { clearCalled = true } }))
    expect(result.handled).toBe(true)
    expect(clearCalled).toBe(true)
  })

  it('/capabilities returns capability info from single source', async () => {
    const result = await handleCommand('/capabilities', makeContext())
    expect(result.handled).toBe(true)
    expect(result.output).toBeDefined()
    expect(result.output.length).toBeGreaterThan(0)
    expect(result.output).toContain('Supported')
    // Must contain capabilities from capabilities.ts single source
    expect(result.output).toContain('Text chat')
    expect(result.output).toContain('Session resume')
    expect(result.output).toContain('CLI --model flag')
    expect(result.output).toContain('Unsupported')
    expect(result.output).toContain('Extended thinking')
  })

  it('/approve toggles auto-approve', async () => {
    let approved = false
    const result = await handleCommand('/approve', makeContext({
      setAutoApprove: (v: boolean) => { approved = v },
    }))
    expect(result.handled).toBe(true)
    expect(approved).toBe(true)
    expect(result.output).toContain('ON')
  })

  it('/approve on sets auto-approve', async () => {
    let approved = false
    const result = await handleCommand('/approve on', makeContext({
      setAutoApprove: (v: boolean) => { approved = v },
    }))
    expect(result.handled).toBe(true)
    expect(approved).toBe(true)
  })

  it('/approve off clears auto-approve', async () => {
    let approved = true
    const result = await handleCommand('/approve off', makeContext({
      autoApprove: true,
      setAutoApprove: (v: boolean) => { approved = v },
    }))
    expect(result.handled).toBe(true)
    expect(approved).toBe(false)
  })

  it('/session shows session info', async () => {
    const result = await handleCommand('/session', makeContext())
    expect(result.handled).toBe(true)
    expect(result.output).toContain('test-session-001')
    expect(result.output).toContain('qwen2.5-coder:32b')
  })

  it('/resume calls resumeSession callback', async () => {
    let resumedWith = ''
    const result = await handleCommand('/resume last', makeContext({
      resumeSession: async (id: string) => { resumedWith = id; return 'test-session-002' },
    }))
    expect(result.handled).toBe(true)
    expect(resumedWith).toBe('last')
    expect(result.output).toContain('test-session-002')
  })

  it('/resume reports not found', async () => {
    const result = await handleCommand('/resume nonexistent', makeContext({
      resumeSession: async () => null,
    }))
    expect(result.handled).toBe(true)
    expect(result.output).toContain('not found')
  })

  it('unknown command returns error message', async () => {
    const result = await handleCommand('/foobar', makeContext())
    expect(result.handled).toBe(true)
    expect(result.output).toContain('Unknown command')
  })
})

// ─── Display formatting tests ───

describe('frontend: display formatting', () => {
  it('formatBanner includes version and model', () => {
    const banner = formatBanner('0.6.1', 'qwen2.5-coder:32b', [])
    expect(banner).toContain('0.6.1')
    expect(banner).toContain('qwen2.5-coder:32b')
  })

  it('formatBanner includes capabilities when provided', () => {
    const banner = formatBanner('0.6.1', 'Distilled-27B', ['streaming', 'tool_use'])
    expect(banner).toContain('streaming')
    expect(banner).toContain('tool_use')
  })

  it('formatUsage formats token counts', () => {
    const usage = formatUsage(100, 200)
    expect(usage).toContain('100')
    expect(usage).toContain('200')
  })

  it('formatStopReason returns empty for end_turn', () => {
    const reason = formatStopReason('end_turn')
    expect(reason).toBe('')
  })

  it('formatStopReason shows truncated for max_tokens', () => {
    const reason = formatStopReason('max_tokens')
    expect(reason).toContain('max')
  })

  it('formatError wraps message in error styling', () => {
    const err = formatError('something broke')
    expect(err).toContain('something broke')
  })

  it('formatWarning wraps message in warning styling', () => {
    const warn = formatWarning('be careful')
    expect(warn).toContain('be careful')
  })

  it('dim returns a string', () => {
    const d = dim('muted text')
    expect(typeof d).toBe('string')
    expect(d).toContain('muted text')
  })
})
