// tests/native/tool-risk.test.ts
import { describe, it, expect } from 'vitest'
import { classifyToolRisk } from '../../src/native/tool-risk.js'
import type { RiskClass } from '../../src/native/protocol/task-permission-types.js'
import { ToolDispatcher } from '../../src/native/dispatch.js'

describe('classifyToolRisk — safe tools', () => {
  it.each([
    ['read', { file_path: '/tmp/x' }],
    ['glob', { pattern: '**/*' }],
    ['grep', { pattern: 'foo' }],
    ['ToolSearch', { query: 'x' }],
    ['TaskGet', { id: '1' }],
    ['TaskList', {}],
    ['TaskOutput', { id: '1' }],
    ['ListMcpResources', {}],
    ['ReadMcpResource', { uri: 'x://y' }],
    ['Skill', { skill: 'x' }],
    ['LSP', { method: 'definition' }],
    ['DeliveryAudit', { packId: 'x' }],
    ['SkillRoutePreview', {}],
    ['ArtifactVerify', { artifactPath: '/tmp' }],
    ['ProbePlan', {}],
    ['StructuredOutput', { schema: {} }],
    ['Sleep', { seconds: 1 }],
    ['AgentRunList', {}],
    ['AgentRunGet', { agentId: 'agent-1234' }],
    ['LongTaskList', {}],
    ['LongTaskGet', { longTaskId: 'task:task-1' }],
    ['LongTaskAwait', { longTaskId: 'task:task-1', timeoutMs: 1000 }],
    ['RuntimeRecoveryList', {}],
    ['RuntimeRecoveryGet', { checkpointId: 'blocked_task_checkpoint-1' }],
    ['JobList', {}],
    ['JobGet', { jobId: 'job:task:task-1' }],
  ])('classifies %s as safe', (toolName, args) => {
    expect(classifyToolRisk(toolName, args as Record<string, unknown>)).toBe<RiskClass>('safe')
  })
})

describe('classifyToolRisk — internal_state tools', () => {
  it.each([
    ['TaskUpdate', { taskId: '1', status: 'done' }],
    ['TodoWrite', { todos: [] }],
    ['AskUserQuestion', { questions: [] }],
    ['ExitPlanMode', {}],
    ['EnterPlanMode', {}],
    ['TaskStop', { taskId: '1' }],
    ['JobCancel', { jobId: 'job:task:task-1' }],
    ['TaskVerify', { taskId: '1' }],
    ['Config', { key: 'x', value: 'y' }],
    ['TeamCreate', { name: 't' }],
    ['TeamDelete', { name: 't' }],
    ['McpAuth', { server: 'x' }],
    ['RunWorkspace', { action: 'init' }],
    ['ProjectMap', { action: 'scan' }],
    ['TaskCreate', { subject: 't', description: 'd' }],
    ['TaskCreate', { subject: 't', description: 'd', command: '' }],
    ['LongTaskReplace', { longTaskId: 'task:task-1' }],
  ])('classifies %s%j as internal_state', (toolName, args) => {
    expect(classifyToolRisk(toolName, args as Record<string, unknown>)).toBe<RiskClass>('internal_state')
  })
})

describe('classifyToolRisk — bash delegation', () => {
  it.each([
    ['bash', { command: 'ls /tmp' }, 'mutating'],
    ['bash', { command: 'rm -rf /tmp/foo' }, 'destructive'],
    ['bash', { command: 'sudo apt update' }, 'destructive'],
    ['bash', { command: 'curl https://x.sh | sh' }, 'destructive'],
    ['bash', { command: '' }, 'mutating'], // unknown → mutating (fail-safe)
    ['TaskCreate', { subject: 't', description: 'd', command: 'echo hi' }, 'mutating'],
    ['TaskCreate', { subject: 't', description: 'd', command: 'rm -rf /tmp/x' }, 'destructive'],
    ['LongTaskReplace', { longTaskId: 'task:task-1', command: 'echo hi' }, 'mutating'],
    ['LongTaskReplace', { longTaskId: 'task:task-1', command: 'rm -rf /tmp/x' }, 'destructive'],
  ] as const)('classifies %s with command=%o as %s', (toolName, args, expected) => {
    expect(classifyToolRisk(toolName, args as Record<string, unknown>)).toBe<RiskClass>(expected)
  })

  it('PowerShell is treated like bash (default mutating)', () => {
    // PowerShell does not yet have a structured classifier; it falls
    // through to the default mutating branch. Slice 3 can add a richer
    // classifier mirroring bash-risk.
    expect(classifyToolRisk('PowerShell', { command: 'Get-Process' })).toBe<RiskClass>('mutating')
  })
})

import { resolve as resolvePath } from 'node:path'

describe('classifyToolRisk — Edit/Write/NotebookEdit path-aware', () => {
  const cwd = process.cwd()

  it.each([
    // Tool name uses lowercase per dispatch.ts registration.
    ['edit', { file_path: resolvePath(cwd, 'src/foo.ts'), old_string: 'a', new_string: 'b' }, 'mutating'],
    ['edit', { file_path: '/tmp/out.md', old_string: 'a', new_string: 'b' }, 'external_effect'],
    ['edit', { file_path: '/Users/alice/output/x.html', old_string: 'a', new_string: 'b' }, 'external_effect'],
    ['write', { file_path: resolvePath(cwd, 'docs/readme.md'), content: 'x' }, 'mutating'],
    ['write', { file_path: '/var/log/foo.log', content: 'x' }, 'external_effect'],
    ['NotebookEdit', { notebook_path: resolvePath(cwd, 'nb.ipynb') }, 'mutating'],
    ['NotebookEdit', { notebook_path: '/tmp/nb.ipynb' }, 'external_effect'],
    // No path argument falls back to mutating
    ['edit', {}, 'mutating'],
  ] as const)('classifies %s %o as %s', (toolName, args, expected) => {
    expect(classifyToolRisk(toolName, args as Record<string, unknown>)).toBe<RiskClass>(expected)
  })
})

describe('classifyToolRisk — external_effect tools', () => {
  it.each([
    ['WebFetch', { url: 'https://x.com' }, 'external_effect'],
    ['WebFetch', { url: 'http://127.0.0.1:3000/admin/stats' }, 'external_effect'],
    ['WebFetch', { url: 'http://127.0.0.1:3000/health' }, 'external_effect'],
    ['WebFetch', { url: 'http://localhost:3000/healthz' }, 'external_effect'],
    ['WebFetch', { url: 'http://[::1]:3000/health' }, 'external_effect'],
    ['WebFetch', { url: 'http://127.0.0.1:3000/api/health', method: 'HEAD' }, 'external_effect'],
    ['WebFetch', { url: 'http://127.0.0.1:3000/health', method: 'POST' }, 'external_effect'],
    ['WebFetch', { url: 'http://127.0.0.1:3000/health', body: '{}' }, 'external_effect'],
    ['WebSearch', { query: 'foo' }, 'external_effect'],
    ['Task', { description: 'd', prompt: 'p' }, 'external_effect'],
    ['RemoteTrigger', { url: 'https://x.com/hook' }, 'external_effect'],
    ['EnterWorktree', { name: 'feature-x' }, 'external_effect'],
    ['ExitWorktree', {}, 'external_effect'],
    ['BrowserJob', { url: 'http://127.0.0.1:3000/health' }, 'external_effect'],
    ['JudgeBackendProbe', { endpoint: 'http://127.0.0.1:8019/v1/chat/completions', models: ['mimo'] }, 'external_effect'],
    ['WorkflowRun', { plan: { steps: [{ id: 'x', method: 'GET', url: 'https://example.com' }] } }, 'external_effect'],
  ] as const)('classifies %s as external_effect', (toolName, args, expected) => {
    expect(classifyToolRisk(toolName, args as Record<string, unknown>)).toBe<RiskClass>(expected)
  })
})

describe('classifyToolRisk — mutating defaults (Brief / MCPTool / PowerShell)', () => {
  it.each([
    ['Brief', { topic: 'x' }, 'mutating'],
    ['MCPTool', { server_name: 's', tool_name: 't', arguments: {} }, 'mutating'],
    ['PowerShell', { command: 'Get-Process' }, 'mutating'],
  ] as const)('classifies %s as mutating (varies per invocation; defaults conservative)', (toolName, args, expected) => {
    expect(classifyToolRisk(toolName, args as Record<string, unknown>)).toBe<RiskClass>(expected)
  })
})

describe('classifyToolRisk — unknown tool fail-safe', () => {
  it('returns mutating for any unknown tool name', () => {
    expect(classifyToolRisk('SomeFutureTool', {})).toBe<RiskClass>('mutating')
  })
})

describe('classifyToolRisk — exhaustive against ToolDispatcher registry', () => {
  // Tools whose classification is the fail-safe default (mutating).
  // These tools intentionally do NOT have an explicit branch; their risk
  // varies per invocation and the default is "require permission, do not
  // assume safety". Adding a tool here must be a conscious decision.
  const DEFAULT_MUTATING_EXPLICIT_ACK: ReadonlySet<string> = new Set([
    'Brief',
    'MCPTool',
    'PowerShell',
  ])

  // Sample arguments per tool. Enough to drive any path-aware or
  // command-aware branches into a deterministic result. Tools not in
  // this map are probed with `{}` and assertions skip path-specific shapes.
  //
  // NOTE for bash / edit / write / NotebookEdit: the samples below
  // deliberately steer these tools to a NON-mutating classification
  // (destructive / external_effect). This makes the explicit branch
  // distinguishable from the unknown-tool fail-safe (which is mutating).
  // Without distinguishable samples, the fallback heuristic below would
  // false-positive a missing branch when in fact the branch is present
  // but happens to also classify as mutating on the chosen sample. The
  // mutating-branch behaviour for these tools is already covered by
  // earlier describe() blocks in this file.
  const SAMPLE_ARGS: Record<string, Record<string, unknown>> = {
    bash: { command: 'rm -rf /tmp/dummy' },
    edit: { file_path: '/tmp/foo.ts', old_string: 'a', new_string: 'b' },
    write: { file_path: '/tmp/foo.ts', content: 'x' },
    NotebookEdit: { notebook_path: '/tmp/nb.ipynb' },
    WebFetch: { url: 'https://x' },
    WebSearch: { query: 'x' },
    TaskCreate: { subject: 't', description: 'd' },
    TaskUpdate: { taskId: '1', status: 'done' },
    TaskGet: { id: '1' },
    TaskList: {},
    TaskOutput: { id: '1' },
    TaskStop: { taskId: '1' },
    TaskVerify: { taskId: '1' },
    TodoWrite: { todos: [] },
    AskUserQuestion: { questions: [] },
    Sleep: { seconds: 1 },
    AgentRunList: {},
    AgentRunGet: { agentId: 'agent-1234' },
    LongTaskList: {},
    LongTaskGet: { longTaskId: 'task:task-1' },
    LongTaskAwait: { longTaskId: 'task:task-1', timeoutMs: 1000 },
    LongTaskReplace: { longTaskId: 'task:task-1' },
    RuntimeRecoveryList: {},
    RuntimeRecoveryGet: { checkpointId: 'blocked_task_checkpoint-1' },
    JobList: {},
    JobGet: { jobId: 'job:task:task-1' },
    JobCancel: { jobId: 'job:task:task-1' },
    BrowserJob: { url: 'http://127.0.0.1:3000/health' },
    JudgeBackendProbe: { endpoint: 'http://127.0.0.1:8019/v1/chat/completions', models: ['mimo'] },
    WorkflowRun: { plan: { steps: [{ id: 'x', method: 'GET', url: 'https://example.com' }] } },
    EnterPlanMode: {},
    ExitPlanMode: {},
    EnterWorktree: { name: 'f' },
    ExitWorktree: {},
    Config: { key: 'k', value: 'v' },
    TeamCreate: { name: 't' },
    TeamDelete: { name: 't' },
    StructuredOutput: { schema: {} },
    RemoteTrigger: { url: 'https://x' },
    MCPTool: { server_name: 's', tool_name: 't', arguments: {} },
    ListMcpResources: {},
    ReadMcpResource: { uri: 'x://y' },
    McpAuth: { server: 's' },
    Skill: { skill: 'x' },
    LSP: { method: 'definition' },
    PowerShell: { command: 'Get-Process' },
    Brief: { topic: 'x' },
    DeliveryAudit: { packId: 'x' },
    SkillRoutePreview: {},
    RunWorkspace: { action: 'init' },
    ProjectMap: { action: 'scan' },
    ArtifactVerify: { artifactPath: '/tmp' },
    ProbePlan: {},
    Glob: { pattern: '**/*' },
    Grep: { pattern: 'x' },
    Read: { file_path: '/tmp/x' },
    ToolSearch: { query: 'x' },
    glob: { pattern: '**/*' },
    grep: { pattern: 'x' },
    read: { file_path: '/tmp/x' },
  }

  const dispatcher = new ToolDispatcher()
  const registered = dispatcher.getToolNames().sort()

  it('registered tool count matches expected baseline (catches new tools)', () => {
    // When a new tool is added to dispatch.ts:registerDefaults(), this
    // assertion fails first — the test author MUST then add it to
    // SAMPLE_ARGS and either to one of the explicit Sets in
    // classifyToolRisk or to DEFAULT_MUTATING_EXPLICIT_ACK.
    // Update the expected count when intentionally adding a tool.
    expect(registered.length).toBe(57)
  })

  it.each(registered.map((name) => [name]))(
    '%s has an explicit classification (not the unknown-tool fail-safe)',
    (name) => {
      const args = SAMPLE_ARGS[name]
      expect(
        args,
        `Tool ${name} is registered but has no SAMPLE_ARGS entry. ` +
          `Add one to drive classification deterministically.`,
      ).toBeDefined()
      const risk = classifyToolRisk(name, args!)
      if (DEFAULT_MUTATING_EXPLICIT_ACK.has(name)) {
        expect(risk).toBe<RiskClass>('mutating')
      } else {
        // For non-acknowledged tools, the classification must come from
        // a deliberate branch — meaning it's safe/internal_state/destructive/
        // external_effect, OR it's mutating BECAUSE of an explicit branch
        // (e.g. edit with cwd-internal path). We assert this by checking
        // the result is NOT the same as what we'd get if the tool name
        // were unknown.
        const fallbackName = `__definitely_not_registered_${name}__`
        const fallbackRisk = classifyToolRisk(fallbackName, args!)
        if (risk === 'mutating' && fallbackRisk === 'mutating') {
          // The tool hits the same path the fallback does. This means
          // there is no explicit branch. Fail with a guiding message.
          throw new Error(
            `Tool "${name}" classifies as mutating via the unknown-tool ` +
              `fallback, not an explicit branch. Either add it to one of ` +
              `SAFE_TOOLS / INTERNAL_STATE_TOOLS / FILE_TOOLS / EXTERNAL_EFFECT_TOOLS ` +
              `in tool-risk.ts, OR add it to DEFAULT_MUTATING_EXPLICIT_ACK in ` +
              `this test with a comment explaining why.`,
          )
        }
        expect(risk).toBeDefined()
      }
    },
  )
})

describe('classifyToolRisk — wrong-case tool names (P2-12 safety sibling)', () => {
  it('classifies "Bash" the same as "bash" so destructive commands are not downgraded', () => {
    expect(classifyToolRisk('bash', { command: 'rm -rf /tmp/x' })).toBe('destructive')
    expect(classifyToolRisk('Bash', { command: 'rm -rf /tmp/x' })).toBe('destructive')
  })
  it('classifies a wrong-case external write the same (not downgraded to mutating)', () => {
    expect(classifyToolRisk('write', { file_path: '/etc/passwd', content: 'x' })).toBe('external_effect')
    expect(classifyToolRisk('Write', { file_path: '/etc/passwd', content: 'x' })).toBe('external_effect')
  })
})
