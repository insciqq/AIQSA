import {
  decodeKnowledgeCoverageScopeCompletenessPromptV4,
  decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2,
  knowledgeCoverageScopeCompletenessPromptV4,
  knowledgeCoverageScopePromptV6AnswerGranularityV2
} from "./coverageScopeAnswerGranularityV2";

export const KNOWLEDGE_COVERAGE_SCOPE_SET_REDUCTION_VERSION = 1 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_SET_REDUCTION_CONTRACT_V1 = Object.freeze([
  '<aiqsa_knowledge_coverage_scope_set_reduction_contract version="1">',
  "Author one Scope finding per materially distinct answer obligation across the entire output, never one finding per evidence unit. Repeated, paraphrased, or independently sourced evidence for the same complete answer-level proposition is support for one task, not additional coverage demand.",
  "When multiple evidence units each fully state the same answer obligation, emit it exactly once under the earliest supplied evidence unit whose atoms fully entail it and leave later repetitions empty. A joint finding is only for a conclusion that requires operands from multiple handles, never a container for redundant copies.",
  "Treat two findings as distinct when their complete truth conditions differ materially, including subject, relation, polarity, comparison side, actor or beneficiary, condition, scope, uncertainty, attribution, mechanism, constraint, trade-off, or outcome. Do not collapse separately requested or co-equal points merely because they share vocabulary.",
  "This is model-owned set reduction over immutable supplied atoms. The server never semantically merges findings, chooses a representative, or transfers provenance, and every emitted finding still passes the unchanged V6 validator.",
  "</aiqsa_knowledge_coverage_scope_set_reduction_contract>"
].join("\n"));

export const KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SET_REDUCTION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_coverage_scope_completeness_set_reduction_contract version="1">',
    "Audit accepted Scope as one answer-task set across all evidence units. Do not append a task that is semantically equivalent to an accepted item merely because another handle repeats, paraphrases, tabulates, or independently supports it.",
    "Append only a materially distinct answer obligation whose complete truth conditions are absent from accepted Scope. Preserve different subjects, relations, polarity, comparison sides, actors or beneficiaries, conditions, scope, uncertainty, attribution, mechanisms, constraints, trade-offs, outcomes, and separately requested members.",
    "Accepted Scope remains immutable: this operation may add a genuinely omitted task but cannot rewrite, merge, delete, or choose among accepted items. The later global Selector performs the fail-closed eligibility reduction for any redundancy already present.",
    "</aiqsa_knowledge_coverage_scope_completeness_set_reduction_contract>"
  ].join("\n"));

function appendContract(systemPrompt: string, contract: string): string {
  return `${systemPrompt}\n\n${contract}`;
}

function stripContract(systemPrompt: string, contract: string): string | null {
  const suffix = `\n\n${contract}`;
  return systemPrompt.endsWith(suffix)
    ? systemPrompt.slice(0, -suffix.length)
    : null;
}

/** Current blind Scope prompt. Snapshot V31 remains byte-exact. */
export function knowledgeCoverageScopePromptV6SetReductionV1(
  input: Parameters<typeof knowledgeCoverageScopePromptV6AnswerGranularityV2>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopePromptV6AnswerGranularityV2(input);
  return Object.freeze({
    systemPrompt: appendContract(
      base.systemPrompt,
      KNOWLEDGE_COVERAGE_SCOPE_SET_REDUCTION_CONTRACT_V1
    ),
    userPrompt: base.userPrompt
  });
}

export function decodeKnowledgeCoverageScopePromptV6SetReductionV1(
  input: Parameters<typeof decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2> {
  const baseSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_SET_REDUCTION_CONTRACT_V1
  );
  if (baseSystemPrompt === null) return null;
  return decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2({
    ...input,
    systemPrompt: baseSystemPrompt
  });
}

/** Current append-only completeness prompt. Snapshot V31 remains byte-exact. */
export function knowledgeCoverageScopeCompletenessPromptV5(
  input: Parameters<typeof knowledgeCoverageScopeCompletenessPromptV4>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopeCompletenessPromptV4(input);
  return Object.freeze({
    systemPrompt: appendContract(
      base.systemPrompt,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SET_REDUCTION_CONTRACT_V1
    ),
    userPrompt: base.userPrompt
  });
}

export function decodeKnowledgeCoverageScopeCompletenessPromptV5(
  input: Parameters<typeof decodeKnowledgeCoverageScopeCompletenessPromptV4>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopeCompletenessPromptV4> {
  const baseSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SET_REDUCTION_CONTRACT_V1
  );
  if (baseSystemPrompt === null) return null;
  return decodeKnowledgeCoverageScopeCompletenessPromptV4({
    ...input,
    systemPrompt: baseSystemPrompt
  });
}
