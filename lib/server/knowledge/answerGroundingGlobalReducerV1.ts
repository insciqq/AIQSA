import {
  knowledgeAnswerTargetedSupplementPromptV7
} from "./answerGroundingAnswerLevelCompressionV1";
import {
  knowledgeAnswerDraftPromptV21
} from "./answerGroundingV21";
import {
  KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1
} from "./answerGroundingDraftFacetAtomizationV1";
import {
  knowledgeGroundedSelectorPromptV21ScopeSetReductionV1
} from "./answerGroundingScopeSetReductionV1";

export {
  KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1
} from "./answerGroundingDraftFacetAtomizationV1";

export const KNOWLEDGE_ANSWER_GLOBAL_REDUCER_VERSION = 1 as const;

export const KNOWLEDGE_GROUNDED_SELECTOR_UNSUPPORTED_SUPERSESSION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_unsupported_supersession_contract version="1">',
    "Apply one global no-data reconciliation after the positive Scope map and append-only completeness pass.",
    "An evidence-free unsupported item may be excluded only when it is a false no-data placeholder for the same complete answer obligation as a distinct evidence-backed Scope item anchored to the same exact request fragment. Keep that positive representative covered or missing under the normal rules.",
    "Do not exclude an unsupported item merely because some evidence exists, its words overlap another item, or a different facet shares a broad topic. A genuinely requested absent facet remains missing.",
    "This is the global reduce decision used to prevent a local no-data map result from surviving beside its positive representative. It does not delete Scope, transfer provenance, choose support, or promote coverage.",
    "</aiqsa_knowledge_unsupported_supersession_contract>"
  ].join("\n"));

export const KNOWLEDGE_TARGETED_SUPPLEMENT_EXACT_DUPLICATE_REDUCTION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_supplement_exact_duplicate_reduction_contract version="1">',
    "Every target group must contribute at least one candidate not already present verbatim in the immutable primary Draft. Reuse the target atoms to state only the missing relation, qualifier, mechanism, or outcome.",
    "Before validation the server may discard only NFC-exact primary-claim repeats, and only when every target group still retains a candidate. It never performs fuzzy deduplication, rewrites text, moves a claim between targets, or treats a duplicate as coverage.",
    "If exact-repeat removal would empty any target group, the whole Supplement remains invalid and correction fails closed.",
    "</aiqsa_knowledge_supplement_exact_duplicate_reduction_contract>"
  ].join("\n"));

/** Current V35 primary map prompt. Earlier Snapshot prompt bytes remain exact. */
export function knowledgeAnswerDraftPromptV21GlobalReducerV1(
  input: Parameters<typeof knowledgeAnswerDraftPromptV21>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeAnswerDraftPromptV21(input);
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n` +
      KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1,
    userPrompt: base.userPrompt
  });
}

export function knowledgeGroundedSelectorPromptV21GlobalReducerV1(
  input: Parameters<typeof knowledgeGroundedSelectorPromptV21ScopeSetReductionV1>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeGroundedSelectorPromptV21ScopeSetReductionV1(input);
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n` +
      KNOWLEDGE_GROUNDED_SELECTOR_UNSUPPORTED_SUPERSESSION_CONTRACT_V1,
    userPrompt: base.userPrompt
  });
}

export function knowledgeAnswerTargetedSupplementPromptV8(
  input: Parameters<typeof knowledgeAnswerTargetedSupplementPromptV7>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeAnswerTargetedSupplementPromptV7(input);
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n` +
      KNOWLEDGE_TARGETED_SUPPLEMENT_EXACT_DUPLICATE_REDUCTION_CONTRACT_V1,
    userPrompt: base.userPrompt
  });
}
