import {
  Prisma,
  type ModelRunStatus,
  type ModelRunToolCallState,
  type PrismaClient
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import { decodeKnowledgePlan } from "../../contracts/knowledge";
import {
  searchAdapterKinds,
  searchCredentialModes,
  searchPlanModes,
  searchProtocols
} from "../../domain/search";
import { MCP_FIND_TOOLS_NAME } from "../mcp/discovery";
import { decodeMcpDiscoveryState } from "../mcp/discoveryState";
import {
  KNOWLEDGE_SCOPE_MAX_BINDINGS,
  KNOWLEDGE_SCOPE_MAX_SOURCES,
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED,
  KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
} from "../knowledge/retrievalTypes";
import { decodeKnowledgeBudgetPolicy } from "../knowledge/knowledgeBudget";
import type {
  KnowledgeRunAdmissionExclusion,
  KnowledgeRunAdmissionSourceAuthorization
} from "../knowledge/runAdmission";
import type { MemorySourceMutationHooks } from "../memory/sourceState";
import type { NormalizedRunRequest } from "../providers/types";
import { decodeMemoryActionAnswerResult } from "../providers/memoryActionAnswer";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { resolveProjectAccess } from "../projects/access";
import { decodeKnowledgeFocusedRequest } from "../knowledge/focusedRequest";
import { KNOWLEDGE_EVIDENCE_MESSAGE_ID } from "../knowledge/evidenceContext";
import {
  KNOWLEDGE_FULL_CONTEXT_THRESHOLD_BASIS_POINTS,
  KNOWLEDGE_MAXIMUM_SEARCHES_MAXIMUM,
  KNOWLEDGE_MAXIMUM_SEARCHES_MINIMUM
} from "../knowledge/answerPolicy";
import {
  parseToolLoopCheckpoint,
  AUTOMATIC_KNOWLEDGE_CALL_PREFIX,
  snapshotToolLoopJson,
  toolLoopCheckpoint,
  toolLoopPersistenceLimits,
  upsertAnswerRoundUsage,
  type CheckpointedToolLoopRun,
  type PersistedToolLoopCall,
  type PersistToolLoopCallBatchInput,
  type ToolLoopCheckpoint,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";
import type { RunOutputArtifactEvent } from "./runOutputEvents";
import { isRunOutputArtifactEvent } from "./runOutputEvents";
import type { RunRepository } from "./runRepositoryContract";
import { settleTerminalMemorySource } from "./prismaRepositoryPreparation";
import {
  activeMessageStatuses,
  dispatchableModelRunStatuses,
  isRecord,
  json,
  projectRunRecoveryAuthority
} from "./prismaRepositoryShared";

export async function appendRunOutputEvents(
  tx: Prisma.TransactionClient,
  runId: string,
  events: readonly RunOutputArtifactEvent[]
): Promise<void> {
  if (events.length === 0) return;
  if (events.some((event) => !isRunOutputArtifactEvent(event))) {
    throw new Error("run_output_event_invalid");
  }
  const latest = await tx.modelRunEvent.aggregate({
    _max: { sequence: true },
    where: { modelRunId: runId }
  });
  const firstSequence = (latest._max.sequence ?? -1) + 1;
  await tx.modelRunEvent.createMany({
    data: events.map((event, offset) => ({
      eventType: event.type,
      modelRunId: runId,
      payload: json(event.data),
      sequence: firstSequence + offset
    }))
  });
}

function canonicalJson(value: ToolLoopJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolLoopArguments(value: unknown): Readonly<Record<string, ToolLoopJsonValue>> | null {
  const snapshot = snapshotToolLoopJson(value, toolLoopPersistenceLimits.argumentsBytes);
  return snapshot && isRecord(snapshot)
    ? snapshot as Readonly<Record<string, ToolLoopJsonValue>>
    : null;
}

function recoveryKnowledgeExclusions(
  value: unknown
): readonly KnowledgeRunAdmissionExclusion[] | null {
  if (!Array.isArray(value)) return null;
  const exclusions: Array<KnowledgeRunAdmissionExclusion | null> = value.map((entry) => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.count) || Number(entry.count) < 1 ||
      entry.reason !== "binding_budget" && entry.reason !== "not_ready" &&
        entry.reason !== "unattached" ||
      entry.resourceType !== "base" && entry.resourceType !== "source") return null;
    return {
      count: Number(entry.count),
      reason: entry.reason,
      resourceType: entry.resourceType
    } as const;
  });
  return exclusions.some((entry) => entry === null)
    ? null
    : exclusions.filter((entry): entry is KnowledgeRunAdmissionExclusion => entry !== null);
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function recoveryKnowledgeSourceAuthorization(input: Readonly<{
  accessProvenance: unknown;
  baseProvenance: unknown;
  directSelected: boolean;
  profileRevisionId: string;
  readinessState: string;
  sourceArtifactId: string | null;
  sourceId: string | null;
  sourceVersionId: string | null;
  tombstonedAt: Date | null;
}>): KnowledgeRunAdmissionSourceAuthorization | null {
  if (input.readinessState !== "ready" || input.tombstonedAt !== null ||
    !input.sourceId?.trim() || !input.sourceVersionId?.trim() ||
    !input.sourceArtifactId?.trim() || !input.profileRevisionId.trim() ||
    !isRecord(input.accessProvenance) ||
    !exactObjectKeys(input.accessProvenance, ["authority", "selectionProvenance"]) ||
    !isRecord(input.accessProvenance.authority) ||
    !exactObjectKeys(input.accessProvenance.authority, ["knowledgeBaseIds", "owner", "projectId"]) ||
    !Array.isArray(input.accessProvenance.authority.knowledgeBaseIds) ||
    typeof input.accessProvenance.authority.owner !== "boolean" ||
    input.accessProvenance.authority.projectId !== null &&
      typeof input.accessProvenance.authority.projectId !== "string" ||
    !Array.isArray(input.accessProvenance.selectionProvenance) ||
    !Array.isArray(input.baseProvenance)) return null;

  const knowledgeBaseIds = input.accessProvenance.authority.knowledgeBaseIds;
  const selectionProvenance = input.accessProvenance.selectionProvenance;
  const validSelections = new Set(["all_my_knowledge", "base", "explicit_source"]);
  if (knowledgeBaseIds.some((value) => typeof value !== "string" || !value.trim()) ||
    new Set(knowledgeBaseIds).size !== knowledgeBaseIds.length ||
    selectionProvenance.length < 1 ||
    selectionProvenance.some((value) => typeof value !== "string" ||
      !validSelections.has(value)) ||
    new Set(selectionProvenance).size !== selectionProvenance.length) return null;

  const baseProvenance = input.baseProvenance.map((entry) =>
    isRecord(entry) && exactObjectKeys(entry, ["indexGenerationId", "knowledgeBaseId"]) &&
      typeof entry.indexGenerationId === "string" && entry.indexGenerationId.trim() &&
      typeof entry.knowledgeBaseId === "string" && entry.knowledgeBaseId.trim()
      ? {
          indexGenerationId: entry.indexGenerationId,
          knowledgeBaseId: entry.knowledgeBaseId
        }
      : null);
  if (baseProvenance.some((entry) => entry === null) ||
    new Set(baseProvenance.map((entry) => entry?.knowledgeBaseId)).size !==
      baseProvenance.length) return null;

  const authorityOwner = input.accessProvenance.authority.owner as boolean;
  const authorityProjectId = input.accessProvenance.authority.projectId as string | null;
  if (!authorityOwner && authorityProjectId === null && knowledgeBaseIds.length === 0) return null;
  return Object.freeze({
    authority: Object.freeze({
      knowledgeBaseIds: Object.freeze([...knowledgeBaseIds]) as readonly string[],
      owner: authorityOwner,
      projectId: authorityProjectId
    }),
    baseProvenance: Object.freeze(baseProvenance.filter((entry): entry is NonNullable<
      typeof entry
    > => entry !== null)),
    directSelected: input.directSelected,
    profileRevisionId: input.profileRevisionId,
    selectionProvenance: Object.freeze([...selectionProvenance]) as
      KnowledgeRunAdmissionSourceAuthorization["selectionProvenance"],
    sourceArtifactId: input.sourceArtifactId,
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId
  });
}

type ToolLoopCallRecord = {
  arguments: Prisma.JsonValue;
  completedAt: Date | null;
  id: string;
  mcpRunBinding: {
    id: string;
    runtimeGenerationFingerprint: string;
    runtimeGenerationId: string | null;
  } | null;
  ordinal: number;
  providerCallId: string;
  result: Prisma.JsonValue | null;
  roundIndex: number;
  startedAt: Date | null;
  state: ModelRunToolCallState;
  toolName: string;
  usageAccountedAt: Date | null;
};

const toolLoopCallInclude = {
  mcpRunBinding: {
    select: {
      id: true,
      runtimeGenerationFingerprint: true,
      runtimeGenerationId: true
    }
  }
} satisfies Prisma.ModelRunToolCallInclude;

function persistedToolLoopCall(call: ToolLoopCallRecord): PersistedToolLoopCall {
  const argumentsValue = toolLoopArguments(call.arguments);
  const result = call.result === null
    ? null
    : snapshotToolLoopJson(call.result, toolLoopPersistenceLimits.resultBytes);
  if (!argumentsValue || (call.result !== null && result === null)) {
    throw new Error("tool_loop_call_invalid_in_storage");
  }
  return {
    arguments: argumentsValue,
    completedAt: call.completedAt?.toISOString() ?? null,
    id: call.id,
    mcpBinding: call.mcpRunBinding,
    ordinal: call.ordinal,
    providerCallId: call.providerCallId,
    result,
    roundIndex: call.roundIndex,
    startedAt: call.startedAt?.toISOString() ?? null,
    state: call.state,
    toolName: call.toolName,
    usageAccountedAt: call.usageAccountedAt?.toISOString() ?? null
  };
}

function sameCheckpoint(left: ToolLoopCheckpoint, right: ToolLoopCheckpoint): boolean {
  return canonicalJson(left as unknown as ToolLoopJsonValue) ===
    canonicalJson(right as unknown as ToolLoopJsonValue);
}

const recoveredRunTerminalMarker = "recoveryTerminal";
const knowledgeBudgetCancellationFailure = "operation_cancelled";
const knowledgeBudgetPostDispatchCancellationFailure =
  "operation_cancelled_after_dispatch";

type LockedToolLoopRun = {
  assistantMessageId: string | null;
  errorPayload: Prisma.JsonValue | null;
  providerResponseId: string | null;
  status: ModelRunStatus;
  toolLoopState: Prisma.JsonValue | null;
};

async function lockToolLoopRun(
  tx: Prisma.TransactionClient,
  input: { runId: string; userId?: string }
): Promise<LockedToolLoopRun | null> {
  const ownerPredicate = input.userId
    ? Prisma.sql`AND "userId" = ${input.userId}`
    : Prisma.empty;
  const [run] = await tx.$queryRaw<LockedToolLoopRun[]>(Prisma.sql`
    SELECT
      "assistantMessageId",
      "errorPayload",
      "providerResponseId",
      "status",
      "toolLoopState"
    FROM "ModelRun"
    WHERE "id" = ${input.runId}
      ${ownerPredicate}
    FOR UPDATE
  `);
  return run ?? null;
}

function activeToolLoopRun(run: LockedToolLoopRun): boolean {
  return dispatchableModelRunStatuses.includes(run.status) ||
    (run.status === "error" && !isRecoveredRunTerminalPayload(run.errorPayload));
}

export function isRecoveredRunTerminalPayload(value: unknown): boolean {
  return isRecord(value) && value[recoveredRunTerminalMarker] === true;
}

export function recoveredRunErrorPayload(error: { code: string; message: string }) {
  return {
    ...error,
    [recoveredRunTerminalMarker]: true
  };
}

/**
 * Cancels the run's still-pending calls and settles any attached Knowledge
 * capacity in the same transaction. The caller must hold the owning ModelRun
 * row lock before entering this helper.
 */
export async function cancelPendingToolLoopCallsInTransaction(
  tx: Prisma.TransactionClient,
  runId: string,
  now = new Date()
): Promise<number> {
  const pendingCalls = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT call."id"
    FROM "ModelRunToolCall" AS call
    WHERE call."modelRunId" = ${runId}
      AND call."state" = 'pending'
    ORDER BY call."roundIndex" ASC, call."ordinal" ASC
    FOR UPDATE
  `);
  if (pendingCalls.length === 0) return 0;

  const pendingCallIds = pendingCalls.map((call) => call.id);
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      failureCode: knowledgeBudgetCancellationFailure,
      leaseExpiresAt: null,
      leaseToken: null,
      releasedAt: now,
      state: "released"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: null,
      state: "reserved"
    }
  });
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      leaseExpiresAt: null,
      leaseToken: null,
      releasedAt: now,
      state: "released"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: { not: null },
      state: "reserved"
    }
  });
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      ambiguousAt: now,
      failureCode: knowledgeBudgetPostDispatchCancellationFailure,
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: null,
      state: "dispatched"
    }
  });
  await tx.knowledgeBudgetReservation.updateMany({
    data: {
      ambiguousAt: now,
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: pendingCallIds },
      purgedAt: { not: null },
      state: "dispatched"
    }
  });
  const cancelled = await tx.modelRunToolCall.updateMany({
    data: {
      completedAt: now,
      state: "cancelled"
    },
    where: {
      id: { in: pendingCallIds },
      modelRunId: runId,
      state: "pending"
    }
  });
  if (cancelled.count !== pendingCallIds.length) {
    throw new Error("pending_tool_call_cancellation_conflict");
  }
  return cancelled.count;
}

export type PrismaRunToolLoopOperations = Pick<
  RunRepository,
  | "advanceToolLoopCallBatch"
  | "appendAssistantText"
  | "appendRunOutputEvent"
  | "beginToolLoopProviderRound"
  | "cancelPendingToolLoopCalls"
  | "claimAutomaticKnowledgeCall"
  | "claimToolLoopCall"
  | "loadCheckpointedToolLoopRun"
  | "loadFocusedKnowledgeCall"
  | "loadFocusedKnowledgeRecoveryScope"
  | "loadFocusedKnowledgeScopeExclusions"
  | "loadProviderDispatchRecoveryRequest"
  | "markRunAnswerStarted"
  | "persistToolLoopCallBatch"
  | "prepareAutomaticKnowledgeCallBatch"
  | "recordRunUsageEvents"
  | "resetToolLoopAssistantDraft"
  | "settleRecoveredRunError"
  | "settleToolLoopCall"
  | "updateRunProviderResponseId"
>;

const normalizedRequestKeys = new Set([
  "attachmentIds",
  "chatId",
  "content",
  "context",
  "knowledgeAnswering",
  "knowledgeEvidencePackingVersion",
  "knowledgeFocusedRequest",
  "knowledgePlan",
  "memoryActionTools",
  "memoryHistoryTool",
  "modelCapabilities",
  "mcpDiscovery",
  "mcp",
  "modelId",
  "params",
  "personalContext",
  "prompt",
  "provider",
  "reasoningEffort",
  "searchPlan",
  "skills",
  "toolBudgets",
  "toolMode"
]);

function onlyKnownKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function nonBlank(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && !value.includes("\u0000");
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function finiteJson(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function validCapabilities(value: unknown): boolean {
  if (!isRecord(value) || !onlyKnownKeys(value, new Set([
    "backgroundStreaming",
    "contextWindow",
    "defaultMaxOutputTokens",
    "defaultReasoningEffort",
    "defaultReasoningMode",
    "nativeBackground",
    "nativeImageGeneration",
    "nativePdfInput",
    "nativeSearch",
    "parallelToolCalls",
    "pdf",
    "reasoning",
    "reasoningEfforts",
    "reasoningModes",
    "streaming",
    "streamUsage",
    "structuredOutput",
    "toolCalling",
    "vision"
  ]))) return false;
  for (const key of ["nativePdfInput", "nativeSearch", "pdf", "reasoning", "vision"] as const) {
    if (typeof value[key] !== "boolean") return false;
  }
  for (const key of [
    "backgroundStreaming",
    "nativeBackground",
    "nativeImageGeneration",
    "parallelToolCalls",
    "streaming",
    "streamUsage",
    "structuredOutput",
    "toolCalling"
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
  }
  for (const key of ["contextWindow", "defaultMaxOutputTokens"] as const) {
    if (value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) || Number(value[key]) <= 0)) return false;
  }
  for (const key of ["defaultReasoningEffort", "defaultReasoningMode"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  for (const key of ["reasoningEfforts", "reasoningModes"] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) ||
      value[key].some((entry) => typeof entry !== "string"))) return false;
  }
  return true;
}

function validContext(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !onlyKnownKeys(value, new Set(["messages", "mode", "summary"])) ||
    value.mode !== "branch_path" || !Array.isArray(value.messages)) return false;
  for (const message of value.messages) {
    if (!isRecord(message) || !onlyKnownKeys(message, new Set(["content", "id", "purpose", "role"])) ||
      !nonBlank(message.id, 1_024) ||
      (message.role !== "assistant" && message.role !== "user") ||
      (message.purpose !== undefined && message.purpose !== "knowledge_evidence" &&
        message.purpose !== "skill_context") ||
      !isRecord(message.content) || !onlyKnownKeys(message.content, new Set(["blocks"])) ||
      !Array.isArray(message.content.blocks) || !finiteJson(message.content.blocks)) return false;
  }
  if (value.summary !== undefined && (!isRecord(value.summary) ||
    !onlyKnownKeys(value.summary, new Set(["truncation"])) ||
    !isRecord(value.summary.truncation) ||
    !onlyKnownKeys(value.summary.truncation, new Set([
      "approxDroppedTokens",
      "approxFinalTokens",
      "approxOriginalTokens",
      "budgetTokens",
      "contextWindow",
      "droppedMessages",
      "keptMessages",
      "maxOutputTokens",
      "safetyMarginTokens"
    ])) || Object.values(value.summary.truncation).some((entry) =>
      !Number.isSafeInteger(entry) || Number(entry) < 0))) return false;
  return true;
}

function validKnowledgeAnswering(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !onlyKnownKeys(value, new Set([
    "answerPolicy",
    "approximateDocumentTokens",
    "evidenceCount",
    "exactDocumentTokens",
    "route",
    "version"
  ])) || value.version !== 1 ||
    (value.route !== "rag_v1" && value.route !== "full_context_v1") ||
    !Number.isSafeInteger(value.approximateDocumentTokens) ||
    Number(value.approximateDocumentTokens) < 1 || !isRecord(value.answerPolicy) ||
    !onlyKnownKeys(value.answerPolicy, new Set([
      "fullContextThresholdBasisPoints",
      "maximumKnowledgeSearches",
      "revision",
      "version"
    ])) || value.answerPolicy.version !== 1 ||
    value.answerPolicy.fullContextThresholdBasisPoints !==
      KNOWLEDGE_FULL_CONTEXT_THRESHOLD_BASIS_POINTS ||
    !Number.isSafeInteger(value.answerPolicy.maximumKnowledgeSearches) ||
    Number(value.answerPolicy.maximumKnowledgeSearches) < KNOWLEDGE_MAXIMUM_SEARCHES_MINIMUM ||
    Number(value.answerPolicy.maximumKnowledgeSearches) > KNOWLEDGE_MAXIMUM_SEARCHES_MAXIMUM ||
    !Number.isSafeInteger(value.answerPolicy.revision) || Number(value.answerPolicy.revision) < 1) {
    return false;
  }
  const fullContext = value.route === "full_context_v1";
  return fullContext
    ? Number.isSafeInteger(value.evidenceCount) && Number(value.evidenceCount) >= 1 &&
      Number(value.evidenceCount) <= 2_048 &&
      Number.isSafeInteger(value.exactDocumentTokens) && Number(value.exactDocumentTokens) >= 1
    : value.evidenceCount === undefined && value.exactDocumentTokens === undefined;
}

function validFullContextEvidenceContext(value: unknown, evidenceCount: number): boolean {
  if (!isRecord(value) || !Array.isArray(value.messages)) return false;
  const evidenceMessages = value.messages.filter((message) =>
    isRecord(message) && message.purpose === "knowledge_evidence");
  if (evidenceMessages.length !== 1) return false;
  const message = evidenceMessages[0]!;
  if (message.id !== KNOWLEDGE_EVIDENCE_MESSAGE_ID || message.role !== "user" ||
    !isRecord(message.content) || !Array.isArray(message.content.blocks) ||
    message.content.blocks.length !== 1) return false;
  const block = message.content.blocks[0];
  if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return false;
  const parts = block.text.split("\n\n");
  if (parts.length !== evidenceCount + 3 ||
    !parts[0]!.startsWith(
      '<private_knowledge_evidence version="4" coverage="full_admitted_corpus">\n'
    ) || !parts[1]!.trim() || parts.at(-1) !== "</private_knowledge_evidence>") return false;
  for (const [index, serialized] of parts.slice(2, -1).entries()) {
    let item: unknown;
    try {
      item = JSON.parse(serialized);
    } catch {
      return false;
    }
    const handle = `K${index + 1}`;
    if (!isRecord(item) || item.type !== "source_evidence" || item.schemaVersion !== 1 ||
      item.handle !== handle || item.citation !== `[${handle}]` ||
      typeof item.exactExcerpt !== "string" || !item.exactExcerpt.trim()) return false;
  }
  return true;
}

function validSearchPlan(value: unknown): boolean {
  if (!isRecord(value) || !onlyKnownKeys(value, new Set(["mode", "options"])) ||
    !searchPlanModes.includes(value.mode as (typeof searchPlanModes)[number]) ||
    !Array.isArray(value.options) || value.options.length > 3) return false;
  const optionIds = new Set<string>();
  for (const option of value.options) {
    if (!isRecord(option) || !onlyKnownKeys(option, new Set([
      "adapterKind",
      "config",
      "credentialMode",
      "displayName",
      "executionModes",
      "modelId",
      "optionId",
      "protocol",
      "provider",
      "providerModelId",
      "revisionId",
      "searchStrategyRowId"
    ])) || !searchAdapterKinds.includes(option.adapterKind as (typeof searchAdapterKinds)[number]) ||
      !searchCredentialModes.includes(option.credentialMode as (typeof searchCredentialModes)[number]) ||
      !searchProtocols.includes(option.protocol as (typeof searchProtocols)[number]) ||
      !isRecord(option.config) || !finiteJson(option.config) ||
      !Array.isArray(option.executionModes) || option.executionModes.length < 1 ||
      option.executionModes.some((mode) =>
        !searchPlanModes.includes(mode as (typeof searchPlanModes)[number])) ||
      !nonBlank(option.optionId, 160) || !nonBlank(option.provider) ||
      !nonBlank(option.revisionId) || !nonBlank(option.searchStrategyRowId) ||
      !(option.modelId === null || nonBlank(option.modelId)) ||
      !(option.providerModelId === null || nonBlank(option.providerModelId)) ||
      (option.displayName !== undefined && typeof option.displayName !== "string") ||
      optionIds.has(option.optionId)) return false;
    optionIds.add(option.optionId);
  }
  return true;
}

function validMcpSnapshot(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !onlyKnownKeys(value, new Set(["servers", "tools", "version"])) ||
    value.version !== 1 || !Array.isArray(value.servers) || !Array.isArray(value.tools)) return false;
  const servers = new Map<string, string>();
  for (const server of value.servers) {
    if (!isRecord(server) || !onlyKnownKeys(server, new Set([
      "credentialSources",
      "externalAccountLabel",
      "fingerprint",
      "revisionId",
      "serverId",
      "serverName"
    ])) || !/^[0-9a-f]{64}$/u.test(String(server.fingerprint)) ||
      !nonBlank(server.revisionId) || !nonBlank(server.serverId) ||
      !nonBlank(server.serverName) || servers.has(server.serverId) ||
      server.externalAccountLabel !== undefined &&
        server.externalAccountLabel !== null &&
        typeof server.externalAccountLabel !== "string" ||
      server.credentialSources !== undefined && (
        !Array.isArray(server.credentialSources) ||
        new Set(server.credentialSources).size !== server.credentialSources.length ||
        server.credentialSources.some((source) =>
          source !== "oauth" && source !== "personal" && source !== "shared")
      )) return false;
    servers.set(server.serverId, server.serverName);
  }
  const namespacedNames = new Set<string>();
  for (const tool of value.tools) {
    if (!isRecord(tool) || !onlyKnownKeys(tool, new Set([
      "annotations",
      "definitionHash",
      "description",
      "inputSchema",
      "name",
      "namespacedName",
      "originalName",
      "outputSchema",
      "serverId",
      "serverName",
      "title"
    ])) || !/^[0-9a-f]{64}$/u.test(String(tool.definitionHash)) ||
      !nullableString(tool.description) || !isRecord(tool.inputSchema) ||
      !finiteJson(tool.inputSchema) || !nonBlank(tool.name) ||
      !nonBlank(tool.namespacedName) || !nonBlank(tool.originalName) ||
      tool.name !== tool.originalName || !nonBlank(tool.serverId) ||
      !nonBlank(tool.serverName) || servers.get(tool.serverId) !== tool.serverName ||
      namespacedNames.has(tool.namespacedName) ||
      tool.outputSchema !== undefined &&
        (!isRecord(tool.outputSchema) || !finiteJson(tool.outputSchema)) ||
      tool.annotations !== undefined && (!isRecord(tool.annotations) ||
        Object.values(tool.annotations).some((entry) =>
          typeof entry !== "boolean" && typeof entry !== "string")) ||
      tool.title !== undefined && typeof tool.title !== "string") return false;
    namespacedNames.add(tool.namespacedName);
  }
  return true;
}

function decodeProviderDispatchRecoveryRequest(
  value: unknown,
  identity: Readonly<{ chatId: string; modelId: string; provider: string }>
): NormalizedRunRequest | null {
  if (!isRecord(value) || !onlyKnownKeys(value, normalizedRequestKeys) ||
    value.chatId !== identity.chatId || value.modelId !== identity.modelId ||
    value.provider !== identity.provider || !nonBlank(value.chatId) ||
    !nonBlank(value.modelId) || !nonBlank(value.provider) ||
    !Array.isArray(value.attachmentIds) ||
    value.attachmentIds.some((id) => !nonBlank(id, 1_024)) ||
    new Set(value.attachmentIds).size !== value.attachmentIds.length ||
    !isRecord(value.content) || !onlyKnownKeys(value.content, new Set(["blocks"])) ||
    !Array.isArray(value.content.blocks) || !finiteJson(value.content.blocks) ||
    !validContext(value.context) || !validKnowledgeAnswering(value.knowledgeAnswering) ||
    value.knowledgeEvidencePackingVersion !== undefined &&
      value.knowledgeEvidencePackingVersion !== 2 ||
    !validCapabilities(value.modelCapabilities) ||
    !isRecord(value.params) || !finiteJson(value.params) ||
    value.reasoningEffort !== undefined && value.reasoningEffort !== null &&
      !nonBlank(value.reasoningEffort, 32) ||
    !isRecord(value.prompt) || !onlyKnownKeys(value.prompt, new Set([
      "baseline", "developer", "knowledgeAnswerContract", "knowledgeAnswerDraftContract",
      "knowledgeGroundedSelectorContract", "memoryActionAnswerResult", "system"
    ])) || !nullableString(value.prompt.developer) || !nullableString(value.prompt.system) ||
    value.prompt.knowledgeAnswerContract !== undefined &&
      value.prompt.knowledgeAnswerContract !== 1 ||
    value.prompt.knowledgeAnswerDraftContract !== undefined &&
      value.prompt.knowledgeAnswerDraftContract !== 7 &&
      value.prompt.knowledgeAnswerDraftContract !== 8 ||
    value.prompt.knowledgeGroundedSelectorContract !== undefined &&
      value.prompt.knowledgeGroundedSelectorContract !== 5 &&
      value.prompt.knowledgeGroundedSelectorContract !== 6 ||
    value.prompt.memoryActionAnswerResult !== undefined &&
      decodeMemoryActionAnswerResult(value.prompt.memoryActionAnswerResult) === null ||
    !validSearchPlan(value.searchPlan) || !validMcpSnapshot(value.mcp) ||
    (value.toolMode !== "auto" && value.toolMode !== "none")) return null;
  if (value.prompt.baseline !== undefined && (!isRecord(value.prompt.baseline) ||
    !onlyKnownKeys(value.prompt.baseline, new Set(["source", "timeZone", "timeZoneSource"])) ||
    value.prompt.baseline.source !== "standard_chat" ||
    typeof value.prompt.baseline.timeZone !== "string" ||
    (value.prompt.baseline.timeZoneSource !== "client" &&
      value.prompt.baseline.timeZoneSource !== "utc_fallback"))) return null;
  const legacyKnowledgeAnswerContract = value.prompt.knowledgeAnswerContract === 1;
  const currentKnowledgeAnswerContract =
    value.prompt.knowledgeAnswerDraftContract === 8 &&
      value.prompt.knowledgeGroundedSelectorContract === 6 ||
    value.prompt.knowledgeAnswerDraftContract === 7 &&
      value.prompt.knowledgeGroundedSelectorContract === 5;
  const partialCurrentKnowledgeAnswerContract =
    value.prompt.knowledgeAnswerDraftContract !== undefined ||
    value.prompt.knowledgeGroundedSelectorContract !== undefined;
  const automaticKnowledgeAnswer = value.knowledgeFocusedRequest !== undefined ||
    isRecord(value.knowledgeAnswering) &&
      value.knowledgeAnswering.route === "full_context_v1";
  if (legacyKnowledgeAnswerContract && partialCurrentKnowledgeAnswerContract ||
    partialCurrentKnowledgeAnswerContract && !currentKnowledgeAnswerContract ||
    automaticKnowledgeAnswer &&
      !legacyKnowledgeAnswerContract && !currentKnowledgeAnswerContract ||
    !automaticKnowledgeAnswer &&
      (legacyKnowledgeAnswerContract || currentKnowledgeAnswerContract)) return null;
  if (!decodeKnowledgePlan(value.knowledgePlan).ok ||
    value.knowledgeFocusedRequest !== undefined &&
      decodeKnowledgeFocusedRequest(value.knowledgeFocusedRequest) === null ||
    value.mcpDiscovery !== undefined && !decodeMcpDiscoveryState(value.mcpDiscovery, 100)) return null;
  if (value.knowledgeFocusedRequest !== undefined && (
    value.knowledgeAnswering !== undefined ||
    value.toolMode !== "none" ||
    !isRecord(value.searchPlan) || !Array.isArray(value.searchPlan.options) ||
    value.searchPlan.options.length !== 0 || value.mcp !== undefined ||
    value.mcpDiscovery !== undefined || value.memoryActionTools !== undefined ||
    value.memoryHistoryTool !== undefined
  )) return null;
  if (isRecord(value.knowledgeAnswering) &&
    value.knowledgeAnswering.route === "full_context_v1" && (
      !validFullContextEvidenceContext(
        value.context,
        Number(value.knowledgeAnswering.evidenceCount)
      ) ||
      !isRecord(value.searchPlan) || !Array.isArray(value.searchPlan.options) ||
      value.searchPlan.options.length !== 0 || value.mcp !== undefined ||
      value.mcpDiscovery !== undefined || value.memoryActionTools !== undefined ||
      value.memoryHistoryTool !== undefined
    )) return null;
  if (value.memoryActionTools !== undefined && (!isRecord(value.memoryActionTools) ||
    !onlyKnownKeys(value.memoryActionTools, new Set(["version"])) ||
    value.memoryActionTools.version !== "model-driven-v2")) return null;
  if (value.memoryHistoryTool !== undefined && (!isRecord(value.memoryHistoryTool) ||
    !onlyKnownKeys(value.memoryHistoryTool, new Set(["maxCalls", "pageSize"])) ||
    value.memoryHistoryTool.maxCalls !== 2 || value.memoryHistoryTool.pageSize !== 20)) return null;
  const personalContext = value.personalContext;
  if (personalContext !== undefined && (!isRecord(personalContext) ||
    !onlyKnownKeys(personalContext, new Set([
      "approxTokens", "itemCount", "memoryGeneration", "memoryRevision", "mode", "text"
    ])) || personalContext.mode !== "prefetched" ||
    typeof personalContext.text !== "string" ||
    ["approxTokens", "itemCount", "memoryGeneration", "memoryRevision"].some((key) =>
      !Number.isSafeInteger(personalContext[key]) || Number(personalContext[key]) < 0))) return null;
  if (value.skills !== undefined && (!Array.isArray(value.skills) || value.skills.some((skill) =>
    !isRecord(skill) || !onlyKnownKeys(skill, new Set(["name", "revisionId", "skillId"])) ||
    !nonBlank(skill.name) || !nonBlank(skill.revisionId) || !nonBlank(skill.skillId)))) return null;
  const toolBudgets = value.toolBudgets;
  if (toolBudgets !== undefined && (!isRecord(toolBudgets) ||
    !onlyKnownKeys(toolBudgets, new Set([
      "mcpAutoDiscoveryTimeoutSeconds",
      "maxMcpToolsPerDiscovery",
      "maxToolCalls",
      "maxToolRounds"
    ])) || ["maxToolCalls", "maxToolRounds"].some((key) =>
      !Number.isSafeInteger(toolBudgets[key]) || Number(toolBudgets[key]) < 1) ||
    ["mcpAutoDiscoveryTimeoutSeconds", "maxMcpToolsPerDiscovery"].some((key) =>
      toolBudgets[key] !== undefined &&
      (!Number.isSafeInteger(toolBudgets[key]) || Number(toolBudgets[key]) < 1)))) {
    return null;
  }
  return value as unknown as NormalizedRunRequest;
}

export function createPrismaRunToolLoopOperations(
  prismaClient: PrismaClient,
  memorySourceHooks: MemorySourceMutationHooks
): PrismaRunToolLoopOperations {
  return {
    advanceToolLoopCallBatch: async (input) => {
      if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 ||
        input.roundIndex > toolLoopPersistenceLimits.roundIndex) return "conflict";
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return "not_found" as const;
        if (run.status === "cancelled") return "cancelled" as const;
        if (!activeToolLoopRun(run)) return "conflict" as const;
        const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
        if (!checkpoint || checkpoint.roundIndex !== input.roundIndex ||
          (checkpoint.phase !== "tools_pending" && checkpoint.phase !== "tools_running")) {
          return "conflict" as const;
        }
        const calls = await tx.modelRunToolCall.findMany({
          select: { state: true },
          where: { modelRunId: input.runId, roundIndex: input.roundIndex }
        });
        if (calls.length === 0) return "conflict" as const;
        if (calls.some((call) => call.state !== "complete" && call.state !== "error")) {
          return "incomplete" as const;
        }
        const next = toolLoopCheckpoint({
          answerRoundUsage: checkpoint.answerRoundUsage,
          phase: "provider_running",
          providerContinuation: checkpoint.providerContinuation,
          providerCursor: checkpoint.providerCursor,
          roundIndex: checkpoint.roundIndex + 1
        });
        if (!next) return "conflict" as const;
        await tx.modelRun.update({
          data: {
            providerResponseId: null,
            toolLoopState: json(next)
          },
          where: { id: input.runId }
        });
        return "advanced" as const;
      });
    },
    appendAssistantText: async (assistantMessageId, text, options) => {
      await prismaClient.$transaction(async (tx) => {
        const updated = await tx.message.updateMany({
          data: {
            content: json(textMessageContent(text)),
            ...(options.allowErrored ? {} : { status: "streaming" as const })
          },
          where: {
            groundedAt: null,
            id: assistantMessageId,
            status: options.allowErrored
              ? { in: ["streaming", "error"] }
              : "streaming"
          }
        });
        if (updated.count === 0) return;
        await tx.modelRun.updateMany({
          data: { updatedAt: new Date() },
          where: {
            assistantMessageId,
            id: options.runId
          }
        });
      });
    },
    beginToolLoopProviderRound: async (input) => {
      const checkpoint = toolLoopCheckpoint({
        phase: "provider_running",
        providerContinuation: input.providerContinuation,
        providerCursor: input.providerCursor,
        roundIndex: input.roundIndex
      });
      if (!checkpoint) return "conflict";
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return "not_found" as const;
        if (run.status === "cancelled") return "cancelled" as const;
        if (!activeToolLoopRun(run)) return "conflict" as const;
        if (run.toolLoopState !== null) {
          const current = parseToolLoopCheckpoint(run.toolLoopState);
          return current && sameCheckpoint(current, checkpoint)
            ? "reused" as const
            : "conflict" as const;
        }
        await tx.modelRun.update({
          data: {
            providerResponseId: null,
            toolLoopState: json(checkpoint)
          },
          where: { id: input.runId }
        });
        return "started" as const;
      });
    },
    cancelPendingToolLoopCalls: async (input) => {
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return 0;
        return cancelPendingToolLoopCallsInTransaction(tx, input.runId);
      });
    },
    prepareAutomaticKnowledgeCallBatch: async (input) => {
      if (input.calls.length !== 1) {
        return { kind: "conflict" as const };
      }
      const requestedCall = input.calls[0]!;
      const requestedArguments = toolLoopArguments(requestedCall.arguments);
      const requestedFocused = decodeKnowledgeFocusedRequest(requestedArguments);
      if (requestedCall.ordinal !== 0 ||
        requestedCall.providerCallId !== `${AUTOMATIC_KNOWLEDGE_CALL_PREFIX}1` ||
        !requestedArguments || !requestedFocused) return { kind: "conflict" as const };
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return { kind: "not_found" as const };
        if (run.status === "cancelled") return { kind: "cancelled" as const };
        if (!activeToolLoopRun(run) || run.toolLoopState !== null) {
          return { kind: "conflict" as const };
        }
        const persistedRun = await tx.modelRun.findUnique({
          select: { normalizedRequest: true },
          where: { id: input.runId }
        });
        const persistedRequest = isRecord(persistedRun?.normalizedRequest)
          ? decodeKnowledgeFocusedRequest(persistedRun.normalizedRequest.knowledgeFocusedRequest)
          : null;
        if (!persistedRequest || canonicalJson(
          persistedRequest as unknown as ToolLoopJsonValue
        ) !== canonicalJson(requestedFocused as unknown as ToolLoopJsonValue)) {
          return { kind: "conflict" as const };
        }
        const scope = await tx.knowledgeRunScope.findUnique({
          select: { budgetPolicy: true },
          where: { modelRunId: input.runId }
        });
        const budgetPolicy = decodeKnowledgeBudgetPolicy(scope?.budgetPolicy);
        if (!budgetPolicy || input.calls.length > budgetPolicy.maxOperations) {
          return { kind: "conflict" as const };
        }
        const existing = await tx.modelRunToolCall.findMany({
          include: toolLoopCallInclude,
          orderBy: { ordinal: "asc" },
          where: { modelRunId: input.runId, roundIndex: 0 }
        });
        if (existing.length > 0) {
          const same = existing.length === input.calls.length && existing.every((call, index) => {
            const expected = input.calls[index];
            const args = toolLoopArguments(call.arguments);
            return Boolean(expected && call.ordinal === expected.ordinal &&
              call.providerCallId === expected.providerCallId &&
              call.toolName === KNOWLEDGE_FOCUSED_OPERATION_NAME &&
              args && canonicalJson(args) === canonicalJson(expected.arguments));
          });
          return same
            ? { calls: existing.map(persistedToolLoopCall), kind: "reused" as const }
            : { kind: "conflict" as const };
        }
        for (const call of input.calls) {
          await tx.modelRunToolCall.create({
            data: {
              arguments: json(call.arguments),
              modelRunId: input.runId,
              ordinal: call.ordinal,
              providerCallId: call.providerCallId,
              roundIndex: 0,
              state: "pending",
              toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
            }
          });
        }
        const prepared = await tx.modelRunToolCall.findMany({
          include: toolLoopCallInclude,
          orderBy: { ordinal: "asc" },
          where: { modelRunId: input.runId, roundIndex: 0 }
        });
        return { calls: prepared.map(persistedToolLoopCall), kind: "prepared" as const };
      });
    },
    claimAutomaticKnowledgeCall: async (input) => prismaClient.$transaction(async (tx) => {
      const run = await lockToolLoopRun(tx, input);
      if (!run) return { kind: "not_found" as const };
      let call = await tx.modelRunToolCall.findFirst({
        include: toolLoopCallInclude,
        where: {
          id: input.callId,
          modelRunId: input.runId,
          providerCallId: `${AUTOMATIC_KNOWLEDGE_CALL_PREFIX}1`,
          roundIndex: 0,
          toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
        }
      });
      if (!call) return { kind: "not_found" as const };
      if (call.state === "complete" || call.state === "error") {
        return { call: persistedToolLoopCall(call), kind: "settled" as const };
      }
      if (call.state === "running") {
        return { call: persistedToolLoopCall(call), kind: "ambiguous" as const };
      }
      if (call.state === "cancelled") {
        return { call: persistedToolLoopCall(call), kind: "cancelled" as const };
      }
      if (!activeToolLoopRun(run)) {
        call = await tx.modelRunToolCall.update({
          data: { completedAt: new Date(), state: "cancelled" },
          include: toolLoopCallInclude,
          where: { id: call.id }
        });
        return { call: persistedToolLoopCall(call), kind: "cancelled" as const };
      }
      call = await tx.modelRunToolCall.update({
        data: { startedAt: new Date(), state: "running" },
        include: toolLoopCallInclude,
        where: { id: call.id }
      });
      return { call: persistedToolLoopCall(call), kind: "claimed" as const };
    }),
    claimToolLoopCall: async (input) => prismaClient.$transaction(async (tx) => {
      const run = await lockToolLoopRun(tx, input);
      if (!run) return { kind: "not_found" as const };
      let call = await tx.modelRunToolCall.findFirst({
        include: toolLoopCallInclude,
        where: { id: input.callId, modelRunId: input.runId }
      });
      if (!call) return { kind: "not_found" as const };
      if (call.state === "complete" || call.state === "error") {
        return { call: persistedToolLoopCall(call), kind: "settled" as const };
      }
      if (call.state === "running" && call.toolName !== MCP_FIND_TOOLS_NAME) {
        const history = await tx.memoryHistoryRun.findUnique({
          select: {
            completedAt: true,
            providerResult: true,
            retentionState: true,
            state: true
          },
          where: { modelRunToolCallId: call.id }
        });
        if (
          history?.retentionState === "RETAINED" &&
          history.completedAt !== null &&
          history.providerResult !== null &&
          (history.state === "COMPLETE" || history.state === "ERROR") &&
          snapshotToolLoopJson(
            history.providerResult,
            toolLoopPersistenceLimits.resultBytes
          ) !== null
        ) {
          call = await tx.modelRunToolCall.update({
            data: {
              completedAt: history.completedAt,
              result: history.providerResult,
              state: history.state === "COMPLETE" ? "complete" : "error"
            },
            include: toolLoopCallInclude,
            where: { id: call.id }
          });
          return { call: persistedToolLoopCall(call), kind: "settled" as const };
        }
        return { call: persistedToolLoopCall(call), kind: "ambiguous" as const };
      }
      if (call.state === "cancelled") {
        return { call: persistedToolLoopCall(call), kind: "cancelled" as const };
      }
      if (!activeToolLoopRun(run)) {
        call = await tx.modelRunToolCall.update({
          data: { completedAt: new Date(), state: "cancelled" },
          include: toolLoopCallInclude,
          where: { id: call.id }
        });
        return { call: persistedToolLoopCall(call), kind: "cancelled" as const };
      }
      const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
      if (!checkpoint || checkpoint.roundIndex !== call.roundIndex ||
        (checkpoint.phase !== "tools_pending" && checkpoint.phase !== "tools_running")) {
        return { kind: "not_found" as const };
      }
      const runningCheckpoint = toolLoopCheckpoint({
        ...checkpoint,
        phase: "tools_running"
      });
      if (!runningCheckpoint) return { kind: "not_found" as const };
      call = await tx.modelRunToolCall.update({
        data: { startedAt: new Date(), state: "running" },
        include: toolLoopCallInclude,
        where: { id: call.id }
      });
      if (checkpoint.phase !== "tools_running") {
        await tx.modelRun.update({
          data: { toolLoopState: json(runningCheckpoint) },
          where: { id: input.runId }
        });
      }
      return { call: persistedToolLoopCall(call), kind: "claimed" as const };
    }),
    appendRunOutputEvent: async (runId, event) => {
      if (!isRunOutputArtifactEvent(event)) throw new Error("run_output_event_invalid");
      await prismaClient.$transaction(async (tx) => {
        const [run] = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "ModelRun" WHERE "id" = ${runId} FOR UPDATE
        `);
        if (!run) throw new Error("model_run_not_found");
        await appendRunOutputEvents(tx, runId, [event]);
        await tx.modelRun.update({
          data: {
            updatedAt: new Date()
          },
          where: {
            id: runId
          }
        });
      });
    },
    loadCheckpointedToolLoopRun: async (input) => {
      const run = await prismaClient.modelRun.findFirst({
        include: {
          assistantMessage: {
            select: {
              content: true,
              groundedAt: true
            }
          },
          knowledgeRunBindings: {
            orderBy: { ordinal: "asc" },
            select: {
              includeWholeBase: true,
              indexGenerationId: true,
              knowledgeBaseId: true,
              ordinal: true,
              selectedSourceIds: true,
              vectorSpaceFingerprint: true
            }
          },
          knowledgeRunScope: {
            select: {
              budgetPolicy: true,
              exclusions: true,
              resolvedSourceCount: true,
              selection: true,
              sourceBindingStrategy: true
            }
          },
          projectRunBinding: {
            select: {
              accessRevision: true,
              instructionsRevision: true,
              memoryRevision: true,
              policyRevision: true,
              projectId: true,
              providerAdmissionFingerprint: true,
              providerConnectionId: true,
              providerModelId: true,
              providerRequiresClientTools: true,
              providerSearchPlan: true
            }
          },
          toolCalls: {
            include: toolLoopCallInclude,
            orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }]
          }
        },
        where: { id: input.runId, userId: input.userId }
      });
      if (!run || run.toolLoopState === null) return null;
      const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
      if (!checkpoint) throw new Error("tool_loop_checkpoint_invalid_in_storage");
      const selection = run.knowledgeRunScope
        ? decodeKnowledgePlan(run.knowledgeRunScope.selection)
        : null;
      const budgetPolicy = run.knowledgeRunScope
        ? decodeKnowledgeBudgetPolicy(run.knowledgeRunScope.budgetPolicy)
        : null;
      const exclusions = run.knowledgeRunScope
        ? recoveryKnowledgeExclusions(run.knowledgeRunScope.exclusions)
        : null;
      const sourceBindingStrategy = run.knowledgeRunScope?.sourceBindingStrategy ===
        KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
        ? KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
        : run.knowledgeRunScope?.sourceBindingStrategy ===
            KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED
          ? KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED
          : null;
      if (run.knowledgeRunScope && (!selection?.ok || !budgetPolicy || !exclusions ||
        !sourceBindingStrategy ||
        !Number.isSafeInteger(run.knowledgeRunScope.resolvedSourceCount) ||
        run.knowledgeRunScope.resolvedSourceCount < 0 ||
        (sourceBindingStrategy === KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
          ? run.knowledgeRunScope.resolvedSourceCount > KNOWLEDGE_SCOPE_MAX_SOURCES
          : sourceBindingStrategy === KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED
            ? run.knowledgeRunScope.resolvedSourceCount <= KNOWLEDGE_SCOPE_MAX_SOURCES
            : true) ||
        run.knowledgeRunBindings.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
        run.knowledgeRunBindings.some((binding, index) =>
          binding.ordinal !== index || !/^[0-9a-f]{64}$/u.test(
            binding.vectorSpaceFingerprint.trim()
          )))) {
        throw new Error("knowledge_run_scope_invalid_in_storage");
      }
      return {
        assistantMessageId: run.assistantMessageId,
        assistantText: run.assistantMessage && !run.assistantMessage.groundedAt
          ? textFromContentBlocks(
              isRecord(run.assistantMessage.content) ? run.assistantMessage.content : {}
            )
          : null,
        calls: run.toolCalls.map(persistedToolLoopCall),
        chatId: run.chatId,
        checkpoint,
        id: run.id,
        ...(run.knowledgeRunScope && selection?.ok && budgetPolicy && exclusions
          ? {
              knowledgeScope: {
                bindings: run.knowledgeRunBindings.map((binding) => ({
                  includeWholeBase: binding.includeWholeBase,
                  indexGenerationId: binding.indexGenerationId,
                  knowledgeBaseId: binding.knowledgeBaseId,
                  ordinal: binding.ordinal,
                  selectedSourceIds: [...binding.selectedSourceIds],
                  vectorSpaceFingerprint: binding.vectorSpaceFingerprint.trim()
                })),
                budgetPolicy,
                exclusions,
                knowledgePlan: selection.plan,
                resolvedSourceCount: run.knowledgeRunScope.resolvedSourceCount,
                sourceBindingStrategy: sourceBindingStrategy!
              }
            }
          : {}),
        modelId: run.modelId,
        normalizedRequest: run.normalizedRequest as unknown as CheckpointedToolLoopRun["normalizedRequest"],
        ...(run.projectRunBinding
          ? { project: projectRunRecoveryAuthority(run.projectRunBinding)! }
          : {}),
        provider: run.provider,
        providerResponseId: run.providerResponseId,
        status: run.status,
        userId: run.userId
      };
    },
    loadProviderDispatchRecoveryRequest: async (input) => {
      const run = await prismaClient.modelRun.findUnique({
        select: {
          chat: {
            select: {
              projectId: true,
              userId: true
            }
          },
          chatId: true,
          modelId: true,
          normalizedRequest: true,
          provider: true
        },
        where: { id: input.runId }
      });
      if (!run) return null;
      if (run.chat.userId !== input.userId) {
        if (!run.chat.projectId || !(await resolveProjectAccess(prismaClient, {
          projectId: run.chat.projectId,
          userId: input.userId
        }))) return null;
      }
      const request = decodeProviderDispatchRecoveryRequest(run.normalizedRequest, run);
      if (!request) {
        throw new Error("provider_dispatch_recovery_request_invalid_in_storage");
      }
      return request;
    },
    loadFocusedKnowledgeCall: async (input) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          toolCalls: {
            include: toolLoopCallInclude,
            orderBy: { ordinal: "asc" },
            where: {
              providerCallId: `${AUTOMATIC_KNOWLEDGE_CALL_PREFIX}1`,
              roundIndex: 0,
              toolName: KNOWLEDGE_FOCUSED_OPERATION_NAME
            }
          }
        },
        where: { id: input.runId, userId: input.userId }
      });
      if (!run || run.toolCalls.length !== 1) return null;
      return persistedToolLoopCall(run.toolCalls[0]!);
    },
    loadFocusedKnowledgeScopeExclusions: async (input) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          knowledgeRunScope: { select: { exclusions: true } }
        },
        where: { id: input.runId, userId: input.userId }
      });
      if (!run?.knowledgeRunScope) return null;
      const exclusions = recoveryKnowledgeExclusions(run.knowledgeRunScope.exclusions);
      if (!exclusions) throw new Error("knowledge_run_scope_invalid_in_storage");
      return exclusions;
    },
    loadFocusedKnowledgeRecoveryScope: async (input) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          knowledgeRunBindings: {
            orderBy: { ordinal: "asc" },
            select: {
              includeWholeBase: true,
              indexGenerationId: true,
              knowledgeBaseId: true,
              ordinal: true,
              selectedSourceIds: true,
              vectorSpaceFingerprint: true
            }
          },
          knowledgeRunProfileBindings: {
            orderBy: { ordinal: "asc" },
            select: {
              embeddingCredentialSource: true,
              embeddingExecutionSnapshot: true,
              embeddingProviderModelId: true,
              ordinal: true,
              profileRevisionId: true,
              targetDimension: true,
              vectorSpaceFingerprint: true
            }
          },
          knowledgeRunScope: {
            select: {
              exclusions: true,
              resolvedBaseCount: true,
              resolvedSourceCount: true,
              selection: true,
              sourceBindingStrategy: true
            }
          },
          knowledgeRunSourceBindings: {
            orderBy: { ordinal: "asc" },
            select: {
              accessProvenance: true,
              baseProvenance: true,
              directSelected: true,
              ordinal: true,
              profileBinding: { select: { profileRevisionId: true } },
              readinessState: true,
              sourceAlias: true,
              sourceArtifactId: true,
              sourceId: true,
              sourceVersionId: true,
              tombstonedAt: true
            }
          }
        },
        where: { id: input.runId, userId: input.userId }
      });
      if (!run?.knowledgeRunScope) return null;
      const selection = decodeKnowledgePlan(run.knowledgeRunScope.selection);
      const exclusions = recoveryKnowledgeExclusions(run.knowledgeRunScope.exclusions);
      const sourceBindingStrategy = run.knowledgeRunScope.sourceBindingStrategy ===
        KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
        ? KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER
        : run.knowledgeRunScope.sourceBindingStrategy ===
            KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED
          ? KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED
          : null;
      const eagerSourceBindings = sourceBindingStrategy ===
        KNOWLEDGE_SOURCE_BINDING_STRATEGY_EAGER;
      const disclosedSourceBindings = sourceBindingStrategy ===
        KNOWLEDGE_SOURCE_BINDING_STRATEGY_DISCLOSED;
      if (!selection.ok || !exclusions ||
        !Number.isSafeInteger(run.knowledgeRunScope.resolvedSourceCount) ||
        run.knowledgeRunScope.resolvedSourceCount < 1 ||
        run.knowledgeRunBindings.length !== run.knowledgeRunScope.resolvedBaseCount ||
        (!eagerSourceBindings && !disclosedSourceBindings) ||
        (eagerSourceBindings && (
          run.knowledgeRunScope.resolvedSourceCount > KNOWLEDGE_SCOPE_MAX_SOURCES ||
          run.knowledgeRunSourceBindings.length !== run.knowledgeRunScope.resolvedSourceCount
        )) ||
        (disclosedSourceBindings && (
          run.knowledgeRunScope.resolvedSourceCount <= KNOWLEDGE_SCOPE_MAX_SOURCES ||
          run.knowledgeRunSourceBindings.length > run.knowledgeRunScope.resolvedSourceCount
        )) ||
        run.knowledgeRunBindings.length > KNOWLEDGE_SCOPE_MAX_BINDINGS ||
        run.knowledgeRunSourceBindings.length > KNOWLEDGE_SCOPE_MAX_SOURCES ||
        run.knowledgeRunBindings.some((binding, ordinal) =>
          binding.ordinal !== ordinal || !/^[0-9a-f]{64}$/u.test(
            binding.vectorSpaceFingerprint.trim()
          )) ||
        run.knowledgeRunProfileBindings.some((profile, ordinal) =>
          profile.ordinal !== ordinal || !/^[0-9a-f]{64}$/u.test(
            profile.vectorSpaceFingerprint.trim()
          )) ||
        run.knowledgeRunSourceBindings.some((source, ordinal) =>
          source.ordinal !== ordinal || source.sourceAlias !== `S${ordinal + 1}`)) {
        throw new Error("knowledge_run_scope_invalid_in_storage");
      }

      let profiles;
      try {
        profiles = run.knowledgeRunProfileBindings.map((profile) => Object.freeze({
          embeddingCredentialSource: profile.embeddingCredentialSource,
          embeddingExecutionSnapshot: normalizeProviderExecutionSnapshot(
            profile.embeddingExecutionSnapshot
          ),
          embeddingProviderModelId: profile.embeddingProviderModelId,
          ordinal: profile.ordinal,
          profileRevisionId: profile.profileRevisionId,
          targetDimension: profile.targetDimension,
          vectorSpaceFingerprint: profile.vectorSpaceFingerprint.trim()
        }));
      } catch {
        throw new Error("knowledge_run_scope_invalid_in_storage");
      }
      const sources = run.knowledgeRunSourceBindings.map((source) =>
        recoveryKnowledgeSourceAuthorization({
          ...source,
          profileRevisionId: source.profileBinding.profileRevisionId
        }));
      if (sources.some((source) => source === null)) {
        throw new Error("knowledge_run_scope_invalid_in_storage");
      }
      const bindingsByBaseId = new Map(run.knowledgeRunBindings.map((binding) => [
        binding.knowledgeBaseId,
        binding
      ]));
      const profileRevisionIds = new Set(profiles.map((profile) => profile.profileRevisionId));
      if (sources.some((source) => source !== null &&
        (!profileRevisionIds.has(source.profileRevisionId) ||
          source.baseProvenance.some((provenance) => {
            const binding = bindingsByBaseId.get(provenance.knowledgeBaseId);
            return !source.authority.knowledgeBaseIds.includes(provenance.knowledgeBaseId) ||
              !binding || binding.indexGenerationId !== provenance.indexGenerationId;
          })))) {
        throw new Error("knowledge_run_scope_invalid_in_storage");
      }
      return Object.freeze({
        bindings: Object.freeze(run.knowledgeRunBindings.map((binding) => Object.freeze({
          includeWholeBase: binding.includeWholeBase,
          indexGenerationId: binding.indexGenerationId,
          knowledgeBaseId: binding.knowledgeBaseId,
          selectedSourceIds: Object.freeze([...binding.selectedSourceIds]),
          vectorSpaceFingerprint: binding.vectorSpaceFingerprint.trim()
        }))),
        exclusions: Object.freeze([...exclusions]),
        knowledgePlan: selection.plan,
        profiles: Object.freeze(profiles),
        resolvedSourceCount: run.knowledgeRunScope.resolvedSourceCount,
        sourceBindingStrategy: sourceBindingStrategy!,
        sources: Object.freeze(sources.filter((source): source is NonNullable<
          typeof source
        > => source !== null))
      });
    },
    persistToolLoopCallBatch: async (input: PersistToolLoopCallBatchInput) => {
      if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 ||
        input.roundIndex > toolLoopPersistenceLimits.roundIndex || input.calls.length === 0 ||
        input.calls.length > toolLoopPersistenceLimits.batchCalls) {
        return { kind: "conflict" as const };
      }
      const providerCallIds = new Set<string>();
      const preparedCalls: Array<{
        arguments: Readonly<Record<string, ToolLoopJsonValue>>;
        ordinal: number;
        providerCallId: string;
        runtimeGenerationFingerprint: string | null;
        toolName: string;
      }> = [];
      for (const [index, call] of input.calls.entries()) {
        const argumentsValue = toolLoopArguments(call.arguments);
        const runtimeFingerprint = call.runtimeGenerationFingerprint ?? null;
        if (!argumentsValue || call.ordinal !== index || !call.providerCallId.trim() ||
          call.providerCallId.length > toolLoopPersistenceLimits.providerCallIdLength ||
          providerCallIds.has(call.providerCallId) || !call.toolName.trim() ||
          call.toolName.length > toolLoopPersistenceLimits.toolNameLength ||
          (runtimeFingerprint !== null && !/^[a-f0-9]{64}$/u.test(runtimeFingerprint))) {
          return { kind: "conflict" as const };
        }
        providerCallIds.add(call.providerCallId);
        preparedCalls.push({
          arguments: argumentsValue,
          ordinal: call.ordinal,
          providerCallId: call.providerCallId,
          runtimeGenerationFingerprint: runtimeFingerprint,
          toolName: call.toolName
        });
      }
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return { kind: "not_found" as const };
        if (run.status === "cancelled") return { kind: "cancelled" as const };
        if (!activeToolLoopRun(run)) return { kind: "conflict" as const };
        const current = parseToolLoopCheckpoint(run.toolLoopState);
        if (!current) return { kind: "conflict" as const };
        const pendingCheckpoint = toolLoopCheckpoint({
          answerRoundUsage: current.answerRoundUsage,
          phase: "tools_pending",
          providerContinuation: input.providerContinuation,
          providerCursor: input.providerCursor,
          roundIndex: input.roundIndex
        });
        if (!pendingCheckpoint) return { kind: "conflict" as const };

        const existing = await tx.modelRunToolCall.findMany({
          include: toolLoopCallInclude,
          orderBy: { ordinal: "asc" },
          where: { modelRunId: input.runId, roundIndex: input.roundIndex }
        });
        if (existing.length > 0) {
          const sameContinuation = current.roundIndex === pendingCheckpoint.roundIndex &&
            (current.phase === "tools_pending" || current.phase === "tools_running") &&
            canonicalJson(current.providerContinuation) ===
              canonicalJson(pendingCheckpoint.providerContinuation) &&
            canonicalJson(current.providerCursor) === canonicalJson(pendingCheckpoint.providerCursor);
          const sameCalls = existing.length === preparedCalls.length && existing.every((call, index) => {
            const expected = preparedCalls[index];
            const argumentsValue = toolLoopArguments(call.arguments);
            return Boolean(expected && argumentsValue && call.ordinal === expected.ordinal &&
              call.providerCallId === expected.providerCallId && call.toolName === expected.toolName &&
              (call.mcpRunBinding?.runtimeGenerationFingerprint ?? null) ===
                expected.runtimeGenerationFingerprint &&
              canonicalJson(argumentsValue!) === canonicalJson(expected.arguments as Record<string, ToolLoopJsonValue>));
          });
          return sameContinuation && sameCalls
            ? { calls: existing.map(persistedToolLoopCall), kind: "reused" as const }
            : { kind: "conflict" as const };
        }
        if (current.phase !== "provider_running" || current.roundIndex !== input.roundIndex) {
          return { kind: "conflict" as const };
        }

        const fingerprints = [...new Set(preparedCalls.flatMap((call) =>
          call.runtimeGenerationFingerprint ? [call.runtimeGenerationFingerprint] : []))];
        const bindings = fingerprints.length
          ? await tx.mcpRunBinding.findMany({
              select: { id: true, runtimeGenerationFingerprint: true },
              where: {
                modelRunId: input.runId,
                runtimeGenerationFingerprint: { in: fingerprints }
              }
            })
          : [];
        const bindingsByFingerprint = new Map(bindings.map((binding) =>
          [binding.runtimeGenerationFingerprint, binding.id]));
        if (bindingsByFingerprint.size !== fingerprints.length) {
          return { kind: "conflict" as const };
        }

        for (const call of preparedCalls) {
          await tx.modelRunToolCall.create({
            data: {
              arguments: json(call.arguments),
              mcpRunBindingId: call.runtimeGenerationFingerprint
                ? bindingsByFingerprint.get(call.runtimeGenerationFingerprint)!
                : null,
              modelRunId: input.runId,
              ordinal: call.ordinal,
              providerCallId: call.providerCallId,
              roundIndex: input.roundIndex,
              state: "pending",
              toolName: call.toolName
            }
          });
        }
        await tx.modelRun.update({
          data: { toolLoopState: json(pendingCheckpoint) },
          where: { id: input.runId }
        });
        const persisted = await tx.modelRunToolCall.findMany({
          include: toolLoopCallInclude,
          orderBy: { ordinal: "asc" },
          where: { modelRunId: input.runId, roundIndex: input.roundIndex }
        });
        return { calls: persisted.map(persistedToolLoopCall), kind: "persisted" as const };
      });
    },
    recordRunUsageEvents: async (input) => {
      const usageAccountedToolCallIds = [...new Set(input.usageAccountedToolCallIds ?? [])];
      if (usageAccountedToolCallIds.length !== (input.usageAccountedToolCallIds?.length ?? 0) ||
        usageAccountedToolCallIds.length > toolLoopPersistenceLimits.batchCalls ||
        usageAccountedToolCallIds.some((id) => !id.trim())) {
        return false;
      }
      if (input.usageAttributions.length === 0 && !input.answerRoundUsage &&
        usageAccountedToolCallIds.length === 0) {
        return false;
      }

      const usageAttributions = input.usageAttributions.map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));
      const usage = sumTokenUsage(usageAttributions.map((attribution) => attribution.usage));
      const estimatedCostMicros = usageAttributions.reduce(
        (total, attribution) => total + (attribution.estimatedCostMicros ?? 0),
        0
      );

      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return false;
        if (usageAccountedToolCallIds.length > 0) {
          const calls = await tx.modelRunToolCall.findMany({
            select: { id: true },
            where: {
              id: { in: usageAccountedToolCallIds },
              modelRunId: input.runId,
              state: { in: ["complete", "error"] }
            }
          });
          if (calls.length !== usageAccountedToolCallIds.length) return false;
        }
        const nextCheckpoint = input.answerRoundUsage
          ? (() => {
              const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
              return checkpoint
                ? upsertAnswerRoundUsage(checkpoint, input.answerRoundUsage)
                : null;
            })()
          : undefined;
        if (input.answerRoundUsage && !nextCheckpoint) return false;

        const updatedRun = await tx.modelRun.updateMany({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            estimatedCostMicros,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            ...(nextCheckpoint ? { toolLoopState: json(nextCheckpoint) } : {}),
            totalTokens: usage.totalTokens
          },
          where: {
            chatId: input.chatId,
            id: input.runId,
            status: {
              not: "complete"
            },
            userId: input.userId
          }
        });
        if (updatedRun.count === 0) {
          return false;
        }

        await tx.usageEvent.deleteMany({
          where: {
            modelRunId: input.runId
          }
        });
        if (usageAttributions.length > 0) {
          await tx.usageEvent.createMany({
            data: usageAttributions.map((attribution) => ({
              chatId: input.chatId,
              cachedInputTokens: attribution.usage.cachedInputTokens,
              cacheWriteInputTokens: attribution.usage.cacheWriteInputTokens,
              estimatedCostMicros: attribution.estimatedCostMicros ?? 0,
              inputTokens: attribution.usage.inputTokens,
              modelId: attribution.modelId,
              modelRunId: input.runId,
              outputTokens: attribution.usage.outputTokens,
              provider: attribution.provider,
              reasoningTokens: attribution.usage.reasoningTokens,
              totalTokens: attribution.usage.totalTokens,
              userId: input.userId
            }))
          });
        }
        if (usageAccountedToolCallIds.length > 0) {
          const accounted = await tx.modelRunToolCall.updateMany({
            data: { usageAccountedAt: new Date() },
            where: {
              id: { in: usageAccountedToolCallIds },
              modelRunId: input.runId,
              state: { in: ["complete", "error"] }
            }
          });
          if (accounted.count !== usageAccountedToolCallIds.length) {
            throw new Error("tool_call_usage_checkpoint_conflict");
          }
        }
        return true;
      });
    },
    resetToolLoopAssistantDraft: async (input) => {
      if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 ||
        input.roundIndex > toolLoopPersistenceLimits.roundIndex) return false;
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run || !activeToolLoopRun(run) || !run.assistantMessageId) return false;
        const checkpoint = parseToolLoopCheckpoint(run.toolLoopState);
        if (!checkpoint || checkpoint.roundIndex !== input.roundIndex ||
          (checkpoint.phase !== "tools_pending" && checkpoint.phase !== "tools_running")) {
          return false;
        }
        const reset = await tx.message.updateMany({
          data: {
            content: json(textMessageContent("")),
            errorMessage: null,
            status: "streaming"
          },
          where: {
            id: run.assistantMessageId,
              status: { in: [...activeMessageStatuses, "error"] }
          }
        });
        if (reset.count !== 1) return false;
        await tx.modelRun.update({
          data: { answerStartedAt: null, updatedAt: new Date() },
          where: { id: input.runId }
        });
        return true;
      });
    },
    markRunAnswerStarted: async (input) => {
      await prismaClient.modelRun.updateMany({
        data: { answerStartedAt: input.at },
        where: { answerStartedAt: null, id: input.runId }
      });
    },
    settleRecoveredRunError: async (input) => {
      const usageAttributions = input.usageAttributions.map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));
      const usage =
        usageAttributions.length > 0
          ? sumTokenUsage(usageAttributions.map((attribution) => attribution.usage))
          : null;
      const estimatedCostMicros = usageAttributions.reduce(
        (total, attribution) => total + (attribution.estimatedCostMicros ?? 0),
        0
      );

      return prismaClient.$transaction(async (tx) => {
        const [run] = await tx.$queryRaw<
          Array<{
            assistantMessageId: string | null;
            chatId: string;
            errorPayload: Prisma.JsonValue | null;
            providerResponseId: string | null;
            status: ModelRunStatus;
            userId: string;
          }>
        >(Prisma.sql`
          SELECT
            "assistantMessageId",
            "chatId",
            "errorPayload",
            "providerResponseId",
            "status",
            "userId"
          FROM "ModelRun"
          WHERE "id" = ${input.runId}
            AND "userId" = ${input.userId}
          FOR UPDATE
        `);

        if (
          !run ||
          (!dispatchableModelRunStatuses.includes(run.status) && run.status !== "error") ||
          isRecoveredRunTerminalPayload(run.errorPayload)
        ) {
          return false;
        }

        await tx.modelRun.update({
          data: {
            errorPayload: json(recoveredRunErrorPayload(input.error)),
            ...(input.providerResponseId
              ? { providerResponseId: input.providerResponseId }
              : {}),
            status: "error",
            ...(usage
              ? {
                  cachedInputTokens: usage.cachedInputTokens,
                  cacheWriteInputTokens: usage.cacheWriteInputTokens,
                  estimatedCostMicros,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  reasoningTokens: usage.reasoningTokens,
                  totalTokens: usage.totalTokens
                }
              : {})
          },
          where: {
            id: input.runId
          }
        });

        if (run.assistantMessageId) {
          await tx.message.updateMany({
            data: {
              errorMessage: input.error.message,
              status: "error"
            },
            where: {
              chatId: run.chatId,
              id: run.assistantMessageId,
              status: {
                in: [...activeMessageStatuses, "error"]
              }
            }
          });
        }
        await settleTerminalMemorySource(tx, {
          assistantMessageId: run.assistantMessageId,
          chatId: run.chatId,
          runId: input.runId,
          status: "error",
          userId: run.userId
        }, memorySourceHooks);

        if (usageAttributions.length > 0) {
          await tx.usageEvent.deleteMany({
            where: {
              modelRunId: input.runId
            }
          });
          await tx.usageEvent.createMany({
            data: usageAttributions.map((attribution) => ({
              chatId: run.chatId,
              cachedInputTokens: attribution.usage.cachedInputTokens,
              cacheWriteInputTokens: attribution.usage.cacheWriteInputTokens,
              estimatedCostMicros: attribution.estimatedCostMicros ?? 0,
              inputTokens: attribution.usage.inputTokens,
              modelId: attribution.modelId,
              modelRunId: input.runId,
              outputTokens: attribution.usage.outputTokens,
              provider: attribution.provider,
              reasoningTokens: attribution.usage.reasoningTokens,
              totalTokens: attribution.usage.totalTokens,
              userId: run.userId
            }))
          });
        }

        await appendRunOutputEvents(tx, input.runId, input.outputEvents);

        return true;
      });
    },
    settleToolLoopCall: async (input) => {
      const result = snapshotToolLoopJson(input.result, toolLoopPersistenceLimits.resultBytes);
      if (result === null && input.result !== null) return "conflict";
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return "not_found" as const;
        const call = await tx.modelRunToolCall.findFirst({
          select: { id: true, result: true, state: true },
          where: { id: input.callId, modelRunId: input.runId }
        });
        if (!call) return "not_found" as const;
        if (call.state === "complete" || call.state === "error") {
          const existing = call.result === null
            ? null
            : snapshotToolLoopJson(call.result, toolLoopPersistenceLimits.resultBytes);
          return call.state === input.state &&
            (call.result === null || existing !== null) &&
            canonicalJson(existing) === canonicalJson(result)
            ? "reused" as const
            : "conflict" as const;
        }
        if (call.state !== "running") return "conflict" as const;
        await tx.modelRunToolCall.update({
          data: {
            completedAt: new Date(),
            result: result === null ? Prisma.JsonNull : json(result),
            state: input.state
          },
          where: { id: call.id }
        });
        return "settled" as const;
      });
    },
    updateRunProviderResponseId: async (runId, providerResponseId) => {
      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, { runId });
        if (!run) return "terminal" as const;
        if (run.status === "cancelled") return "cancelled" as const;
        if (!activeToolLoopRun(run)) return "terminal" as const;

        await tx.modelRun.update({
          data: { providerResponseId },
          where: { id: runId }
        });
        return "published" as const;
      });
    }
  };
}
