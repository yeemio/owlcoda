import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import * as inkRepl from '../../src/native/ink-repl.js'
import * as replShared from '../../src/native/repl-shared.js'

describe('permission decision audit', () => {
  it('formats a persistent transcript line with a bounded bash target', () => {
    const formatter = (replShared as Record<string, unknown>)['formatPermissionDecisionAudit']
    expect(formatter).toBeTypeOf('function')
    if (typeof formatter !== 'function') return

    const line = formatter({
      decision: 'always',
      toolName: 'bash',
      input: { command: `brew install ${'very-long-package-name '.repeat(8)}` },
    }) as string

    expect(line).toContain('↳ Allowed (always for this tool): bash — brew install')
    expect(line.length).toBeLessThanOrEqual(125)
  })

  it('routes the completed decision to appendTranscript instead of a transient footer', () => {
    const source = readFileSync(new URL('../../src/native/ink-repl.tsx', import.meta.url), 'utf8')
    expect(source).toContain('appendTranscript(formatPermissionDecisionAudit({')
    expect(source).not.toContain('setFooterNotice(dim(`↳ ${verb}: ${toolDisplay}`))')
  })

  it('builds bash permission-card props from the classifier tier and reason', () => {
    const buildProps = (inkRepl as Record<string, unknown>)['buildPermissionCardProps']
    expect(buildProps).toBeTypeOf('function')
    if (typeof buildProps !== 'function') return

    const props = buildProps('bash', { command: 'brew install tesseract poppler' }, 1, 100) as {
      kind: string
      risk?: string
    }
    expect(props.kind).toBe('exec')
    expect(props.risk).toContain('SYSTEM')
    expect(props.risk).toContain('system package manager')
  })
})
