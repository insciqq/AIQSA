import {
  decodeKnowledgeCoverageScopeCompletenessPromptV2,
  decodeKnowledgeCoverageScopePromptV6QueryIntentV1,
  knowledgeCoverageScopeCompletenessPromptV2,
  knowledgeCoverageScopePromptV6QueryIntentV1
} from "./coverageScopeQueryIntentV1";

export const KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_VERSION = 1 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_coverage_scope_answer_granularity_contract version="1">',
    "Match Scope breadth and detail to the exact request. The eight-dimension bound is a ceiling, never a target, and evidence volume never creates answer requirements.",
    "For an explicit exhaustive, all/every, complete-list, separately-named, or multi-part request, retain every materially distinct requested item. For a non-exhaustive overview, role, influence, significance, or general how/why request, author the smallest non-overlapping set of high-importance answer tasks whose union explains the requested relationship at that granularity.",
    "A narrower example, repeated instance, proof branch, parameter case, or implementation detail is evidence for a broader task rather than another required dimension unless the request asks for that detail or it adds a distinct mechanism, constraint, trade-off, or outcome needed for the answer. Do not create one dimension per relevant evidence unit.",
    "Preserve epistemic force and attribution as material semantic slots. Distinguish an established or observed result from an author's belief, expectation, conjecture, estimate, possibility, limitation, unknown, or statement whose proof is omitted. A task that promotes qualified evidence into an unqualified fact is not entailed by its atoms.",
    "When a qualified statement is a direct requirement, describe the faithful answer task, including whose position it is and the qualification that changes its truth conditions. Do not promote, suppress, or average away uncertainty merely to make a task easier to answer.",
    "These rules select answer granularity and preserve source meaning; they do not authorize an answer, a server inference, external knowledge, or a benchmark-specific expectation.",
    "</aiqsa_knowledge_coverage_scope_answer_granularity_contract>"
  ].join("\n"));

export const KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_coverage_scope_completeness_answer_granularity_contract version="1">',
    "Audit completeness at the exact request's breadth and detail. Missing means necessary to answer that request at its requested granularity, not merely another relevant fact present in the atoms. The remaining Scope capacity is a ceiling, never a quota.",
    "For explicit exhaustive or separately named requests, append every omitted requested item. For a non-exhaustive overview, role, influence, significance, or general how/why request, do not append redundant examples, repeated instances, narrower subcases, proof branches, or background after the smallest non-overlapping high-importance task set already explains the requested relationship.",
    "Epistemic force and attribution are part of completeness. An accepted item that turns a belief, expectation, conjecture, estimate, possibility, limitation, unknown, or omitted proof into an established fact does not cover the faithful requirement. When that requirement is material, append a qualified task from the exact atoms without rewriting the accepted item; the independent Selector may exclude the overclaim.",
    "Do not append stylistic detail, manufacture uncertainty, or weaken an explicit exhaustive request. Apply the same boundary across every domain and never infer expected content from benchmark metadata or reference answers.",
    "</aiqsa_knowledge_coverage_scope_completeness_answer_granularity_contract>"
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

/** Current blind Scope prompt. V29 remains byte-exact; this wrapper adds only
 * model-owned answer-granularity and epistemic-fidelity instructions. */
export function knowledgeCoverageScopePromptV6AnswerGranularityV1(
  input: Parameters<typeof knowledgeCoverageScopePromptV6QueryIntentV1>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopePromptV6QueryIntentV1(input);
  return Object.freeze({
    systemPrompt: appendContract(
      base.systemPrompt,
      KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1
    ),
    userPrompt: base.userPrompt
  });
}

export function decodeKnowledgeCoverageScopePromptV6AnswerGranularityV1(
  input: Parameters<typeof decodeKnowledgeCoverageScopePromptV6QueryIntentV1>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopePromptV6QueryIntentV1> {
  const baseSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1
  );
  if (baseSystemPrompt === null) return null;
  return decodeKnowledgeCoverageScopePromptV6QueryIntentV1({
    ...input,
    systemPrompt: baseSystemPrompt
  });
}

/** Current append-only completeness prompt. The V1 payload/schema and existing
 * operation count stay unchanged; V29 prompt bytes remain historical. */
export function knowledgeCoverageScopeCompletenessPromptV3(
  input: Parameters<typeof knowledgeCoverageScopeCompletenessPromptV2>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopeCompletenessPromptV2(input);
  return Object.freeze({
    systemPrompt: appendContract(
      base.systemPrompt,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1
    ),
    userPrompt: base.userPrompt
  });
}

export function decodeKnowledgeCoverageScopeCompletenessPromptV3(
  input: Parameters<typeof decodeKnowledgeCoverageScopeCompletenessPromptV2>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopeCompletenessPromptV2> {
  const baseSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1
  );
  if (baseSystemPrompt === null) return null;
  return decodeKnowledgeCoverageScopeCompletenessPromptV2({
    ...input,
    systemPrompt: baseSystemPrompt
  });
}
