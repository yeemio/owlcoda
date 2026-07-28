import assert from "node:assert/strict"
import test from "node:test"

const buildInfo = await import("../scripts/build-info-status.mjs").catch(() => ({}))

test("RunKit project truth alone does not make a build dirty", () => {
  assert.equal(typeof buildInfo.hasProductSourceChanges, "function")
  assert.equal(buildInfo.hasProductSourceChanges("?? .owlcoda/runkit/run.json\0"), false)
  assert.equal(buildInfo.hasProductSourceChanges(" M .owlcoda/runkit/profiles.json\0"), false)
})

test("product source changes still make a build dirty", () => {
  assert.equal(buildInfo.hasProductSourceChanges(" M src/cli.ts\0"), true)
  assert.equal(buildInfo.hasProductSourceChanges("?? desktop/osui/new.ts\0"), true)
})

test("rename status excludes only changes wholly inside RunKit truth", () => {
  assert.equal(buildInfo.hasProductSourceChanges("R  .owlcoda/runkit/old.json\0.owlcoda/runkit/new.json\0"), false)
  assert.equal(buildInfo.hasProductSourceChanges("R  src/old.ts\0.owlcoda/runkit/new.json\0"), true)
})
