/**
 * OwlCoda public headless API.
 *
 * Stable entry point for driving a single non-interactive OwlCoda run
 * programmatically: send a prompt, run the agentic loop against a configured
 * model (via an OwlCoda daemon `apiBaseUrl`), and get back a structured
 * {@link HeadlessResult} — final text, exit code, iterations, stop reason,
 * task status, and approval denials. With `json: true` the same record is the
 * machine-readable contract a batch/benchmark runner consumes.
 *
 * This barrel is deliberately decoupled from internal file layout: external
 * callers import `owlcoda/headless` (mapped to `dist/headless.js` in
 * package.json `exports`), never the internal `./native/*` modules. Keeping
 * the public surface here means internal refactors of `src/native/headless.ts`
 * do not break downstream importers.
 */
export { runHeadless } from './native/headless.js'
export type { HeadlessOptions, HeadlessResult } from './native/headless.js'
// Re-export the types HeadlessResult references so external TS consumers can name
// them (result.taskStatus, result.mode) without reaching into internal ./native/*.
export type { TaskRunStatus } from './native/protocol/types.js'
export type { OperatingMode } from './native/modes.js'
