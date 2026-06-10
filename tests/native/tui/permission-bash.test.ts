/**
 * Verifies the TUI permission helper now delegates to the centralized
 * bash-risk classifier (issue #2). The helper used to carry its own
 * destructive-command regex; that regex has been replaced with a thin
 * wrapper around `classifyBashCommand`. The behavioral contract this
 * test pins:
 *   - dangerous classifier verdict → returns a non-null warning string
 *   - safe-readonly / needs-approval / unknown → returns null
 *   - the warning string mirrors the classifier's reason (one source of truth)
 */
import { describe, it, expect } from 'vitest'
import { detectDestructiveCommand } from '../../../src/native/tui/permission.js'
import { classifyBashCommand } from '../../../src/native/bash-risk.js'

describe('detectDestructiveCommand (delegates to classifier)', () => {
  it('returns null for safe read-only commands', () => {
    for (const cmd of ['pwd', 'ls -la', 'cat README.md', 'git status', 'rg foo src']) {
      expect(detectDestructiveCommand(cmd)).toBeNull()
    }
  })

  it('returns null for needs_approval commands (the card itself prompts)', () => {
    // The permission CARD already asks for consent; we only escalate to
    // a warning banner for `dangerous`. needs_approval should not double-
    // warn on every `git commit` or `npm install`.
    for (const cmd of ['rm foo.txt', 'git checkout main', 'npm install x', 'echo hi > /tmp/x']) {
      expect(detectDestructiveCommand(cmd)).toBeNull()
    }
  })

  it('returns null for unknown commands (warning is reserved for dangerous)', () => {
    expect(detectDestructiveCommand('some-custom-cli')).toBeNull()
  })

  it('returns a non-null warning for dangerous commands', () => {
    for (const cmd of ['rm -rf /', 'sudo rm x', 'git push --force', 'kill -9 1', 'killall node']) {
      const warning = detectDestructiveCommand(cmd)
      expect(warning).not.toBeNull()
      expect(typeof warning).toBe('string')
    }
  })

  it('warning string echoes the classifier reason (single source of truth)', () => {
    const classifier = classifyBashCommand('rm -rf /')
    expect(classifier.level).toBe('dangerous')
    expect(detectDestructiveCommand('rm -rf /')).toBe(classifier.reasons[0])
  })
})
