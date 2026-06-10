import type { ThirdPartySkillEntry } from './manifest.js'
import { logInfo } from '../logger.js'

/** Record a third-party skill grant. Slice 1: structured log line (envelope wiring deferred). */
export function recordSkillGrant(entry: ThirdPartySkillEntry): void {
  logInfo('skills', 'skill_grant', {
    id: entry.id, source: entry.source, pinnedRef: entry.pinnedRef,
    integrity: entry.integrity, origin: entry.origin, scope: 'project', at: entry.addedAt,
  })
}
