import {
  decodeKnowledgeCoverageScopeCompletenessPromptV1,
  knowledgeCoverageScopeCompletenessPromptV1
} from "./coverageScopeCompletenessV1";
import {
  decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1,
  knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1
} from "./coverageScopeMultiDiagnosticRepairV1";

export const KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_VERSION = 1 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1 = Object.freeze([
  '<aiqsa_knowledge_coverage_scope_query_intent_contract version="1">',
  "Preserve every semantic operator in the exact request when authoring final Scope findings. A complete set of finding descriptions, if answered, must answer each requested fact, explanation, mechanism, comparison, relation, calculation, enumeration, condition, limitation, or other operation rather than merely repeat its topic.",
  "For why, how, explain, account-for, rationale, or equivalent requests, restating a premise, conclusion, recommendation, suitability judgment, outcome, or correlation is not the requested explanation. Author the evidence-backed answer task that preserves the material connector between the relevant operands, such as the supported cause, mechanism, enabling condition, trade-off, constraint, or consequence. Choose only the relation the assigned atoms entail; these examples are relation classes, never required answer content.",
  "If the requested connector and its operands are entailed inside one evidence unit, keep one complete local finding. Use a joint finding only when its complete relation is inseparable across multiple K handles. If the exact request requires a semantic operator that no supplied atom supports, represent that request facet as unsupported instead of weakening it to a related fact.",
  "Descriptions remain private answer tasks: name the semantic operation and all material slots needed to answer it, but do not assert an answer or manufacture a relation. Do not add explanation, comparison, or background to a direct factual request that does not ask for it.",
  "The question form is a completeness boundary, not a style preference. Lexical overlap, evidence presence, or a proposition that appears in the request never substitutes for the requested relation.",
  "</aiqsa_knowledge_coverage_scope_query_intent_contract>"
].join("\n"));

export const KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1 =
  Object.freeze([
    '<aiqsa_knowledge_coverage_scope_completeness_query_intent_contract version="1">',
    "Audit acceptedScope against every semantic operator in the exact request, not only its named entities, topics, or propositions. The union is complete only when answering its descriptions would perform every requested fact, explanation, mechanism, comparison, relation, calculation, enumeration, condition, limitation, or other operation.",
    "For why, how, explain, account-for, rationale, or equivalent requests, an accepted item that merely restates a premise, conclusion, recommendation, suitability judgment, outcome, or correlation does not cover the requested explanation. When supplied atoms entail the omitted connector, append a distinct answer task for the supported cause, mechanism, enabling condition, trade-off, constraint, consequence, or other entailed relation. When none do, append the explicitly requested unsupported facet. Never rewrite the accepted item.",
    "Preserve all material operands and qualifiers of the requested semantic operator. Component facts, lexical overlap, evidence presence, and a proposition copied from the request do not replace the relation that makes the answer responsive.",
    "Do not add stylistic elaboration or generic background, and do not demand an explanation for a direct factual request that does not ask for one. Relation classes in this contract are generic audit categories, never answer content or quotas.",
    "</aiqsa_knowledge_coverage_scope_completeness_query_intent_contract>"
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

/** Current blind-Scope prompt. The historical V28 prompt remains byte-exact
 * in coverageScopeMultiDiagnosticRepairV1; this append-only wrapper changes
 * only model instructions and grants no new data or server semantic authority. */
export function knowledgeCoverageScopePromptV6QueryIntentV1(
  input: Parameters<typeof knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1(input);
  return Object.freeze({
    systemPrompt: appendContract(
      base.systemPrompt,
      KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1
    ),
    userPrompt: base.userPrompt
  });
}

export function decodeKnowledgeCoverageScopePromptV6QueryIntentV1(
  input: Parameters<
    typeof decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1
  >[0]
): ReturnType<typeof decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1> {
  const baseSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1
  );
  if (baseSystemPrompt === null) return null;
  return decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1({
    ...input,
    systemPrompt: baseSystemPrompt
  });
}

/** Current append-only completeness prompt. It retains the V1 payload/schema
 * and one existing audit call while strengthening only the query-intent rule. */
export function knowledgeCoverageScopeCompletenessPromptV2(
  input: Parameters<typeof knowledgeCoverageScopeCompletenessPromptV1>[0]
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const base = knowledgeCoverageScopeCompletenessPromptV1(input);
  return Object.freeze({
    systemPrompt: appendContract(
      base.systemPrompt,
      KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1
    ),
    userPrompt: base.userPrompt
  });
}

export function decodeKnowledgeCoverageScopeCompletenessPromptV2(
  input: Parameters<typeof decodeKnowledgeCoverageScopeCompletenessPromptV1>[0]
): ReturnType<typeof decodeKnowledgeCoverageScopeCompletenessPromptV1> {
  const baseSystemPrompt = stripContract(
    input.systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1
  );
  if (baseSystemPrompt === null) return null;
  return decodeKnowledgeCoverageScopeCompletenessPromptV1({
    ...input,
    systemPrompt: baseSystemPrompt
  });
}
