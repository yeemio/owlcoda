import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  mergeRuntimeFactRefs,
  normalizeRuntimeFactRefs,
  runtimeFactRefsFromPayload,
} from '../../src/native/runtime-facts.js'
import {
  captureLocalFileEvidence,
  createEvidenceContext,
  createVerifiedOutcome,
  createWorkCase,
  executeWorkCase,
  recordAdjudicationReceipt,
  recordVerifiedOutcome,
  resolveEvidenceContext,
  resolveEvidenceRef,
} from '../../src/native/invariant-spine/index.js'
import { createRunWorkspace, readArtifactLedger, recordArtifact } from '../../src/native/run-workspace.js'
import { getJob, listJobs, resetJobSupervisor } from '../../src/native/job-supervisor.js'
import { createJobCancelTool } from '../../src/native/tools/job.js'
import { OWLCODA_NATIVE_DRIVER_ID } from '../../src/native/runtime-execution-control/index.js'

describe('Invariant Spine F0 correlation facts', () => {
  it('normalizes, merges, and parses WorkCase execution provenance refs', () => {
    expect(normalizeRuntimeFactRefs({
      workCaseId: ' work-case-1 ',
      evidenceContextId: ' evidence-context-1 ',
      executionRunId: ' workflow-run-1 ',
      driverId: ' owlcoda-native ',
      executionId: ' runtime-execution:1 ',
      attemptId: ' runtime-attempt:1 ',
      driverSessionId: ' native-session:1 ',
      workspaceRunId: ' workspace-run-1 ',
      workflowReceiptRef: ' /tmp/workflow/receipt.json ',
      workflowArtifactRefs: [' /tmp/workflow/response.json ', '/tmp/workflow/response.json'],
    })).toEqual({
      workCaseId: 'work-case-1',
      evidenceContextId: 'evidence-context-1',
      executionRunId: 'workflow-run-1',
      driverId: 'owlcoda-native',
      executionId: 'runtime-execution:1',
      attemptId: 'runtime-attempt:1',
      driverSessionId: 'native-session:1',
      workspaceRunId: 'workspace-run-1',
      workflowReceiptRef: '/tmp/workflow/receipt.json',
      workflowArtifactRefs: ['/tmp/workflow/response.json'],
    })

    expect(mergeRuntimeFactRefs({
      workCaseId: 'work-case-1',
      workflowArtifactRefs: ['/tmp/workflow/a.json'],
    }, {
      workCaseId: 'ignored-later-value',
      evidenceContextId: 'evidence-context-1',
      workflowArtifactRefs: ['/tmp/workflow/b.json', '/tmp/workflow/a.json'],
    })).toEqual({
      workCaseId: 'work-case-1',
      evidenceContextId: 'evidence-context-1',
      workflowArtifactRefs: ['/tmp/workflow/a.json', '/tmp/workflow/b.json'],
    })

    expect(runtimeFactRefsFromPayload({
      correlation: {
        work_case_id: 'work-case-1',
        evidence_context_id: 'evidence-context-1',
        execution_run_id: 'workflow-run-1',
        driver_id: 'owlcoda-native',
        execution_id: 'runtime-execution:1',
        attempt_id: 'runtime-attempt:1',
        driver_session_id: 'native-session:1',
        workspace_run_id: 'workspace-run-1',
        workflow_receipt_ref: '/tmp/workflow/receipt.json',
        workflow_artifact_refs: ['/tmp/workflow/a.json', '/tmp/workflow/b.json'],
      },
    })).toEqual({
      workCaseId: 'work-case-1',
      evidenceContextId: 'evidence-context-1',
      executionRunId: 'workflow-run-1',
      driverId: 'owlcoda-native',
      executionId: 'runtime-execution:1',
      attemptId: 'runtime-attempt:1',
      driverSessionId: 'native-session:1',
      workspaceRunId: 'workspace-run-1',
      workflowReceiptRef: '/tmp/workflow/receipt.json',
      workflowArtifactRefs: ['/tmp/workflow/a.json', '/tmp/workflow/b.json'],
    })
  })
})

describe('Invariant Spine F0 local evidence', () => {
  let tempDir = ''

  beforeEach(async () => {
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'owlcoda-invariant-f0-evidence-')))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('captures a stable immutable local regular-file EvidenceRef and rejects digest drift', async () => {
    const locator = join(tempDir, 'evidence.json')
    await writeFile(locator, '{"fixture":"read-only"}\n', 'utf-8')
    const canonicalLocator = await realpath(locator)

    const first = await captureLocalFileEvidence({
      locator,
      observedAt: '2026-08-09T08:00:00.000Z',
      version: 'fixture-v1',
    })
    const second = await captureLocalFileEvidence({
      locator,
      observedAt: '2026-08-09T08:01:00.000Z',
      version: 'fixture-v1',
    })

    expect(first).toMatchObject({
      schemaVersion: 1,
      sourceType: 'local_file',
      locator: canonicalLocator,
      mediaType: 'application/json',
      version: 'fixture-v1',
      observedAt: '2026-08-09T08:00:00.000Z',
      symlinkPolicy: 'reject',
    })
    expect(first.id).toMatch(/^evidence-ref:sha256:[a-f0-9]{64}$/)
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(first.id).toBe(second.id)
    expect(first.sha256).toBe(second.sha256)
    expect(isAbsolute(first.locator)).toBe(true)
    expect(Object.isFrozen(first)).toBe(true)
    await expect(resolveEvidenceRef(first)).resolves.toEqual(first)

    await writeFile(locator, '{"fixture":"changed"}\n', 'utf-8')
    await expect(resolveEvidenceRef(first)).rejects.toMatchObject({ code: 'EVIDENCE_DIGEST_DRIFT' })
  })

  it('fails closed for missing, unreadable, non-regular, and rejected-symlink evidence', async () => {
    const missingPath = join(tempDir, 'missing.txt')
    await expect(captureLocalFileEvidence({ locator: missingPath })).rejects.toMatchObject({ code: 'EVIDENCE_MISSING' })

    const removedPath = join(tempDir, 'removed-after-capture.txt')
    await writeFile(removedPath, 'captured then removed', 'utf-8')
    const removedRef = await captureLocalFileEvidence({ locator: removedPath })
    await rm(removedPath)
    await expect(resolveEvidenceRef(removedRef)).rejects.toMatchObject({ code: 'EVIDENCE_MISSING' })

    const unreadablePath = join(tempDir, 'unreadable.txt')
    await writeFile(unreadablePath, 'private fixture', 'utf-8')
    await chmod(unreadablePath, 0o000)
    try {
      await expect(captureLocalFileEvidence({ locator: unreadablePath })).rejects.toMatchObject({ code: 'EVIDENCE_UNREADABLE' })
    } finally {
      await chmod(unreadablePath, 0o600)
    }

    const directoryPath = join(tempDir, 'directory-evidence')
    await mkdir(directoryPath)
    await expect(captureLocalFileEvidence({ locator: directoryPath })).rejects.toMatchObject({ code: 'EVIDENCE_NOT_REGULAR_FILE' })

    const targetPath = join(tempDir, 'target.txt')
    const symlinkPath = join(tempDir, 'linked.txt')
    await writeFile(targetPath, 'target fixture', 'utf-8')
    await symlink(targetPath, symlinkPath)
    await expect(captureLocalFileEvidence({ locator: symlinkPath })).rejects.toMatchObject({ code: 'EVIDENCE_SYMLINK_REJECTED' })
  })

  it('rejects a symlink in any locator ancestor while resolve policy follows it', async () => {
    const targetDir = join(tempDir, 'target-directory')
    const linkedDir = join(tempDir, 'linked-directory')
    await mkdir(targetDir)
    const targetLocator = join(targetDir, 'evidence.txt')
    await writeFile(targetLocator, 'ancestor symlink fixture', 'utf-8')
    const platformAliasLocator = process.platform === 'darwin'
      ? targetLocator.replace(/^\/private\/(etc|tmp|var)(?=\/)/, '/$1')
      : targetLocator
    await expect(captureLocalFileEvidence({ locator: platformAliasLocator, symlinkPolicy: 'reject' }))
      .resolves.toMatchObject({ locator: await realpath(targetLocator), symlinkPolicy: 'reject' })
    await symlink(targetDir, linkedDir)
    const locator = join(linkedDir, 'evidence.txt')

    await expect(captureLocalFileEvidence({ locator, symlinkPolicy: 'reject' }))
      .rejects.toMatchObject({ code: 'EVIDENCE_SYMLINK_REJECTED' })
    await expect(captureLocalFileEvidence({ locator, symlinkPolicy: 'resolve' }))
      .resolves.toMatchObject({ locator: await realpath(locator), symlinkPolicy: 'resolve' })
  })

  it('normalizes EvidenceRef set order into one immutable deterministic EvidenceContext', async () => {
    const firstPath = join(tempDir, 'b.txt')
    const secondPath = join(tempDir, 'a.txt')
    await writeFile(firstPath, 'bravo', 'utf-8')
    await writeFile(secondPath, 'alpha', 'utf-8')
    const firstRef = await captureLocalFileEvidence({ locator: firstPath, observedAt: '2026-08-09T08:00:00.000Z' })
    const secondRef = await captureLocalFileEvidence({ locator: secondPath, observedAt: '2026-08-09T08:00:01.000Z' })

    const forward = await createEvidenceContext({ evidenceRefs: [firstRef, secondRef, firstRef] })
    const reverse = await createEvidenceContext({ evidenceRefs: [secondRef, firstRef] })

    expect(forward.id).toMatch(/^evidence-context:sha256:[a-f0-9]{64}$/)
    expect(forward.snapshotDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(forward.id).toBe(reverse.id)
    expect(forward.snapshotDigest).toBe(reverse.snapshotDigest)
    expect(forward.evidenceRefs).toHaveLength(2)
    expect(forward.evidenceRefs.map(ref => ref.id)).toEqual([...forward.evidenceRefs.map(ref => ref.id)].sort())
    expect(Object.isFrozen(forward)).toBe(true)
    expect(Object.isFrozen(forward.evidenceRefs)).toBe(true)
    expect(forward.evidenceRefs.every(Object.isFrozen)).toBe(true)
    await expect(resolveEvidenceContext(forward)).resolves.toEqual(forward)

    await expect(resolveEvidenceContext({
      ...reverse,
      snapshotDigest: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'EVIDENCE_CONTEXT_MISMATCH' })

    await writeFile(firstPath, 'changed', 'utf-8')
    await expect(resolveEvidenceContext(forward)).rejects.toMatchObject({ code: 'EVIDENCE_DIGEST_DRIFT' })
  })
})

describe('Invariant Spine F0 WorkCase execution bridge', () => {
  let tempDir = ''
  let server: Server | undefined
  let baseUrl = ''
  let redirectTargetUrl = ''
  let calls: Array<{ method: string; url: string; body: string }> = []

  beforeEach(async () => {
    resetJobSupervisor()
    calls = []
    redirectTargetUrl = ''
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'owlcoda-invariant-f0-workcase-')))
    server = createServer((req, res) => {
      let body = ''
      req.on('data', chunk => { body += String(chunk) })
      req.on('end', () => {
        calls.push({ method: req.method ?? 'GET', url: req.url ?? '/', body })
        res.setHeader('content-type', 'application/json; charset=utf-8')
        if (req.url === '/slow') return
        if (req.url === '/redirect') {
          res.statusCode = 302
          res.setHeader('location', redirectTargetUrl)
          res.end(JSON.stringify({ redirect: redirectTargetUrl }))
          return
        }
        if (req.url === '/failed') {
          res.statusCode = 503
          res.end(JSON.stringify({ ok: false, reason: 'fixture failure' }))
          return
        }
        res.end(JSON.stringify({
          ok: true,
          rows: Array.from({ length: 32 }, (_, index) => ({ index, value: `fixture-${index}` })),
        }))
      })
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    resetJobSupervisor()
    await new Promise<void>(resolve => server?.close(() => resolve()))
    server = undefined
    await rm(tempDir, { recursive: true, force: true })
  })

  async function makeFixture(ids: { workCaseId: string; workspaceRunId: string }) {
    const evidencePath = join(tempDir, `${ids.workCaseId}.json`)
    await writeFile(evidencePath, JSON.stringify({ source: 'local-fixture' }), 'utf-8')
    const evidenceRef = await captureLocalFileEvidence({
      locator: evidencePath,
      observedAt: '2026-08-09T08:00:00.000Z',
    })
    const evidenceContext = await createEvidenceContext({ evidenceRefs: [evidenceRef] })
    const workCase = createWorkCase({
      id: ids.workCaseId,
      objective: 'Read local fixture evidence through the generic workflow runtime.',
      evidenceContextRef: evidenceContext.id,
      executionMode: 'local_read_only',
      createdAt: '2026-08-09T08:00:02.000Z',
      opaqueDomainPayloadRef: 'opaque://fixture/payload-1',
    })
    const outputRoot = join(tempDir, `${ids.workCaseId}-output`)
    const workspace = await createRunWorkspace({
      outputRoot,
      cwd: tempDir,
      runId: ids.workspaceRunId,
      taskFamily: 'research',
    })
    return { evidencePath, evidenceContext, workCase, outputRoot, workspace }
  }

  it('keeps WorkCase as an immutable thin domain-neutral envelope', async () => {
    const { evidenceContext } = await makeFixture({ workCaseId: 'work-case-envelope', workspaceRunId: 'workspace-envelope' })
    const workCase = createWorkCase({
      id: 'work-case-thin',
      objective: 'Read evidence.',
      evidenceContextRef: evidenceContext.id,
      executionMode: 'local_read_only',
      createdAt: '2026-08-09T08:00:02.000Z',
      opaqueDomainPayloadRef: 'opaque://payload',
    })

    expect(Object.keys(workCase).sort()).toEqual([
      'createdAt',
      'evidenceContextRef',
      'executionMode',
      'id',
      'objective',
      'opaqueDomainPayloadRef',
      'schemaVersion',
      'state',
    ])
    expect(workCase).toMatchObject({ state: 'created', executionMode: 'local_read_only' })
    expect(Object.isFrozen(workCase)).toBe(true)
    expect(() => createWorkCase({
      id: 'work-case-domain-leak',
      objective: 'Reject a domain field.',
      evidenceContextRef: evidenceContext.id,
      executionMode: 'local_read_only',
      createdAt: '2026-08-09T08:00:02.000Z',
      matchId: 'domain-field-is-not-allowed',
    } as any)).toThrow(expect.objectContaining({ code: 'WORK_CASE_INVALID' }))
  })

  it('submits a local GET through Runtime Execution Control and registers every bridge artifact to one active workspace', async () => {
    const fixture = await makeFixture({ workCaseId: 'work-case-success', workspaceRunId: 'workspace-run-success' })

    const result = await executeWorkCase({
      workCase: fixture.workCase,
      evidenceContext: fixture.evidenceContext,
      executionRunId: 'execution-run-success',
      runRef: fixture.workspace.paths.runDir,
      cwd: tempDir,
      workflowPlan: {
        plan_version: 'invariant-f0.test',
        base_url: baseUrl,
        steps: [{
          id: 'read_local_fixture',
          method: 'GET',
          url: '/evidence',
          expected_status: 200,
          max_response_bytes: 80,
        }],
      },
    })

    expect(result.receipt).toMatchObject({
      schemaVersion: 1,
      kind: 'work_case_execution_correlation_receipt',
      status: 'completed',
      workCaseId: fixture.workCase.id,
      evidenceContextId: fixture.evidenceContext.id,
      executionRunId: 'execution-run-success',
      driverId: OWLCODA_NATIVE_DRIVER_ID,
      executionId: expect.stringMatching(/^runtime-execution:/),
      attemptId: expect.stringMatching(/^runtime-attempt:/),
      driverSessionId: expect.stringMatching(/^owlcoda-native-session:/),
      runId: 'execution-run-success',
      jobId: result.job.jobId,
      workspaceRunId: 'workspace-run-success',
      executionMode: 'local_read_only',
      productionWriteCount: 0,
      evidenceContextSnapshotRef: expect.stringContaining('evidence-context-snapshot.json'),
      workflowReceiptRef: expect.stringContaining('receipt.json'),
      workflowArtifactRefs: expect.arrayContaining([
        expect.stringContaining('plan.json'),
        expect.stringContaining('read_local_fixture.response.json'),
      ]),
    })
    expect(result.job).toMatchObject({
      type: 'workflow',
      status: 'completed',
      stage: 'completed',
      tool: 'WorkCaseExecution',
      provider: OWLCODA_NATIVE_DRIVER_ID,
      startedAt: expect.any(String),
      endedAt: expect.any(String),
      factRefs: {
        runId: 'workspace-run-success',
        workCaseId: fixture.workCase.id,
        evidenceContextId: fixture.evidenceContext.id,
        executionRunId: 'execution-run-success',
        driverId: OWLCODA_NATIVE_DRIVER_ID,
        executionId: result.receipt.executionId,
        attemptId: result.receipt.attemptId,
        driverSessionId: result.receipt.driverSessionId,
        workspaceRunId: 'workspace-run-success',
        jobId: result.job.jobId,
      },
    })
    expect(result.runtimeExecutionResult).toMatchObject({
      status: 'completed',
      driverId: OWLCODA_NATIVE_DRIVER_ID,
      executionId: result.receipt.executionId,
      attemptId: result.receipt.attemptId,
      driverSessionId: result.receipt.driverSessionId,
      correlationRefs: {
        correlationId: 'execution-run-success',
        nativeRunId: 'execution-run-success',
        receiptRef: result.receipt.workflowReceiptRef,
      },
    })
    expect(new Set([
      result.receipt.executionId,
      result.receipt.attemptId,
      result.receipt.driverSessionId,
    ]).size).toBe(3)
    expect(calls).toEqual([{ method: 'GET', url: '/evidence', body: '' }])
    expect(calls.some(call => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(call.method))).toBe(false)

    const roundTrip = JSON.parse(await readFile(result.receiptPath, 'utf-8'))
    expect(roundTrip).toEqual(result.receipt)
    const ledger = await readArtifactLedger(fixture.workspace.paths.runDir, { refresh: true }, tempDir)
    expect(ledger.artifacts.map(artifact => artifact.artifactType)).toEqual(expect.arrayContaining([
      'evidence_context_snapshot',
      'workflow_plan',
      'workflow_receipt',
      'workflow_response',
      'work_case_execution_receipt',
    ]))
    expect(ledger.artifacts.every(artifact => artifact.runId === 'workspace-run-success')).toBe(true)
    expect(ledger.artifacts.every(artifact => artifact.jobId === result.job.jobId)).toBe(true)
    expect(ledger.artifacts.every(artifact => artifact.factRefs?.workCaseId === fixture.workCase.id)).toBe(true)
    expect(ledger.artifacts.every(artifact => artifact.factRefs?.driverId === OWLCODA_NATIVE_DRIVER_ID)).toBe(true)
    expect(ledger.artifacts.every(artifact => artifact.factRefs?.executionId === result.receipt.executionId)).toBe(true)
    expect(ledger.artifacts.every(artifact => artifact.factRefs?.attemptId === result.receipt.attemptId)).toBe(true)
    expect(ledger.artifacts.every(artifact => artifact.factRefs?.driverSessionId === result.receipt.driverSessionId)).toBe(true)
    expect(new Set(ledger.artifacts.map(artifact => artifact.factRefs?.workspaceRunId))).toEqual(new Set(['workspace-run-success']))
    expect(new Set(result.job.artifacts.map(artifact => artifact.id))).toEqual(new Set(ledger.artifacts.map(artifact => artifact.id)))
    const evidenceSnapshotRecord = ledger.artifacts.find(artifact => artifact.artifactType === 'evidence_context_snapshot')
    expect(evidenceSnapshotRecord).toMatchObject({
      status: 'present',
      runId: 'workspace-run-success',
      jobId: result.job.jobId,
      factRefs: {
        workCaseId: fixture.workCase.id,
        evidenceContextId: fixture.evidenceContext.id,
        executionRunId: 'execution-run-success',
        driverId: OWLCODA_NATIVE_DRIVER_ID,
        executionId: result.receipt.executionId,
        attemptId: result.receipt.attemptId,
        driverSessionId: result.receipt.driverSessionId,
        workspaceRunId: 'workspace-run-success',
        artifactId: expect.any(String),
        artifactPath: expect.stringContaining('evidence-context-snapshot.json'),
      },
    })
    const evidenceSnapshot = JSON.parse(await readFile(evidenceSnapshotRecord!.path, 'utf-8'))
    expect(evidenceSnapshot).toMatchObject({
      schemaVersion: 1,
      kind: 'evidence_context_snapshot',
      status: 'validated',
      workCaseId: fixture.workCase.id,
      evidenceContextId: fixture.evidenceContext.id,
      executionRunId: 'execution-run-success',
      driverId: OWLCODA_NATIVE_DRIVER_ID,
      executionId: result.receipt.executionId,
      attemptId: result.receipt.attemptId,
      driverSessionId: result.receipt.driverSessionId,
      workspaceRunId: 'workspace-run-success',
      jobId: result.job.jobId,
      evidenceContext: fixture.evidenceContext,
    })
    expect(new Set([
      result.receipt.driverSessionId,
      result.runtimeExecutionResult?.driverSessionId,
      result.job.factRefs?.driverSessionId,
      evidenceSnapshotRecord?.factRefs?.driverSessionId,
      evidenceSnapshot.driverSessionId,
    ])).toEqual(new Set([result.receipt.driverSessionId]))
    const successEvents = await readJsonLines(fixture.workspace.paths.eventsPath)
    expect(successEvents).toContainEqual(expect.objectContaining({
      type: 'work_case_execution_completed',
      factRefs: expect.objectContaining({
        workCaseId: fixture.workCase.id,
        evidenceContextId: fixture.evidenceContext.id,
        executionRunId: 'execution-run-success',
        driverId: OWLCODA_NATIVE_DRIVER_ID,
        executionId: result.receipt.executionId,
        attemptId: result.receipt.attemptId,
        driverSessionId: result.receipt.driverSessionId,
        workspaceRunId: 'workspace-run-success',
        jobId: result.job.jobId,
      }),
      data: expect.objectContaining({
        driverId: OWLCODA_NATIVE_DRIVER_ID,
        executionId: result.receipt.executionId,
        attemptId: result.receipt.attemptId,
        driverSessionId: result.receipt.driverSessionId,
        evidenceContextSnapshotRef: evidenceSnapshotRecord!.path,
      }),
    }))
  })

  it('records human adjudication and emits a verified, no-writeback outcome only from positive final decisions', async () => {
    const fixture = await makeFixture({
      workCaseId: 'work-case-human-tail',
      workspaceRunId: 'workspace-run-human-tail',
    })
    const execution = await executeWorkCase({
      workCase: fixture.workCase,
      evidenceContext: fixture.evidenceContext,
      executionRunId: 'execution-run-human-tail',
      runRef: fixture.workspace.paths.runDir,
      cwd: tempDir,
      workflowPlan: {
        plan_version: 'invariant-f0.human-tail.test',
        base_url: baseUrl,
        steps: [{
          id: 'read_for_human_review',
          method: 'GET',
          url: '/evidence',
          expected_status: 200,
          max_response_bytes: 80,
        }],
      },
    })
    const findingOrArtifactRef = execution.receipt.workflowArtifactRefs.find(ref =>
      ref.endsWith('read_for_human_review.response.json'))
    expect(findingOrArtifactRef).toBeTruthy()

    const correctedArtifactRef = join(fixture.workspace.paths.finalDir, 'human-corrected-result.json')
    await writeFile(correctedArtifactRef, '{"corrected":true}\n', 'utf-8')
    await recordArtifact(fixture.workspace.paths.runDir, {
      path: correctedArtifactRef,
      origin: 'human_adjudication',
      runId: execution.receipt.workspaceRunId,
      jobId: execution.receipt.jobId,
      factRefs: {
        workCaseId: execution.receipt.workCaseId,
        evidenceContextId: execution.receipt.evidenceContextId,
        executionRunId: execution.receipt.executionRunId,
        driverId: execution.receipt.driverId,
        executionId: execution.receipt.executionId,
        attemptId: execution.receipt.attemptId,
        driverSessionId: execution.receipt.driverSessionId,
        workspaceRunId: execution.receipt.workspaceRunId,
      },
      artifactType: 'human_corrected_artifact',
      participatesInFinal: true,
    }, tempDir)

    const common = {
      execution: { receipt: execution.receipt, receiptPath: execution.receiptPath },
      findingOrArtifactRef: findingOrArtifactRef!,
      adjudicatorRef: 'human://owner/owlcoda',
      runRef: fixture.workspace.paths.runDir,
      cwd: tempDir,
    }
    const accepted = await recordAdjudicationReceipt({
      ...common,
      disposition: 'accept',
      note: 'The runtime artifact is supported by the frozen evidence.',
      timestamp: '2026-08-10T09:00:00.000Z',
    })
    const corrected = await recordAdjudicationReceipt({
      ...common,
      disposition: 'correct',
      note: 'Use the human-corrected artifact as the final result.',
      correctedArtifactRef,
      timestamp: '2026-08-10T09:01:00.000Z',
    })
    const rejected = await recordAdjudicationReceipt({
      ...common,
      disposition: 'reject',
      note: 'Rejected receipt retained as append-only audit history.',
      timestamp: '2026-08-10T09:02:00.000Z',
    })
    const needsEvidence = await recordAdjudicationReceipt({
      ...common,
      disposition: 'need_evidence',
      note: 'Need-evidence receipt retained as append-only audit history.',
      timestamp: '2026-08-10T09:03:00.000Z',
    })

    for (const recorded of [accepted, corrected, rejected, needsEvidence]) {
      expect(recorded.receipt.id).toMatch(/^adjudication-receipt:sha256:[a-f0-9]{64}$/)
      expect(recorded.receipt).toMatchObject({
        schemaVersion: 1,
        kind: 'adjudication_receipt',
        workCaseId: execution.receipt.workCaseId,
        evidenceSnapshotRef: execution.receipt.evidenceContextSnapshotRef,
        runRef: execution.receipt.executionRunId,
        findingOrArtifactRef,
        findingOrArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        adjudicatorRef: 'human://owner/owlcoda',
      })
      expect(Object.isFrozen(recorded.receipt)).toBe(true)
      expect(JSON.parse(await readFile(recorded.receiptPath, 'utf-8'))).toEqual(recorded.receipt)
    }
    expect(corrected.receipt.correctedArtifactRef).toBe(correctedArtifactRef)
    expect(corrected.receipt.correctedArtifactSha256).toMatch(/^[a-f0-9]{64}$/)
    const acceptedReplay = await recordAdjudicationReceipt({
      ...common,
      disposition: 'accept',
      note: 'The runtime artifact is supported by the frozen evidence.',
      timestamp: '2026-08-10T09:00:00.000Z',
    })
    expect(acceptedReplay.receipt.id).toBe(accepted.receipt.id)
    expect(acceptedReplay.receiptPath).toBe(accepted.receiptPath)
    await expect(recordAdjudicationReceipt({
      ...common,
      disposition: 'correct',
      note: 'A correction without a corrected artifact is invalid.',
      timestamp: '2026-08-10T09:04:00.000Z',
    })).rejects.toMatchObject({ code: 'ADJUDICATION_INVALID' })

    const outcomeInput = {
      executionReceipt: execution.receipt,
      resultArtifactRefs: [correctedArtifactRef],
      verifiedAt: '2026-08-10T09:05:00.000Z',
    }
    expect(() => createVerifiedOutcome({
      ...outcomeInput,
      adjudicationReceipts: [],
    })).toThrow(expect.objectContaining({ code: 'VERIFIED_OUTCOME_BLOCKED' }))
    expect(createVerifiedOutcome({
      ...outcomeInput,
      adjudicationReceipts: [accepted.receipt],
      resultArtifactRefs: [findingOrArtifactRef!],
    })).toMatchObject({
      verificationStatus: 'verified',
      resultArtifactRefs: [findingOrArtifactRef],
      systemOfRecordWriteBack: false,
    })
    expect(() => createVerifiedOutcome({
      ...outcomeInput,
      adjudicationReceipts: [rejected.receipt],
    })).toThrow(expect.objectContaining({ code: 'VERIFIED_OUTCOME_BLOCKED' }))
    expect(() => createVerifiedOutcome({
      ...outcomeInput,
      adjudicationReceipts: [needsEvidence.receipt],
    })).toThrow(expect.objectContaining({ code: 'VERIFIED_OUTCOME_BLOCKED' }))
    expect(() => createVerifiedOutcome({
      ...outcomeInput,
      executionReceipt: { ...execution.receipt, status: 'failed' },
      adjudicationReceipts: [corrected.receipt],
    })).toThrow(expect.objectContaining({ code: 'VERIFIED_OUTCOME_BLOCKED' }))
    expect(() => createVerifiedOutcome({
      ...outcomeInput,
      resultArtifactRefs: [findingOrArtifactRef!],
      adjudicationReceipts: [corrected.receipt],
    })).toThrow(expect.objectContaining({ code: 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH' }))

    const recordedOutcome = await recordVerifiedOutcome({
      execution: { receipt: execution.receipt, receiptPath: execution.receiptPath },
      adjudications: [corrected],
      resultArtifactRefs: [correctedArtifactRef],
      verifiedAt: '2026-08-10T09:05:00.000Z',
      runRef: fixture.workspace.paths.runDir,
      cwd: tempDir,
    })
    expect(recordedOutcome.outcome).toEqual({
      schemaVersion: 1,
      kind: 'verified_outcome',
      outcomeId: expect.stringMatching(/^verified-outcome:sha256:[a-f0-9]{64}$/),
      workCaseId: execution.receipt.workCaseId,
      evidenceSnapshotRef: execution.receipt.evidenceContextSnapshotRef,
      runRef: execution.receipt.executionRunId,
      adjudicationRefs: [corrected.receipt.id],
      verificationStatus: 'verified',
      resultArtifactRefs: [correctedArtifactRef],
      resultArtifactBindings: [{
        ref: correctedArtifactRef,
        sha256: corrected.receipt.correctedArtifactSha256,
      }],
      verifiedAt: '2026-08-10T09:05:00.000Z',
      systemOfRecordWriteBack: false,
    })
    expect(Object.isFrozen(recordedOutcome.outcome)).toBe(true)
    expect(Object.isFrozen(recordedOutcome.outcome.adjudicationRefs)).toBe(true)
    expect(JSON.parse(await readFile(recordedOutcome.outcomePath, 'utf-8'))).toEqual(recordedOutcome.outcome)

    await writeFile(correctedArtifactRef, '{"corrected":"drifted-after-adjudication"}\n', 'utf-8')
    await expect(recordVerifiedOutcome({
      execution: { receipt: execution.receipt, receiptPath: execution.receiptPath },
      adjudications: [corrected],
      resultArtifactRefs: [correctedArtifactRef],
      verifiedAt: '2026-08-10T09:06:00.000Z',
      runRef: fixture.workspace.paths.runDir,
      cwd: tempDir,
    })).rejects.toMatchObject({ code: 'VERIFIED_OUTCOME_PROVENANCE_MISMATCH' })

    const ledger = await readArtifactLedger(fixture.workspace.paths.runDir, { refresh: true }, tempDir)
    expect(ledger.artifacts.filter(artifact => artifact.artifactType === 'adjudication_receipt')).toHaveLength(4)
    expect(ledger.artifacts).toContainEqual(expect.objectContaining({
      id: recordedOutcome.outcome.outcomeId,
      path: recordedOutcome.outcomePath,
      artifactType: 'verified_outcome',
      participatesInFinal: true,
      status: 'present',
      factRefs: expect.objectContaining({
        workCaseId: execution.receipt.workCaseId,
        evidenceContextId: execution.receipt.evidenceContextId,
        executionRunId: execution.receipt.executionRunId,
        executionId: execution.receipt.executionId,
        attemptId: execution.receipt.attemptId,
        driverSessionId: execution.receipt.driverSessionId,
        workspaceRunId: execution.receipt.workspaceRunId,
      }),
    }))
  })

  it('retains inspectable failed and cancelled workflow evidence with correlated Job state', async () => {
    const failedFixture = await makeFixture({ workCaseId: 'work-case-failed', workspaceRunId: 'workspace-run-failed' })
    const failed = await executeWorkCase({
      workCase: failedFixture.workCase,
      evidenceContext: failedFixture.evidenceContext,
      executionRunId: 'execution-run-failed',
      runRef: failedFixture.workspace.paths.runDir,
      cwd: tempDir,
      workflowPlan: {
        base_url: baseUrl,
        steps: [{ id: 'read_failure', method: 'GET', url: '/failed', expected_status: 200 }],
      },
    })

    expect(failed.receipt).toMatchObject({
      status: 'failed',
      driverId: OWLCODA_NATIVE_DRIVER_ID,
      executionId: expect.stringMatching(/^runtime-execution:/),
      attemptId: expect.stringMatching(/^runtime-attempt:/),
      driverSessionId: expect.stringMatching(/^owlcoda-native-session:/),
      failure: { code: 'WORKFLOW_ACCEPTANCE_FAILED' },
      workflowReceiptRef: expect.stringContaining('receipt.json'),
      productionWriteCount: 0,
    })
    expect(failed.runtimeExecutionResult).toMatchObject({
      status: 'failed',
      driverId: failed.receipt.driverId,
      executionId: failed.receipt.executionId,
      attemptId: failed.receipt.attemptId,
      driverSessionId: failed.receipt.driverSessionId,
      correlationRefs: { nativeRunId: 'execution-run-failed' },
    })
    expect(failed.job).toMatchObject({
      status: 'failed',
      stage: 'failed',
      endedAt: expect.any(String),
      factRefs: { driverSessionId: failed.receipt.driverSessionId },
    })
    expect(await readArtifactLedger(failedFixture.workspace.paths.runDir, {}, tempDir)).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifactType: 'workflow_receipt', status: 'present' }),
        expect.objectContaining({ artifactType: 'work_case_execution_receipt', status: 'present' }),
      ]),
    })

    const cancelledFixture = await makeFixture({ workCaseId: 'work-case-cancelled', workspaceRunId: 'workspace-run-cancelled' })
    const pending = executeWorkCase({
      workCase: cancelledFixture.workCase,
      evidenceContext: cancelledFixture.evidenceContext,
      executionRunId: 'execution-run-cancelled',
      runRef: cancelledFixture.workspace.paths.runDir,
      cwd: tempDir,
      workflowPlan: {
        base_url: baseUrl,
        steps: [{ id: 'read_slow', method: 'GET', url: '/slow', expected_status: 200 }],
      },
    })
    const runningJob = await waitForRunningWorkCaseJob('execution-run-cancelled')
    const cancelledResult = await createJobCancelTool().execute({ jobId: runningJob.jobId, reason: 'test_cancel' })
    expect(cancelledResult.isError).toBe(false)
    const cancelled = await pending

    expect(cancelled.receipt).toMatchObject({
      status: 'cancelled',
      driverId: OWLCODA_NATIVE_DRIVER_ID,
      executionId: expect.stringMatching(/^runtime-execution:/),
      attemptId: expect.stringMatching(/^runtime-attempt:/),
      driverSessionId: expect.stringMatching(/^owlcoda-native-session:/),
      failure: { code: 'WORK_CASE_EXECUTION_CANCELLED' },
      productionWriteCount: 0,
    })
    expect(cancelled.runtimeExecutionResult).toMatchObject({
      status: 'cancelled',
      driverId: cancelled.receipt.driverId,
      executionId: cancelled.receipt.executionId,
      attemptId: cancelled.receipt.attemptId,
      driverSessionId: cancelled.receipt.driverSessionId,
      correlationRefs: { nativeRunId: 'execution-run-cancelled' },
    })
    expect(cancelled.job).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
      terminationReason: 'test_cancel',
      cleanupAttempted: true,
      cleanupSucceeded: true,
      factRefs: { driverSessionId: cancelled.receipt.driverSessionId },
    })
    expect(getJob(cancelled.job.jobId)?.status).toBe('cancelled')
    expect(await readArtifactLedger(cancelledFixture.workspace.paths.runDir, {}, tempDir)).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifactType: 'workflow_receipt', status: 'present' }),
        expect.objectContaining({ artifactType: 'work_case_execution_receipt', status: 'present' }),
      ]),
    })
  })

  it('fails closed before endpoint execution on evidence drift, a business-write method, or a non-local endpoint', async () => {
    const driftFixture = await makeFixture({ workCaseId: 'work-case-drift', workspaceRunId: 'workspace-run-drift' })
    await writeFile(driftFixture.evidencePath, '{"source":"changed"}', 'utf-8')
    const drift = await executeWorkCase({
      workCase: driftFixture.workCase,
      evidenceContext: driftFixture.evidenceContext,
      executionRunId: 'execution-run-drift',
      runRef: driftFixture.workspace.paths.runDir,
      cwd: tempDir,
      workflowPlan: {
        base_url: baseUrl,
        steps: [{ id: 'must_not_run', method: 'GET', url: '/evidence' }],
      },
    })

    expect(drift.receipt).toMatchObject({
      status: 'failed',
      failure: { code: 'EVIDENCE_DIGEST_DRIFT' },
      productionWriteCount: 0,
      evidenceContextSnapshotRef: expect.stringContaining('evidence-context-snapshot.json'),
      registeredArtifactRefs: [expect.objectContaining({ artifactType: 'evidence_context_snapshot' })],
    })
    expect(drift.job.status).toBe('failed')
    expect(calls).toEqual([])
    const driftLedger = await readArtifactLedger(driftFixture.workspace.paths.runDir, {}, tempDir)
    expect(driftLedger).toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({ artifactType: 'evidence_context_snapshot', status: 'present' }),
        expect.objectContaining({ artifactType: 'work_case_execution_receipt', status: 'present' }),
      ]),
    })
    expect(driftLedger.artifacts).toHaveLength(2)
    expect(driftLedger.artifacts.every(artifact => artifact.factRefs?.executionRunId === 'execution-run-drift')).toBe(true)
    const attemptedSnapshot = driftLedger.artifacts.find(artifact => artifact.artifactType === 'evidence_context_snapshot')
    expect(JSON.parse(await readFile(attemptedSnapshot!.path, 'utf-8'))).toMatchObject({
      schemaVersion: 1,
      kind: 'evidence_context_snapshot',
      status: 'attempted',
      workCaseId: driftFixture.workCase.id,
      evidenceContextId: driftFixture.evidenceContext.id,
      executionRunId: 'execution-run-drift',
      workspaceRunId: 'workspace-run-drift',
      jobId: drift.job.jobId,
      evidenceContext: driftFixture.evidenceContext,
      failure: { code: 'EVIDENCE_DIGEST_DRIFT' },
    })
    const driftEvents = await readJsonLines(driftFixture.workspace.paths.eventsPath)
    expect(driftEvents).toContainEqual(expect.objectContaining({
      type: 'work_case_execution_failed',
      factRefs: expect.objectContaining({
        workCaseId: driftFixture.workCase.id,
        evidenceContextId: driftFixture.evidenceContext.id,
        executionRunId: 'execution-run-drift',
        workspaceRunId: 'workspace-run-drift',
        jobId: drift.job.jobId,
      }),
      data: expect.objectContaining({ evidenceContextSnapshotRef: attemptedSnapshot!.path }),
    }))

    const writeFixture = await makeFixture({ workCaseId: 'work-case-write', workspaceRunId: 'workspace-run-write' })
    const writeAttempt = await executeWorkCase({
      workCase: writeFixture.workCase,
      evidenceContext: writeFixture.evidenceContext,
      executionRunId: 'execution-run-write',
      runRef: writeFixture.workspace.paths.runDir,
      cwd: tempDir,
      workflowPlan: {
        base_url: baseUrl,
        steps: [{ id: 'forbidden_write', method: 'POST', url: '/evidence', body: { forbidden: true } }],
      },
    })

    expect(writeAttempt.receipt).toMatchObject({
      status: 'failed',
      failure: { code: 'WORK_CASE_EXECUTION_NOT_READ_ONLY' },
      productionWriteCount: 0,
    })
    expect(writeAttempt.job.status).toBe('failed')
    expect(calls).toEqual([])

    const remoteFixture = await makeFixture({ workCaseId: 'work-case-remote', workspaceRunId: 'workspace-run-remote' })
    const remoteAttempt = await executeWorkCase({
      workCase: remoteFixture.workCase,
      evidenceContext: remoteFixture.evidenceContext,
      executionRunId: 'execution-run-remote',
      runRef: remoteFixture.workspace.paths.runDir,
      cwd: tempDir,
      workflowPlan: {
        steps: [{ id: 'forbidden_remote_read', method: 'GET', url: 'https://example.com/evidence' }],
      },
    })

    expect(remoteAttempt.receipt).toMatchObject({
      status: 'failed',
      failure: { code: 'WORK_CASE_EXECUTION_NON_LOCAL_ENDPOINT' },
      productionWriteCount: 0,
    })
    expect(remoteAttempt.job.status).toBe('failed')
    expect(calls).toEqual([])
  })

  it('stops an unvalidated redirect before the rejected target receives a request', async () => {
    const redirectedCalls: string[] = []
    const redirectedServer = createServer((req, res) => {
      redirectedCalls.push(req.url ?? '/')
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ reached: true }))
    })
    await new Promise<void>(resolve => redirectedServer.listen(0, '127.0.0.1', resolve))
    try {
      const address = redirectedServer.address()
      if (!address || typeof address === 'string') throw new Error('redirected server did not bind')
      redirectTargetUrl = `http://0.0.0.0:${address.port}/must-not-run`
      const fixture = await makeFixture({ workCaseId: 'work-case-redirect', workspaceRunId: 'workspace-run-redirect' })

      const result = await executeWorkCase({
        workCase: fixture.workCase,
        evidenceContext: fixture.evidenceContext,
        executionRunId: 'execution-run-redirect',
        runRef: fixture.workspace.paths.runDir,
        cwd: tempDir,
        workflowPlan: {
          base_url: baseUrl,
          steps: [{ id: 'redirect_must_stop', method: 'GET', url: '/redirect', expected_status: 200 }],
        },
      })

      expect(result.receipt).toMatchObject({
        status: 'failed',
        failure: { code: 'WORKFLOW_ACCEPTANCE_FAILED' },
        productionWriteCount: 0,
      })
      expect(result.workflowResult?.receipt.endpoint_calls).toEqual([
        expect.objectContaining({
          step_id: 'redirect_must_stop',
          status_code: 302,
          ok: false,
          url: `${baseUrl}/redirect`,
        }),
      ])
      expect(calls).toEqual([{ method: 'GET', url: '/redirect', body: '' }])
      expect(redirectedCalls).toEqual([])
    } finally {
      await new Promise<void>(resolve => redirectedServer.close(() => resolve()))
    }
  })
})

async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path, 'utf-8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

async function waitForRunningWorkCaseJob(executionRunId: string) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const job = listJobs().find(candidate =>
      candidate.type === 'workflow'
      && candidate.status === 'running'
      && candidate.factRefs?.executionRunId === executionRunId,
    )
    if (job) return job
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`work case job did not reach running state: ${executionRunId}`)
}
