import type { ModelRunStatus } from "@prisma/client";
import type { NormalizedTokenUsage } from "../../domain/usage";
import type { NormalizedRunRequest } from "../providers/types";

export type ToolLoopJsonValue =
  | boolean
  | number
  | string
  | null
  | ToolLoopJsonValue[]
  | { [key: string]: ToolLoopJsonValue };

export type ToolLoopCheckpointPhase = "provider_running" | "tools_pending" | "tools_running";

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
  ordinal: number;
  providerCallId: string;
  result: ToolLoopJsonValue | null;
  roundIndex: number;
  startedAt: string | null;
  state: PersistedToolLoopCallState;
  toolName: string;
}>;

export type CheckpointedToolLoopRun = Readonly<{
  assistantMessageId: string | null;
  assistantText: string | null;
  calls: readonly PersistedToolLoopCall[];
  chatId: string;
  checkpoint: ToolLoopCheckpoint;
  id: string;
  modelId: string;
  normalizedRequest: NormalizedRunRequest;
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
  }>[];
  providerContinuation: ToolLoopJsonValue | null;
  providerCursor?: number | string | null;
  roundIndex: number;
  runId: string;
  userId: string;
}>;

export type PersistToolLoopCallBatchResult =
  | Readonly<{
    calls: readonly PersistedToolLoopCall[];
    kind: "persisted" | "reused";
  }>
  | Readonly<{
    kind: "conflict" | "cancelled" | "not_found";
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
  argumentsBytes: 64 * 1_024,
  batchCalls: 64,
  checkpointBytes: 4 * 1_024 * 1_024,
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
  if (!isRecord(value) || Object.keys(value).length !== 6) return null;
  if (!normalizedUsageFields.every((field) =>
    Object.hasOwn(value, field) && Number.isSafeInteger(value[field]) && Number(value[field]) >= 0)) {
    return null;
  }
  return Object.fromEntries(
    normalizedUsageFields.map((field) => [field, Number(value[field])])
  ) as NormalizedTokenUsage;
}

function answerRoundUsage(value: unknown, checkpointRound: number): PersistedAnswerRoundUsage[] | null {
  if (!Array.isArray(value) || value.length > checkpointRound) return null;
  const entries: PersistedAnswerRoundUsage[] = [];
  const cumulativeUsage = Object.fromEntries(
    normalizedUsageFields.map((field) => [field, 0])
  ) as NormalizedTokenUsage;
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
      const next = cumulativeUsage[field] + usage[field];
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
    value.version !== 2 ||
    Object.keys(value).length !== 6 ||
    !["provider_running", "tools_pending", "tools_running"].includes(String(value.phase)) ||
    !Number.isSafeInteger(value.roundIndex) || (value.roundIndex as number) < 0 ||
    (value.roundIndex as number) > toolLoopPersistenceLimits.roundIndex ||
    !(value.providerCursor === null || typeof value.providerCursor === "number" ||
      typeof value.providerCursor === "string") ||
    (typeof value.providerCursor === "number" && !Number.isFinite(value.providerCursor)) ||
    (typeof value.providerCursor === "string" &&
      value.providerCursor.length > toolLoopPersistenceLimits.providerCursorLength) ||
    !isToolLoopJsonValue(value.providerContinuation)) {
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
}>): ToolLoopCheckpoint | null {
  return parseToolLoopCheckpoint({
    answerRoundUsage: input.answerRoundUsage ?? [],
    phase: input.phase,
    providerContinuation: input.providerContinuation,
    providerCursor: input.providerCursor ?? null,
    roundIndex: input.roundIndex,
    version: 2
  });
}

function sameUsage(left: NormalizedTokenUsage, right: NormalizedTokenUsage): boolean {
  return left.cachedInputTokens === right.cachedInputTokens &&
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
    current[index] = entry;
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
    roundIndex: checkpoint.roundIndex
  });
}
