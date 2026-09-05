import { knowledgeAnswerCanonicalJson, knowledgeAnswerHash } from "./answerGroundingV5";
import { knowledgeCoverageScopePromptV6 } from "./coverageScopeV6";
import { knowledgeCoverageScopeCompletenessPromptV1 } from "./coverageScopeCompletenessV1";
import { KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1 } from "./coverageScopeQueryIntentV1";
import { KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1 } from "./coverageScopeAnswerGranularityV1";
import { KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 } from "./coverageScopeAnswerGranularityV2";
import { KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_CONTRACT_V1 } from "./coverageScopeRecallMapV1";
import { KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1, knowledgeCoverageRequestAnchorIndexV1 } from "./coverageScopeRequestAnchorIdsV1";
import { KNOWLEDGE_SCOPE_PENDING_MAX, knowledgeScopeWithoutOverflow, type KnowledgeCoverageScopeV7 } from "./coverageScopeV7";

const overflowContract = [
  '<aiqsa_knowledge_request_overflow_contract version="1">',
  "The active Scope capacity remains eight independently checkable requirements. It does not limit the number of inseparable values inside one requirement. Keep date/value/unit associations intact; split independently requested Sources, comparison members, counts and trends. Never regroup or weaken the request merely to evade capacity.",
  "If more than eight independent requirements are known, retain eight active dimensions and put the additional exact request tasks in overflow.pending. Pending tasks are unprocessed, never excluded, answered or unsupported merely because they exceed capacity. Every pending item uses a supplied Q ID as requestAnchor and a bounded answer-task description, with no evidence IDs or factual assertions.",
  "Return at most eight new pending tasks. Set overflow.unparsedRemainder=true if additional tasks cannot be listed within that bound or the request cannot be completely analyzed. Do not invent an exact count of omitted tasks. Otherwise return false. An empty pending array alone never certifies completeness when that flag is true.",
  "Completeness may only append active dimensions within remainingCapacity or add new pending tasks after active capacity fills. Its overflow.pending contains new tasks only. Existing pending tasks and an accepted incomplete-analysis flag are immutable and cannot be erased, promoted or hidden by an empty response. Empty additions means no additional active item, not necessarily a completely analyzed request.",
  "Scope output uses version 7 and Completeness output uses version 2, both with the required version-1 overflow object. No overflow is represented by pending=[] and unparsedRemainder=false. A structural repair is one fresh complete output over the same immutable input and the content-free repairReason; no rejected candidate or transient repair base is required.",
  "</aiqsa_knowledge_request_overflow_contract>"
].join("\n");

export function knowledgeCoverageScopePromptV7(
  input: Omit<Parameters<typeof knowledgeCoverageScopePromptV6>[0], "atomIndexVersion">
) {
  const base = knowledgeCoverageScopePromptV6({ ...input, atomIndexVersion: 3 });
  const systemPrompt = base.systemPrompt.replace('<aiqsa_knowledge_coverage_scope_contract version="6">',
    '<aiqsa_knowledge_coverage_scope_contract version="7">')
    .replace("return at most eight total dimensions.", "return at most eight active dimensions and retain additional independent tasks in overflow.");
  return Object.freeze({ systemPrompt: [systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1, KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1, KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1, overflowContract].join("\n\n"),
  userPrompt: knowledgeAnswerCanonicalJson({ ...JSON.parse(base.userPrompt),
    maximumPendingRequirements: KNOWLEDGE_SCOPE_PENDING_MAX,
    requestAnchorIndex: knowledgeCoverageRequestAnchorIndexV1(input.request), version: 7 }) });
}

export function knowledgeCoverageScopeCompletenessPromptV2(input:
  Omit<Parameters<typeof knowledgeCoverageScopeCompletenessPromptV1>[0], "acceptedScope" | "atomIndexVersion"> &
  Readonly<{ acceptedScope: KnowledgeCoverageScopeV7 }>
) {
  const base = knowledgeCoverageScopeCompletenessPromptV1({ ...input,
    acceptedScope: knowledgeScopeWithoutOverflow(input.acceptedScope), atomIndexVersion: 3 });
  const systemPrompt = base.systemPrompt.replace('<aiqsa_knowledge_coverage_scope_completeness_contract version="1">',
    '<aiqsa_knowledge_coverage_scope_completeness_contract version="2">')
    .replace("An empty additions array means the accepted Scope is already complete.",
      "An empty additions array means no new active dimension; pending requirements and incomplete analysis remain explicit in overflow.");
  return Object.freeze({ systemPrompt: [systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1, KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1, overflowContract].join("\n\n"),
  userPrompt: knowledgeAnswerCanonicalJson({ ...JSON.parse(base.userPrompt),
    acceptedScope: input.acceptedScope, acceptedScopePayloadHash: knowledgeAnswerHash(input.acceptedScope),
    maximumPendingRequirements: KNOWLEDGE_SCOPE_PENDING_MAX,
    remainingPendingCapacity: KNOWLEDGE_SCOPE_PENDING_MAX - input.acceptedScope.overflow.pending.length,
    requestAnchorIndex: knowledgeCoverageRequestAnchorIndexV1(input.request), version: 2 }) });
}
