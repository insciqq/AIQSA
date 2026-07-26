import { randomUUID } from "node:crypto";
import {
  Prisma,
  type MessageStatus,
  type ModelRunStatus,
  type ModelRunToolCallState,
  type PrismaClient
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import {
  groundedLiveOnlyMessageContent,
  groundedLiveOnlyProviderPreview
} from "../../domain/grounding";
import { isGroundingDisplaySseEvent, type ModelRunSseEvent } from "../../domain/modelRunEvents";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import { loadChatUsageStats, summarizeMessageRunArtifacts } from "../chats/prismaRepository";
import { titleFromMessageContent } from "../chats/titlePolicy";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import {
  ProviderAdmissionError,
  loadProviderAdmissionPlan,
  sameProviderAdmissionPlan,
  type ProviderAdmissionPlan,
  type ProviderAdmissionRole
} from "../providerRuntime/admission";
import { prisma } from "../prisma";
import type { ProviderConversationMessage } from "../providers/types";
import {
  applySettingsUpdateInTransaction,
  type SettingsTransactionClient
} from "../settings/settingsTransaction";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AttachmentLinkConflictError,
  McpRunPlanConflictError,
  ProviderAdmissionConflictError,
  type AcceptedRunDefaults,
  type DurableRunControlRecord,
  type RunAttachmentRecord,
  type RunRepository
} from "./runRepositoryContract";
import type { McpRunPlanBinding } from "../mcp/runPlan";
import { persistedToolCallActivity } from "./toolInspection";
import {
  isToolLoopJsonValue,
  parseToolLoopCheckpoint,
  snapshotToolLoopJson,
  toolLoopCheckpoint,
  toolLoopPersistenceLimits,
  type CheckpointedToolLoopRun,
  type PersistedToolLoopCall,
  type PersistToolLoopCallBatchInput,
  type ToolLoopCheckpointV1,
  type ToolLoopJsonValue
} from "./toolLoopPersistence";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function sameCheckpoint(left: ToolLoopCheckpointV1, right: ToolLoopCheckpointV1): boolean {
  return canonicalJson(left as unknown as ToolLoopJsonValue) ===
    canonicalJson(right as unknown as ToolLoopJsonValue);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function defaultMaxOutputTokens(defaultParams: unknown): number | undefined {
  if (!isRecord(defaultParams)) {
    return undefined;
  }

  return (
    numberValue(defaultParams.maxOutputTokens) ??
    numberValue(defaultParams.maxTokens) ??
    numberValue(defaultParams.max_output_tokens) ??
    numberValue(defaultParams.max_tokens) ??
    numberValue(defaultParams.max_completion_tokens) ??
    undefined
  );
}

function modelControlKey(input: { modelId: string; provider: string }): string {
  return `${input.provider}:${input.modelId}`;
}

function runControlRecord(run: {
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  provider: string;
  providerResponseId: string | null;
  status: DurableRunControlRecord["status"];
}): DurableRunControlRecord {
  return {
    assistantMessageId: run.assistantMessageId,
    chatId: run.chatId,
    id: run.id,
    modelId: run.modelId,
    provider: run.provider,
    providerResponseId: run.providerResponseId,
    status: run.status
  };
}

async function persistAcceptedRunDefaults(
  tx: SettingsTransactionClient,
  userId: string,
  defaults: AcceptedRunDefaults
): Promise<void> {
  if (defaults.userId !== userId) {
    throw new Error("Run defaults user does not match run owner");
  }

  if (defaults.promptPresetId) {
    const prompt = await tx.promptPreset.findFirst({
      select: {
        id: true
      },
      where: {
        id: defaults.promptPresetId,
        userId
      }
    });
    if (!prompt) {
      throw new Error("Run defaults persistence failed: not_found");
    }
  }

  const searchStrategyId = defaults.searchStrategy ?? "search-disabled";
  const result = await applySettingsUpdateInTransaction(
    tx,
    userId,
    {
      defaultControlValues: {
        [modelControlKey(defaults)]: { ...defaults.controlDefaults }
      },
      defaultProviderModelId: defaults.modelId,
      defaultSearchStrategyId: searchStrategyId
    },
    [
      {
        modelId: defaults.modelId,
        provider: defaults.provider,
        searchStrategyIds: [searchStrategyId]
      }
    ]
  );

  if (result.kind !== "updated") {
    throw new Error(`Run defaults persistence failed: ${result.kind}`);
  }
}

export async function insertAcceptedMcpRunBindings(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  input: {
    bindings: McpRunPlanBinding[] | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  const bindings = input.bindings ?? [];
  const serverIds = new Set<string>();
  const generationIds = new Set<string>();
  const fingerprints = new Set<string>();
  for (const binding of bindings) {
    if (!binding.serverId || !binding.runtimeGenerationId || !binding.fingerprint ||
      serverIds.has(binding.serverId) || generationIds.has(binding.runtimeGenerationId) ||
      fingerprints.has(binding.fingerprint)) {
      throw new McpRunPlanConflictError();
    }
    serverIds.add(binding.serverId);
    generationIds.add(binding.runtimeGenerationId);
    fingerprints.add(binding.fingerprint);
  }

  for (const binding of bindings) {
    const inserted = await tx.$executeRaw`
      INSERT INTO "McpRunBinding" (
        "id",
        "modelRunId",
        "runtimeGenerationId",
        "runtimeGenerationFingerprint"
      )
      SELECT
        ${randomUUID()},
        ${input.runId},
        generation."id",
        generation."fingerprint"
      FROM "McpRuntimeGeneration" AS generation
      INNER JOIN "McpUserServer" AS preference
        ON preference."id" = generation."userServerId"
      INNER JOIN "McpServer" AS server
        ON server."id" = preference."serverId"
      INNER JOIN "User" AS owner
        ON owner."id" = preference."userId"
      WHERE owner."id" = ${input.userId}
        AND owner."status" = 'active'
        AND preference."enabled" = true
        AND preference."desiredRuntimeGenerationId" = generation."id"
        AND server."id" = ${binding.serverId}
        AND server."enabled" = true
        AND server."archivedAt" IS NULL
        AND server."activeRevisionId" = generation."revisionId"
        AND generation."id" = ${binding.runtimeGenerationId}
        AND generation."fingerprint" = ${binding.fingerprint}
        AND generation."state" = 'ready'
        AND generation."inventory" IS NOT NULL
        AND generation."inventoryUpdatedAt" IS NOT NULL
        AND generation."inventoryUpdatedAt" >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
        AND EXISTS (
          SELECT 1
          FROM "McpGrant" AS mcp_grant
          WHERE mcp_grant."serverId" = server."id"
            AND mcp_grant."canUse" = true
            AND (
              mcp_grant."userId" = ${input.userId}
              OR mcp_grant."groupId" IN (
                SELECT membership."groupId"
                FROM "UserGroup" AS membership
                INNER JOIN "Group" AS member_group
                  ON member_group."id" = membership."groupId"
                  AND member_group."archivedAt" IS NULL
                WHERE membership."userId" = ${input.userId}
              )
            )
        )
    `;
    if (inserted !== 1) throw new McpRunPlanConflictError();
  }
}

function providerRecoveryHorizon(
  role: ProviderAdmissionRole,
  nativeBackgroundRequested: boolean
): Date | null {
  if (
    role.snapshot.model.adapterKind !== "openai_responses_native" ||
    !nativeBackgroundRequested
  ) {
    return null;
  }
  return new Date(Date.now() + 24 * 60 * 60 * 1_000);
}

async function insertAcceptedProviderRunBindings(
  tx: Prisma.TransactionClient,
  input: {
    nativeBackgroundRequested: boolean;
    plan: ProviderAdmissionPlan | undefined;
    runId: string;
    userId: string;
  }
): Promise<void> {
  if (!input.plan) return;
  let current: ProviderAdmissionPlan;
  try {
    current = await loadProviderAdmissionPlan(tx, {
      providerConnectionId: input.plan.selection.providerConnectionId,
      providerModelId: input.plan.selection.providerModelId,
      searchStrategyId: input.plan.requestedSearchStrategyId,
      userId: input.userId
    });
  } catch (error) {
    if (error instanceof ProviderAdmissionError) {
      throw new ProviderAdmissionConflictError();
    }
    throw error;
  }
  if (!sameProviderAdmissionPlan(input.plan, current)) {
    throw new ProviderAdmissionConflictError();
  }

  const roles: Array<{ role: "answer" | "search"; value: ProviderAdmissionRole }> = [
    { role: "answer", value: current.answer },
    ...(current.search ? [{ role: "search" as const, value: current.search }] : [])
  ];
  await tx.providerRunBinding.createMany({
    data: roles.map(({ role, value }) => ({
      connectionId: value.snapshot.connectionId,
      credentialId: value.snapshot.credentialId,
      credentialSource: value.credentialSource,
      credentialVersionId: value.snapshot.credentialVersionId,
      executionSnapshot: json(value.snapshot),
      modelRunId: input.runId,
      providerModelId: value.snapshot.providerModelId,
      recoverableUntil: role === "answer"
        ? providerRecoveryHorizon(value, input.nativeBackgroundRequested)
        : null,
      role
    }))
  });
}

async function repeatableReadTransaction<Value>(
  prismaClient: PrismaClient,
  operation: (tx: Prisma.TransactionClient) => Promise<Value>
): Promise<Value> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prismaClient.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 10_000,
        timeout: 120_000
      });
    } catch (error) {
      const serializationConflict =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === "P2034" ||
          (error.code === "P2010" &&
            isRecord(error.meta) &&
            error.meta.code === "40001"));
      if (serializationConflict) {
        if (attempt < 2) continue;
        throw new ProviderAdmissionConflictError();
      }
      throw error;
    }
  }
  throw new ProviderAdmissionConflictError();
}

const activeModelRunStatuses: ModelRunStatus[] = ["streaming", "queued", "in_progress"];
const activeMessageStatuses: MessageStatus[] = ["streaming", "queued"];
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
  input: { runId: string; userId: string }
): Promise<LockedToolLoopRun | null> {
  const [run] = await tx.$queryRaw<LockedToolLoopRun[]>(Prisma.sql`
    SELECT
      "assistantMessageId",
      "errorPayload",
      "providerResponseId",
      "status",
      "toolLoopState"
    FROM "ModelRun"
    WHERE "id" = ${input.runId}
      AND "userId" = ${input.userId}
    FOR UPDATE
  `);
  return run ?? null;
}

function activeToolLoopRun(run: LockedToolLoopRun): boolean {
  return activeModelRunStatuses.includes(run.status) ||
    (run.status === "error" && !isRecoveredRunTerminalPayload(run.errorPayload));
}

function isRecoveredRunTerminalPayload(value: unknown): boolean {
  return isRecord(value) && value[recoveredRunTerminalMarker] === true;
}

function recoveredRunErrorPayload(error: { code: string; message: string }) {
  return {
    ...error,
    [recoveredRunTerminalMarker]: true
  };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("ModelRun_one_active_per_chat_idx") ||
    error.message.includes("ModelRun_one_active_per_user_idx") ||
    error.message.includes("Unique constraint failed") ||
    error.message.includes("duplicate key value violates unique constraint")
  );
}

async function mapActiveRunConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ActiveRunConflictError();
    }

    throw error;
  }
}

type ConversationPathSelector =
  | { kind: "active" }
  | { kind: "expected"; leafMessageId: string | null }
  | { kind: "explicit"; leafMessageId: string };

type ConversationPathRow = {
  chatId: string;
  messageGroundedAt: Date | null;
  messageContent: Prisma.JsonValue | null;
  messageId: string | null;
  messageRole: string | null;
  messageStatus: string | null;
};

export function conversationMessagesFromPathRows(rows: ConversationPathRow[]): ProviderConversationMessage[] {
  return rows.flatMap((row) => {
    if (
      !row.messageId ||
      (row.messageRole !== "user" && row.messageRole !== "assistant") ||
      (row.messageStatus !== "complete" && row.messageStatus !== "streaming")
    ) {
      return [];
    }

    return [
      {
        content: row.messageGroundedAt
          ? groundedLiveOnlyMessageContent()
          : row.messageContent as { blocks: unknown[] },
        id: row.messageId,
        role: row.messageRole
      }
    ];
  });
}

export function createPrismaRunRepository(prismaClient = prisma): RunRepository {
  async function loadConversationPath(
    chatId: string,
    userId: string,
    selector: ConversationPathSelector
  ): Promise<{ chatMatched: boolean; messages: ProviderConversationMessage[] }> {
    const selectedLeaf =
      selector.kind === "active"
        ? Prisma.sql`chat."activeLeafMessageId"`
        : Prisma.sql`${selector.leafMessageId}::text`;
    const expectedLeafPredicate =
      selector.kind === "expected"
        ? Prisma.sql`AND chat."activeLeafMessageId" IS NOT DISTINCT FROM ${selector.leafMessageId}`
        : Prisma.empty;
    const rows = await prismaClient.$queryRaw<ConversationPathRow[]>(Prisma.sql`
      WITH RECURSIVE "selected_chat" AS (
        SELECT
          chat."id",
          ${selectedLeaf} AS "selectedLeafMessageId"
        FROM "Chat" AS chat
        WHERE chat."id" = ${chatId}
          AND chat."userId" = ${userId}
          AND chat."archived" = false
          ${expectedLeafPredicate}
      ),
      "ancestor_path" AS (
        SELECT
          message."chatId",
          message."content",
          message."groundedAt",
          message."id",
          message."parentMessageId",
          message."role",
          message."status"::text AS "status",
          ARRAY[message."id"]::text[] AS "visitedIds",
          0 AS "depth"
        FROM "selected_chat" AS chat
        INNER JOIN "Message" AS message
          ON message."chatId" = chat."id"
          AND message."id" = chat."selectedLeafMessageId"

        UNION ALL

        SELECT
          parent."chatId",
          parent."content",
          parent."groundedAt",
          parent."id",
          parent."parentMessageId",
          parent."role",
          parent."status"::text AS "status",
          path."visitedIds" || parent."id",
          path."depth" + 1
        FROM "ancestor_path" AS path
        INNER JOIN "Message" AS parent
          ON parent."chatId" = path."chatId"
          AND parent."id" = path."parentMessageId"
        WHERE NOT parent."id" = ANY(path."visitedIds")
      )
      SELECT
        chat."id" AS "chatId",
        path."content" AS "messageContent",
        path."groundedAt" AS "messageGroundedAt",
        path."id" AS "messageId",
        path."role" AS "messageRole",
        path."status" AS "messageStatus"
      FROM "selected_chat" AS chat
      LEFT JOIN "ancestor_path" AS path ON true
      ORDER BY path."depth" DESC NULLS LAST
    `);

    return {
      chatMatched: rows.length > 0,
      messages: conversationMessagesFromPathRows(rows)
    };
  }

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
    appendAssistantText: async (assistantMessageId, text) => {
      await prismaClient.message.updateMany({
        data: {
          content: json(textMessageContent(text)),
          status: "streaming"
        },
        where: {
          groundedAt: null,
          id: assistantMessageId,
          status: "streaming"
        }
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
    appendRunEvent: async (runId, sequence, event) => {
      if (isGroundingDisplaySseEvent(event)) {
        throw new Error("grounding_display_event_is_transient");
      }
      await prismaClient.$transaction(async (tx) => {
        await tx.modelRunEvent.create({
          data: {
            eventType: event.type,
            modelRunId: runId,
            payload: json(event.data),
            sequence
          }
        });
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
    sweepBootOrphanedRuns: async ({ createdBefore, liveRunIds }) => {
      const liveRunIdFilter = unique(liveRunIds);
      const payload = {
        code: "run_orphaned_on_boot",
        message: "Run was active when this server process started and was marked failed."
      };

      return prismaClient.$transaction(async (tx) => {
        const runs = await tx.modelRun.findMany({
          select: {
            assistantMessageId: true,
            id: true
          },
          where: {
            createdAt: {
              lt: createdBefore
            },
            ...(liveRunIdFilter.length > 0
              ? {
                  id: {
                    notIn: liveRunIdFilter
                  }
                }
              : {}),
            status: {
              in: activeModelRunStatuses
            },
            providerResponseId: null,
            toolLoopState: { equals: Prisma.DbNull }
          }
        });

        if (runs.length === 0) {
          return 0;
        }

        const runIds = runs.map((run) => run.id);
        const updatedRuns = await tx.modelRun.updateMany({
          data: {
            errorPayload: json(payload),
            status: "error"
          },
          where: {
            id: {
              in: runIds
            },
            status: {
              in: activeModelRunStatuses
            },
            providerResponseId: null,
            toolLoopState: { equals: Prisma.DbNull }
          }
        });
        const assistantMessageIds = unique(
          runs.flatMap((run) => (run.assistantMessageId ? [run.assistantMessageId] : []))
        );

        if (assistantMessageIds.length > 0) {
          await tx.message.updateMany({
            data: {
              errorMessage: payload.message,
              status: "error"
            },
            where: {
              id: {
                in: assistantMessageIds
              },
              status: {
                in: activeMessageStatuses
              }
            }
          });
        }

        return updatedRuns.count;
      });
    },
    cancelRun: async (input) => {
      return prismaClient.$transaction(async (tx) => {
        const updatedRun = await tx.modelRun.updateMany({
          data: {
            errorPayload: json(input.payload),
            status: "cancelled"
          },
          where: {
            id: input.runId,
            status: {
              in: activeModelRunStatuses
            },
            userId: input.userId
          }
        });
        const run = await tx.modelRun.findFirst({
          select: {
            assistantMessageId: true,
            chatId: true,
            id: true,
            modelId: true,
            provider: true,
            providerResponseId: true,
            status: true
          },
          where: {
            id: input.runId,
            userId: input.userId
          }
        });

        if (!run) {
          if (updatedRun.count > 0) {
            throw new Error("Cancelled run disappeared before transaction commit");
          }

          return { kind: "not_found" } as const;
        }

        if (updatedRun.count === 0) {
          return {
            kind: "current",
            run: runControlRecord(run)
          } as const;
        }

        await tx.modelRunToolCall.updateMany({
          data: {
            completedAt: new Date(),
            state: "cancelled"
          },
          where: {
            modelRunId: input.runId,
            state: "pending"
          }
        });

        if (run.assistantMessageId) {
          await tx.message.updateMany({
            data: {
              errorMessage: input.payload.message,
              status: "cancelled"
            },
            where: {
              id: run.assistantMessageId,
              status: {
                in: activeMessageStatuses
              }
            }
          });
        }

        return {
          kind: "cancelled",
          run: {
            ...runControlRecord(run),
            status: "cancelled"
          }
        } as const;
      });
    },
    completeRun: async (input) => {
      const usage = normalizeTokenUsage(input.usage);
      const usageAttributions = (
        input.usageAttributions?.length
          ? input.usageAttributions
          : [
              {
                estimatedCostMicros: input.estimatedCostMicros,
                modelId: input.modelId,
                provider: input.provider,
                usage
              }
            ]
      ).map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));

      return prismaClient.$transaction(async (tx) => {
        const [existingRun] = await tx.$queryRaw<
          Array<{
            assistantMessageId: string | null;
            chatId: string;
            errorPayload: Prisma.JsonValue | null;
            modelId: string;
            provider: string;
            providerResponseId: string | null;
            status: ModelRunStatus;
            userId: string;
          }>
        >(Prisma.sql`
          SELECT
            "assistantMessageId",
            "chatId",
            "errorPayload",
            "modelId",
            "provider",
            "providerResponseId",
            "status",
            "userId"
          FROM "ModelRun"
          WHERE "id" = ${input.runId}
            AND "userId" = ${input.userId}
          FOR UPDATE
        `);
        const activeCompletion = Boolean(
          existingRun && activeModelRunStatuses.includes(existingRun.status)
        );
        const recoveredCompletion = Boolean(
          existingRun &&
            existingRun.status === "error" &&
            input.providerResponseId &&
            existingRun.providerResponseId === input.providerResponseId &&
            !isRecoveredRunTerminalPayload(existingRun.errorPayload)
        );
        if (
          !existingRun ||
          (!activeCompletion && !recoveredCompletion) ||
          existingRun.assistantMessageId !== input.assistantMessageId ||
          existingRun.chatId !== input.chatId ||
          existingRun.modelId !== input.modelId ||
          existingRun.provider !== input.provider
        ) {
          return false;
        }

        const assistantMessage = await tx.message.findUnique({
          select: { groundedAt: true },
          where: { id: input.assistantMessageId }
        });
        const groundedLiveOnly = Boolean(assistantMessage?.groundedAt);

        await tx.modelRun.update({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            errorPayload: Prisma.JsonNull,
            estimatedCostMicros: input.estimatedCostMicros ?? 0,
            finalProviderResponsePreview: json(
              groundedLiveOnly ? groundedLiveOnlyProviderPreview() : input.finalProviderResponsePreview
            ),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            providerResponseId: input.providerResponseId ?? existingRun?.providerResponseId ?? null,
            reasoningTokens: usage.reasoningTokens,
            status: "complete",
            totalTokens: usage.totalTokens
          },
          where: {
            id: input.runId
          }
        });

        await tx.message.updateMany({
          data: {
            content: json(
              groundedLiveOnly ? groundedLiveOnlyMessageContent() : textMessageContent(input.finalText)
            ),
            errorMessage: null,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            status: "complete"
          },
          where: {
            id: input.assistantMessageId,
            OR: [
              {
                status: {
                  in: activeMessageStatuses
                }
              },
              {
                status: "error"
              }
            ]
          }
        });
        await tx.usageEvent.deleteMany({
          where: {
            modelRunId: input.runId
          }
        });
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
        await tx.chat.update({
          data: {
            totalInputTokens: {
              increment: usage.inputTokens
            },
            totalOutputTokens: {
              increment: usage.outputTokens
            },
            totalReasoningTokens: {
              increment: usage.reasoningTokens
            }
          },
          where: {
            id: input.chatId
          }
        });
        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: input.runId
          }
        });
        const firstTerminalSequence = (latestEvent._max.sequence ?? -1) + 1;
        const terminalEvents: ModelRunSseEvent[] = [
          ...(groundedLiveOnly ? [] : input.eventsBeforeTerminal ?? []),
          {
            data: usage,
            type: "usage"
          },
          {
            data: {
              runId: input.runId,
              status: "complete"
            },
            type: "done"
          }
        ];
        await tx.modelRunEvent.createMany({
          data: terminalEvents.map((event, offset) => ({
            eventType: event.type,
            modelRunId: input.runId,
            payload: json(event.data),
            sequence: firstTerminalSequence + offset
          }))
        });
        return true;
      });
    },
    createRun: async (input) => {
      return mapActiveRunConflict(() =>
        repeatableReadTransaction(prismaClient, async (tx) => {
          const lockedChats = await tx.$queryRaw<
            Array<{ activeLeafMessageId: string | null; archived: boolean; id: string }>
          >`
            SELECT "id", "activeLeafMessageId", "archived"
            FROM "Chat"
            WHERE "id" = ${input.chatId}
              AND "userId" = ${input.userId}
            FOR UPDATE
          `;
          const lockedChat = lockedChats[0];
          if (
            !lockedChat ||
            lockedChat.archived ||
            lockedChat.activeLeafMessageId !== input.expectedActiveLeafId
          ) {
            throw new ActiveLeafConflictError();
          }

          const chat = await tx.chat.findFirst({
            select: {
              _count: {
                select: {
                  messages: true
                }
              },
              activeLeafMessageId: true,
              id: true,
              title: true
            },
            where: {
              archived: false,
              id: input.chatId,
              userId: input.userId
            }
          });

          if (!chat) {
            throw new Error("Chat not found for run creation");
          }

          const userMessage = await tx.message.create({
            data: {
              chatId: input.chatId,
              content: json(input.content),
              modelId: input.modelId,
              parentMessageId: input.expectedActiveLeafId,
              promptPresetId: input.normalizedRequest.prompt.presetId ?? null,
              provider: input.provider,
              role: "user",
              status: "complete"
            }
          });
          const assistantMessage = await tx.message.create({
            data: {
              chatId: input.chatId,
              content: json(textMessageContent("")),
              modelId: input.modelId,
              parentMessageId: userMessage.id,
              promptPresetId: input.normalizedRequest.prompt.presetId ?? null,
              provider: input.provider,
              role: "assistant",
              status: "streaming"
            }
          });

          const attachmentIds = unique(input.normalizedRequest.attachmentIds);
          if (attachmentIds.length > 0) {
            const linkedAttachments = await tx.attachment.updateMany({
              data: {
                chatId: input.chatId,
                messageId: userMessage.id
              },
              where: {
                id: {
                  in: attachmentIds
                },
                chatId: null,
                messageId: null,
                userId: input.userId
              }
            });
            if (linkedAttachments.count !== attachmentIds.length) {
              throw new AttachmentLinkConflictError();
            }
          }

          const run = await tx.modelRun.create({
            data: {
              assistantMessageId: assistantMessage.id,
              chatId: input.chatId,
              modelId: input.modelId,
              normalizedRequest: json(input.normalizedRequest),
              provider: input.provider,
              providerRequestPreview: json(input.providerRequestPreview),
              status: "streaming",
              userId: input.userId,
              userMessageId: userMessage.id
            }
          });

          await insertAcceptedMcpRunBindings(tx, {
            bindings: input.mcpBindings,
            runId: run.id,
            userId: input.userId
          });

          await insertAcceptedProviderRunBindings(tx, {
            nativeBackgroundRequested: input.normalizedRequest.params.background === true,
            plan: input.providerAdmissionPlan,
            runId: run.id,
            userId: input.userId
          });

          await persistAcceptedRunDefaults(tx, input.userId, input.defaults);

          await tx.chat.update({
            data: {
              activeLeafMessageId: assistantMessage.id,
              ...(chat._count.messages === 0
                ? {
                    defaultProviderModelId: input.defaults.modelId,
                    defaultPromptPresetId: input.normalizedRequest.prompt.presetId ?? null,
                  }
                : {})
            },
            where: {
              id: input.chatId
            }
          });

          if (chat._count.messages === 0) {
            await tx.chat.updateMany({
              data: {
                title: titleFromMessageContent(input.content)
              },
              where: {
                archived: false,
                id: input.chatId,
                title: {
                  in: ["New Chat", "Untitled QSA"]
                },
                userId: input.userId
              }
            });
          }

          return {
            assistantMessageId: assistantMessage.id,
            runId: run.id,
            userMessageId: userMessage.id
          };
        })
      );
    },
    createRegenerationRun: async (input) => {
      return mapActiveRunConflict(() =>
        repeatableReadTransaction(prismaClient, async (tx) => {
          const lockedChats = await tx.$queryRaw<Array<{ archived: boolean; id: string }>>`
            SELECT "id", "archived"
            FROM "Chat"
            WHERE "id" = ${input.chatId}
              AND "userId" = ${input.userId}
            FOR UPDATE
          `;
          if (!lockedChats[0] || lockedChats[0].archived) {
            throw new ActiveLeafConflictError();
          }

          const userMessage = await tx.message.findFirst({
            select: {
              chatId: true,
              id: true
            },
            where: {
              chat: {
                userId: input.userId
              },
              chatId: input.chatId,
              id: input.userMessageId,
              role: "user"
            }
          });

          if (!userMessage) {
            throw new Error("User message not found for regeneration");
          }

          const assistantMessage = await tx.message.create({
            data: {
              chatId: input.chatId,
              content: json(textMessageContent("")),
              modelId: input.modelId,
              parentMessageId: input.userMessageId,
              promptPresetId: input.normalizedRequest.prompt.presetId ?? null,
              provider: input.provider,
              role: "assistant",
              status: "streaming"
            }
          });
          const run = await tx.modelRun.create({
            data: {
              assistantMessageId: assistantMessage.id,
              chatId: input.chatId,
              modelId: input.modelId,
              normalizedRequest: json(input.normalizedRequest),
              provider: input.provider,
              providerRequestPreview: json(input.providerRequestPreview),
              status: "streaming",
              userId: input.userId,
              userMessageId: input.userMessageId
            }
          });

          await insertAcceptedMcpRunBindings(tx, {
            bindings: input.mcpBindings,
            runId: run.id,
            userId: input.userId
          });

          await insertAcceptedProviderRunBindings(tx, {
            nativeBackgroundRequested: input.normalizedRequest.params.background === true,
            plan: input.providerAdmissionPlan,
            runId: run.id,
            userId: input.userId
          });

          await persistAcceptedRunDefaults(tx, input.userId, input.defaults);

          await tx.chat.update({
            data: {
              activeLeafMessageId: assistantMessage.id
            },
            where: {
              id: input.chatId
            }
          });

          return {
            assistantMessageId: assistantMessage.id,
            runId: run.id,
            userMessageId: input.userMessageId
          };
        })
      );
    },
    createSearchRun: async (input) => {
      const artifacts = isRecord(input.artifacts) ? input.artifacts : null;
      const toolCall = artifacts && isRecord(artifacts.toolCall) ? artifacts.toolCall : null;
      const providerCallId = toolCall && typeof toolCall.id === "string" ? toolCall.id : null;
      if (providerCallId) {
        const existing = await prismaClient.searchRun.findFirst({
          select: { id: true },
          where: {
            artifacts: { path: ["toolCall", "id"], equals: providerCallId },
            modelRunId: input.modelRunId,
            provider: input.provider,
            strategyId: input.strategyId
          }
        });
        if (existing) return;
      }
      await prismaClient.searchRun.create({
        data: {
          artifacts: json(input.artifacts),
          modelId: input.modelId,
          modelRunId: input.modelRunId,
          provider: input.provider,
          requestPreview: json(input.requestPreview),
          status: input.status,
          strategyId: input.strategyId
        }
      });
    },
    failRun: async (runId, assistantMessageId, error) => {
      return prismaClient.$transaction(async (tx) => {
        const assistantMessage = await tx.message.findUnique({
          select: { groundedAt: true },
          where: { id: assistantMessageId }
        });
        const groundedLiveOnly = Boolean(assistantMessage?.groundedAt);
        const durableError = groundedLiveOnly
          ? { code: error.code, message: "Grounded live-only run failed." }
          : error;
        const updatedRun = await tx.modelRun.updateMany({
          data: {
            errorPayload: json(durableError),
            ...(groundedLiveOnly
              ? { finalProviderResponsePreview: json(groundedLiveOnlyProviderPreview()) }
              : {}),
            status: "error"
          },
          where: {
            id: runId,
            status: {
              in: activeModelRunStatuses
            }
          }
        });

        if (updatedRun.count === 0) {
          return false;
        }

        await tx.modelRunToolCall.updateMany({
          data: {
            completedAt: new Date(),
            state: "cancelled"
          },
          where: {
            modelRunId: runId,
            state: "pending"
          }
        });

        if (groundedLiveOnly) {
          await tx.modelRunEvent.deleteMany({
            where: {
              eventType: { in: ["artifact", "token"] },
              modelRunId: runId
            }
          });
        }

        await tx.message.updateMany({
          data: {
            ...(groundedLiveOnly
              ? { content: json(groundedLiveOnlyMessageContent()) }
              : {}),
            errorMessage: durableError.message,
            status: "error"
          },
          where: {
            id: assistantMessageId,
            status: {
              in: activeMessageStatuses
            }
          }
        });
        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: runId
          }
        });
        await tx.modelRunEvent.create({
          data: {
            eventType: "error",
            modelRunId: runId,
            payload: json(durableError),
            sequence: (latestEvent._max.sequence ?? -1) + 1
          }
        });
        return true;
      });
    },
    findOwnedChat: (chatId, userId) =>
	      prismaClient.chat.findFirst({
	        select: {
	          _count: {
	            select: {
	              messages: true
	            }
	          },
	          activeLeafMessageId: true,
	          defaultProviderModel: {
	            select: {
	              connectionId: true,
	              id: true
	            }
	          },
	          folder: {
	            select: {
	              projectMemory: true
	            }
	          },
	          id: true,
	          title: true
	        },
        where: {
          archived: false,
          id: chatId,
          userId
        }
      }).then((chat) =>
        chat
	          ? {
	              activeLeafMessageId: chat.activeLeafMessageId,
	              defaultModelId: chat.defaultProviderModel?.id ?? "",
	              defaultProvider: chat.defaultProviderModel?.connectionId ?? "",
	              id: chat.id,
	              messageCount: chat._count.messages,
	              projectMemory: chat.folder?.projectMemory ?? null,
	              title: chat.title
	            }
          : null
      ),
    findRecentActiveRunForChat: ({ chatId, since, userId }) =>
      prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true
        },
        orderBy: {
          updatedAt: "desc"
        },
        where: {
          chatId,
          userId,
          status: {
            in: activeModelRunStatuses
          },
          updatedAt: {
            gt: since
          }
        }
      }),
    findStaleActiveRunsForUser: (input) =>
      prismaClient.modelRun.findMany({
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true,
          updatedAt: true
        },
        where: {
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.runId ? { id: input.runId } : {}),
          userId: input.userId,
          status: {
            in: activeModelRunStatuses
          },
          updatedAt: {
            lt: input.staleBefore
          }
        }
      }),
    findInstallationRecoverableRuns: (input) =>
      prismaClient.modelRun.findMany({
        orderBy: { updatedAt: "asc" },
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true,
          updatedAt: true,
          userId: true
        },
        take: input.limit,
        where: {
          OR: [
            {
              createdAt: { lt: input.bootedBefore },
              OR: [
                { providerResponseId: { not: null } },
                { toolLoopState: { not: Prisma.DbNull } }
              ]
            },
            { updatedAt: { lt: input.staleBefore } }
          ],
          status: { in: activeModelRunStatuses }
        }
      }),
    findRegenerationSource: async (assistantMessageId, userId) => {
      const assistantMessage = await prismaClient.message.findFirst({
        include: {
          chat: {
            select: {
              defaultProviderModel: {
                select: {
                  connectionId: true,
                  id: true
                }
              },
              folder: {
                select: {
                  projectMemory: true
                }
              },
              id: true
            }
          },
          parent: {
            select: {
              content: true,
              id: true,
              role: true
            }
          }
        },
        where: {
          chat: {
            archived: false,
            userId
          },
          id: assistantMessageId,
          role: "assistant"
        }
      });

      if (!assistantMessage?.parent || assistantMessage.parent.role !== "user") {
        return null;
      }

      const sourceRun = await prismaClient.modelRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          providerRunBindings: {
            select: {
              connectionId: true,
              providerModelId: true
            },
            where: { role: "answer" }
          }
        },
        where: {
          assistantMessageId: assistantMessage.id,
          userId
        }
      });
      const answerBinding = sourceRun?.providerRunBindings[0];

      return {
        assistantMessage: {
          id: assistantMessage.id,
          modelId: answerBinding?.providerModelId ?? null,
          provider: answerBinding?.connectionId ?? null
        },
        chat: {
          defaultModelId: assistantMessage.chat.defaultProviderModel?.id ?? "",
          defaultProvider: assistantMessage.chat.defaultProviderModel?.connectionId ?? "",
          id: assistantMessage.chat.id,
          projectMemory: assistantMessage.chat.folder?.projectMemory ?? null
        },
        userMessage: {
          content: assistantMessage.parent.content,
          id: assistantMessage.parent.id
        }
      };
    },
    getRunControlForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true,
          chatId: true,
          errorPayload: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true
        },
        where: {
          id: runId,
          userId
        }
      });

      return run
        ? {
            assistantMessageId: run.assistantMessageId,
            chatId: run.chatId,
            id: run.id,
            modelId: run.modelId,
            provider: run.provider,
            providerResponseId: run.providerResponseId,
            recoverySettled: isRecoveredRunTerminalPayload(run.errorPayload),
            status: run.status
          }
        : null;
    },
    getRunForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        include: {
          events: {
            orderBy: {
              sequence: "asc"
            }
          },
          searchRuns: {
            orderBy: {
              createdAt: "asc"
            }
          },
          toolCalls: {
            orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }]
          }
        },
        where: {
          id: runId,
          userId
        }
      });

      if (!run) {
        return null;
      }

      return {
        assistantMessageId: run.assistantMessageId,
        chatId: run.chatId,
        createdAt: run.createdAt.toISOString(),
        errorPayload: run.errorPayload,
        estimatedCostMicros: run.estimatedCostMicros > 0 ? run.estimatedCostMicros : null,
        events: run.events.map((event) => ({
          createdAt: event.createdAt.toISOString(),
          eventType: event.eventType,
          payload: event.payload,
          sequence: event.sequence
        })),
        finalProviderResponsePreview: run.finalProviderResponsePreview,
        id: run.id,
        cachedInputTokens: run.cachedInputTokens,
        cacheWriteInputTokens: run.cacheWriteInputTokens,
        inputTokens: run.inputTokens,
        modelId: run.modelId,
        normalizedRequest: run.normalizedRequest,
        outputTokens: run.outputTokens,
        provider: run.provider,
        providerRequestPreview: run.providerRequestPreview,
        providerResponseId: run.providerResponseId,
        reasoningTokens: run.reasoningTokens,
        totalTokens: run.totalTokens,
        searchRuns: run.searchRuns.map((searchRun) => ({
          artifacts: searchRun.artifacts,
          createdAt: searchRun.createdAt.toISOString(),
          id: searchRun.id,
          modelId: searchRun.modelId,
          provider: searchRun.provider,
          requestPreview: searchRun.requestPreview,
          status: searchRun.status,
          strategyId: searchRun.strategyId,
          updatedAt: searchRun.updatedAt.toISOString()
        })),
        status: run.status,
        toolCalls: run.toolCalls.flatMap((call) => {
          const activity = persistedToolCallActivity({
            call,
            normalizedRequest: run.normalizedRequest,
            runStatus: run.status
          });
          return activity ? [activity] : [];
        }),
        updatedAt: run.updatedAt.toISOString(),
        userMessageId: run.userMessageId
      };
    },
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) => {
      const chat = await prismaClient.chat.findFirst({
        select: {
          _count: {
            select: {
              messages: true
            }
          },
          activeLeafMessageId: true,
          createdAt: true,
          defaultProviderModel: {
            select: {
              connectionId: true,
              id: true
            }
          },
          defaultPromptPresetId: true,
          folderId: true,
          id: true,
          messages: {
            include: {
              assistantModelRuns: {
                orderBy: {
                  createdAt: "desc"
                },
                select: {
                  events: {
                    orderBy: {
                      sequence: "asc"
                    },
                    select: {
                      payload: true
                    },
                    where: {
                      eventType: "artifact"
                    }
                  },
                  id: true,
                  normalizedRequest: true,
                  searchRuns: {
                    orderBy: {
                      createdAt: "asc"
                    },
                    select: {
                      artifacts: true,
                      modelId: true,
                      provider: true,
                      requestPreview: true,
                      status: true,
                      strategyId: true
                    }
                  },
                  status: true,
                  toolCalls: {
                    orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
                    select: {
                      arguments: true,
                      completedAt: true,
                      mcpRunBindingId: true,
                      ordinal: true,
                      providerCallId: true,
                      result: true,
                      roundIndex: true,
                      startedAt: true,
                      state: true,
                      toolName: true
                    }
                  }
                },
                take: 1
              }
            },
            orderBy: {
              createdAt: "asc"
            },
            where: {
              id: {
                in: [userMessageId, assistantMessageId]
              }
            }
          },
          pinned: true,
          title: true,
          updatedAt: true
        },
        where: {
          archived: false,
          id: chatId,
          userId
        }
      });

      if (!chat) {
        return null;
      }

      const usageStats = await loadChatUsageStats(prismaClient, { chatId, userId });

      return {
        chat: {
          activeLeafMessageId: chat.activeLeafMessageId,
          createdAt: chat.createdAt,
          defaultModelId: chat.defaultProviderModel?.id ?? null,
          defaultPromptPresetId: chat.defaultPromptPresetId,
          defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
          folderId: chat.folderId,
          id: chat.id,
          messageCount: chat._count.messages,
          pinned: chat.pinned,
          title: chat.title,
          updatedAt: chat.updatedAt,
          usageStats
        },
        messages: chat.messages.map((message) => {
          const modelRun = message.assistantModelRuns[0];

          return {
            artifactSummary: modelRun ? summarizeMessageRunArtifacts(modelRun) : null,
            content: message.content,
            createdAt: message.createdAt,
            errorMessage: message.errorMessage,
            id: message.id,
            modelId: message.modelId,
            modelRunId: modelRun?.id ?? null,
            parentMessageId: message.parentMessageId,
            provider: message.provider,
            role: message.role,
            status: message.status
          };
        })
      };
    },
    isPromptPresetAvailable: async (userId, promptPresetId) => {
      const prompt = await prismaClient.promptPreset.findFirst({
        select: {
          id: true
        },
        where: {
          id: promptPresetId,
          userId
        }
      });

      return Boolean(prompt);
    },
    isSearchStrategyEnabled: async (searchStrategyId) => {
      const strategy = await prismaClient.searchStrategy.findFirst({
        select: {
          strategyId: true
        },
        where: {
          enabled: true,
          strategyId: searchStrategyId
        }
      });

      return Boolean(strategy);
    },
    loadSearchStrategyConfiguration: async (searchStrategyId) => {
      const strategy = await prismaClient.searchStrategy.findFirst({
        select: {
          config: true,
          kind: true,
          modelId: true,
          provider: true,
          strategyId: true
        },
        where: {
          enabled: true,
          strategyId: searchStrategyId
        }
      });

      if (!strategy) {
        return null;
      }

      return {
        config: isRecord(strategy.config)
          ? { ...(strategy.config as Record<string, unknown>) }
          : {},
        kind: strategy.kind,
        modelId: strategy.modelId,
        provider: strategy.provider,
        strategyId: strategy.strategyId
      };
    },
    loadConversationContext: async (chatId, userId) => {
      const context = await loadConversationPath(chatId, userId, { kind: "active" });
      return context.messages;
    },
    loadConversationContextForExpectedLeaf: async (
      chatId,
      userId,
      expectedActiveLeafMessageId
    ) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "expected",
        leafMessageId: expectedActiveLeafMessageId
      });
      return context.chatMatched ? context.messages : null;
    },
    loadConversationContextForLeaf: async (chatId, userId, leafMessageId) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "explicit",
        leafMessageId
      });
      return context.messages;
    },
    loadAttachments: async (userId, attachmentIds) => {
      if (attachmentIds.length === 0) {
        return [];
      }

      const attachments = await prismaClient.attachment.findMany({
        where: {
          id: {
            in: attachmentIds
          },
          userId
        }
      });

      return attachments.map(
        (attachment): RunAttachmentRecord => ({
          byteSize: attachment.byteSize,
          extractedText: attachment.extractedText,
          fileName: attachment.fileName,
          id: attachment.id,
          kind: attachment.kind,
          metadata: attachment.metadata,
          mimeType: attachment.mimeType,
          status: attachment.status,
          storageKey: attachment.storageKey
        })
      );
    },
    loadEntitlements: (userId) => loadEntitlementsForUser(userId),
    loadModelConfiguration: async (provider, modelId) => {
      const model = await prismaClient.providerModel.findFirst({
        select: {
          capabilities: true,
          contextWindow: true,
          defaultParams: true,
          supportsNativeSearch: true,
          supportsPdf: true,
          supportsReasoning: true,
          supportsVision: true
        },
        where: {
          enabled: true,
          modelId,
          provider
        }
      });

      if (!model) {
        return null;
      }
      const defaultCapabilities =
        typeof model.capabilities === "object" && model.capabilities !== null && !Array.isArray(model.capabilities)
          ? (model.capabilities as Record<string, unknown>)
          : {};

      return {
        capabilities: {
          backgroundStreaming:
            typeof defaultCapabilities.backgroundStreaming === "boolean"
              ? defaultCapabilities.backgroundStreaming
              : false,
          contextWindow: model.contextWindow,
          defaultMaxOutputTokens: defaultMaxOutputTokens(model.defaultParams),
          nativeBackground:
            typeof defaultCapabilities.nativeBackground === "boolean"
              ? defaultCapabilities.nativeBackground
              : false,
          nativePdfInput:
            typeof defaultCapabilities.nativePdfInput === "boolean" ? defaultCapabilities.nativePdfInput : false,
          nativeSearch: model.supportsNativeSearch,
          parallelToolCalls:
            typeof defaultCapabilities.parallelToolCalls === "boolean"
              ? defaultCapabilities.parallelToolCalls
              : false,
          pdf: model.supportsPdf,
          reasoning: model.supportsReasoning,
          streaming: typeof defaultCapabilities.streaming === "boolean" ? defaultCapabilities.streaming : false,
          toolCalling:
            typeof defaultCapabilities.toolCalling === "boolean" ? defaultCapabilities.toolCalling : false,
          vision: model.supportsVision
        },
        defaultParams: isRecord(model.defaultParams)
          ? { ...(model.defaultParams as Record<string, unknown>) }
          : {}
      };
    },
    loadModelPricing: async (provider, modelId) => {
      const models = await prismaClient.providerModel.findMany({
        select: {
          inputTokenPriceMicros: true,
          outputTokenPriceMicros: true
        },
        take: 2,
        where: { modelId, provider }
      });

      return models.length === 1
        ? {
            inputTokenPriceMicros: models[0].inputTokenPriceMicros,
            outputTokenPriceMicros: models[0].outputTokenPriceMicros
          }
        : null;
    },
    loadRunUsageAttributions: async (input) => {
      const rows = await prismaClient.usageEvent.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          estimatedCostMicros: true,
          inputTokens: true,
          modelId: true,
          outputTokens: true,
          provider: true,
          reasoningTokens: true,
          totalTokens: true
        },
        where: { modelRunId: input.runId, userId: input.userId }
      });
      return rows.map((row) => ({
        estimatedCostMicros: row.estimatedCostMicros,
        modelId: row.modelId,
        provider: row.provider,
        usage: {
          cachedInputTokens: row.cachedInputTokens,
          cacheWriteInputTokens: row.cacheWriteInputTokens,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          reasoningTokens: row.reasoningTokens,
          totalTokens: row.totalTokens
        }
      }));
    },
    loadCheckpointedToolLoopRun: async (input) => {
      const run = await prismaClient.modelRun.findFirst({
        include: {
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
        calls: run.toolCalls.map(persistedToolLoopCall),
        chatId: run.chatId,
        checkpoint,
        id: run.id,
        modelId: run.modelId,
        normalizedRequest: run.normalizedRequest as unknown as CheckpointedToolLoopRun["normalizedRequest"],
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
      const pendingCheckpoint = toolLoopCheckpoint({
        phase: "tools_pending",
        providerContinuation: input.providerContinuation,
        providerCursor: input.providerCursor,
        roundIndex: input.roundIndex
      });
      if (!pendingCheckpoint) return { kind: "conflict" as const };

      return prismaClient.$transaction(async (tx) => {
        const run = await lockToolLoopRun(tx, input);
        if (!run) return { kind: "not_found" as const };
        if (run.status === "cancelled") return { kind: "cancelled" as const };
        if (!activeToolLoopRun(run)) return { kind: "conflict" as const };
        const current = parseToolLoopCheckpoint(run.toolLoopState);
        if (!current) return { kind: "conflict" as const };

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
      if (input.usageAttributions.length === 0) {
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
        const updatedRun = await tx.modelRun.updateMany({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            estimatedCostMicros,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
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
        return true;
      });
    },
    resetToolLoopAssistantDraft: async (input) => {
      if (!Number.isSafeInteger(input.roundIndex) || input.roundIndex < 0 ||
        input.roundIndex > toolLoopPersistenceLimits.roundIndex ||
        !Number.isInteger(input.sequence) || input.sequence < 0) return false;
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
        await tx.modelRunEvent.create({
          data: {
            eventType: "message_reset",
            modelRunId: input.runId,
            payload: json({ round: input.roundIndex }),
            sequence: input.sequence
          }
        });
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
          (!activeModelRunStatuses.includes(run.status) && run.status !== "error") ||
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

        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: input.runId
          }
        });
        const firstSequence = (latestEvent._max.sequence ?? -1) + 1;
        const events: ModelRunSseEvent[] = [
          ...input.events,
          {
            data: input.error,
            type: "error"
          }
        ];
        await tx.modelRunEvent.createMany({
          data: events.map((event, offset) => ({
            eventType: event.type,
            modelRunId: input.runId,
            payload: json(event.data),
            sequence: firstSequence + offset
          }))
        });

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
    markAssistantMessageGroundedLiveOnly: async (input) => {
      const provider = input.provider.trim().slice(0, 128);
      const strategy = input.strategy.trim().slice(0, 128);
      if (provider !== "gemini" || strategy !== "gemini-google-search") return false;

      return prismaClient.$transaction(async (tx) => {
        const run = await tx.modelRun.findUnique({
          select: { assistantMessageId: true, status: true },
          where: { id: input.runId }
        });
        if (
          run?.assistantMessageId !== input.assistantMessageId ||
          !activeModelRunStatuses.includes(run.status)
        ) return false;

        const updated = await tx.message.updateMany({
          data: {
            content: json(groundedLiveOnlyMessageContent()),
            groundedAt: input.groundedAt,
            groundingProvider: provider,
            groundingStrategy: strategy
          },
          where: { id: input.assistantMessageId }
        });
        if (updated.count !== 1) return false;

        await tx.modelRunEvent.deleteMany({
          where: {
            eventType: { in: ["artifact", "token"] },
            modelRunId: input.runId
          }
        });
        await tx.modelRun.update({
          data: {
            finalProviderResponsePreview: json(groundedLiveOnlyProviderPreview())
          },
          where: { id: input.runId }
        });
        return true;
      });
    },
    nextRunEventSequence: async (runId) => {
      const aggregate = await prismaClient.modelRunEvent.aggregate({
        _max: {
          sequence: true
        },
        where: {
          modelRunId: runId
        }
      });

      return (aggregate._max.sequence ?? -1) + 1;
    },
    updateRunProviderResponseId: async (runId, providerResponseId) => {
      const updated = await prismaClient.modelRun.updateMany({
        data: {
          providerResponseId
        },
        where: {
          id: runId,
          status: {
            in: activeModelRunStatuses
          }
        }
      });
      if (updated.count > 0) {
        return "published";
      }

      const current = await prismaClient.modelRun.findUnique({
        select: {
          status: true
        },
        where: {
          id: runId
        }
      });
      return current?.status === "cancelled" ? "cancelled" : "terminal";
    },
    updateRunProviderRequestPreview: async (runId, providerRequestPreview) => {
      await prismaClient.modelRun.update({
        data: {
          providerRequestPreview: json(providerRequestPreview)
        },
        where: {
          id: runId
        }
      });
    },
    updateCancelledRunProviderPreview: async (input) => {
      const preview = JSON.stringify(input.providerCancelPreview);
      const updated = await prismaClient.$executeRaw`
        UPDATE "ModelRun"
        SET
          "errorPayload" = COALESCE("errorPayload", '{}'::jsonb) ||
            jsonb_build_object('providerCancelPreview', ${preview}::jsonb),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.runId}
          AND "userId" = ${input.userId}
          AND "status" = 'cancelled'::"ModelRunStatus"
      `;

      return updated === 1;
    }
  };
}
