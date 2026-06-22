import { buildReleaseDecisionPacket } from '../src/native/release-decision-packet.js'
import { buildReleaseReadinessSnapshot } from '../src/native/release-readiness.js'
import { readReleaseSnapshotInputs } from '../src/native/release-snapshot-inputs.js'
import {
  evaluatePublicSourceSurface,
  evaluateWebsiteSurface,
} from '../src/native/release-surface-readiness.js'

const inputs = readReleaseSnapshotInputs({
  prepublishGatePassed: process.argv.includes('--prepublish-passed'),
})

const decisionPacket = buildReleaseDecisionPacket(inputs.decisionInput)
const snapshot = buildReleaseReadinessSnapshot({
  decisionPacket,
  surfaceReadiness: {
    publicSource: evaluatePublicSourceSurface(inputs.publicSourceInput),
    website: evaluateWebsiteSurface(inputs.websiteInput),
  },
})

console.log(JSON.stringify(snapshot, null, 2))
