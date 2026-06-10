import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { addUserMessage, createConversation, runConversationLoop } from '../../src/native/conversation.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'
import { evaluateProjectMapDogfoodAcceptance } from '../../src/native/project-map-acceptance.js'
import type { AnthropicMessagesRequest } from '../../src/native/protocol/types.js'

describe('Project Map Runtime Control Plane dogfood acceptance', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owlcoda-project-map-acceptance-'))
    initGit(tmpDir, 'dddddddddddddddddddddddddddddddddddddddd')
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'Use Project Map before planning.')
    fs.mkdirSync(path.join(tmpDir, '.claude', 'rules'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, '.claude', 'rules', 'runtime-control-plane.md'), 'Stay on Runtime Control Plane work.')
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true })
    writeJson(path.join(tmpDir, 'package.json'), {
      name: 'acceptance-fixture',
      version: '1.0.0',
      scripts: {
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
    })
    process.env['OWLCODA_PROJECT_MAP'] = '1'
  })

  afterEach(() => {
    delete process.env['OWLCODA_PROJECT_MAP']
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes a bounded fake-router run that uses Project Map and finishes on the control-plane objective', async () => {
    const requests: AnthropicMessagesRequest[] = []
    const toolCalls: Array<{ tool: string }> = []
    const approvalDenials: Array<{ toolName: string; reason: string }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String((init as RequestInit).body)) as AnthropicMessagesRequest)
      return requests.length === 1
        ? toolUseResponse('ProjectMap', { action: 'scan', cwd: tmpDir })
        : textResponse([
          `Conclusion: Runtime Control Plane next gap is the strict fake-router dogfood acceptance gate (pass ${requests.length}).`,
          '',
          'Evidence: Project Map was used to identify sources, boundaries, verification, and freshness before selecting the next step.',
          '',
          'Uncertainty: Real dogfood false positives still need tracking before any default-on release decision.',
          '',
          'Next: Keep the bounded Project Map acceptance check in place.',
        ].join('\n'))
    })

    const conv = createConversation({ system: 'base system', model: 'test-model' })
    addUserMessage(conv, 'Use Project Map read-only and answer in chat with a Runtime Control Plane next-gap plan.')

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      cwd: tmpDir,
      maxIterations: 4,
      callbacks: {
        onToolStart(tool) {
          toolCalls.push({ tool })
        },
        async onToolApproval(toolName) {
          const allowed = toolName === 'ProjectMap' || toolName === 'read' || toolName === 'grep' || toolName === 'glob'
          if (!allowed) approvalDenials.push({ toolName, reason: 'not in acceptance allowlist' })
          return allowed
        },
      },
    })

    const acceptance = evaluateProjectMapDogfoodAcceptance({
      finalText: result.finalText,
      iterations: result.iterations,
      maxIterations: 4,
      stopReason: result.stopReason,
      toolCalls,
      approvalDenials,
      systemPrompt: extractSystemText(requests[0]!),
    })

    expect(acceptance).toMatchObject({
      ok: true,
      failures: [],
      checks: {
        projectMapUsed: true,
        promptInjected: true,
        withinIterationBudget: true,
        noUnauthorizedToolAttempts: true,
        finalAnswerOnObjective: true,
      },
    })
  })

  it('forces tool-free synthesis before a bounded free-mode Project Map dogfood run hits the cap', async () => {
    const requests: AnthropicMessagesRequest[] = []
    const notices: string[] = []
    const toolCalls: Array<{ tool: string }> = []
    const approvalDenials: Array<{ toolName: string; reason: string }> = []
    const readPath = path.join(tmpDir, 'AGENTS.md')
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String((init as RequestInit).body)) as AnthropicMessagesRequest)
      if (requests.length === 1) {
        return toolUseResponse('ProjectMap', { action: 'scan', cwd: tmpDir }, 'tool-1')
      }
      if (requests.length === 2) {
        return toolUseResponse('read', { path: readPath }, 'tool-2')
      }
      if (requests.length === 3) {
        return toolUseResponse('glob', { pattern: 'docs/execution-prompts/PROJECT_MAP*', cwd: tmpDir }, 'tool-3')
      }
      return textResponse([
        'Conclusion: Project Map Runtime Control Plane dogfood should close through bounded synthesis, not continued exploration.',
        'Evidence: Project Map and repository instructions were used before selecting the next control-plane gap.',
        'Uncertainty: Real dogfood false positives still need tracking before any default-on release decision.',
        'Next: Keep OWLCODA_PROJECT_MAP=0 rollback available and rerun strict dogfood acceptance.',
      ].join('\n\n'))
    })

    const conv = createConversation({ system: 'base system', model: 'test-model' })
    addUserMessage(conv, 'Use Project Map to inspect this repo read-only and produce a Runtime Control Plane next-gap plan.')

    const result = await runConversationLoop(conv, new ToolDispatcher(), {
      apiBaseUrl: 'http://localhost:0',
      apiKey: 'test-key',
      cwd: tmpDir,
      maxIterations: 4,
      callbacks: {
        onNotice(notice) {
          notices.push(notice)
        },
        onToolStart(tool) {
          toolCalls.push({ tool })
        },
        async onToolApproval(toolName) {
          const allowed = toolName === 'ProjectMap' || toolName === 'read' || toolName === 'grep' || toolName === 'glob'
          if (!allowed) approvalDenials.push({ toolName, reason: 'not in acceptance allowlist' })
          return allowed
        },
      },
    })

    const synthesisRequest = requests[3]!
    const synthesisText = requestText(synthesisRequest)
    const acceptance = evaluateProjectMapDogfoodAcceptance({
      finalText: result.finalText,
      iterations: result.iterations,
      maxIterations: 4,
      stopReason: result.stopReason,
      toolCalls,
      approvalDenials,
      systemPrompt: extractSystemText(requests[0]!),
    })

    expect(result.stopReason).toBe('end_turn')
    expect(synthesisRequest.tool_choice).toEqual({ type: 'none' })
    expect(synthesisRequest.tools).toBeUndefined()
    expect(synthesisRequest.stream).toBe(false)
    expect(synthesisText).toContain('Respond now using the required final-answer contract only.')
    expect(synthesisText).toContain('Keep the full answer under 160 words.')
    expect(synthesisText).toContain('Do not include file-line citation lists or long bullet lists.')
    expect(synthesisText).toContain('The Next section must end with a period.')
    expect(synthesisRequest.messages.some((message) => messageHasToolUse(message, 'ProjectMap'))).toBe(true)
    expect(synthesisRequest.messages.some(messageHasToolResult)).toBe(true)
    expect(notices.some((notice) => notice.includes('Project Map convergence'))).toBe(true)
    expect(acceptance.ok).toBe(true)
  })

  it('fails acceptance when a fake-router run attempts an unauthorized tool', () => {
    const acceptance = evaluateProjectMapDogfoodAcceptance({
      finalText: 'Runtime Control Plane next gap: strict acceptance.',
      iterations: 2,
      maxIterations: 4,
      stopReason: 'end_turn',
      toolCalls: [{ tool: 'ProjectMap' }],
      approvalDenials: [{ toolName: 'bash', reason: 'deny-tool-not-allowed' }],
      systemPrompt: '<project_map>\nPackage: fixture\n</project_map>',
    })

    expect(acceptance.ok).toBe(false)
    expect(acceptance.failures).toContain('unauthorized_tool_attempt:bash')
  })

  it('fails acceptance when the final answer drifts away from Runtime Control Plane work', () => {
    const acceptance = evaluateProjectMapDogfoodAcceptance({
      finalText: 'The next slice should be ADR-007-FOLLOW to clean up native tool stubs.',
      iterations: 2,
      maxIterations: 4,
      stopReason: 'end_turn',
      toolCalls: [{ tool: 'ProjectMap' }],
      approvalDenials: [],
      systemPrompt: '<project_map>\nPackage: fixture\n</project_map>',
    })

    expect(acceptance.ok).toBe(false)
    expect(acceptance.failures).toContain('final_answer_off_objective')
  })

  it('accepts ProjectMap camelcase wording as on-objective Runtime Control Plane work', () => {
    const acceptance = evaluateProjectMapDogfoodAcceptance({
      finalText: [
        'Conclusion:',
        'The Runtime Control Plane is ready for a ProjectMap beta release decision packet.',
        '',
        'Evidence:',
        'The ProjectMap tool was used and acceptance stayed on the runtime control plane objective.',
        '',
        'Uncertainty:',
        'Default-on remains a later decision.',
        '',
        'Next:',
        'Keep OWLCODA_PROJECT_MAP=0 rollback available.',
      ].join('\n'),
      iterations: 4,
      maxIterations: 8,
      stopReason: 'end_turn',
      toolCalls: [{ tool: 'ProjectMap' }],
      approvalDenials: [],
      systemPrompt: '<project_map>\nPackage: fixture\n</project_map>',
    })

    expect(acceptance.ok).toBe(true)
    expect(acceptance.checks.finalAnswerOnObjective).toBe(true)
  })

  it('fails acceptance when a contract-style final answer is truncated', () => {
    const acceptance = evaluateProjectMapDogfoodAcceptance({
      finalText:
        'Conclusion:\n' +
        'The Project Map Runtime Control Plane has verification profile evidence.\n\n' +
        'Evidence:\n' +
        '- `ProjectMapSnapshot.verificationProfiles` are visible but every `taskVerifyChecks` and `artifactP',
      iterations: 8,
      maxIterations: 8,
      stopReason: 'end_turn',
      toolCalls: [{ tool: 'ProjectMap' }],
      approvalDenials: [],
      systemPrompt: '<project_map>\nPackage: fixture\n</project_map>',
    })

    expect(acceptance.ok).toBe(false)
    expect(acceptance.failures).toContain('final_answer_incomplete')
    expect(acceptance.checks.finalAnswerComplete).toBe(false)
  })

  it('fails acceptance when the final answer contradicts Project Map lifecycle evidence', () => {
    const acceptance = evaluateProjectMapDogfoodAcceptance({
      finalText: [
        'Conclusion:',
        'The Project Map Runtime Control Plane declares verification profiles, but there is no lifecycle integration layer and profiles are static dead data.',
        '',
        'Evidence:',
        'The answer remains focused on Project Map Runtime Control Plane verification-profile work.',
        '',
        'Uncertainty:',
        'None for this bounded fake-router check.',
        '',
        'Next:',
        'Keep the false-positive guard as the next Runtime Control Plane gate.',
      ].join('\n'),
      evidenceText: [
        'function expandProjectMapVerificationProfiles(...) { ... }',
        'projectMapVerificationProfileIds: ["npm-test"]',
        'Project Map verification profiles: npm-test',
      ].join('\n'),
      iterations: 4,
      maxIterations: 8,
      stopReason: 'end_turn',
      toolCalls: [{ tool: 'ProjectMap' }, { tool: 'read' }],
      approvalDenials: [],
      systemPrompt: '<project_map>\nPackage: fixture\n</project_map>',
    })

    expect(acceptance.ok).toBe(false)
    expect(acceptance.failures).toContain('final_answer_contradicts_project_map_evidence')
    expect(acceptance.checks.finalAnswerConsistentWithEvidence).toBe(false)
  })
})

function toolUseResponse(name: string, input: Record<string, unknown>, id = 'tool-1'): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function textResponse(text: string): Response {
  return new Response(JSON.stringify({
    type: 'message',
    role: 'assistant',
    model: 'test-model',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function extractSystemText(request: AnthropicMessagesRequest): string {
  const system = request.system
  if (Array.isArray(system)) {
    return system.map((block) => block.type === 'text' ? block.text : '').join('\n')
  }
  return typeof system === 'string' ? system : ''
}

function requestText(request: AnthropicMessagesRequest): string {
  return request.messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .map((block) => block.type === 'text' ? block.text : '')
    .join('\n')
}

function messageHasToolUse(message: AnthropicMessagesRequest['messages'][number], toolName: string): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_use' && block.name === toolName)
}

function messageHasToolResult(message: AnthropicMessagesRequest['messages'][number]): boolean {
  return Array.isArray(message.content)
    && message.content.some((block) => block.type === 'tool_result')
}

function initGit(repo: string, head: string): void {
  const refsDir = path.join(repo, '.git', 'refs', 'heads')
  fs.mkdirSync(refsDir, { recursive: true })
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  fs.writeFileSync(path.join(refsDir, 'main'), `${head}\n`)
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
