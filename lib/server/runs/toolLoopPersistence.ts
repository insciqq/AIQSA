import type { ModelRunStatus } from "@prisma/client";
import type { NormalizedRunRequest } from "../providers/types";

export type ToolLoopJsonValue =
  | boolean
  | number
  | string
  | null
  | ToolLoopJsonValue[]
  | { [key: string]: ToolLoopJsonValue };

export type ToolLoopCheckpointPhase = "provider_running" | "tools_pending" | "tools_running";

export type ToolLoopCheckpointV1 = Readonly<{
  phase: ToolLoopCheckpointPhase;
  providerContinuation: ToolLoopJsonValue | null;
  providerCursor: number | string | null;
  roundIndex: number;
  version: 1;
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
  calls: readonly PersistedToolLoopCall[];
  chatId: string;
  checkpoint: ToolLoopCheckpointV1;
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

export function parseToolLoopCheckpoint(value: unknown): ToolLoopCheckpointV1 | null {
  if (!isRecord(value) || Object.keys(value).length !== 5 ||
    !["phase", "providerContinuation", "providerCursor", "roundIndex", "version"]
      .every((key) => Object.hasOwn(value, key)) || value.version !== 1 ||
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
  const snapshot = jsonSnapshot(value, toolLoopPersistenceLimits.checkpointBytes);
  if (!snapshot || !isRecord(snapshot)) return null;
  return snapshot as ToolLoopCheckpointV1;
}

export function toolLoopCheckpoint(input: Readonly<{
  phase: ToolLoopCheckpointPhase;
  providerContinuation: ToolLoopJsonValue | null;
  providerCursor?: number | string | null;
  roundIndex: number;
}>): ToolLoopCheckpointV1 | null {
  return parseToolLoopCheckpoint({
    phase: input.phase,
    providerContinuation: input.providerContinuation,
    providerCursor: input.providerCursor ?? null,
    roundIndex: input.roundIndex,
    version: 1
  });
}
