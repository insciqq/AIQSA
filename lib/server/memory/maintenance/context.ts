import { Prisma, type PrismaClient } from "@prisma/client";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { projectMemoryHistorySourceText } from "../history/safety";
import { redactMemorySecrets } from "../explicit/safety";
import { memorySha256 } from "../persistence/lexical";
import type { MemoryMaintenanceSource } from "./policy";

/** Direct evidence supplies testimony. Surrounding text only resolves scope,
 * reference, and explicit intent; assistant text cannot supply personal facts. */
export async function loadMemoryMaintenanceContext(client: Pick<PrismaClient, "$queryRaw">,
  userId: string, versionId: string, messageIds: readonly string[]): Promise<MemoryMaintenanceSource["context"] | null> {
  const rows = await client.$queryRaw<Array<{
    id: string; role: string; content: Prisma.JsonValue; updatedAt: Date; createdAt: Date; depth: number; eligible: boolean;
  }>>(Prisma.sql`
    WITH RECURSIVE context_message AS (
      SELECT message.id, message."chatId", message."parentMessageId", message.role, message.content, message."updatedAt", message."createdAt", 0 AS depth, TRUE AS eligible
      FROM "Message" message JOIN "Chat" chat ON chat.id = message."chatId"
      WHERE chat."userId" = ${userId} AND chat."projectId" IS NULL AND chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        AND chat."permanentDeletionAt" IS NULL AND message.id IN (${Prisma.join([...messageIds])}) AND message.status = 'complete'
        AND aiqsa_memory_message_dependency_valid(${userId}, message.id, message."updatedAt")
      UNION ALL
      SELECT parent.id, parent."chatId", parent."parentMessageId", parent.role,
        CASE WHEN aiqsa_memory_message_dependency_valid(${userId}, parent.id, parent."updatedAt") THEN parent.content ELSE NULL::jsonb END,
        parent."updatedAt", parent."createdAt", child.depth + 1,
        aiqsa_memory_message_dependency_valid(${userId}, parent.id, parent."updatedAt") AS eligible
      FROM "Message" parent JOIN context_message child ON parent.id = child."parentMessageId" AND parent."chatId" = child."chatId"
      WHERE child.depth < 4 AND child.eligible
    ) SELECT DISTINCT ON (id) id, role, content, "updatedAt", "createdAt", depth, eligible FROM context_message ORDER BY id, depth
  `);
  // A hidden boundary might carry the scope or explicit remember intent of a
  // fragment. Skip this review instead of making a destructive judgment from
  // incomplete context; never traverse or disclose the denied message.
  if (rows.some(({ eligible }) => !eligible) || new Set(rows.filter(({ depth }) => depth === 0)
    .map(({ id }) => id)).size !== new Set(messageIds).size) return null;
  const contexts: NonNullable<MemoryMaintenanceSource["context"]>[number][] = [];
  let size = 0;
  for (const row of rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id))) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    const projected = projectMemoryHistorySourceText(textFromContentBlocks(row.content as { blocks?: unknown[] }));
    if (!projected.eligible || projected.processingState !== "COMPLETE" || projected.providerSafeText.length > 8_000) return null;
    size += projected.providerSafeText.length;
    if (size > 16_000) return null;
    contexts.push({ kind: row.depth === 0 ? "SOURCE_MESSAGE" : "REFERENCE_MESSAGE", role: row.role,
      text: projected.providerSafeText, observedAt: row.createdAt.toISOString(),
      identityHash: memorySha256({ id: row.id, updatedAt: row.updatedAt, depth: row.depth, text: projected.providerSafeText }) });
  }
  const dependencies = await client.$queryRaw<Array<{
    id: string; sourceMessageId: string | null; sourceMessageContentHash: string | null;
    sourceMessageUpdatedAt: Date | null; sourceFactVersionId: string | null; content: Prisma.JsonValue | null;
    role: string | null; statement: string | null;
  }>>(Prisma.sql`
    SELECT dep.id, dep."sourceMessageId", dep."sourceMessageContentHash", dep."sourceMessageUpdatedAt", dep."sourceFactVersionId",
      message.content, message.role, version."displayText" AS statement
    FROM "MemoryFactVersionSourceDependency" dep
    LEFT JOIN "Message" message ON message.id = dep."sourceMessageId"
    LEFT JOIN "MemoryFactVersion" version ON version."userId" = dep."userId" AND version.id = dep."sourceFactVersionId"
    WHERE dep."userId" = ${userId} AND dep."targetFactVersionId" = ${versionId}
      AND aiqsa_memory_fact_dependencies_valid(${userId}, ${versionId}) ORDER BY dep.id LIMIT 7
  `);
  if (dependencies.length > 6) return null;
  for (const dep of dependencies) {
    const projected = dep.sourceMessageId ? projectMemoryHistorySourceText(textFromContentBlocks(dep.content as { blocks?: unknown[] })) : null;
    if (dep.sourceMessageId && (!projected?.eligible || projected.processingState !== "COMPLETE" ||
      memorySha256(projected.providerSafeText) !== dep.sourceMessageContentHash)) return null;
    const text = projected?.eligible ? projected.providerSafeText : dep.statement ? redactMemorySecrets(dep.statement).redactedText : null;
    if (!text || text.length > 8_000 || size + text.length > 16_000) return null;
    size += text.length;
    contexts.push({ kind: dep.sourceMessageId ? "REFERENCE_MESSAGE" : "FACT_DEPENDENCY", role: dep.role ?? "memory",
      text, identityHash: memorySha256({ ...dep, content: undefined, text }) });
  }
  return contexts;
}
