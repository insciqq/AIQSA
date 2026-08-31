import {
  KNOWLEDGE_ANSWER_DRAFT_LIMITS,
  KNOWLEDGE_ANSWER_DRAFT_MAX_SUPPLEMENT_CLAIMS,
  isKnowledgeDraftMalformed,
  knowledgeAnswerHash,
  mergeKnowledgeAnswerDraftsV1,
  validateKnowledgeAnswerDraftSupplementV1,
  validateKnowledgeAnswerDraftSupplementV2,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeAnswerDraftV5,
  type KnowledgeAnswerDraftValidationFailureReason,
  type KnowledgeAnswerDraftValidationV6,
  type KnowledgeGroundedSelectorClaimV3
} from "./answerGroundingV5";
import type {
  KnowledgeCoverageDimensionV6,
  KnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import { knowledgeCoverageEvidenceAtomIndexV1 } from "./coverageScopeV4";
import type { KnowledgeCoverageEvidenceV6 } from "./coverageScopeV6";

export const KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V1 = 1 as const;
export const KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V2 = 2 as const;

export const KNOWLEDGE_TARGETED_EVIDENCE_ATOM_LIMITS_V1 = Object.freeze({
  maxAtoms: 128,
  maxCodePoints: 32_768
});

const targetIdPattern = /^D[1-8]$/u;
const claimIdPattern = /^C(?:[1-9]|1\d|2[0-4])$/u;

const targetedClaimSchema = Object.freeze({
  additionalProperties: false,
  properties: {
    targetDimensionId: { pattern: "^D[1-8]$", type: "string" },
    text: {
      maxLength: KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaimCodePoints,
      minLength: 1,
      type: "string"
    }
  },
  required: ["targetDimensionId", "text"],
  type: "object"
});

export const KNOWLEDGE_ANSWER_TARGETED_SUPPLEMENT_SCHEMA_V1 = Object.freeze({
  additionalProperties: false,
  properties: {
    claims: {
      items: targetedClaimSchema,
      maxItems: KNOWLEDGE_ANSWER_DRAFT_MAX_SUPPLEMENT_CLAIMS,
      minItems: 1,
      type: "array"
    },
    version: { const: KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V1, type: "integer" }
  },
  required: ["version", "claims"],
  type: "object"
} satisfies Readonly<Record<string, unknown>>);

const targetedClaimTextSchemaV2 = Object.freeze({
  maxLength: KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaimCodePoints,
  minLength: 1,
  type: "string"
});

export type KnowledgeTargetedSupplementClaimBindingV1 = Readonly<{
  claimId: string;
  targetDimensionId: string;
}>;

export type KnowledgeTargetedSupplementV1 = Readonly<{
  bindings: readonly KnowledgeTargetedSupplementClaimBindingV1[];
  draft: KnowledgeAnswerDraftV5;
  version: typeof KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V1;
}>;

export type KnowledgeTargetedSupplementV2 = Readonly<{
  bindings: readonly KnowledgeTargetedSupplementClaimBindingV1[];
  draft: KnowledgeAnswerDraftV5;
  version: typeof KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V2;
}>;

export type KnowledgeTargetedSupplementClaimLimitV2 = Readonly<{
  maxClaims: number;
  targetDimensionId: string;
}>;

export type KnowledgeTargetedEvidenceAtomIndexV1 = Readonly<{
  atoms: readonly Readonly<{
    handle: string;
    id: string;
    text: string;
  }>[];
  targets: readonly Readonly<{
    evidenceAtomIds: readonly string[];
    targetDimensionId: string;
  }>[];
  version: 1;
}>;

export type KnowledgeTargetedSupplementFailureReasonV1 =
  | "draft_duplicate_primary_claim"
  | "draft_target_evidence_invalid"
  | "draft_target_set_invalid"
  | "draft_target_shape_invalid";

export type KnowledgeTargetedSupplementFailureV1 = Readonly<{
  kind: "targeted_supplement_failed";
  reason: KnowledgeTargetedSupplementFailureReasonV1;
}>;

export type KnowledgeTargetedSupplementValidationFailureReasonV1 =
  | KnowledgeAnswerDraftValidationFailureReason
  | KnowledgeTargetedSupplementFailureReasonV1;

type KnowledgeTargetedSupplementValidationInputV1 = Readonly<{
  availableHandles: ReadonlySet<string> | readonly string[];
  forbiddenIdentityFragments?: readonly string[];
  missingDimensions: readonly KnowledgeCoverageDimensionV6[];
  primaryDraft: KnowledgeAnswerDraftSelectorInput;
}>;

type KnowledgeTargetedSupplementDraftValidatorV1 = (
  value: unknown,
  input: Parameters<typeof validateKnowledgeAnswerDraftSupplementV1>[1]
) => KnowledgeAnswerDraftValidationV6;

export type KnowledgeTargetedSupplementValidationV1 =
  | Readonly<{ kind: "accepted"; value: KnowledgeTargetedSupplementV1 }>
  | Readonly<{
      kind: "rejected";
      reason: KnowledgeTargetedSupplementValidationFailureReasonV1;
    }>;

export type KnowledgeMergedTargetedSupplementV1 = Readonly<{
  bindings: readonly KnowledgeTargetedSupplementClaimBindingV1[];
  draft: KnowledgeAnswerDraftV5;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rejected(
  reason: KnowledgeTargetedSupplementValidationFailureReasonV1
): KnowledgeTargetedSupplementValidationV1 {
  return Object.freeze({ kind: "rejected", reason });
}

const targetedFailureReasons = new Set<KnowledgeTargetedSupplementFailureReasonV1>([
  "draft_duplicate_primary_claim",
  "draft_target_evidence_invalid",
  "draft_target_set_invalid",
  "draft_target_shape_invalid"
]);

export function isKnowledgeTargetedSupplementFailureReasonV1(
  value: unknown
): value is KnowledgeTargetedSupplementFailureReasonV1 {
  return typeof value === "string" && targetedFailureReasons.has(
    value as KnowledgeTargetedSupplementFailureReasonV1
  );
}

export function knowledgeTargetedSupplementFailureV1(
  reason: KnowledgeTargetedSupplementFailureReasonV1
): KnowledgeTargetedSupplementFailureV1 {
  return Object.freeze({ kind: "targeted_supplement_failed", reason });
}

export function decodeKnowledgeTargetedSupplementFailureV1(
  value: unknown
): KnowledgeTargetedSupplementFailureV1 | null {
  return record(value) && exactKeys(value, ["kind", "reason"]) &&
    value.kind === "targeted_supplement_failed" &&
    isKnowledgeTargetedSupplementFailureReasonV1(value.reason)
    ? knowledgeTargetedSupplementFailureV1(value.reason)
    : null;
}

/** A correction is useful only for missing positive Scope findings. Explicitly
 * unsupported request facets have no evidence provenance and cannot be repaired
 * by generating another claim over the same manifest. */
export function knowledgeTargetableMissingDimensionsV1(
  dimensions: readonly KnowledgeCoverageDimensionV6[]
): readonly KnowledgeCoverageDimensionV6[] {
  return Object.freeze(dimensions.filter((dimension) =>
    dimension.status === "missing" && dimension.evidenceHandles.length > 0
  ));
}

/** Splits the immutable global Supplement claim budget across every target.
 * Each target receives at least one slot and capacities differ by at most one,
 * so an earlier target cannot consume the slots required by a later target. */
export function knowledgeTargetedSupplementClaimLimitsV2(input: Readonly<{
  primaryClaimCount: number;
  targetDimensions: readonly KnowledgeCoverageDimensionV6[];
}>): readonly KnowledgeTargetedSupplementClaimLimitV2[] | null {
  const targetable = knowledgeTargetableMissingDimensionsV1(input.targetDimensions);
  const targetIds = new Set(targetable.map(({ id }) => id));
  const available = Math.min(
    KNOWLEDGE_ANSWER_DRAFT_MAX_SUPPLEMENT_CLAIMS,
    KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaims - input.primaryClaimCount
  );
  if (!Number.isSafeInteger(input.primaryClaimCount) || input.primaryClaimCount < 1 ||
    targetable.length !== input.targetDimensions.length || targetable.length < 1 ||
    targetIds.size !== targetable.length || targetable.some(({ id }) =>
      !targetIdPattern.test(id)) || available < targetable.length) return null;
  const base = Math.floor(available / targetable.length);
  const remainder = available % targetable.length;
  return Object.freeze(targetable.map(({ id }, index) => Object.freeze({
    maxClaims: base + (index < remainder ? 1 : 0),
    targetDimensionId: id
  })));
}

/** Builds a request-specific strict schema whose required object keys are the
 * exact missing Scope IDs. Grouping preserves task identity while still
 * allowing several independently checkable claims for one dimension. */
export function knowledgeAnswerTargetedSupplementSchemaV2(input: Readonly<{
  primaryClaimCount: number;
  targetDimensions: readonly KnowledgeCoverageDimensionV6[];
}>): Readonly<Record<string, unknown>> {
  const limits = knowledgeTargetedSupplementClaimLimitsV2(input);
  if (!limits) throw new Error("knowledge_targeted_supplement_schema_invalid");
  const properties = Object.freeze(Object.fromEntries(limits.map((limit) => [
    limit.targetDimensionId,
    Object.freeze({
      items: targetedClaimTextSchemaV2,
      maxItems: limit.maxClaims,
      minItems: 1,
      type: "array"
    })
  ])));
  return Object.freeze({
    additionalProperties: false,
    properties: Object.freeze({
      targets: Object.freeze({
        additionalProperties: false,
        properties,
        required: Object.freeze(limits.map(({ targetDimensionId }) =>
          targetDimensionId)),
        type: "object"
      }),
      version: Object.freeze({
        const: KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V2,
        type: "integer"
      })
    }),
    required: Object.freeze(["version", "targets"]),
    type: "object"
  });
}

/** Recognizes only the bounded fair-allocation schema family used by V2. The
 * exact target IDs and primary-Draft capacity are reconstructed and byte-
 * compared during recovery. */
export function isKnowledgeAnswerTargetedSupplementSchemaV2(
  value: unknown
): value is Readonly<Record<string, unknown>> {
  if (!record(value) || !exactKeys(value, [
    "additionalProperties",
    "properties",
    "required",
    "type"
  ]) || value.additionalProperties !== false || value.type !== "object" ||
    !Array.isArray(value.required) || !sameStrings(value.required as string[], [
      "version",
      "targets"
    ]) || !record(value.properties) || !exactKeys(value.properties, [
      "targets",
      "version"
    ])) return false;
  const version = value.properties.version;
  const targets = value.properties.targets;
  if (!record(version) || !exactKeys(version, ["const", "type"]) ||
    version.const !== KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V2 ||
    version.type !== "integer" || !record(targets) || !exactKeys(targets, [
      "additionalProperties",
      "properties",
      "required",
      "type"
    ]) || targets.additionalProperties !== false || targets.type !== "object" ||
    !record(targets.properties) || !Array.isArray(targets.required)) return false;
  const ids = Object.keys(targets.properties);
  if (ids.length < 1 || ids.length > 8 || !sameStrings(
    targets.required as string[],
    ids
  ) || ids.some((id, index) => !targetIdPattern.test(id) || index > 0 &&
    Number(id.slice(1)) <= Number(ids[index - 1]!.slice(1)))) return false;
  const capacities: number[] = [];
  for (const id of ids) {
    const schema = targets.properties[id];
    if (!record(schema) || !exactKeys(schema, [
      "items",
      "maxItems",
      "minItems",
      "type"
    ]) || schema.type !== "array" || schema.minItems !== 1 ||
      !Number.isSafeInteger(schema.maxItems) || Number(schema.maxItems) < 1 ||
      Number(schema.maxItems) > KNOWLEDGE_ANSWER_DRAFT_MAX_SUPPLEMENT_CLAIMS ||
      knowledgeAnswerHash(schema.items) !==
        knowledgeAnswerHash(targetedClaimTextSchemaV2)) return false;
    capacities.push(Number(schema.maxItems));
  }
  const total = capacities.reduce((sum, capacity) => sum + capacity, 0);
  const base = Math.floor(total / capacities.length);
  const remainder = total % capacities.length;
  return total <= KNOWLEDGE_ANSWER_DRAFT_MAX_SUPPLEMENT_CLAIMS &&
    capacities.every((capacity, index) =>
      capacity === base + (index < remainder ? 1 : 0));
}

/** Projects only the exact Scope atoms assigned to positive correction
 * targets. The projection is deterministic, lossless, and bounded; it adds no
 * retrieval or semantic server inference. Returning null disables correction
 * rather than sending a partial target-evidence view. */
export function knowledgeTargetedEvidenceAtomIndexV1(input: Readonly<{
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  targetDimensions: readonly KnowledgeCoverageDimensionV6[];
}>): KnowledgeTargetedEvidenceAtomIndexV1 | null {
  const targetable = knowledgeTargetableMissingDimensionsV1(input.targetDimensions);
  const targetIds = new Set(targetable.map(({ id }) => id));
  if (targetable.length !== input.targetDimensions.length || targetable.length < 1 ||
    targetIds.size !== targetable.length || targetable.some(({ id, evidenceAtomIds }) =>
      !targetIdPattern.test(id) || evidenceAtomIds.length < 1 ||
      new Set(evidenceAtomIds).size !== evidenceAtomIds.length)) return null;
  let atomIndex: ReturnType<typeof knowledgeCoverageEvidenceAtomIndexV1>;
  try {
    atomIndex = knowledgeCoverageEvidenceAtomIndexV1(input.evidence);
  } catch {
    return null;
  }
  const atomById = new Map(atomIndex.items.map((atom, index) =>
    [atom.id, Object.freeze({ ...atom, index })] as const));
  const selectedIds = new Set<string>();
  for (const dimension of targetable) {
    const atoms = dimension.evidenceAtomIds.map((id) => atomById.get(id));
    if (atoms.some((atom) => atom === undefined) || atoms.some((atom, index) =>
      index > 0 && atom!.index <= atoms[index - 1]!.index)) return null;
    const handles = [...new Set(atoms.map((atom) => atom!.handle))];
    if (!sameStrings(handles, dimension.evidenceHandles)) return null;
    for (const id of dimension.evidenceAtomIds) selectedIds.add(id);
  }
  const atoms = atomIndex.items.filter(({ id }) => selectedIds.has(id));
  const totalCodePoints = atoms.reduce((total, { text }) =>
    total + Array.from(text).length, 0);
  if (atoms.length < 1 ||
    atoms.length > KNOWLEDGE_TARGETED_EVIDENCE_ATOM_LIMITS_V1.maxAtoms ||
    totalCodePoints > KNOWLEDGE_TARGETED_EVIDENCE_ATOM_LIMITS_V1.maxCodePoints) return null;
  return Object.freeze({
    atoms: Object.freeze(atoms.map((atom) => Object.freeze({ ...atom }))),
    targets: Object.freeze(targetable.map((dimension) => Object.freeze({
      evidenceAtomIds: Object.freeze([...dimension.evidenceAtomIds]),
      targetDimensionId: dimension.id
    }))),
    version: 1 as const
  });
}

/** The all-target supplement contract is dispatchable only when one candidate
 * per positive missing dimension fits both the supplement and merged-Draft
 * bounds. Otherwise the accepted initial partial result settles unchanged. */
export function knowledgeTargetedSupplementFitsV1(input: Readonly<{
  primaryClaimCount: number;
  targetableDimensionCount: number;
}>): boolean {
  return Number.isSafeInteger(input.primaryClaimCount) &&
    input.primaryClaimCount >= 1 &&
    Number.isSafeInteger(input.targetableDimensionCount) &&
    input.targetableDimensionCount >= 1 &&
    input.targetableDimensionCount <= KNOWLEDGE_ANSWER_DRAFT_MAX_SUPPLEMENT_CLAIMS &&
    input.primaryClaimCount + input.targetableDimensionCount <=
      KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaims;
}

/** Validates a task-addressed corrective Draft. Every positive missing Scope
 * dimension receives at least one novel candidate. The model returns no
 * provenance: the server derives advisory Draft hints from that target's exact
 * immutable Scope handles, while the final Selector owns factual support,
 * provenance overlap, and semantic coverage. */
function validateKnowledgeTargetedSupplementWithDraftValidatorV1(
  value: unknown,
  input: KnowledgeTargetedSupplementValidationInputV1,
  validateDraft: KnowledgeTargetedSupplementDraftValidatorV1
): KnowledgeTargetedSupplementValidationV1 {
  if (isKnowledgeDraftMalformed(input.primaryDraft) || !record(value) ||
    !exactKeys(value, ["version", "claims"]) ||
    value.version !== KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V1 ||
    !Array.isArray(value.claims) || value.claims.length < 1 ||
    value.claims.length > KNOWLEDGE_ANSWER_DRAFT_MAX_SUPPLEMENT_CLAIMS ||
    input.primaryDraft.claims.length + value.claims.length >
      KNOWLEDGE_ANSWER_DRAFT_LIMITS.maxClaims) {
    return rejected("draft_target_shape_invalid");
  }
  const targetable = knowledgeTargetableMissingDimensionsV1(input.missingDimensions);
  const dimensionById = new Map(targetable.map((dimension) => [dimension.id, dimension]));
  if (targetable.length < 1 || dimensionById.size !== targetable.length ||
    targetable.some(({ id }) => !targetIdPattern.test(id))) {
    return rejected("draft_target_set_invalid");
  }
  const rawClaims: Array<Readonly<{
    targetDimensionId: string;
    text: unknown;
  }>> = [];
  for (const candidate of value.claims) {
    if (!record(candidate) || !exactKeys(candidate, [
      "targetDimensionId",
      "text"
    ]) || typeof candidate.targetDimensionId !== "string" ||
      !dimensionById.has(candidate.targetDimensionId)) {
      return rejected("draft_target_shape_invalid");
    }
    rawClaims.push({
      targetDimensionId: candidate.targetDimensionId,
      text: candidate.text
    });
  }
  if (targetable.some((dimension) => !rawClaims.some((claim) =>
    claim.targetDimensionId === dimension.id))) {
    return rejected("draft_target_set_invalid");
  }
  const validation = validateDraft({
    claims: rawClaims.map(({ targetDimensionId, text }) => ({
      citationHints: dimensionById.get(targetDimensionId)!.evidenceHandles,
      text
    })),
    version: 1
  }, {
    availableHandles: input.availableHandles,
    forbiddenIdentityFragments: input.forbiddenIdentityFragments
  });
  if (validation.kind === "rejected") return validation;
  const primaryTexts = new Set(input.primaryDraft.claims.map(({ text }) =>
    text.normalize("NFC")));
  if (validation.value.claims.some(({ text }) => primaryTexts.has(text.normalize("NFC")))) {
    return rejected("draft_duplicate_primary_claim");
  }
  return Object.freeze({
    kind: "accepted",
    value: Object.freeze({
      bindings: Object.freeze(validation.value.claims.map((claim, index) => Object.freeze({
        claimId: claim.id,
        targetDimensionId: rawClaims[index]!.targetDimensionId
      }))),
      draft: validation.value,
      version: KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V1
    })
  });
}

export function validateKnowledgeTargetedSupplementV1(
  value: unknown,
  input: KnowledgeTargetedSupplementValidationInputV1
): KnowledgeTargetedSupplementValidationV1 {
  return validateKnowledgeTargetedSupplementWithDraftValidatorV1(
    value,
    input,
    validateKnowledgeAnswerDraftSupplementV1
  );
}

function validateKnowledgeTargetedSupplementCommonMarkV1(
  value: unknown,
  input: KnowledgeTargetedSupplementValidationInputV1
): KnowledgeTargetedSupplementValidationV1 {
  return validateKnowledgeTargetedSupplementWithDraftValidatorV1(
    value,
    input,
    validateKnowledgeAnswerDraftSupplementV2
  );
}

export function decodeKnowledgeTargetedSupplementV1(
  value: unknown,
  input: Parameters<typeof validateKnowledgeTargetedSupplementV1>[1]
): KnowledgeTargetedSupplementV1 | null {
  const validation = validateKnowledgeTargetedSupplementV1(value, input);
  return validation.kind === "accepted" ? validation.value : null;
}

/** Validates the grouped V2 handoff. Exact target keys are mandatory and each
 * target is independently bounded before claims are flattened in immutable
 * Scope order for the existing semantic Draft validator. */
function validateKnowledgeTargetedSupplementGroupedV2(
  value: unknown,
  input: KnowledgeTargetedSupplementValidationInputV1,
  validateDraft: (
    value: unknown,
    input: KnowledgeTargetedSupplementValidationInputV1
  ) => KnowledgeTargetedSupplementValidationV1
): KnowledgeTargetedSupplementValidationV2 {
  if (isKnowledgeDraftMalformed(input.primaryDraft) || !record(value) ||
    !exactKeys(value, ["version", "targets"]) ||
    value.version !== KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V2 ||
    !record(value.targets)) return rejectedV2("draft_target_shape_invalid");
  const limits = knowledgeTargetedSupplementClaimLimitsV2({
    primaryClaimCount: input.primaryDraft.claims.length,
    targetDimensions: knowledgeTargetableMissingDimensionsV1(input.missingDimensions)
  });
  if (!limits) return rejectedV2("draft_target_set_invalid");
  const ids = limits.map(({ targetDimensionId }) => targetDimensionId);
  if (!exactKeys(value.targets, ids)) return rejectedV2("draft_target_set_invalid");
  const claims: Array<Readonly<{ targetDimensionId: string; text: unknown }>> = [];
  for (const limit of limits) {
    const targetClaims = value.targets[limit.targetDimensionId];
    if (!Array.isArray(targetClaims) || targetClaims.length < 1 ||
      targetClaims.length > limit.maxClaims) {
      return rejectedV2("draft_target_shape_invalid");
    }
    for (const text of targetClaims) {
      claims.push(Object.freeze({
        targetDimensionId: limit.targetDimensionId,
        text
      }));
    }
  }
  const validation = validateDraft({
    claims,
    version: KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V1
  }, input);
  return validation.kind === "rejected"
    ? rejectedV2(validation.reason)
    : Object.freeze({
        kind: "accepted" as const,
        value: Object.freeze({
          bindings: validation.value.bindings,
          draft: validation.value.draft,
          version: KNOWLEDGE_TARGETED_SUPPLEMENT_PAYLOAD_VERSION_V2
        })
      });
}

export function validateKnowledgeTargetedSupplementV2(
  value: unknown,
  input: KnowledgeTargetedSupplementValidationInputV1
): KnowledgeTargetedSupplementValidationV2 {
  return validateKnowledgeTargetedSupplementGroupedV2(
    value,
    input,
    validateKnowledgeTargetedSupplementV1
  );
}

/** Current grouped handoff retains the V2 wire shape while applying the
 * CommonMark-aware claim-text contract selected by the enclosing pipeline. */
export function validateKnowledgeTargetedSupplementV3(
  value: unknown,
  input: KnowledgeTargetedSupplementValidationInputV1
): KnowledgeTargetedSupplementValidationV2 {
  return validateKnowledgeTargetedSupplementGroupedV2(
    value,
    input,
    validateKnowledgeTargetedSupplementCommonMarkV1
  );
}

export type KnowledgeTargetedSupplementValidationV2 =
  | Readonly<{ kind: "accepted"; value: KnowledgeTargetedSupplementV2 }>
  | Readonly<{
      kind: "rejected";
      reason: KnowledgeTargetedSupplementValidationFailureReasonV1;
    }>;

function rejectedV2(
  reason: KnowledgeTargetedSupplementValidationFailureReasonV1
): KnowledgeTargetedSupplementValidationV2 {
  return Object.freeze({ kind: "rejected", reason });
}

export function decodeKnowledgeTargetedSupplementV2(
  value: unknown,
  input: Parameters<typeof validateKnowledgeTargetedSupplementV2>[1]
): KnowledgeTargetedSupplementV2 | null {
  const validation = validateKnowledgeTargetedSupplementV2(value, input);
  return validation.kind === "accepted" ? validation.value : null;
}

export function decodeKnowledgeTargetedSupplementV3(
  value: unknown,
  input: Parameters<typeof validateKnowledgeTargetedSupplementV3>[1]
): KnowledgeTargetedSupplementV2 | null {
  const validation = validateKnowledgeTargetedSupplementV3(value, input);
  return validation.kind === "accepted" ? validation.value : null;
}

/** Rebase the locally assigned Supplement claim IDs after the immutable primary
 * Draft. Validation guarantees no semantic-text deduplication or truncation can
 * occur, so the target binding remains lossless. */
export function mergeKnowledgeTargetedSupplementV1(input: Readonly<{
  primaryDraft: KnowledgeAnswerDraftSelectorInput;
  supplement: KnowledgeTargetedSupplementV1 | KnowledgeTargetedSupplementV2;
}>): KnowledgeMergedTargetedSupplementV1 {
  if (isKnowledgeDraftMalformed(input.primaryDraft)) {
    throw new Error("knowledge_targeted_supplement_primary_invalid");
  }
  const merged = mergeKnowledgeAnswerDraftsV1({
    primary: input.primaryDraft,
    supplement: input.supplement.draft
  });
  if (isKnowledgeDraftMalformed(merged) ||
    merged.claims.length !== input.primaryDraft.claims.length +
      input.supplement.draft.claims.length) {
    throw new Error("knowledge_targeted_supplement_merge_invalid");
  }
  const offset = input.primaryDraft.claims.length;
  return Object.freeze({
    bindings: Object.freeze(input.supplement.bindings.map((binding, index) =>
      Object.freeze({
        claimId: `C${offset + index + 1}`,
        targetDimensionId: binding.targetDimensionId
      }))),
    draft: merged
  });
}

export function mergeKnowledgeTargetedSupplementV2(input: Readonly<{
  primaryDraft: KnowledgeAnswerDraftSelectorInput;
  supplement: KnowledgeTargetedSupplementV2;
}>): KnowledgeMergedTargetedSupplementV1 {
  return mergeKnowledgeTargetedSupplementV1(input);
}

function immutableClaim(claim: KnowledgeGroundedSelectorClaimV3) {
  return Object.freeze({
    id: claim.id,
    supportHandles: Object.freeze([...claim.supportHandles]),
    verdict: claim.verdict
  });
}

/** Applies the final Selector as a delta. Initial support, covered Scope, and
 * eligibility decisions are immutable; only supplement claim verdicts and
 * mappings for dimensions that were initially missing can be added. A new
 * mapping is admitted only when the final Selector chose a supported claim
 * explicitly targeted to that same dimension. */
export function mergeKnowledgeGroundedCorrectionV1(input: Readonly<{
  bindings: readonly KnowledgeTargetedSupplementClaimBindingV1[];
  finalSelector: KnowledgeGroundedSelectorV21;
  initialSelector: KnowledgeGroundedSelectorV21;
  primaryClaimCount: number;
}>): KnowledgeGroundedSelectorV21 {
  const { finalSelector, initialSelector } = input;
  if (!Number.isSafeInteger(input.primaryClaimCount) || input.primaryClaimCount < 1 ||
    initialSelector.claims.length !== input.primaryClaimCount ||
    finalSelector.claims.length < input.primaryClaimCount ||
    initialSelector.coverage.length !== finalSelector.coverage.length ||
    input.bindings.length !== finalSelector.claims.length - input.primaryClaimCount) {
    throw new Error("knowledge_grounded_correction_invalid");
  }
  const bindingByClaimId = new Map(input.bindings.map((binding) =>
    [binding.claimId, binding] as const));
  const targetableIds = new Set(initialSelector.coverage
    .filter((dimension) => dimension.status === "missing" &&
      dimension.evidenceHandles.length > 0)
    .map(({ id }) => id));
  if (bindingByClaimId.size !== input.bindings.length || input.bindings.some((binding) =>
    !claimIdPattern.test(binding.claimId) || !targetIdPattern.test(binding.targetDimensionId) ||
    !targetableIds.has(binding.targetDimensionId)) ||
    [...targetableIds].some((targetId) => !input.bindings.some((binding) =>
      binding.targetDimensionId === targetId))) {
    throw new Error("knowledge_grounded_correction_invalid");
  }
  const supplementalClaims = finalSelector.claims.slice(input.primaryClaimCount);
  if (supplementalClaims.some((claim) => !bindingByClaimId.has(claim.id))) {
    throw new Error("knowledge_grounded_correction_invalid");
  }
  const finalClaimById = new Map(finalSelector.claims.map((claim) => [claim.id, claim]));
  const coverage = initialSelector.coverage.map((initialDimension, index) => {
    const finalDimension = finalSelector.coverage[index];
    if (!finalDimension || initialDimension.id !== finalDimension.id ||
      initialDimension.description !== finalDimension.description ||
      initialDimension.requestAnchor !== finalDimension.requestAnchor ||
      !sameStrings(initialDimension.evidenceHandles, finalDimension.evidenceHandles) ||
      !sameStrings(initialDimension.evidenceAtomIds, finalDimension.evidenceAtomIds)) {
      throw new Error("knowledge_grounded_correction_invalid");
    }
    if (initialDimension.status !== "missing") {
      return Object.freeze({
        ...initialDimension,
        evidenceAtomIds: Object.freeze([...initialDimension.evidenceAtomIds]),
        evidenceHandles: Object.freeze([...initialDimension.evidenceHandles]),
        supportIds: Object.freeze([...initialDimension.supportIds])
      });
    }
    const allowed = new Set(input.bindings
      .filter(({ targetDimensionId }) => targetDimensionId === initialDimension.id)
      .map(({ claimId }) => claimId));
    const supportIds = finalDimension.status === "covered"
      ? finalDimension.supportIds.filter((id) =>
          allowed.has(id) && finalClaimById.get(id)?.verdict === "supported")
      : [];
    return Object.freeze({
      ...initialDimension,
      evidenceAtomIds: Object.freeze([...initialDimension.evidenceAtomIds]),
      evidenceHandles: Object.freeze([...initialDimension.evidenceHandles]),
      status: supportIds.length > 0 ? "covered" as const : "missing" as const,
      supportIds: Object.freeze(supportIds)
    });
  });
  const claims = Object.freeze([
    ...initialSelector.claims.map(immutableClaim),
    ...supplementalClaims.map(immutableClaim)
  ]);
  const hasSupportedContent = claims.some(({ verdict }) => verdict === "supported") ||
    initialSelector.extractIds.length > 0;
  return Object.freeze({
    claims,
    coverage: Object.freeze(coverage),
    extractIds: Object.freeze([...initialSelector.extractIds]),
    insufficientReason: hasSupportedContent
      ? "not_applicable"
      : finalSelector.insufficientReason === "not_applicable"
        ? initialSelector.insufficientReason
        : finalSelector.insufficientReason,
    version: finalSelector.version
  });
}
