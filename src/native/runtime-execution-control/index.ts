import { RuntimeExecutionController, type RuntimeExecutionControllerOptions } from './controller.js'
import { OwlCodaNativeAgentRuntimeDriver } from './drivers.js'
import {
  CodexCliAgentRuntimeDriver,
  CursorAgentRuntimeDriver,
  KimiCliAgentRuntimeDriver,
  type VendorCliDriverOptions,
} from './vendor-cli-drivers.js'
import {
  resolveGrantedWorkflowRuntimeTask,
  type RuntimeExecutionAuthorizationGrant,
} from './grants.js'
import type { WorkflowRunInput } from '../workflow-runner.js'
import {
  CODEX_CLI_DRIVER_ID,
  CODEX_CLI_TASK_KIND,
  CURSOR_AGENT_DRIVER_ID,
  CURSOR_AGENT_TASK_KIND,
  KIMI_CLI_DRIVER_ID,
  KIMI_CLI_TASK_KIND,
  type VendorCliDriverName,
} from './types.js'

export * from './controller.js'
export * from './drivers.js'
export * from './vendor-cli-drivers.js'
export * from './types.js'

export interface DefaultRuntimeExecutionControllerOptions
  extends Pick<RuntimeExecutionControllerOptions, 'identityFactory'> {
  readonly vendorCli?: Partial<Record<VendorCliDriverName, VendorCliDriverOptions>>
}

export function createDefaultRuntimeExecutionController(
  options: DefaultRuntimeExecutionControllerOptions = {},
): RuntimeExecutionController {
  const { vendorCli = {}, ...controllerOptions } = options
  return new RuntimeExecutionController({
    drivers: [
      new OwlCodaNativeAgentRuntimeDriver(),
      new KimiCliAgentRuntimeDriver(vendorCli.kimi),
      new CursorAgentRuntimeDriver(vendorCli.cursor),
      new CodexCliAgentRuntimeDriver(vendorCli.codex),
    ],
    routingPolicy: {
      'workflow-run-v1': 'owlcoda-native',
      [KIMI_CLI_TASK_KIND]: KIMI_CLI_DRIVER_ID,
      [CURSOR_AGENT_TASK_KIND]: CURSOR_AGENT_DRIVER_ID,
      [CODEX_CLI_TASK_KIND]: CODEX_CLI_DRIVER_ID,
    },
    ...controllerOptions,
  })
}

export async function executeApprovedWorkflowRuntime(input: {
  readonly workflow: WorkflowRunInput
  readonly authorizationGrant: RuntimeExecutionAuthorizationGrant
  readonly signal?: AbortSignal
}) {
  const task = resolveGrantedWorkflowRuntimeTask(input.authorizationGrant, input.workflow)
  const controller = createDefaultRuntimeExecutionController()
  const reservation = controller.reserve({
    taskKind: 'workflow-run-v1',
    correlationId: `workflow:${input.authorizationGrant.grantId}`,
    workspaceRoot: input.authorizationGrant.workspaceRoot,
    permissionMode: 'approved_external_effect',
    authorizationGrant: input.authorizationGrant,
    task,
  })
  return await controller.execute(reservation, task, { signal: input.signal })
}

export type { RuntimeExecutionAuthorizationGrant } from './grants.js'
