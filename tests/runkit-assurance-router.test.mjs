import assert from "node:assert/strict";
import test from "node:test";

import {
  routeRunKitAssuranceV1,
} from "../scripts/runkit-contract/assurance-router.mjs";

function safeRequest(overrides = {}) {
  return {
    needsDurableEvidence: false,
    needsFormalAcceptance: false,
    exactCommandCount: 0,
    writerCount: 0,
    mayMutateProject: false,
    externalSideEffects: false,
    longRunning: false,
    interruptionRecovery: false,
    dirtyParallelWorkspace: false,
    riskCategories: [],
    ...overrides,
  };
}

test("assurance routing selects none when durable evidence is unnecessary", () => {
  const routed = routeRunKitAssuranceV1(safeRequest());

  assert.equal(routed.schemaVersion, "OwlCodaRunKitAssuranceRouteV1");
  assert.equal(routed.status, "routed");
  assert.equal(routed.lane, "none");
  assert.equal(routed.riskMode, "lightweight");
  assert.deepEqual(routed.reasonCodes, ["durable_evidence_not_required"]);
  assert.equal(routed.authorizationGranted, false);
});

test("bounded command count alone does not create RunKit work when evidence is unnecessary", () => {
  const routed = routeRunKitAssuranceV1(safeRequest({
    exactCommandCount: 3,
  }));

  assert.equal(routed.lane, "none");
  assert.deepEqual(routed.reasonCodes, ["durable_evidence_not_required"]);
});

test("assurance routing selects Quick only for one bounded side-effect-free verification", () => {
  const routed = routeRunKitAssuranceV1(safeRequest({
    needsDurableEvidence: true,
    exactCommandCount: 1,
  }));

  assert.equal(routed.lane, "quick");
  assert.equal(routed.riskMode, "lightweight");
  assert.deepEqual(routed.reasonCodes, ["single_bounded_verification"]);
  assert.equal(routed.nextCommand, "owlrunkit quick-verify");
});

test("external effects, project writes, and high-risk categories always select Formal", () => {
  for (const request of [
    safeRequest({ needsDurableEvidence: true, exactCommandCount: 1, externalSideEffects: true }),
    safeRequest({ needsDurableEvidence: true, exactCommandCount: 1, mayMutateProject: true }),
    safeRequest({
      needsDurableEvidence: true,
      exactCommandCount: 1,
      riskCategories: ["deployment"],
    }),
  ]) {
    const routed = routeRunKitAssuranceV1(request);
    assert.equal(routed.lane, "formal");
    assert.equal(routed.status, "routed");
    assert.equal(routed.nextCommand, "owlrunkit formal start");
    assert.equal(routed.authorizationGranted, false);
  }
});

test("missing safety facts fail closed to Formal instead of guessing Quick", () => {
  const request = safeRequest({
    needsDurableEvidence: true,
    exactCommandCount: 1,
  });
  delete request.externalSideEffects;

  const routed = routeRunKitAssuranceV1(request);

  assert.equal(routed.lane, "formal");
  assert.equal(routed.riskMode, "full");
  assert.equal(routed.nextCommand, "owlrunkit formal start");
  assert.deepEqual(routed.reasonCodes, [
    "assurance_input_incomplete",
    "unknown_external_side_effects",
  ]);
});

test("risk routing is structured and never infers safety from command prose", () => {
  const routed = routeRunKitAssuranceV1({
    ...safeRequest({
      needsDurableEvidence: true,
      exactCommandCount: 1,
      externalSideEffects: true,
    }),
    command: "echo harmless",
  });

  assert.equal(routed.lane, "formal");
  assert.ok(routed.reasonCodes.includes("external_side_effects"));
});
