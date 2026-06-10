import { describe, it, expect } from 'vitest'
import { existsSync, writeFileSync } from 'node:fs'
import { runEditorSession } from '../../src/native/editor-session.js'

describe('runEditorSession', () => {
  it('returns the edited content on success', () => {
    const res = runEditorSession('initial', {
      env: { EDITOR: 'fake' },
      spawn: (_cmd, args) => { writeFileSync(args[args.length - 1]!, 'edited!'); return { status: 0 } },
    })
    expect(res).toEqual({ ok: true, content: 'edited!' })
  })

  it('prefers VISUAL over EDITOR', () => {
    let used = ''
    runEditorSession('x', { env: { VISUAL: 'myvis', EDITOR: 'myed' }, spawn: (cmd) => { used = cmd; return { status: 0 } } })
    expect(used).toBe('myvis')
  })

  it('falls back to vi when no editor env is set', () => {
    let used = ''
    runEditorSession('x', { env: {}, spawn: (cmd) => { used = cmd; return { status: 0 } } })
    expect(used).toBe('vi')
  })

  it('returns ok:false on a non-zero exit', () => {
    const res = runEditorSession('x', { env: { EDITOR: 'e' }, spawn: () => ({ status: 1 }) })
    expect(res.ok).toBe(false)
    expect(res.content).toBeNull()
  })

  it('returns ok:false with the message on a spawn error', () => {
    const res = runEditorSession('x', { env: { EDITOR: 'e' }, spawn: () => ({ status: null, error: new Error('ENOENT editor') }) })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('ENOENT')
  })

  it('cleans up the temp file afterward', () => {
    let path = ''
    runEditorSession('x', { env: { EDITOR: 'e' }, spawn: (_cmd, args) => { path = args[args.length - 1]!; return { status: 0 } } })
    expect(path).not.toBe('')
    expect(existsSync(path)).toBe(false)
  })
})
