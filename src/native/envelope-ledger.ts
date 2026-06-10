/**
 * Shared reader for the unified telemetry envelope ledger
 * (~/.owlcoda/telemetry/events-*.jsonl). Multiple shadow features write here
 * (model_routing_shadow, microcompact_shadow, ...); this is the one place that
 * enumerates + parses the files so each summarizer only has to tally.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TelemetryEventEnvelope } from './telemetry-envelope.js'

export interface EnvelopeLedgerOptions {
  home?: string
  maxFiles?: number
}

// Shadow cutover windows lean on ~2 weeks; default to 14 days so a soak metric
// is not truncated (the original fidelity reader's 7-day default would clip it).
const DEFAULT_MAX_FILES = 14

/** Read parsed envelope events from the unified ledger, newest files first. */
export function readEnvelopeEvents(
  options: EnvelopeLedgerOptions = {},
): { events: TelemetryEventEnvelope[]; filesRead: string[] } {
  const home = options.home ?? process.env['OWLCODA_HOME'] ?? join(homedir(), '.owlcoda')
  const telemetryDir = join(home, 'telemetry')
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES)
  const events: TelemetryEventEnvelope[] = []
  const filesRead: string[] = []
  try {
    if (!existsSync(telemetryDir) || !statSync(telemetryDir).isDirectory()) {
      return { events, filesRead }
    }
    const files = readdirSync(telemetryDir)
      .filter(name => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
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
          events.push(JSON.parse(trimmed) as TelemetryEventEnvelope)
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
