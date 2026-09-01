import {
  decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2,
  knowledgeCoverageScopePromptV6AnswerGranularityV2
} from "./coverageScopeAnswerGranularityV2";

export const KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_VERSION = 1 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_CONTRACT_V1 = Object.freeze([
  '<aiqsa_knowledge_coverage_scope_recall_map_contract version="1">',
  "Scope is the recall-oriented map stage. Emit every evidence-backed answer obligation at answer-level granularity within its own evidence unit; do not perform cross-unit semantic deduplication here.",
  "Repeated, paraphrased, tabulated, or independently sourced evidence may therefore produce equivalent positive findings in multiple units. Never suppress all representatives because a fact repeats. When equivalence or representative choice is uncertain, retain each locally entailed positive finding; the later global Selector is the sole semantic redundancy-reduction stage.",
  "Within one evidence unit, do not multiply a proposition merely because several atoms repeat it. Preserve materially different subject, relation, polarity, comparison side, actor or beneficiary, condition, scope, uncertainty, attribution, mechanism, constraint, trade-off, outcome, and separately requested members.",
  "The server validates and materializes every emitted finding without semantic merging, representative selection, similarity thresholds, or provenance transfer. A zero-finding answer is valid only when no supplied atom entails any answer obligation and no requested facet belongs in unsupportedDimensions.",
  "</aiqsa_knowledge_coverage_scope_recall_map_contract>"
].join("\n"));

function stripContract(systemPrompt: string): string | null {
  const suffix = `\n\n${KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_CONTRACT_V1}`;
  return systemPrompt.endsWith(suffix)
    ? systemPrompt.slice(0, -suffix.length)
    : null;
}

/** Current recall-first Scope map. Snapshot V32 remains byte-exact. */
export function knowledgeCoverageScopePromptV6RecallMapV1(
  input: Parameters<typeof knowledgeCoverageScopePromptV6AnswerGranularityV2>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopePromptV6AnswerGranularityV2(input);
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n${KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_CONTRACT_V1}`,
    userPrompt: base.userPrompt
  });
}

export function decodeKnowledgeCoverageScopePromptV6RecallMapV1(
  input: Parameters<typeof decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2> {
  const baseSystemPrompt = stripContract(input.systemPrompt);
  if (baseSystemPrompt === null) return null;
  return decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2({
    ...input,
    systemPrompt: baseSystemPrompt
  });
}
