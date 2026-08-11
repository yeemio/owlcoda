import {
  RUNTIME_ROOT,
  acceptedCloseoutVerificationIssues,
  currentCoreIdentity,
  validateCoreArtifact,
  validateExecutionPin,
  validateLeaseOwnedPaths,
} from "./core-contract.mjs";
import { parseProjectControlState } from "./project-control-parser.mjs";

const PARSER_CONTRACT = Object.freeze({
  runtimeRoot: RUNTIME_ROOT,
  acceptedCloseoutVerificationIssues,
  validateCoreArtifact,
  validateExecutionPin,
  validateLeaseOwnedPaths,
});

export function inspectProjectControlState({
  workspaceRoot,
  currentCore = currentCoreIdentity(),
} = {}) {
  return parseProjectControlState({
    workspaceRoot,
    currentCore,
    contract: PARSER_CONTRACT,
  });
}
