import { knowledgeAnswerCanonicalJson } from "./answerGroundingV5";
import {
  KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6,
  KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS,
  validateKnowledgeCoverageScopeV6,
  type KnowledgeCoverageEvidenceV6,
  type KnowledgeCoverageScopeV6,
  type KnowledgeCoverageScopeValidationFailureReasonV6
} from "./coverageScopeV6";
import {
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1,
  validateDecodedKnowledgeCoverageScopeCompletenessUnionV1,
  validateKnowledgeCoverageScopeCompletenessV1,
  type KnowledgeCoverageScopeCompletenessValidationFailureReasonV1
} from "./coverageScopeCompletenessV1";

export const KNOWLEDGE_COVERAGE_SCOPE_OPERATION_V7 = "knowledge_coverage_scope_v7" as const;
export const KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_OPERATION_V2 = "knowledge_coverage_scope_completeness_v2" as const;
export const KNOWLEDGE_SCOPE_PENDING_MAX = 8;

type PendingTask = Readonly<{ description: string; requestAnchor: string }>;
export type KnowledgeScopeOverflowV1 = Readonly<{
  pending: readonly (PendingTask & Readonly<{ id: string }>)[];
  unparsedRemainder: boolean;
  version: 1;
}>;
export const KNOWLEDGE_EMPTY_SCOPE_OVERFLOW_V1: KnowledgeScopeOverflowV1 = Object.freeze({
  pending: Object.freeze([]), unparsedRemainder: false, version: 1
});
export type KnowledgeCoverageScopeV7 = Readonly<{
  overflow: KnowledgeScopeOverflowV1;
  scope: KnowledgeCoverageScopeV6["scope"];
  version: 7;
}>;
type ScopeInput = Readonly<{ evidence: readonly KnowledgeCoverageEvidenceV6[]; request: string }>;

const pendingTaskSchema = KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6.properties.unsupportedDimensions.items;
const overflowSchema = Object.freeze({ additionalProperties: false, properties: {
  pending: { items: pendingTaskSchema, maxItems: KNOWLEDGE_SCOPE_PENDING_MAX, minItems: 0, type: "array", uniqueItems: true },
  unparsedRemainder: { type: "boolean" }, version: { const: 1, type: "integer" }
}, required: ["pending", "unparsedRemainder", "version"], type: "object" });

export const KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V7 = Object.freeze({
  ...KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6,
  properties: { ...KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6.properties,
    overflow: overflowSchema, version: { const: 7, type: "integer" } },
  required: [...KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V6.required, "overflow"]
});
export const KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V2 = Object.freeze({
  ...KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1,
  properties: { ...KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1.properties,
    overflow: overflowSchema, version: { const: 2, type: "integer" } },
  required: [...KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V1.required, "overflow"]
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function taskKey(task: PendingTask): string {
  return knowledgeAnswerCanonicalJson([task.requestAnchor.normalize("NFC"), task.description.normalize("NFC")]);
}
function privateText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= 500 && !/\p{Cc}/u.test(value);
}

/** Append-only overflow union. Once the bounded ledger fills, the flag records
 * incomplete request analysis without inventing the number of lost tasks. */
function mergeOverflow(value: unknown, scope: KnowledgeCoverageScopeV6, request: string,
  base: KnowledgeScopeOverflowV1 = KNOWLEDGE_EMPTY_SCOPE_OVERFLOW_V1): KnowledgeScopeOverflowV1 | null {
  if (!record(value) || !exactKeys(value, ["pending", "unparsedRemainder", "version"]) ||
    value.version !== 1 || typeof value.unparsedRemainder !== "boolean" ||
    !Array.isArray(value.pending) || value.pending.length > KNOWLEDGE_SCOPE_PENDING_MAX) return null;
  const known = new Set([...scope.scope, ...base.pending].map(taskKey));
  const additions: PendingTask[] = [];
  for (const item of value.pending) {
    if (!record(item) || !exactKeys(item, ["description", "requestAnchor"]) ||
      !privateText(item.description) || !privateText(item.requestAnchor) || !request.includes(item.requestAnchor)) return null;
    const task = { description: item.description, requestAnchor: item.requestAnchor };
    const key = taskKey(task);
    if (known.has(key)) return null;
    known.add(key);
    additions.push(task);
  }
  if ((base.pending.length > 0 || additions.length > 0) && scope.scope.length < KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) return null;
  additions.sort((left, right) => request.indexOf(left.requestAnchor) - request.indexOf(right.requestAnchor) ||
    (taskKey(left) < taskKey(right) ? -1 : taskKey(left) > taskKey(right) ? 1 : 0));
  const pending = [...base.pending];
  let unparsedRemainder = base.unparsedRemainder || value.unparsedRemainder;
  for (const task of additions) {
    if (pending.length === KNOWLEDGE_SCOPE_PENDING_MAX) { unparsedRemainder = true; continue; }
    pending.push(Object.freeze({ ...task, id: `P${pending.length + 1}` }));
  }
  return Object.freeze({ pending: Object.freeze(pending), unparsedRemainder, version: 1 });
}

export function knowledgeScopeWithoutOverflow(scope: KnowledgeCoverageScopeV6 | KnowledgeCoverageScopeV7): KnowledgeCoverageScopeV6 {
  return scope.version === 6 ? scope : Object.freeze({ scope: scope.scope, version: 6 });
}

export function validateKnowledgeCoverageScopeV7(value: unknown, input: ScopeInput):
  Readonly<{ kind: "accepted"; value: KnowledgeCoverageScopeV7 }> |
  Readonly<{ kind: "rejected"; reason: KnowledgeCoverageScopeValidationFailureReasonV6 }> {
  const rejected = () => Object.freeze({ kind: "rejected" as const, reason: "coverage_scope_shape_invalid" as const });
  if (!record(value) || !exactKeys(value, ["version", "evidenceUnits", "jointFindings", "unsupportedDimensions", "overflow"]) ||
    value.version !== 7) return rejected();
  const { overflow, ...output } = value;
  const validated = validateKnowledgeCoverageScopeV6({ ...output, version: 6 }, { ...input, atomIndexVersion: 3 });
  if (validated.kind === "rejected") return validated;
  const pending = mergeOverflow(overflow, validated.value, input.request);
  return pending ? Object.freeze({ kind: "accepted", value: Object.freeze({ ...validated.value, overflow: pending, version: 7 }) }) : rejected();
}

export function validateDecodedKnowledgeCoverageScopeV7(value: unknown, input: ScopeInput): value is KnowledgeCoverageScopeV7 {
  if (!record(value) || !exactKeys(value, ["scope", "overflow", "version"]) || value.version !== 7 ||
    !validateDecodedKnowledgeCoverageScopeCompletenessUnionV1({ scope: value.scope, version: 6 }, { ...input, atomIndexVersion: 3 }) ||
    !record(value.overflow) || !exactKeys(value.overflow, ["pending", "unparsedRemainder", "version"]) ||
    value.overflow.version !== 1 || typeof value.overflow.unparsedRemainder !== "boolean" ||
    !Array.isArray(value.overflow.pending) || value.overflow.pending.length > KNOWLEDGE_SCOPE_PENDING_MAX) return false;
  const known = new Set((value.scope as KnowledgeCoverageScopeV6["scope"]).map(taskKey));
  return (value.overflow.pending.length === 0 || (value.scope as unknown[]).length === 8) &&
    value.overflow.pending.every((item, index) => {
      if (!record(item) || !exactKeys(item, ["id", "description", "requestAnchor"]) || item.id !== `P${index + 1}` ||
        !privateText(item.description) || !privateText(item.requestAnchor) || !input.request.includes(item.requestAnchor)) return false;
      const key = taskKey({ description: item.description, requestAnchor: item.requestAnchor });
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
}

export function validateKnowledgeCoverageScopeCompletenessV2(value: unknown,
  input: ScopeInput & Readonly<{ acceptedScope: KnowledgeCoverageScopeV7 }>):
  Readonly<{ additionCount: number; kind: "accepted"; scope: KnowledgeCoverageScopeV7 }> |
  Readonly<{ kind: "rejected"; reason: KnowledgeCoverageScopeCompletenessValidationFailureReasonV1 }> {
  const rejected = () => Object.freeze({ kind: "rejected" as const, reason: "coverage_scope_completeness_shape_invalid" as const });
  if (!validateDecodedKnowledgeCoverageScopeV7(input.acceptedScope, input) || !record(value) ||
    !exactKeys(value, ["version", "additions", "overflow"]) || value.version !== 2) return rejected();
  const validated = validateKnowledgeCoverageScopeCompletenessV1({ additions: value.additions, version: 1 }, {
    ...input, acceptedScope: knowledgeScopeWithoutOverflow(input.acceptedScope), atomIndexVersion: 3
  });
  if (validated.kind === "rejected") return validated;
  const overflow = mergeOverflow(value.overflow, validated.scope, input.request, input.acceptedScope.overflow);
  return overflow ? Object.freeze({ additionCount: validated.additionCount, kind: "accepted",
    scope: Object.freeze({ ...validated.scope, overflow, version: 7 }) }) : rejected();
}
