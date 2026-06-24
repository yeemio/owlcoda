/**
 * Integration tests for the native LSP provider.
 *
 * The diagnostics/symbols cases spawn a REAL typescript-language-server over
 * stdio and assert end-to-end behavior — this is the verification that makes
 * the LSP tool genuinely wired (vs the old permanent no-op provider). They
 * skip gracefully when the binary isn't installed so CI without it stays green.
 *
 * The no-server cases (unsupported extension, missing file) never spawn and
 * always run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { NativeLspProvider } from '../../../src/native/tools/lsp-provider.js'

function tsLsAvailable(): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['typescript-language-server'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HAS_TS_LS = tsLsAvailable()

describe.skipIf(!HAS_TS_LS)('NativeLspProvider — live typescript-language-server', () => {
  let tmpDir: string
  let provider: NativeLspProvider

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'owlcoda-lsp-'))
    writeFileSync(
      join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true } }),
    )
    provider = new NativeLspProvider()
  })

  afterAll(() => {
    provider?.disposeAll()
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('isAvailable() is true when the binary is on PATH', () => {
    expect(provider.isAvailable()).toBe(true)
  })

  it('surfaces a type-error diagnostic for a bad .ts file', async () => {
    const file = join(tmpDir, 'bad.ts')
    writeFileSync(file, 'const x: number = "definitely not a number"\nexport { x }\n')
    const result = await provider.execute('diagnostics', { file_path: file })
    expect(result.isError).toBeFalsy()
    // TS2322: Type 'string' is not assignable to type 'number'.
    expect(result.content).toMatch(/not assignable|number|2322/i)
    expect(result.content).toMatch(/diagnostic/i)
  }, 30000)

  it('reports a clean file as having no diagnostics', async () => {
    const file = join(tmpDir, 'good.ts')
    writeFileSync(file, 'export const y: number = 42\n')
    const result = await provider.execute('diagnostics', { file_path: file })
    expect(result.isError).toBeFalsy()
    expect(result.content).toMatch(/no diagnostics|0 error/i)
  }, 30000)

  it('returns document symbols for a .ts file', async () => {
    const file = join(tmpDir, 'sym.ts')
    writeFileSync(file, 'export function alpha() { return 1 }\nexport class Beta {}\n')
    const result = await provider.execute('symbols', { file_path: file })
    expect(result.isError).toBeFalsy()
    expect(result.content).toMatch(/alpha|Beta/)
  }, 30000)
})

describe('NativeLspProvider — no external server required', () => {
  it('waits for populated diagnostics after an initial empty publish', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owlcoda-lsp-delayed-'))
    const binDir = join(dir, 'bin')
    const oldPath = process.env.PATH
    mkdirSync(binDir)
    const fakeServer = join(binDir, process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server')
    writeFileSync(fakeServer, `#!/usr/bin/env node
let buffer = Buffer.alloc(0)
let openedUri = null
function send(msg) {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } })
    return
  }
  if (msg.method === 'textDocument/didOpen') {
    openedUri = msg.params.textDocument.uri
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: openedUri, diagnostics: [] } })
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: openedUri,
          diagnostics: [{
            range: { start: { line: 0, character: 6 } },
            severity: 1,
            source: 'typescript',
            code: 2322,
            message: 'Type string is not assignable to type number.',
          }],
        },
      })
    }, 650)
    return
  }
  if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: null })
}
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) return
    const header = buffer.subarray(0, headerEnd).toString('utf8')
    const match = /Content-Length:\\s*(\\d+)/i.exec(header)
    if (!match) return
    const len = Number.parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + len) return
    const body = buffer.subarray(bodyStart, bodyStart + len).toString('utf8')
    buffer = buffer.subarray(bodyStart + len)
    handle(JSON.parse(body))
  }
})
setInterval(() => {}, 1000)
`)
    chmodSync(fakeServer, 0o755)
    process.env.PATH = `${binDir}:${oldPath ?? ''}`
    const provider = new NativeLspProvider()
    const file = join(dir, 'bad.ts')
    writeFileSync(file, 'const x: number = "definitely not a number"\nexport { x }\n')
    try {
      const result = await provider.execute('diagnostics', { file_path: file })
      expect(result.isError).toBeFalsy()
      expect(result.content).toMatch(/not assignable|2322/i)
    } finally {
      provider.disposeAll()
      process.env.PATH = oldPath
      rmSync(dir, { recursive: true, force: true })
    }
  }, 10000)

  it('reports no-server gracefully for unsupported extensions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'owlcoda-lsp-x-'))
    const f = join(dir, 'data.xyz')
    writeFileSync(f, 'whatever')
    try {
      const p = new NativeLspProvider()
      const result = await p.execute('diagnostics', { file_path: f })
      expect(result.isError).toBe(true)
      expect(result.content).toMatch(/no language server/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('errors clearly on a missing file', async () => {
    const p = new NativeLspProvider()
    const result = await p.execute('diagnostics', { file_path: '/nonexistent/owlcoda/xyz.ts' })
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/not found/i)
  })

  it('errors on missing file_path param', async () => {
    const p = new NativeLspProvider()
    const result = await p.execute('diagnostics', {})
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/file_path is required/i)
  })
})
