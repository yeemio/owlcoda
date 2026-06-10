/**
 * OwlCoda Native LSP Provider
 *
 * A real Language Server Protocol client over stdio JSON-RPC, wired into the
 * LSP tool (see lsp.ts). Before this, the LSP tool was registered with a
 * permanent no-op provider (`isAvailable() => false`) and the only documented
 * activation path ("plugin with lspServers config") was never implemented —
 * so the tool was dead weight that misled the model into wasting a turn
 * calling it.
 *
 * This provider lazily spawns a language server per workspace root, performs
 * the initialize handshake, and routes the six LSP tool actions
 * (diagnostics / hover / definition / references / symbols / completion) to
 * the corresponding `textDocument/*` requests. Diagnostics are collected from
 * the server-pushed `textDocument/publishDiagnostics` notification within a
 * settle window.
 *
 * Server selection is by file extension + binary availability on PATH:
 *   - .ts/.tsx/.js/.jsx/.mts/.cts → typescript-language-server --stdio
 *   - (extensible: add more rows to LANGUAGE_SERVERS)
 *
 * When no server binary is available for a file, the provider reports
 * unavailable gracefully (same shape the old no-op default produced), so
 * non-TS/JS files don't error in a confusing way.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import type { LSPProvider } from './lsp.js'

interface LanguageServerSpec {
  /** Binary name resolved on PATH. */
  command: string
  /** Args to launch in stdio mode. */
  args: string[]
  /** LSP languageId for didOpen. */
  languageId: string
}

/** Extension → language server spec. Extend here to support more languages. */
function resolveServerSpec(filePath: string): LanguageServerSpec | null {
  const ext = extname(filePath).toLowerCase()
  switch (ext) {
    case '.ts':
    case '.mts':
    case '.cts':
      return { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescript' }
    case '.tsx':
      return { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescriptreact' }
    case '.js':
    case '.mjs':
    case '.cjs':
      return { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascript' }
    case '.jsx':
      return { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascriptreact' }
    default:
      return null
  }
}

const binaryAvailableCache = new Map<string, boolean>()

function isBinaryAvailable(command: string): boolean {
  const cached = binaryAvailableCache.get(command)
  if (cached !== undefined) return cached
  let available = false
  try {
    // `which` (POSIX) / `where` (win32). execFileSync throws on non-zero exit.
    const probe = process.platform === 'win32' ? 'where' : 'which'
    execFileSync(probe, [command], { stdio: 'ignore' })
    available = true
  } catch {
    available = false
  }
  binaryAvailableCache.set(command, available)
  return available
}

/** Walk up from the file's directory to find a project root marker. */
function resolveWorkspaceRoot(filePath: string): string {
  const markers = ['tsconfig.json', 'jsconfig.json', 'package.json', '.git']
  let dir = dirname(filePath)
  for (let i = 0; i < 50; i++) {
    for (const marker of markers) {
      if (existsSync(join(dir, marker))) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(filePath)
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type JsonRpcMessage = {
  jsonrpc?: string
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

interface Diagnostic {
  range?: { start?: { line?: number; character?: number } }
  severity?: number
  message?: string
  source?: string
  code?: string | number
}

/**
 * One language-server process for one workspace root. Handles JSON-RPC framing
 * over stdio, the initialize handshake, didOpen tracking, and request/notify.
 */
class LspSession {
  private proc: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private diagnosticsByUri = new Map<string, Diagnostic[]>()
  private diagnosticsListeners = new Set<(uri: string) => void>()
  private openDocs = new Set<string>()
  private initializePromise: Promise<void>
  private dead = false

  constructor(spec: LanguageServerSpec, private readonly rootUri: string) {
    this.proc = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.proc.stdout.on('data', (chunk: Buffer) => this.onData(chunk))
    // LS stderr is noisy progress/log output — intentionally ignored.
    this.proc.stderr.on('data', () => {})
    this.proc.on('exit', () => {
      this.dead = true
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('Language server exited'))
      }
      this.pending.clear()
    })
    this.proc.on('error', () => { this.dead = true })
    this.initializePromise = this.initialize()
  }

  isDead(): boolean {
    return this.dead
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Unparseable header — drop it and resync.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const len = Number.parseInt(match[1]!, 10)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + len) return // wait for more data
      const body = this.buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
      this.buffer = this.buffer.subarray(bodyStart + len)
      let msg: JsonRpcMessage
      try {
        msg = JSON.parse(body) as JsonRpcMessage
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }

  private onMessage(msg: JsonRpcMessage): void {
    // Response to one of our requests.
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const pending = this.pending.get(msg.id)
      if (pending) {
        this.pending.delete(msg.id)
        clearTimeout(pending.timer)
        if (msg.error) pending.reject(new Error(msg.error.message ?? 'LSP error'))
        else pending.resolve(msg.result)
      }
      return
    }

    // Server-pushed diagnostics.
    if (msg.method === 'textDocument/publishDiagnostics') {
      const uri = msg.params?.['uri'] as string | undefined
      const diags = (msg.params?.['diagnostics'] as Diagnostic[] | undefined) ?? []
      if (uri) {
        this.diagnosticsByUri.set(uri, diags)
        for (const listener of this.diagnosticsListeners) listener(uri)
      }
      return
    }

    // Server → client request. We must reply or some servers block.
    if (typeof msg.id === 'number' && msg.method) {
      if (msg.method === 'workspace/configuration') {
        const items = (msg.params?.['items'] as unknown[] | undefined) ?? []
        this.sendRaw({ jsonrpc: '2.0', id: msg.id, result: items.map(() => ({})) })
      } else {
        // registerCapability, workDoneProgress/create, applyEdit, etc. — ack with null.
        this.sendRaw({ jsonrpc: '2.0', id: msg.id, result: null })
      }
    }
  }

  private sendRaw(msg: unknown): void {
    if (this.dead) return
    const json = JSON.stringify(msg)
    const frame = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
    try {
      this.proc.stdin.write(frame)
    } catch {
      this.dead = true
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error('Language server is not running'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.sendRaw({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.sendRaw({ jsonrpc: '2.0', method, params })
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          completion: { completionItem: { snippetSupport: false } },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    }, 15000)
    this.notify('initialized', {})
  }

  private ensureOpen(filePath: string, languageId: string): string {
    const uri = pathToFileURL(filePath).toString()
    if (this.openDocs.has(uri)) return uri
    const text = readFileSync(filePath, 'utf8')
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    })
    this.openDocs.add(uri)
    return uri
  }

  async diagnostics(filePath: string, languageId: string, settleMs = 2500): Promise<Diagnostic[]> {
    await this.initializePromise
    const uri = this.ensureOpen(filePath, languageId)
    return new Promise<Diagnostic[]>((resolve) => {
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      let hardCap: ReturnType<typeof setTimeout> | null = null
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        this.diagnosticsListeners.delete(listener)
        if (settleTimer) clearTimeout(settleTimer)
        if (hardCap) clearTimeout(hardCap)
        resolve(this.diagnosticsByUri.get(uri) ?? [])
      }
      const listener = (changed: string): void => {
        if (changed !== uri) return
        // Debounce: publishDiagnostics may arrive empty-then-populated, so
        // wait 400ms after the LAST update to return the settled set.
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(finish, 400)
      }
      this.diagnosticsListeners.add(listener)
      // Hard cap so we never hang if the server never publishes for this uri.
      hardCap = setTimeout(finish, settleMs)
    })
  }

  async positionRequest(
    method: string,
    filePath: string,
    languageId: string,
    line: number,
    character: number,
  ): Promise<unknown> {
    await this.initializePromise
    const uri = this.ensureOpen(filePath, languageId)
    return this.request(method, {
      textDocument: { uri },
      position: { line, character },
      ...(method === 'textDocument/references' ? { context: { includeDeclaration: true } } : {}),
    })
  }

  async documentRequest(method: string, filePath: string, languageId: string): Promise<unknown> {
    await this.initializePromise
    const uri = this.ensureOpen(filePath, languageId)
    return this.request(method, { textDocument: { uri } })
  }

  dispose(): void {
    if (this.dead) return
    try {
      this.notify('shutdown', {})
      this.notify('exit', {})
      this.proc.kill()
    } catch {
      // best effort
    }
    this.dead = true
  }
}

const SEVERITY_LABELS: Record<number, string> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

function formatDiagnostics(filePath: string, diags: Diagnostic[]): string {
  if (diags.length === 0) return `No diagnostics for ${filePath}.`
  const lines = diags.map((d) => {
    const line = (d.range?.start?.line ?? 0) + 1
    const col = (d.range?.start?.character ?? 0) + 1
    const sev = SEVERITY_LABELS[d.severity ?? 1] ?? 'error'
    const code = d.code !== undefined ? ` [${d.code}]` : ''
    const src = d.source ? `${d.source}: ` : ''
    return `${filePath}:${line}:${col} ${sev}${code} — ${src}${(d.message ?? '').trim()}`
  })
  const errorCount = diags.filter((d) => (d.severity ?? 1) === 1).length
  const warnCount = diags.filter((d) => d.severity === 2).length
  return `${diags.length} diagnostic(s) (${errorCount} error, ${warnCount} warning):\n` + lines.join('\n')
}

function formatLocations(result: unknown): string {
  const locs = Array.isArray(result) ? result : result ? [result] : []
  if (locs.length === 0) return 'No locations found.'
  const out: string[] = []
  for (const loc of locs as Array<Record<string, unknown>>) {
    const uri = (loc['uri'] ?? loc['targetUri']) as string | undefined
    const range = (loc['range'] ?? loc['targetRange']) as { start?: { line?: number; character?: number } } | undefined
    if (!uri) continue
    let path = uri
    try { path = fileURLToPath(uri) } catch { /* keep uri */ }
    const line = (range?.start?.line ?? 0) + 1
    const col = (range?.start?.character ?? 0) + 1
    out.push(`${path}:${line}:${col}`)
  }
  return out.length > 0 ? out.join('\n') : 'No locations found.'
}

function formatHover(result: unknown): string {
  if (!result || typeof result !== 'object') return 'No hover information.'
  const contents = (result as Record<string, unknown>)['contents']
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === 'string' ? c : (c as Record<string, unknown>)['value'] ?? '')).join('\n')
  }
  if (contents && typeof contents === 'object') {
    return String((contents as Record<string, unknown>)['value'] ?? 'No hover information.')
  }
  return 'No hover information.'
}

function formatSymbols(result: unknown): string {
  const syms = Array.isArray(result) ? result : []
  if (syms.length === 0) return 'No symbols found.'
  const out: string[] = []
  const SYMBOL_KINDS: Record<number, string> = {
    5: 'class', 6: 'method', 8: 'field', 9: 'constructor', 11: 'interface',
    12: 'function', 13: 'variable', 14: 'constant', 23: 'struct',
  }
  const walk = (nodes: Array<Record<string, unknown>>, depth: number): void => {
    for (const n of nodes) {
      const name = n['name'] as string | undefined
      const kind = SYMBOL_KINDS[(n['kind'] as number) ?? 0] ?? 'symbol'
      const range = (n['range'] ?? (n['location'] as Record<string, unknown> | undefined)?.['range']) as
        { start?: { line?: number } } | undefined
      const line = (range?.start?.line ?? 0) + 1
      out.push(`${'  '.repeat(depth)}${kind} ${name ?? '?'}  (L${line})`)
      const children = n['children'] as Array<Record<string, unknown>> | undefined
      if (Array.isArray(children)) walk(children, depth + 1)
    }
  }
  walk(syms as Array<Record<string, unknown>>, 0)
  return out.join('\n')
}

function formatCompletions(result: unknown): string {
  const items = Array.isArray(result)
    ? result
    : (result as Record<string, unknown> | null)?.['items']
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return 'No completions.'
  const labels = (list as Array<Record<string, unknown>>).slice(0, 40).map((i) => String(i['label'] ?? ''))
  const more = list.length > 40 ? `\n… +${list.length - 40} more` : ''
  return `${list.length} completion(s):\n` + labels.join(', ') + more
}

/**
 * The native LSP provider. Manages one LspSession per (root × server) and
 * routes tool actions to the right textDocument request.
 */
export class NativeLspProvider implements LSPProvider {
  private sessions = new Map<string, LspSession>()

  isAvailable(): boolean {
    // Available if at least one known server binary is on PATH. The
    // per-file check in execute() is the authoritative gate; this coarse
    // check lets the tool advertise itself only when something can run.
    return isBinaryAvailable('typescript-language-server')
  }

  private sessionFor(filePath: string, spec: LanguageServerSpec): LspSession {
    const root = resolveWorkspaceRoot(filePath)
    const key = `${spec.command}::${root}`
    const existing = this.sessions.get(key)
    if (existing && !existing.isDead()) return existing
    const session = new LspSession(spec, pathToFileURL(root).toString())
    this.sessions.set(key, session)
    return session
  }

  async execute(
    action: string,
    params: Record<string, unknown>,
  ): Promise<{ content: string; isError?: boolean }> {
    const filePath = String(params['file_path'] ?? '')
    if (!filePath) return { content: 'LSP: file_path is required.', isError: true }
    if (!existsSync(filePath)) return { content: `LSP: file not found: ${filePath}`, isError: true }

    const spec = resolveServerSpec(filePath)
    if (!spec) {
      return {
        content: `LSP: no language server configured for ${extname(filePath) || 'this file type'}. ` +
          `Supported: .ts/.tsx/.js/.jsx (typescript-language-server).`,
        isError: true,
      }
    }
    if (!isBinaryAvailable(spec.command)) {
      return {
        content: `LSP: '${spec.command}' is not installed. ` +
          `Install it (e.g. \`npm i -g typescript-language-server typescript\`) to enable code intelligence.`,
        isError: true,
      }
    }

    const session = this.sessionFor(filePath, spec)
    const line = typeof params['line'] === 'number' ? (params['line'] as number) : 0
    const character = typeof params['character'] === 'number' ? (params['character'] as number) : 0

    try {
      switch (action) {
        case 'diagnostics': {
          const diags = await session.diagnostics(filePath, spec.languageId)
          return { content: formatDiagnostics(filePath, diags) }
        }
        case 'hover': {
          const r = await session.positionRequest('textDocument/hover', filePath, spec.languageId, line, character)
          return { content: formatHover(r) }
        }
        case 'definition': {
          const r = await session.positionRequest('textDocument/definition', filePath, spec.languageId, line, character)
          return { content: formatLocations(r) }
        }
        case 'references': {
          const r = await session.positionRequest('textDocument/references', filePath, spec.languageId, line, character)
          return { content: formatLocations(r) }
        }
        case 'symbols': {
          const r = await session.documentRequest('textDocument/documentSymbol', filePath, spec.languageId)
          return { content: formatSymbols(r) }
        }
        case 'completion': {
          const r = await session.positionRequest('textDocument/completion', filePath, spec.languageId, line, character)
          return { content: formatCompletions(r) }
        }
        default:
          return { content: `LSP: unknown action '${action}'.`, isError: true }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `LSP ${action} failed: ${msg}`, isError: true }
    }
  }

  disposeAll(): void {
    for (const [, session] of this.sessions) session.dispose()
    this.sessions.clear()
  }
}

let sharedProvider: NativeLspProvider | null = null

/** Lazy singleton — one provider process-wide, sessions reused across calls. */
export function getNativeLspProvider(): NativeLspProvider {
  if (!sharedProvider) sharedProvider = new NativeLspProvider()
  return sharedProvider
}
