import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, normalize, resolve } from 'node:path'

export type EvidenceSymlinkPolicy = 'reject' | 'resolve'

export interface EvidenceRef {
  readonly schemaVersion: 1
  readonly id: string
  readonly sourceType: 'local_file'
  readonly locator: string
  readonly sha256: string
  readonly mediaType: string
  readonly byteLength: number
  readonly observedAt: string
  readonly version?: string
  readonly symlinkPolicy: EvidenceSymlinkPolicy
}

export interface EvidenceContext {
  readonly schemaVersion: 1
  readonly id: string
  readonly snapshotDigest: string
  readonly evidenceRefs: readonly EvidenceRef[]
}

export class InvariantSpineError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'InvariantSpineError'
    this.code = code
  }
}

export async function captureLocalFileEvidence(input: {
  locator: string
  mediaType?: string
  observedAt?: string
  version?: string
  symlinkPolicy?: EvidenceSymlinkPolicy
}): Promise<EvidenceRef> {
  if (!input || typeof input.locator !== 'string' || !input.locator.trim()) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef locator must be a non-empty path')
  }
  const symlinkPolicy = normalizeSymlinkPolicy(input.symlinkPolicy)
  const observed = await observeRegularFile(input.locator, symlinkPolicy)
  const observedAt = normalizeTimestamp(input.observedAt ?? new Date().toISOString(), 'EvidenceRef observedAt')
  const mediaType = normalizeMediaType(input.mediaType, observed.locator)
  const version = normalizeOptionalString(input.version, 'EvidenceRef version')
  return freezeEvidenceRef({
    schemaVersion: 1,
    id: evidenceRefId({
      locator: observed.locator,
      sha256: observed.sha256,
      mediaType,
      version,
      symlinkPolicy,
    }),
    sourceType: 'local_file',
    locator: observed.locator,
    sha256: observed.sha256,
    mediaType,
    byteLength: observed.byteLength,
    observedAt,
    ...(version ? { version } : {}),
    symlinkPolicy,
  })
}

export async function resolveEvidenceRef(ref: EvidenceRef): Promise<EvidenceRef> {
  validateEvidenceRefShape(ref)
  const version = normalizeOptionalString(ref.version, 'EvidenceRef version')
  const expectedId = evidenceRefId({
    locator: ref.locator,
    sha256: ref.sha256,
    mediaType: ref.mediaType,
    version,
    symlinkPolicy: ref.symlinkPolicy,
  })
  if (ref.id !== expectedId) {
    throw new InvariantSpineError('EVIDENCE_REF_MISMATCH', `EvidenceRef id does not match its immutable fields: ${ref.id}`)
  }

  const observed = await observeRegularFile(ref.locator, ref.symlinkPolicy)
  if (observed.locator !== ref.locator) {
    throw new InvariantSpineError(
      'EVIDENCE_REF_MISMATCH',
      `EvidenceRef locator resolved to a different canonical file: expected ${ref.locator}, observed ${observed.locator}`,
    )
  }
  if (observed.sha256 !== ref.sha256) {
    throw new InvariantSpineError(
      'EVIDENCE_DIGEST_DRIFT',
      `EvidenceRef SHA-256 drift: expected ${ref.sha256}, observed ${observed.sha256}`,
    )
  }
  if (observed.byteLength !== ref.byteLength) {
    throw new InvariantSpineError(
      'EVIDENCE_REF_MISMATCH',
      `EvidenceRef byte length mismatch: expected ${ref.byteLength}, observed ${observed.byteLength}`,
    )
  }

  return freezeEvidenceRef({
    schemaVersion: 1,
    id: ref.id,
    sourceType: 'local_file',
    locator: ref.locator,
    sha256: ref.sha256,
    mediaType: ref.mediaType,
    byteLength: ref.byteLength,
    observedAt: normalizeTimestamp(ref.observedAt, 'EvidenceRef observedAt'),
    ...(version ? { version } : {}),
    symlinkPolicy: ref.symlinkPolicy,
  })
}

export async function createEvidenceContext(input: {
  evidenceRefs: readonly EvidenceRef[]
}): Promise<EvidenceContext> {
  if (!input || !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length === 0) {
    throw new InvariantSpineError('EVIDENCE_CONTEXT_UNRESOLVED', 'EvidenceContext requires at least one resolved EvidenceRef')
  }
  const resolvedRefs = await Promise.all(input.evidenceRefs.map(ref => resolveEvidenceRef(ref)))
  return buildEvidenceContext(resolvedRefs)
}

export async function resolveEvidenceContext(context: EvidenceContext): Promise<EvidenceContext> {
  validateEvidenceContextShape(context)
  const resolvedRefs = await Promise.all(context.evidenceRefs.map(ref => resolveEvidenceRef(ref)))
  const normalized = buildEvidenceContext(resolvedRefs)
  if (normalized.snapshotDigest !== context.snapshotDigest || normalized.id !== context.id) {
    throw new InvariantSpineError(
      'EVIDENCE_CONTEXT_MISMATCH',
      `EvidenceContext snapshot does not match its resolved EvidenceRef set: ${context.id}`,
    )
  }
  return normalized
}

function buildEvidenceContext(refs: readonly EvidenceRef[]): EvidenceContext {
  const byId = new Map<string, EvidenceRef>()
  for (const ref of refs) {
    const existing = byId.get(ref.id)
    if (existing && stableJson(existing) !== stableJson(ref)) {
      throw new InvariantSpineError('EVIDENCE_CONTEXT_MISMATCH', `EvidenceContext contains conflicting refs for ${ref.id}`)
    }
    byId.set(ref.id, ref)
  }
  const evidenceRefs = [...byId.values()].sort((left, right) =>
    left.id.localeCompare(right.id) || left.locator.localeCompare(right.locator),
  )
  if (evidenceRefs.length === 0) {
    throw new InvariantSpineError('EVIDENCE_CONTEXT_UNRESOLVED', 'EvidenceContext resolved to an empty EvidenceRef set')
  }
  const snapshotDigest = sha256(stableJson(evidenceRefs.map(evidenceRefSnapshot)))
  return Object.freeze({
    schemaVersion: 1,
    id: `evidence-context:sha256:${snapshotDigest}`,
    snapshotDigest,
    evidenceRefs: Object.freeze(evidenceRefs.map(freezeEvidenceRef)),
  })
}

function validateEvidenceRefShape(ref: EvidenceRef): void {
  if (!isRecord(ref)) throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef must be an object')
  const allowedKeys = new Set([
    'schemaVersion',
    'id',
    'sourceType',
    'locator',
    'sha256',
    'mediaType',
    'byteLength',
    'observedAt',
    'version',
    'symlinkPolicy',
  ])
  const unknownKeys = Object.keys(ref).filter(key => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', `EvidenceRef has unsupported fields: ${unknownKeys.join(', ')}`)
  }
  if (ref.schemaVersion !== 1 || ref.sourceType !== 'local_file') {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef schemaVersion/sourceType is unsupported')
  }
  if (typeof ref.id !== 'string' || !/^evidence-ref:sha256:[a-f0-9]{64}$/.test(ref.id)) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef id must be an evidence-ref SHA-256 identifier')
  }
  if (typeof ref.locator !== 'string' || !isAbsolute(ref.locator) || normalize(resolve(ref.locator)) !== ref.locator) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef locator must be a normalized absolute path')
  }
  if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef sha256 must be an exact lowercase SHA-256 digest')
  }
  if (typeof ref.mediaType !== 'string' || !ref.mediaType.trim()) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef mediaType must be non-empty')
  }
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef byteLength must be a non-negative safe integer')
  }
  normalizeTimestamp(ref.observedAt, 'EvidenceRef observedAt')
  normalizeSymlinkPolicy(ref.symlinkPolicy)
}

function validateEvidenceContextShape(context: EvidenceContext): void {
  if (!isRecord(context)) throw new InvariantSpineError('EVIDENCE_CONTEXT_UNRESOLVED', 'EvidenceContext must be an object')
  const allowedKeys = new Set(['schemaVersion', 'id', 'snapshotDigest', 'evidenceRefs'])
  const unknownKeys = Object.keys(context).filter(key => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    throw new InvariantSpineError('EVIDENCE_CONTEXT_MISMATCH', `EvidenceContext has unsupported fields: ${unknownKeys.join(', ')}`)
  }
  if (context.schemaVersion !== 1 || typeof context.id !== 'string' || !/^evidence-context:sha256:[a-f0-9]{64}$/.test(context.id)) {
    throw new InvariantSpineError('EVIDENCE_CONTEXT_MISMATCH', 'EvidenceContext schema or id is invalid')
  }
  if (typeof context.snapshotDigest !== 'string' || !/^[a-f0-9]{64}$/.test(context.snapshotDigest)) {
    throw new InvariantSpineError('EVIDENCE_CONTEXT_MISMATCH', 'EvidenceContext snapshotDigest must be an exact SHA-256 digest')
  }
  if (!Array.isArray(context.evidenceRefs) || context.evidenceRefs.length === 0) {
    throw new InvariantSpineError('EVIDENCE_CONTEXT_UNRESOLVED', 'EvidenceContext evidenceRefs must be a non-empty array')
  }
}

async function observeRegularFile(rawLocator: string, symlinkPolicy: EvidenceSymlinkPolicy): Promise<{
  locator: string
  sha256: string
  byteLength: number
}> {
  const requestedLocator = normalize(resolve(rawLocator))
  if (symlinkPolicy === 'reject') await rejectSymbolicLinkComponents(requestedLocator)
  else await lstatForEvidence(requestedLocator)

  const canonicalLocator = await realpathForEvidence(requestedLocator)
  const before = await lstatForEvidence(canonicalLocator)
  if (!before.isFile()) {
    throw new InvariantSpineError('EVIDENCE_NOT_REGULAR_FILE', `EvidenceRef locator is not a regular file: ${canonicalLocator}`)
  }
  if ((before.mode & 0o444n) === 0n) {
    throw new InvariantSpineError('EVIDENCE_UNREADABLE', `EvidenceRef locator has no readable mode bits: ${canonicalLocator}`)
  }
  try {
    await access(canonicalLocator, constants.R_OK)
  } catch (error) {
    throw evidenceFsError(error, canonicalLocator, 'read')
  }

  let bytes: Buffer
  try {
    bytes = await readFile(canonicalLocator)
  } catch (error) {
    throw evidenceFsError(error, canonicalLocator, 'read')
  }
  const after = await lstatForEvidence(canonicalLocator)
  if (!after.isFile()) {
    throw new InvariantSpineError('EVIDENCE_NOT_REGULAR_FILE', `EvidenceRef locator stopped being a regular file: ${canonicalLocator}`)
  }
  if (statFingerprint(before) !== statFingerprint(after)) {
    throw new InvariantSpineError('EVIDENCE_CHANGED_DURING_READ', `EvidenceRef changed while hashing: ${canonicalLocator}`)
  }
  return {
    locator: canonicalLocator,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  }
}

async function rejectSymbolicLinkComponents(locator: string): Promise<void> {
  const inspectionLocator = normalizeDarwinSystemRootAlias(locator)
  const components: string[] = []
  let current = inspectionLocator
  while (true) {
    components.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const component of components.reverse()) {
    const info = await lstatForEvidence(component)
    if (info.isSymbolicLink()) {
      throw new InvariantSpineError(
        'EVIDENCE_SYMLINK_REJECTED',
        `EvidenceRef symlink component is rejected by policy: ${component}`,
      )
    }
  }
}

function normalizeDarwinSystemRootAlias(locator: string): string {
  if (process.platform !== 'darwin') return locator
  return locator.replace(/^\/(etc|tmp|var)(?=\/|$)/, '/private/$1')
}

async function lstatForEvidence(locator: string) {
  try {
    return await lstat(locator, { bigint: true })
  } catch (error) {
    throw evidenceFsError(error, locator, 'inspect')
  }
}

async function realpathForEvidence(locator: string): Promise<string> {
  try {
    return normalize(resolve(await realpath(locator)))
  } catch (error) {
    throw evidenceFsError(error, locator, 'resolve')
  }
}

function evidenceFsError(error: unknown, locator: string, operation: string): InvariantSpineError {
  const code = isNodeError(error) ? error.code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new InvariantSpineError('EVIDENCE_MISSING', `EvidenceRef locator is missing during ${operation}: ${locator}`)
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new InvariantSpineError('EVIDENCE_UNREADABLE', `EvidenceRef locator is unreadable during ${operation}: ${locator}`)
  }
  return new InvariantSpineError(
    'EVIDENCE_UNREADABLE',
    `EvidenceRef locator could not be ${operation}ed: ${locator}: ${error instanceof Error ? error.message : String(error)}`,
  )
}

function evidenceRefId(input: {
  locator: string
  sha256: string
  mediaType: string
  version?: string
  symlinkPolicy: EvidenceSymlinkPolicy
}): string {
  return `evidence-ref:sha256:${sha256(stableJson({
    sourceType: 'local_file',
    locator: input.locator,
    sha256: input.sha256,
    mediaType: input.mediaType,
    version: input.version ?? null,
    symlinkPolicy: input.symlinkPolicy,
  }))}`
}

function evidenceRefSnapshot(ref: EvidenceRef): Record<string, unknown> {
  return {
    schemaVersion: ref.schemaVersion,
    id: ref.id,
    sourceType: ref.sourceType,
    locator: ref.locator,
    sha256: ref.sha256,
    mediaType: ref.mediaType,
    byteLength: ref.byteLength,
    observedAt: ref.observedAt,
    version: ref.version ?? null,
    symlinkPolicy: ref.symlinkPolicy,
  }
}

function freezeEvidenceRef(ref: EvidenceRef): EvidenceRef {
  return Object.freeze({ ...ref })
}

function normalizeSymlinkPolicy(value: EvidenceSymlinkPolicy | undefined): EvidenceSymlinkPolicy {
  const policy = value ?? 'reject'
  if (policy !== 'reject' && policy !== 'resolve') {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', `Unsupported EvidenceRef symlink policy: ${String(value)}`)
  }
  return policy
}

function normalizeMediaType(value: string | undefined, locator: string): string {
  if (value !== undefined) {
    const trimmed = value.trim()
    if (!trimmed) throw new InvariantSpineError('EVIDENCE_REF_INVALID', 'EvidenceRef mediaType must be non-empty')
    return trimmed
  }
  const byExtension: Record<string, string> = {
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.zip': 'application/zip',
  }
  return byExtension[extname(locator).toLowerCase()] ?? 'application/octet-stream'
}

function normalizeTimestamp(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', `${field} must be a non-empty timestamp`)
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new InvariantSpineError('EVIDENCE_REF_INVALID', `${field} must be an ISO-compatible timestamp`)
  }
  return parsed.toISOString()
}

function normalizeOptionalString(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) throw new InvariantSpineError('EVIDENCE_REF_INVALID', `${field} must be non-empty when provided`)
  return trimmed
}

function statFingerprint(info: Awaited<ReturnType<typeof lstatForEvidence>>): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].map(String).join(':')
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!isRecord(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson(value[key])]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
