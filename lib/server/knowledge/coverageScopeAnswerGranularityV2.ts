import {
  decodeKnowledgeCoverageScopeCompletenessPromptV3,
  decodeKnowledgeCoverageScopePromptV6AnswerGranularityV1,
  knowledgeCoverageScopeCompletenessPromptV3,
  knowledgeCoverageScopePromptV6AnswerGranularityV1
} from "./coverageScopeAnswerGranularityV1";
import { knowledgeAnswerCanonicalJson } from "./answerGroundingV5";
import {
  KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1,
  knowledgeCoverageRequestAnchorIndexV1
} from "./coverageScopeRequestAnchorIdsV1";

export const KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_VERSION = 1 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_coverage_scope_answer_level_compression_contract version="1">',
    "Author each broad-query finding at the lowest answer-level abstraction that the atoms state and the request needs. Prefer a source's own summary proposition over its subordinate examples, rows, parameter values, formulas, proof steps, or exception inventory.",
    "Preserve a material condition or epistemic qualification, but do not turn its subordinate enumeration into required answer slots unless the request explicitly asks for the members, exact values, formula, proof, or complete list. For a broad request, 'the result is conjectural and excludes specified degenerate cases' can be the faithful task when the source states that summary; enumerating every excluded case is a different, narrower task.",
    "Never author a compound finding whose direct key point can be answered but whose coverage would depend on an unrequested inventory or placeholder such as 'the listed values'. Split only independently requested or independently important answer-level mechanisms, constraints, trade-offs, and outcomes; otherwise keep one minimally sufficient finding.",
    "This is query-relative compression, not permission to drop uncertainty, a necessary condition, a contradiction, an explicit exhaustive member, or a co-equal key point. It adds no server ranking, inference, answer, or benchmark authority.",
    "</aiqsa_knowledge_coverage_scope_answer_level_compression_contract>"
  ].join("\n"));

export const KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_coverage_scope_completeness_answer_level_compression_contract version="1">',
    "Audit the smallest answer-level key-point set, not the union of every subordinate detail found in the atoms. Prefer a source-stated summary proposition when it faithfully answers the request and retains its material conditions and epistemic force.",
    "Do not append an exact member list, parameter inventory, formula expansion, proof step, record row, example, or exception catalogue merely to elaborate a broad non-exhaustive task. Append such content only when the request asks for it or its members are independently necessary answer-level points.",
    "If accepted Scope already contains a faithful broad key point, ancillary detail cannot create another missing requirement. If accepted Scope only contains narrow examples and capacity remains, append the supported broad key point; accepted items remain immutable and the Selector independently adjudicates them.",
    "Never use compression to erase uncertainty, attribution, a necessary condition, contradiction, explicit exhaustive member, or co-equal mechanism, constraint, trade-off, or outcome.",
    "</aiqsa_knowledge_coverage_scope_completeness_answer_level_compression_contract>"
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendRequestAnchorIndex(userPrompt: string, request: string): string {
  const value = JSON.parse(userPrompt) as unknown;
  if (!record(value) || Object.hasOwn(value, "requestAnchorIndex")) {
    throw new Error("knowledge_coverage_request_anchor_prompt_invalid");
  }
  return knowledgeAnswerCanonicalJson({
    ...value,
    requestAnchorIndex: knowledgeCoverageRequestAnchorIndexV1(request)
  });
}

function stripRequestAnchorIndex(userPrompt: string, request: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(userPrompt) as unknown;
  } catch {
    return null;
  }
  if (!record(value) || knowledgeAnswerCanonicalJson(value.requestAnchorIndex) !==
    knowledgeAnswerCanonicalJson(knowledgeCoverageRequestAnchorIndexV1(request))) {
    return null;
  }
  const { requestAnchorIndex: _requestAnchorIndex, ...base } = value;
  void _requestAnchorIndex;
  return knowledgeAnswerCanonicalJson(base);
}

/** Current blind Scope prompt. Snapshot V30 remains byte-exact. */
export function knowledgeCoverageScopePromptV6AnswerGranularityV2(
  input: Parameters<typeof knowledgeCoverageScopePromptV6AnswerGranularityV1>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopePromptV6AnswerGranularityV1(input);
  return Object.freeze({
    systemPrompt: appendContract(
      appendContract(
        base.systemPrompt,
        KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1
      ),
      KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1
    ),
    userPrompt: appendRequestAnchorIndex(base.userPrompt, input.request)
  });
}

export function decodeKnowledgeCoverageScopePromptV6AnswerGranularityV2(
  input: Parameters<typeof decodeKnowledgeCoverageScopePromptV6AnswerGranularityV1>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopePromptV6AnswerGranularityV1> {
  const compressionSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1
  );
  const baseSystemPrompt = compressionSystemPrompt === null
    ? null
    : stripContract(
        compressionSystemPrompt,
        KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1
      );
  const baseUserPrompt = stripRequestAnchorIndex(input.userPrompt, input.request);
  if (baseSystemPrompt === null || baseUserPrompt === null) return null;
  return decodeKnowledgeCoverageScopePromptV6AnswerGranularityV1({
    ...input,
    systemPrompt: baseSystemPrompt,
    userPrompt: baseUserPrompt
  });
}

/** Current append-only completeness prompt with one bounded server-owned anchor
 * index and no evidence, schema, or call change. Snapshot V30 remains byte-exact. */
export function knowledgeCoverageScopeCompletenessPromptV4(
  input: Parameters<typeof knowledgeCoverageScopeCompletenessPromptV3>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopeCompletenessPromptV3(input);
  return Object.freeze({
    systemPrompt: appendContract(
      appendContract(
        base.systemPrompt,
        KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1
      ),
      KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1
    ),
    userPrompt: appendRequestAnchorIndex(base.userPrompt, input.request)
  });
}

export function decodeKnowledgeCoverageScopeCompletenessPromptV4(
  input: Parameters<typeof decodeKnowledgeCoverageScopeCompletenessPromptV3>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopeCompletenessPromptV3> {
  const compressionSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1
  );
  const baseSystemPrompt = compressionSystemPrompt === null
    ? null
    : stripContract(
        compressionSystemPrompt,
        KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1
      );
  const baseUserPrompt = stripRequestAnchorIndex(input.userPrompt, input.request);
  if (baseSystemPrompt === null || baseUserPrompt === null) return null;
  return decodeKnowledgeCoverageScopeCompletenessPromptV3({
    ...input,
    systemPrompt: baseSystemPrompt,
    userPrompt: baseUserPrompt
  });
}
