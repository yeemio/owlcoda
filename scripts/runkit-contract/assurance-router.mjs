const BOOLEAN_FACTS = [
  "needsDurableEvidence",
  "needsFormalAcceptance",
  "mayMutateProject",
  "externalSideEffects",
  "longRunning",
  "interruptionRecovery",
  "dirtyParallelWorkspace",
];

const RISK_CATEGORIES = new Set([
  "backtest",
  "deployment",
  "destructive",
  "foreign_write",
  "funds",
  "integration",
  "migration",
  "production",
  "release",
]);

const FULL_RISK_CATEGORIES = new Set([
  "deployment",
  "destructive",
  "foreign_write",
  "funds",
  "production",
  "release",
]);

function incompleteReasons(input) {
  const reasons = [];
  for (const field of BOOLEAN_FACTS) {
    if (typeof input?.[field] !== "boolean") {
      reasons.push(`unknown_${field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`);
    }
  }
  if (!Number.isInteger(input?.exactCommandCount) || input.exactCommandCount < 0) {
    reasons.push("unknown_exact_command_count");
  }
  if (!Number.isInteger(input?.writerCount) || input.writerCount < 0) {
    reasons.push("unknown_writer_count");
  }
  if (!Array.isArray(input?.riskCategories)) {
    reasons.push("unknown_risk_categories");
  } else if (input.riskCategories.some(category => !RISK_CATEGORIES.has(category))) {
    reasons.push("unknown_risk_category");
  }
  return [...new Set(reasons)].sort();
}

function result({ lane, riskMode, reasonCodes, nextCommand }) {
  return {
    schemaVersion: "OwlCodaRunKitAssuranceRouteV1",
    status: "routed",
    lane,
    riskMode,
    reasonCodes,
    nextCommand,
    authorizationGranted: false,
  };
}

export function routeRunKitAssuranceV1(input) {
  const incomplete = incompleteReasons(input);
  if (incomplete.length > 0) {
    return result({
      lane: "formal",
      riskMode: "full",
      reasonCodes: ["assurance_input_incomplete", ...incomplete],
      nextCommand: "owlrunkit formal start",
    });
  }

  const categories = [...new Set(input.riskCategories)].sort();
  const formalReasons = [
    ...(input.needsFormalAcceptance ? ["formal_acceptance_required"] : []),
    ...(input.mayMutateProject ? ["project_mutation"] : []),
    ...(input.externalSideEffects ? ["external_side_effects"] : []),
    ...(input.longRunning ? ["long_running_execution"] : []),
    ...(input.interruptionRecovery ? ["interruption_recovery_required"] : []),
    ...(input.dirtyParallelWorkspace ? ["dirty_parallel_workspace"] : []),
    ...(input.writerCount > 0 ? ["writer_scope_required"] : []),
    ...(input.needsDurableEvidence && input.exactCommandCount === 0
      ? ["exact_command_missing"]
      : []),
    ...(input.needsDurableEvidence && input.exactCommandCount > 1
      ? ["multiple_commands"]
      : []),
    ...categories.map(category => `risk_${category}`),
  ];
  if (formalReasons.length > 0) {
    const full = input.externalSideEffects
      || categories.some(category => FULL_RISK_CATEGORIES.has(category));
    return result({
      lane: "formal",
      riskMode: full ? "full" : "standard",
      reasonCodes: [...new Set(formalReasons)].sort(),
      nextCommand: "owlrunkit formal start",
    });
  }

  if (!input.needsDurableEvidence) {
    return result({
      lane: "none",
      riskMode: "lightweight",
      reasonCodes: ["durable_evidence_not_required"],
      nextCommand: null,
    });
  }

  return result({
    lane: "quick",
    riskMode: "lightweight",
    reasonCodes: ["single_bounded_verification"],
    nextCommand: "owlrunkit quick-verify",
  });
}
