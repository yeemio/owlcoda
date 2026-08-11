import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OWLCODA_NATIVE_DRIVER_ID,
  RuntimeExecutionControlError,
  RuntimeExecutionController,
  createDefaultRuntimeExecutionController,
  createUnsupportedVendorNativeDriver,
  executeApprovedWorkflowRuntime,
  type AgentRuntimeDriver,
} from '../../src/native/runtime-execution-control/index.js'
import type { WorkflowRunInput } from '../../src/native/workflow-runner.js'
import {
  issueOperatorCliWorkflowRuntimeGrant,
  resolveGrantedWorkflowRuntimeTask,
} from '../../src/native/runtime-execution-control/grants.js'

describe('Runtime Execution Control native workflow slice', () => {
  let server: Server
  let baseUrl = ''
  let tempDir = ''
  let requests: string[] = []
  let slowRequestStarted: (() => void) | undefined

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'owlcoda-runtime-control-'))
    requests = []
    slowRequestStarted = undefined
    server = createServer((req, res) => {
      requests.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`)
      res.setHeader('content-type', 'application/json; charset=utf-8')
      if (req.url === '/slow') {
        slowRequestStarted?.()
        setTimeout(() => {
          if (!res.destroyed) res.end(JSON.stringify({ ok: true }))
        }, 250)
        return
      }
      res.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(tempDir, { recursive: true, force: true })
  })

  it('selects owlcoda-native by controller policy and returns distinct correlated identities and artifacts', async () => {
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => ({
        executionId: 'runtime-execution:test-success',
        attemptId: 'runtime-attempt:test-success:1',
      }),
    })
    const reservation = controller.reserve({
      taskKind: 'workflow-run-v1',
      correlationId: 'legacy-execution-run-success',
      workspaceRoot: tempDir,
      permissionMode: 'local_read_only',
    })

    const result = await controller.execute(reservation, {
      kind: 'workflow-run-v1',
      workflow: {
        cwd: tempDir,
        receiptPath: join(tempDir, 'success', 'receipt.json'),
        artifactDir: join(tempDir, 'success', 'artifacts'),
        plan: {
          run_id: 'legacy-execution-run-success',
          base_url: baseUrl,
          steps: [{ id: 'read', method: 'GET', url: '/ok', expected_status: 200 }],
        },
      },
      options: { redirect: 'manual' },
    })

    expect(result).toMatchObject({
      status: 'completed',
      driverId: OWLCODA_NATIVE_DRIVER_ID,
      driverFamily: 'owlcoda-native',
      executionId: 'runtime-execution:test-success',
      attemptId: 'runtime-attempt:test-success:1',
      driverSessionId: 'owlcoda-native-session:runtime-attempt:test-success:1',
      correlationRefs: {
        correlationId: 'legacy-execution-run-success',
        nativeRunId: 'legacy-execution-run-success',
        receiptRef: join(tempDir, 'success', 'receipt.json'),
      },
      artifactFacts: expect.arrayContaining([
        expect.objectContaining({ artifactType: 'workflow_plan' }),
        expect.objectContaining({ artifactType: 'workflow_receipt' }),
      ]),
      workflowResult: { receipt: { acceptance: 'pass' } },
    })
    expect(new Set([result.executionId, result.attemptId, result.driverSessionId]).size).toBe(3)
  })

  it('interrupts the native driver session and returns cancellation with the same execution and attempt identity', async () => {
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => ({
        executionId: 'runtime-execution:test-cancel',
        attemptId: 'runtime-attempt:test-cancel:1',
      }),
    })
    const reservation = controller.reserve({
      taskKind: 'workflow-run-v1',
      correlationId: 'legacy-execution-run-cancel',
      workspaceRoot: tempDir,
      permissionMode: 'local_read_only',
    })
    const requestStarted = new Promise<void>(resolve => {
      slowRequestStarted = resolve
    })
    const pending = controller.execute(reservation, {
      kind: 'workflow-run-v1',
      workflow: {
        cwd: tempDir,
        receiptPath: join(tempDir, 'cancel', 'receipt.json'),
        artifactDir: join(tempDir, 'cancel', 'artifacts'),
        plan: {
          run_id: 'legacy-execution-run-cancel',
          base_url: baseUrl,
          steps: [{ id: 'read_slow', method: 'GET', url: '/slow', expected_status: 200 }],
        },
      },
    })
    await requestStarted
    const interrupt = await controller.interrupt(reservation, 'test_cancel')
    const result = await pending

    expect(interrupt).toMatchObject({ accepted: true, driverId: OWLCODA_NATIVE_DRIVER_ID })
    expect(result).toMatchObject({
      status: 'cancelled',
      driverId: OWLCODA_NATIVE_DRIVER_ID,
      executionId: reservation.executionId,
      attemptId: reservation.attemptId,
      failure: { code: 'RUNTIME_EXECUTION_CANCELLED', message: 'test_cancel' },
      correlationRefs: { nativeRunId: 'legacy-execution-run-cancel' },
    })
  })

  it('rejects a vendor-native family at reservation even when its driver claims full availability', async () => {
    let identityAllocations = 0
    let probeCalls = 0
    let startCalls = 0
    let collectCalls = 0
    const vendorDriver: AgentRuntimeDriver = {
      id: 'vendor-native:available-fake',
      family: 'vendor-native',
      capabilities: {
        taskKinds: ['workflow-run-v1'],
        permissionModes: ['local_read_only'],
        lifecycle: {
          probe: true,
          start: true,
          observe: true,
          interrupt: true,
          resume: true,
          collect: true,
        },
        artifactCollection: true,
      },
      async probe() {
        probeCalls += 1
        return {
          driverId: this.id,
          driverFamily: this.family,
          status: 'available',
          capabilities: this.capabilities,
        }
      },
      async start(request) {
        startCalls += 1
        return { ...request.identity, driverSessionId: 'vendor-native-session:available-fake' }
      },
      async observe(session) {
        return { ...session, status: 'completed' }
      },
      async interrupt() {},
      async resume(request) {
        return { ...request.identity, driverSessionId: 'vendor-native-session:available-fake:resume' }
      },
      async collect(session) {
        collectCalls += 1
        return {
          status: 'completed',
          driverSessionId: session.driverSessionId,
          correlationRefs: {
            correlationId: 'legacy-execution-run-vendor-available',
            artifactRefs: [],
          },
          artifactFacts: [],
        }
      },
    }
    const controller = new RuntimeExecutionController({
      drivers: [vendorDriver],
      routingPolicy: { 'workflow-run-v1': vendorDriver.id },
      identityFactory: () => {
        identityAllocations += 1
        return {
          executionId: 'runtime-execution:test-vendor-available',
          attemptId: 'runtime-attempt:test-vendor-available:1',
        }
      },
    })

    let rejection: unknown
    try {
      const reservation = controller.reserve({
        taskKind: 'workflow-run-v1',
        correlationId: 'legacy-execution-run-vendor-available',
        workspaceRoot: tempDir,
        permissionMode: 'local_read_only',
      })
      await controller.execute(reservation, {
        kind: 'workflow-run-v1',
        workflow: {
          cwd: tempDir,
          plan: {
            run_id: 'must-not-run-vendor-available',
            base_url: baseUrl,
            steps: [{ id: 'must_not_run', method: 'GET', url: '/ok' }],
          },
        },
      })
    } catch (error) {
      rejection = error
    }

    expect.soft(rejection).toMatchObject<Partial<RuntimeExecutionControlError>>({
      code: 'RUNTIME_DRIVER_UNSUPPORTED',
    })
    expect.soft(identityAllocations).toBe(0)
    expect({ probeCalls, startCalls, collectCalls }).toEqual({
      probeCalls: 0,
      startCalls: 0,
      collectCalls: 0,
    })
  })

  it('fails closed at reservation when policy resolves to an explicitly unsupported vendor-native driver', () => {
    const vendorDriver = createUnsupportedVendorNativeDriver('vendor-native:test')
    const controller = new RuntimeExecutionController({
      drivers: [vendorDriver],
      routingPolicy: { 'workflow-run-v1': vendorDriver.id },
      identityFactory: () => ({
        executionId: 'runtime-execution:test-vendor',
        attemptId: 'runtime-attempt:test-vendor:1',
      }),
    })
    let rejection: unknown
    try {
      controller.reserve({
        taskKind: 'workflow-run-v1',
        correlationId: 'legacy-execution-run-vendor',
        workspaceRoot: tempDir,
        permissionMode: 'local_read_only',
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection).toMatchObject<Partial<RuntimeExecutionControlError>>({
      code: 'RUNTIME_DRIVER_UNSUPPORTED',
    })
    expect(requests).toEqual([])
  })

  it('enforces local-read-only admission in the controller before a native driver session can write', async () => {
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => ({
        executionId: 'runtime-execution:test-write-rejected',
        attemptId: 'runtime-attempt:test-write-rejected:1',
      }),
    })
    const reservation = controller.reserve({
      taskKind: 'workflow-run-v1',
      correlationId: 'legacy-execution-run-write-rejected',
      workspaceRoot: tempDir,
      permissionMode: 'local_read_only',
    })

    await expect(controller.execute(reservation, {
      kind: 'workflow-run-v1',
      workflow: {
        cwd: tempDir,
        plan: {
          run_id: 'must-not-run',
          base_url: baseUrl,
          steps: [{ id: 'must_not_run', method: 'POST', url: '/write', body: { forbidden: true } }],
        },
      },
    })).rejects.toMatchObject<Partial<RuntimeExecutionControlError>>({
      code: 'RUNTIME_EXECUTION_NOT_READ_ONLY',
    })
    expect(requests).toEqual([])
  })

  it('rejects a structurally forged external-effect grant before allocating or probing a driver', () => {
    let identityAllocations = 0
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => {
        identityAllocations += 1
        return {
          executionId: 'runtime-execution:forged-grant',
          attemptId: 'runtime-attempt:forged-grant:1',
        }
      },
    })

    expect(() => controller.reserve({
      taskKind: 'workflow-run-v1',
      correlationId: 'forged-grant',
      workspaceRoot: tempDir,
      permissionMode: 'approved_external_effect' as any,
      authorizationGrant: {
        schemaVersion: 1,
        grantId: 'runtime-grant:forged',
        source: 'tool_approval',
        workspaceRoot: tempDir,
      },
      task: {
        kind: 'workflow-run-v1',
        workflow: {
          cwd: tempDir,
          plan: {
            run_id: 'forged-grant',
            base_url: baseUrl,
            steps: [{ id: 'must_not_run', method: 'POST', url: '/write' }],
          },
        },
      },
    } as any)).toThrowError(expect.objectContaining({
      code: 'RUNTIME_AUTHORIZATION_GRANT_INVALID',
    }))
    expect(identityAllocations).toBe(0)
    expect(requests).toEqual([])
  })

  it('rejects task drift against an authentic product grant before allocating or probing a driver', async () => {
    let identityAllocations = 0
    const workflow: WorkflowRunInput = {
      cwd: tempDir,
      plan: {
        run_id: 'authentic-grant-task-binding',
        base_url: baseUrl,
        steps: [{ id: 'approved', method: 'POST', url: '/approved', body: { value: 1 } }],
      },
    }
    const authorizationGrant = await issueOperatorCliWorkflowRuntimeGrant({
      workflow,
      workspaceRoot: tempDir,
      action: 'workflow execute',
    })
    const approvedTask = resolveGrantedWorkflowRuntimeTask(authorizationGrant, workflow)
    const controller = createDefaultRuntimeExecutionController({
      identityFactory: () => {
        identityAllocations += 1
        return {
          executionId: 'runtime-execution:task-drift',
          attemptId: 'runtime-attempt:task-drift:1',
        }
      },
    })

    expect(() => controller.reserve({
      taskKind: 'workflow-run-v1',
      correlationId: 'task-drift',
      workspaceRoot: tempDir,
      permissionMode: 'approved_external_effect',
      authorizationGrant,
      task: {
        ...approvedTask,
        workflow: {
          ...approvedTask.workflow,
          plan: {
            ...approvedTask.workflow.plan!,
            steps: [{ id: 'swapped', method: 'POST', url: '/swapped', body: { value: 2 } }],
          },
        },
      },
    })).toThrowError(expect.objectContaining({
      code: 'RUNTIME_AUTHORIZATION_TASK_MISMATCH',
    }))
    expect(identityAllocations).toBe(0)
    expect(requests).toEqual([])
  })

  it('fails closed when an approved contract resource drifts before driver start', async () => {
    const contractRef = join(tempDir, 'contract.json')
    const workflow: WorkflowRunInput = {
      cwd: tempDir,
      contractRef,
      baseUrl,
    }
    const contract = {
      artifact_version: 'match-harness-task-contract.v1',
      matchId: '1',
      stamp: 'test',
      runRef: 'run-ref',
      task_queue: [{
        task_id: 'task-1',
        task_name: 'task.one',
        order: 1,
        status: 'pending',
        writes: [],
        execution: { method: 'POST', endpoint: '/ok', request: {}, runRef: 'run-ref' },
      }],
    }
    await writeFile(contractRef, JSON.stringify(contract), 'utf8')
    const authorizationGrant = await issueOperatorCliWorkflowRuntimeGrant({
      workflow,
      workspaceRoot: tempDir,
      action: 'workflow run-contract',
    })
    await writeFile(contractRef, JSON.stringify({ ...contract, stamp: 'drifted' }), 'utf8')

    await expect(executeApprovedWorkflowRuntime({ workflow, authorizationGrant }))
      .rejects.toMatchObject({ code: 'RUNTIME_AUTHORIZATION_RESOURCE_DRIFT' })
    expect(requests).toEqual([])
  })

  it('binds the previous receipt even when resume is submitted with an inline plan', async () => {
    const receiptPath = join(tempDir, 'resume-receipt.json')
    const workflow: WorkflowRunInput = {
      cwd: tempDir,
      receiptPath,
      resumeRunId: 'inline-plan-resume',
      plan: {
        run_id: 'inline-plan-resume',
        base_url: baseUrl,
        steps: [{ id: 'already_done', method: 'POST', url: '/ok', body: { approved: true } }],
      },
    }
    const receipt = {
      schema_version: 1,
      kind: 'workflow_invocation_receipt',
      run_id: 'inline-plan-resume',
      endpoint_calls: [{ step_id: 'already_done', ok: true }],
    }
    await writeFile(receiptPath, JSON.stringify(receipt), 'utf8')
    const authorizationGrant = await issueOperatorCliWorkflowRuntimeGrant({
      workflow,
      workspaceRoot: tempDir,
      action: 'workflow resume',
    })
    await writeFile(receiptPath, JSON.stringify({ ...receipt, endpoint_calls: [] }), 'utf8')

    await expect(executeApprovedWorkflowRuntime({ workflow, authorizationGrant }))
      .rejects.toMatchObject({ code: 'RUNTIME_AUTHORIZATION_RESOURCE_DRIFT' })
    expect(requests).toEqual([])
  })
})
