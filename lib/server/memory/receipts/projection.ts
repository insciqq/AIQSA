import type { PrismaClient } from "@prisma/client";
import {
  MEMORY_FORGET_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_UPDATE_TOOL_NAME
} from "../actions/tools";
import {
  decodeMemoryActionFeedback,
  decodeMemoryReceipt,
  type MemoryActionFeedback,
  type MemoryReceipt,
  type MemoryReceiptItem,
  type MemoryReceiptItemType,
  type MemoryScopeType
} from "../../../contracts/memory";

type MemoryReceiptClient = Pick<
  PrismaClient,
  | "chat"
  | "memoryFact"
  | "memoryFactVersion"
  | "memoryOperationReceipt"
  | "memoryRetrievalAttemptItem"
  | "modelRunMemoryBinding"
  | "modelRunMemoryItem"
  | "modelRunToolCall"
>;

export type MemoryRunEvidenceProjection = Readonly<{
  action: MemoryActionFeedback | null;
  receipt: MemoryReceipt | null;
}>;

const sourceModes = new Set(["EXPLICIT", "AUTOMATIC", "HISTORY", "PROFILE"]);
const scopeTypes = new Set(["GLOBAL_USER", "FOLDER", "ASSISTANT", "CHAT"]);
const itemTypes = new Set(["FACT_VERSION", "EPISODE", "RECALL_CHUNK", "PROFILE"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function frozenSourceMode(value: unknown): MemoryReceiptItem["sourceMode"] | null {
  const candidate = record(value)?.sourceMode;
  return typeof candidate === "string" && sourceModes.has(candidate)
    ? candidate as MemoryReceiptItem["sourceMode"]
    : null;
}

function frozenScopeType(value: unknown): MemoryScopeType | null {
  const candidate = record(value)?.scopeType;
  return typeof candidate === "string" && scopeTypes.has(candidate)
    ? candidate as MemoryScopeType
    : null;
}

function receiptItemType(value: string): MemoryReceiptItemType | null {
  return itemTypes.has(value) ? value as MemoryReceiptItemType : null;
}

function actionFeedback(operation: string): MemoryActionFeedback | null {
  const candidate = {
    operation: operation === "EDIT" ? "UPDATE" : operation,
    status: "COMMITTED"
  };
  const decoded = decodeMemoryActionFeedback(candidate);
  return decoded.ok ? decoded.value : null;
}

function expectedActionToolName(operation: string): string | null {
  if (operation === "SAVE") return MEMORY_SAVE_TOOL_NAME;
  if (operation === "EDIT") return MEMORY_UPDATE_TOOL_NAME;
  if (operation === "FORGET") return MEMORY_FORGET_TOOL_NAME;
  return null;
}

/**
 * Loads private evidence for exact accepted runs in bounded batches. Receipt
 * text, ordinals, version IDs, source snapshots, and selection reasons come
 * from immutable admission rows. Current fact/chat reads may only add a later
 * lifecycle label; they never replace the frozen content.
 */
export async function loadMemoryRunEvidence(
  client: MemoryReceiptClient,
  input: Readonly<{ runIds: readonly string[]; userId: string }>
): Promise<ReadonlyMap<string, MemoryRunEvidenceProjection>> {
  const runIds = [...new Set(input.runIds.filter(Boolean))];
  if (runIds.length === 0) return new Map();

  const bindings = await client.modelRunMemoryBinding.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      degradationCode: true,
      id: true,
      modelRunId: true,
      outcome: true,
      retrievalAttemptId: true
    },
    where: { modelRunId: { in: runIds }, userId: input.userId }
  });
  const bindingIds = bindings.map(({ id }) => id);
  const attemptIds = bindings.map(({ retrievalAttemptId }) => retrievalAttemptId);
  const [items, attemptItems, operationReceipts] = await Promise.all([
    bindingIds.length > 0
      ? client.modelRunMemoryItem.findMany({
          orderBy: [{ bindingId: "asc" }, { ordinal: "asc" }],
          select: {
            bindingId: true,
            factVersionId: true,
            includedText: true,
            itemType: true,
            ordinal: true,
            selectionReason: true,
            sourceChatIdSnapshot: true,
            sourceMessageIdsSnapshot: true
          },
          where: { bindingId: { in: bindingIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    attemptIds.length > 0
      ? client.memoryRetrievalAttemptItem.findMany({
          orderBy: [{ attemptId: "asc" }, { ordinal: "asc" }],
          select: {
            attemptId: true,
            ordinal: true,
            sourceSnapshot: true,
            versionSnapshot: true
          },
          where: { attemptId: { in: attemptIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    client.memoryOperationReceipt.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        modelRunId: true,
        operation: true,
        persistedToolCallId: true
      },
      where: {
        modelRunId: { in: runIds },
        operation: { in: ["SAVE", "EDIT", "FORGET"] },
        outcome: "APPLIED",
        persistedToolCallId: { not: null },
        userId: input.userId
      }
    })
  ]);

  const factVersionIds = [...new Set(items.flatMap((item) =>
    item.factVersionId ? [item.factVersionId] : []))];
  const sourceChatIds = [...new Set(items.flatMap((item) =>
    item.sourceChatIdSnapshot ? [item.sourceChatIdSnapshot] : []))];
  const toolCallIds = [...new Set(operationReceipts.flatMap((receipt) =>
    receipt.persistedToolCallId ? [receipt.persistedToolCallId] : []))];
  const [versions, liveChats, toolCalls] = await Promise.all([
    factVersionIds.length > 0
      ? client.memoryFactVersion.findMany({
          select: {
            contentPurgedAt: true,
            factId: true,
            id: true,
            sourceMode: true,
            state: true
          },
          where: { id: { in: factVersionIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    sourceChatIds.length > 0
      ? client.chat.findMany({
          select: { id: true },
          where: { id: { in: sourceChatIds }, userId: input.userId }
        })
      : Promise.resolve([]),
    toolCallIds.length > 0
      ? client.modelRunToolCall.findMany({
          select: { id: true, modelRunId: true, toolName: true },
          where: {
            id: { in: toolCallIds },
            modelRunId: { in: runIds }
          }
        })
      : Promise.resolve([])
  ]);
  const factIds = [...new Set(versions.map(({ factId }) => factId))];
  const facts = factIds.length > 0
    ? await client.memoryFact.findMany({
        select: { id: true, state: true },
        where: { id: { in: factIds }, userId: input.userId }
      })
    : [];

  const itemsByBinding = new Map<string, typeof items>();
  for (const item of items) {
    const current = itemsByBinding.get(item.bindingId) ?? [];
    current.push(item);
    itemsByBinding.set(item.bindingId, current);
  }
  const snapshotsByAttemptOrdinal = new Map(
    attemptItems.map((item) => [`${item.attemptId}:${item.ordinal}`, item] as const)
  );
  const versionById = new Map(versions.map((version) => [version.id, version] as const));
  const factById = new Map(facts.map((fact) => [fact.id, fact] as const));
  const liveChatIds = new Set(liveChats.map(({ id }) => id));
  const toolCallById = new Map(toolCalls.map((call) => [call.id, call] as const));
  const actionsByRun = new Map<string, MemoryActionFeedback[]>();
  for (const operationReceipt of operationReceipts) {
    const runId = operationReceipt.modelRunId;
    const toolCallId = operationReceipt.persistedToolCallId;
    const toolCall = toolCallId ? toolCallById.get(toolCallId) : null;
    if (
      !runId || !toolCallId || !toolCall || toolCall.modelRunId !== runId ||
      toolCall.toolName !== expectedActionToolName(operationReceipt.operation)
    ) continue;
    const feedback = actionFeedback(operationReceipt.operation);
    if (!feedback) continue;
    const actions = actionsByRun.get(runId) ?? [];
    actions.push(feedback);
    actionsByRun.set(runId, actions);
  }

  const projected = new Map<string, MemoryRunEvidenceProjection>();
  for (const binding of bindings) {
    const bindingItems = itemsByBinding.get(binding.id) ?? [];
    const receiptItems = bindingItems.map((item): MemoryReceiptItem => {
      const itemType = receiptItemType(item.itemType);
      if (!itemType) throw new Error("memory_run_receipt_item_type_invalid");
      const snapshot = snapshotsByAttemptOrdinal.get(
        `${binding.retrievalAttemptId}:${item.ordinal}`
      );
      const version = item.factVersionId ? versionById.get(item.factVersionId) : null;
      const fact = version ? factById.get(version.factId) : null;
      const sourceDeleted = Boolean(
        item.sourceChatIdSnapshot && !liveChatIds.has(item.sourceChatIdSnapshot)
      );
      const laterForgotten = itemType === "FACT_VERSION" && (
        !version || !fact || version.state === "FORGOTTEN" ||
        version.contentPurgedAt !== null || fact.state === "FORGOTTEN"
      );
      const sourceMode = frozenSourceMode(snapshot?.sourceSnapshot) ??
        (version && sourceModes.has(version.sourceMode)
          ? version.sourceMode as MemoryReceiptItem["sourceMode"]
          : "EXPLICIT");

      return {
        includedText: item.includedText,
        itemType,
        lifecycleState: sourceDeleted
          ? "SOURCE_DELETED"
          : laterForgotten ? "LATER_FORGOTTEN" : "CURRENT",
        ordinal: item.ordinal,
        scopeType: frozenScopeType(snapshot?.versionSnapshot),
        selectionReason: item.selectionReason,
        sourceChatId: sourceDeleted ? null : item.sourceChatIdSnapshot,
        sourceMessageIds: item.sourceMessageIdsSnapshot,
        sourceMode,
        versionId: item.factVersionId
      };
    });
    const candidate = {
      degradationCode: binding.degradationCode,
      itemCount: receiptItems.length,
      items: receiptItems,
      outcome: binding.outcome,
      summary: `memory_receipt:${binding.outcome.toLowerCase()}:${receiptItems.length}`
    };
    const decoded = decodeMemoryReceipt(candidate);
    if (!decoded.ok) throw new Error("memory_run_receipt_invalid");
    const actions = actionsByRun.get(binding.modelRunId) ?? [];
    projected.set(binding.modelRunId, {
      action: actions.length === 1 ? actions[0]! : null,
      receipt: decoded.value
    });
  }

  for (const runId of runIds) {
    if (projected.has(runId)) continue;
    const actions = actionsByRun.get(runId) ?? [];
    if (actions.length === 1) {
      projected.set(runId, { action: actions[0]!, receipt: null });
    }
  }
  return projected;
}
