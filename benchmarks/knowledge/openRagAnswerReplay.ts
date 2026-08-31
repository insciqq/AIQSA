import { randomUUID } from "node:crypto";
import type { ModelRunUsage } from "../../lib/domain/modelRunEvents";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import {
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
  KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION,
  decodeKnowledgeAnswerDraftAcceptedResultForPair,
  decodeKnowledgeAnswerDraftSupplementAcceptedResultV1,
  decodeKnowledgeCoveragePlanAcceptedResultV1,
  decodeKnowledgeGroundedSelectorV8,
  decodeKnowledgeSelectorFailureV3,
  isKnowledgeDraftMalformed,
  knowledgeSelectorEvidenceFromManifest,
  mergeKnowledgeAnswerDraftsV1,
  settleKnowledgeAnswerV5,
  type KnowledgeAnswerDraftSelectorInput,
  type KnowledgeAnswerOperationRequestSnapshotV1
} from "../../lib/server/knowledge/answerGroundingV5";
import {
  executeKnowledgeAnswerGroundingV8,
  type KnowledgeAnswerOperationExecutionV8
} from "../../lib/server/knowledge/answerGroundingExecutionV5";
import {
  KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V1,
  type KnowledgeAnswerOperationRequestSnapshotV21
} from "../../lib/server/knowledge/answerGroundingV21";
import {
  executeKnowledgeAnswerGroundingV21,
  type KnowledgeAnswerOperationExecutionV21
} from "../../lib/server/knowledge/answerGroundingExecutionV21";
import {
  decodeKnowledgeEvidenceDispatchManifestDraft,
  type KnowledgeEvidenceDispatchManifestDraft
} from "../../lib/server/knowledge/evidenceDispatchManifest";
import {
  decodeKnowledgeGroundingEffectiveExecutionPolicyV1,
  type KnowledgeGroundingEffectiveExecutionPolicyV1
} from "../../lib/server/knowledge/groundingExecutionPolicy";
import type { KnowledgeProviderDispatchLifecycle } from
  "../../lib/server/knowledge/providerDispatchLifecycle";
import type {
  ProviderStructuredOutputOptions,
  ProviderStructuredOutputRequest
} from "../../lib/server/providers/structuredOutput";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../lib/server/providers/runtimeFactory";
import type {
  OpenRagAnswerCase,
  OpenRagAnswerEnginePin
} from "./openRagAnswerContract";
import {
  decodeOpenRagAnswerEnginePin,
  sha256Canonical
} from "./openRagAnswerContract";
import type { OpenRagAnswerStageRecord } from "./openRagAnswerCheckpoint";

export const OPEN_RAG_ANSWER_REPLAY_SCHEMA_VERSION = 2 as const;

export type OpenRagAnswerReplayContracts = Readonly<{
  coverageAuditorContractVersion: number | null;
  draftContractVersion: number;
  selectorContractVersion: number;
  settlementVersion: number;
}>;

export type OpenRagAnswerReplayEvidenceBinding = Readonly<{
  dispatchEvidenceId: string;
  evidenceItemId: string;
  handle: string;
  sourceArtifactId: string;
  sourceId: string;
  sourceVersionId: string;
}>;

export type OpenRagAnswerReplayOrigin = Readonly<{
  baseFingerprint: string;
  engine: OpenRagAnswerEnginePin;
  sourceBindingFingerprint: string;
}>;

export type OpenRagAnswerReplaySnapshot = Readonly<{
  answerExecutionSnapshot: ProviderExecutionSnapshot;
  capturedAt: string;
  case: OpenRagAnswerCase;
  contracts: OpenRagAnswerReplayContracts;
  evidence: KnowledgeEvidenceDispatchManifestDraft;
  evidenceBindings: readonly OpenRagAnswerReplayEvidenceBinding[];
  executionPolicy: KnowledgeGroundingEffectiveExecutionPolicyV1 | null;
  forbiddenIdentityFragments: readonly string[];
  origin: OpenRagAnswerReplayOrigin;
  originalRunId: string;
  reasoningEffort: string | null;
  request: string;
  routeInstruction: string;
  schemaVersion: typeof OPEN_RAG_ANSWER_REPLAY_SCHEMA_VERSION;
  snapshotHash: string;
  transport: "native_strict" | "provider_neutral_json";
}>;

export type OpenRagAnswerReplayResult = Readonly<{
  acceptedResults: readonly Readonly<{
    operation: string;
    output: Readonly<Record<string, unknown>>;
  }>[];
  citedEvidence: readonly Readonly<{
    handle: string;
    locator: string | null;
    providerEvidence: string;
    providerEvidenceTruncated: false;
    sourceLabel: string | null;
  }>[];
  contracts: OpenRagAnswerReplayContracts;
  coverage: "complete" | "none" | "partial";
  finalText: string;
  operationCount: number;
  stageRecords: readonly OpenRagAnswerStageRecord[];
}>;

export type OpenRagReplayStructuredExecutor = (
  snapshot: ProviderExecutionSnapshot,
  request: ProviderStructuredOutputRequest,
  options: ProviderStructuredOutputOptions
) => Promise<Record<string, unknown>>;

type CapturedOperation = Readonly<{
  acceptedRequest:
    | KnowledgeAnswerOperationRequestSnapshotV1
    | KnowledgeAnswerOperationRequestSnapshotV21;
  acceptedResult: Readonly<Record<string, unknown>>;
  durationMs: number;
  operation: string;
  ordinal: number;
  providerResponseId: string | null;
  usage: ModelRunUsage;
}>;

const snapshotKeys = Object.freeze([
  "answerExecutionSnapshot",
  "capturedAt",
  "case",
  "contracts",
  "evidence",
  "evidenceBindings",
  "executionPolicy",
  "forbiddenIdentityFragments",
  "origin",
  "originalRunId",
  "reasoningEffort",
  "request",
  "routeInstruction",
  "schemaVersion",
  "snapshotHash",
  "transport"
] as const);
const contractKeys = Object.freeze([
  "coverageAuditorContractVersion",
  "draftContractVersion",
  "selectorContractVersion",
  "settlementVersion"
] as const);
const evidenceBindingKeys = Object.freeze([
  "dispatchEvidenceId",
  "evidenceItemId",
  "handle",
  "sourceArtifactId",
  "sourceId",
  "sourceVersionId"
] as const);
const originKeys = Object.freeze([
  "baseFingerprint",
  "engine",
  "sourceBindingFingerprint"
] as const);
const caseKeys = Object.freeze([
  "caseId",
  "documentAlias",
  "evaluationMode",
  "goldSectionId",
  "kind",
  "question",
  "referenceAnswer",
  "source",
  "type"
] as const);
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

const zeroUsage: ModelRunUsage = Object.freeze({
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function replayPipeline(
  contracts: OpenRagAnswerReplayContracts
): "v20_v16" | "v21_audit_v1" | null {
  if (contracts.coverageAuditorContractVersion === null &&
    contracts.draftContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16.draftContractVersion &&
    contracts.selectorContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16.selectorContractVersion &&
    contracts.settlementVersion === 5) return "v20_v16";
  if (contracts.coverageAuditorContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V1.coverageAuditorContractVersion &&
    contracts.draftContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V1.draftContractVersion &&
    contracts.selectorContractVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V1.selectorContractVersion &&
    contracts.settlementVersion ===
      KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V1.settlementVersion) {
    return "v21_audit_v1";
  }
  return null;
}

function exactSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function isOpenRagAnswerOperationSequence(
  contracts: OpenRagAnswerReplayContracts,
  operations: readonly string[]
): boolean {
  const pipeline = replayPipeline(contracts);
  if (pipeline === "v20_v16") {
    const pair = KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16;
    const base = [
      pair.coveragePlannerOperation!,
      pair.draftOperation,
      pair.selectorOperation
    ];
    return [
      base,
      [...base, pair.finalSelectorOperation!],
      [...base, pair.supplementalDraftOperation!],
      [...base, pair.supplementalDraftOperation!, pair.finalSelectorOperation!]
    ].some((candidate) => exactSequence(operations, candidate));
  }
  if (pipeline === "v21_audit_v1") {
    const pair = KNOWLEDGE_ANSWER_CONTRACT_PAIR_V21_V17_AUDIT_V1;
    const base = [pair.draftOperation, pair.selectorOperation];
    const repaired = [...base, pair.selectorOperation];
    return [base, repaired].some((prefix) => [
      [...prefix, pair.coverageAuditorOperation],
      [...prefix, pair.coverageAuditorOperation, pair.supplementalDraftOperation],
      [
        ...prefix,
        pair.coverageAuditorOperation,
        pair.supplementalDraftOperation,
        pair.finalSelectorOperation
      ]
    ].some((candidate) => exactSequence(operations, candidate)));
  }
  return false;
}

function contractsFromEngine(
  engine: OpenRagAnswerEnginePin
): OpenRagAnswerReplayContracts {
  const contracts = Object.freeze({
    coverageAuditorContractVersion: engine.coverageAuditorContractVersion,
    draftContractVersion: engine.draftContractVersion,
    selectorContractVersion: engine.selectorContractVersion,
    settlementVersion: engine.settlementVersion
  });
  if (!replayPipeline(contracts)) {
    throw new Error("open_rag_answer_replay_snapshot_invalid");
  }
  return contracts;
}

function decodeCase(value: unknown): OpenRagAnswerCase | null {
  if (!isRecord(value) || !hasExactKeys(value, caseKeys) ||
    typeof value.caseId !== "string" || !/^doc-[0-9]{3}-q[1-8]$/u.test(value.caseId) ||
    typeof value.documentAlias !== "string" ||
      !/^doc-[0-9]{3}$/u.test(value.documentAlias) ||
    !value.caseId.startsWith(`${value.documentAlias}-q`) ||
    value.evaluationMode !== "open_rag_reference_answer" ||
    !Number.isSafeInteger(value.goldSectionId) || Number(value.goldSectionId) < 0 ||
    value.kind !== "fact" && value.kind !== "table" ||
    typeof value.question !== "string" || !value.question.trim() ||
      value.question.includes("\u0000") ||
      Buffer.byteLength(value.question, "utf8") > 64 * 1_024 ||
    typeof value.referenceAnswer !== "string" || !value.referenceAnswer.trim() ||
      value.referenceAnswer.includes("\u0000") ||
      Buffer.byteLength(value.referenceAnswer, "utf8") > 64 * 1_024 ||
    !["text", "text-image", "text-table", "text-table-image"].includes(
      String(value.source)
    ) || !["abstractive", "extractive"].includes(String(value.type))) return null;
  return Object.freeze({
    caseId: value.caseId,
    documentAlias: value.documentAlias,
    evaluationMode: "open_rag_reference_answer",
    goldSectionId: Number(value.goldSectionId),
    kind: value.kind,
    question: value.question,
    referenceAnswer: value.referenceAnswer,
    source: value.source as OpenRagAnswerCase["source"],
    type: value.type as OpenRagAnswerCase["type"]
  });
}

function replaySnapshotBody(input: Omit<OpenRagAnswerReplaySnapshot, "snapshotHash">) {
  return input;
}

export function createOpenRagAnswerReplaySnapshot(
  input: Omit<
    OpenRagAnswerReplaySnapshot,
    "contracts" | "schemaVersion" | "snapshotHash"
  >
): OpenRagAnswerReplaySnapshot {
  const evidence = decodeKnowledgeEvidenceDispatchManifestDraft(input.evidence);
  if (!evidence) throw new Error("open_rag_answer_replay_snapshot_invalid");
  const engine = decodeOpenRagAnswerEnginePin(input.origin.engine);
  const executionPolicy = input.executionPolicy === null
    ? null
    : decodeKnowledgeGroundingEffectiveExecutionPolicyV1(input.executionPolicy);
  if (input.executionPolicy !== null && !executionPolicy) {
    throw new Error("open_rag_answer_replay_snapshot_invalid");
  }
  const body = Object.freeze({
    ...input,
    answerExecutionSnapshot: normalizeProviderExecutionSnapshot(
      input.answerExecutionSnapshot
    ),
    contracts: contractsFromEngine(engine),
    evidence,
    evidenceBindings: Object.freeze(input.evidenceBindings.map((binding) =>
      Object.freeze({ ...binding }))),
    forbiddenIdentityFragments: Object.freeze([...input.forbiddenIdentityFragments]),
    executionPolicy,
    origin: Object.freeze({
      baseFingerprint: input.origin.baseFingerprint,
      engine,
      sourceBindingFingerprint: input.origin.sourceBindingFingerprint
    }),
    schemaVersion: OPEN_RAG_ANSWER_REPLAY_SCHEMA_VERSION
  });
  return decodeOpenRagAnswerReplaySnapshot(Object.freeze({
    ...body,
    snapshotHash: sha256Canonical(body)
  }));
}

export function decodeOpenRagAnswerReplaySnapshot(
  value: unknown
): OpenRagAnswerReplaySnapshot {
  const code = "open_rag_answer_replay_snapshot_invalid";
  if (!isRecord(value) || !hasExactKeys(value, snapshotKeys) ||
    value.schemaVersion !== OPEN_RAG_ANSWER_REPLAY_SCHEMA_VERSION ||
    typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt)) ||
    typeof value.originalRunId !== "string" || !safeIdPattern.test(value.originalRunId) ||
    typeof value.request !== "string" || !value.request.trim() ||
      Buffer.byteLength(value.request, "utf8") > 64 * 1_024 ||
    typeof value.routeInstruction !== "string" || !value.routeInstruction.trim() ||
      Buffer.byteLength(value.routeInstruction, "utf8") > 16 * 1_024 ||
    value.routeInstruction !== KNOWLEDGE_FOCUSED_DRAFT_ROUTE_INSTRUCTION ||
    !isRecord(value.contracts) || !hasExactKeys(value.contracts, contractKeys) ||
    value.contracts.coverageAuditorContractVersion !== null &&
      !Number.isSafeInteger(value.contracts.coverageAuditorContractVersion) ||
    !Number.isSafeInteger(value.contracts.draftContractVersion) ||
    !Number.isSafeInteger(value.contracts.selectorContractVersion) ||
    !Number.isSafeInteger(value.contracts.settlementVersion) ||
    value.reasoningEffort !== null && (typeof value.reasoningEffort !== "string" ||
      !value.reasoningEffort.trim() || value.reasoningEffort.length > 32) ||
    value.transport !== "native_strict" && value.transport !== "provider_neutral_json" ||
    !Array.isArray(value.forbiddenIdentityFragments) ||
      value.forbiddenIdentityFragments.length > 1_000 ||
    value.forbiddenIdentityFragments.some((fragment) => typeof fragment !== "string" ||
      fragment.length < 1 || fragment.length > 512) ||
    new Set(value.forbiddenIdentityFragments).size !==
      value.forbiddenIdentityFragments.length ||
    !isRecord(value.origin) || !hasExactKeys(value.origin, originKeys) ||
    typeof value.origin.baseFingerprint !== "string" ||
      !sha256Pattern.test(value.origin.baseFingerprint) ||
    typeof value.origin.sourceBindingFingerprint !== "string" ||
      !sha256Pattern.test(value.origin.sourceBindingFingerprint) ||
    !Array.isArray(value.evidenceBindings) || value.evidenceBindings.length < 1 ||
      value.evidenceBindings.length > 1_000 ||
    value.evidenceBindings.some((binding) => !isRecord(binding) ||
      !hasExactKeys(binding, evidenceBindingKeys) ||
      evidenceBindingKeys.some((key) => typeof binding[key] !== "string" ||
        !safeIdPattern.test(binding[key] as string))) ||
    typeof value.snapshotHash !== "string" || !sha256Pattern.test(value.snapshotHash)) {
    throw new Error(code);
  }
  const replayCase = decodeCase(value.case);
  const evidence = decodeKnowledgeEvidenceDispatchManifestDraft(value.evidence);
  const contracts = Object.freeze({
    coverageAuditorContractVersion:
      value.contracts.coverageAuditorContractVersion as number | null,
    draftContractVersion: Number(value.contracts.draftContractVersion),
    selectorContractVersion: Number(value.contracts.selectorContractVersion),
    settlementVersion: Number(value.contracts.settlementVersion)
  });
  const pipeline = replayPipeline(contracts);
  let answerExecutionSnapshot: ProviderExecutionSnapshot;
  let engine: OpenRagAnswerEnginePin;
  try {
    answerExecutionSnapshot = normalizeProviderExecutionSnapshot(value.answerExecutionSnapshot);
    engine = decodeOpenRagAnswerEnginePin(value.origin.engine);
  } catch {
    throw new Error(code);
  }
  if (!replayCase || !evidence || !pipeline) throw new Error(code);
  if (value.request !== replayCase.question) throw new Error(code);
  const evidenceBindings = (value.evidenceBindings as Record<string, string>[]).map(
    (binding): OpenRagAnswerReplayEvidenceBinding => Object.freeze({
      dispatchEvidenceId: binding.dispatchEvidenceId!,
      evidenceItemId: binding.evidenceItemId!,
      handle: binding.handle!,
      sourceArtifactId: binding.sourceArtifactId!,
      sourceId: binding.sourceId!,
      sourceVersionId: binding.sourceVersionId!
    })
  );
  const evidenceByHandle = new Map(evidence.items.map((item) => [item.handle, item]));
  if (evidenceBindings.length !== evidence.items.length ||
    new Set(evidenceBindings.map(({ handle }) => handle)).size !==
      evidenceBindings.length ||
    new Set(evidenceBindings.map(({ dispatchEvidenceId }) => dispatchEvidenceId)).size !==
      evidenceBindings.length ||
    new Set(evidenceBindings.map(({ evidenceItemId }) => evidenceItemId)).size !==
      evidenceBindings.length ||
    evidenceBindings.some((binding) =>
      evidenceByHandle.get(binding.handle)?.evidenceId !== binding.dispatchEvidenceId)) {
    throw new Error(code);
  }
  const executionPolicy = value.executionPolicy === null
    ? null
    : decodeKnowledgeGroundingEffectiveExecutionPolicyV1(value.executionPolicy);
  if (value.executionPolicy !== null && !executionPolicy ||
    pipeline === "v20_v16" && (executionPolicy !== null ||
      engine.groundingEvidenceVersion !== 16) ||
    pipeline === "v21_audit_v1" && (engine.groundingEvidenceVersion === 18
      ? !executionPolicy || value.reasoningEffort !== null
      : engine.groundingEvidenceVersion === 17
        ? executionPolicy !== null
        : true) ||
    engine.coverageAuditorContractVersion !==
      contracts.coverageAuditorContractVersion ||
    engine.draftContractVersion !== contracts.draftContractVersion ||
    engine.selectorContractVersion !== contracts.selectorContractVersion ||
    engine.settlementVersion !== contracts.settlementVersion ||
    engine.evidencePackingVersion !== evidence.packingVersion) {
    throw new Error(code);
  }
  const body = Object.freeze({
    answerExecutionSnapshot,
    capturedAt: value.capturedAt,
    case: replayCase,
    contracts,
    evidence,
    evidenceBindings: Object.freeze(evidenceBindings),
    executionPolicy,
    forbiddenIdentityFragments: Object.freeze([
      ...value.forbiddenIdentityFragments as string[]
    ]),
    origin: Object.freeze({
      baseFingerprint: value.origin.baseFingerprint,
      engine,
      sourceBindingFingerprint: value.origin.sourceBindingFingerprint
    }),
    originalRunId: value.originalRunId,
    reasoningEffort: value.reasoningEffort as string | null,
    request: value.request,
    routeInstruction: value.routeInstruction,
    schemaVersion: OPEN_RAG_ANSWER_REPLAY_SCHEMA_VERSION,
    transport: value.transport
  });
  if (sha256Canonical(replaySnapshotBody(body)) !== value.snapshotHash) {
    throw new Error(code);
  }
  return Object.freeze({ ...body, snapshotHash: value.snapshotHash });
}

function replayLifecycle(captured: CapturedOperation[]): KnowledgeProviderDispatchLifecycle {
  const preparedById = new Map<string, Readonly<{
    acceptedRequest:
      | KnowledgeAnswerOperationRequestSnapshotV1
      | KnowledgeAnswerOperationRequestSnapshotV21;
    operation: string;
    ordinal: number;
    startedAt: number;
  }>>();
  const lifecycle = {
    async inspect() {
      return null;
    },
    async prepare(input: Readonly<{
      acceptedRequest?: Readonly<Record<string, unknown>>;
      modelRunId: string;
      ordinal: number;
      purpose: string;
    }>) {
      if (!input.acceptedRequest) throw new Error("open_rag_replay_request_missing");
      const attemptId = randomUUID();
      preparedById.set(attemptId, {
        acceptedRequest: input.acceptedRequest as
          | KnowledgeAnswerOperationRequestSnapshotV1
          | KnowledgeAnswerOperationRequestSnapshotV21,
        operation: input.purpose,
        ordinal: input.ordinal,
        startedAt: Date.now()
      });
      return {
        dispatch: {},
        identity: {
          attemptId,
          checkpointHash: "0".repeat(64),
          idempotencyKey: `open-rag-replay:${input.ordinal}:${attemptId}`,
          manifestHash: "0".repeat(64),
          modelRunId: input.modelRunId,
          providerBindingKey: "answer",
          requestHash: sha256Canonical(input.acceptedRequest)
        },
        leaseToken: attemptId
      };
    },
    async recover() {
      return { kind: "not_found" };
    },
    async dispatch() {},
    async settle(prepared: Readonly<{ identity: Readonly<{ attemptId: string }> }>, input: Readonly<{
      acceptedResult?: Readonly<Record<string, unknown>>;
      providerResponseId?: string | null;
      usage: ModelRunUsage;
    }>) {
      const pending = preparedById.get(prepared.identity.attemptId);
      if (!pending || !input.acceptedResult) throw new Error("open_rag_replay_settlement_invalid");
      captured.push(Object.freeze({
        acceptedRequest: pending.acceptedRequest,
        acceptedResult: input.acceptedResult,
        durationMs: Math.max(0, Date.now() - pending.startedAt),
        operation: pending.operation,
        ordinal: pending.ordinal,
        providerResponseId: input.providerResponseId ?? null,
        usage: input.usage
      }));
    },
    async release() {},
    async markAmbiguous() {}
  };
  return lifecycle as unknown as KnowledgeProviderDispatchLifecycle;
}

function settleCapturedV20(
  snapshot: OpenRagAnswerReplaySnapshot,
  captured: readonly CapturedOperation[]
) {
  const pair = KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16;
  const evidence = knowledgeSelectorEvidenceFromManifest(snapshot.evidence);
  const byOrdinal = new Map(captured.map((operation) => [operation.ordinal, operation]));
  const planner = byOrdinal.get(1);
  const primaryOperation = byOrdinal.get(2);
  const initialOperation = byOrdinal.get(3);
  if (captured.length < 3 || captured.length > 5 || byOrdinal.size !== captured.length ||
    [...byOrdinal.keys()].some((ordinal) => ordinal < 1 || ordinal > 5) ||
    !planner || !primaryOperation ||
    !initialOperation || planner.operation !== pair.coveragePlannerOperation ||
    primaryOperation.operation !== pair.draftOperation ||
    initialOperation.operation !== pair.selectorOperation) {
    throw new Error("open_rag_replay_operation_set_invalid");
  }
  const coveragePlan = decodeKnowledgeCoveragePlanAcceptedResultV1(planner.acceptedResult);
  if (!coveragePlan || "kind" in coveragePlan) {
    throw new Error("open_rag_replay_coverage_plan_invalid");
  }
  const validationInput = {
    availableHandles: evidence.map(({ handle }) => handle),
    forbiddenIdentityFragments: snapshot.forbiddenIdentityFragments
  };
  const primaryDraft = decodeKnowledgeAnswerDraftAcceptedResultForPair(
    primaryOperation.acceptedResult,
    validationInput,
    pair
  );
  if (!primaryDraft) throw new Error("open_rag_replay_draft_invalid");
  let finalDraft: KnowledgeAnswerDraftSelectorInput = primaryDraft;
  let finalOperation = initialOperation;
  const adaptiveOperation = byOrdinal.get(4);
  const terminalSelectorOperation = byOrdinal.get(5);
  if (adaptiveOperation?.operation === pair.supplementalDraftOperation) {
    const supplement = decodeKnowledgeAnswerDraftSupplementAcceptedResultV1(
      adaptiveOperation.acceptedResult,
      validationInput
    );
    if (!supplement) throw new Error("open_rag_replay_supplement_invalid");
    if (!isKnowledgeDraftMalformed(supplement)) {
      if (!terminalSelectorOperation ||
        terminalSelectorOperation.operation !== pair.finalSelectorOperation) {
        throw new Error("open_rag_replay_final_selector_missing");
      }
      finalDraft = mergeKnowledgeAnswerDraftsV1({ primary: primaryDraft, supplement });
      finalOperation = terminalSelectorOperation;
    } else if (terminalSelectorOperation) {
      throw new Error("open_rag_replay_operation_set_invalid");
    }
  } else if (adaptiveOperation?.operation === pair.finalSelectorOperation) {
    if (terminalSelectorOperation) throw new Error("open_rag_replay_operation_set_invalid");
    finalOperation = adaptiveOperation;
  } else if (adaptiveOperation || terminalSelectorOperation) {
    throw new Error("open_rag_replay_operation_set_invalid");
  }
  const failure = decodeKnowledgeSelectorFailureV3(finalOperation.acceptedResult);
  const selector = failure
    ? null
    : decodeKnowledgeGroundedSelectorV8(finalOperation.acceptedResult, {
        coveragePlan,
        draft: finalDraft,
        evidence
      });
  if (!failure && !selector) throw new Error("open_rag_replay_selector_invalid");
  return settleKnowledgeAnswerV5({
    draft: finalDraft,
    evidence,
    selector: failure
      ? { kind: "failed", reason: failure.reason }
      : { kind: "accepted", value: selector! }
  });
}

function citedEvidence(
  finalText: string,
  evidence: KnowledgeEvidenceDispatchManifestDraft
): OpenRagAnswerReplayResult["citedEvidence"] {
  const handles = [...new Set(
    [...finalText.matchAll(/\[(K[1-9][0-9]{0,3})\]/gu)].map((match) => match[1]!)
  )];
  const byHandle = new Map(evidence.items.map((item) => [item.handle, item]));
  return Object.freeze(handles.map((handle) => {
    const item = byHandle.get(handle);
    if (!item) throw new Error("open_rag_replay_cited_evidence_missing");
    return Object.freeze({
      handle,
      locator: item.locator || null,
      providerEvidence: item.text,
      providerEvidenceTruncated: false as const,
      sourceLabel: item.sourceLabel || null
    });
  }));
}

export async function replayOpenRagAnswerSnapshot(input: Readonly<{
  executeStructuredOutput: OpenRagReplayStructuredExecutor;
  signal?: AbortSignal;
  snapshot: OpenRagAnswerReplaySnapshot;
}>): Promise<OpenRagAnswerReplayResult> {
  const snapshot = decodeOpenRagAnswerReplaySnapshot(input.snapshot);
  const captured: CapturedOperation[] = [];
  const lifecycle = replayLifecycle(captured);
  const modelRunId = `open-rag-replay:${randomUUID()}`;
  const evidenceBindings = snapshot.evidenceBindings.map((binding) => Object.freeze({
    dispatchEvidenceId: binding.dispatchEvidenceId,
    evidenceItemId: binding.evidenceItemId
  }));
  const authorize = async () => {
    if (input.signal?.aborted) throw input.signal.reason;
  };
  const shouldAbort = (error: unknown) => input.signal?.aborted === true ||
    error instanceof DOMException && error.name === "AbortError";
  const execute = async (
    request: ProviderStructuredOutputRequest,
    options: Readonly<{ providerResponseId: string | null }>
  ): Promise<KnowledgeAnswerOperationExecutionV8 & KnowledgeAnswerOperationExecutionV21> => {
    let providerResponseId: string | null = options.providerResponseId;
    let usage = zeroUsage;
    const output = await input.executeStructuredOutput(
      snapshot.answerExecutionSnapshot,
      request,
      {
        onProviderResponseId: (value) => {
          providerResponseId = value;
        },
        onUsage: (value) => {
          usage = value;
        },
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: 15 * 60 * 1_000
      }
    );
    return Object.freeze({ output, providerResponseId, usage });
  };
  const pipeline = replayPipeline(snapshot.contracts);
  if (!pipeline) throw new Error("open_rag_replay_contract_invalid");
  let operations: readonly Readonly<{ operation: string }>[];
  let settlement: ReturnType<typeof settleKnowledgeAnswerV5>;
  if (pipeline === "v20_v16") {
    const result = await executeKnowledgeAnswerGroundingV8({
      authorize,
      contractPair: KNOWLEDGE_ANSWER_CONTRACT_PAIR_V20_V16,
      draft: snapshot.evidence,
      evidenceBindings,
      execute,
      forbiddenIdentityFragments: snapshot.forbiddenIdentityFragments,
      lifecycle,
      modelRunId,
      reasoningEffort: snapshot.reasoningEffort,
      request: snapshot.request,
      routeInstruction: snapshot.routeInstruction,
      shouldAbort,
      transport: snapshot.transport
    });
    operations = result.operations;
    settlement = settleCapturedV20(snapshot, captured);
  } else {
    const result = await executeKnowledgeAnswerGroundingV21({
      authorize,
      draft: snapshot.evidence,
      evidenceBindings,
      execute,
      forbiddenIdentityFragments: snapshot.forbiddenIdentityFragments,
      lifecycle,
      modelRunId,
      ...(snapshot.executionPolicy
        ? { executionPolicy: snapshot.executionPolicy }
        : { reasoningEffort: snapshot.reasoningEffort }),
      request: snapshot.request,
      routeInstruction: snapshot.routeInstruction,
      shouldAbort,
      transport: snapshot.transport
    });
    operations = result.operations;
    settlement = result.settlement;
  }
  const ordered = [...captured].sort((left, right) => left.ordinal - right.ordinal);
  if (ordered.length !== operations.length ||
    ordered.some((operation, index) =>
      operation.operation !== operations[index]?.operation) ||
    !isOpenRagAnswerOperationSequence(
      snapshot.contracts,
      ordered.map(({ operation }) => operation)
    )) {
    throw new Error("open_rag_replay_operation_set_invalid");
  }
  return Object.freeze({
    acceptedResults: Object.freeze(ordered.map(({ acceptedResult, operation }) =>
      Object.freeze({ operation, output: acceptedResult }))),
    citedEvidence: citedEvidence(settlement.finalText, snapshot.evidence),
    contracts: snapshot.contracts,
    coverage: settlement.requestCoverage,
    finalText: settlement.finalText,
    operationCount: operations.length,
    stageRecords: Object.freeze(ordered.map((operation): OpenRagAnswerStageRecord => {
      const usage = normalizeTokenUsage(operation.usage);
      return Object.freeze({
        durationMs: operation.durationMs,
        providerResponseId: operation.providerResponseId,
        requestHash: sha256Canonical(operation.acceptedRequest),
        resultHash: sha256Canonical(operation.acceptedResult),
        stage: operation.operation,
        usage: Object.freeze({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          totalTokens: usage.totalTokens
        })
      });
    }))
  });
}
