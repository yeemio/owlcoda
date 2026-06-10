/**
 * Public headless API surface.
 *
 * Open Coding Lab dogfood (2026-06-09): OwlCoda's reusable single-shot runner
 * `runHeadless` lived only in `src/native/headless.ts` with no package export
 * (`package.json` had `exports: undefined`), so a programmatic caller — the
 * Lab's benchmark runner — could not `import { runHeadless } from
 * 'owlcoda/headless'`. It had to reach into `../../src/native/*` via fragile
 * relative paths that break with ERR_MODULE_NOT_FOUND once the caller is its
 * own repo. This barrel is the stable public surface decoupled from internal
 * file layout; `package.json` maps `owlcoda/headless` → `dist/headless.js`.
 */
import { describe, it, expect } from 'vitest'
import * as headless from '../src/headless.js'
import { runHeadless, type HeadlessOptions, type HeadlessResult } from '../src/headless.js'

describe('public headless API barrel', () => {
  it('re-exports runHeadless as a callable named function', () => {
    expect(typeof runHeadless).toBe('function')
    expect(headless.runHeadless.name).toBe('runHeadless')
  })

  it('exports the HeadlessOptions type (the stable input contract)', () => {
    // Type-level assertion: fails tsc if the type is not re-exported.
    const opts: HeadlessOptions = {
      apiBaseUrl: 'http://127.0.0.1:9999',
      apiKey: 'sk-test',
      model: 'test-model',
      prompt: 'solve the task',
      json: true,
    }
    expect(opts.model).toBe('test-model')
  })

  it('exports the HeadlessResult type (the structured record contract)', () => {
    const result: HeadlessResult = { text: '', exitCode: 0, iterations: 0 }
    expect(result.exitCode).toBe(0)
  })
})
