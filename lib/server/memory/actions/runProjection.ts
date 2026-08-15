import type { PrismaClient } from "@prisma/client";
import {
  decodeMemoryActionFeedback,
  type MemoryActionFeedback
} from "../../../contracts/memory";
import {
  MEMORY_FORGET_TOOL_NAME,
  MEMORY_MARK_INCORRECT_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_UPDATE_TOOL_NAME
} from "./tools";

type MemoryRunActionClient = Pick<
  PrismaClient,
  | "memoryDeletionOutbox"
  | "memoryFactVersion"
  | "memoryFeedback"
  | "memoryOperationReceipt"
  | "modelRunToolCall"
>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function snapshotString(value: unknown, key: string): string | null {
  const candidate = record(value)?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function expectedActionToolName(operation: string): string | null {
  if (operation === "SAVE") return MEMORY_SAVE_TOOL_NAME;
  if (operation === "EDIT") return MEMORY_UPDATE_TOOL_NAME;
  if (operation === "FORGET") return MEMORY_FORGET_TOOL_NAME;
  return null;
}

function actionFeedback(
  receipt: Readonly<{
    operation: string;
    resultSnapshot: unknown;
    targetFactId: string | null;
    targetVersionId: string | null;
  }>,
  version: Readonly<{
    contentPurgedAt: Date | null;
    displayText: string | null;
    factId: string;
    id: string;
    state: string;
  }> | null,
  undoPending: boolean
): MemoryActionFeedback | null {
  const targetStateMatches = version && (receipt.operation === "FORGET"
    ? version.state === "FORGOTTEN"
    : version.state === "ACTIVE");
  const target = version && targetStateMatches && !version.contentPurgedAt && version.displayText &&
      receipt.targetFactId === version.factId && receipt.targetVersionId === version.id
    ? {
        factId: version.factId,
        statement: version.displayText,
        versionId: version.id
      }
    : null;
  const candidate = {
    ...(target ?? {}),
    ...(receipt.operation === "FORGET" && undoPending && target
      ? {
          deletionId: snapshotString(receipt.resultSnapshot, "deletionId") ?? undefined,
          expiresAt: snapshotString(receipt.resultSnapshot, "undoExpiresAt") ?? undefined
        }
      : {}),
    operation: receipt.operation === "EDIT" ? "UPDATE" : receipt.operation,
    status: "COMMITTED"
  };
  const decoded = decodeMemoryActionFeedback(candidate);
  return decoded.ok ? decoded.value : null;
}

/** Projects only committed user-visible Memory mutations for their exact runs. */
export async function loadMemoryRunActions(
  client: MemoryRunActionClient,
  input: Readonly<{ runIds: readonly string[]; userId: string }>
): Promise<ReadonlyMap<string, MemoryActionFeedback>> {
  const runIds = [...new Set(input.runIds.filter(Boolean))];
  if (runIds.length === 0) return new Map();

  const operationReceipts = await client.memoryOperationReceipt.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      modelRunId: true,
      operation: true,
      persistedToolCallId: true,
      resultSnapshot: true,
      targetFactId: true,
      targetVersionId: true
    },
    where: {
      modelRunId: { in: runIds },
      operation: { in: ["SAVE", "EDIT", "FORGET"] },
      outcome: "APPLIED",
      persistedToolCallId: { not: null },
      userId: input.userId
    }
  });
  const versionIds = [...new Set(operationReceipts.flatMap((receipt) =>
    receipt.targetVersionId ? [receipt.targetVersionId] : []))];
  const operationToolCallIds = [...new Set(operationReceipts.flatMap((receipt) =>
    receipt.persistedToolCallId ? [receipt.persistedToolCallId] : []))];
  const deletionIds = [...new Set(operationReceipts.flatMap((receipt) => {
    const deletionId = snapshotString(receipt.resultSnapshot, "deletionId");
    return deletionId ? [deletionId] : [];
  }))];

  const [versions, pendingUndoDeletions, toolCalls, incorrectFeedback] = await Promise.all([
    versionIds.length > 0
      ? client.memoryFactVersion.findMany({
          select: {
            contentPurgedAt: true,
            displayText: true,
            factId: true,
            id: true,
            state: true
          },
          where: { id: { in: versionIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    deletionIds.length > 0
      ? client.memoryDeletionOutbox.findMany({
          select: { id: true, nextAttemptAt: true, state: true },
          where: {
            id: { in: deletionIds },
            operation: "FORGET_PURGE",
            userId: input.userId
          }
        })
      : Promise.resolve([]),
    client.modelRunToolCall.findMany({
      select: { id: true, modelRunId: true, toolName: true },
      where: {
        modelRunId: { in: runIds },
        OR: [
          ...(operationToolCallIds.length > 0 ? [{ id: { in: operationToolCallIds } }] : []),
          { toolName: MEMORY_MARK_INCORRECT_TOOL_NAME }
        ]
      }
    }),
    client.memoryFeedback.findMany({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        feedbackType: true,
        id: true,
        modelRunId: true,
        modelRunToolCallId: true,
        retractsFeedbackId: true
      },
      where: {
        contentPurgedAt: null,
        feedbackType: "INCORRECT",
        modelRunId: { in: runIds },
        modelRunToolCallId: { not: null },
        userId: input.userId
      }
    })
  ]);
  const retractions = incorrectFeedback.length > 0
    ? await client.memoryFeedback.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          feedbackType: true,
          id: true,
          modelRunId: true,
          modelRunToolCallId: true,
          retractsFeedbackId: true
        },
        where: {
          contentPurgedAt: null,
          feedbackType: "RETRACT",
          retractsFeedbackId: { in: incorrectFeedback.map(({ id }) => id) },
          userId: input.userId
        }
      })
    : [];

  const versionById = new Map(versions.map((version) => [version.id, version] as const));
  const toolCallById = new Map(toolCalls.map((call) => [call.id, call] as const));
  const pendingUndoById = new Map(pendingUndoDeletions.map((deletion) => [
    deletion.id,
    deletion.state === "PENDING" && deletion.nextAttemptAt !== null &&
      deletion.nextAttemptAt > new Date()
  ] as const));
  const retractedFeedbackIds = new Set(retractions.flatMap((feedback) =>
    feedback.retractsFeedbackId ? [feedback.retractsFeedbackId] : []));
  const actionsByRun = new Map<string, MemoryActionFeedback[]>();

  for (const operationReceipt of operationReceipts) {
    const runId = operationReceipt.modelRunId;
    const toolCallId = operationReceipt.persistedToolCallId;
    const toolCall = toolCallId ? toolCallById.get(toolCallId) : null;
    if (
      !runId || !toolCallId || !toolCall || toolCall.modelRunId !== runId ||
      toolCall.toolName !== expectedActionToolName(operationReceipt.operation)
    ) continue;
    const deletionId = snapshotString(operationReceipt.resultSnapshot, "deletionId");
    const action = actionFeedback(
      operationReceipt,
      operationReceipt.targetVersionId
        ? versionById.get(operationReceipt.targetVersionId) ?? null
        : null,
      deletionId ? pendingUndoById.get(deletionId) === true : false
    );
    if (!action) continue;
    const actions = actionsByRun.get(runId) ?? [];
    actions.push(action);
    actionsByRun.set(runId, actions);
  }

  for (const feedback of incorrectFeedback) {
    if (
      retractedFeedbackIds.has(feedback.id) || !feedback.modelRunId ||
      !feedback.modelRunToolCallId
    ) continue;
    const toolCall = toolCallById.get(feedback.modelRunToolCallId);
    if (
      !toolCall || toolCall.modelRunId !== feedback.modelRunId ||
      toolCall.toolName !== MEMORY_MARK_INCORRECT_TOOL_NAME
    ) continue;
    const actions = actionsByRun.get(feedback.modelRunId) ?? [];
    actions.push({ operation: "MARK_INCORRECT", status: "COMMITTED" });
    actionsByRun.set(feedback.modelRunId, actions);
  }

  return new Map(runIds.flatMap((runId) => {
    const actions = actionsByRun.get(runId) ?? [];
    return actions.length === 1 ? [[runId, actions[0]!] as const] : [];
  }));
}
