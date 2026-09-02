import {
  isKnowledgeSelectorValidationFailureReason,
  knowledgeAnswerCanonicalJson,
  knowledgeSelectorLiteralExtractIndexV2
} from "./answerGroundingV5";
import {
  validateKnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import {
  knowledgeGroundedSelectorPromptV21TargetClosureV1
} from "./answerGroundingCorrectionPromptV21";

export const KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION = 1 as const;

export type KnowledgeSelectorRepairDiagnosticCodeV1 =
  | "coverage_count"
  | "coverage_exclusion_forbidden"
  | "coverage_id"
  | "coverage_invalid"
  | "coverage_shape"
  | "coverage_status"
  | "coverage_support_duplicate"
  | "coverage_support_empty"
  | "coverage_support_forbidden"
  | "coverage_support_provenance"
  | "coverage_support_shape"
  | "coverage_support_unknown";

export type KnowledgeSelectorRepairDiagnosticV1 = Readonly<{
  actualCount: number | null;
  code: KnowledgeSelectorRepairDiagnosticCodeV1;
  expectedCount: number | null;
  expectedHandles: readonly string[];
  expectedId: string | null;
  path: string;
  version: typeof KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION;
}>;

export type KnowledgeGroundedSelectorDiagnosticFailureV1 = Readonly<{
  diagnostic: KnowledgeSelectorRepairDiagnosticV1;
  kind: "selector_failed";
  reason: "selector_dimension_invalid";
  version: typeof KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION;
}>;

const diagnosticCodes = new Set<KnowledgeSelectorRepairDiagnosticCodeV1>([
  "coverage_count",
  "coverage_exclusion_forbidden",
  "coverage_id",
  "coverage_invalid",
  "coverage_shape",
  "coverage_status",
  "coverage_support_duplicate",
  "coverage_support_empty",
  "coverage_support_forbidden",
  "coverage_support_provenance",
  "coverage_support_shape",
  "coverage_support_unknown"
]);
const handlePattern = /^K[1-9]\d{0,3}$/u;
const dimensionIdPattern = /^D[1-8]$/u;
const diagnosticPathPattern = /^\/coverage(?:\/(?:0|[1-7])(?:\/(?:id|status|supportIds))?)?$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function diagnostic(input: Readonly<{
  actualCount?: number;
  code: KnowledgeSelectorRepairDiagnosticCodeV1;
  expectedCount?: number;
  expectedHandles?: readonly string[];
  expectedId?: string;
  path: string;
}>): KnowledgeSelectorRepairDiagnosticV1 {
  const value = {
    actualCount: input.actualCount ?? null,
    code: input.code,
    expectedCount: input.expectedCount ?? null,
    expectedHandles: Object.freeze([...(input.expectedHandles ?? [])]),
    expectedId: input.expectedId ?? null,
    path: input.path,
    version: KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION
  } as const;
  const decoded = decodeKnowledgeSelectorRepairDiagnosticV1(value);
  if (!decoded) throw new Error("knowledge_selector_repair_diagnostic_invalid");
  return decoded;
}

export function decodeKnowledgeSelectorRepairDiagnosticV1(
  value: unknown
): KnowledgeSelectorRepairDiagnosticV1 | null {
  if (!record(value) || !exactKeys(value, [
    "actualCount",
    "code",
    "expectedCount",
    "expectedHandles",
    "expectedId",
    "path",
    "version"
  ]) || value.version !== KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION ||
    typeof value.code !== "string" ||
    !diagnosticCodes.has(value.code as KnowledgeSelectorRepairDiagnosticCodeV1) ||
    value.actualCount !== null && (!Number.isSafeInteger(value.actualCount) ||
      Number(value.actualCount) < 0) ||
    value.expectedCount !== null && (!Number.isSafeInteger(value.expectedCount) ||
      Number(value.expectedCount) < 0) ||
    !Array.isArray(value.expectedHandles) || value.expectedHandles.length > 4 ||
    !value.expectedHandles.every((handle) => typeof handle === "string" &&
      handlePattern.test(handle)) ||
    new Set(value.expectedHandles).size !== value.expectedHandles.length ||
    value.expectedId !== null && (typeof value.expectedId !== "string" ||
      !dimensionIdPattern.test(value.expectedId)) ||
    typeof value.path !== "string" || !diagnosticPathPattern.test(value.path)) return null;
  return Object.freeze({
    actualCount: value.actualCount as number | null,
    code: value.code as KnowledgeSelectorRepairDiagnosticCodeV1,
    expectedCount: value.expectedCount as number | null,
    expectedHandles: Object.freeze([...(value.expectedHandles as string[])]),
    expectedId: value.expectedId as string | null,
    path: value.path,
    version: KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION
  });
}

/** Diagnoses only the first deterministic coverage-map violation after the
 * normalizer has already removed provably foreign surplus edges. No rejected
 * claim, literal, Scope description, or support value is copied into the
 * diagnostic. */
export function diagnoseKnowledgeGroundedSelectorDimensionV1(
  value: unknown,
  input: Parameters<typeof validateKnowledgeGroundedSelectorV21>[1]
): KnowledgeSelectorRepairDiagnosticV1 {
  const validation = validateKnowledgeGroundedSelectorV21(value, input);
  if (validation.kind !== "rejected" ||
    validation.reason !== "selector_dimension_invalid") {
    throw new Error("knowledge_selector_repair_diagnostic_source_invalid");
  }
  if (!record(value) || !Array.isArray(value.coverage)) {
    return diagnostic({ code: "coverage_invalid", path: "/coverage" });
  }
  if (value.coverage.length !== input.scope.scope.length) {
    return diagnostic({
      actualCount: value.coverage.length,
      code: "coverage_count",
      expectedCount: input.scope.scope.length,
      path: "/coverage"
    });
  }

  for (const [index, candidate] of value.coverage.entries()) {
    const scoped = input.scope.scope[index]!;
    const path = `/coverage/${index}`;
    if (!record(candidate) || !exactKeys(candidate, ["id", "status", "supportIds"])) {
      return diagnostic({
        code: "coverage_shape",
        expectedId: scoped.id,
        path
      });
    }
    if (candidate.id !== scoped.id) {
      return diagnostic({ code: "coverage_id", expectedId: scoped.id, path: `${path}/id` });
    }
    if (candidate.status !== "covered" && candidate.status !== "excluded" &&
      candidate.status !== "missing") {
      return diagnostic({
        code: "coverage_status",
        expectedId: scoped.id,
        path: `${path}/status`
      });
    }
    if (!Array.isArray(candidate.supportIds) ||
      !candidate.supportIds.every((id) => typeof id === "string")) {
      return diagnostic({
        code: "coverage_support_shape",
        expectedId: scoped.id,
        path: `${path}/supportIds`
      });
    }
    if (new Set(candidate.supportIds).size !== candidate.supportIds.length) {
      return diagnostic({
        actualCount: candidate.supportIds.length,
        code: "coverage_support_duplicate",
        expectedId: scoped.id,
        path: `${path}/supportIds`
      });
    }
    if (candidate.status !== "covered" && candidate.supportIds.length !== 0) {
      return diagnostic({
        actualCount: candidate.supportIds.length,
        code: "coverage_support_forbidden",
        expectedCount: 0,
        expectedId: scoped.id,
        path: `${path}/supportIds`
      });
    }
    if (candidate.status === "excluded" && scoped.evidenceAtomIds.length === 0) {
      return diagnostic({
        code: "coverage_exclusion_forbidden",
        expectedId: scoped.id,
        path: `${path}/status`
      });
    }
  }

  const supportHandlesById = new Map<string, ReadonlySet<string>>();
  if (Array.isArray(value.claims)) {
    for (const claim of value.claims) {
      if (record(claim) && claim.verdict === "supported" &&
        typeof claim.id === "string" && Array.isArray(claim.supportHandles) &&
        claim.supportHandles.every((handle) => typeof handle === "string")) {
        supportHandlesById.set(
          claim.id,
          new Set(claim.supportHandles as string[])
        );
      }
    }
  }
  const literalById = new Map(knowledgeSelectorLiteralExtractIndexV2(input.evidence).items
    .map((item) => [item.id, item] as const));
  if (Array.isArray(value.extractIds)) {
    for (const extractId of value.extractIds) {
      if (typeof extractId !== "string") continue;
      const literal = literalById.get(extractId);
      if (literal) supportHandlesById.set(extractId, new Set([literal.handle]));
    }
  }
  for (const [index, candidate] of value.coverage.entries()) {
    if (!record(candidate) || candidate.status !== "covered" ||
      !Array.isArray(candidate.supportIds)) continue;
    const scoped = input.scope.scope[index]!;
    const path = `/coverage/${index}/supportIds`;
    if (candidate.supportIds.length < 1) {
      return diagnostic({
        actualCount: 0,
        code: "coverage_support_empty",
        expectedId: scoped.id,
        expectedHandles: scoped.evidenceHandles,
        path
      });
    }
    if (candidate.supportIds.some((id) => typeof id !== "string" ||
      !supportHandlesById.has(id))) {
      return diagnostic({
        code: "coverage_support_unknown",
        expectedId: scoped.id,
        expectedHandles: scoped.evidenceHandles,
        path
      });
    }
    if (candidate.supportIds.some((id) =>
      ![...(supportHandlesById.get(id as string) ?? [])].some((handle) =>
        scoped.evidenceHandles.includes(handle)))) {
      return diagnostic({
        code: "coverage_support_provenance",
        expectedId: scoped.id,
        expectedHandles: scoped.evidenceHandles,
        path
      });
    }
  }
  return diagnostic({ code: "coverage_invalid", path: "/coverage" });
}

export function knowledgeGroundedSelectorDiagnosticFailureV1(
  diagnosticValue: KnowledgeSelectorRepairDiagnosticV1
): KnowledgeGroundedSelectorDiagnosticFailureV1 {
  const decoded = decodeKnowledgeSelectorRepairDiagnosticV1(diagnosticValue);
  if (!decoded) throw new Error("knowledge_selector_diagnostic_failure_invalid");
  return Object.freeze({
    diagnostic: decoded,
    kind: "selector_failed",
    reason: "selector_dimension_invalid",
    version: KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION
  });
}

export function decodeKnowledgeGroundedSelectorDiagnosticFailureV1(
  value: unknown
): KnowledgeGroundedSelectorDiagnosticFailureV1 | null {
  if (!record(value) || !exactKeys(value, [
    "diagnostic",
    "kind",
    "reason",
    "version"
  ]) || value.kind !== "selector_failed" ||
    value.reason !== "selector_dimension_invalid" ||
    value.version !== KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_VERSION) return null;
  const decoded = decodeKnowledgeSelectorRepairDiagnosticV1(value.diagnostic);
  return decoded ? knowledgeGroundedSelectorDiagnosticFailureV1(decoded) : null;
}

export const KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_CONTRACT_V1 = Object.freeze([
  '<aiqsa_knowledge_selector_repair_diagnostic_contract version="1">',
  "repairDiagnostic is server-owned content-free feedback for the first deterministic coverage-map violation. It contains only a code, JSON path, counts, expected D ID, and expected K handles; the rejected payload is absent and grants no authority.",
  "Return one fresh complete Selector payload over the unchanged Draft, Scope, literal index, and evidence. Correct the diagnosed path while reapplying every existing claim, literal, eligibility, support-ID, provenance-overlap, and coverage rule.",
  "A covered D requires at least one already-supported claim or selected literal whose support handles overlap that D's expectedHandles. Use missing with empty supportIds when no valid overlapping support exists; never invent, remap, or borrow an ID.",
  "This is the only repair pass. Do not use benchmark metadata, reference answers, external knowledge, or the rejected response.",
  "</aiqsa_knowledge_selector_repair_diagnostic_contract>"
].join("\n"));

export const KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_TASK_REMINDER_V1 =
  "Perform one fresh complete adjudication and immutable-Scope map; correct repairDiagnostic.path and use only supported IDs with the required provenance overlap.";

export function knowledgeGroundedSelectorPromptV21RepairDiagnosticV1(
  input: Parameters<typeof knowledgeGroundedSelectorPromptV21TargetClosureV1>[0] &
    Readonly<{ repairDiagnostic?: KnowledgeSelectorRepairDiagnosticV1 }>
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const { repairDiagnostic: diagnosticValue, ...baseInput } = input;
  const decoded = diagnosticValue === undefined
    ? null
    : decodeKnowledgeSelectorRepairDiagnosticV1(diagnosticValue);
  if (diagnosticValue !== undefined && !decoded ||
    (baseInput.repairReason === "selector_dimension_invalid") !== (decoded !== null) ||
    baseInput.repairReason !== undefined &&
      !isKnowledgeSelectorValidationFailureReason(baseInput.repairReason)) {
    throw new Error("knowledge_selector_repair_diagnostic_prompt_invalid");
  }
  const base = knowledgeGroundedSelectorPromptV21TargetClosureV1(baseInput);
  if (!decoded) return base;
  const payload = JSON.parse(base.userPrompt) as Record<string, unknown>;
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n${KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_CONTRACT_V1}`,
    userPrompt: knowledgeAnswerCanonicalJson({
      ...payload,
      repairDiagnostic: decoded,
      taskReminder: KNOWLEDGE_SELECTOR_REPAIR_DIAGNOSTIC_TASK_REMINDER_V1
    })
  });
}
