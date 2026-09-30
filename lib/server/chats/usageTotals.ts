import { Prisma } from "@prisma/client";
import type { ChatUsageStats } from "../../contracts/chats";

/** Call only after authorizing this chat. Usage stays cumulative across every
 * branch and actor; PostgreSQL aggregates without materializing private rows.
 * `hasCompletedAnswer` gates the Spent display: a completed answer, or usage of
 * an answer attempt (the run's own model rounds, also when the answer was
 * stopped or failed). Pre-answer receipts such as PDF preparation or optional
 * decisions alone never open it; they still count in the totals. */
export async function loadChatUsageTotals(tx: Prisma.TransactionClient, chatId: string): Promise<ChatUsageStats> {
  const [row] = await tx.$queryRaw<Array<{
    hasCompletedAnswer: boolean;
    titleUsagePending: boolean;
    recordCount: bigint; knownCostRecordCount: bigint; incompleteRecordCount: bigint;
    estimatedCostMicros: bigint | null; totalTokens: bigint | null;
  }>>(Prisma.sql`
    SELECT (EXISTS (
      SELECT 1 FROM "Message" WHERE "chatId" = ${chatId} AND "role" = 'assistant' AND "status" = 'complete'
    ) OR EXISTS (
      SELECT 1 FROM "UsageEvent" WHERE "chatId" = ${chatId} AND "modelRunId" IS NOT NULL
        AND NOT "chatPdfPreparation" AND NOT "imageGeneration" AND NOT "visionAnalysis"
        AND NOT "chatTitleGeneration" AND NOT "knowledgeRelevance" AND NOT "optionalDecision"
        AND NOT "mcpHubDiscovery"
    )) AS "hasCompletedAnswer",
      EXISTS (SELECT 1 FROM "ChatTitleGeneration" WHERE "chatId" = ${chatId}
        AND "status" IN ('pending', 'dispatched')) AS "titleUsagePending",
      COUNT(*) AS "recordCount", COUNT("estimatedCostMicros") AS "knownCostRecordCount",
      COUNT(*) FILTER (WHERE "usageCompleteness" <> 'COMPLETE') AS "incompleteRecordCount",
      SUM("estimatedCostMicros") AS "estimatedCostMicros", SUM("totalTokens") AS "totalTokens"
    FROM "UsageEvent" WHERE "chatId" = ${chatId}
  `);
  const count = (value: bigint | null) => {
    if (value === null) return null;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("chat_usage_total_out_of_range");
    return number;
  };
  if (!row) throw new Error("chat_usage_totals_missing");
  return { hasCompletedAnswer: row.hasCompletedAnswer, recordCount: count(row.recordCount)!, knownCostRecordCount: count(row.knownCostRecordCount)!,
    ...(row.titleUsagePending ? { titleUsagePending: true } : {}),
    incompleteRecordCount: count(row.incompleteRecordCount)!, estimatedCostMicros: count(row.estimatedCostMicros),
    totalTokens: count(row.totalTokens) };
}
