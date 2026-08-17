import {
  Prisma,
  type ModelRunStatus,
  type ModelRunToolCallState,
  type PrismaClient
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import { MCP_FIND_TOOLS_NAME } from "../mcp/discovery";
import type { MemorySourceMutationHooks } from "../memory/sourceState";
import {
  parseToolLoopCheckpoint,
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
    toolName: call.toolName
  };
}

function sameCheckpoint(left: ToolLoopCheckpoint, right: ToolLoopCheckpoint): boolean {
  return canonicalJson(left as unknown as ToolLoopJsonValue) ===
    canonicalJson(right as unknown as ToolLoopJsonValue);
}

const recoveredRunTerminalMarker = "recoveryTerminal";

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

export type PrismaRunToolLoopOperations = Pick<
  RunRepository,
  | "advanceToolLoopCallBatch"
  | "appendAssistantText"
  | "appendRunOutputEvent"
  | "beginToolLoopProviderRound"
  | "cancelPendingToolLoopCalls"
  | "claimToolLoopCall"
  | "loadCheckpointedToolLoopRun"
  | "persistToolLoopCallBatch"
  | "recordRunUsageEvents"
  | "resetToolLoopAssistantDraft"
  | "settleRecoveredRunError"
  | "settleToolLoopCall"
  | "updateRunProviderResponseId"
>;

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
      const cancelled = await prismaClient.modelRunToolCall.updateMany({
        data: {
          completedAt: new Date(),
          state: "cancelled"
        },
        where: {
          modelRun: { id: input.runId, userId: input.userId },
          state: "pending"
        }
      });
      return cancelled.count;
    },
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
      if (input.usageAttributions.length === 0 && !input.answerRoundUsage) {
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
          data: { updatedAt: new Date() },
          where: { id: input.runId }
        });
        return true;
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
