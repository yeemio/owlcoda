import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelExecutorConfig, ModelExecutorKind } from '../model-registry.js'
import type {
  StructuredOutputExecutor,
  StructuredOutputModelResponse,
} from '../model-output-harness.js'
import {
  CODEX_CLI_TASK_KIND,
  CURSOR_AGENT_TASK_KIND,
  KIMI_CLI_TASK_KIND,
  RuntimeExecutionControlError,
  createDefaultRuntimeExecutionController,
  type VendorCliDriverName,
  type VendorCliRuntimeTaskKind,
} from '../native/runtime-execution-control/index.js'

export interface VendorCliStructuredOutputExecutorOptions {
  readonly executorKind: ModelExecutorKind
  readonly executorConfig: ModelExecutorConfig
  readonly backendModel: string
  readonly requestedModelConfigured: boolean
}

export function createVendorCliStructuredOutputExecutor(
  options: VendorCliStructuredOutputExecutorOptions,
): StructuredOutputExecutor {
  return async request => {
    if (!options.requestedModelConfigured) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_EXECUTION_MODEL_NOT_CONFIGURED',
        `CLI-backed model is not explicitly configured: ${request.model}`,
      )
    }
    const route = routeFor(options.executorKind)
    const workspace = await mkdtemp(join(tmpdir(), `owlcoda-${route.name}-structured-output-`))
    try {
      const controller = createDefaultRuntimeExecutionController({
        vendorCli: { [route.name]: options.executorConfig },
      })
      const correlationId = `structured-output:${randomUUID()}`
      const reservation = controller.reserve({
        taskKind: route.taskKind,
        correlationId,
        workspaceRoot: workspace,
        permissionMode: 'local_read_only',
      })
      const result = await controller.execute(reservation, {
        kind: route.taskKind,
        prompt: structuredPrompt(request),
        model: options.backendModel,
        ...(request.schema ? { outputSchema: request.schema as Readonly<Record<string, unknown>> } : {}),
      }, { signal: request.signal })
      request.onRuntimeExecution?.(result)
      const vendorResult = result.vendorResult
      const response: StructuredOutputModelResponse = {
        text: result.status === 'completed' ? vendorResult?.text ?? '' : '',
        stopReason: result.status === 'completed' ? 'end_turn' : result.failure?.code ?? result.status,
        inputTokens: vendorResult?.inputTokens ?? 0,
        outputTokens: vendorResult?.outputTokens ?? 0,
        durationMs: vendorResult?.durationMs ?? 0,
        streamingMode: 'non_streaming',
        streamDeltaSource: 'none',
        runtimeExecution: result,
      }
      return response
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

function routeFor(kind: ModelExecutorKind): {
  name: VendorCliDriverName
  taskKind: VendorCliRuntimeTaskKind
} {
  switch (kind) {
    case 'kimi-cli':
      return { name: 'kimi', taskKind: KIMI_CLI_TASK_KIND }
    case 'cursor-agent':
      return { name: 'cursor', taskKind: CURSOR_AGENT_TASK_KIND }
    case 'codex-cli':
      return { name: 'codex', taskKind: CODEX_CLI_TASK_KIND }
  }
}

function structuredPrompt(request: Parameters<StructuredOutputExecutor>[0]): string {
  return [
    'You are running through the OwlCoda controlled structured-output runtime.',
    'Do not inspect files, browse, or use information beyond this prompt.',
    'Return exactly one JSON object. Do not use Markdown or explanatory text.',
    `System instructions:\n${request.system}`,
    `User input:\n${request.user}`,
    `JSON Schema:\n${JSON.stringify(request.schema ?? { type: 'object' })}`,
    'The response must validate against the JSON Schema.',
  ].join('\n\n')
}
