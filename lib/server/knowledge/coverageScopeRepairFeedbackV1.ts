import {
  knowledgeAnswerCanonicalJson,
  knowledgeAnswerHash
} from "./answerGroundingV5";
import {
  knowledgeCoverageEvidenceAtomIndex,
  knowledgeCoverageEvidenceContextV1,
  type KnowledgeCoverageEvidenceAtomIndexVersion
} from "./coverageScopeV4";
import { knowledgeCoverageEvidenceUnitIndex } from "./coverageScopeV5";
import {
  KNOWLEDGE_COVERAGE_SCOPE_CONTRACT_V6,
  KNOWLEDGE_COVERAGE_SCOPE_REPAIR_TASK_REMINDER_V6,
  KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6,
  KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS,
  KNOWLEDGE_COVERAGE_SCOPE_V6_PAYLOAD_VERSION,
  decodeKnowledgeCoverageScopeFailureV6,
  isKnowledgeCoverageScopeValidationFailureReasonV6,
  validateKnowledgeCoverageScopeV6,
  type KnowledgeCoverageEvidenceV6,
  type KnowledgeCoverageScopeFailureReasonV6,
  type KnowledgeCoverageScopeV6,
  type KnowledgeCoverageScopeValidationFailureReasonV6
} from "./coverageScopeV6";

export const KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION = 1 as const;

export type KnowledgeCoverageScopeRepairDiagnosticCodeV1 =
  | "anchor_invalid"
  | "atom_count"
  | "atom_duplicate"
  | "atom_id_invalid"
  | "description_duplicate"
  | "description_invalid"
  | "dimension_count"
  | "finding_atom_provenance"
  | "finding_shape"
  | "joint_handle_count"
  | "payload_shape"
  | "unit_map_count"
  | "unit_map_duplicate_handle"
  | "unit_map_handle"
  | "unit_map_key_set"
  | "unit_map_shape"
  | "unsupported_shape";

export type KnowledgeCoverageScopeRepairDiagnosticV1 = Readonly<{
  actualCount: number | null;
  code: KnowledgeCoverageScopeRepairDiagnosticCodeV1;
  expectedHandle: string | null;
  maximumCount: number | null;
  path: string;
  version: typeof KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION;
}>;

export type KnowledgeCoverageScopeRepairFeedbackFailureV1 = Readonly<{
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1 | null;
  kind: "coverage_scope_failed";
  reason: KnowledgeCoverageScopeFailureReasonV6;
}>;

export type KnowledgeCoverageScopeRepairFeedbackValidationV1 =
  | Readonly<{ kind: "accepted"; value: KnowledgeCoverageScopeV6 }>
  | Readonly<{
      diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1;
      kind: "rejected";
      reason: KnowledgeCoverageScopeValidationFailureReasonV6;
    }>;

const diagnosticCodes = new Set<KnowledgeCoverageScopeRepairDiagnosticCodeV1>([
  "anchor_invalid",
  "atom_count",
  "atom_duplicate",
  "atom_id_invalid",
  "description_duplicate",
  "description_invalid",
  "dimension_count",
  "finding_atom_provenance",
  "finding_shape",
  "joint_handle_count",
  "payload_shape",
  "unit_map_count",
  "unit_map_duplicate_handle",
  "unit_map_handle",
  "unit_map_key_set",
  "unit_map_shape",
  "unsupported_shape"
]);
const handlePattern = /^K[1-9]\d{0,3}$/u;
const atomIdPattern = /^A[1-9]\d{0,3}$/u;
const controlCharacterPattern = /\p{Cc}/u;
const diagnosticIndexPattern = /^(?:0|[1-9]\d{0,3})$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validPrivateText(value: unknown, maximumCodePoints: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    [...value].length <= maximumCodePoints && !controlCharacterPattern.test(value);
}

function validDiagnosticPath(value: string): boolean {
  if (value === "/") return true;
  const segments = value.slice(1).split("/");
  if (segments[0] === "version") return segments.length === 1;
  if (segments[0] === "evidenceUnits") {
    if (segments.length === 1) return true;
    if (!diagnosticIndexPattern.test(segments[1]!)) return false;
    if (segments.length === 2) return true;
    if (segments[2] === "handle") return segments.length === 3;
    if (segments[2] !== "findings") return false;
    if (segments.length === 3) return true;
    if (!diagnosticIndexPattern.test(segments[3]!)) return false;
    return segments.length === 4 || segments.length === 5 &&
      ["description", "requestAnchor", "evidenceAtomIds"].includes(segments[4]!);
  }
  if (segments[0] === "jointFindings") {
    if (segments.length === 1) return true;
    if (!diagnosticIndexPattern.test(segments[1]!)) return false;
    return segments.length === 2 || segments.length === 3 &&
      ["description", "requestAnchor", "evidenceAtomIds"].includes(segments[2]!);
  }
  if (segments[0] === "unsupportedDimensions") {
    if (segments.length === 1) return true;
    if (!diagnosticIndexPattern.test(segments[1]!)) return false;
    return segments.length === 2 || segments.length === 3 &&
      ["description", "requestAnchor"].includes(segments[2]!);
  }
  return false;
}

function diagnostic(input: Readonly<{
  actualCount?: number;
  code: KnowledgeCoverageScopeRepairDiagnosticCodeV1;
  expectedHandle?: string;
  maximumCount?: number;
  path: string;
}>): KnowledgeCoverageScopeRepairDiagnosticV1 {
  return Object.freeze({
    actualCount: input.actualCount ?? null,
    code: input.code,
    expectedHandle: input.expectedHandle ?? null,
    maximumCount: input.maximumCount ?? null,
    path: input.path,
    version: KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION
  });
}

function diagnoseKnowledgeCoverageScopeV6(
  value: unknown,
  input: Readonly<{
    atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
    evidence: readonly KnowledgeCoverageEvidenceV6[];
    request: string;
  }>
): KnowledgeCoverageScopeRepairDiagnosticV1 {
  if (!record(value) || !exactKeys(value, [
    "version",
    "evidenceUnits",
    "jointFindings",
    "unsupportedDimensions"
  ]) || value.version !== KNOWLEDGE_COVERAGE_SCOPE_V6_PAYLOAD_VERSION ||
    !Array.isArray(value.evidenceUnits) || !Array.isArray(value.jointFindings) ||
    !Array.isArray(value.unsupportedDimensions)) {
    return diagnostic({ code: "payload_shape", path: "/" });
  }
  let unitIndex: ReturnType<typeof knowledgeCoverageEvidenceUnitIndex>;
  let atomIndex: ReturnType<typeof knowledgeCoverageEvidenceAtomIndex>;
  try {
    const atomIndexVersion = input.atomIndexVersion ?? 1;
    unitIndex = knowledgeCoverageEvidenceUnitIndex(input.evidence, atomIndexVersion);
    atomIndex = knowledgeCoverageEvidenceAtomIndex(input.evidence, atomIndexVersion);
  } catch {
    return diagnostic({ code: "payload_shape", path: "/" });
  }
  if (value.evidenceUnits.length !== unitIndex.units.length) {
    return diagnostic({
      actualCount: value.evidenceUnits.length,
      code: "unit_map_count",
      maximumCount: unitIndex.units.length,
      path: "/evidenceUnits"
    });
  }
  if (value.jointFindings.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) {
    return diagnostic({
      actualCount: value.jointFindings.length,
      code: "dimension_count",
      maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
      path: "/jointFindings"
    });
  }
  if (value.unsupportedDimensions.length >
    KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) {
    return diagnostic({
      actualCount: value.unsupportedDimensions.length,
      code: "dimension_count",
      maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
      path: "/unsupportedDimensions"
    });
  }

  const suppliedUnits = new Map<string, Readonly<{
    findings: readonly unknown[];
    index: number;
  }>>();
  for (const [index, candidate] of value.evidenceUnits.entries()) {
    if (!record(candidate) || !exactKeys(candidate, ["handle", "findings"]) ||
      !Array.isArray(candidate.findings)) {
      return diagnostic({ code: "unit_map_shape", path: `/evidenceUnits/${index}` });
    }
    if (typeof candidate.handle !== "string" || !handlePattern.test(candidate.handle)) {
      return diagnostic({ code: "unit_map_handle", path: `/evidenceUnits/${index}/handle` });
    }
    if (candidate.findings.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) {
      return diagnostic({
        actualCount: candidate.findings.length,
        code: "dimension_count",
        maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
        path: `/evidenceUnits/${index}/findings`
      });
    }
    if (suppliedUnits.has(candidate.handle)) {
      return diagnostic({
        code: "unit_map_duplicate_handle",
        expectedHandle: candidate.handle,
        path: `/evidenceUnits/${index}/handle`
      });
    }
    suppliedUnits.set(candidate.handle, Object.freeze({
      findings: candidate.findings,
      index
    }));
  }
  const missingUnit = unitIndex.units.find(({ handle }) => !suppliedUnits.has(handle));
  if (suppliedUnits.size !== unitIndex.units.length || missingUnit) {
    return diagnostic({
      code: "unit_map_key_set",
      ...(missingUnit ? { expectedHandle: missingUnit.handle } : {}),
      path: "/evidenceUnits"
    });
  }

  const atomById = new Map(atomIndex.items.map((atom) => [atom.id, atom] as const));
  const descriptions = new Set<string>();
  let dimensionCount = 0;
  const inspectText = (
    candidate: Record<string, unknown>,
    path: string
  ): KnowledgeCoverageScopeRepairDiagnosticV1 | null => {
    if (!validPrivateText(
      candidate.description,
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDescriptionCodePoints
    )) return diagnostic({ code: "description_invalid", path: `${path}/description` });
    const descriptionKey = candidate.description.normalize("NFC");
    if (descriptions.has(descriptionKey)) {
      return diagnostic({ code: "description_duplicate", path: `${path}/description` });
    }
    if (!validPrivateText(
      candidate.requestAnchor,
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints
    ) || !input.request.includes(candidate.requestAnchor)) {
      return diagnostic({ code: "anchor_invalid", path: `${path}/requestAnchor` });
    }
    descriptions.add(descriptionKey);
    return null;
  };
  const inspectFinding = (
    candidate: unknown,
    expectedHandle: string | null,
    path: string
  ): KnowledgeCoverageScopeRepairDiagnosticV1 | null => {
    if (!record(candidate) || !exactKeys(candidate, [
      "description",
      "requestAnchor",
      "evidenceAtomIds"
    ]) || !Array.isArray(candidate.evidenceAtomIds)) {
      return diagnostic({ code: "finding_shape", path });
    }
    const textDiagnostic = inspectText(candidate, path);
    if (textDiagnostic) return textDiagnostic;
    if (candidate.evidenceAtomIds.length < 1 || candidate.evidenceAtomIds.length >
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAtomsPerDimension) {
      return diagnostic({
        actualCount: candidate.evidenceAtomIds.length,
        code: "atom_count",
        maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAtomsPerDimension,
        path: `${path}/evidenceAtomIds`
      });
    }
    if (!candidate.evidenceAtomIds.every((id): id is string =>
      typeof id === "string" && atomIdPattern.test(id) && atomById.has(id))) {
      return diagnostic({ code: "atom_id_invalid", path: `${path}/evidenceAtomIds` });
    }
    if (new Set(candidate.evidenceAtomIds).size !== candidate.evidenceAtomIds.length) {
      return diagnostic({ code: "atom_duplicate", path: `${path}/evidenceAtomIds` });
    }
    const handles = [...new Set(candidate.evidenceAtomIds.map((id) =>
      atomById.get(id)!.handle))];
    if (expectedHandle !== null &&
      (handles.length !== 1 || handles[0] !== expectedHandle)) {
      return diagnostic({
        actualCount: handles.length,
        code: "finding_atom_provenance",
        expectedHandle,
        maximumCount: 1,
        path: `${path}/evidenceAtomIds`
      });
    }
    if (expectedHandle === null && (handles.length < 2 ||
      handles.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceHandles)) {
      return diagnostic({
        actualCount: handles.length,
        code: "joint_handle_count",
        maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceHandles,
        path: `${path}/evidenceAtomIds`
      });
    }
    dimensionCount += 1;
    return null;
  };

  for (const unit of unitIndex.units) {
    const suppliedUnit = suppliedUnits.get(unit.handle)!;
    for (const [findingIndex, finding] of suppliedUnit.findings.entries()) {
      const findingDiagnostic = inspectFinding(
        finding,
        unit.handle,
        `/evidenceUnits/${suppliedUnit.index}/findings/${findingIndex}`
      );
      if (findingDiagnostic) return findingDiagnostic;
    }
  }
  for (const [index, finding] of value.jointFindings.entries()) {
    const findingDiagnostic = inspectFinding(finding, null, `/jointFindings/${index}`);
    if (findingDiagnostic) return findingDiagnostic;
  }
  for (const [index, candidate] of value.unsupportedDimensions.entries()) {
    const path = `/unsupportedDimensions/${index}`;
    if (!record(candidate) || !exactKeys(candidate, ["description", "requestAnchor"])) {
      return diagnostic({ code: "unsupported_shape", path });
    }
    const textDiagnostic = inspectText(candidate, path);
    if (textDiagnostic) return textDiagnostic;
    dimensionCount += 1;
  }
  if (dimensionCount < 1 ||
    dimensionCount > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) {
    return diagnostic({
      actualCount: dimensionCount,
      code: "dimension_count",
      maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
      path: "/"
    });
  }
  return diagnostic({ code: "payload_shape", path: "/" });
}

export function decodeKnowledgeCoverageScopeRepairDiagnosticV1(
  value: unknown
): KnowledgeCoverageScopeRepairDiagnosticV1 | null {
  if (!record(value) || !exactKeys(value, [
    "actualCount",
    "code",
    "expectedHandle",
    "maximumCount",
    "path",
    "version"
  ]) || value.version !== KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION ||
    typeof value.code !== "string" ||
    !diagnosticCodes.has(value.code as KnowledgeCoverageScopeRepairDiagnosticCodeV1) ||
    value.actualCount !== null && (!Number.isSafeInteger(value.actualCount) ||
      (value.actualCount as number) < 0) ||
    value.maximumCount !== null && (!Number.isSafeInteger(value.maximumCount) ||
      (value.maximumCount as number) < 0) ||
    value.expectedHandle !== null && (typeof value.expectedHandle !== "string" ||
      !handlePattern.test(value.expectedHandle)) ||
    typeof value.path !== "string" || !validDiagnosticPath(value.path)) return null;
  return Object.freeze({
    actualCount: value.actualCount as number | null,
    code: value.code as KnowledgeCoverageScopeRepairDiagnosticCodeV1,
    expectedHandle: value.expectedHandle as string | null,
    maximumCount: value.maximumCount as number | null,
    path: value.path,
    version: KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION
  });
}

export function validateKnowledgeCoverageScopeV6RepairFeedbackV1(
  value: unknown,
  input: Readonly<{
    atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
    evidence: readonly KnowledgeCoverageEvidenceV6[];
    request: string;
  }>
): KnowledgeCoverageScopeRepairFeedbackValidationV1 {
  const validation = validateKnowledgeCoverageScopeV6(value, input);
  if (validation.kind === "accepted") return validation;
  return Object.freeze({
    diagnostic: diagnoseKnowledgeCoverageScopeV6(value, input),
    kind: "rejected",
    reason: validation.reason
  });
}

export function knowledgeCoverageScopeRepairFeedbackFailureV1(
  reason: KnowledgeCoverageScopeFailureReasonV6,
  diagnosticValue: KnowledgeCoverageScopeRepairDiagnosticV1 | null = null
): KnowledgeCoverageScopeRepairFeedbackFailureV1 {
  const baseFailure = decodeKnowledgeCoverageScopeFailureV6({
    kind: "coverage_scope_failed",
    reason
  });
  const decodedDiagnostic = diagnosticValue === null
    ? null
    : decodeKnowledgeCoverageScopeRepairDiagnosticV1(diagnosticValue);
  if (!baseFailure || diagnosticValue !== null && !decodedDiagnostic ||
    isKnowledgeCoverageScopeValidationFailureReasonV6(reason) !==
      (decodedDiagnostic !== null)) {
    throw new Error("knowledge_coverage_scope_repair_feedback_failure_invalid");
  }
  return Object.freeze({
    diagnostic: decodedDiagnostic,
    kind: baseFailure.kind,
    reason: baseFailure.reason
  });
}

export function decodeKnowledgeCoverageScopeRepairFeedbackFailureV1(
  value: unknown
): KnowledgeCoverageScopeRepairFeedbackFailureV1 | null {
  if (!record(value) || !exactKeys(value, ["diagnostic", "kind", "reason"])) return null;
  const baseFailure = decodeKnowledgeCoverageScopeFailureV6({
    kind: value.kind,
    reason: value.reason
  });
  const decodedDiagnostic = value.diagnostic === null
    ? null
    : decodeKnowledgeCoverageScopeRepairDiagnosticV1(value.diagnostic);
  if (!baseFailure || value.diagnostic !== null && !decodedDiagnostic ||
    isKnowledgeCoverageScopeValidationFailureReasonV6(baseFailure.reason) !==
      (decodedDiagnostic !== null)) return null;
  return Object.freeze({
    diagnostic: decodedDiagnostic,
    kind: baseFailure.kind,
    reason: baseFailure.reason
  });
}

export const KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1 = [
  KNOWLEDGE_COVERAGE_SCOPE_CONTRACT_V6,
  '<aiqsa_knowledge_coverage_scope_repair_feedback_contract version="1">',
  "validationLimits is authoritative machine-readable structure. maxTotalDimensions applies to the sum of every unit finding, joint finding, and unsupported dimension, not to each array independently.",
  "A local finding may cite atoms from exactly its own K handle. Put an inseparable cross-K conclusion in jointFindings; never move foreign atoms into a local finding.",
  "On repair, repairDiagnostic identifies the first structural violation by code and JSON path. It contains no evidence or prior output content. Return one fresh complete payload over the unchanged evidence index; do not quote, continue, or otherwise rely on the rejected payload.",
  "Do not truncate, merge, or discard a distinct requested finding merely to satisfy a count. Produce a valid bounded semantic decomposition under the unchanged Scope V6 contract.",
  "</aiqsa_knowledge_coverage_scope_repair_feedback_contract>"
].join("\n");

function validationLimits(
  evidence: readonly KnowledgeCoverageEvidenceV6[]
): Readonly<Record<string, number | string>> {
  return Object.freeze({
    localFindingEvidenceHandles: "exactly_one_matching_unit",
    maxAtomsPerFinding: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAtomsPerDimension,
    maxFindingsPerUnit: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
    maxJointFindingEvidenceHandles: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceHandles,
    maxJointFindings: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
    maxTotalDimensions: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
    maxUnsupportedDimensions: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
    minJointFindingEvidenceHandles: 2,
    requiredEvidenceUnitCount: evidence.length
  });
}

export function knowledgeCoverageScopePromptV6RepairFeedbackV1(input: Readonly<{
  atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  evidenceManifest: string;
  repairDiagnostic?: KnowledgeCoverageScopeRepairDiagnosticV1;
  repairReason?: KnowledgeCoverageScopeValidationFailureReasonV6;
  request: string;
  scopePass: "initial" | "repair";
}>): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const rawInput = input as unknown;
  const hasRepair = input.repairReason !== undefined || input.repairDiagnostic !== undefined;
  const expectedKeys = [
    "evidence",
    "evidenceManifest",
    ...(input.atomIndexVersion === undefined ? [] : ["atomIndexVersion"]),
    ...(hasRepair ? ["repairDiagnostic", "repairReason"] : []),
    "request",
    "scopePass"
  ];
  const decodedDiagnostic = input.repairDiagnostic === undefined
    ? null
    : decodeKnowledgeCoverageScopeRepairDiagnosticV1(input.repairDiagnostic);
  if (!record(rawInput) || !exactKeys(rawInput, expectedKeys) ||
    input.scopePass !== "initial" && input.scopePass !== "repair" ||
    (input.scopePass === "repair") !== hasRepair ||
    hasRepair && (!decodedDiagnostic ||
      !isKnowledgeCoverageScopeValidationFailureReasonV6(input.repairReason)) ||
    !input.request.trim() || !input.evidenceManifest.trim() || input.evidence.length < 1 ||
    input.evidence.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceItems ||
    new Set(input.evidence.map(({ handle }) => handle)).size !== input.evidence.length ||
    input.evidence.some(({ handle }) => !handlePattern.test(handle))) {
    throw new Error("knowledge_coverage_scope_repair_feedback_v1_prompt_invalid");
  }
  return Object.freeze({
    systemPrompt: input.atomIndexVersion === 2
      ? `${KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1}\n\n` +
        KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
      : KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1,
    userPrompt: knowledgeAnswerCanonicalJson({
      ...(input.atomIndexVersion === 2
        ? { atomProjection: "source_ordered_context_v2" as const }
        : {}),
      evidenceContext: knowledgeCoverageEvidenceContextV1(input.evidence),
      evidenceManifestHash: knowledgeAnswerHash(input.evidenceManifest),
      evidenceUnitIndex: knowledgeCoverageEvidenceUnitIndex(
        input.evidence,
        input.atomIndexVersion ?? 1
      ),
      payloadVersion: KNOWLEDGE_COVERAGE_SCOPE_V6_PAYLOAD_VERSION,
      repairDiagnostic: decodedDiagnostic,
      repairFeedbackVersion: KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION,
      repairReason: input.repairReason ?? null,
      request: input.request,
      scopePass: input.scopePass,
      taskReminder: input.scopePass === "repair"
        ? KNOWLEDGE_COVERAGE_SCOPE_REPAIR_TASK_REMINDER_V6
        : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6,
      validationLimits: validationLimits(input.evidence)
    })
  });
}

export function decodeKnowledgeCoverageScopePromptV6RepairFeedbackV1(input: Readonly<{
  atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  evidenceManifest: string;
  request: string;
  systemPrompt: string;
  userPrompt: string;
}>): Readonly<{
  repairDiagnostic: KnowledgeCoverageScopeRepairDiagnosticV1 | null;
  repairReason: KnowledgeCoverageScopeValidationFailureReasonV6 | null;
  scopePass: "initial" | "repair";
}> | null {
  const atomIndexVersion = input.atomIndexVersion ?? 1;
  const expectedSystemPrompt = atomIndexVersion === 2
    ? `${KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1}\n\n` +
      KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
    : KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1;
  if (input.systemPrompt !== expectedSystemPrompt) return null;
  let value: unknown;
  try {
    value = JSON.parse(input.userPrompt) as unknown;
  } catch {
    return null;
  }
  if (!record(value) || !exactKeys(value, [
    ...(atomIndexVersion === 2 ? ["atomProjection"] : []),
    "evidenceContext",
    "evidenceManifestHash",
    "evidenceUnitIndex",
    "payloadVersion",
    "repairDiagnostic",
    "repairFeedbackVersion",
    "repairReason",
    "request",
    "scopePass",
    "taskReminder",
    "validationLimits"
  ]) || value.scopePass !== "initial" && value.scopePass !== "repair" ||
    (atomIndexVersion === 2) !==
      (value.atomProjection === "source_ordered_context_v2") ||
    value.payloadVersion !== KNOWLEDGE_COVERAGE_SCOPE_V6_PAYLOAD_VERSION ||
    value.repairFeedbackVersion !== KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION ||
    value.evidenceManifestHash !== knowledgeAnswerHash(input.evidenceManifest) ||
    value.request !== input.request ||
    knowledgeAnswerCanonicalJson(value.evidenceContext) !== knowledgeAnswerCanonicalJson(
      knowledgeCoverageEvidenceContextV1(input.evidence)
    ) || knowledgeAnswerCanonicalJson(value.evidenceUnitIndex) !== knowledgeAnswerCanonicalJson(
      knowledgeCoverageEvidenceUnitIndex(input.evidence, atomIndexVersion)
    ) || knowledgeAnswerCanonicalJson(value.validationLimits) !== knowledgeAnswerCanonicalJson(
      validationLimits(input.evidence)
    )) return null;
  const decodedDiagnostic = value.repairDiagnostic === null
    ? null
    : decodeKnowledgeCoverageScopeRepairDiagnosticV1(value.repairDiagnostic);
  if (value.repairDiagnostic !== null && !decodedDiagnostic ||
    (value.scopePass === "repair") !== (decodedDiagnostic !== null) ||
    (value.scopePass === "repair") !==
      isKnowledgeCoverageScopeValidationFailureReasonV6(value.repairReason) ||
    value.scopePass === "initial" && value.repairReason !== null ||
    value.taskReminder !== (value.scopePass === "repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_REPAIR_TASK_REMINDER_V6
      : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6) ||
    knowledgeAnswerCanonicalJson(value) !== input.userPrompt) return null;
  return Object.freeze({
    repairDiagnostic: decodedDiagnostic,
    repairReason:
      value.repairReason as KnowledgeCoverageScopeValidationFailureReasonV6 | null,
    scopePass: value.scopePass
  });
}
