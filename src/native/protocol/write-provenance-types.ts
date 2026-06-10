export type ProvenanceKind =
  | 'user_explicit_deny'
  | 'user_explicit_revoke'
  | 'user_declared_target'
  | 'user_reference'
  | 'tool_confirmed_existing'
  | 'parent_listing'

export type ProvenanceDenyScope = 'exact' | 'subtree'

export interface ProvenanceRecord {
  kind: ProvenanceKind
  ts: number
  originIteration: number
  originalString: string
  toolName?: string
  toolSucceeded?: boolean
  verbContext?: string
  denyMarker?: string
  revokeMarker?: string
  denyScope?: ProvenanceDenyScope
  /**
   * True when this record was synthesized from a settings.json permission
   * rule. Permanent denies bypass the conversation-revoke check entirely
   * (a `算了改吧 X` in the conversation cannot lift a permanent rule).
   * Permanent admits act as baseline `user_declared_target` evidence —
   * they admit writes when nothing in the conversation denies them.
   */
  permanent?: boolean
}

export interface UserPathExtraction {
  path: string
  originalString: string
  kind: Extract<ProvenanceKind, 'user_explicit_deny' | 'user_explicit_revoke' | 'user_declared_target' | 'user_reference'>
  verbContext?: string
  denyMarker?: string
  revokeMarker?: string
  denyScope?: ProvenanceDenyScope
}

/**
 * Glob-pattern denies that the v1 extractor declined to classify as deny
 * records (because deny semantics only apply to literal paths).
 *
 * Wired callers should emit `path_provenance_deny_pattern_skipped` telemetry
 * with these so we know how often users try glob denies — informs v2 scope
 * decisions (spec §16.5, OQ10).
 */
export interface SkippedGlobDeny {
  pattern: string         // the glob-shaped token as it appeared in user text
  originalString: string  // surrounding context (the deny phrase including marker)
}

/**
 * Result shape of `extractPathsFromUserMessage`. Carries the typed
 * extractions plus side-channel info that wired callers need for telemetry.
 */
export interface UserMessageExtractionResult {
  extractions: UserPathExtraction[]
  skippedGlobDenies: SkippedGlobDeny[]
}

/**
 * Extraction shape produced by `extractPathsFromToolResult`. Tool-derived
 * provenance always carries a tool name, and v1 only emits records when the
 * tool call succeeded — `toolSucceeded` therefore is always true on emit.
 * Failed locator events (`isError=true`) yield an empty array per spec §5.3.2.
 */
export interface ToolResultPathExtraction {
  path: string
  originalString: string
  kind: Extract<ProvenanceKind, 'tool_confirmed_existing' | 'parent_listing'>
  toolName: string
  toolSucceeded: true
}

export type ExtractedWriteTargetKind =
  | 'write'
  | 'edit'
  | 'notebook_edit'
  | 'redirect_stdout'
  | 'redirect_stderr'
  | 'tee'
  | 'sed_inplace'
  | 'cp'
  | 'mv'
  | 'rm'
  | 'heredoc'
  | 'mkdir'
  | 'task_command'

export interface ExtractedWriteTarget {
  path: string
  kind: ExtractedWriteTargetKind
  destructive: boolean
}

export interface AdmissionResult {
  admitted: boolean
  via?: ProvenanceKind
  record?: ProvenanceRecord
  denyActive?: boolean
  activeDenyRecord?: ProvenanceRecord
  availableRecords?: {
    path: ProvenanceRecord[]
    parent: ProvenanceRecord[]
  }
}

export interface ProvenanceTargetEvaluation {
  target: ExtractedWriteTarget
  canonical: string
  isNewFile: boolean
  admission: AdmissionResult
}

export interface ProvenanceViolation {
  toolName: string
  failures: ProvenanceTargetEvaluation[]
  reason: string
}

export interface ProvenanceLedgerData {
  version: 1
  recordsByPath: Record<string, ProvenanceRecord[]>
}
