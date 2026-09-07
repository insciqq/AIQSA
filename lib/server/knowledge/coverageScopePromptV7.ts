import { knowledgeAnswerCanonicalJson, knowledgeAnswerHash } from "./answerGroundingV5";
import { knowledgeCoverageScopePromptV6, knowledgeCoverageAtomContextContract, KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS,
  type KnowledgeCoverageScopeValidationFailureReasonV6 } from "./coverageScopeV6";
import { knowledgeCoverageScopeCompletenessPromptV1 } from "./coverageScopeCompletenessV1";
import { KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1 } from "./coverageScopeQueryIntentV1";
import { KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1 } from "./coverageScopeAnswerGranularityV1";
import { KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1 } from "./coverageScopeAnswerGranularityV2";
import { KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_CONTRACT_V1 } from "./coverageScopeRecallMapV1";
import { KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1, knowledgeCoverageRequestAnchorIndexV1 } from "./coverageScopeRequestAnchorIdsV1";
import { knowledgeCoverageRequestAnchorIndexV2 } from "./coverageScopeRequestAnchorIdsV2";
import { KNOWLEDGE_SCOPE_PENDING_MAX, knowledgeScopeWithoutOverflow, type KnowledgeCoverageScopeV7 } from "./coverageScopeV7";
import { KNOWLEDGE_COVERAGE_SCOPE_PARTIAL_EVIDENCE_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_PARTIAL_EVIDENCE_CONTRACT_V1 } from "./coverageScopePartialEvidenceV1";

const overflowContract = [
  '<aiqsa_knowledge_request_overflow_contract version="1">',
  "The active Scope capacity remains eight independently checkable requirements. It does not limit the number of inseparable values inside one requirement. Keep date/value/unit associations intact; split independently requested Sources, comparison members, counts and trends. Never regroup or weaken the request merely to evade capacity.",
  "If more than eight independent requirements are known, retain eight active dimensions and put the additional exact request tasks in overflow.pending. Pending tasks are unprocessed, never excluded, answered or unsupported merely because they exceed capacity. Every pending item uses a supplied Q ID as requestAnchor and a bounded answer-task description, with no evidence IDs or factual assertions.",
  "Return at most eight new pending tasks. Set overflow.unparsedRemainder=true if additional tasks cannot be listed within that bound or the request cannot be completely analyzed. Do not invent an exact count of omitted tasks. Otherwise return false. An empty pending array alone never certifies completeness when that flag is true.",
  "Completeness may only append active dimensions within remainingCapacity or add new pending tasks after active capacity fills. Its overflow.pending contains new tasks only. Existing pending tasks and an accepted incomplete-analysis flag are immutable and cannot be erased, promoted or hidden by an empty response. Empty additions means no additional active item, not necessarily a completely analyzed request.",
  "Scope output uses version 7 and Completeness output uses version 2, both with the required version-1 overflow object. No overflow is represented by pending=[] and unparsedRemainder=false. A structural repair is one fresh complete output over the same immutable input and the content-free repairReason; no rejected candidate or transient repair base is required.",
  "</aiqsa_knowledge_request_overflow_contract>"
].join("\n");
const boundedAnchorContract = "The version-2 requestAnchorIndex contains only control-free exact spans. It is a bounded locator index, not a substitute for the complete request. Descriptions must be unique across all evidence units and joint or unsupported findings: distinguish different requested tasks or Source bindings, while repeated evidence for the same task does not create another requirement. Use the description to state the complete answer task, including essential constraints; the selected Q fragment is only its locator.";
const requestOutcomeContract = [
  "Identify the user's desired result and essential conditions before assigning findings to evidence. An unsuccessful attempted implementation is context, not authority to replace that desired result with the attempted approach. Preserve the behavior shown by the requested output and do not invent constraints from a failing operation or its arguments.",
  "The primary requested outcome belongs in active Scope before supporting definitions, examples or error explanations. Never put that outcome in overflow while active dimensions are occupied by those subordinate details. Pending capacity is for additional independent requested tasks, not a substitute for analyzing the main goal.",
  "A retrieved API definition, parameter example, or repeated documentation excerpt is not a separately requested task merely because it is relevant background. Do not invent Source-specific requests such as explaining a first or second excerpt when the user did not ask for those Sources separately. Preserve actual separately requested actors and Source bindings.",
  "Check the union of proposed tasks against the complete request: would answering them deliver the requested method, relationship or result under its essential conditions? If a required outcome lacks evidence, retain that outcome as an active unsupported dimension instead of replacing it with a related supported fact. An explanation of why the attempted approach fails cannot erase the task of finding a working approach.",
  "Descriptions remain unique, bounded answer tasks, and Q IDs remain exact locators only. These priorities add no factual claim, provenance transfer, answer verdict or server semantic inference."
].join("\n");

const occurrenceFindingContract = "Descriptions are human-readable task labels, not identities. Equal descriptions may occur for different exact request anchors or different assigned atom sets, including independent Sources and distinct row occurrences. Preserve their original provenance; do not invent a different task merely to make its wording unique. An exact repeat of description, request anchor and atom set is invalid. The same rule applies across accepted Scope and completeness additions. This grants no semantic deduplication or provenance transfer: the global Selector still owns redundancy reduction and factual support.";
const structuralRepairGuidance: Partial<Record<KnowledgeCoverageScopeValidationFailureReasonV6, string>> = {
  coverage_scope_finding_duplicate: "Return one finding for each exact description, request anchor and atom-set tuple. Do not repeat that identical finding; retain different anchors or provenance without renaming their actual tasks.",
  coverage_scope_finding_shape_invalid: "Each local or joint finding has exactly description, requestAnchor and evidenceAtomIds. Each unsupportedDimensions entry has only description and requestAnchor. Follow the supplied schema and add no private IDs, statuses, handles or other fields to a finding.",
  coverage_scope_atom_count_invalid: `A positive finding needs one to ${KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAtomsPerDimension} supplied atom IDs. Put a requested task with no supporting atom in unsupportedDimensions instead of an empty positive finding. Retain only the bounded atoms needed for the complete task; do not invent coverage.`,
  coverage_scope_atom_duplicate: "Each finding's evidenceAtomIds must contain distinct supplied A IDs. List a needed atom once while preserving distinct occurrence IDs even when their text is equal.",
  coverage_scope_atom_id_invalid: "Use only exact A IDs from the supplied evidence atom index. Do not use K, U, Q or L IDs, ranges, bracketed forms, or an invented atom number.",
  coverage_scope_atom_source_mismatch: "A finding inside one evidenceUnits entry may use only A IDs owned by that exact entry's K handle. Use jointFindings only for an inseparable requested relation supported across multiple handles; never move or relabel an atom to another Source.",
  coverage_scope_joint_sources_invalid: `A joint finding requires atoms from at least two and at most ${KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceHandles} different K handles. A one-handle finding belongs inside that evidenceUnits entry. Preserve every operand needed for a true joint relation.`
};
function repairContract(reason: KnowledgeCoverageScopeValidationFailureReasonV6 | undefined, partialEvidence = false): readonly string[] {
  let guidance = reason ? structuralRepairGuidance[reason] : undefined;
  if (guidance && partialEvidence) guidance = guidance
    .replace("no supporting atom", "no directly useful full or partial evidence atom")
    .replace("needed for the complete task", "that directly address all or part of the full task")
    .replace("supported across multiple handles", "with directly useful full or partial evidence across multiple handles")
    .replace("Preserve every operand needed for a true joint relation.", "Preserve the exact provenance of the available useful parts without inventing missing operands or the relation.");
  return guidance ? [`Structural repair requirement: ${guidance}`] : [];
}

function workflowContracts(workflowVersion: 2 | 3 | 4 | 5 | 6 | 7 | undefined): readonly string[] {
  if (workflowVersion === 6) return [requestOutcomeContract.replace("Descriptions remain unique, bounded answer tasks",
    "Descriptions remain bounded answer tasks"), occurrenceFindingContract];
  return workflowVersion === 4 || workflowVersion === 5 ? [requestOutcomeContract] : workflowVersion !== undefined ? [boundedAnchorContract] : [];
}

export function knowledgeCoverageScopePromptV7(
  input: Omit<Parameters<typeof knowledgeCoverageScopePromptV6>[0], "atomIndexVersion"> & Readonly<{ workflowVersion?: 2 | 3 | 4 | 5 | 6 | 7 }>
) {
  const { workflowVersion, ...baseInput } = input;
  const base = knowledgeCoverageScopePromptV6({ ...baseInput, atomIndexVersion: 3 });
  if (workflowVersion === 7) return Object.freeze({
    systemPrompt: [KNOWLEDGE_COVERAGE_SCOPE_PARTIAL_EVIDENCE_CONTRACT_V1,
      knowledgeCoverageAtomContextContract(3), KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1,
      overflowContract, occurrenceFindingContract, ...repairContract(input.repairReason, true)].join("\n\n"),
    userPrompt: knowledgeAnswerCanonicalJson({ ...JSON.parse(base.userPrompt),
      maximumPendingRequirements: KNOWLEDGE_SCOPE_PENDING_MAX,
      requestAnchorIndex: knowledgeCoverageRequestAnchorIndexV2(input.request),
      taskReminder: "Map each requested outcome to evidence that fully or partially addresses it; leave wholly unsupported outcomes unbound. Apply the supplied structural repairReason when present.",
      version: 7 })
  });
  let systemPrompt = base.systemPrompt.replace('<aiqsa_knowledge_coverage_scope_contract version="6">',
    '<aiqsa_knowledge_coverage_scope_contract version="7">')
    .replace("return at most eight total dimensions.", "return at most eight active dimensions and retain additional independent tasks in overflow.");
  if (workflowVersion === 6) systemPrompt = systemPrompt.replace("Scope descriptions must be unique, bounded", "Scope descriptions must be bounded");
  return Object.freeze({ systemPrompt: [systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_QUERY_INTENT_CONTRACT_V1, KNOWLEDGE_COVERAGE_SCOPE_ANSWER_GRANULARITY_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_SCOPE_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1, KNOWLEDGE_COVERAGE_SCOPE_RECALL_MAP_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1, overflowContract,
    ...workflowContracts(workflowVersion), ...repairContract(input.repairReason)].join("\n\n"),
  userPrompt: knowledgeAnswerCanonicalJson({ ...JSON.parse(base.userPrompt),
    maximumPendingRequirements: KNOWLEDGE_SCOPE_PENDING_MAX,
    requestAnchorIndex: (workflowVersion !== undefined ? knowledgeCoverageRequestAnchorIndexV2 : knowledgeCoverageRequestAnchorIndexV1)(input.request), version: 7 }) });
}

export function knowledgeCoverageScopeCompletenessPromptV2(input:
  Omit<Parameters<typeof knowledgeCoverageScopeCompletenessPromptV1>[0], "acceptedScope" | "atomIndexVersion"> &
  Readonly<{ acceptedScope: KnowledgeCoverageScopeV7; workflowVersion?: 2 | 3 | 4 | 5 | 6 | 7 }>
) {
  const { workflowVersion, ...baseInput } = input;
  const base = knowledgeCoverageScopeCompletenessPromptV1({ ...baseInput,
    acceptedScope: knowledgeScopeWithoutOverflow(input.acceptedScope), atomIndexVersion: 3 });
  if (workflowVersion === 7) return Object.freeze({
    systemPrompt: [KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_PARTIAL_EVIDENCE_CONTRACT_V1,
      knowledgeCoverageAtomContextContract(3), KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1,
      overflowContract, occurrenceFindingContract].join("\n\n"),
    userPrompt: knowledgeAnswerCanonicalJson({ ...JSON.parse(base.userPrompt),
      acceptedScope: input.acceptedScope, acceptedScopePayloadHash: knowledgeAnswerHash(input.acceptedScope),
      maximumPendingRequirements: KNOWLEDGE_SCOPE_PENDING_MAX,
      remainingPendingCapacity: KNOWLEDGE_SCOPE_PENDING_MAX - input.acceptedScope.overflow.pending.length,
      requestAnchorIndex: knowledgeCoverageRequestAnchorIndexV2(input.request),
      taskReminder: "Append only omitted request tasks or directly useful evidence bindings. A full task already bound to partial evidence does not need a duplicate unsupported copy. Apply the supplied structural repairReason when present.",
      version: 2 })
  });
  let systemPrompt = base.systemPrompt.replace('<aiqsa_knowledge_coverage_scope_completeness_contract version="1">',
    '<aiqsa_knowledge_coverage_scope_completeness_contract version="2">')
    .replace("An empty additions array means the accepted Scope is already complete.",
      "An empty additions array means no new active dimension; pending requirements and incomplete analysis remain explicit in overflow.");
  if (workflowVersion === 6) systemPrompt = systemPrompt.replace("Descriptions must be unique across acceptedScope and additions, bounded", "Descriptions must be bounded");
  return Object.freeze({ systemPrompt: [systemPrompt,
    KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_QUERY_INTENT_CONTRACT_V1, KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_GRANULARITY_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_ANSWER_LEVEL_COMPRESSION_CONTRACT_V1,
    KNOWLEDGE_COVERAGE_REQUEST_ANCHOR_IDS_CONTRACT_V1, overflowContract,
    ...workflowContracts(workflowVersion)].join("\n\n"),
  userPrompt: knowledgeAnswerCanonicalJson({ ...JSON.parse(base.userPrompt),
    acceptedScope: input.acceptedScope, acceptedScopePayloadHash: knowledgeAnswerHash(input.acceptedScope),
    maximumPendingRequirements: KNOWLEDGE_SCOPE_PENDING_MAX,
    remainingPendingCapacity: KNOWLEDGE_SCOPE_PENDING_MAX - input.acceptedScope.overflow.pending.length,
    requestAnchorIndex: (workflowVersion !== undefined ? knowledgeCoverageRequestAnchorIndexV2 : knowledgeCoverageRequestAnchorIndexV1)(input.request), version: 2 }) });
}
