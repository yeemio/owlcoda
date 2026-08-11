import {
  formatWorkflowRunSummary,
  type WorkflowRunInput,
} from '../workflow-runner.js'
import {
  executeApprovedWorkflowRuntime,
  RuntimeExecutionControlError,
} from '../runtime-execution-control/index.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export function createWorkflowRunTool(): NativeToolDef<WorkflowRunInput> {
  return {
    name: 'WorkflowRun',
    description:
      'Execute a typed HTTP/API workflow plan without bash, then write a machine-readable invocation receipt with endpoint calls, skipped/failed steps, compacted responses, and artifacts.',
    maturity: 'beta',
    async execute(input: WorkflowRunInput, context?: ToolExecutionContext): Promise<ToolResult> {
      if (!context?.runtimeExecutionGrant) {
        return {
          output: 'WorkflowRun failed: product runtime authorization is required.',
          isError: true,
          metadata: {
            failureCategory: 'workflow:runtime_authorization_required',
          },
        }
      }
      try {
        const runtimeResult = await executeApprovedWorkflowRuntime({
          workflow: input,
          authorizationGrant: context.runtimeExecutionGrant,
          signal: context.signal,
        })
        const runtimeExecution = {
          driverId: runtimeResult.driverId,
          executionId: runtimeResult.executionId,
          attemptId: runtimeResult.attemptId,
          driverSessionId: runtimeResult.driverSessionId,
          ...(runtimeResult.grantId ? { grantId: runtimeResult.grantId } : {}),
        }
        if (!runtimeResult.workflowResult) {
          const invalidPlan = runtimeResult.failure?.code === 'WORKFLOW_PLAN_INVALID'
          return {
            output: runtimeResult.failure?.message ?? 'WorkflowRun failed without a collected workflow result.',
            isError: true,
            metadata: {
              failureCategory: invalidPlan ? 'workflow:invalid_plan' : 'workflow:execution_failed',
              ...(runtimeResult.failure?.errors ? { errors: runtimeResult.failure.errors } : {}),
              runtimeExecution,
            },
          }
        }
        const result = runtimeResult.workflowResult
        return {
          output: formatWorkflowRunSummary(result),
          isError: result.receipt.acceptance !== 'pass',
          metadata: {
            receipt: result.receipt,
            receiptPath: result.receiptPath,
            artifactDir: result.artifactDir,
            runtimeExecution,
          },
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          output: `WorkflowRun failed: ${message}`,
          isError: true,
          metadata: {
            failureCategory: err instanceof RuntimeExecutionControlError
              ? 'workflow:runtime_authorization_failed'
              : 'workflow:execution_failed',
            ...(err instanceof RuntimeExecutionControlError ? { runtimeControlCode: err.code } : {}),
          },
        }
      }
    },
  }
}

export type { WorkflowRunInput }
