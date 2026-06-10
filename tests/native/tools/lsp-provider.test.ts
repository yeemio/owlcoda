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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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
