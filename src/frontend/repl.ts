/**
 * OwlCoda Source-First REPL — interactive chat frontend with tool execution.
 * Zero runtime dependencies. Uses built-in readline + http.
 * Talks to the OwlCoda proxy using Anthropic Messages API format.
 */

import * as readline from 'node:readline'
import { request as httpRequest } from 'node:http'
import type { OwlCodaConfig } from '../config.js'
import { getDefaultConfiguredModel, resolveConfiguredModel, overlayAvailability, probeRouterModels } from '../config.js'
import { VERSION } from '../cli-core.js'
import { isCommand, handleCommand, type CommandContext } from './commands.js'
import { formatBanner, formatUsage, formatStopReason, formatToolCall, formatToolResult, formatError, formatWarning, dim, bold } from './display.js'
import { resolveClientHost } from '../cli-core.js'
import { executeToolUse, TOOL_DEFINITIONS, type ApprovalCallback } from '../runtime/tools.js'
import { createSession, saveMessage, loadSession, getLastSessionId, updateSessionModel } from '../history/sessions.js'
import { onSessionEnd } from '../skills/auto-synth.js'
import { logWarn } from '../logger.js'

// ─── Anthropic message types (minimal subset) ───

interface AnthropicTextBlock {
  type: 'text'
  text: string
}

interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}

type ContentBlock = AnthropicTextBlock | AnthropicToolUseBlock

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[] | AnthropicToolResultBlock[]
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
}

interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: ContentBlock[]
  model: string
  stop_reason: string
  usage: AnthropicUsage
}

// ─── SSE types ───

interface SSEMessageStart {
  type: 'message_start'
  message: {
    id: string
    model: string
    usage: { input_tokens: number; output_tokens: number }
  }
}

interface SSEContentBlockStart {
  type: 'content_block_start'
  index: number
  content_block: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
}

interface SSEContentBlockDelta {
  type: 'content_block_delta'
  index: number
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string }
}

interface SSEMessageDelta {
  type: 'message_delta'
  delta: { stop_reason: string }
  usage: { output_tokens: number }
}

type SSEEvent = SSEMessageStart | SSEContentBlockStart | SSEContentBlockDelta | SSEMessageDelta | { type: string }

// ─── REPL state ───

interface ReplState {
  messages: AnthropicMessage[]
  currentModel: string
  running: boolean
  sessionId: string | null
  autoApprove: boolean
}

// ─── HTTP client to OwlCoda proxy ───

function postMessages(
  config: OwlCodaConfig,
  messages: AnthropicMessage[],
  model: string,
  stream: boolean,
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>,
): Promise<{ statusCode: number; body: string; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const host = resolveClientHost(config.host)
    const payload: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      messages,
      stream,
    }
    if (tools && tools.length > 0) {
      payload.tools = tools
    }
    const body = JSON.stringify(payload)

    const req = httpRequest({
      hostname: host,
      port: config.port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'owlcoda-local-key-' + String(config.port),
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode ?? 500,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers as Record<string, string>,
        })
      })
    })

    req.on('error', reject)
    req.setTimeout(config.routerTimeoutMs, () => {
      req.destroy(new Error('Request timed out'))
    })
    req.write(body)
    req.end()
  })
}

/** Streaming result from one API call */
interface StreamResult {
  contentBlocks: ContentBlock[]
  assistantText: string
  stopReason: string
  inputTokens: number
  outputTokens: number
  error?: Error
}

function streamMessages(
  config: OwlCodaConfig,
  messages: AnthropicMessage[],
  model: string,
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> | undefined,
  onText: (text: string) => void,
): Promise<StreamResult> {
  return new Promise((resolve) => {
    const host = resolveClientHost(config.host)
    const payload: Record<string, unknown> = {
      model,
      max_tokens: 8192,
      messages,
      stream: true,
    }
    if (tools && tools.length > 0) {
      payload.tools = tools
    }
    const body = JSON.stringify(payload)

    const result: StreamResult = {
      contentBlocks: [],
      assistantText: '',
      stopReason: 'end_turn',
      inputTokens: 0,
      outputTokens: 0,
    }

    // Track current block being streamed
    let currentBlockType: 'text' | 'tool_use' | null = null
    let currentToolId = ''
    let currentToolName = ''
    let currentToolJson = ''

    function flushCurrentBlock(): void {
      if (currentBlockType === 'text' && result.assistantText) {
        result.contentBlocks.push({ type: 'text', text: result.assistantText })
      } else if (currentBlockType === 'tool_use' && currentToolId) {
        let parsedInput: Record<string, unknown> = {}
        try { parsedInput = JSON.parse(currentToolJson || '{}') } catch { /* empty */ }
        result.contentBlocks.push({
          type: 'tool_use',
          id: currentToolId,
          name: currentToolName,
          input: parsedInput,
        })
      }
    }

    const req = httpRequest({
      hostname: host,
      port: config.port,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'owlcoda-local-key-' + String(config.port),
        'anthropic-version': '2023-06-01',
      },
    }, res => {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const errBody = Buffer.concat(chunks).toString('utf-8')
          try {
            const parsed = JSON.parse(errBody)
            result.error = new Error(parsed.error?.message ?? `HTTP ${res.statusCode}`)
          } catch {
            result.error = new Error(`HTTP ${res.statusCode}: ${errBody.slice(0, 200)}`)
          }
          resolve(result)
        })
        return
      }

      let buffer = ''
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') continue
          try {
            const event = JSON.parse(data) as SSEEvent
            switch (event.type) {
              case 'message_start': {
                const msg = (event as SSEMessageStart).message
                result.inputTokens = msg.usage.input_tokens
                break
              }
              case 'content_block_start': {
                // Flush previous block if any
                if (currentBlockType) flushCurrentBlock()

                const block = (event as SSEContentBlockStart).content_block
                if (block.type === 'tool_use') {
                  currentBlockType = 'tool_use'
                  currentToolId = block.id
                  currentToolName = block.name
                  currentToolJson = ''
                } else {
                  currentBlockType = 'text'
                  // Reset text accumulation for this new text block
                  // Note: assistantText accumulates across all text blocks
                }
                break
              }
              case 'content_block_delta': {
                if ('delta' in event) {
                  const delta = (event as SSEContentBlockDelta).delta
                  if ('text' in delta) {
                    result.assistantText += delta.text
                    onText(delta.text)
                  } else if ('partial_json' in delta) {
                    currentToolJson += delta.partial_json
                  }
                }
                break
              }
              case 'content_block_stop': {
                flushCurrentBlock()
                currentBlockType = null
                break
              }
              case 'message_delta': {
                const md = event as SSEMessageDelta
                result.stopReason = md.delta.stop_reason
                result.outputTokens = md.usage.output_tokens
                break
              }
            }
          } catch {
            // Skip malformed events
          }
        }
      })

      res.on('end', () => {
        // Flush any remaining block
        if (currentBlockType) flushCurrentBlock()
        resolve(result)
      })
    })

    req.on('error', (err) => {
      result.error = err
      resolve(result)
    })
    req.setTimeout(config.routerTimeoutMs, () => {
      req.destroy(new Error('Stream timed out'))
    })
    req.write(body)
    req.end()
  })
}

// ─── Tool definitions for API requests ───

function getToolDefsForApi(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return TOOL_DEFINITIONS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

// ─── Approval via readline ───

function createApprovalCallback(rl: readline.Interface): ApprovalCallback {
  return (tool: string, detail: string) => {
    return new Promise((resolve) => {
      process.stderr.write(`\n${bold(`⚡ ${tool} requires approval:`)}\n`)
      process.stderr.write(`  ${detail}\n`)
      rl.question(dim('  Allow? [y/N] '), (answer) => {
        resolve(answer.trim().toLowerCase() === 'y')
      })
    })
  }
}

// ─── Main REPL ───

export async function startRepl(config: OwlCodaConfig, resumeSessionId?: string, explicitModel?: string): Promise<void> {
  const defaultModel = getDefaultConfiguredModel(config)
  let initialModel = defaultModel?.id ?? 'unknown'

  // Model priority: CLI explicit > resumed session > catalog default
  if (explicitModel) {
    const resolved = resolveConfiguredModel(config, explicitModel)
    initialModel = resolved.id
  }

  const state: ReplState = {
    messages: [],
    currentModel: initialModel,
    running: true,
    sessionId: null,
    autoApprove: false,
  }

  // Resume session if requested
  if (resumeSessionId) {
    const session = await loadSession(resumeSessionId)
    if (session) {
      state.messages = session.messages.map(m => ({
        role: m.role,
        content: m.content as string | ContentBlock[],
      }))
      // CLI explicit model takes priority over resumed session model
      if (!explicitModel) {
        state.currentModel = session.meta.model
      }
      state.sessionId = session.meta.id
      process.stderr.write(dim(`Resumed session ${session.meta.id} (${session.meta.messageCount} messages)\n`))
    } else {
      process.stderr.write(formatWarning(`Session ${resumeSessionId} not found, starting fresh\n`))
    }
  } else {
    // Check for --resume last
    const lastId = await getLastSessionId()
    if (lastId) {
      process.stderr.write(dim(`Last session: ${lastId} (use /resume to continue)\n`))
    }
  }

  // Create new session if not resuming
  if (!state.sessionId) {
    try {
      state.sessionId = await createSession(state.currentModel, process.cwd())
    } catch {
      // Non-fatal — session persistence optional
    }
  }

  // Show banner
  const capabilities = ['streaming', 'multi-turn', 'tool execution', 'local models']
  process.stderr.write(formatBanner(VERSION, state.currentModel, capabilities))

  // Probe router for model availability overlay (non-blocking)
  probeRouterModels(config.routerUrl).then(routerIds => {
    overlayAvailability(config, routerIds)
  }).catch(e => logWarn('repl', `Router model probe failed: ${e}`))

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${dim('>')} `,
    terminal: process.stdin.isTTY ?? false,
  })

  const approvalCallback = createApprovalCallback(rl)

  const commandContext: CommandContext = {
    config,
    currentModel: state.currentModel,
    sessionId: state.sessionId,
    messageCount: state.messages.length,
    autoApprove: state.autoApprove,
    setModel: (model: string) => {
      state.currentModel = model
      commandContext.currentModel = model
      // Persist model change to session file so /resume restores last real model
      if (state.sessionId) {
        updateSessionModel(state.sessionId, model).catch(e => logWarn('repl', `Failed to persist model change: ${e}`))
      }
    },
    setAutoApprove: (value: boolean) => {
      state.autoApprove = value
      commandContext.autoApprove = value
    },
    clearMessages: () => {
      state.messages = []
    },
    quit: () => {
      state.running = false
      rl.close()
    },
    resumeSession: async (target: string) => {
      let targetId = target
      if (!targetId || targetId === 'last') {
        targetId = (await getLastSessionId()) || ''
      }
      if (!targetId) return null
      const session = await loadSession(targetId)
      if (!session) return null
      state.messages = session.messages.map(m => ({
        role: m.role,
        content: m.content as string | ContentBlock[],
      }))
      state.currentModel = session.meta.model
      state.sessionId = session.meta.id
      commandContext.currentModel = state.currentModel
      commandContext.sessionId = state.sessionId
      commandContext.messageCount = state.messages.length
      return session.meta.id
    },
  }

  rl.prompt()

  rl.on('line', async (line: string) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }

    // Handle slash commands
    if (isCommand(input)) {
      const result = await handleCommand(input, commandContext)
      // Sync context fields after command execution
      commandContext.messageCount = state.messages.length
      commandContext.sessionId = state.sessionId
      if (result.output) {
        process.stderr.write(result.output + '\n\n')
      }
      if (state.running) rl.prompt()
      return
    }

    // Add user message
    state.messages.push({ role: 'user', content: input })
    await persistMessage(state.sessionId, 'user', input)

    // Run the conversation turn (may loop for tool use)
    await runConversationTurn(config, state, rl, approvalCallback)

    if (state.running) rl.prompt()
  })

  rl.on('close', async () => {
    state.running = false
    // Fire-and-forget skill auto-synthesis
    if (state.sessionId) {
      const session = await loadSession(state.sessionId).catch(e => { logWarn('repl', `Failed to load session for auto-synth: ${e}`); return null })
      if (session) {
        onSessionEnd(session).catch(e => logWarn('repl', `Session-end auto-synth failed: ${e}`))
      }
    }
    process.stderr.write(dim(`\nOwlCoda session ended. Session: ${state.sessionId ?? 'none'}\n`))
  })

  // Keep alive
  await new Promise<void>((resolve) => {
    rl.on('close', resolve)
  })
}

/**
 * Run one conversation turn, potentially looping for tool execution.
 * Model may return tool_use → execute → tool_result → continue → repeat.
 */
async function runConversationTurn(
  config: OwlCodaConfig,
  state: ReplState,
  _rl: readline.Interface,
  approvalCallback: ApprovalCallback,
): Promise<void> {
  const tools = getToolDefsForApi()
  let loopCount = 0
  const maxToolLoops = 20  // Safety limit

  while (loopCount < maxToolLoops) {
    loopCount++
    process.stderr.write('\n')

    const result = await streamMessages(
      config,
      state.messages,
      state.currentModel,
      tools,
      (text) => {
        process.stderr.write(text)
      },
    )

    if (result.error) {
      process.stderr.write('\n' + formatError(result.error.message) + '\n\n')
      // Remove the failed user message if this is the first attempt
      if (loopCount === 1 && state.messages.length > 0 && state.messages[state.messages.length - 1]!.role === 'user') {
        state.messages.pop()
      }
      return
    }

    // Build assistant message content
    const assistantContent: ContentBlock[] = result.contentBlocks.length > 0
      ? result.contentBlocks
      : (result.assistantText ? [{ type: 'text' as const, text: result.assistantText }] : [])

    // Push assistant message to history
    state.messages.push({ role: 'assistant', content: assistantContent })
    await persistMessage(state.sessionId, 'assistant', assistantContent)

    // Show usage
    process.stderr.write('\n')
    const reasonSuffix = formatStopReason(result.stopReason)
    const usage = formatUsage(result.inputTokens, result.outputTokens)
    process.stderr.write(`${usage}${reasonSuffix}\n`)

    // If stop_reason is NOT tool_use, we're done
    if (result.stopReason !== 'tool_use') {
      process.stderr.write('\n')
      return
    }

    // ── Tool execution loop ──
    const toolUseBlocks = assistantContent.filter(
      (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
    )

    if (toolUseBlocks.length === 0) {
      process.stderr.write('\n')
      return
    }

    process.stderr.write('\n')
    const toolResults: AnthropicToolResultBlock[] = []

    for (const toolUse of toolUseBlocks) {
      process.stderr.write(formatToolCall(toolUse.name, toolUse.input) + '\n')

      const toolResult = await executeToolUse(
        { id: toolUse.id, name: toolUse.name, input: toolUse.input },
        {
          cwd: process.cwd(),
          autoApprove: state.autoApprove,
          approve: approvalCallback,
        },
      )

      process.stderr.write(formatToolResult(toolUse.name, toolResult.isError) + '\n')

      // Show truncated output
      const preview = toolResult.content.length > 200
        ? toolResult.content.slice(0, 200) + '...'
        : toolResult.content
      if (preview.trim()) {
        process.stderr.write(dim(`  ${preview.split('\n').slice(0, 5).join('\n  ')}`) + '\n')
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolResult.toolUseId,
        content: toolResult.content,
        is_error: toolResult.isError || undefined,
      })
    }

    // Add tool results as user message (Anthropic protocol)
    const toolResultMessage: AnthropicMessage = {
      role: 'user',
      content: toolResults as any,
    }
    state.messages.push(toolResultMessage)
    await persistMessage(state.sessionId, 'user', toolResults)

    // Continue the loop — model will receive tool results and respond
    process.stderr.write(dim('  Continuing with tool results...') + '\n')
  }

  process.stderr.write(formatWarning(`Tool execution loop limit (${maxToolLoops}) reached`) + '\n\n')
}

/** Persist message to session (non-fatal on failure). */
async function persistMessage(sessionId: string | null, role: 'user' | 'assistant', content: unknown): Promise<void> {
  if (!sessionId) return
  try {
    await saveMessage(sessionId, role, content)
  } catch {
    // Non-fatal — don't break the conversation
  }
}

/**
 * Send a single non-streaming request (for programmatic use / non-interactive mode).
 */
export async function sendMessage(
  config: OwlCodaConfig,
  messages: AnthropicMessage[],
  model: string,
): Promise<AnthropicResponse> {
  const resp = await postMessages(config, messages, model, false)
  if (resp.statusCode !== 200) {
    let errorMsg: string
    try {
      const parsed = JSON.parse(resp.body)
      errorMsg = parsed.error?.message ?? `HTTP ${resp.statusCode}`
    } catch {
      errorMsg = `HTTP ${resp.statusCode}: ${resp.body.slice(0, 200)}`
    }
    throw new Error(errorMsg)
  }
  return JSON.parse(resp.body) as AnthropicResponse
}

/**
 * Run a single non-interactive conversation (for `owlcoda run`).
 * Supports tool execution loop, returns final text output.
 */
export interface NonInteractiveOptions {
  model?: string
  autoApprove?: boolean
  json?: boolean
  resumeSessionId?: string
}

export async function runNonInteractive(
  config: OwlCodaConfig,
  prompt: string,
  opts: NonInteractiveOptions = {},
): Promise<{ text: string; exitCode: number }> {
  const { model: explicitModel, autoApprove = false, json: jsonOutput = false, resumeSessionId } = opts
  const defaultModel = getDefaultConfiguredModel(config)
  let currentModel = explicitModel ?? defaultModel?.id ?? 'unknown'
  let resumed = false

  // Session handling: resume or create new
  let sessionId: string | null = null
  const messages: AnthropicMessage[] = []

  if (resumeSessionId) {
    const resolvedId = resumeSessionId === 'last'
      ? await getLastSessionId()
      : resumeSessionId
    if (resolvedId) {
      const session = await loadSession(resolvedId)
      if (session) {
        sessionId = resolvedId
        resumed = true
        // Restore session model unless explicit --model overrides
        if (!explicitModel) {
          currentModel = session.meta.model
        }
        // Restore history into messages
        for (const msg of session.messages) {
          messages.push({ role: msg.role, content: msg.content as any })
        }
        process.stderr.write(dim(`  ↩ Resumed session ${resolvedId} (${session.messages.length} messages, model: ${currentModel})\n`))
      } else {
        process.stderr.write(formatWarning(`Session ${resolvedId} not found, starting fresh`) + '\n')
      }
    } else {
      process.stderr.write(formatWarning('No previous session found, starting fresh') + '\n')
    }
  }

  // Create session if we didn't resume one
  if (!sessionId) {
    try {
      sessionId = await createSession(currentModel, process.cwd())
    } catch {
      // Non-fatal: continue without session persistence
    }
  }

  // Add the new user prompt
  messages.push({ role: 'user', content: prompt })
  if (sessionId) {
    try { await saveMessage(sessionId, 'user', prompt) } catch { /* non-fatal */ }
  }

  const tools = getToolDefsForApi()
  const maxLoops = 20
  let totalText = ''
  const toolCalls: Array<{ tool: string; input: Record<string, unknown>; output: string; isError: boolean }> = []

  // Auto-synth on session end (fire-and-forget)
  const triggerAutoSynth = () => {
    if (sessionId) {
      loadSession(sessionId).then(s => { if (s) onSessionEnd(s).catch(e => logWarn('repl', `Auto-synth failed: ${e}`)) }).catch(e => logWarn('repl', `Failed to load session for auto-synth: ${e}`))
    }
  }

  for (let i = 0; i < maxLoops; i++) {
    const resp = await postMessages(config, messages, currentModel, false, tools)
    if (resp.statusCode !== 200) {
      let errMsg: string
      try {
        const parsed = JSON.parse(resp.body)
        errMsg = parsed.error?.message ?? `HTTP ${resp.statusCode}`
      } catch {
        errMsg = `HTTP ${resp.statusCode}: ${resp.body.slice(0, 200)}`
      }
      process.stderr.write(formatError(errMsg) + '\n')
      if (jsonOutput) {
        process.stdout.write(JSON.stringify({ text: '', model: currentModel, session_id: sessionId, resumed, exit_code: 2, error: errMsg, tool_calls: toolCalls }) + '\n')
      }
      return { text: '', exitCode: 2 }
    }

    const parsed = JSON.parse(resp.body) as AnthropicResponse
    const textBlocks = parsed.content.filter(b => b.type === 'text') as AnthropicTextBlock[]
    totalText += textBlocks.map(b => b.text).join('')

    // Push assistant message
    messages.push({ role: 'assistant', content: parsed.content })
    if (sessionId) {
      try { await saveMessage(sessionId, 'assistant', parsed.content) } catch { /* non-fatal */ }
    }

    if (parsed.stop_reason !== 'tool_use') {
      triggerAutoSynth()
      if (jsonOutput) {
        process.stdout.write(JSON.stringify({ text: totalText, model: currentModel, session_id: sessionId, resumed, exit_code: 0, tool_calls: toolCalls }) + '\n')
      }
      return { text: jsonOutput ? '' : totalText, exitCode: 0 }
    }

    // Execute tools
    const toolUseBlocks = parsed.content.filter(
      (b): b is AnthropicToolUseBlock => b.type === 'tool_use'
    )

    const toolResults: AnthropicToolResultBlock[] = []
    for (const tu of toolUseBlocks) {
      process.stderr.write(dim(`  ⚙ ${tu.name}`) + '\n')
      const result = await executeToolUse(
        { id: tu.id, name: tu.name, input: tu.input },
        { cwd: process.cwd(), autoApprove, approve: async () => false },
      )
      toolCalls.push({ tool: tu.name, input: tu.input, output: result.content, isError: result.isError })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: result.toolUseId,
        content: result.content,
        is_error: result.isError || undefined,
      })
    }

    messages.push({ role: 'user', content: toolResults as any })
    // Persist tool_result to session transcript (Wave 2: transcript completeness)
    if (sessionId) {
      try { await saveMessage(sessionId, 'user', toolResults) } catch { /* non-fatal */ }
    }
  }

  process.stderr.write(formatWarning('Tool loop limit reached') + '\n')
  triggerAutoSynth()
  if (jsonOutput) {
    process.stdout.write(JSON.stringify({ text: totalText, model: currentModel, session_id: sessionId, resumed, exit_code: 3, tool_calls: toolCalls }) + '\n')
  }
  return { text: jsonOutput ? '' : totalText, exitCode: 3 }
}
