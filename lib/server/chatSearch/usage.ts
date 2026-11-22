import type { PrismaClient } from "@prisma/client";
import { normalizeTokenUsage } from "../../domain/usage";
import { logEvent } from "../observability";
import { loadProviderModelCostBasis, providerModelUsageCostMicros, storedTokenUsage } from "../usage";

/**
 * Usage of past-chat search's own model calls: document embeddings when the index embeds passages
 * (`memory_indexing`) and query embeddings and reranking when a search runs (`memory_retrieval`). The purposes keep the
 * old Memory's identifiers so usage history stays continuous (integrator decision 2026-11-22); the rows carry no Memory
 * execution binding, which `UsageEvent_knowledge_shape_check` allows for rows without purpose flags.
 *
 * Bookkeeping after the work (root `AGENTS.md`, "Answer first"): only what the provider reported is recorded, the
 * reported cost first, else the model's stored prices, else unknown; nothing is estimated. A call that reported
 * nothing writes nothing. Recording never throws: a failed write is logged without content, so a caller may start it
 * without awaiting it and the embedding or search result never waits for it or fails with it.
 */
export type ChatSearchUsagePurpose = "memory_indexing" | "memory_retrieval";

export type ChatSearchUsageDb = Pick<PrismaClient, "providerModel" | "usageEvent">;

export type ChatSearchUsageRecord = Readonly<{
  /** The owner whose text the call processed; the row counts toward the installation's pooled cap. */
  userId: string;
  purpose: ChatSearchUsagePurpose;
  /** The catalog model the call ran on; it prices the call when the provider reported no cost. */
  providerModelId: string;
  /** The provider family and the upstream model id, as the other usage writers name them. */
  provider: string;
  modelId: string;
  usage: Readonly<{
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
  }>;
  /** USD the provider reported for exactly this call; null or absent when it reported none. */
  costUsd?: number | null;
  /** Physical provider requests the call made, retries included, when known. */
  requestCount?: number | null;
  /** The chat and run a search ran for, when a caller links them; the index links none. */
  chatId?: string | null;
  modelRunId?: string | null;
}>;

export type ChatSearchUsageOutcome = "recorded" | "skipped" | "failed";

function reportedCost(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function requestCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
}

export async function recordChatSearchUsage(
  db: ChatSearchUsageDb,
  record: ChatSearchUsageRecord
): Promise<ChatSearchUsageOutcome> {
  try {
    const usage = normalizeTokenUsage({ ...record.usage });
    const costUsd = reportedCost(record.costUsd);
    if (usage.completeness === "unavailable" && costUsd === null) return "skipped";
    const basis = await loadProviderModelCostBasis(db, record.providerModelId);
    await db.usageEvent.create({ data: {
      chatId: record.chatId ?? null,
      estimatedCostMicros: providerModelUsageCostMicros({ basis, reportedCostUsd: costUsd, usage }),
      modelId: record.modelId,
      modelRunId: record.modelRunId ?? null,
      operationCount: requestCount(record.requestCount),
      provider: record.provider,
      providerModelId: record.providerModelId,
      purpose: record.purpose,
      userId: record.userId,
      ...storedTokenUsage(usage)
    } });
    return "recorded";
  } catch (error) {
    logEvent("service_operation", {
      action: "skip", code: "chat_search_usage_unrecorded", error, outcome: "degraded",
      stage: "write", subsystem: "memory_search"
    });
    return "failed";
  }
}
