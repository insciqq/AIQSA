import type { PrismaClient } from "@prisma/client";
import { createPrismaChatRepository } from "../../lib/server/chats/prismaRepository";

/** Read with Memory enabled, then exclude the synthetic probe through the same
 * source lifecycle as the application. Accepted answer bindings remain immutable.
 */
export async function excludeBenchmarkQuestion(prisma: PrismaClient, userId: string, chatId: string, timeoutMs = 60_000) {
  const excluded = await createPrismaChatRepository(prisma).setMemoryMode({ chatId, mode: "EXCLUDED", userId });
  if (excluded.kind !== "ok") throw new Error("longmemeval_query_exclusion_failed");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [jobs, deletions, chunks, chat] = await Promise.all([
      prisma.memoryJob.findMany({ where: { userId, chatId }, select: { state: true } }),
      prisma.memoryDeletionOutbox.count({ where: { userId, targetId: chatId, state: { not: "SUCCEEDED" } } }),
      prisma.memoryRecallChunk.count({ where: { userId, chatId, state: "ACTIVE" } }),
      prisma.chat.findFirst({ where: { userId, id: chatId }, select: { memoryMode: true } })
    ]);
    if (chat?.memoryMode !== "EXCLUDED" || jobs.some(({ state }) => state === "TERMINAL_FAILED")) {
      throw new Error("longmemeval_query_cleanup_failed");
    }
    if (deletions === 0 && chunks === 0 && jobs.every(({ state }) => ["SUCCEEDED", "STALE", "CANCELLED"].includes(state))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("longmemeval_query_cleanup_timeout");
}
