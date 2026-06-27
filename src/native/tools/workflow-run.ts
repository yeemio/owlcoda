import {
  formatWorkflowRunSummary,
  runWorkflow,
  WorkflowPlanValidationError,
  type WorkflowRunInput,
} from '../workflow-runner.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './types.js'

export function createWorkflowRunTool(): NativeToolDef<WorkflowRunInput> {
  return {
    name: 'WorkflowRun',
    description:
      'Execute a typed HTTP/API workflow plan without bash, then write a machine-readable invocation receipt with endpoint calls, skipped/failed steps, compacted responses, and artifacts.',
    maturity: 'beta',
    async execute(input: WorkflowRunInput, context?: ToolExecutionContext): Promise<ToolResult> {
      try {
        const result = await runWorkflow(input, { signal: context?.signal })
        return {
          output: formatWorkflowRunSummary(result),
          isError: result.receipt.acceptance !== 'pass',
          metadata: {
            receipt: result.receipt,
            receiptPath: result.receiptPath,
            artifactDir: result.artifactDir,
          },
        }
      } catch (err) {
        if (err instanceof WorkflowPlanValidationError) {
          return {
            output: err.message,
            isError: true,
            metadata: {
              failureCategory: 'workflow:invalid_plan',
              errors: err.errors,
            },
          }
        }
        const message = err instanceof Error ? err.message : String(err)
        return {
          output: `WorkflowRun failed: ${message}`,
          isError: true,
          metadata: {
            failureCategory: 'workflow:execution_failed',
          },
        }
      }
    },
  }
}

export type { WorkflowRunInput }
