/**
 * OwlCoda Native Tool Dispatcher
 *
 * Routes tool_use blocks from the model to native tool implementations,
 * executes them, and returns tool_result blocks for the conversation.
 */

import type {
  AnthropicToolUseBlock,
  AnthropicContentBlock,
  EvidencePersistenceFailure,
  EvidencePersistenceOperation,
  TaskExecutionState,
} from './protocol/types.js'
import type { NativeToolDef, ToolExecutionContext, ToolResult } from './tools/types.js'
import { createBashTool } from './tools/bash.js'
import { createReadTool } from './tools/read.js'
import { createWriteTool } from './tools/write.js'
import { createEditTool } from './tools/edit.js'
import { createGlobTool } from './tools/glob.js'
import { createGrepTool } from './tools/grep.js'
import { createWebFetchTool } from './tools/web-fetch.js'
import { createWebSearchTool } from './tools/web-search.js'
import { createTodoWriteTool } from './tools/todo-write.js'
import { createAskUserQuestionTool } from './tools/ask-user.js'
import { createSleepTool } from './tools/sleep.js'
import { createAgentRunGetTool, createAgentRunListTool } from './tools/agent.js'
import {
  createLongTaskAwaitTool,
  createLongTaskGetTool,
  createLongTaskListTool,
  createLongTaskReplaceTool,
} from './tools/long-task.js'
import { createRuntimeRecoveryGetTool, createRuntimeRecoveryListTool } from './tools/runtime-recovery.js'
import { createJobCancelTool, createJobGetTool, createJobListTool } from './tools/job.js'
import { createBrowserJobTool } from './tools/browser-job.js'
import { createEnterPlanModeTool, type PlanModeState } from './tools/enter-plan-mode.js'
import { createExitPlanModeTool } from './tools/exit-plan-mode.js'
import { createConfigTool } from './tools/config.js'
import { createNotebookEditTool } from './tools/notebook-edit.js'
import { createEnterWorktreeTool, type WorktreeState } from './tools/enter-worktree.js'
import { createExitWorktreeTool } from './tools/exit-worktree.js'
import { createTaskCreateTool } from './tools/task-create.js'
import { createTaskListTool } from './tools/task-list.js'
import { createTaskGetTool } from './tools/task-get.js'
import { createTaskUpdateTool } from './tools/task-update.js'
import { createTaskStopTool } from './tools/task-stop.js'
import { createTaskOutputTool } from './tools/task-output.js'
import { createTaskVerifyTool } from './tools/task-verify.js'
import { createTeamCreateTool } from './tools/team-create.js'
import { createTeamDeleteTool } from './tools/team-delete.js'
import { createToolSearchTool } from './tools/tool-search.js'
import { createStructuredOutputTool } from './tools/structured-output.js'
import { createRemoteTriggerTool } from './tools/remote-trigger.js'
import { createMCPTool } from './tools/mcp-tool.js'
import { createListMcpResourcesTool } from './tools/list-mcp-resources.js'
import { createReadMcpResourceTool } from './tools/read-mcp-resource.js'
import { createMcpAuthTool } from './tools/mcp-auth.js'
import type { MCPManager } from './mcp/manager.js'
import { createSkillTool } from './tools/skill.js'
import { createLSPTool } from './tools/lsp.js'
import { getNativeLspProvider } from './tools/lsp-provider.js'
import { createPowerShellTool } from './tools/powershell.js'
import { createBriefTool } from './tools/brief.js'
import { createDeliveryAuditTool } from './tools/delivery-audit.js'
import { createProbePlanTool } from './tools/probe-plan.js'
import { createSkillRoutePreviewTool } from './tools/skill-route-preview.js'
import { createRunWorkspaceTool } from './tools/run-workspace.js'
import { createProjectMapTool } from './tools/project-map.js'
import { createArtifactVerifyTool } from './tools/artifact-verify.js'
import { createJudgeBackendProbeTool } from './tools/judge-backend-probe.js'
import { createWorkflowRunTool } from './tools/workflow-run.js'
import { applyToolFailurePolicy } from './tools/semantic-failure.js'
import {
  evaluateWriteGuard,
  ensureRunWorkspaceForStructuredTask,
  markTaskWriteScopeBlocked,
  recordBashArtifactProgress,
  recordToolExecutionProgress,
  recordWriteSuccess,
  recordEvidencePersistenceFailure,
  clearEvidencePersistenceFailure,
} from './task-state.js'
import { writePlan, recordArtifact } from './run-workspace.js'
import { normalize, isAbsolute, resolve } from 'node:path'

/** Tool execution result with the original tool_use_id. */
export interface ToolExecutionResult {
  toolUseId: string
  toolName: string
  result: ToolResult
  durationMs: number
}

export class ToolDispatcher {
  private tools = new Map<string, NativeToolDef<unknown>>()

  constructor(private mcpManager?: MCPManager) {
    this.registerDefaults()
  }

  /** Register a tool. */
  register<T>(tool: NativeToolDef<T>): void {
    this.tools.set(tool.name, tool as NativeToolDef<unknown>)
  }

  /** Remove a registered tool by name. */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /** Get all registered tool names. */
  getToolNames(): string[] {
    return [...this.tools.keys()]
  }

  /**
   * Resolve a tool by name, tolerating case differences in the
   * model-emitted name. Some models intermittently emit a capitalized
   * name (e.g. "Bash") while the registry holds the canonical lowercase
   * "bash"; a case-sensitive lookup would mis-report it as an unknown
   * tool. Exact match wins; a case-insensitive scan is the fallback.
   * Tool count is small (~45) so the linear scan is negligible, and
   * scanning live (rather than caching) stays correct after unregister().
   */
  private resolveTool(name: string): NativeToolDef<unknown> | undefined {
    const exact = this.tools.get(name)
    if (exact) return exact
    const lower = name.toLowerCase()
    for (const [key, tool] of this.tools) {
      if (key.toLowerCase() === lower) return tool
    }
    return undefined
  }

  /** Check if a tool is registered (case-insensitive). */
  has(name: string): boolean {
    return this.resolveTool(name) !== undefined
  }

  /**
   * Resolve the description authored by the tool's factory. Returns
   * `undefined` when the tool isn't registered or didn't supply one.
   *
   * Wire-the-honest-text exists because `buildNativeToolDefs` and
   * `ToolSearch` previously hardcoded a `"Native ${name} tool"`
   * placeholder, which silently dropped honest stub-disclosure copy
   * (e.g. McpAuth's "tokens are NOT validated"). The LLM never
   * saw what the maintainer wrote.
   */
  getToolDescription(name: string): string | undefined {
    return this.resolveTool(name)?.description
  }

  /** Execute a single tool_use block. */
  async executeTool(block: AnthropicToolUseBlock, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.resolveTool(block.name)
    if (!tool) {
      return {
        toolUseId: block.id,
        toolName: block.name,
        result: {
          output: `Error: unknown tool "${block.name}"`,
          isError: true,
        },
        durationMs: 0,
      }
    }

    // Normalize to the canonical registered name so the write guard,
    // failure policy, telemetry, and run-workspace bookkeeping all key on
    // the real tool regardless of the casing the model emitted.
    const toolName = tool.name

    const start = Date.now()
    try {
      const guardViolation = evaluateWriteGuard(toolName, block.input, context?.taskState)
      if (guardViolation) {
        if (context?.taskState) {
          markTaskWriteScopeBlocked(
            context.taskState,
            guardViolation.message,
            guardViolation.attemptedPath,
            guardViolation.attemptedPaths,
          )
        }
        return {
          toolUseId: block.id,
          toolName,
          result: {
            output: guardViolation.message,
            isError: true,
            metadata: {
              taskGuardBlocked: true,
              attemptedPath: guardViolation.attemptedPath,
              attemptedPaths: guardViolation.attemptedPaths,
              allowedPaths: guardViolation.allowedPaths,
            },
          },
          durationMs: Date.now() - start,
        }
      }

      const rawResult = await tool.execute(block.input, context)
      const result = applyToolFailurePolicy(toolName, block.input, rawResult)
      await recordBashArtifactProgress(context?.taskState, toolName, block.input, start)
      if (result.metadata?.['usablePartialEvidence'] === true) {
        recordToolExecutionProgress(context?.taskState, toolName, block.input, result.metadata)
      }
      if (!result.isError) {
        recordWriteSuccess(context?.taskState, toolName, block.input, result.metadata)
        recordToolExecutionProgress(context?.taskState, toolName, block.input, result.metadata)
        await ensureRunWorkspaceForStructuredTask(context?.taskState, toolName, block.input, result.metadata)

        // B2: Mirror TodoWrite todos → plan.json when a RunWorkspace exists.
        const runWorkspaceB2 = context?.taskState?.run.runWorkspace
        if (toolName === 'TodoWrite' && runWorkspaceB2) {
          try {
            await mirrorTodosToRunWorkspace(block.input, runWorkspaceB2.runDir)
            clearEvidencePersistenceFailure(context?.taskState, 'todo_mirror')
          } catch (error: unknown) {
            const failure = buildEvidencePersistenceFailure('todo_mirror', error, block.id, toolName, runWorkspaceB2)
            recordEvidencePersistenceFailure(context?.taskState, failure)
            notifyEvidencePersistenceFailure(context, failure, result)
            result.metadata = { ...(result.metadata ?? {}), evidencePersistenceFailure: failure }
          }
        }

        // B3: Append write/edit/NotebookEdit artifacts within outputRoot → artifacts.json.
        const runWorkspaceB3 = context?.taskState?.run.runWorkspace
        if (runWorkspaceB3 && (toolName === 'write' || toolName === 'edit' || toolName === 'NotebookEdit')) {
          try {
            const artifactRecord = await recordWriteArtifact(
              toolName,
              result.metadata,
              runWorkspaceB3.runDir,
              runWorkspaceB3.outputRoot,
            )
            if (artifactRecord.recorded) {
              clearEvidencePersistenceFailure(context?.taskState, 'artifact_record', {
                runId: runWorkspaceB3.runId,
                runDir: runWorkspaceB3.runDir,
                outputRoot: runWorkspaceB3.outputRoot,
                toolUseId: block.id,
                toolName,
              })
            }
          } catch (error: unknown) {
            const failure = buildEvidencePersistenceFailure('artifact_record', error, block.id, toolName, runWorkspaceB3)
            recordEvidencePersistenceFailure(context?.taskState, failure)
            notifyEvidencePersistenceFailure(context, failure, result)
            result.metadata = { ...(result.metadata ?? {}), evidencePersistenceFailure: failure }
          }
        }
      }
      return {
        toolUseId: block.id,
        toolName,
        result,
        durationMs: Date.now() - start,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        toolUseId: block.id,
        toolName,
        result: { output: `Error: ${msg}`, isError: true },
        durationMs: Date.now() - start,
      }
    }
  }

  /** Execute all tool_use blocks (sequentially to avoid race conditions). */
  async executeAll(blocks: AnthropicToolUseBlock[], context?: ToolExecutionContext): Promise<ToolExecutionResult[]> {
    const results: ToolExecutionResult[] = []
    for (const block of blocks) {
      results.push(await this.executeTool(block, context))
    }
    return results
  }

  /** Convert execution results to tool_result content blocks for the next message. */
  toContentBlocks(results: ToolExecutionResult[]): AnthropicContentBlock[] {
    return results.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.toolUseId,
      content: r.result.output,
      is_error: r.result.isError,
      ...(r.result.metadata ? { metadata: r.result.metadata } : {}),
    }))
  }

  private registerDefaults(): void {
    // Shared plan-mode state
    const planState: PlanModeState = { inPlanMode: false }
    // Shared worktree state
    const worktreeState: WorktreeState = { inWorktree: false }

    this.register(createBashTool())
    this.register(createReadTool())
    this.register(createWriteTool())
    this.register(createEditTool())
    this.register(createGlobTool())
    this.register(createGrepTool())
    this.register(createWebFetchTool())
    this.register(createWebSearchTool())
    this.register(createTodoWriteTool())
    this.register(createAskUserQuestionTool())
    this.register(createSleepTool())
    this.register(createAgentRunListTool())
    this.register(createAgentRunGetTool())
    this.register(createLongTaskListTool())
    this.register(createLongTaskGetTool())
    this.register(createLongTaskAwaitTool())
    this.register(createLongTaskReplaceTool())
    this.register(createRuntimeRecoveryListTool())
    this.register(createRuntimeRecoveryGetTool())
    this.register(createJobListTool())
    this.register(createJobGetTool())
    this.register(createJobCancelTool())
    this.register(createBrowserJobTool())
    this.register(createEnterPlanModeTool(planState))
    this.register(createExitPlanModeTool(planState))
    this.register(createConfigTool())
    this.register(createNotebookEditTool())
    this.register(createEnterWorktreeTool(worktreeState))
    this.register(createExitWorktreeTool(worktreeState))
    this.register(createTaskCreateTool())
    this.register(createTaskListTool())
    this.register(createTaskGetTool())
    this.register(createTaskUpdateTool())
    this.register(createTaskStopTool())
    this.register(createTaskOutputTool())
    this.register(createTaskVerifyTool())
    this.register(createTeamCreateTool())
    this.register(createTeamDeleteTool())
    this.register(createToolSearchTool({
      getToolDescription: (name) => this.getToolDescription(name),
    }))
    this.register(createStructuredOutputTool())
    this.register(createRemoteTriggerTool())
    this.register(createMCPTool(this.mcpManager))
    this.register(createListMcpResourcesTool(this.mcpManager))
    this.register(createReadMcpResourceTool(this.mcpManager))
    this.register(createMcpAuthTool())
    this.register(createSkillTool())
    this.register(createLSPTool(getNativeLspProvider()))
    this.register(createPowerShellTool())
    this.register(createBriefTool())
    this.register(createDeliveryAuditTool())
    this.register(createSkillRoutePreviewTool())
    this.register(createRunWorkspaceTool())
    this.register(createProjectMapTool())
    this.register(createArtifactVerifyTool())
    this.register(createWorkflowRunTool())
    // ProbePlan registers without a live-conversation accessor by default;
    // ink-repl re-registers it with one, same pattern as Config/Agent.
    this.register(createProbePlanTool())
    this.register(createJudgeBackendProbeTool())
  }
}

function buildEvidencePersistenceFailure(
  operation: EvidencePersistenceOperation,
  error: unknown,
  toolUseId: string,
  toolName: string,
  runWorkspace: NonNullable<TaskExecutionState['run']['runWorkspace']>,
): EvidencePersistenceFailure {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const message = rawMessage
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 500)
  return {
    operation,
    runId: runWorkspace.runId,
    runDir: runWorkspace.runDir,
    outputRoot: runWorkspace.outputRoot,
    toolUseId,
    toolName,
    error: {
      name: error instanceof Error && error.name ? error.name : 'PersistenceError',
      message,
    },
    evidenceCompleteness: 'incomplete',
    acceptanceImpact: 'blocking',
    at: new Date().toISOString(),
  }
}

function notifyEvidencePersistenceFailure(
  context: ToolExecutionContext | undefined,
  failure: EvidencePersistenceFailure,
  result: ToolResult,
): void {
  try {
    context?.onEvidencePersistenceFailure?.(failure)
  } catch (error: unknown) {
    const rawMessage = error instanceof Error ? error.message : String(error)
    result.metadata = {
      ...(result.metadata ?? {}),
      evidencePersistenceObserverFailure: rawMessage.replace(/[\r\n]+/g, ' ').slice(0, 200),
    }
  }
}

/**
 * B2: Mirror TodoWrite todos to plan.json in the active RunWorkspace.
 * Mapping: todo.content → step.title; todo.status → step.status;
 * todo.activeForm → step.activeForm. Single-direction mirror only.
 */
async function mirrorTodosToRunWorkspace(
  input: Record<string, unknown>,
  runDir: string,
): Promise<void> {
  const todos = input['todos']
  if (!Array.isArray(todos)) return
  const steps = todos.map((todo: Record<string, unknown>, index: number) => ({
    id: `todo-${index + 1}`,
    title: typeof todo['content'] === 'string' ? todo['content'] : String(todo['content'] ?? ''),
    status: typeof todo['status'] === 'string' ? todo['status'] : 'pending',
    ...(typeof todo['activeForm'] === 'string' && todo['activeForm'] !== todo['content']
      ? { activeForm: todo['activeForm'] }
      : {}),
  }))
  await writePlan(runDir, {
    version: 1,
    source: 'TodoWrite',
    updatedAt: new Date().toISOString(),
    steps,
  })
}

/**
 * B3: Record a write/edit/NotebookEdit artifact into artifacts.json.
 * Only records paths within outputRoot (isWithinRunRoot guard).
 * Reports whether a write produced a durable artifact record. A successful
 * primary write outside outputRoot is not an artifact-record repair.
 */
type ArtifactRecordOutcome =
  | { recorded: true }
  | { recorded: false; reason: 'missing_metadata' | 'missing_path' | 'outside_output_root' }

async function recordWriteArtifact(
  toolName: string,
  metadata: Record<string, unknown> | undefined,
  runDir: string,
  outputRoot: string,
): Promise<ArtifactRecordOutcome> {
  if (!metadata) return { recorded: false, reason: 'missing_metadata' }
  const rawPath = toolName === 'NotebookEdit'
    ? metadata['notebook_path']
    : metadata['path']
  if (typeof rawPath !== 'string' || !rawPath) return { recorded: false, reason: 'missing_path' }
  const artifactPath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rawPath)
  const normalizedOutputRoot = normalize(outputRoot)
  const normalizedArtifact = normalize(artifactPath)
  // Only record artifacts within outputRoot
  if (normalizedArtifact !== normalizedOutputRoot && !normalizedArtifact.startsWith(`${normalizedOutputRoot}/`)) {
    return { recorded: false, reason: 'outside_output_root' }
  }
  const isFinalDir = normalizedArtifact.startsWith(normalize(`${outputRoot}/final`))
  await recordArtifact(runDir, {
    path: artifactPath,
    origin: toolName as 'write' | 'edit',
    participatesInFinal: isFinalDir,
  })
  return { recorded: true }
}
