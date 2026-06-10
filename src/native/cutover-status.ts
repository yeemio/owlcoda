/**
 * Cutover-status readout (ADR-025 P1).
 *
 * The structural bug this fixes: owlcoda quantifies cutover criteria in prose
 * (handoffs, the permission-modes-cutover-criteria doc) but never reads them
 * back, so opt-in gates (provenance, GATE_V2, ...) stay shadow-only for months
 * — the "expensive 80% (criteria), missing cheap 20% (readout)" anti-pattern.
 *
 * This turns the prose into a DECLARATIVE table and evaluates each criterion
 * against the gate-events ledger, so "has gate X met its cutover bar" is one
 * command, not a memory exercise. It is read-only: it never flips a flag.
 *
 * Honesty: a gate is only `allAutoMet` when every auto-countable criterion is
 * confirmed met. Manual-review criteria (e.g. "0 unwanted analysis-hint
 * softenings") and insufficient-data rates report met=null so they can never be
 * silently counted as passing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { GateEvent, GateEventKind } from './gate-telemetry.js'

const MS_PER_DAY = 86_400_000
// A rate needs enough denominator events to be meaningful; below this it reads
// as insufficient (met=null) rather than passing on a lucky n=1.
const MIN_RATE_SAMPLE = 20

export type CutoverCriterion =
  | { id: string; label: string; type: 'count'; kinds: GateEventKind[]; threshold: number }
  | { id: string; label: string; type: 'window_days'; threshold: number }
  | {
      id: string
      label: string
      type: 'rate'
      numeratorKinds: GateEventKind[]
      denominatorKinds: GateEventKind[]
      threshold: number
      comparator: 'lt' | 'lte'
    }
  | { id: string; label: string; type: 'manual'; note: string }

export interface CutoverGateSpec {
  gate: string
  /** Opt-in env var; kept so the readout can point the user at the right flag. */
  envVar: string
  criteria: CutoverCriterion[]
}

export interface CriterionResult {
  id: string
  label: string
  type: CutoverCriterion['type']
  /** Current measured value (count, days, or rate); null for manual criteria. */
  current: number | null
  threshold: number | null
  /** true/false for auto criteria; null = manual or insufficient data. */
  met: boolean | null
  detail: string
}

export interface CutoverStatus {
  gate: string
  envVar: string
  criteria: CriterionResult[]
  /** Every non-manual criterion confirmed met (insufficient-data => not met). */
  allAutoMet: boolean
  /** Manual-review criteria still pending human sign-off. */
  manualPending: number
}

function countKinds(events: readonly GateEvent[], kinds: readonly string[]): number {
  const set = new Set(kinds)
  let n = 0
  for (const e of events) if (set.has(e.kind)) n++
  return n
}

/** Evaluate a single criterion against the events. Pure. */
export function evaluateCutoverCriterion(
  events: readonly GateEvent[],
  criterion: CutoverCriterion,
  /** When set, window_days measures the span over only these kinds (the gate's
   *  own events) — otherwise an unrelated gate's history inflates the soak. */
  gateKinds?: ReadonlySet<string>,
): CriterionResult {
  const base = { id: criterion.id, label: criterion.label, type: criterion.type }

  if (criterion.type === 'count') {
    const current = countKinds(events, criterion.kinds)
    return { ...base, current, threshold: criterion.threshold, met: current >= criterion.threshold, detail: `${current}/${criterion.threshold} events` }
  }

  if (criterion.type === 'window_days') {
    const scoped = gateKinds ? events.filter(e => gateKinds.has(e.kind)) : events
    if (scoped.length < 2) {
      return { ...base, current: 0, threshold: criterion.threshold, met: false, detail: `0d / ${criterion.threshold}d (n<2)` }
    }
    let min = Infinity
    let max = -Infinity
    for (const e of scoped) {
      if (e.ts < min) min = e.ts
      if (e.ts > max) max = e.ts
    }
    const days = Math.round(((max - min) / MS_PER_DAY) * 10) / 10
    return { ...base, current: days, threshold: criterion.threshold, met: days >= criterion.threshold, detail: `${days}d / ${criterion.threshold}d` }
  }

  if (criterion.type === 'rate') {
    const den = countKinds(events, criterion.denominatorKinds)
    if (den < MIN_RATE_SAMPLE) {
      return { ...base, current: null, threshold: criterion.threshold, met: null, detail: `n=${den} (insufficient, need >=${MIN_RATE_SAMPLE})` }
    }
    const num = countKinds(events, criterion.numeratorKinds)
    const rate = num / den
    const met = criterion.comparator === 'lt' ? rate < criterion.threshold : rate <= criterion.threshold
    return { ...base, current: rate, threshold: criterion.threshold, met, detail: `${num}/${den} = ${(rate * 100).toFixed(1)}% (${criterion.comparator} ${(criterion.threshold * 100).toFixed(0)}%)` }
  }

  // manual
  return { ...base, current: null, threshold: null, met: null, detail: criterion.note }
}

/** Evaluate every criterion in a gate spec against the events. Pure. */
export function buildCutoverStatus(
  events: readonly GateEvent[],
  spec: CutoverGateSpec,
): CutoverStatus {
  // The kinds this gate's count/rate criteria care about — used to scope the
  // soak window to the gate's own events (not unrelated gates in the same ledger).
  const gateKinds = new Set<string>()
  for (const c of spec.criteria) {
    if (c.type === 'count') for (const k of c.kinds) gateKinds.add(k)
    else if (c.type === 'rate') {
      for (const k of c.numeratorKinds) gateKinds.add(k)
      for (const k of c.denominatorKinds) gateKinds.add(k)
    }
  }
  const criteria = spec.criteria.map(c => evaluateCutoverCriterion(events, c, gateKinds))
  const autoCriteria = criteria.filter(c => c.type !== 'manual')
  return {
    gate: spec.gate,
    envVar: spec.envVar,
    criteria,
    allAutoMet: autoCriteria.length > 0 && autoCriteria.every(c => c.met === true),
    manualPending: criteria.filter(c => c.type === 'manual').length,
  }
}

/**
 * Declarative cutover criteria, lifted from the prose in the handoffs and
 * docs/superpowers/permission-modes-cutover-criteria.md. gate-events ledger
 * only. (S11 routing-shadow reads the unified envelope ledger and has its own
 * summary; it is intentionally not in this table.)
 */
export const CUTOVER_GATE_SPECS: readonly CutoverGateSpec[] = [
  {
    gate: 'modes',
    envVar: 'OWLCODA_MODES',
    criteria: [
      { id: 'soak', label: 'soak window', type: 'window_days', threshold: 14 },
      { id: 'volume', label: 'mode events', type: 'count', kinds: ['mode_gate_block', 'mode_analysis_hint', 'mode_auto_approve'], threshold: 200 },
      { id: 'auto_volume', label: 'auto approvals', type: 'count', kinds: ['mode_auto_approve'], threshold: 30 },
      { id: 'analysis_hint_review', label: 'analysis-hint softenings reviewed (0 unwanted)', type: 'manual', note: 'inspect every mode_analysis_hint with modeWouldBlockLegacy=true' },
      { id: 'plan_fp', label: 'plan has 0 false positives', type: 'manual', note: 'confirm no report of plan blocking a read-only call' },
    ],
  },
  {
    gate: 'provenance',
    envVar: 'OWLCODA_GATE_PROVENANCE',
    criteria: [
      { id: 'soak', label: 'soak window', type: 'window_days', threshold: 14 },
      { id: 'admit', label: 'admits', type: 'count', kinds: ['path_provenance_admit_evidence', 'path_provenance_parent_admit'], threshold: 200 },
      // Block decisions count both enforce-mode blocks and shadow-mode
      // would-blocks: the gate is opt-in and ships in shadow, where it emits
      // path_provenance_would_block (path_provenance_block only fires once
      // enforcement is on). Counting only block makes this unmeetable in shadow.
      { id: 'block', label: 'block decisions (enforce block or shadow would-block)', type: 'count', kinds: ['path_provenance_block', 'path_provenance_would_block'], threshold: 30 },
      // FP rate is NOT auto-computable: a would-block is only a false positive if
      // the write should have been admitted, which telemetry can't know. Manual
      // review of a would-block sample, not a fabricated rate.
      { id: 'fp_review', label: 'would-block false-positive review (<5%)', type: 'manual', note: 'sample path_provenance_would_block events; confirm <5% are writes that should have been admitted' },
    ],
  },
  {
    gate: 'gate_v2',
    envVar: 'OWLCODA_GATE_V2',
    criteria: [
      { id: 'soak', label: 'soak window', type: 'window_days', threshold: 10 },
      { id: 'volume', label: 'predicate events', type: 'count', kinds: ['gate_predicate_agreement', 'gate_predicate_disagreement'], threshold: 100 },
      { id: 'new_fires_old_silent', label: 'predicate disagreement rate', type: 'rate', numeratorKinds: ['gate_predicate_disagreement'], denominatorKinds: ['gate_predicate_agreement', 'gate_predicate_disagreement'], threshold: 0.05, comparator: 'lt' },
    ],
  },
]

// ─── Ledger reader ───

export interface CutoverLedgerOptions {
  home?: string
  maxFiles?: number
}

// Cutover windows are >=10-14d; read a generous span so the soak criterion is
// never truncated (the fidelity reader's 7-day default would clip it).
const DEFAULT_MAX_FILES = 30

/** Read gate events from ~/.owlcoda/telemetry/gate-events-*.jsonl. */
export function readGateEvents(
  options: CutoverLedgerOptions = {},
): { events: GateEvent[]; filesRead: string[] } {
  const home = options.home ?? process.env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
  const telemetryDir = join(home, 'telemetry')
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
  const events: GateEvent[] = []
  const filesRead: string[] = []
  try {
    if (!existsSync(telemetryDir) || !statSync(telemetryDir).isDirectory()) {
      return { events, filesRead }
    }
    const files = readdirSync(telemetryDir)
      .filter(name => /^gate-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse()
      .slice(0, maxFiles)
    for (const fileName of files) {
      const filePath = join(telemetryDir, fileName)
      filesRead.push(filePath)
      let content = ''
      try {
        content = readFileSync(filePath, 'utf8')
      } catch {
        continue
      }
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as { kind?: unknown }
          if (parsed && typeof parsed.kind === 'string') events.push(parsed as GateEvent)
        } catch {
          // skip malformed line
        }
      }
    }
  } catch {
    // return whatever was gathered
  }
  return { events, filesRead }
}

/** Read the ledger and evaluate every configured gate (or one, if filtered). */
export function buildAllCutoverStatuses(
  options: CutoverLedgerOptions & { gate?: string } = {},
): { statuses: CutoverStatus[]; filesRead: string[] } {
  const { events, filesRead } = readGateEvents(options)
  const specs = options.gate
    ? CUTOVER_GATE_SPECS.filter(s => s.gate === options.gate)
    : CUTOVER_GATE_SPECS
  return { statuses: specs.map(spec => buildCutoverStatus(events, spec)), filesRead }
}

// ─── Formatter ───

/** Human-readable one-gate block: a header verdict + a line per criterion. */
export function formatCutoverStatus(status: CutoverStatus): string {
  const head = status.allAutoMet
    ? status.manualPending > 0
      ? `AUTO-MET · ${status.manualPending} manual review(s) pending`
      : 'ALL MET'
    : 'NOT MET'
  const lines = [`${status.gate} (${status.envVar}): ${head}`]
  for (const c of status.criteria) {
    const mark = c.met === true ? '✓' : c.met === false ? '✗' : '·'
    lines.push(`  ${mark} ${c.label}: ${c.detail}`)
  }
  return lines.join('\n')
}
