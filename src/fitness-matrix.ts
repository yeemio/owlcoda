import {
  buildTelemetryEventEnvelope,
  type TelemetryEventDecision,
  type TelemetryEventEnvelope,
  type TelemetryEventOrigin,
  type TelemetryEventSeverity,
} from './native/telemetry-envelope.js'

export const FITNESS_TIERS = [
  'tier1_fault_injection',
  'tier2_semi_automated',
  'tier3_manual_terminal',
] as const

export type FitnessTier = (typeof FITNESS_TIERS)[number]

export const FITNESS_GATES = [
  'ci',
  'doctor',
  'manual',
] as const

export type FitnessGate = (typeof FITNESS_GATES)[number]

export const FITNESS_OBSERVABLE_SURFACES = [
  'cli',
  'http',
  'doctor',
  'status',
  'daemon_log',
  'telemetry',
  'admin',
  'config',
] as const

export type FitnessObservableSurface = (typeof FITNESS_OBSERVABLE_SURFACES)[number]

export interface FitnessMatrixCell {
  id: string
  tier: FitnessTier
  fault: string
  injectionPoint: string
  observableAssertions: string[]
  surfaces: FitnessObservableSurface[]
  gate: FitnessGate
  telemetryOrigin: TelemetryEventOrigin
  /** True when this file carries an inline behavioral probe for the fault.
   *  False means the cell is covered only by the referenced suites in
   *  `currentEvidence` — honest about the weaker, file-granular guarantee. */
  directProbe: boolean
  currentEvidence: string[]
}

export const FITNESS_TIER1_FAULT_INJECTION_CELLS: readonly FitnessMatrixCell[] = [
  {
    id: 'runtime.unreachable',
    tier: 'tier1_fault_injection',
    fault: 'Local runtime socket is closed or unreachable.',
    injectionPoint: 'Probe a closed localhost runtime URL.',
    observableAssertions: [
      'preflight reports missing local runtime with the target URL',
      'init model detection returns an empty list instead of throwing',
    ],
    surfaces: ['cli', 'doctor', 'status'],
    gate: 'ci',
    telemetryOrigin: 'runtime',
    directProbe: true,
    currentEvidence: [
      'tests/init-router-detect.test.ts',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'runtime.upstream_502',
    tier: 'tier1_fault_injection',
    fault: 'Upstream provider returns a 5xx response.',
    injectionPoint: 'Fake provider route returns 500/502/503.',
    observableAssertions: [
      'messages endpoint returns structured provider diagnostics',
      'fallback attempts are visible in stderr/log output',
    ],
    surfaces: ['http', 'telemetry'],
    gate: 'ci',
    telemetryOrigin: 'runtime',
    directProbe: true,
    currentEvidence: [
      'tests/messages-integration.test.ts',
      'tests/middleware-integration.test.ts',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'config.router_url_v1',
    tier: 'tier1_fault_injection',
    fault: 'User stores an OpenAI-style router URL ending in /v1.',
    injectionPoint: 'Load config and init probes with routerUrl ending in /v1.',
    observableAssertions: [
      'loaded config stores the bare router base',
      'model discovery probes exactly one /v1/models path',
    ],
    surfaces: ['config', 'cli'],
    gate: 'ci',
    telemetryOrigin: 'admin',
    directProbe: true,
    currentEvidence: [
      'tests/router-url-normalize.test.ts',
      'tests/init-router-detect.test.ts',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'daemon.orphan',
    tier: 'tier1_fault_injection',
    fault: 'OwlCoda daemon is alive but PID metadata is missing or stale.',
    injectionPoint: 'Probe /healthz and recover daemon PID without a pid file.',
    observableAssertions: [
      'status message identifies a stale OwlCoda daemon rather than a non-OwlCoda process',
      'stop --force can recover the orphan PID from /healthz',
    ],
    surfaces: ['cli', 'status'],
    gate: 'ci',
    telemetryOrigin: 'daemon',
    directProbe: true,
    currentEvidence: [
      'tests/daemon.test.ts',
      'tests/cli-lifecycle.test.ts',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'daemon.request_throw',
    tier: 'tier1_fault_injection',
    fault: 'A request handler throws synchronously.',
    injectionPoint: 'Invoke the request dispatcher with a throwing handler.',
    observableAssertions: [
      'single request receives a JSON 500 response',
      'the exception does not escape to daemon process scope',
    ],
    surfaces: ['http', 'daemon_log'],
    gate: 'ci',
    telemetryOrigin: 'daemon',
    directProbe: true,
    currentEvidence: [
      'tests/server-request-isolation.test.ts',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'task.no_progress_advisory',
    tier: 'tier1_fault_injection',
    fault: 'Long read-heavy work crosses the no-progress threshold.',
    injectionPoint: 'Run a task loop with many distinct reads and no touched artifact paths.',
    observableAssertions: [
      'the task emits one advisory notice',
      'the loop does not hard-stop by default',
    ],
    surfaces: ['cli', 'telemetry'],
    gate: 'ci',
    telemetryOrigin: 'task',
    directProbe: false,
    currentEvidence: [
      'tests/native/conversation-loop-guard.test.ts',
    ],
  },
  {
    id: 'config.migration_preserves_models',
    tier: 'tier1_fault_injection',
    fault: 'Old config schema is loaded after upgrades.',
    injectionPoint: 'Load legacy config fixtures through migration.',
    observableAssertions: [
      'models are preserved and backendModel is filled',
      'existing backendModel and port are not overwritten',
    ],
    surfaces: ['config', 'cli'],
    gate: 'ci',
    telemetryOrigin: 'admin',
    directProbe: true,
    currentEvidence: [
      'tests/config-migrate.test.ts',
      'tests/config.test.ts',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'build.stale_binary',
    tier: 'tier1_fault_injection',
    fault: 'A built binary reports a baked SHA that no longer matches the source tree HEAD (stale dist masquerading as current code).',
    injectionPoint: 'Classify a baked build SHA against a differing HEAD SHA.',
    observableAssertions: [
      '--version reports a build SHA matching HEAD on a fresh build',
      'a baked SHA differing from HEAD is reported as stale',
    ],
    surfaces: ['cli'],
    gate: 'ci',
    telemetryOrigin: 'fitness',
    directProbe: true,
    currentEvidence: [
      'src/version.ts',
      'scripts/postbuild.mjs',
      '.github/workflows/ci.yml',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'build.imported_untracked',
    tier: 'tier1_fault_injection',
    fault: 'A source module is imported by tracked code but never git-added, so a dirty tree builds while a clean clone and the published tarball fail.',
    injectionPoint: 'Resolve the tracked import graph against the set of git-tracked files.',
    observableAssertions: [
      'a tracked file importing an untracked module is reported as a clean-clone build break',
      'a fully tracked import graph reports no violations',
    ],
    surfaces: ['cli'],
    gate: 'ci',
    telemetryOrigin: 'fitness',
    directProbe: true,
    currentEvidence: [
      'src/native/import-integrity.ts',
      'scripts/check-imported-untracked.mjs',
      '.github/workflows/ci.yml',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
  {
    id: 'arch.ink_write_boundary',
    tier: 'tier1_fault_injection',
    fault: 'A React effect hook in the Ink layer writes to the terminal directly instead of routing through the buffered render Diff.',
    injectionPoint: 'Parse Ink source and locate stdout.write calls lexically inside an effect-hook callback.',
    observableAssertions: [
      'a stdout.write inside a React effect hook is reported as a side-channel write',
      'renderer writes outside any effect hook are not reported',
    ],
    surfaces: ['cli'],
    gate: 'ci',
    telemetryOrigin: 'fitness',
    directProbe: true,
    currentEvidence: [
      'scripts/ink-write-boundary.mjs',
      '.github/workflows/ci.yml',
      'tests/ink-write-boundary.test.ts',
      'tests/fitness-tier1-fault-injection.test.ts',
    ],
  },
] as const

export function listTier1FaultInjectionCells(): readonly FitnessMatrixCell[] {
  return FITNESS_TIER1_FAULT_INJECTION_CELLS
}

export interface FitnessCellObservation {
  decision: TelemetryEventDecision
  reasonCode: string
  severity?: TelemetryEventSeverity
  surface?: FitnessObservableSurface
  subject?: string
  observedAt?: Date | string | number
  evidenceRef?: string
  attributes?: Record<string, unknown>
}

/**
 * Project a fitness cell plus a probe outcome onto the shared telemetry
 * envelope. This is the envelope's first real producer: it proves the schema
 * is sufficient to describe every Tier-1 cell (see the mapping test) instead
 * of leaving the "shared spine" claim aspirational. Pure — no emit/IO here.
 */
export function buildFitnessCellTelemetry(
  cell: FitnessMatrixCell,
  observation: FitnessCellObservation,
): TelemetryEventEnvelope {
  return buildTelemetryEventEnvelope({
    eventType: `fitness.${cell.id}`,
    surface: observation.surface ?? cell.surfaces[0] ?? 'telemetry',
    subject: observation.subject ?? cell.id,
    origin: cell.telemetryOrigin,
    severity: observation.severity ?? 'info',
    decision: observation.decision,
    reasonCode: observation.reasonCode,
    evidenceRef: observation.evidenceRef ?? cell.currentEvidence[0] ?? cell.id,
    ...(observation.observedAt !== undefined ? { observedAt: observation.observedAt } : {}),
    attributes: { tier: cell.tier, gate: cell.gate, ...(observation.attributes ?? {}) },
  })
}
