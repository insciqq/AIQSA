import { STRUCTURED_OUTPUT_LIMITS } from "../providers/structuredOutput";
import { structuredOutputPromptFits } from "../providers/structuredOutputLimits";
import {
  KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES,
  knowledgeAnswerCanonicalJson,
  knowledgeAnswerHash
} from "./answerGroundingV5";
import {
  KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V21,
  KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
  KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS
} from "./answerGroundingV21";
import { knowledgeAnswerDraftPromptV21GlobalReducerV1 } from "./answerGroundingGlobalReducerV1";
import { KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1 } from "./answerGroundingDraftFacetAtomizationV1";
import { KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V7, KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V2 } from "./coverageScopeV7";
import { KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V22 } from "./answerGroundingSelectorV22";
import { KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V3 } from "./coverageScopeClosureV3";
import { isKnowledgeCorrectionSchemaV22 } from "./answerGroundingCorrectionV22";
import {
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  knowledgeGroundingReasoningEffortForRoleV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1,
  type KnowledgeGroundingExecutionRole
} from "./groundingExecutionPolicy";
import type { KnowledgeEvidenceDispatchManifestDraft } from "./evidenceDispatchManifest";

export const KNOWLEDGE_ANSWER_CONTRIBUTION_PROTOCOL_V1 =
  "scope_v7_pending_v1_occurrence_atoms_v3_contributions_v1_additive_correction_v2_publication_plan_v1" as const;
const draftProvenanceContract = "Preserve separate requested source/actor bindings even when their factual text is identical. Separate source-bound candidates may have identical text with different citation hints. One shared candidate may answer several requirements only when its complete provenance supports that same assertion for each; do not fuse their source identities.";

export function knowledgeAnswerDraftPromptV40(input: Parameters<typeof knowledgeAnswerDraftPromptV21GlobalReducerV1>[0]) {
  const prompt = knowledgeAnswerDraftPromptV21GlobalReducerV1(input);
  return Object.freeze({ ...prompt, systemPrompt: `${prompt.systemPrompt}\n\n${draftProvenanceContract}` });
}
export const KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V22 = "knowledge_grounded_selector_v22" as const;
export const KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V22 = "knowledge_grounded_selector_final_v22" as const;
export const KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V22 = "knowledge_answer_draft_supplement_v22" as const;
export const KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION_V3 = "knowledge_coverage_scope_closure_v3" as const;
export const KNOWLEDGE_ANSWER_CONTRIBUTION_CONTRACTS_V1 = Object.freeze({
  coverageAuditorContractVersion: 7,
  draftContractVersion: 21,
  selectorContractVersion: 22,
  settlementVersion: 7
} as const);

export type KnowledgeAnswerOperationV40 =
  | "knowledge_answer_draft_v21"
  | "knowledge_coverage_scope_v7"
  | "knowledge_coverage_scope_completeness_v2"
  | typeof KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V22
  | typeof KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V22
  | typeof KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V22
  | typeof KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION_V3;

export type KnowledgeAnswerOperationRequestSnapshotV40 = Readonly<{
  contractVersion: 2 | 3 | 7 | 21 | 22;
  coverageScopePayloadHash: string | null;
  evidenceReceiptHash: string;
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1;
  maxOutputTokens: number;
  name: KnowledgeAnswerOperationV40;
  operation: KnowledgeAnswerOperationV40;
  pipeline: typeof KNOWLEDGE_ANSWER_CONTRIBUTION_PROTOCOL_V1;
  reasoningEffort: string | null;
  schema: Readonly<Record<string, unknown>>;
  schemaHash: string;
  systemPrompt: string;
  tools: "none";
  transport: "native_strict" | "provider_neutral_json";
  userPrompt: string;
  version: 40;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Resolve schemas inside the function: the historical Draft owner also routes
// decoding here, and no schema may depend on circular module initialization.
function metadata(operation: string): Readonly<{
  contractVersion: KnowledgeAnswerOperationRequestSnapshotV40["contractVersion"];
  operation: KnowledgeAnswerOperationV40;
  payload: boolean;
  role: KnowledgeGroundingExecutionRole;
  schema: Readonly<Record<string, unknown>> | "supplement" | "delta";
}> | null {
  switch (operation) {
    case "knowledge_answer_draft_v21":
      return { contractVersion: 21, operation, payload: false, role: "draft", schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21 };
    case "knowledge_coverage_scope_v7":
      return { contractVersion: 7, operation, payload: false, role: "auditor", schema: KNOWLEDGE_COVERAGE_SCOPE_SCHEMA_V7 };
    case "knowledge_coverage_scope_completeness_v2":
      return { contractVersion: 2, operation, payload: true, role: "auditor", schema: KNOWLEDGE_COVERAGE_SCOPE_COMPLETENESS_SCHEMA_V2 };
    case KNOWLEDGE_GROUNDED_SELECTOR_OPERATION_V22:
      return { contractVersion: 22, operation, payload: true, role: "selector", schema: KNOWLEDGE_GROUNDED_SELECTOR_SCHEMA_V22 };
    case KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_OPERATION_V3:
      return { contractVersion: 3, operation, payload: true, role: "auditor", schema: KNOWLEDGE_COVERAGE_SCOPE_CLOSURE_SCHEMA_V3 };
    case KNOWLEDGE_ANSWER_DRAFT_SUPPLEMENT_OPERATION_V22:
      return { contractVersion: 22, operation, payload: true, role: "supplement", schema: "supplement" };
    case KNOWLEDGE_GROUNDED_SELECTOR_FINAL_OPERATION_V22:
      return { contractVersion: 22, operation, payload: true, role: "selector", schema: "delta" };
    default: return null;
  }
}

export function createKnowledgeAnswerOperationRequestSnapshotV40(input: Readonly<{
  contractVersion: number;
  coverageScopePayloadHash?: string | null;
  evidenceReceiptHash: string;
  executionPolicy?: KnowledgeGroundingEffectiveExecutionPolicyV1;
  maxOutputTokens: number;
  operation: string;
  reasoningEffort?: string | null;
  schema: Readonly<Record<string, unknown>>;
  systemPrompt: string;
  transport: "native_strict" | "provider_neutral_json";
  userPrompt: string;
}>): KnowledgeAnswerOperationRequestSnapshotV40 {
  const entry = metadata(input.operation);
  const executionPolicy = decodeKnowledgeGroundingEffectiveExecutionPolicyV1(input.executionPolicy);
  const coverageScopePayloadHash = input.coverageScopePayloadHash ?? null;
  if (!entry || !executionPolicy || input.reasoningEffort !== undefined ||
    input.contractVersion !== entry.contractVersion ||
    entry.payload !== (coverageScopePayloadHash !== null) ||
    coverageScopePayloadHash !== null && !/^[0-9a-f]{64}$/u.test(coverageScopePayloadHash) ||
    !/^[0-9a-f]{64}$/u.test(input.evidenceReceiptHash) ||
    !record(input.schema) || Buffer.byteLength(JSON.stringify(input.schema), "utf8") > STRUCTURED_OUTPUT_LIMITS.maxSchemaBytes ||
    (typeof entry.schema === "string" ? !isKnowledgeCorrectionSchemaV22(input.schema, entry.schema)
      : knowledgeAnswerHash(input.schema) !== knowledgeAnswerHash(entry.schema)) ||
    !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < STRUCTURED_OUTPUT_LIMITS.minOutputTokens ||
    input.maxOutputTokens > STRUCTURED_OUTPUT_LIMITS.maxOutputTokens ||
    input.transport !== "native_strict" && input.transport !== "provider_neutral_json" ||
    typeof input.systemPrompt !== "string" || !input.systemPrompt.trim() ||
    typeof input.userPrompt !== "string" || !input.userPrompt.trim() || !structuredOutputPromptFits(input)) {
    throw new Error("knowledge_answer_operation_request_invalid");
  }
  const snapshot: KnowledgeAnswerOperationRequestSnapshotV40 = Object.freeze({
    contractVersion: entry.contractVersion,
    coverageScopePayloadHash,
    evidenceReceiptHash: input.evidenceReceiptHash,
    executionPolicy,
    maxOutputTokens: input.maxOutputTokens,
    name: entry.operation,
    operation: entry.operation,
    pipeline: KNOWLEDGE_ANSWER_CONTRIBUTION_PROTOCOL_V1,
    reasoningEffort: knowledgeGroundingReasoningEffortForRoleV1(executionPolicy, entry.role),
    schema: input.schema,
    schemaHash: knowledgeAnswerHash(input.schema),
    systemPrompt: input.systemPrompt,
    tools: "none",
    transport: input.transport,
    userPrompt: input.userPrompt,
    version: 40
  });
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > KNOWLEDGE_ANSWER_ACCEPTED_REQUEST_MAX_BYTES) {
    throw new Error("knowledge_answer_operation_request_invalid");
  }
  return snapshot;
}

export function decodeKnowledgeAnswerOperationRequestSnapshotV40(value: unknown): KnowledgeAnswerOperationRequestSnapshotV40 | null {
  if (!record(value) || value.version !== 40) return null;
  try {
    const { reasoningEffort: _reasoningEffort, ...fields } = value;
    const expected = createKnowledgeAnswerOperationRequestSnapshotV40(
      fields as Parameters<typeof createKnowledgeAnswerOperationRequestSnapshotV40>[0]
    );
    return knowledgeAnswerCanonicalJson(expected) === knowledgeAnswerCanonicalJson(value) ? expected : null;
  } catch { return null; }
}

export function decodeKnowledgeAnswerDraftPrimaryPromptV40(input: Readonly<{
  draft: KnowledgeEvidenceDispatchManifestDraft;
  snapshot: KnowledgeAnswerOperationRequestSnapshotV40;
}>): Readonly<{ request: string; routeInstruction: string }> | null {
  if (input.snapshot.operation !== "knowledge_answer_draft_v21") return null;
  const prefix = `${KNOWLEDGE_ANSWER_DRAFT_CONTRACT_V21}\n\n`;
  const suffix = `\n\n${KNOWLEDGE_ANSWER_DRAFT_COEQUAL_FACET_ATOMIZATION_CONTRACT_V1}\n\n${draftProvenanceContract}`;
  if (!input.snapshot.systemPrompt.startsWith(prefix) || !input.snapshot.systemPrompt.endsWith(suffix)) return null;
  const routeInstruction = input.snapshot.systemPrompt.slice(prefix.length, -suffix.length);
  try {
    const payload: unknown = JSON.parse(input.snapshot.userPrompt);
    if (!record(payload) || typeof payload.request !== "string" || !payload.request.trim()) return null;
    const prompt = knowledgeAnswerDraftPromptV40({
      draftPass: "primary", evidenceManifest: input.draft.message, request: payload.request, routeInstruction
    });
    const expected = createKnowledgeAnswerOperationRequestSnapshotV40({
      contractVersion: 21,
      evidenceReceiptHash: input.draft.manifestHash,
      executionPolicy: input.snapshot.executionPolicy,
      maxOutputTokens: KNOWLEDGE_ANSWER_DRAFT_V21_MAX_OUTPUT_TOKENS,
      operation: "knowledge_answer_draft_v21",
      schema: KNOWLEDGE_ANSWER_DRAFT_SCHEMA_V21,
      transport: input.snapshot.transport,
      ...prompt
    });
    return knowledgeAnswerCanonicalJson(expected) === knowledgeAnswerCanonicalJson(input.snapshot)
      ? Object.freeze({ request: payload.request, routeInstruction }) : null;
  } catch { return null; }
}
