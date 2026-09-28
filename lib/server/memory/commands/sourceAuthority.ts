import { Prisma } from "@prisma/client";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { memoryPersistenceFailure } from "../persistence/errors";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryTransaction } from "../persistence/transaction";
import { sanitizeMemoryUtilityText } from "../retrieval/querySafety";

/** Caller holds the owner/settings lock. Ordinary appends preserve authority;
 * edits, branch changes, pause/reset, ownership loss and expired leases do not. */
export async function requireMemoryCommandSource(
  tx: MemoryTransaction,
  userId: string,
  jobId: string,
  claimToken?: string,
  now = new Date(),
  includeContext = false
) {
  const job = await tx.memoryJob.findFirst({ where: {
    id: jobId, userId, kind: "MEMORY_COMMAND", state: "CLAIMED",
    ...(claimToken ? { leaseToken: claimToken } : {}), leaseExpiresAt: { gt: now }
  } });
  if (!job?.chatId || !job.sourceMessageId || !job.sourceHash || job.branchGeneration === null) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
  const rows = await tx.$queryRaw<Array<{ content: Prisma.JsonValue; createdAt: Date; modelRunId: string }>>(Prisma.sql`
    SELECT source.content, source."createdAt", run.id AS "modelRunId"
    FROM "Chat" chat
    JOIN "Message" source ON source."chatId" = chat.id AND source.id = ${job.sourceMessageId}
    JOIN "ModelRun" run ON run."userId" = chat."userId" AND run."chatId" = chat.id
      AND run."userMessageId" = source.id AND run."assistantMessageId" = ${job.activeLeafMessageId}
    JOIN "UserMemorySettings" settings ON settings."userId" = chat."userId"
    JOIN "User" owner ON owner.id = settings."userId" AND owner.status = 'active'
    WHERE chat.id = ${job.chatId} AND chat."userId" = ${userId}
      AND chat."projectId" IS NULL AND chat."memoryMode" = 'NORMAL'
      AND chat."permanentDeletionAt" IS NULL AND source.role = 'user'
      AND settings."useMemoryFacts" = TRUE
      AND settings."memoryGeneration" = ${job.memoryGenerationSnapshot}
      AND chat."memoryBranchGeneration" = ${job.branchGeneration}
      AND ((run."assistantId" IS NULL AND run."assistantIdentity" IS NULL)
        OR EXISTS (SELECT 1 FROM "AssistantDefinition" assistant
        WHERE assistant.id = run."assistantId" AND assistant."ownerUserId" = ${userId}
          AND assistant."archivedAt" IS NULL))
      AND NOT EXISTS (SELECT 1 FROM "MemoryPauseInterval" pause WHERE pause."userId" = ${userId}
        AND pause.scope = 'MASTER'
        AND (pause."pausedAt" >= ${job.createdAt}
          OR (pause."pausedAt" <= source."createdAt"
            AND (pause."resumedAt" IS NULL OR pause."resumedAt" >= source."createdAt"))))
      AND EXISTS (WITH RECURSIVE path AS (
        SELECT message.id, message."parentMessageId" FROM "Message" message
          WHERE message."chatId" = chat.id AND message.id = chat."activeLeafMessageId"
        UNION
        SELECT parent.id, parent."parentMessageId" FROM path child JOIN "Message" parent
          ON parent.id = child."parentMessageId" AND parent."chatId" = chat.id
      ) SELECT 1 FROM path WHERE id = source.id)
    FOR UPDATE OF chat, source, run
  `);
  const source = rows[0];
  if (rows.length !== 1 || !source || memorySha256(source.content) !== job.sourceHash) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
  const content = source.content;
  const blocks = content && typeof content === "object" && !Array.isArray(content) &&
    Array.isArray(content.blocks) ? content.blocks : [];
  const text = textFromContentBlocks({ blocks });
  const safe = sanitizeMemoryUtilityText(text);
  if (!safe.eligible || !safe.safeText) return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  const ancestors = includeContext ? await tx.$queryRaw<Array<{ role: string; content: Prisma.JsonValue }>>(Prisma.sql`
    WITH RECURSIVE previous AS (
      SELECT parent.id, parent."parentMessageId", parent.role, parent.content, 1 AS depth
      FROM "Message" current JOIN "Message" parent ON parent.id = current."parentMessageId"
        AND parent."chatId" = current."chatId"
      WHERE current.id = ${job.sourceMessageId} AND current."chatId" = ${job.chatId}
      UNION ALL
      SELECT parent.id, parent."parentMessageId", parent.role, parent.content, child.depth + 1
      FROM previous child JOIN "Message" parent ON parent.id = child."parentMessageId"
        AND parent."chatId" = ${job.chatId}
      WHERE child.depth < 8
    ) SELECT role, content FROM previous ORDER BY depth DESC
  `) : [];
  const recentMessages = ancestors.flatMap<{ role: "user" | "assistant"; text: string }>((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const value = message.content;
    const messageBlocks = value && typeof value === "object" && !Array.isArray(value) &&
      Array.isArray(value.blocks) ? value.blocks : [];
    const projected = sanitizeMemoryUtilityText(textFromContentBlocks({ blocks: messageBlocks }));
    return projected.eligible && projected.safeText ? [{ role: message.role, text: projected.safeText }] : [];
  });
  return { job, modelRunId: source.modelRunId, text, safeText: safe.safeText, recentMessages };
}
