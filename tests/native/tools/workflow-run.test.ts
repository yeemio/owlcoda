import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createWorkflowRunTool } from '../../../src/native/tools/workflow-run.js'
import { issueToolApprovedWorkflowRuntimeGrant } from '../../../src/native/runtime-execution-control/grants.js'
import {
  runWorkflow,
  type WorkflowRunInput,
} from '../../../src/native/workflow-runner.js'
import { NATIVE_TOOL_SCHEMAS } from '../../../src/native/tool-defs.js'

describe('WorkflowRun native tool', () => {
  let server: Server | undefined
  let baseUrl = ''
  let tempDir = ''
  let calls: Array<{ method: string; url: string; body: string; headers: Record<string, string | string[] | undefined> }> = []
  let flakyStatus = 500
  let grantSequence = 0
  let crossOriginRedirectUrl = ''

  async function executeGrantedWorkflow(input: WorkflowRunInput) {
    grantSequence += 1
    const runtimeExecutionGrant = await issueToolApprovedWorkflowRuntimeGrant({
      workflow: input,
      workspaceRoot: input.cwd ?? tempDir,
      toolUseId: `tool-workflow-test-${grantSequence}`,
      permissionState: 'granted',
      riskClass: 'external_effect',
      grantEvent: { ts: Date.now(), mode: 'user_prompt', iteration: grantSequence },
    })
    return await createWorkflowRunTool().execute(input, { runtimeExecutionGrant })
  }

  beforeEach(async () => {
    calls = []
    flakyStatus = 500
    grantSequence = 0
    crossOriginRedirectUrl = ''
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-workflow-run-'))
    server = createServer((req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += String(chunk) })
      req.on('end', () => {
        calls.push({ method: req.method ?? 'GET', url: req.url ?? '/', body: raw, headers: req.headers })
        res.setHeader('content-type', 'application/json; charset=utf-8')

        if (req.url === '/large') {
          res.end(JSON.stringify({
            summary: { status: 'ok', retained: true },
            rows: Array.from({ length: 80 }, (_, i) => ({ id: i, value: `row-${i}` })),
          }))
          return
        }

        if (req.url === '/redirect') {
          res.statusCode = 302
          res.setHeader('location', '/large')
          res.end(JSON.stringify({ redirect: '/large' }))
          return
        }

        if (req.url === '/cross-origin-redirect') {
          res.statusCode = 302
          res.setHeader('location', crossOriginRedirectUrl)
          res.end(JSON.stringify({ redirect: crossOriginRedirectUrl }))
          return
        }

        if (req.url === '/refresh') {
          res.end(JSON.stringify({ refreshed: true, received: raw ? JSON.parse(raw) : null }))
          return
        }

        if (req.url === '/workspace-binding') {
          res.end(JSON.stringify({
            ok: true,
            result: { status: 'complete', artifacts_written: [] },
            payload: 'x'.repeat(25_000),
          }))
          return
        }

        if (req.url === '/preflight') {
          res.end(JSON.stringify({ preflight: { first_action: null, action_count: 0 } }))
          return
        }

        if (req.url === '/flaky') {
          res.statusCode = flakyStatus
          res.end(JSON.stringify({
            ok: flakyStatus >= 200 && flakyStatus < 300,
            status: flakyStatus,
          }))
          return
        }

        if (req.url === '/capture') {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'capture should have been skipped' }))
          return
        }

        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      })
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind to a port')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exposes a typed plan, receipt, and artifact schema', () => {
    const schema = NATIVE_TOOL_SCHEMAS['WorkflowRun'] as Record<string, any>
    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        plan: { type: 'object' },
        contractRef: { type: 'string' },
        baseUrl: { type: 'string' },
        runRef: { type: 'string' },
        taskRunId: { type: 'string' },
        receiptPath: { type: 'string' },
        artifactDir: { type: 'string' },
      },
    })
  })

  it('fails closed before the endpoint when no product runtime grant is present', async () => {
    const result = await createWorkflowRunTool().execute({
      cwd: tempDir,
      plan: {
        run_id: 'wf-without-runtime-grant',
        base_url: baseUrl,
        steps: [{ id: 'must_not_run', method: 'POST', url: '/refresh', body: { denied: true } }],
      },
    })

    expect(result).toMatchObject({
      isError: true,
      metadata: {
        failureCategory: 'workflow:runtime_authorization_required',
      },
    })
    expect(calls).toEqual([])
  })

  it.each(['terminal', 'ancestor'] as const)(
    'fails closed before endpoint or output writes when an approved %s workspace symlink is retargeted',
    async symlinkKind => {
      const caseRoot = join(tempDir, `workspace-identity-${symlinkKind}`)
      const approvedWorkspace = symlinkKind === 'terminal'
        ? join(caseRoot, 'approved-target-a')
        : join(caseRoot, 'approved-ancestor-a', 'workspace')
      const retargetedWorkspace = symlinkKind === 'terminal'
        ? join(caseRoot, 'retargeted-target-b')
        : join(caseRoot, 'retargeted-ancestor-b', 'workspace')
      const workspaceLink = symlinkKind === 'terminal'
        ? join(caseRoot, 'workspace-link')
        : join(caseRoot, 'ancestor-link')
      const lexicalWorkspace = symlinkKind === 'terminal'
        ? workspaceLink
        : join(workspaceLink, 'workspace')
      const approvedLinkTarget = symlinkKind === 'terminal'
        ? approvedWorkspace
        : join(caseRoot, 'approved-ancestor-a')
      const retargetedLinkTarget = symlinkKind === 'terminal'
        ? retargetedWorkspace
        : join(caseRoot, 'retargeted-ancestor-b')
      await Promise.all([
        mkdir(approvedWorkspace, { recursive: true }),
        mkdir(retargetedWorkspace, { recursive: true }),
      ])
      await symlink(approvedLinkTarget, workspaceLink, 'dir')

      const contractContent = `${JSON.stringify({
        artifact_version: 'match-harness-task-contract.v1',
        matchId: 'workspace-binding',
        stamp: '2026-08-09T00-00-00-000Z',
        runRef: 'owlcoda://workspace-binding',
        task_queue: [{
          task_id: 'workspace-binding-task',
          task_name: 'workspace.binding.execute',
          order: 1,
          status: 'pending',
          writes: [],
          execution: {
            method: 'POST',
            endpoint: '/workspace-binding',
            request: { approved: true },
          },
        }],
      })}\n`
      await Promise.all([
        writeFile(join(approvedWorkspace, 'contract.json'), contractContent, 'utf8'),
        writeFile(join(retargetedWorkspace, 'contract.json'), contractContent, 'utf8'),
      ])

      const taskRunId = `workspace-binding-${symlinkKind}`
      const input: WorkflowRunInput = {
        cwd: lexicalWorkspace,
        contractRef: join(lexicalWorkspace, 'contract.json'),
        baseUrl,
        taskRunId,
        artifactDir: join(lexicalWorkspace, 'binding-artifacts'),
      }
      const runtimeExecutionGrant = await issueToolApprovedWorkflowRuntimeGrant({
        workflow: input,
        workspaceRoot: lexicalWorkspace,
        toolUseId: `tool-workspace-binding-${symlinkKind}`,
        permissionState: 'granted',
        riskClass: 'external_effect',
        grantEvent: { ts: Date.now(), mode: 'user_prompt', iteration: 1 },
      })

      await rm(workspaceLink)
      await symlink(retargetedLinkTarget, workspaceLink, 'dir')

      const result = await createWorkflowRunTool().execute(input, { runtimeExecutionGrant })
      expect.soft(result).toMatchObject({
        isError: true,
        metadata: {
          runtimeControlCode: 'RUNTIME_AUTHORIZATION_WORKSPACE_DRIFT',
        },
      })
      expect.soft(runtimeExecutionGrant.workspaceRoot).toBe(await realpath(approvedWorkspace))
      expect.soft(calls).toEqual([])
      expect.soft(existsSync(join(
        retargetedWorkspace,
        '.owlcoda-workflows',
        taskRunId,
        'receipt.json',
      ))).toBe(false)
      expect.soft(existsSync(join(retargetedWorkspace, 'binding-artifacts'))).toBe(false)
    },
  )

  it('executes HTTP steps, writes an invocation receipt, and compacts large responses into artifacts', async () => {
    const receiptPath = join(tempDir, 'receipt.json')
    const artifactDir = join(tempDir, 'artifacts')

    const result = await executeGrantedWorkflow({
      receiptPath,
      artifactDir,
      plan: {
        run_id: 'wf-native-1',
        plan_version: 'spec00.test',
        base_url: baseUrl,
        steps: [{
          id: 'fetch_latest',
          method: 'GET',
          url: '/large',
          required: true,
          expected_status: 200,
          projection: ['summary'],
          max_response_bytes: 160,
        }, {
          id: 'refresh_research',
          method: 'POST',
          url: '/refresh',
          required: true,
          body: { mode: 'refresh' },
          expected_status: 200,
          projection: ['refreshed'],
        }],
        acceptance: {
          required_endpoint_calls: 2,
          must_all_ok: true,
          must_write_receipt: true,
        },
      },
    })

    expect(result.isError).toBe(false)
    expect(result.output).toContain('WorkflowRun completed')
    expect(existsSync(receiptPath)).toBe(true)

    const receipt = JSON.parse(await readFile(receiptPath, 'utf-8'))
    expect(receipt).toMatchObject({
      run_id: 'wf-native-1',
      plan_version: 'spec00.test',
      required_steps_total: 2,
      required_steps_completed: 2,
      acceptance: 'pass',
      required_endpoint_calls: '2/2',
      failed_steps: [],
      skipped_steps: [],
    })
    expect(receipt.endpoint_calls).toHaveLength(2)
    expect(receipt.endpoint_calls[0]).toMatchObject({
      step_id: 'fetch_latest',
      method: 'GET',
      status_code: 200,
      ok: true,
      response_truncated: true,
      projected_response: {
        summary: { status: 'ok', retained: true },
      },
    })
    expect(receipt.endpoint_calls[0].response_artifact).toEqual(expect.stringContaining('fetch_latest'))
    expect(existsSync(receipt.endpoint_calls[0].response_artifact)).toBe(true)
    expect(await readFile(receipt.endpoint_calls[0].response_artifact, 'utf-8')).toContain('"rows"')
    expect(receipt.endpoint_calls[0].artifact_completeness).toMatchObject({
      expected: [],
      produced: [receipt.endpoint_calls[0].response_artifact],
      missing: [],
      validationStatus: 'pass',
      fallbackStatus: 'none',
    })
    expect(receipt.artifact_completeness).toMatchObject({
      validationStatus: 'pass',
      fallbackStatus: 'none',
      missing: [],
    })
    expect(receipt.artifact_completeness.produced).toEqual(expect.arrayContaining([
      receipt.endpoint_calls[0].response_artifact,
    ]))
    expect(receipt.consumer_readiness).toMatchObject({
      consumerReady: true,
      blockers: [],
      requiredArtifactsMissing: [],
      fallbackUsed: false,
      usable: true,
    })
    expect(calls.map(call => `${call.method} ${call.url}`)).toEqual(['GET /large', 'POST /refresh'])
  })

  it('preserves redirect following for ordinary generic WorkflowRun calls', async () => {
    const receiptPath = join(tempDir, 'redirect-receipt.json')
    const result = await executeGrantedWorkflow({
      receiptPath,
      artifactDir: join(tempDir, 'redirect-artifacts'),
      plan: {
        run_id: 'wf-redirect-default',
        base_url: baseUrl,
        steps: [{ id: 'follow_redirect', method: 'GET', url: '/redirect', expected_status: 200 }],
      },
    })

    expect(result.isError).toBe(false)
    expect(calls.map(call => call.url)).toEqual(['/redirect', '/large'])
    expect(JSON.parse(await readFile(receiptPath, 'utf-8'))).toMatchObject({
      acceptance: 'pass',
      endpoint_calls: [expect.objectContaining({
        step_id: 'follow_redirect',
        status_code: 200,
        ok: true,
      })],
    })
  })

  it('checks every redirect hop and refuses an origin that was not bound by the grant', async () => {
    let blockedOriginHits = 0
    const blockedServer = createServer((_req, res) => {
      blockedOriginHits += 1
      res.end(JSON.stringify({ shouldNotRun: true }))
    })
    try {
      await new Promise<void>(resolve => blockedServer.listen(0, '127.0.0.1', resolve))
      const address = blockedServer.address()
      if (!address || typeof address === 'string') throw new Error('blocked-origin fixture did not bind')
      crossOriginRedirectUrl = `http://127.0.0.1:${address.port}/blocked`
      const receiptPath = join(tempDir, 'cross-origin-redirect-receipt.json')

      const result = await executeGrantedWorkflow({
        cwd: tempDir,
        receiptPath,
        plan: {
          run_id: 'wf-cross-origin-redirect',
          base_url: baseUrl,
          steps: [{ id: 'cross_origin', method: 'GET', url: '/cross-origin-redirect', expected_status: 200 }],
        },
      })

      expect(result.isError).toBe(true)
      expect(calls.map(call => call.url)).toEqual(['/cross-origin-redirect'])
      expect(blockedOriginHits).toBe(0)
      expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({
        acceptance: 'fail',
        failed_steps: [{
          step_id: 'cross_origin',
          reason: expect.stringContaining('does not allow origin'),
        }],
      })
    } finally {
      await new Promise<void>(resolve => blockedServer.close(() => resolve()))
    }
  })

  it('sends step idempotency_key as an HTTP Idempotency-Key header', async () => {
    const result = await executeGrantedWorkflow({
      receiptPath: join(tempDir, 'idempotency-receipt.json'),
      artifactDir: join(tempDir, 'idempotency-artifacts'),
      plan: {
        run_id: 'wf-idempotency-1',
        base_url: baseUrl,
        steps: [{
          id: 'refresh_research',
          method: 'POST',
          url: '/refresh',
          body: { mode: 'idempotent' },
          expected_status: 200,
          idempotency_key: 'owlcoda-step-refresh-research',
        } as any],
      },
    } as any)

    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].headers['idempotency-key']).toBe('owlcoda-step-refresh-research')
  })

  it('records conditional steps as skipped instead of executing them when the source path is null', async () => {
    const receiptPath = join(tempDir, 'conditional-receipt.json')

    const result = await executeGrantedWorkflow({
      receiptPath,
      artifactDir: join(tempDir, 'conditional-artifacts'),
      plan: {
        run_id: 'wf-conditional-1',
        base_url: baseUrl,
        steps: [{
          id: 'standings_preflight',
          method: 'GET',
          url: '/preflight',
          required: true,
          expected_status: 200,
          projection: ['preflight.first_action'],
        }, {
          id: 'capture_first_action',
          method: 'POST',
          url: '/capture',
          required: false,
          if: {
            from_step: 'standings_preflight',
            path: '$.preflight.first_action',
            exists: true,
          },
        }],
      },
    })

    expect(result.isError).toBe(false)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf-8'))
    expect(calls.map(call => call.url)).toEqual(['/preflight'])
    expect(receipt).toMatchObject({
      acceptance: 'pass',
      required_steps_total: 1,
      required_steps_completed: 1,
      skipped_steps: [{
        step_id: 'capture_first_action',
        reason: 'condition_not_met',
      }],
    })
  })

  it('allows top-level baseUrl to resolve relative plan step URLs', async () => {
    const receiptPath = join(tempDir, 'base-url-receipt.json')

    const result = await executeGrantedWorkflow({
      baseUrl,
      receiptPath,
      artifactDir: join(tempDir, 'base-url-artifacts'),
      plan: {
        run_id: 'wf-base-url-1',
        steps: [{
          id: 'refresh_research',
          method: 'POST',
          url: '/refresh',
          required: true,
          body: { mode: 'base-url' },
          expected_status: 200,
          projection: ['refreshed'],
        }],
      },
    })

    expect(result.isError).toBe(false)
    const receipt = JSON.parse(await readFile(receiptPath, 'utf-8'))
    expect(receipt).toMatchObject({
      acceptance: 'pass',
      required_endpoint_calls: '1/1',
    })
    expect(receipt.endpoint_calls[0]).toMatchObject({
      step_id: 'refresh_research',
      url: `${baseUrl}/refresh`,
      ok: true,
    })
  })

  it('returns machine-readable plan validation errors before any endpoint call', async () => {
    const result = await executeGrantedWorkflow({
      plan: {
        steps: [{
          id: 'bad_step',
          method: 'GET',
        }],
      },
    } as any)

    expect(result.isError).toBe(true)
    expect(result.output).toContain('bad_step')
    expect(result.output).toContain('url is required')
    expect(result.metadata).toMatchObject({
      failureCategory: 'workflow:invalid_plan',
    })
    expect(calls).toEqual([])
  })

  it('resumes a saved workflow run by run id without re-executing already successful steps', async () => {
    const artifactDir = join(tempDir, 'resume-artifacts')
    const first = await executeGrantedWorkflow({
      cwd: tempDir,
      artifactDir,
      plan: {
        run_id: 'wf-resume-1',
        base_url: baseUrl,
        steps: [{
          id: 'refresh_research',
          method: 'POST',
          url: '/refresh',
          body: { mode: 'first' },
          expected_status: 200,
          projection: ['refreshed'],
        }, {
          id: 'flaky_step',
          method: 'GET',
          url: '/flaky',
          expected_status: 200,
          retry: 0,
          projection: ['ok', 'status'],
        }],
        acceptance: {
          required_endpoint_calls: 2,
          must_all_ok: true,
        },
      },
    })

    expect(first.isError).toBe(true)
    expect(calls.map(call => call.url)).toEqual(['/refresh', '/flaky'])

    calls = []
    flakyStatus = 200
    const resumed = await executeGrantedWorkflow({
      cwd: tempDir,
      artifactDir,
      resumeRunId: 'wf-resume-1',
    } as any)

    expect(resumed.isError).toBe(false)
    expect(calls.map(call => call.url)).toEqual(['/flaky'])

    const receipt = (resumed.metadata as any).receipt
    expect(receipt).toMatchObject({
      run_id: 'wf-resume-1',
      acceptance: 'pass',
      required_endpoint_calls: '2/2',
      resume: {
        previous_run_id: 'wf-resume-1',
        resumed_step_ids: ['refresh_research'],
        mode: 'skip_successful_steps',
      },
    })
    expect(receipt.endpoint_calls.map((call: any) => call.step_id)).toEqual([
      'refresh_research',
      'flaky_step',
    ])
    expect(receipt.endpoint_calls[0].resumed_from_receipt).toEqual(expect.stringContaining('receipt.json'))
    expect(existsSync(join(tempDir, '.owlcoda-workflows', 'wf-resume-1', 'plan.json'))).toBe(true)
  })

  it('does not replace an approved malformed resume-plan snapshot with mutable disk bytes', async () => {
    const runDir = join(tempDir, 'resume-plan-snapshot')
    const receiptPath = join(runDir, 'receipt.json')
    const planPath = join(runDir, 'plan.json')
    await mkdir(runDir, { recursive: true })
    await writeFile(planPath, JSON.stringify({
      run_id: 'resume-plan-snapshot',
      base_url: baseUrl,
      steps: [{ id: 'must_not_run', method: 'POST', url: '/refresh', body: { mutable: true } }],
    }), 'utf8')
    await writeFile(receiptPath, JSON.stringify({
      kind: 'workflow_invocation_receipt',
      run_id: 'resume-plan-snapshot',
      endpoint_calls: [],
    }), 'utf8')

    await expect(runWorkflow({
      cwd: tempDir,
      resumeRunId: 'resume-plan-snapshot',
      receiptPath,
    }, {
      resumePlanSnapshot: {
        ref: planPath,
        content: '{approved-but-malformed',
      },
    })).rejects.toMatchObject({
      errors: [expect.stringContaining('requires a saved plan snapshot')],
    })
    expect(calls).toEqual([])
  })

  it('consumes an OwlFootball harness task contract, handles 409 structured-output, and posts matching receipts', async () => {
    const matchId = '48'
    const stamp = '2026-06-27T13-10-00-000Z'
    const runRef = join(tempDir, 'owlfootball-run')
    const receiptPath = join(tempDir, 'contract-receipt.json')
    const taskReceipts: any[] = []
    const structuredOutputBodies: any[] = []
    const contractRef = join(tempDir, 'harness_task_contract.json')
    await writeFile(contractRef, JSON.stringify({
      artifact_version: 'match-harness-task-contract.v1',
      owner: 'OwlCoda',
      matchId,
      stamp,
      runRef,
      mode: 'full',
      safety: {
        mutates_issue_permission: false,
        mutates_ticket_state: false,
        model_roles_have_issue_authority: false,
      },
      summary: { tasks: 2, complete_tasks: 0, pending_tasks: 2, failed_tasks: 0 },
      task_queue: [{
        task_id: `owlfootball.match.inspect_snapshot_coverage:${matchId}:${stamp}`,
        task_name: 'owlfootball.match.inspect_snapshot_coverage',
        order: 1,
        owner: 'OwlCoda',
        status: 'pending',
        reads: ['harness_input.json'],
        writes: ['snapshot_coverage.json'],
        model_preset: null,
        execution: {
          surface: 'owlfootball_adapter',
          callable_by_owlcoda_app_server: true,
          method: 'POST',
          endpoint: '/api/harness/tasks/execute',
          request: { taskName: 'owlfootball.match.inspect_snapshot_coverage', matchId, stamp },
          runRef,
          safety: { mutates_issue_permission: false, mutates_ticket_state: false },
        },
      }, {
        task_id: `owlfootball.match.build_evidence_digest:${matchId}:${stamp}`,
        task_name: 'owlfootball.match.build_evidence_digest',
        order: 2,
        owner: 'OwlCoda',
        status: 'pending',
        reads: ['snapshot_coverage.json'],
        writes: ['evidence_digest.json'],
        model_preset: 'evidence-digest.v1',
        execution: {
          surface: 'owlfootball_adapter',
          callable_by_owlcoda_app_server: true,
          method: 'POST',
          endpoint: '/api/harness/tasks/execute',
          request: { taskName: 'owlfootball.match.build_evidence_digest', matchId, stamp },
          runRef,
          receipt_endpoint: '/api/harness/tasks/receipt',
          structured_output: {
            trigger_error: 'requires_structured_output',
            endpoint: '/v1/structured-output',
            preset: 'evidence-digest.v1',
            persist: true,
            runRef,
            runId: stamp,
            taskId: `owlfootball.match.${matchId}`,
            stepId: 'owlfootball.match.build_evidence_digest',
          },
          safety: { mutates_issue_permission: false, mutates_ticket_state: false },
        },
      }],
    }, null, 2), 'utf-8')

    server?.removeAllListeners('request')
    server?.on('request', (req, res) => {
      let raw = ''
      req.on('data', chunk => { raw += String(chunk) })
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {}
        calls.push({ method: req.method ?? 'GET', url: req.url ?? '/', body: raw })
        res.setHeader('content-type', 'application/json; charset=utf-8')

        if (req.url === '/api/harness/tasks/execute') {
          if (body.taskName === 'owlfootball.match.build_evidence_digest') {
            res.statusCode = 409
            res.end(JSON.stringify({
              ok: false,
              error: 'requires_structured_output',
              taskName: body.taskName,
              preset: 'evidence-digest.v1',
              runRef,
              structured_output: {
                endpoint: '/v1/structured-output',
                preset: 'evidence-digest.v1',
                persist: true,
                runRef,
                runId: stamp,
                taskId: `owlfootball.match.${matchId}`,
                stepId: body.taskName,
              },
              request: {
                persist: true,
                runRef,
                runId: stamp,
                taskId: `owlfootball.match.${matchId}`,
                stepId: body.taskName,
              },
              receipt: {
                required: true,
                method: 'POST',
                endpoint: '/api/harness/tasks/receipt',
                transcriptRefFormat: 'owlcoda://runs/<taskRunId>',
              },
            }))
            return
          }
          res.end(JSON.stringify({
            ok: true,
            result: {
              task_name: body.taskName,
              status: 'complete',
              artifacts_written: ['snapshot_coverage.json'],
            },
          }))
          return
        }

        if (req.url === '/v1/structured-output') {
          structuredOutputBodies.push(body)
          res.end(JSON.stringify({
            ok: true,
            usable: true,
            consumerReady: true,
            artifact: { artifact: 'evidence_digest', summary: 'model evidence' },
            rawText: 'raw model evidence text',
            attempts: [{ label: 'primary', parsed: true }],
            persisted: true,
            artifactId: 'structured-output-evidence-1',
            attemptLedgerId: 'structured-output-evidence-1-attempts',
            runRef,
          }))
          return
        }

        if (req.url === '/api/harness/tasks/receipt') {
          taskReceipts.push(body)
          res.end(JSON.stringify({ ok: true, receipt: { receipts: taskReceipts } }))
          return
        }

        res.statusCode = 404
        res.end(JSON.stringify({ ok: false, error: 'not found' }))
      })
    })

    const result = await executeGrantedWorkflow({
      contractRef,
      baseUrl,
      receiptPath,
      artifactDir: join(tempDir, 'contract-artifacts'),
      taskRunId: 'owlcoda-run-contract-1',
      structuredOutputModel: 'mimo',
    } as any)

    expect(result.isError).toBe(false)
    expect(structuredOutputBodies).toHaveLength(1)
    expect(structuredOutputBodies[0]).toMatchObject({
      model: 'mimo',
      preset: 'evidence-digest.v1',
      persist: true,
      runRef,
      runId: stamp,
      taskId: `owlfootball.match.${matchId}`,
      stepId: 'owlfootball.match.build_evidence_digest',
    })
    expect(taskReceipts).toHaveLength(2)
    expect(taskReceipts.map(receipt => receipt.taskName)).toEqual([
      'owlfootball.match.inspect_snapshot_coverage',
      'owlfootball.match.build_evidence_digest',
    ])
    expect(taskReceipts.every(receipt => receipt.taskRunId === 'owlcoda-run-contract-1')).toBe(true)
    expect(taskReceipts.every(receipt => receipt.transcriptRef === 'owlcoda://runs/owlcoda-run-contract-1')).toBe(true)
    expect(taskReceipts[1]).toMatchObject({
      status: 'completed',
      artifactsWritten: ['evidence_digest.json'],
    })

    const receipt = JSON.parse(await readFile(receiptPath, 'utf-8'))
    expect(receipt).toMatchObject({
      task_run_id: 'owlcoda-run-contract-1',
      transcript_ref: 'owlcoda://runs/owlcoda-run-contract-1',
      acceptance: 'pass',
      contract: {
        kind: 'owlfootball_harness_task_contract',
        matchId,
        stamp,
        tasks_total: 2,
        tasks_completed: 2,
      },
    })
    const structuredCall = receipt.endpoint_calls.find((call: any) => call.step_id.endsWith(':structured-output'))
    expect(structuredCall).toMatchObject({
      status_code: 200,
      ok: true,
      projected_response: {
        ok: true,
        usable: true,
        consumerReady: true,
        artifactId: 'structured-output-evidence-1',
        attemptLedgerId: 'structured-output-evidence-1-attempts',
        rawText: 'raw model evidence text',
      },
    })
    expect(structuredCall.artifact_completeness).toMatchObject({
      expected: [],
      produced: ['structured-output-evidence-1', 'structured-output-evidence-1-attempts'],
      missing: [],
      validationStatus: 'pass',
      fallbackStatus: 'none',
    })
    expect(receipt.artifact_completeness.produced).toEqual(expect.arrayContaining([
      'structured-output-evidence-1',
      'structured-output-evidence-1-attempts',
    ]))
    expect(receipt.consumer_readiness.consumerReady).toBe(true)
  })
})
