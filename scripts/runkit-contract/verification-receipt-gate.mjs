import { readFile } from "node:fs/promises";

import { isDirectExecution } from "./core-contract.mjs";

import { validateReceiptLineage } from "./receipt-lineage.mjs";
import { validateReplayableEvidence } from "./acceptance-evidence.mjs";
import {
  validateVerificationContext,
  verificationContextFingerprint as computeVerificationContextFingerprint,
} from "./verification-context.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const DEFERRED_STATUSES = new Set([
  "ready_for_verification",
  "shadow_validated",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(code, message, extra = {}) {
  return { code, ...extra, message };
}

function isSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isSortedUniqueStrings(values) {
  return Array.isArray(values)
    && values.every(
      (value) => typeof value === "string"
        && value.trim().length > 0
        && value.trim() === value,
    )
    && new Set(values).size === values.length
    && values.every((value, index) => index === 0 || values[index - 1] < value);
}

function isRisk(value) {
  return isRecord(value)
    && new Set(["lightweight", "standard", "full"]).has(value.riskMode)
    && isSortedUniqueStrings(value.riskCategories)
    && value.riskCategories.every(category => new Set([
      "backtest",
      "funds",
      "migration",
      "production",
      "release",
    ]).has(category));
}

function validateSourceArtifactShape(receipt, sourceGate) {
  if (receipt.sourceArtifact === undefined) return [];
  const artifact = receipt.sourceArtifact;
  if (
    !isRecord(artifact)
    || !new Set(["delivery_packet_v1", "source_candidate_v2"])
      .has(artifact.kind)
    || artifact.runId !== receipt.runId
    || typeof artifact.path !== "string"
    || artifact.path.length === 0
    || artifact.path.startsWith("/")
    || artifact.path.split("/").some(segment => (
      segment.length === 0 || segment === "." || segment === ".."
    ))
    || !isSha256(artifact.sha256)
    || !isSha256(artifact.sourceFingerprint)
    || artifact.sourceFingerprint !== receipt.sourceFingerprint
    || artifact.sourceFingerprint !== sourceGate?.recomputedFingerprint
  ) {
    return [issue(
      "source_artifact_binding_malformed",
      "sourceArtifact must exactly bind the active run, source bytes, path, and fingerprint.",
    )];
  }
  return [];
}

function sameRisk(left, right) {
  return left?.riskMode === right?.riskMode
    && JSON.stringify(left?.riskCategories) === JSON.stringify(right?.riskCategories);
}

function validateRepairControlShape(receipt) {
  const issues = [];
  const hasSupersedes = receipt.supersedesReceiptSha256 !== undefined;
  const hasControl = receipt.repairControl !== undefined;
  if (hasSupersedes && !hasControl) {
    issues.push(issue(
      "repair_control_required",
      "A superseding receipt requires a source-bound repairControl.",
    ));
    return issues;
  }
  if (!hasSupersedes && hasControl) {
    issues.push(issue(
      "repair_control_malformed",
      "repairControl is only valid on a superseding receipt.",
    ));
    return issues;
  }
  if (!hasSupersedes) return issues;
  if (!isSha256(receipt.supersedesReceiptSha256)) {
    issues.push(issue(
      "repair_control_malformed",
      "supersedesReceiptSha256 must be a SHA-256.",
    ));
  }
  if (!isRecord(receipt.repairControl)) {
    issues.push(issue("repair_control_malformed", "repairControl must be an object."));
    return issues;
  }
  const control = receipt.repairControl;
  if (typeof control.repairPlanPath !== "string"
    || control.repairPlanPath.length === 0
    || control.parentBindingMode !== "receipt"
    || !isSha256(control.repairPlanSha256)
    || !isSha256(control.goalContractSha256)
    || !isSha256(control.profilesSha256)
    || !Array.isArray(control.executableBindings)
    || control.executableBindings.length === 0) {
    issues.push(issue(
      "repair_control_malformed",
      "repairControl is missing its plan, goal, profile, or executable binding.",
    ));
  }
  const bindingIds = [];
  for (const binding of control.executableBindings ?? []) {
    if (!isRecord(binding)
      || typeof binding.commandId !== "string"
      || binding.commandId.length === 0
      || typeof binding.executable !== "string"
      || binding.executable.length === 0
      || !isSha256(binding.sha256)) {
      issues.push(issue(
        "repair_control_malformed",
        "Each repair executable binding must identify one command, executable, and SHA-256.",
      ));
      continue;
    }
    bindingIds.push(binding.commandId);
  }
  if (new Set(bindingIds).size !== bindingIds.length) {
    issues.push(issue(
      "repair_control_malformed",
      "repair executable binding commandIds must be unique.",
    ));
  }
  if (!isSha256(receipt.goalContractSha256) || !isRisk(receipt.risk)) {
    issues.push(issue(
      "goal_contract_binding_missing",
      "A superseding receipt requires goalContractSha256 and normalized risk.",
    ));
  } else if (control.goalContractSha256 !== receipt.goalContractSha256
    || !isRisk(control.risk)
    || !sameRisk(control.risk, receipt.risk)) {
    issues.push(issue(
      "repair_risk_binding_mismatch",
      "repairControl goal and risk must exactly match the receipt binding.",
    ));
  }
  return issues;
}

function malformedResult(issues, lineage = null) {
  return {
    valid: false,
    malformed: true,
    accepted: false,
    verificationPassed: false,
    decision: "malformed_input",
    activeReceiptSha256: null,
    lineage,
    issues,
  };
}

function validateGateShapes({ sourceGate, profileImpact }) {
  const issues = [];
  if (!isRecord(sourceGate)) {
    issues.push(issue("source_gate_not_object", "sourceGate must be an object."));
  } else {
    if (typeof sourceGate.status !== "string") {
      issues.push(issue("malformed_source_gate_status", "sourceGate.status must be a string."));
    }
    if (!Number.isInteger(sourceGate.exitCode)) {
      issues.push(issue("malformed_source_gate_exit_code", "sourceGate.exitCode must be an integer."));
    }
    if (!isSha256(sourceGate.declaredFingerprint)) {
      issues.push(issue(
        "malformed_declared_fingerprint",
        "sourceGate.declaredFingerprint must be a 64-character hexadecimal SHA-256.",
      ));
    }
    if (!isSha256(sourceGate.recomputedFingerprint)) {
      issues.push(issue(
        "malformed_recomputed_fingerprint",
        "sourceGate.recomputedFingerprint must be a 64-character hexadecimal SHA-256.",
      ));
    }
  }

  if (!isRecord(profileImpact)) {
    issues.push(issue("profile_impact_not_object", "profileImpact must be an object."));
  } else {
    if (typeof profileImpact.decision !== "string") {
      issues.push(issue(
        "malformed_profile_decision",
        "profileImpact.decision must be a string.",
      ));
    }
    if (!isSortedUniqueStrings(profileImpact.profileIds)) {
      issues.push(issue(
        "malformed_profile_ids",
        "profileImpact.profileIds must be a lexically sorted array of unique non-empty strings.",
      ));
    }
  }
  return issues;
}

function validateActiveReceiptShape(receipt, contractVersion) {
  const issues = [];
  if (contractVersion === "0.2") {
    if (receipt.schemaVersion !== "OwlCodaRunKitVerificationReceiptV2") {
      issues.push(issue(
        "unsupported_v02_receipt_schema",
        "Contract v0.2 requires OwlCodaRunKitVerificationReceiptV2.",
      ));
    }
    if (typeof receipt.runId !== "string" || receipt.runId.length === 0) {
      issues.push(issue(
        "missing_receipt_run_id",
        "Contract v0.2 receipt requires runId.",
      ));
    }
    if (!isSha256(receipt.verificationContextFingerprint)) {
      issues.push(issue(
        "malformed_verification_context_fingerprint",
        "Contract v0.2 receipt requires verificationContextFingerprint.",
      ));
    }
  }
  if (!isSha256(receipt.sourceFingerprint)) {
    issues.push(issue(
      "malformed_receipt_source_fingerprint",
      "The active receipt sourceFingerprint must be a 64-character hexadecimal SHA-256.",
    ));
  }
  if (!isSortedUniqueStrings(receipt.selectedProfileIds)) {
    issues.push(issue(
      "malformed_selected_profile_ids",
      "The active receipt selectedProfileIds must be a lexically sorted array of unique non-empty strings.",
    ));
  }
  if (!Number.isInteger(receipt.commandRuns) || receipt.commandRuns < 0) {
    issues.push(issue(
      "malformed_command_runs",
      "The active receipt commandRuns must be a non-negative integer.",
    ));
  }
  if (!Array.isArray(receipt.commandReceipts)) {
    issues.push(issue(
      "command_receipts_not_array",
      "The active receipt commandReceipts must be an array.",
    ));
  }
  if ((receipt.goalContractSha256 !== undefined || receipt.risk !== undefined)
    && (!isSha256(receipt.goalContractSha256) || !isRisk(receipt.risk))) {
    issues.push(issue(
      "goal_contract_binding_malformed",
      "Receipt goalContractSha256 and normalized risk must either both be valid or both be absent.",
    ));
  }
  issues.push(...validateRepairControlShape(receipt));
  return issues;
}

function validateCommandReceipt(commandReceipt, index, contractVersion) {
  if (!isRecord(commandReceipt)) {
    return [issue(
      "command_receipt_not_object",
      "Each command receipt must be an object.",
      { index },
    )];
  }

  const issues = [];
  if (contractVersion === "0.2") {
    const evidenceValidation = validateReplayableEvidence(commandReceipt.evidence);
    if (!evidenceValidation.valid) {
      issues.push(...evidenceValidation.issues.map((message) => issue(
        "non_replayable_command_evidence",
        message,
        { index },
      )));
    }
  } else if (
    typeof commandReceipt.command !== "string"
    || commandReceipt.command.trim().length === 0
  ) {
    issues.push(issue(
      "missing_command",
      "Each command receipt must name the command that ran.",
      { index },
    ));
  }
  if (!Number.isInteger(commandReceipt.exitCode)) {
    issues.push(issue(
      "malformed_command_exit_code",
      "Each command receipt exitCode must be an integer.",
      { index },
    ));
  }
  if (!isSha256(commandReceipt.stdoutSha256)) {
    issues.push(issue(
      "malformed_stdout_sha256",
      "Each command receipt must bind a 64-character stdoutSha256.",
      { index },
    ));
  }
  if (!isSha256(commandReceipt.stderrSha256)) {
    issues.push(issue(
      "malformed_stderr_sha256",
      "Each command receipt must bind a 64-character stderrSha256.",
      { index },
    ));
  }
  return issues;
}

export function validateVerificationReceiptGate({
  contractVersion = "0.1",
  receipts,
  sourceGate,
  profileImpact,
  verificationContext = null,
} = {}) {
  if (!new Set(["0.1", "0.2"]).has(contractVersion)) {
    return malformedResult([
      issue("unsupported_contract_version", "contractVersion must be 0.1 or 0.2."),
    ]);
  }
  if (
    Array.isArray(receipts)
    && receipts.some((entry) => {
      const receipt = isRecord(entry?.receipt) ? entry.receipt : entry;
      return isRecord(receipt) && receipt.schemaVersion === "OwlCodaQuickVerificationReceiptV1";
    })
  ) {
    return {
      contractVersion,
      valid: false,
      malformed: false,
      accepted: false,
      verificationPassed: false,
      decision: "rejected",
      activeReceiptSha256: null,
      lineage: null,
      issues: [issue(
        "quick_receipt_not_formal",
        "A Quick Receipt cannot satisfy a Formal Delivery verification gate.",
      )],
    };
  }
  const lineage = validateReceiptLineage(receipts);
  if (lineage.malformed) {
    return malformedResult(lineage.issues, lineage);
  }

  const shapeIssues = validateGateShapes({ sourceGate, profileImpact });
  if (shapeIssues.length > 0) return malformedResult(shapeIssues, lineage);

  const issues = [];
  if (!lineage.valid || !lineage.active) {
    issues.push(issue(
      "invalid_receipt_lineage",
      "Verification acceptance requires one valid append-only receipt lineage.",
    ));
  }
  if (sourceGate.status !== "valid" || sourceGate.exitCode !== 0) {
    issues.push(issue(
      "source_gate_not_valid",
      "Verification acceptance requires a current valid source gate with exit code 0.",
    ));
  }
  if (
    sourceGate.declaredFingerprint.toLowerCase()
    !== sourceGate.recomputedFingerprint.toLowerCase()
  ) {
    issues.push(issue(
      "source_gate_fingerprint_mismatch",
      "The current source gate declared and recomputed fingerprints must match.",
    ));
  }
  if (profileImpact.decision !== "targeted_profiles") {
    issues.push(issue(
      "profile_impact_not_targeted",
      "Verification acceptance requires a targeted_profiles impact decision.",
    ));
  }

  let currentVerificationContextFingerprint = null;
  if (contractVersion === "0.2") {
    if (!isRecord(verificationContext)) {
      issues.push(issue(
        "verification_context_required",
        "Contract v0.2 acceptance requires a recomputable VerificationContextV1.",
      ));
    } else {
      const contextValidation = validateVerificationContext(verificationContext);
      if (!contextValidation.valid) {
        issues.push(...contextValidation.issues.map((message) => issue(
          "invalid_verification_context",
          message,
        )));
      } else {
        currentVerificationContextFingerprint = computeVerificationContextFingerprint(
          verificationContext,
        );
      }
    }
  }

  if (!lineage.active) {
    return {
      valid: false,
      malformed: false,
      accepted: false,
      verificationPassed: false,
      decision: "rejected",
      activeReceiptSha256: null,
      lineage,
      issues,
    };
  }

  const activeReceipt = lineage.active.receipt;
  const receiptShapeIssues = validateActiveReceiptShape(activeReceipt, contractVersion);
  if (receiptShapeIssues.length > 0) {
    return malformedResult(receiptShapeIssues, lineage);
  }
  const commandReceiptShapeIssues = activeReceipt.commandReceipts.flatMap(
    (commandReceipt, index) => validateCommandReceipt(
      commandReceipt,
      index,
      contractVersion,
    ),
  );
  if (commandReceiptShapeIssues.length > 0) {
    return malformedResult(commandReceiptShapeIssues, lineage);
  }
  issues.push(...validateSourceArtifactShape(activeReceipt, sourceGate));

  if (
    activeReceipt.sourceFingerprint.toLowerCase()
    !== sourceGate.recomputedFingerprint.toLowerCase()
  ) {
    issues.push(issue(
      "active_receipt_source_fingerprint_mismatch",
      "The active receipt must bind the current valid source fingerprint.",
    ));
  }
  if (
    contractVersion === "0.2"
    && currentVerificationContextFingerprint !== null
    && activeReceipt.verificationContextFingerprint.toLowerCase()
      !== currentVerificationContextFingerprint.toLowerCase()
  ) {
    issues.push(issue(
      "verification_context_fingerprint_mismatch",
      "The active receipt must bind the current verification context fingerprint.",
    ));
  }
  if (
    activeReceipt.selectedProfileIds.length !== profileImpact.profileIds.length
    || activeReceipt.selectedProfileIds.some(
      (profileId, index) => profileId !== profileImpact.profileIds[index],
    )
  ) {
    issues.push(issue(
      "active_receipt_profile_ids_mismatch",
      "The active receipt must bind exactly the selected profile IDs.",
    ));
  }
  if (activeReceipt.commandRuns !== activeReceipt.commandReceipts.length) {
    issues.push(issue(
      "command_run_count_mismatch",
      "commandRuns must equal the number of commandReceipts.",
    ));
  }

  if (activeReceipt.status === "passed") {
    if (activeReceipt.commandRuns <= 0) {
      issues.push(issue(
        "passed_without_command_run",
        "A passed receipt must bind at least one real command run.",
      ));
    }
    for (const [index, commandReceipt] of activeReceipt.commandReceipts.entries()) {
      if (isRecord(commandReceipt) && commandReceipt.exitCode !== 0) {
        issues.push(issue(
          "nonzero_command_exit",
          "Every command bound by a passed receipt must exit with code 0.",
          { index, exitCode: commandReceipt.exitCode },
        ));
      }
    }
  } else if (DEFERRED_STATUSES.has(activeReceipt.status)) {
    if (activeReceipt.commandRuns !== 0 || activeReceipt.commandReceipts.length !== 0) {
      issues.push(issue(
        "deferred_receipt_has_command_runs",
        "A deferred receipt must not claim command execution.",
      ));
    }
  } else {
    issues.push(issue(
      "unsupported_active_receipt_status",
      "The active receipt status must be passed, shadow_validated, or ready_for_verification.",
      { status: activeReceipt.status },
    ));
  }

  const verificationPassed = activeReceipt.status === "passed"
    && issues.length === 0;
  const deferred = DEFERRED_STATUSES.has(activeReceipt.status)
    && issues.length === 0;

  return {
    contractVersion,
    valid: issues.length === 0,
    malformed: false,
    accepted: verificationPassed,
    verificationPassed,
    decision: verificationPassed
      ? "accepted_passed"
      : deferred
        ? activeReceipt.status
        : "rejected",
    activeReceiptSha256: lineage.active.receiptSha256.toLowerCase(),
    sourceFingerprint: sourceGate.recomputedFingerprint.toLowerCase(),
    verificationContextFingerprint: currentVerificationContextFingerprint,
    selectedProfileIds: [...profileImpact.profileIds],
    lineage,
    issues,
  };
}

export async function runCli(args = process.argv.slice(2)) {
  if (args.length !== 1) {
    return {
      exitCode: 3,
      output: malformedResult([
        issue(
          "usage_error",
          "Usage: verification-receipt-gate.mjs <gate-input.json>",
        ),
      ]),
    };
  }

  let input;
  try {
    input = JSON.parse(await readFile(args[0], "utf8"));
  } catch (error) {
    return {
      exitCode: 3,
      output: malformedResult([issue("input_error", error.message)]),
    };
  }

  if (!isRecord(input)) {
    return {
      exitCode: 3,
      output: malformedResult([
        issue("gate_input_not_object", "Gate input must be an object."),
      ]),
    };
  }

  const output = validateVerificationReceiptGate(input);
  return {
    exitCode: output.malformed ? 3 : output.accepted ? 0 : 2,
    output,
  };
}

if (isDirectExecution(import.meta.url)) {
  const { exitCode, output } = await runCli();
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}
