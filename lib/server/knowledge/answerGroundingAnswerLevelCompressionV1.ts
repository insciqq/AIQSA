import {
  knowledgeAnswerTargetedSupplementPromptV6,
  knowledgeGroundedDeltaSelectorPromptV5,
  knowledgeGroundedSelectorPromptV21RelevanceFidelityV1
} from "./answerGroundingRelevanceFidelityV1";

export const KNOWLEDGE_ANSWER_LEVEL_COMPRESSION_VERSION = 1 as const;

export const KNOWLEDGE_TARGETED_SUPPLEMENT_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_targeted_supplement_answer_level_compression_contract version="1">',
    "Return the smallest source-explicit proposition set that closes each target at the exact request's granularity. Prefer an answer-level summary stated by the atoms over copying its subordinate examples, rows, parameter values, formula terms, proof steps, or exception inventory.",
    "For a broad non-exhaustive request, preserve that a result is conjectural, conditional, limited, or excludes specified cases, but do not enumerate every subordinate case unless the request or target independently requires the members or exact values. When the atoms state only a list header or an incomplete inventory, use a supported general summary if present; never emit a partial list, placeholder such as 'the stated values', or reconstructed remainder.",
    "A target's maxClaims is a ceiling. Stop as soon as the minimal supported answer-level relation and its truth-conditional qualifications are expressed. Do not spend remaining slots on narrower detail merely because it is available.",
    "Compression never authorizes dropping uncertainty, attribution, a necessary condition, contradiction, explicit exhaustive member, or co-equal key point.",
    "</aiqsa_knowledge_targeted_supplement_answer_level_compression_contract>"
  ].join("\n"));

export const KNOWLEDGE_GROUNDED_SELECTOR_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_grounded_selector_answer_level_compression_contract version="1">',
    "Adjudicate target closure at the exact request's answer-level granularity. For a broad non-exhaustive request, a source-explicit summary claim may satisfy a generic key point or qualification without reproducing every example, record row, parameter value, formula term, proof step, or member of an unrequested inventory.",
    "Preserving that a result is conjectural, conditional, limited, or excludes specified cases is material; enumerating all subordinate cases is material only when the request or faithful answer-level target explicitly requires the members or exact values. Never require a partial list, list header, or placeholder to close a broad key point.",
    "Do not use compression to accept a claim that drops uncertainty, attribution, a necessary condition, contradiction, explicit exhaustive member, or co-equal key point. Exact support and target provenance remain mandatory, and unsupported subordinate text remains unsupported even when the target can be closed by a different supported summary claim.",
    "Apply the rule consistently to initial, repair, and final target-only verification. It grants no server-side promotion, external knowledge, reference-answer authority, or benchmark-specific exception.",
    "</aiqsa_knowledge_grounded_selector_answer_level_compression_contract>"
  ].join("\n"));

function appendContract(
  prompt: Readonly<{ systemPrompt: string; userPrompt: string }>,
  contract: string
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  return Object.freeze({
    systemPrompt: `${prompt.systemPrompt}\n\n${contract}`,
    userPrompt: prompt.userPrompt
  });
}

/** Current Supplement prompt; Snapshot V30's V6 bytes remain historical. */
export function knowledgeAnswerTargetedSupplementPromptV7(
  input: Parameters<typeof knowledgeAnswerTargetedSupplementPromptV6>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  return appendContract(
    knowledgeAnswerTargetedSupplementPromptV6(input),
    KNOWLEDGE_TARGETED_SUPPLEMENT_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1
  );
}

/** Current initial/repair Selector prompt with unchanged authority and payload. */
export function knowledgeGroundedSelectorPromptV21AnswerLevelCompressionV1(
  input: Parameters<typeof knowledgeGroundedSelectorPromptV21RelevanceFidelityV1>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  return appendContract(
    knowledgeGroundedSelectorPromptV21RelevanceFidelityV1(input),
    KNOWLEDGE_GROUNDED_SELECTOR_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1
  );
}

/** Current final target-only verifier with no extra evidence or operation. */
export function knowledgeGroundedDeltaSelectorPromptV6(
  input: Parameters<typeof knowledgeGroundedDeltaSelectorPromptV5>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  return appendContract(
    knowledgeGroundedDeltaSelectorPromptV5(input),
    KNOWLEDGE_GROUNDED_SELECTOR_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1
  );
}
