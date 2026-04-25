/**
 * OwlCoda Native Tool Dispatcher
 *
 * Routes tool_use blocks from the model to native tool implementations,
 * executes them, and returns tool_result blocks for the conversation.
 */

import type { AnthropicToolUseBlock, AnthropicContentBlock } from './protocol/types.js'
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
import { createSendMessageTool } from './tools/send-message.js'
import { createTeamCreateTool } from './tools/team-create.js'
import { createTeamDeleteTool } from './tools/team-delete.js'
import { createToolSearchTool } from './tools/tool-search.js'
import { createStructuredOutputTool } from './tools/structured-output.js'
import { createScheduleCronTool } from './tools/schedule-cron.js'
import { createRemoteTriggerTool } from './tools/remote-trigger.js'
import { createMCPTool } from './tools/mcp-tool.js'
import { createListMcpResourcesTool } from './tools/list-mcp-resources.js'
import { createReadMcpResourceTool } from './tools/read-mcp-resource.js'
import { createMcpAuthTool } from './tools/mcp-auth.js'
import type { MCPManager } from './mcp/manager.js'
import { createSkillTool } from './tools/skill.js'
import { createLSPTool } from './tools/lsp.js'
import { createPowerShellTool } from './tools/powershell.js'
import { createBriefTool } from './tools/brief.js'
import { createTungstenTool } from './tools/tungsten.js'
import { createWorkflowTool } from './tools/workflow.js'
import {
  evaluateWriteGuard,
  markTaskWriteScopeBlocked,
  recordWriteSuccess,
} from './task-state.js'

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

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Execute a single tool_use block. */
  async executeTool(block: AnthropicToolUseBlock, context?: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(block.name)
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

    const start = Date.now()
    try {
      const guardViolation = evaluateWriteGuard(block.name, block.input, context?.taskState)
      if (guardViolation) {
        if (context?.taskState) {
          markTaskWriteScopeBlocked(context.taskState, guardViolation.message, guardViolation.attemptedPath)
        }
        return {
          toolUseId: block.id,
          toolName: block.name,
          result: {
            output: guardViolation.message,
            isError: true,
            metadata: {
              taskGuardBlocked: true,
              attemptedPath: guardViolation.attemptedPath,
              allowedPaths: guardViolation.allowedPaths,
            },
          },
          durationMs: Date.now() - start,
        }
      }

      const result = await tool.execute(block.input, context)
      if (!result.isError) {
        recordWriteSuccess(context?.taskState, block.name, block.input, result.metadata)
      }
      return {
        toolUseId: block.id,
        toolName: block.name,
        result,
        durationMs: Date.now() - start,
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        toolUseId: block.id,
        toolName: block.name,
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
    this.register(createSendMessageTool())
    this.register(createTeamCreateTool())
    this.register(createTeamDeleteTool())
    this.register(createToolSearchTool())
    this.register(createStructuredOutputTool())
    this.register(createScheduleCronTool())
    this.register(createRemoteTriggerTool())
    this.register(createMCPTool(this.mcpManager))
    this.register(createListMcpResourcesTool(this.mcpManager))
    this.register(createReadMcpResourceTool(this.mcpManager))
    this.register(createMcpAuthTool())
    this.register(createSkillTool())
    this.register(createLSPTool())
    this.register(createPowerShellTool())
    this.register(createBriefTool())
    this.register(createTungstenTool())
    this.register(createWorkflowTool())
  }
}
