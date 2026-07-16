import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createRunWorkspace } from '../src/native/run-workspace.js'
import {
  StructuredOutputBudgetExceededError,
  readStructuredOutputExecutionLedger,
  reserveDurableStructuredOutputIdempotency,
  reserveStructuredOutputBudget,
  resetStructuredOutputExecutionEconomicsForTesting,
  settleStructuredOutputBudget,
  completeDurableStructuredOutputIdempotency,
} from '../src/structured-output-execution-economics.js'

const roots: string[] = []
const execFileAsync = promisify(execFile)

afterEach(async () => {
  resetStructuredOutputExecutionEconomicsForTesting()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'owlcoda-execution-economics-'))
  roots.push(root)
  const outputRoot = join(root, 'out')
  await createRunWorkspace({ outputRoot, cwd: root, runId: 'run-economics' })
  return outputRoot
}

describe('structured-output execution economics', () => {
  it('reserves the primary provider call before execution and durably stops the next call', async () => {
    const runRef = await workspace()
    const budget = {
      maxProviderCalls: 1,
      maxInputTokens: 1_000,
      maxOutputTokens: 100,
      maxElapsedMs: 60_000,
    }
    const reservation = await reserveStructuredOutputBudget({
      runRef,
      taskId: 'task-budget',
      budget,
      requestedMaxTokens: 80,
      estimatedInputTokens: 50,
      rerun: false,
    })

    expect(reservation.appliedMaxTokens).toBe(80)
    expect(reservation.receipt.cumulative.providerCalls).toBe(1)
    expect(reservation.receipt.current.providerCalls).toBe(1)

    const settled = await settleStructuredOutputBudget({
      reservation,
      inputTokens: 20,
      outputTokens: 30,
      durationMs: 25,
      counts: {
        providerCalls: 1,
        parseAttempts: 1,
        repairAttempts: 0,
        salvageAttempts: 0,
        rerunAttempts: 0,
      },
    })
    expect(settled.cumulative).toMatchObject({
      providerCalls: 1,
      inputTokens: 20,
      outputTokens: 30,
      parseAttempts: 1,
    })

    await expect(reserveStructuredOutputBudget({
      runRef,
      taskId: 'task-budget',
      budget,
      requestedMaxTokens: 80,
      estimatedInputTokens: 50,
      rerun: false,
    })).rejects.toMatchObject<Partial<StructuredOutputBudgetExceededError>>({
      code: 'task_budget_exhausted',
      dimension: 'provider_calls',
    })

    const ledger = await readStructuredOutputExecutionLedger(runRef)
    expect(ledger.tasks['task-budget']).toMatchObject({
      status: 'exhausted',
      cumulative: { providerCalls: 1, inputTokens: 20, outputTokens: 30 },
    })
    const checkpointPath = ledger.tasks['task-budget']?.lastStopReceipt?.checkpointPath
    expect(checkpointPath).toBeTruthy()
    expect(JSON.parse(await readFile(checkpointPath!, 'utf8'))).toMatchObject({
      type: 'task_budget_exhausted',
      taskId: 'task-budget',
      dimension: 'provider_calls',
    })
  })

  it('clamps output reservation and enforces caller-priced USD cost without inventing provider prices', async () => {
    const runRef = await workspace()
    const reservation = await reserveStructuredOutputBudget({
      runRef,
      taskId: 'task-priced',
      budget: {
        maxProviderCalls: 3,
        maxInputTokens: 1_000,
        maxOutputTokens: 50,
        maxElapsedMs: 60_000,
        maxCostUsd: 0.00016,
        inputCostPerMillionUsd: 1,
        outputCostPerMillionUsd: 2,
      },
      requestedMaxTokens: 80,
      estimatedInputTokens: 50,
      rerun: true,
    })

    expect(reservation.appliedMaxTokens).toBe(50)
    expect(reservation.receipt.reservation).toMatchObject({
      inputTokens: 50,
      outputTokens: 50,
      costUsd: 0.00015,
    })
    expect(reservation.receipt.current.rerunAttempts).toBe(1)
  })

  it('keeps a durable idempotency reservation fail-closed until its response receipt is complete', async () => {
    const runRef = await workspace()
    const input = {
      runRef,
      namespace: 'primary' as const,
      key: 'durable-primary-key',
      requestHash: 'sha256:request-a',
    }
    expect((await reserveDurableStructuredOutputIdempotency(input)).kind).toBe('reserved')
    expect((await reserveDurableStructuredOutputIdempotency(input)).kind).toBe('in_progress')
    expect((await reserveDurableStructuredOutputIdempotency({
      ...input,
      requestHash: 'sha256:request-b',
    })).kind).toBe('conflict')

    await completeDurableStructuredOutputIdempotency({
      ...input,
      status: 200,
      body: { ok: true, artifactId: 'structured-output-1' },
    })
    const replay = await reserveDurableStructuredOutputIdempotency(input)
    expect(replay.kind).toBe('replay')
    expect(replay.record).toMatchObject({
      state: 'completed',
      keyHash: expect.stringMatching(/^sha256:/),
      body: { ok: true, artifactId: 'structured-output-1' },
    })
    expect(JSON.stringify(replay.record)).not.toContain('durable-primary-key')
  })

  it('serializes task budget and idempotency reservations across runtime processes', async () => {
    const runRef = await workspace()
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/structured-output-execution-economics.ts')).href
    const budgetProbe = `
      import { reserveStructuredOutputBudget } from ${JSON.stringify(moduleUrl)};
      try {
        await reserveStructuredOutputBudget({
          runRef: ${JSON.stringify(runRef)}, taskId: 'cross-process-budget',
          budget: { maxProviderCalls: 1, maxInputTokens: 100000, maxOutputTokens: 1000, maxElapsedMs: 60000 },
          requestedMaxTokens: 100, estimatedInputTokens: 100, rerun: false,
        });
        process.stdout.write('reserved');
      } catch (error) {
        process.stdout.write(error?.code ?? 'error');
      }
    `
    const runProbe = (source: string) => execFileAsync(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', source,
    ])
    const budgetResults = await Promise.all([runProbe(budgetProbe), runProbe(budgetProbe)])
    expect(budgetResults.map(result => result.stdout).sort()).toEqual(['reserved', 'task_budget_exhausted'])

    const idempotencyProbe = `
      import { reserveDurableStructuredOutputIdempotency } from ${JSON.stringify(moduleUrl)};
      const result = await reserveDurableStructuredOutputIdempotency({
        runRef: ${JSON.stringify(runRef)}, namespace: 'primary', key: 'cross-process-idempotency', requestHash: 'sha256:same',
      });
      process.stdout.write(result.kind);
    `
    const idempotencyResults = await Promise.all([runProbe(idempotencyProbe), runProbe(idempotencyProbe)])
    expect(idempotencyResults.map(result => result.stdout).sort()).toEqual(['in_progress', 'reserved'])
  })
})
