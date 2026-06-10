import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

export interface EditorSessionResult {
  ok: boolean
  content: string | null
  error?: string
}

export interface EditorSessionDeps {
  /** Injectable for tests; defaults to a real `spawnSync` with inherited stdio. */
  spawn?: (cmd: string, args: string[]) => { status: number | null; error?: Error }
  env?: NodeJS.ProcessEnv
  tmpRoot?: string
}

/**
 * Open the user's $EDITOR on a temp file seeded with `initialContent`, then return
 * the saved content. Pure of Ink/terminal concerns — the caller is responsible for
 * suspending/restoring the REPL around this call.
 */
export function runEditorSession(initialContent: string, deps: EditorSessionDeps = {}): EditorSessionResult {
  const env = deps.env ?? process.env
  const editor = env.VISUAL || env.EDITOR || 'vi'
  const root = deps.tmpRoot ?? tmpdir()
  const dir = mkdtempSync(join(root, 'owlcoda-editor-'))
  const file = join(dir, 'message.md')
  try {
    writeFileSync(file, initialContent, 'utf8')
    const spawn = deps.spawn ?? ((cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { stdio: 'inherit' })
      return { status: r.status, error: r.error }
    })
    const { status, error } = spawn(editor, [file])
    if (error) return { ok: false, content: null, error: error.message }
    if (status !== 0) return { ok: false, content: null, error: `editor exited with code ${status}` }
    return { ok: true, content: readFileSync(file, 'utf8') }
  } catch (e) {
    return { ok: false, content: null, error: e instanceof Error ? e.message : String(e) }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }
}
