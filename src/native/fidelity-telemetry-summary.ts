import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { GateEvent } from './gate-telemetry.js'

type FidelityEventKind = Extract<GateEvent['kind'], 'fidelity_claim_observed' | 'fidelity_compaction_fact_observed'>
type FidelityEvent = GateEvent & { kind: FidelityEventKind }

export interface FidelityTelemetrySummaryOptions {
  home?: string
  maxFiles?: number
  sampleLimit?: number
}

export interface FidelityTelemetrySample {
  reviewKey: string
  ts: number
  kind: FidelityEventKind
  target: string
  verdict: string
  detail: string
  model?: string
  phase?: string
  surface?: string
}

export interface FidelityTelemetrySummary {
  home: string
  telemetryDir: string
  filesRead: string[]
  totalEvents: number
  malformedLines: number
  claims: {
    total: number
    matched: number
    unmatched: number
  }
  compactionFacts: {
    total: number
    preserved: number
    dropped: number
  }
  recent: FidelityTelemetrySample[]
}

const DEFAULT_MAX_FILES = 7
const DEFAULT_SAMPLE_LIMIT = 8
const FIDELITY_KINDS = new Set<string>([
  'fidelity_claim_observed',
  'fidelity_compaction_fact_observed',
])

function defaultOwlcodaHome(): string {
  return process.env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
}

function emptySummary(home: string, telemetryDir: string): FidelityTelemetrySummary {
  return {
    home,
    telemetryDir,
    filesRead: [],
    totalEvents: 0,
    malformedLines: 0,
    claims: { total: 0, matched: 0, unmatched: 0 },
    compactionFacts: { total: 0, preserved: 0, dropped: 0 },
    recent: [],
  }
}

function isFidelityEvent(value: unknown): value is FidelityEvent {
  if (!value || typeof value !== 'object') return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && FIDELITY_KINDS.has(kind)
}

function displayTarget(event: FidelityEvent): string {
  if (event.target) return event.target
  if (event.factType) return `(${event.factType})`
  return '(no target)'
}

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function buildReviewKey(event: FidelityEvent, target: string, verdict: string, detail: string): string {
  const anchorOrFactType = event.kind === 'fidelity_claim_observed'
    ? event.anchorType ?? ''
    : event.factType ?? ''
  return createHash('sha256')
    .update([
      event.kind,
      target,
      anchorOrFactType,
      verdict,
      detail,
    ].join('\0'))
    .digest('hex')
    .slice(0, 12)
}

function toSample(event: FidelityEvent): FidelityTelemetrySample {
  if (event.kind === 'fidelity_claim_observed') {
    const target = displayTarget(event)
    const verdict = event.matched === true ? 'matched' : 'unmatched'
    const detail = `origin=${event.evidenceOrigin ?? 'unknown'}`
    return {
      reviewKey: buildReviewKey(event, target, verdict, detail),
      ts: event.ts,
      kind: event.kind,
      target,
      verdict,
      detail,
      model: event.model,
      phase: event.phase,
      surface: event.surface,
    }
  }

  const target = displayTarget(event)
  const verdict = event.preserved === true ? 'preserved' : 'dropped'
  const detail = `reason=${event.compactionFactReason ?? event.reason ?? 'unknown'}`
  return {
    reviewKey: buildReviewKey(event, target, verdict, detail),
    ts: event.ts,
    kind: event.kind,
    target,
    verdict,
    detail,
    model: event.model,
    phase: event.phase,
    surface: event.surface,
  }
}

export function buildFidelityTelemetrySummary(options: FidelityTelemetrySummaryOptions = {}): FidelityTelemetrySummary {
  const home = options.home ?? defaultOwlcodaHome()
  const telemetryDir = join(home, 'telemetry')
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
  const sampleLimit = Math.max(1, options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT)
  const summary = emptySummary(home, telemetryDir)

  try {
    if (!existsSync(telemetryDir) || !statSync(telemetryDir).isDirectory()) {
      return summary
    }

    const files = readdirSync(telemetryDir)
      .filter(name => /^gate-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
      .sort()
      .reverse()
      .slice(0, maxFiles)

    const events: FidelityEvent[] = []
    for (const fileName of files) {
      const filePath = join(telemetryDir, fileName)
      summary.filesRead.push(filePath)
      let content = ''
      try {
        content = readFileSync(filePath, 'utf8')
      } catch {
        summary.malformedLines++
        continue
      }

      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          summary.malformedLines++
          continue
        }
        if (!isFidelityEvent(parsed)) continue
        events.push(parsed)
      }
    }

    for (const event of events) {
      summary.totalEvents++
      if (event.kind === 'fidelity_claim_observed') {
        summary.claims.total++
        if (event.matched === true) summary.claims.matched++
        else summary.claims.unmatched++
      } else {
        summary.compactionFacts.total++
        if (event.preserved === true) summary.compactionFacts.preserved++
        else summary.compactionFacts.dropped++
      }
    }

    summary.recent = events
      .sort((left, right) => right.ts - left.ts)
      .slice(0, sampleLimit)
      .map(toSample)
    return summary
  } catch {
    return summary
  }
}

export function formatFidelityTelemetrySummary(summary: FidelityTelemetrySummary): string {
  const lines = [
    'Fidelity telemetry (shadow-only, read-only)',
    `Home: ${summary.home}`,
  ]

  if (summary.filesRead.length === 0) {
    lines.push('No fidelity telemetry files found.')
    return lines.join('\n')
  }

  lines.push(`Scanned: ${summary.filesRead.length} file(s) (${summary.filesRead.map(file => basename(file)).join(', ')})`)
  if (summary.totalEvents === 0) {
    lines.push('No fidelity events found in scanned telemetry.')
    if (summary.malformedLines > 0) lines.push(`Ignored malformed lines: ${summary.malformedLines}`)
    return lines.join('\n')
  }

  lines.push(`Events: ${summary.totalEvents} fidelity event(s)`)
  lines.push(`Claims: ${summary.claims.total} total, ${summary.claims.matched} matched, ${summary.claims.unmatched} unmatched`)
  lines.push(`Compaction facts: ${summary.compactionFacts.total} total, ${summary.compactionFacts.preserved} preserved, ${summary.compactionFacts.dropped} dropped`)
  if (summary.malformedLines > 0) lines.push(`Ignored malformed lines: ${summary.malformedLines}`)
  lines.push('')
  lines.push('Recent review samples:')

  for (const sample of summary.recent) {
    const time = new Date(sample.ts).toISOString().slice(11, 19)
    const kind = sample.kind === 'fidelity_claim_observed' ? 'claim' : 'compact'
    const parts = [
      `${time}`,
      `key=${sample.reviewKey}`,
      kind,
      sample.verdict,
      truncate(sample.target),
      sample.detail,
    ]
    if (sample.model) parts.push(`model=${sample.model}`)
    if (sample.phase) parts.push(`phase=${sample.phase}`)
    if (sample.surface) parts.push(`surface=${truncate(sample.surface, 48)}`)
    lines.push(`  - ${parts.join(' ')}`)
  }

  return lines.join('\n')
}

export function formatFidelityTelemetryJson(summary: FidelityTelemetrySummary): string {
  return JSON.stringify(summary, null, 2)
}

export function formatFidelityReviewPacket(summary: FidelityTelemetrySummary): string {
  return JSON.stringify({
    schema: 'owlcoda.fidelity.review.v1',
    capability: 'debug-only shadow export',
    enforcement: 'blocked',
    home: summary.home,
    filesRead: summary.filesRead,
    totals: {
      events: summary.totalEvents,
      malformedLines: summary.malformedLines,
      claims: summary.claims,
      compactionFacts: summary.compactionFacts,
    },
    samples: summary.recent.map(sample => ({
      reviewKey: sample.reviewKey,
      kind: sample.kind,
      target: sample.target,
      verdict: sample.verdict,
      detail: sample.detail,
      model: sample.model ?? null,
      phase: sample.phase ?? null,
      surface: sample.surface ?? null,
      humanLabel: null,
      reviewerNotes: '',
    })),
  }, null, 2)
}
