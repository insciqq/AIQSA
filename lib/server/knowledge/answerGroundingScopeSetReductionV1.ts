import {
  knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1
} from "./answerGroundingAnswerLevelCompressionV1";

export const KNOWLEDGE_ANSWER_SCOPE_SET_REDUCTION_VERSION = 1 as const;

export const KNOWLEDGE_GROUNDED_SELECTOR_SCOPE_SET_REDUCTION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_grounded_selector_scope_set_reduction_contract version="1">',
    "Apply Scope eligibility to the complete ordered set, not each item in isolation. If two positive items express the same complete answer obligation and differ only because evidence units repeat, paraphrase, tabulate, or independently support it, keep the earliest Scope item eligible and mark every later equivalent positive item excluded with no support IDs.",
    "Excluding a later redundant item is the global reduce decision; it does not delete, merge, rename, reorder, rewrite, or transfer provenance between immutable Scope items. Judge coverage only for the surviving representative using its own assigned atoms and overlapping supported IDs.",
    "Never collapse materially different truth conditions: subject, relation, polarity, comparison side, actor or beneficiary, condition, scope, uncertainty, attribution, mechanism, constraint, trade-off, outcome, and separately requested or exhaustive members remain distinct. A positive item that adds any such required slot is not redundant merely because its wording overlaps.",
    "An evidence-free requested facet can never be excluded, and exclusion cannot hide an answer omission. Reapply the same earliest-representative rule on repair; final correction preserves the accepted initial eligibility decisions.",
    "This is the same model-owned map/reduce boundary used to clean repeated analyst points before synthesis. The server performs no semantic deduplication, similarity threshold, benchmark lookup, or coverage promotion.",
    "</aiqsa_knowledge_grounded_selector_scope_set_reduction_contract>"
  ].join("\n"));

/** Current global Selector reduction. Snapshot V31 remains byte-exact. */
export function knowledgeGroundedSelectorPromptV21ScopeSetReductionV1(
  input: Parameters<
    typeof knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1
  >[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1(input);
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n` +
      KNOWLEDGE_GROUNDED_SELECTOR_SCOPE_SET_REDUCTION_CONTRACT_V1,
    userPrompt: base.userPrompt
  });
}
