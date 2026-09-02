import {
  knowledgeAnswerTargetedSupplementPromptV5,
  knowledgeGroundedDeltaSelectorPromptV4
} from "./answerGroundingCorrectionPromptV21";
import {
  knowledgeGroundedSelectorPromptV21RepairDiagnosticV1
} from "./answerGroundingSelectorRepairDiagnosticV1";

export const KNOWLEDGE_ANSWER_RELEVANCE_FIDELITY_VERSION = 1 as const;

export const KNOWLEDGE_TARGETED_SUPPLEMENT_EPISTEMIC_FIDELITY_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_targeted_supplement_epistemic_fidelity_contract version="1">',
    "Epistemic force and attribution are part of every atomic proposition. Preserve whether the target atoms establish or observe a result, attribute a belief or expectation, state a conjecture or estimate, express possibility, report an unknown or limitation, or explicitly omit a proof.",
    "Never turn an author's belief, expectation, conjecture, estimate, may/could statement, open case, or unproved assertion into an established fact. Name the source-side actor when attribution changes the proposition. If the complete qualified proposition does not fit faithfully, omit the overclaim and let the Selector keep the target missing.",
    "Return the smallest faithful claim set required by each exact target. A narrower example or repeated parameter case does not need another claim unless it adds an independently requested relation or a distinct condition required to close that target.",
    "</aiqsa_knowledge_targeted_supplement_epistemic_fidelity_contract>"
  ].join("\n"));

export const KNOWLEDGE_GROUNDED_SELECTOR_RELEVANCE_FIDELITY_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_grounded_selector_relevance_fidelity_contract version="1">',
    "Treat epistemic force and attribution as truth-conditional support. Evidence that only reports a belief, expectation, conjecture, estimate, possibility, unknown, limitation, or omitted proof does not support an unqualified factual claim. A categorical claim that drops such status is unsupported even when every noun and value appears in the evidence.",
    "Apply the same rule to Scope eligibility: exclude a positive Scope item whose description promotes its assigned atoms to stronger certainty or loses a material attribution. A faithful qualified item remains eligible when it is a direct requirement of the request.",
    "Judge materiality at the exact request's granularity. For a non-exhaustive overview, role, influence, significance, or general how/why request, a redundant example, repeated instance, narrow proof branch, or parameter subcase is not independently required merely because it is relevant. Explicit all/every/list, separately named, and multi-part requests retain their requested items.",
    "A literal span may support only a complete directly requested fact at the same epistemic force. Raw fragments, list continuations, and literals requiring synthesis cannot stand in for an explanation, overview, influence, significance, or other derived relation; use only independently supported claims for those tasks.",
    "Never promote coverage, invent a relevance score, or use reference answers or benchmark expectations. Reapply the existing exact support, provenance, eligibility, and immutable-Scope rules.",
    "</aiqsa_knowledge_grounded_selector_relevance_fidelity_contract>"
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

/** Current Supplement prompt. V29's V5 prompt and schema remain byte-exact. */
export function knowledgeAnswerTargetedSupplementPromptV6(
  input: Parameters<typeof knowledgeAnswerTargetedSupplementPromptV5>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  return appendContract(
    knowledgeAnswerTargetedSupplementPromptV5(input),
    KNOWLEDGE_TARGETED_SUPPLEMENT_EPISTEMIC_FIDELITY_CONTRACT_V1
  );
}

/** Current initial/repair Selector prompt with no payload or schema change. */
export function knowledgeGroundedSelectorPromptV21RelevanceFidelityV1(
  input: Parameters<typeof knowledgeGroundedSelectorPromptV21RepairDiagnosticV1>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  return appendContract(
    knowledgeGroundedSelectorPromptV21RepairDiagnosticV1(input),
    KNOWLEDGE_GROUNDED_SELECTOR_RELEVANCE_FIDELITY_CONTRACT_V1
  );
}

/** Current final least-authority Selector prompt with unchanged target-only
 * inputs and output schema. */
export function knowledgeGroundedDeltaSelectorPromptV5(
  input: Parameters<typeof knowledgeGroundedDeltaSelectorPromptV4>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  return appendContract(
    knowledgeGroundedDeltaSelectorPromptV4(input),
    KNOWLEDGE_GROUNDED_SELECTOR_RELEVANCE_FIDELITY_CONTRACT_V1
  );
}
