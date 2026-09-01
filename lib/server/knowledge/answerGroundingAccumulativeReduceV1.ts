import {
  knowledgeAnswerCanonicalJson
} from "./answerGroundingV5";
import {
  knowledgeGroundedDeltaSelectorPromptV6
} from "./answerGroundingAnswerLevelCompressionV1";
import {
  knowledgeTargetPrimaryClaimsV1
} from "./answerGroundingCorrectionV21";

export const KNOWLEDGE_ANSWER_ACCUMULATIVE_TARGET_REDUCE_VERSION = 1 as const;

export const KNOWLEDGE_GROUNDED_SELECTOR_ACCUMULATIVE_TARGET_REDUCE_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_grounded_selector_accumulative_target_reduce_contract version="1">',
    "This contract supersedes only the earlier prohibition on using primary claim IDs for an initially missing target and the statement that all primary Draft text is absent. targetPrimaryClaims is the sole admitted exception; every other least-authority, immutable-base, target-provenance, and fail-closed rule remains in force.",
    "targetPrimaryClaims contains only primary claims already accepted as supported whose complete accepted support-handle set is contained by one or more initially missing positive targets. These records are candidate map points and protocol state, not factual evidence. targetEvidenceAtomIndex remains the sole factual authority in this operation.",
    "For each target, reduce over its target-bound supplemental claims together with only targetPrimaryClaims whose targetDimensionIds contains that exact D. Revalidate every primary candidate's complete text against that target's exact ordered atoms and exact request before using its ID. A prior supported verdict, handle containment, lexical overlap, or candidate membership alone never establishes target relevance or coverage.",
    "A covered target may map any collectively complete set of revalidated listed primary IDs and supported target-bound supplemental IDs; either source may be absent when the other already closes the target. Their ordered union must entail every material part of the immutable target description. Otherwise keep the target missing.",
    "Copy every primary claim verdict and supportHandles exactly from baseSelector. Never map an unlisted primary ID, change its accepted state, borrow a primary candidate from another target, treat primary text as evidence, or alter non-target coverage. This remains one bounded target-local reduce with no retrieval, generation, or additional operation.",
    "</aiqsa_knowledge_grounded_selector_accumulative_target_reduce_contract>"
  ].join("\n"));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Current V35 target-local reduce over the union of accepted primary map
 * points and generated target deltas. Historical V6 prompt bytes remain exact. */
export function knowledgeGroundedDeltaSelectorPromptV7(
  input: Parameters<typeof knowledgeGroundedDeltaSelectorPromptV6>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeGroundedDeltaSelectorPromptV6(input);
  const payload = JSON.parse(base.userPrompt) as unknown;
  if (!record(payload) || Object.hasOwn(payload, "targetPrimaryClaims")) {
    throw new Error("knowledge_grounded_delta_selector_prompt_invalid");
  }
  return Object.freeze({
    systemPrompt: `${base.systemPrompt}\n\n` +
      KNOWLEDGE_GROUNDED_SELECTOR_ACCUMULATIVE_TARGET_REDUCE_CONTRACT_V1,
    userPrompt: knowledgeAnswerCanonicalJson({
      ...payload,
      targetPrimaryClaims: knowledgeTargetPrimaryClaimsV1({
        draft: input.draft,
        initialSelector: input.initialSelector
      })
    })
  });
}
