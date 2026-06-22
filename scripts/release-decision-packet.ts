import { buildReleaseDecisionPacket } from '../src/native/release-decision-packet.js'
import { readReleaseSnapshotInputs } from '../src/native/release-snapshot-inputs.js'

const inputs = readReleaseSnapshotInputs({
  prepublishGatePassed: process.argv.includes('--prepublish-passed'),
})

const packet = buildReleaseDecisionPacket(inputs.decisionInput)

console.log(JSON.stringify(packet, null, 2))
