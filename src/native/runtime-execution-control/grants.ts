import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync, type BigIntStats } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type {
  WorkflowContractSnapshot,
  WorkflowHttpMethod,
  WorkflowPlan,
  WorkflowRequestAdmissionHook,
  WorkflowResumePlanSnapshot,
  WorkflowResumeSourceSnapshot,
  WorkflowRunInput,
} from '../workflow-runner.js'
import {
  RuntimeExecutionControlError,
  type RuntimeExecutionTask,
  type WorkflowRuntimeExecutionTask,
} from './types.js'

export type RuntimeExecutionGrantSource = 'tool_approval' | 'operator_cli_explicit'

export interface RuntimeExecutionAuthorizationGrant {
  readonly schemaVersion: 1
  readonly grantId: string
  readonly source: RuntimeExecutionGrantSource
  readonly sourceRef: string
  readonly workspaceRoot: string
  readonly taskFingerprint: string
  readonly taskSummary: string
  readonly allowedMethods: readonly WorkflowHttpMethod[]
  readonly allowedOrigins: readonly string[]
  readonly redirectPolicy: 'follow'
}

export interface ToolApprovedWorkflowGrantInput {
  readonly workflow: WorkflowRunInput
  readonly workspaceRoot: string
  readonly toolUseId: string
  readonly permissionState: 'granted'
  readonly riskClass: 'external_effect'
  readonly grantEvent: {
    readonly ts: number
    readonly mode: string
    readonly iteration: number
  }
}

export interface OperatorCliWorkflowGrantInput {
  readonly workflow: WorkflowRunInput
  readonly workspaceRoot: string
  readonly action: 'workflow execute' | 'workflow run-contract' | 'workflow resume' | 'resume'
}

interface BoundResource {
  readonly path: string
  readonly digest: string
}

interface BoundWorkspace {
  readonly lexicalRoot: string
  readonly canonicalRoot: string
  readonly dev: bigint
  readonly ino: bigint
}

interface RuntimeExecutionGrantBinding {
  readonly grant: RuntimeExecutionAuthorizationGrant
  readonly workspace: BoundWorkspace
  readonly requestFingerprint: string
  readonly task: WorkflowRuntimeExecutionTask
  readonly resources: readonly BoundResource[]
  readonly contractSnapshot?: WorkflowContractSnapshot
  readonly resumeSnapshot?: WorkflowResumeSourceSnapshot
  readonly resumePlanSnapshot?: WorkflowResumePlanSnapshot
  consumed: boolean
}

const grantBindings = new WeakMap<RuntimeExecutionAuthorizationGrant, RuntimeExecutionGrantBinding>()

export async function issueToolApprovedWorkflowRuntimeGrant(
  input: ToolApprovedWorkflowGrantInput,
): Promise<RuntimeExecutionAuthorizationGrant> {
  if (
    input.permissionState !== 'granted'
    || input.riskClass !== 'external_effect'
    || !input.toolUseId.trim()
    || !Number.isFinite(input.grantEvent.ts)
  ) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_NOT_GRANTED',
      'Workflow runtime authority requires a granted external-effect tool permission lifecycle',
    )
  }
  return await issueWorkflowRuntimeGrant({
    workflow: input.workflow,
    workspaceRoot: input.workspaceRoot,
    source: 'tool_approval',
    sourceRef: input.toolUseId,
  })
}

export async function issueOperatorCliWorkflowRuntimeGrant(
  input: OperatorCliWorkflowGrantInput,
): Promise<RuntimeExecutionAuthorizationGrant> {
  return await issueWorkflowRuntimeGrant({
    workflow: input.workflow,
    workspaceRoot: input.workspaceRoot,
    source: 'operator_cli_explicit',
    sourceRef: input.action,
  })
}

export function resolveGrantedWorkflowRuntimeTask(
  grant: RuntimeExecutionAuthorizationGrant,
  workflow: WorkflowRunInput,
): WorkflowRuntimeExecutionTask {
  const binding = requireAuthenticGrant(grant)
  const requestFingerprint = digestStable(workflow)
  if (requestFingerprint !== binding.requestFingerprint) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_TASK_MISMATCH',
      `Runtime grant ${binding.grant.grantId} does not authorize the submitted workflow request`,
    )
  }
  return binding.task
}

export function verifyRuntimeExecutionGrantReservation(
  grant: RuntimeExecutionAuthorizationGrant | undefined,
  workspaceRoot: string,
  task: RuntimeExecutionTask,
): RuntimeExecutionAuthorizationGrant {
  if (!grant || typeof grant !== 'object') {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_GRANT_REQUIRED',
      'Approved external-effect runtime execution requires a product-issued grant',
    )
  }
  const binding = requireAuthenticGrant(grant)
  if (binding.consumed) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_GRANT_REPLAYED',
      `Runtime grant has already been reserved: ${binding.grant.grantId}`,
    )
  }
  assertRuntimeExecutionGrantTask(grant, workspaceRoot, task)
  return binding.grant
}

export function assertRuntimeExecutionGrantTask(
  grant: RuntimeExecutionAuthorizationGrant,
  workspaceRoot: string,
  task: RuntimeExecutionTask,
): void {
  const binding = requireAuthenticGrant(grant)
  assertRuntimeExecutionGrantWorkspace(binding)
  const normalizedWorkspace = resolve(workspaceRoot)
  if (
    normalizedWorkspace !== binding.workspace.lexicalRoot
    && normalizedWorkspace !== binding.workspace.canonicalRoot
  ) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_WORKSPACE_MISMATCH',
      `Runtime grant workspace ${binding.grant.workspaceRoot} does not authorize ${normalizedWorkspace}`,
    )
  }
  const fingerprint = fingerprintTask(task, binding.resources)
  if (fingerprint !== binding.grant.taskFingerprint) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_TASK_MISMATCH',
      `Runtime grant ${binding.grant.grantId} does not authorize the submitted runtime task`,
    )
  }
}

export function consumeRuntimeExecutionGrant(grant: RuntimeExecutionAuthorizationGrant): void {
  const binding = requireAuthenticGrant(grant)
  if (binding.consumed) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_GRANT_REPLAYED',
      `Runtime grant has already been reserved: ${binding.grant.grantId}`,
    )
  }
  binding.consumed = true
}

export async function revalidateRuntimeExecutionGrantResources(
  grant: RuntimeExecutionAuthorizationGrant,
): Promise<void> {
  const binding = requireAuthenticGrant(grant)
  for (const resource of binding.resources) {
    const current = await readBoundResource(resource.path)
    if (current.digest !== resource.digest) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_AUTHORIZATION_RESOURCE_DRIFT',
        `Runtime grant resource changed after approval: ${resource.path}`,
      )
    }
  }
}

export function getRuntimeExecutionContractSnapshot(
  grant: RuntimeExecutionAuthorizationGrant,
): WorkflowContractSnapshot | undefined {
  return requireAuthenticGrant(grant).contractSnapshot
}

export function getRuntimeExecutionResumeSnapshot(
  grant: RuntimeExecutionAuthorizationGrant,
): WorkflowResumeSourceSnapshot | undefined {
  return requireAuthenticGrant(grant).resumeSnapshot
}

export function getRuntimeExecutionResumePlanSnapshot(
  grant: RuntimeExecutionAuthorizationGrant,
): WorkflowResumePlanSnapshot | undefined {
  return requireAuthenticGrant(grant).resumePlanSnapshot
}

export function createRuntimeExecutionRequestAdmission(
  grant: RuntimeExecutionAuthorizationGrant,
): WorkflowRequestAdmissionHook {
  const binding = requireAuthenticGrant(grant)
  const methods = new Set(binding.grant.allowedMethods)
  const origins = new Set(binding.grant.allowedOrigins)
  return request => {
    let origin: string
    try {
      const parsed = new URL(request.url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`unsupported protocol ${parsed.protocol}`)
      origin = parsed.origin
    } catch (error) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_REQUEST_NOT_AUTHORIZED',
        `Runtime request URL is invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!methods.has(request.method)) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_REQUEST_NOT_AUTHORIZED',
        `Runtime grant ${binding.grant.grantId} does not allow method ${request.method}`,
      )
    }
    if (!origins.has(origin)) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_REQUEST_NOT_AUTHORIZED',
        `Runtime grant ${binding.grant.grantId} does not allow origin ${origin}`,
      )
    }
    if (request.redirect !== binding.grant.redirectPolicy) {
      throw new RuntimeExecutionControlError(
        'RUNTIME_REQUEST_NOT_AUTHORIZED',
        `Runtime grant ${binding.grant.grantId} requires redirect=${binding.grant.redirectPolicy}`,
      )
    }
  }
}

function requireAuthenticGrant(grant: RuntimeExecutionAuthorizationGrant): RuntimeExecutionGrantBinding {
  const binding = grantBindings.get(grant)
  if (!binding) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_GRANT_INVALID',
      'Runtime authorization grant is not product-issued',
    )
  }
  return binding
}

async function issueWorkflowRuntimeGrant(input: {
  readonly workflow: WorkflowRunInput
  readonly workspaceRoot: string
  readonly source: RuntimeExecutionGrantSource
  readonly sourceRef: string
}): Promise<RuntimeExecutionAuthorizationGrant> {
  const workspace = await bindRuntimeExecutionWorkspace(input.workspaceRoot)
  const preparedRequest = prepareRuntimeWorkflowRequest(input.workflow, workspace)
  const prepared = await prepareRuntimeTask(preparedRequest, workspace.canonicalRoot, workspace)
  const policy = deriveRequestPolicy(prepared.task, prepared.contract)
  const taskFingerprint = fingerprintTask(prepared.task, prepared.resources)
  const grant = Object.freeze({
    schemaVersion: 1 as const,
    grantId: `runtime-grant:${randomUUID()}`,
    source: input.source,
    sourceRef: requiredString(input.sourceRef, 'sourceRef'),
    workspaceRoot: workspace.canonicalRoot,
    taskFingerprint,
    taskSummary: summarizeTask(prepared.task, policy.methods, policy.origins),
    allowedMethods: Object.freeze(policy.methods),
    allowedOrigins: Object.freeze(policy.origins),
    redirectPolicy: 'follow' as const,
  })
  const binding: RuntimeExecutionGrantBinding = {
    grant,
    workspace,
    requestFingerprint: digestStable(input.workflow),
    task: deepFreeze(prepared.task),
    resources: Object.freeze(prepared.resources),
    ...(prepared.contractSnapshot ? { contractSnapshot: deepFreeze(prepared.contractSnapshot) } : {}),
    ...(prepared.resumeSnapshot ? { resumeSnapshot: deepFreeze(prepared.resumeSnapshot) } : {}),
    ...(prepared.resumePlanSnapshot ? { resumePlanSnapshot: deepFreeze(prepared.resumePlanSnapshot) } : {}),
    consumed: false,
  }
  grantBindings.set(grant, binding)
  return grant
}

async function prepareRuntimeTask(
  workflow: WorkflowRunInput,
  workspaceRoot: string,
  workspace: BoundWorkspace,
): Promise<{
  task: WorkflowRuntimeExecutionTask
  resources: BoundResource[]
  contract?: unknown
  contractSnapshot?: WorkflowContractSnapshot
  resumeSnapshot?: WorkflowResumeSourceSnapshot
  resumePlanSnapshot?: WorkflowResumePlanSnapshot
}> {
  let preparedWorkflow = structuredClone(workflow)
  const resources: BoundResource[] = []
  let contract: unknown
  let contractSnapshot: WorkflowContractSnapshot | undefined
  let resumeSnapshot: WorkflowResumeSourceSnapshot | undefined
  let resumePlanSnapshot: WorkflowResumePlanSnapshot | undefined

  if (preparedWorkflow.contractRef?.trim()) {
    const contractPath = resolveFromWorkspace(workspaceRoot, preparedWorkflow.contractRef)
    preparedWorkflow = { ...preparedWorkflow, contractRef: contractPath }
    const resource = await readBoundResource(contractPath)
    resources.push(resource.binding)
    contract = parseJson(resource.content)
    contractSnapshot = {
      ref: contractPath,
      ...(resource.content !== undefined ? { content: resource.content } : {}),
      ...(resource.errorMessage ? { readError: resource.errorMessage } : {}),
    }
  } else {
    if (!preparedWorkflow.plan && preparedWorkflow.resumeRunId?.trim()) {
      const planPath = resolveResumePlanPath(preparedWorkflow, workspaceRoot)
      const planResource = await readBoundResource(planPath)
      resources.push(planResource.binding)
      resumePlanSnapshot = {
        ref: planPath,
        ...(planResource.content !== undefined ? { content: planResource.content } : {}),
        ...(planResource.errorMessage ? { readError: planResource.errorMessage } : {}),
      }
      const plan = parseJson(planResource.content)
      if (plan !== undefined) preparedWorkflow = { ...preparedWorkflow, plan: plan as WorkflowPlan }
    }

    if (preparedWorkflow.resumeRunId?.trim()) {
      const receiptPath = resolveResumeReceiptPath(preparedWorkflow, workspaceRoot)
      const receiptResource = await readBoundResource(receiptPath)
      resources.push(receiptResource.binding)
      const responseArtifacts: Array<WorkflowResumeSourceSnapshot['responseArtifacts'][number]> = []
      const receipt = asRecord(parseJson(receiptResource.content))
      const endpointCalls = Array.isArray(receipt?.['endpoint_calls']) ? receipt['endpoint_calls'] : []
      const seenArtifactRefs = new Set<string>()
      for (const rawCall of endpointCalls) {
        const call = asRecord(rawCall)
        if (call?.['ok'] !== true) continue
        const artifactRef = stringValue(call['response_artifact'])
          ?? stringValue(call['raw_ref'])
          ?? stringValue(call['artifact_ref'])
        if (!artifactRef || seenArtifactRefs.has(artifactRef)) continue
        seenArtifactRefs.add(artifactRef)
        const artifactPath = resolveRuntimeWorkspacePath(workspace, artifactRef)
        const artifactResource = await readBoundResource(artifactPath)
        resources.push(artifactResource.binding)
        responseArtifacts.push({
          ref: artifactRef,
          ...(artifactResource.content !== undefined ? { content: artifactResource.content } : {}),
          ...(artifactResource.errorMessage ? { readError: artifactResource.errorMessage } : {}),
        })
      }
      resumeSnapshot = {
        receiptRef: receiptPath,
        ...(receiptResource.content !== undefined ? { receiptContent: receiptResource.content } : {}),
        ...(receiptResource.errorMessage ? { receiptReadError: receiptResource.errorMessage } : {}),
        responseArtifacts,
      }
    }
  }

  const task: WorkflowRuntimeExecutionTask = {
    kind: 'workflow-run-v1',
    workflow: preparedWorkflow,
    options: { redirect: 'follow' },
  }
  return {
    task,
    resources,
    ...(contract !== undefined ? { contract } : {}),
    ...(contractSnapshot ? { contractSnapshot } : {}),
    ...(resumeSnapshot ? { resumeSnapshot } : {}),
    ...(resumePlanSnapshot ? { resumePlanSnapshot } : {}),
  }
}

function deriveRequestPolicy(task: WorkflowRuntimeExecutionTask, contract: unknown): {
  methods: WorkflowHttpMethod[]
  origins: string[]
} {
  const methods = new Set<WorkflowHttpMethod>()
  const origins = new Set<string>()
  const workflow = task.workflow

  if (workflow.contractRef?.trim()) {
    const baseUrl = workflow.baseUrl?.trim()
    addOrigin(origins, baseUrl)
    const parsed = asRecord(contract)
    const queue = Array.isArray(parsed?.['task_queue']) ? parsed['task_queue'] : []
    for (const item of queue) {
      const execution = asRecord(asRecord(item)?.['execution'])
      const method = normalizeMethod(execution?.['method'])
      if (method) methods.add(method)
      addEndpointOrigin(origins, stringValue(execution?.['endpoint']), baseUrl)
      methods.add('POST')
      addEndpointOrigin(origins, stringValue(execution?.['receipt_endpoint']), baseUrl)
      addEndpointOrigin(origins, stringValue(asRecord(execution?.['structured_output'])?.['endpoint']), baseUrl)
    }
    addEndpointOrigin(origins, workflow.receiptEndpoint, baseUrl)
  } else {
    const plan = workflow.plan
    const baseUrl = workflow.baseUrl?.trim() || plan?.base_url?.trim()
    addOrigin(origins, baseUrl)
    for (const step of plan?.steps ?? []) {
      const method = normalizeMethod(step?.method)
      if (method) methods.add(method)
      addEndpointOrigin(origins, typeof step?.url === 'string' ? step.url : undefined, baseUrl)
    }
  }

  if ([...methods].some(method => method !== 'HEAD')) methods.add('GET')
  return {
    methods: [...methods].sort(),
    origins: [...origins].sort(),
  }
}

function fingerprintTask(task: RuntimeExecutionTask, resources: readonly BoundResource[]): string {
  return digestStable({
    task,
    resources: resources.map(resource => ({ path: resource.path, digest: resource.digest })),
  })
}

function prepareRuntimeWorkflowRequest(
  workflow: WorkflowRunInput,
  workspace: BoundWorkspace,
): WorkflowRunInput {
  const cloned = structuredClone(workflow)
  const requestedCwd = resolve(cloned.cwd?.trim() || workspace.lexicalRoot)
  if (requestedCwd !== workspace.lexicalRoot && requestedCwd !== workspace.canonicalRoot) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_WORKSPACE_MISMATCH',
      `Runtime workflow cwd ${requestedCwd} does not match authorized workspace ${workspace.lexicalRoot}`,
    )
  }
  return {
    ...cloned,
    cwd: workspace.canonicalRoot,
    ...(cloned.contractRef?.trim()
      ? { contractRef: resolveRuntimeWorkspacePath(workspace, cloned.contractRef) }
      : {}),
    ...(cloned.receiptPath?.trim()
      ? { receiptPath: resolveRuntimeWorkspacePath(workspace, cloned.receiptPath) }
      : {}),
    ...(cloned.artifactDir?.trim()
      ? { artifactDir: resolveRuntimeWorkspacePath(workspace, cloned.artifactDir) }
      : {}),
  }
}

function summarizeTask(
  task: WorkflowRuntimeExecutionTask,
  methods: readonly WorkflowHttpMethod[],
  origins: readonly string[],
): string {
  const workflow = task.workflow
  const run = workflow.taskRunId?.trim()
    || workflow.resumeRunId?.trim()
    || workflow.plan?.run_id?.trim()
    || workflow.contractRef?.trim()
    || 'generated'
  return `workflow-run-v1 run=${run} methods=${methods.join(',') || 'none'} origins=${origins.join(',') || 'none'} redirect=follow`
}

async function readBoundResource(path: string): Promise<{
  binding: BoundResource
  content?: string
  digest: string
  errorMessage?: string
}> {
  try {
    const content = await readFile(path, 'utf8')
    const digest = sha256(content)
    return { binding: Object.freeze({ path, digest }), content, digest }
  } catch (error) {
    return {
      binding: Object.freeze({ path, digest: 'missing' }),
      digest: 'missing',
      errorMessage: error instanceof Error ? error.message : String(error),
    }
  }
}

function resolveResumePlanPath(workflow: WorkflowRunInput, workspaceRoot: string): string {
  return join(dirname(resolveResumeReceiptPath(workflow, workspaceRoot)), 'plan.json')
}

function resolveResumeReceiptPath(workflow: WorkflowRunInput, workspaceRoot: string): string {
  const runId = safeSegment(workflow.resumeRunId ?? '')
  return workflow.receiptPath?.trim()
    ? resolveFromWorkspace(workspaceRoot, workflow.receiptPath)
    : join(workspaceRoot, '.owlcoda-workflows', runId, 'receipt.json')
}

function addEndpointOrigin(origins: Set<string>, endpoint: string | undefined, baseUrl: string | undefined): void {
  if (!endpoint?.trim()) return
  try {
    const parsed = isAbsoluteHttpUrl(endpoint) ? new URL(endpoint) : new URL(endpoint, baseUrl)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin)
  } catch {
    // Workflow validation reports malformed endpoints before a request is made.
  }
}

function addOrigin(origins: Set<string>, raw: string | undefined): void {
  if (!raw?.trim()) return
  try {
    const parsed = new URL(raw)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') origins.add(parsed.origin)
  } catch {
    // Workflow validation reports malformed base URLs before a request is made.
  }
}

function normalizeMethod(value: unknown): WorkflowHttpMethod | undefined {
  if (typeof value !== 'string') return undefined
  const method = value.trim().toUpperCase()
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)
    ? method as WorkflowHttpMethod
    : undefined
}

function resolveFromWorkspace(workspaceRoot: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(workspaceRoot, path)
}

async function bindRuntimeExecutionWorkspace(rawWorkspaceRoot: string): Promise<BoundWorkspace> {
  const lexicalRoot = resolve(requiredString(rawWorkspaceRoot, 'workspaceRoot'))
  let canonicalRoot: string
  let stats: BigIntStats
  try {
    canonicalRoot = await realpath(lexicalRoot)
    stats = await stat(canonicalRoot, { bigint: true })
  } catch (error) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_WORKSPACE_INVALID',
      `Runtime workspace must be an existing directory: ${lexicalRoot} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (!stats.isDirectory()) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_WORKSPACE_INVALID',
      `Runtime workspace must be an existing directory: ${lexicalRoot}`,
    )
  }
  return Object.freeze({
    lexicalRoot,
    canonicalRoot,
    dev: stats.dev,
    ino: stats.ino,
  })
}

function assertRuntimeExecutionGrantWorkspace(binding: RuntimeExecutionGrantBinding): void {
  let canonicalRoot: string
  let stats: BigIntStats
  try {
    canonicalRoot = realpathSync(binding.workspace.lexicalRoot)
    stats = statSync(canonicalRoot, { bigint: true })
  } catch (error) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_WORKSPACE_DRIFT',
      `Runtime grant workspace changed after approval: ${binding.workspace.lexicalRoot} (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (
    !stats.isDirectory()
    || canonicalRoot !== binding.workspace.canonicalRoot
    || stats.dev !== binding.workspace.dev
    || stats.ino !== binding.workspace.ino
  ) {
    throw new RuntimeExecutionControlError(
      'RUNTIME_AUTHORIZATION_WORKSPACE_DRIFT',
      `Runtime grant workspace changed after approval: ${binding.workspace.lexicalRoot}`,
    )
  }
}

function resolveRuntimeWorkspacePath(workspace: BoundWorkspace, rawPath: string): string {
  const trimmed = rawPath.trim()
  if (!isAbsolute(trimmed)) return resolve(workspace.canonicalRoot, trimmed)
  const absolutePath = resolve(trimmed)
  const fromLexical = relative(workspace.lexicalRoot, absolutePath)
  if (isPathWithinRoot(fromLexical)) return resolve(workspace.canonicalRoot, fromLexical)
  const fromCanonical = relative(workspace.canonicalRoot, absolutePath)
  if (isPathWithinRoot(fromCanonical)) return resolve(workspace.canonicalRoot, fromCanonical)
  return absolutePath
}

function isPathWithinRoot(relativePath: string): boolean {
  return relativePath === ''
    || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function isAbsoluteHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function parseJson(content: string | undefined): unknown {
  if (content === undefined) return undefined
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function digestStable(value: unknown): string {
  return `sha256:${sha256(JSON.stringify(canonicalize(value)))}`
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]))
  }
  return value
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'workflow'
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RuntimeExecutionControlError('RUNTIME_EXECUTION_REQUEST_INVALID', `Runtime ${field} must be non-empty`)
  }
  return value.trim()
}
