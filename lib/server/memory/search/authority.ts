import { Prisma } from "@prisma/client";
import type { MemoryTransaction } from "../persistence/transaction";

/** Settings lock is held by the caller. Both accepted messages must remain on the active branch. */
export async function requireMemorySearchActiveBranch(tx: MemoryTransaction, userId: string, runId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT run.id FROM "ModelRun" run JOIN "Chat" chat ON chat.id = run."chatId"
    WHERE run.id = ${runId} AND run."userId" = ${userId} AND chat."userId" = ${userId}
      AND chat."projectId" IS NULL AND chat."memoryMode" = 'NORMAL'
      AND chat."permanentDeletionAt" IS NULL
      AND run."status" IN ('queued', 'streaming', 'in_progress')
      AND COALESCE(run."normalizedRequest" -> 'agent', 'null'::jsonb) = 'null'::jsonb
      AND run."normalizedRequest" ->> 'toolMode' = 'auto'
      AND ((run."assistantId" IS NULL AND run."assistantIdentity" IS NULL)
        OR EXISTS (SELECT 1 FROM "AssistantDefinition" assistant
          WHERE assistant.id = run."assistantId" AND assistant."ownerUserId" = ${userId}
            AND assistant."archivedAt" IS NULL))
      AND EXISTS (WITH RECURSIVE path AS (
        SELECT message.id, message."parentMessageId" FROM "Message" message
          WHERE message."chatId" = chat.id AND message.id = chat."activeLeafMessageId"
        UNION
        SELECT parent.id, parent."parentMessageId" FROM path child JOIN "Message" parent
          ON parent.id = child."parentMessageId" AND parent."chatId" = chat.id
      ) SELECT 1 FROM path WHERE id = run."userMessageId")
      AND (run."assistantMessageId" IS NULL OR EXISTS (WITH RECURSIVE path AS (
        SELECT message.id, message."parentMessageId" FROM "Message" message
          WHERE message."chatId" = chat.id AND message.id = chat."activeLeafMessageId"
        UNION
        SELECT parent.id, parent."parentMessageId" FROM path child JOIN "Message" parent
          ON parent.id = child."parentMessageId" AND parent."chatId" = chat.id
      ) SELECT 1 FROM path WHERE id = run."assistantMessageId"))
    FOR SHARE OF run, chat
  `);
  if (rows.length !== 1) throw new Error("memory_search_authority_changed");
}
