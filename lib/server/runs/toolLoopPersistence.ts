import { getMcpRequestMaxBytes } from "../mcp/responseLimits";
import type { ModelRunStatus } from "@prisma/client";
import type { SearchPlan } from "../../domain/search";
import { mergeTokenUsage, normalizeTokenUsage, type NormalizedTokenUsage, type TokenUsageField } from "../../domain/usage";
import type { NormalizedRunRequest } from "../providers/types";
import type { KnowledgePlan } from "../../contracts/knowledge";
import type { KnowledgeBudgetPolicy } from "../knowledge/knowledgeBudget";
import type { KnowledgeRunAdmissionExclusion } from "../knowledge/runAdmission";
import type { KnowledgeSourceBindingStrategy } from "../knowledge/retrievalTypes";
import type { ContextCompactionCheckpoint, ContextCompactionStatus, ContextPlanMeasurement } from "../../contracts/contextCompaction";
import { CONTEXT_COMPACTION_LIMITS, decodeContextSummary, decodeContextSummaryAttempt } from "./contextCompactionContract";

export type ToolLoopJsonValue =
  | boolean
  | number
  | string
  | null
  | ToolLoopJsonValue[]
  | { [key: string]: ToolLoopJsonValue };

export type ToolLoopCheckpointPhase = "provider_running" | "tools_pending" | "tools_running";

export const AUTOMATIC_KNOWLEDGE_CALL_PREFIX = "knowledge-focused-v1-";

export type PersistedAnswerRoundUsage = Readonly<{
  completeness: "partial" | "terminal";
  roundIndex: number;
  usage: NormalizedTokenUsage;
}>;

export type ToolLoopCheckpoint = Readonly<{
  answerRoundUsage: readonly PersistedAnswerRoundUsage[];
  phase: ToolLoopCheckpointPhase;
  providerContinuation: ToolLoopJsonValue | null;
  providerCursor: number | string | null;
  roundIndex: number;
  version: 2;
  contextCompaction?: ContextCompactionCheckpoint;
}>;

export type PersistedToolLoopCallState = "pending" | "running" | "complete" | "error" | "cancelled";

export type PersistedToolLoopCall = Readonly<{
  arguments: Readonly<Record<string, ToolLoopJsonValue>>;
  completedAt: string | null;
  id: string;
  mcpBinding: Readonly<{
    id: string;
    runtimeGenerationFingerprint: string;
    runtimeGenerationId: string | null;
  }> | null;
  /** Present on repository records; omitted only by historical/in-memory fixtures. */
  workspaceBindingId?: string | null;
  ordinal: number;
  providerCallId: string;
  result: ToolLoopJsonValue | null;
  roundIndex: number;
  startedAt: string | null;
  state: PersistedToolLoopCallState;
  toolName: string;
  /** Present on repository records. Optional only for historical/in-memory
   * fixtures; a missing value is conservatively treated as unaccounted. */
  usageAccountedAt?: string | null;
}>;

/** Immutable Project authority needed before recovery performs external I/O. */
export type ProjectRunRecoveryAuthority = Readonly<{
  accessRevision: number;
  instructionsRevision: number;
  memoryRevision: number;
  policyRevision: number;
  projectId: string;
  providerAdmissionFingerprint: string;
  providerConnectionId: string;
  providerModelId: string;
  providerRequiresClientTools: boolean;
  providerSearchPlan: SearchPlan;
}>;

export type KnowledgeRunRecoveryScope = Readonly<{
  bindings: readonly Readonly<{
    includeWholeBase: boolean;
    indexGenerationId: string;
    knowledgeBaseId: string;
    ordinal: number;
    selectedSourceIds: readonly string[];
    vectorSpaceFingerprint: string;
  }>[];
  budgetPolicy: KnowledgeBudgetPolicy;
  exclusions: readonly KnowledgeRunAdmissionExclusion[];
  knowledgePlan: KnowledgePlan;
  /** Present for H2 scopes. Undefined is reserved for historical fixtures. */
  resolvedSourceCount?: number;
  sourceBindingStrategy?: KnowledgeSourceBindingStrategy;
}>;

export type CheckpointedToolLoopRun = Readonly<{
  contextCompactionStatus?: ContextCompactionStatus | null;
  assistantMessageId: string | null;
  assistantText: string | null;
  calls: readonly PersistedToolLoopCall[];
  chatId: string;
  checkpoint: ToolLoopCheckpoint;
  id: string;
  knowledgeScope?: KnowledgeRunRecoveryScope;
  modelId: string;
  normalizedRequest: NormalizedRunRequest;
  project?: ProjectRunRecoveryAuthority;
  provider: string;
  providerResponseId: string | null;
  status: ModelRunStatus;
  userId: string;
}>;

export type BeginToolLoopProviderRoundResult =
  | "started"
  | "reused"
  | "conflict"
  | "cancelled"
  | "not_found";

export type PersistToolLoopCallBatchInput = Readonly<{
  calls: readonly Readonly<{
    arguments: Readonly<Record<string, ToolLoopJsonValue>>;
    ordinal: number;
    providerCallId: string;
    runtimeGenerationFingerprint?: string | null;
    toolName: string;
    workspace?: true;
  }>[];
  providerContinuation: ToolLoopJsonValue | null;
  providerCursor?: number | string | null;
  roundIndex: number;
  runId: string;
  userId: string;
  contextCompaction?: ContextCompactionCheckpoint;
}>;

export type PersistToolLoopCallBatchResult =
  | Readonly<{
    calls: readonly PersistedToolLoopCall[];
    kind: "persisted" | "reused";
  }>
  | Readonly<{
    kind: "conflict" | "cancelled" | "not_found";
  }>;

export type PrepareAutomaticKnowledgeCallBatchInput = Readonly<{
  calls: readonly Readonly<{
    arguments: Readonly<Record<string, ToolLoopJsonValue>>;
    ordinal: number;
    providerCallId: string;
  }>[];
  runId: string;
  userId: string;
}>;

export type PrepareAutomaticKnowledgeCallBatchResult =
  | Readonly<{
      calls: readonly PersistedToolLoopCall[];
      kind: "prepared" | "reused";
    }>
  | Readonly<{
      kind: "cancelled" | "conflict" | "not_found";
    }>;

export type ClaimToolLoopCallResult =
  | Readonly<{ call: PersistedToolLoopCall; kind: "claimed" | "settled" | "ambiguous" | "cancelled" }>
  | Readonly<{ kind: "not_found" }>;

export type SettleToolLoopCallResult = "settled" | "reused" | "conflict" | "not_found";

export type AdvanceToolLoopCallBatchResult =
  | "advanced"
  | "incomplete"
  | "conflict"
  | "cancelled"
  | "not_found";

export const toolLoopPersistenceLimits = Object.freeze({
  get argumentsBytes() { return getMcpRequestMaxBytes(); },
  batchCalls: 64,
  get checkpointBytes() { return Math.max(4 * 1024 * 1024, 2 * getMcpRequestMaxBytes() + 64 * 1024); },
  providerCallIdLength: 256,
  providerCursorLength: 4_096,
  resultBytes: 256 * 1_024,
  roundIndex: 2_147_483_647,
  toolNameLength: 256
});

const normalizedUsageFields = [
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens"
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonSnapshot(value: unknown, maxBytes: number): ToolLoopJsonValue | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > maxBytes) return null;
    const snapshot = JSON.parse(serialized) as unknown;
    return isToolLoopJsonValue(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

export function isToolLoopJsonValue(value: unknown): value is ToolLoopJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isToolLoopJsonValue);
  return isRecord(value) && Object.values(value).every(isToolLoopJsonValue);
}

export function snapshotToolLoopJson(value: unknown, maxBytes: number): ToolLoopJsonValue | null {
  return jsonSnapshot(value, maxBytes);
}

function normalizedUsage(value: unknown): NormalizedTokenUsage | null {
  if (!isRecord(value) || ![6, 7].includes(Object.keys(value).length)) return null;
  if (Object.keys(value).length === 7 && !["complete", "partial", "unavailable"].includes(String(value.completeness))) return null;
  if (!normalizedUsageFields.every((field) =>
    Object.hasOwn(value, field) && (value[field] === null || Number.isSafeInteger(value[field]) && Number(value[field]) >= 0))) {
    return null;
  }
  const normalized = normalizeTokenUsage(value);
  if (value.completeness !== undefined && value.completeness !== normalized.completeness) return null;
  return normalized;
}

function validContextCompactionMeasurement(value: unknown): value is ContextPlanMeasurement {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !==
    "afterTokens,beforeTokens,budgetTokens,legacyFallback,maskedBatches,maskedObservations,outcome,version" ||
    value.version !== 1 || !["already_fits", "masking_applied", "needs_summary", "irreducible_overflow"].includes(String(value.outcome)) ||
    typeof value.legacyFallback !== "boolean" ||
    !["afterTokens", "beforeTokens", "maskedBatches", "maskedObservations"].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) ||
    !(value.budgetTokens === null || Number.isSafeInteger(value.budgetTokens) && Number(value.budgetTokens) >= 0)) return false;
  return true;
}

function validContextCompactionCheckpoint(value: unknown): value is ContextCompactionCheckpoint {
  if (!isRecord(value) || Object.keys(value).filter((key) => !["summary", "summaryAttempts"].includes(key)).sort().join(",") !==
      "branchId,followupDigest,followupRevision,measurement,observationRefs,ownerId,pinDigest,policyRevision,providerProjectionRevision,recentTailCallIds,runId,sourceDigest,version" ||
    value.version !== 1 || value.policyRevision !== "legacy-compatible-v1" && value.policyRevision !== "hybrid-v1" ||
    !["ownerId", "runId", "branchId"].every(key => typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 256) ||
    !["sourceDigest", "pinDigest", "followupDigest"].every(key => typeof value[key] === "string" && /^[a-f0-9]{64}$/u.test(value[key] as string)) ||
    !Number.isSafeInteger(value.followupRevision) || Number(value.followupRevision) < 0 ||
    !Number.isSafeInteger(value.providerProjectionRevision) || Number(value.providerProjectionRevision) < 1 ||
    !Array.isArray(value.observationRefs) || value.observationRefs.length > 512 ||
    value.observationRefs.some(entry => typeof entry !== "string" || !/^tor1_[a-f0-9]{32}$/u.test(entry)) ||
    !Array.isArray(value.recentTailCallIds) || value.recentTailCallIds.length > 64 ||
    value.recentTailCallIds.some(entry => typeof entry !== "string" || entry.length === 0 || entry.length > 1024) ||
    value.summary !== undefined && !decodeContextSummary(value.summary) ||
    value.summaryAttempts !== undefined && (!Array.isArray(value.summaryAttempts) ||
      value.summaryAttempts.length > CONTEXT_COMPACTION_LIMITS.summaryAttempts ||
      value.summaryAttempts.some((attempt) => !decodeContextSummaryAttempt(attempt))) ||
    !validContextCompactionMeasurement(value.measurement)) return false;
  return true;
}

function answerRoundUsage(value: unknown, checkpointRound: number): PersistedAnswerRoundUsage[] | null {
  if (!Array.isArray(value) || value.length > checkpointRound) return null;
  const entries: PersistedAnswerRoundUsage[] = [];
  const cumulativeUsage = Object.fromEntries(
    normalizedUsageFields.map((field) => [field, 0])
  ) as Record<TokenUsageField, number>;
  let previousRound = 0;
  for (const candidate of value) {
    if (!isRecord(candidate) || Object.keys(candidate).length !== 3 ||
      !["completeness", "roundIndex", "usage"].every((key) => Object.hasOwn(candidate, key)) ||
      (candidate.completeness !== "partial" && candidate.completeness !== "terminal") ||
      !Number.isSafeInteger(candidate.roundIndex) || Number(candidate.roundIndex) <= previousRound ||
      Number(candidate.roundIndex) > toolLoopPersistenceLimits.roundIndex ||
      Number(candidate.roundIndex) > checkpointRound) {
      return null;
    }
    const usage = normalizedUsage(candidate.usage);
    if (!usage) return null;
    for (const field of normalizedUsageFields) {
      const next = cumulativeUsage[field] + (usage[field] ?? 0);
      if (!Number.isSafeInteger(next)) return null;
      cumulativeUsage[field] = next;
    }
    previousRound = Number(candidate.roundIndex);
    entries.push({
      completeness: candidate.completeness,
      roundIndex: previousRound,
      usage
    });
  }
  return entries;
}

export function parseToolLoopCheckpoint(value: unknown): ToolLoopCheckpoint | null {
  if (!isRecord(value) ||
    !["answerRoundUsage", "phase", "providerContinuation", "providerCursor", "roundIndex", "version"]
      .every((key) => Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !["answerRoundUsage", "phase", "providerContinuation", "providerCursor", "roundIndex", "version", "contextCompaction"].includes(key)) ||
    value.version !== 2 ||
    (Object.keys(value).length !== 6 && Object.keys(value).length !== 7) ||
    !["provider_running", "tools_pending", "tools_running"].includes(String(value.phase)) ||
    !Number.isSafeInteger(value.roundIndex) || (value.roundIndex as number) < 0 ||
    (value.roundIndex as number) > toolLoopPersistenceLimits.roundIndex ||
    !(value.providerCursor === null || typeof value.providerCursor === "number" ||
      typeof value.providerCursor === "string") ||
    (typeof value.providerCursor === "number" && !Number.isFinite(value.providerCursor)) ||
    (typeof value.providerCursor === "string" &&
      value.providerCursor.length > toolLoopPersistenceLimits.providerCursorLength) ||
    !isToolLoopJsonValue(value.providerContinuation) ||
    value.contextCompaction !== undefined && !validContextCompactionCheckpoint(value.contextCompaction)) {
    return null;
  }
  const parsedAnswerRoundUsage = answerRoundUsage(
    value.answerRoundUsage,
    Number(value.roundIndex)
  );
  if (parsedAnswerRoundUsage === null) return null;
  const snapshot = jsonSnapshot(value, toolLoopPersistenceLimits.checkpointBytes);
  if (!snapshot || !isRecord(snapshot)) return null;
  return snapshot as unknown as ToolLoopCheckpoint;
}

export function toolLoopCheckpoint(input: Readonly<{
  answerRoundUsage?: readonly PersistedAnswerRoundUsage[];
  phase: ToolLoopCheckpointPhase;
  providerContinuation: ToolLoopJsonValue | null;
  providerCursor?: number | string | null;
  roundIndex: number;
  contextCompaction?: ContextCompactionCheckpoint;
}>): ToolLoopCheckpoint | null {
  return parseToolLoopCheckpoint({
    answerRoundUsage: input.answerRoundUsage ?? [],
    phase: input.phase,
    providerContinuation: input.providerContinuation,
    providerCursor: input.providerCursor ?? null,
    roundIndex: input.roundIndex,
    version: 2,
    ...(input.contextCompaction ? { contextCompaction: input.contextCompaction } : {})
  });
}

function sameUsage(left: NormalizedTokenUsage, right: NormalizedTokenUsage): boolean {
  return left.completeness === right.completeness && left.cachedInputTokens === right.cachedInputTokens &&
    left.cacheWriteInputTokens === right.cacheWriteInputTokens &&
    left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens && left.totalTokens === right.totalTokens;
}

export function mergeAnswerRoundUsage(
  currentEntries: readonly PersistedAnswerRoundUsage[],
  entry: PersistedAnswerRoundUsage,
  checkpointRound: number
): readonly PersistedAnswerRoundUsage[] | null {
  const current = answerRoundUsage(currentEntries, checkpointRound);
  if (!current || entry.completeness !== "partial" && entry.completeness !== "terminal" ||
    !Number.isSafeInteger(entry.roundIndex) || entry.roundIndex < 1 ||
    entry.roundIndex > checkpointRound ||
    entry.roundIndex > toolLoopPersistenceLimits.roundIndex || !normalizedUsage(entry.usage)) {
    return null;
  }
  const index = current.findIndex((candidate) => candidate.roundIndex === entry.roundIndex);
  if (index >= 0) {
    const existing = current[index]!;
    if (existing.completeness === "terminal") {
      return entry.completeness === "terminal" && sameUsage(existing.usage, entry.usage)
        ? current
        : null;
    }
    current[index] = { ...entry, usage: mergeTokenUsage(existing.usage, entry.usage) };
  } else {
    current.push(entry);
    current.sort((left, right) => left.roundIndex - right.roundIndex);
  }
  return answerRoundUsage(current, checkpointRound);
}

export function upsertAnswerRoundUsage(
  checkpoint: ToolLoopCheckpoint,
  entry: PersistedAnswerRoundUsage
): ToolLoopCheckpoint | null {
  const current = mergeAnswerRoundUsage(
    checkpoint.answerRoundUsage,
    entry,
    checkpoint.roundIndex
  );
  if (!current) return null;
  return toolLoopCheckpoint({
    answerRoundUsage: current,
    phase: checkpoint.phase,
    providerContinuation: checkpoint.providerContinuation,
    providerCursor: checkpoint.providerCursor,
    roundIndex: checkpoint.roundIndex,
    ...(checkpoint.contextCompaction ? { contextCompaction: checkpoint.contextCompaction } : {})
  });
}
