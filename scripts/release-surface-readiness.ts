import {
  evaluatePublicSourceSurface,
  evaluateWebsiteSurface,
} from '../src/native/release-surface-readiness.js'
import { readReleaseSnapshotInputs } from '../src/native/release-snapshot-inputs.js'

const inputs = readReleaseSnapshotInputs()
const publicSource = evaluatePublicSourceSurface(inputs.publicSourceInput)
const website = evaluateWebsiteSurface(inputs.websiteInput)

console.log(JSON.stringify({
  packageName: inputs.packageName,
  localVersion: inputs.localVersion,
  publicRepo: inputs.publicRepo,
  surfaces: {
    publicSource,
    website,
  },
}, null, 2))
