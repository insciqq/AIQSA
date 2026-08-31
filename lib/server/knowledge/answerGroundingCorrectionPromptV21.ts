import {
  isKnowledgeDraftMalformed,
  knowledgeAnswerCanonicalJson,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeSelectorEvidenceV1,
  type KnowledgeSelectorValidationFailureReason
} from "./answerGroundingV5";
import {
  knowledgeAnswerDraftPromptV21
} from "./answerGroundingV21";
import {
  knowledgeGroundedSelectorPromptV21,
  type KnowledgeCoverageDimensionV6,
  type KnowledgeGroundedSelectorV21
} from "./answerGroundingSelectorV21";
import type {
  KnowledgeTargetedSupplementClaimBindingV1
} from "./answerGroundingCorrectionV21";
import type { KnowledgeCoverageScopeV6 } from "./coverageScopeV6";

export const KNOWLEDGE_TARGETED_SUPPLEMENT_CONTRACT_V1 = Object.freeze([
  '<aiqsa_knowledge_targeted_supplement_contract version="1">',
  "Every returned candidate must include targetDimensionId naming exactly one supplied positive missing dimension. The target is a task address, never evidence or permission to copy its description.",
  "Every supplied dimension is a positive missing target with evidence provenance. Return at least one independently checkable evidence-derived candidate for every supplied dimension.",
  "A candidate's citationHints must overlap its target dimension's immutable evidenceHandles. This provenance overlap is only a search boundary: derive the complete claim from the manifest and do not substitute an adjacent fact from the same handle.",
  "Do not repeat a primary Draft claim. Keep candidates grouped by their semantic target, but split independently falsifiable assertions into separate claims carrying the same targetDimensionId when needed.",
  "The server validates exact target coverage and provenance, assigns claim IDs, and preserves the target binding for the final delta Selector.",
  "Do not create, remove, merge, rename, or reinterpret target dimensions.",
  "</aiqsa_knowledge_targeted_supplement_contract>"
].join("\n"));

export const KNOWLEDGE_GROUNDED_DELTA_SELECTOR_CONTRACT_V1 = Object.freeze([
  '<aiqsa_knowledge_grounded_delta_selector_contract version="1">',
  "This delta contract supersedes the base final-pass recomputation instruction. Do not re-adjudicate or remap accepted primary state.",
  "baseSelector is immutable accepted protocol state. Repeat its primary claim verdicts, extract IDs, and already-covered dimension mappings exactly; the server preserves that state even if this response disagrees.",
  "correctionTargets binds every supplemental claim ID to exactly one dimension that was missing in baseSelector. Adjudicate supplemental claims normally, but map a newly covered dimension only to supported supplemental IDs targeted to that same dimension.",
  "Do not use a primary claim, a literal, or a claim targeted to another dimension to flip a previously missing dimension. Do not remove or rewrite already accepted support.",
  "A targeted claim still needs semantic entailment and must answer the complete immutable Scope description. Provenance overlap and target identity alone never establish coverage.",
  "This is one bounded delta pass. It cannot trigger another correction, retrieve again, or alter Scope.",
  "</aiqsa_knowledge_grounded_delta_selector_contract>"
].join("\n"));

const TARGETED_SUPPLEMENT_TASK_REMINDER =
  "Return novel evidence-derived candidates for every positive missing D target, with exact targetDimensionId and provenance overlap.";
const DELTA_SELECTOR_TASK_REMINDER =
  "Preserve the accepted base and adjudicate only target-addressed supplemental deltas for previously missing dimensions.";

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validTargetDimensions(
  dimensions: readonly KnowledgeCoverageDimensionV6[]
): boolean {
  const ids = new Set(dimensions.map(({ id }) => id));
  return dimensions.length > 0 && ids.size === dimensions.length &&
    dimensions.every((dimension) => dimension.status === "missing" &&
      dimension.evidenceHandles.length > 0);
}

export function knowledgeAnswerTargetedSupplementPromptV1(input: Readonly<{
  auditDimensions: readonly KnowledgeCoverageDimensionV6[];
  evidenceManifest: string;
  primaryDraft: KnowledgeAnswerDraftSelectorInput;
  request: string;
  routeInstruction: string;
}>): Readonly<{ systemPrompt: string; userPrompt: string }> {
  if (isKnowledgeDraftMalformed(input.primaryDraft) ||
    !validTargetDimensions(input.auditDimensions)) {
    throw new Error("knowledge_targeted_supplement_prompt_invalid");
  }
  const base = knowledgeAnswerDraftPromptV21({
    auditDimensions: input.auditDimensions,
    draftPass: "supplement",
    evidenceManifest: input.evidenceManifest,
    primaryDraft: input.primaryDraft,
    request: input.request,
    routeInstruction: input.routeInstruction
  });
  const payload = JSON.parse(base.userPrompt) as Record<string, unknown>;
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n${KNOWLEDGE_TARGETED_SUPPLEMENT_CONTRACT_V1}`,
    userPrompt: knowledgeAnswerCanonicalJson({
      ...payload,
      targetingMode: "exact_missing_dimension",
      taskReminder: TARGETED_SUPPLEMENT_TASK_REMINDER
    })
  });
}

export function knowledgeGroundedDeltaSelectorPromptV1(input: Readonly<{
  bindings: readonly KnowledgeTargetedSupplementClaimBindingV1[];
  draft: KnowledgeAnswerDraftSelectorInput;
  evidence: readonly KnowledgeSelectorEvidenceV1[];
  evidenceManifest: string;
  initialSelector: KnowledgeGroundedSelectorV21;
  repairReason?: KnowledgeSelectorValidationFailureReason;
  request: string;
  scope: KnowledgeCoverageScopeV6;
}>): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const draft = input.draft;
  if (input.repairReason !== undefined || isKnowledgeDraftMalformed(draft)) {
    throw new Error("knowledge_grounded_delta_selector_prompt_invalid");
  }
  const primaryClaimCount = input.initialSelector.claims.length;
  const supplementalClaims = draft.claims.slice(primaryClaimCount);
  const bindingByClaimId = new Map(input.bindings.map((binding) =>
    [binding.claimId, binding] as const));
  const targetable = input.initialSelector.coverage.filter((dimension) =>
    dimension.status === "missing" && dimension.evidenceHandles.length > 0);
  const targetIds = new Set(targetable.map(({ id }) => id));
  const scopeById = new Map(input.scope.scope.map((dimension) => [dimension.id, dimension]));
  const baseShapeValid = primaryClaimCount > 0 &&
    draft.claims.length > primaryClaimCount &&
    input.bindings.length === supplementalClaims.length &&
    bindingByClaimId.size === input.bindings.length &&
    targetIds.size === targetable.length && targetIds.size > 0 &&
    input.scope.scope.length === input.initialSelector.coverage.length &&
    input.initialSelector.claims.every((claim, index) =>
      draft.claims[index]?.id === claim.id) &&
    supplementalClaims.every((claim) => bindingByClaimId.has(claim.id)) &&
    input.bindings.every(({ targetDimensionId }) => targetIds.has(targetDimensionId)) &&
    targetable.every(({ id }) => input.bindings.some((binding) =>
      binding.targetDimensionId === id)) &&
    input.initialSelector.coverage.every((dimension) => {
      const scoped = scopeById.get(dimension.id);
      return scoped !== undefined && dimension.description === scoped.description &&
        dimension.requestAnchor === scoped.requestAnchor &&
        sameStrings(dimension.evidenceHandles, scoped.evidenceHandles) &&
        sameStrings(dimension.evidenceAtomIds, scoped.evidenceAtomIds);
    });
  if (!baseShapeValid) {
    throw new Error("knowledge_grounded_delta_selector_prompt_invalid");
  }
  const base = knowledgeGroundedSelectorPromptV21({
    draft,
    evidence: input.evidence,
    evidenceManifest: input.evidenceManifest,
    request: input.request,
    scope: input.scope,
    selectorPass: "final"
  });
  const payload = JSON.parse(base.userPrompt) as Record<string, unknown>;
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n${KNOWLEDGE_GROUNDED_DELTA_SELECTOR_CONTRACT_V1}`,
    userPrompt: knowledgeAnswerCanonicalJson({
      ...payload,
      baseSelector: input.initialSelector,
      correctionTargets: input.bindings,
      selectorPass: "final_delta",
      taskReminder: DELTA_SELECTOR_TASK_REMINDER
    })
  });
}
