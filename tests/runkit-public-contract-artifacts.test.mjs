import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { coreManifest } from "../scripts/runkit-contract/core-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const schemaRoot = path.join(root, "scripts/runkit-contract/schemas");
const templateRoot = path.join(root, "scripts/runkit-contract/templates");

const schemas = [
  "assurance-route-v1.schema.json",
  "core-successor-batch-receipt-v1.schema.json",
  "core-successor-plan-v1.schema.json",
  "core-successor-project-success-receipt-v1.schema.json",
  "deployment-execute-request-v1.schema.json",
  "deployment-lineage-v1.schema.json",
  "deployment-prepare-receipt-v1.schema.json",
  "fleet-discovery-v1.schema.json",
  "fleet-manifest-v1.schema.json",
  "fleet-root-registry-v1.schema.json",
  "human-status-v1.schema.json",
  "owner-authority-trust-v1.schema.json",
  "owner-migration-authority-v1.schema.json",
  "owner-migration-authority-v2.schema.json",
  "owner-deployment-authority-v1.schema.json",
  "owner-deployment-authority-v2.schema.json",
  "owner-deployment-decision-v1.schema.json",
  "profile-apply-receipt-v1.schema.json",
  "profile-detection-v2.schema.json",
  "remote-deployment-manifest-v1.schema.json",
  "remote-deployment-result-v1.schema.json",
  "remote-deployment-stage-journal-v1.schema.json",
  "remote-target-v1.schema.json",
  "source-candidate-v2.schema.json",
  "team-project-definition-v1.schema.json",
  "team-project-event-v1.schema.json",
  "team-project-successor-receipt-v1.schema.json",
  "team-project-status-v1.schema.json",
  "verification-envelope-v1.schema.json",
];

const templates = new Map([
  ["assurance-request.json", null],
  ["core-successor-owner-authority.json", "owner-migration-authority-v2.schema.json"],
  ["deployment-execute-request.json", "deployment-execute-request-v1.schema.json"],
  ["deployment-owner-authority.json", "owner-deployment-authority-v2.schema.json"],
  ["deployment-owner-decision.json", "owner-deployment-decision-v1.schema.json"],
  ["fleet-manifest.json", "fleet-manifest-v1.schema.json"],
  ["fleet-root-registry.json", "fleet-root-registry-v1.schema.json"],
  ["owner-authority-trust.json", "owner-authority-trust-v1.schema.json"],
  ["remote-deployment-manifest.json", "remote-deployment-manifest-v1.schema.json"],
  ["team-project-definition.json", "team-project-definition-v1.schema.json"],
  ["team-project-event.json", "team-project-event-v1.schema.json"],
  ["verification-envelope.json", "verification-envelope-v1.schema.json"],
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function resolveRef(schema, ref) {
  assert.match(ref, /^#\/\$defs\/[A-Za-z0-9_-]+$/u);
  return schema.$defs[ref.slice("#/$defs/".length)];
}

function validate(schema, value, rootSchema = schema, location = "$") {
  if (schema.$ref) return validate(resolveRef(rootSchema, schema.$ref), value, rootSchema, location);
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, location);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${location}: enum`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => {
      try {
        validate(candidate, value, rootSchema, location);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(matches.length, 1, `${location}: oneOf`);
    return;
  }
  if (schema.type === "object") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `${location}: object`);
    for (const key of schema.required ?? []) {
      assert.ok(Object.hasOwn(value, key), `${location}: missing ${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${location}: extra ${key}`);
      }
    }
    for (const [key, nested] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) validate(nested, value[key], rootSchema, `${location}.${key}`);
    }
  } else if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${location}: array`);
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${location}: minItems`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${location}: maxItems`);
    if (schema.uniqueItems) assert.equal(new Set(value.map(JSON.stringify)).size, value.length, `${location}: uniqueItems`);
    value.forEach((entry, index) => validate(schema.items, entry, rootSchema, `${location}[${index}]`));
  } else if (schema.type === "string") {
    assert.equal(typeof value, "string", `${location}: string`);
    if (schema.minLength !== undefined) assert.ok(value.length >= schema.minLength, `${location}: minLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern, "u"), location);
  } else if (schema.type === "integer") {
    assert.ok(Number.isInteger(value), `${location}: integer`);
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${location}: minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${location}: maximum`);
  } else if (schema.type === "boolean") {
    assert.equal(typeof value, "boolean", `${location}: boolean`);
  } else if (schema.type === "null") {
    assert.equal(value, null, `${location}: null`);
  }
}

test("daily-use public contracts have strict draft-2020-12 schemas with valid examples", () => {
  for (const ref of schemas) {
    const schema = readJson(path.join(schemaRoot, ref));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", ref);
    assert.equal(schema.type, "object", ref);
    assert.equal(schema.additionalProperties, false, ref);
    assert.ok(Array.isArray(schema.required) && schema.required.includes("schemaVersion"), ref);
    assert.ok(Array.isArray(schema.examples) && schema.examples.length > 0, ref);
    for (const example of schema.examples) validate(schema, example);
  }
});

test("Core manifest distributes the project-level successor success receipt schema", () => {
  assert.ok(coreManifest().files.includes(
    "schemas/core-successor-project-success-receipt-v1.schema.json",
  ));
});

test("Core manifest binds Agent team progress and Verification Envelope contracts", () => {
  const files = coreManifest().files;
  for (const ref of [
    "team-project-successor.mjs",
    "team-project.mjs",
    "verification-envelope.mjs",
    "verification-envelope-check.mjs",
    "schemas/team-project-definition-v1.schema.json",
    "schemas/team-project-event-v1.schema.json",
    "schemas/team-project-successor-receipt-v1.schema.json",
    "schemas/team-project-status-v1.schema.json",
    "schemas/verification-envelope-v1.schema.json",
    "templates/team-project-definition.json",
    "templates/team-project-event.json",
    "templates/verification-envelope.json",
  ]) assert.ok(files.includes(ref), ref);

  const eventSchema = readJson(path.join(schemaRoot, "team-project-event-v1.schema.json"));
  const assignmentRule = eventSchema.allOf.find(row => (
    row.if?.properties?.type?.const === "agent_assigned"
  ));
  assert.deepEqual(assignmentRule.then.required, [
    "assignmentId", "workItemId", "agentId",
  ]);
  assert.deepEqual(assignmentRule.then.dependentRequired, {
    executionRunId: ["executionWorkItemId"],
    executionWorkItemId: ["executionRunId"],
  });
  const deferredRule = eventSchema.allOf.find(row => (
    row.if?.properties?.type?.const === "verification_deferred"
  ));
  assert.deepEqual(deferredRule.then.required, [
    "verificationId",
    "workItemId",
    "ownerAgentId",
    "checkIds",
    "reason",
    "dueGateId",
  ]);
  const closedRule = eventSchema.allOf.find(row => (
    row.if?.properties?.type?.const === "verification_closed"
  ));
  assert.deepEqual(closedRule.then.required, [
    "verificationId",
    "disposition",
    "summary",
    "evidenceRefs",
    "decisionIds",
  ]);
});

test("SourceCandidateV2 schema accepts a real deletion-only frozen payload", () => {
  const schema = readJson(path.join(schemaRoot, "source-candidate-v2.schema.json"));
  const candidate = structuredClone(schema.examples[0]);
  candidate.sourceManifest.entries = [{
    operation: "deleted",
    status: " D",
    path: "src/obsolete.mjs",
  }];
  candidate.payload.blobCount = 0;
  candidate.payload.totalBytes = 0;
  candidate.payload.entries = [];

  validate(schema, candidate);
});

test("operator templates are valid JSON and bind to their public schemas", () => {
  for (const [ref, schemaRef] of templates) {
    const template = readJson(path.join(templateRoot, ref));
    if (Object.hasOwn(template, "authorizationGranted")) {
      assert.equal(template.authorizationGranted, false, ref);
    }
    if (schemaRef) validate(readJson(path.join(schemaRoot, schemaRef)), template);
  }
});
