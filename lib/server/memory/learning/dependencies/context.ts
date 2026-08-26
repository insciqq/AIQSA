import { Prisma } from "@prisma/client";
import { textFromContentBlocks } from "../../../../domain/modelRunEvents";
import { projectMemoryHistorySafeText } from "../../history/safety";
import { memorySha256 } from "../../persistence/lexical";
import { memoryExactVNextDirectAuthorityPredicate } from
  "../../persistence/eligibility";
import type { MemoryTransaction } from "../../persistence/transaction";
import {
  loadAdmissibleMemoryEntityAliases,
  memoryEntityRootIdSql
} from "../entities/authority";
import {
  MEMORY_FACT_MAX_CONTEXT_CHARACTERS,
  MEMORY_FACT_MAX_CONTEXT_MESSAGES,
  MEMORY_FACT_MAX_CONTEXT_REFS,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  type MemoryFactContextRef
} from "../extraction/contract";

type ContextMessage = Readonly<{
  content: Prisma.JsonValue;
  id: string;
  role: string;
  status: string;
  updatedAt: Date;
}>;

type ContextFact = Readonly<{
  displayText: string;
  factVersionId: string;
  identitySubjectKey: string | null;
}>;

type EntityRow = Readonly<{
  canonicalId: string;
  displayName: string;
  entityType: string;
}>;

async function messageRefs(
  tx: MemoryTransaction,
  sourceMessageId: string,
  activePathMessageIds: readonly string[]
): Promise<readonly MemoryFactContextRef[]> {
  const targetIndex = activePathMessageIds.indexOf(sourceMessageId);
  if (targetIndex <= 0) return [];
  const priorIds = activePathMessageIds.slice(0, targetIndex).reverse();
  const messages = await tx.message.findMany({
    select: { content: true, id: true, role: true, status: true, updatedAt: true },
    where: { id: { in: priorIds }, role: "user", status: "complete" }
  }) as ContextMessage[];
  const byId = new Map(messages.map((message) => [message.id, message] as const));
  const refs: MemoryFactContextRef[] = [];
  let characters = 0;
  for (const id of priorIds) {
    if (refs.length >= MEMORY_FACT_MAX_CONTEXT_MESSAGES) break;
    const message = byId.get(id);
    if (!message) continue;
    const projected = projectMemoryHistorySafeText(textFromContentBlocks(
      message.content as { blocks?: unknown[] }
    ));
    if (!projected.eligible || !projected.providerSafeText) continue;
    if (characters + projected.providerSafeText.length >
      MEMORY_FACT_MAX_CONTEXT_CHARACTERS) continue;
    characters += projected.providerSafeText.length;
    refs.push({
      aliases: [],
      displayName: null,
      entityId: null,
      entityType: null,
      identitySubjectKey: null,
      kind: "MESSAGE",
      ref: `M${refs.length + 1}`,
      source: {
        contentHash: memorySha256(projected.providerSafeText),
        factVersionId: null,
        messageId: message.id,
        messageUpdatedAt: message.updatedAt.toISOString(),
        projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
      },
      text: projected.providerSafeText
    });
  }
  return refs;
}

async function factEntity(
  tx: MemoryTransaction,
  userId: string,
  factVersionId: string
): Promise<Readonly<{
  aliases: readonly string[];
  displayName: string;
  entityId: string;
  entityType: string;
}> | null> {
  const [row] = await tx.$queryRaw<EntityRow[]>(Prisma.sql`
    SELECT root."id" AS "canonicalId", root."displayName", root."entityType"
    FROM "MemoryFactVersionEntity" AS link
    INNER JOIN "MemoryEntity" AS root
      ON root."userId" = link."userId"
      AND root."id" = ${memoryEntityRootIdSql(
        userId,
        Prisma.sql`link."entityId"`
      )}
    WHERE link."userId" = ${userId}
      AND link."factVersionId" = ${factVersionId}
      AND link."role" = 'SUBJECT'::"MemoryEntityLinkRole"
    ORDER BY root."id"
    LIMIT 1
  `);
  if (!row) return null;
  const aliases = await loadAdmissibleMemoryEntityAliases(
    tx,
    userId,
    [row.canonicalId],
    4
  );
  if (aliases.length === 0) return null;
  return {
    aliases: aliases.map(({ displayAlias }) => displayAlias),
    displayName: row.displayName,
    entityId: row.canonicalId,
    entityType: row.entityType
  };
}

async function factRefs(
  tx: MemoryTransaction,
  userId: string,
  limit: number
): Promise<readonly MemoryFactContextRef[]> {
  if (limit <= 0) return [];
  const facts = await tx.$queryRaw<ContextFact[]>(Prisma.sql`
    SELECT version."id" AS "factVersionId", version."displayText",
      fact."subjectKey" AS "identitySubjectKey"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."currentVersionId" = version."id"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
    WHERE version."userId" = ${userId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."contentPurgedAt" IS NULL
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND ${memoryExactVNextDirectAuthorityPredicate(userId)}
      AND aiqsa_memory_fact_dependencies_valid(${userId}, version."id")
    ORDER BY fact."pinned" DESC, fact."lastConfirmedAt" DESC NULLS LAST,
      version."systemFrom" DESC, version."id"
    LIMIT ${limit}
  `);
  const refs: MemoryFactContextRef[] = [];
  for (const fact of facts) {
    const entity = await factEntity(tx, userId, fact.factVersionId);
    refs.push({
      aliases: entity?.aliases ?? [],
      displayName: entity?.displayName ?? null,
      entityId: entity?.entityId ?? null,
      entityType: entity?.entityType ?? null,
      identitySubjectKey: fact.identitySubjectKey,
      kind: "FACT_VERSION",
      ref: `F${refs.length + 1}`,
      source: {
        contentHash: null,
        factVersionId: fact.factVersionId,
        messageId: null,
        messageUpdatedAt: null,
        projectionVersion: null
      },
      text: fact.displayText
    });
  }
  return refs;
}

export async function loadMemoryFactContextRefs(
  tx: MemoryTransaction,
  input: Readonly<{
    activePathMessageIds: readonly string[];
    sourceMessageId: string;
    userId: string;
  }>
): Promise<readonly MemoryFactContextRef[]> {
  const messages = await messageRefs(
    tx,
    input.sourceMessageId,
    input.activePathMessageIds
  );
  const facts = await factRefs(
    tx,
    input.userId,
    MEMORY_FACT_MAX_CONTEXT_REFS - messages.length
  );
  const bounded: MemoryFactContextRef[] = [];
  let characters = 0;
  for (const context of [...messages, ...facts]) {
    if (characters + context.text.length > MEMORY_FACT_MAX_CONTEXT_CHARACTERS) {
      continue;
    }
    bounded.push(context);
    characters += context.text.length;
  }
  return bounded.slice(0, MEMORY_FACT_MAX_CONTEXT_REFS);
}
