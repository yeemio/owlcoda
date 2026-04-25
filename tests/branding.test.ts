import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliCoreSource = readFileSync(join(__dirname, '..', 'src', 'cli-core.ts'), 'utf-8')
const readmeSource = readFileSync(join(__dirname, '..', 'README.md'), 'utf-8')

describe('standalone branding', () => {
  it('cli help no longer advertises source-first or binary launch modes', () => {
    expect(cliCoreSource).not.toContain('--source-first')
    expect(cliCoreSource).not.toContain('--binary')
    expect(cliCoreSource).not.toContain(['--legacy', 'claude'].join('-'))
    expect(cliCoreSource).not.toContain('--legacy-repl')
  })

  it('README positions OwlCoda as an independent product', () => {
    // Hero must frame OwlCoda as a local-first, independent workbench.
    expect(readmeSource).toMatch(/本地优先|独立的本地|local[- ]first/i)
    expect(readmeSource).toContain('workbench')
    // Privacy default must be visible at the top of the README, not buried.
    expect(readmeSource).toMatch(/默认关闭|opt-in/)
    // Legacy "mode B / mode C" multi-mode framing must stay retired.
    expect(readmeSource).not.toContain('模式 B：Source-First')
    expect(readmeSource).not.toContain('模式 C：Binary Mode')
    // Capability-source pointer must point at the runtime-verified file.
    expect(readmeSource).toContain('src/capabilities.ts')
  })
})
