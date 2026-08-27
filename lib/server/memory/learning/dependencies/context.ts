import { Prisma } from "@prisma/client";
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
  type MemoryFactContextRef,
  type MemoryFactInputMessage
} from "../extraction/contract";

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

function messageRefs(
  messages: readonly MemoryFactInputMessage[]
): readonly MemoryFactContextRef[] {
  const refs: MemoryFactContextRef[] = [];
  let characters = 0;
  for (const message of messages) {
    if (message.evidenceEligible) continue;
    if (refs.length >= MEMORY_FACT_MAX_CONTEXT_MESSAGES) break;
    if (characters + message.text.length >
      MEMORY_FACT_MAX_CONTEXT_CHARACTERS) continue;
    characters += message.text.length;
    refs.push({
      aliases: [],
      displayName: null,
      entityId: null,
      entityType: null,
      identitySubjectKey: null,
      kind: "MESSAGE",
      ref: `M${refs.length + 1}`,
      source: {
        contentHash: message.contentHash,
        factVersionId: null,
        messageId: message.id,
        messageUpdatedAt: message.updatedAt,
        projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
      },
      text: message.text
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
  limit: number,
  factVersionIds?: readonly string[]
): Promise<readonly MemoryFactContextRef[]> {
  if (limit <= 0) return [];
  const frozenIds = factVersionIds === undefined
    ? undefined
    : [...new Set(factVersionIds)].slice(0, limit);
  if (frozenIds?.length === 0) return [];
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
      AND version."confidence" = 1.0
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND ${memoryExactVNextDirectAuthorityPredicate(userId)}
      AND aiqsa_memory_fact_dependencies_valid(${userId}, version."id")
      ${frozenIds === undefined
        ? Prisma.empty
        : Prisma.sql`AND version."id" IN (${Prisma.join(frozenIds)})`}
    ORDER BY fact."pinned" DESC, fact."lastConfirmedAt" DESC NULLS LAST,
      version."systemFrom" DESC, version."id"
    LIMIT ${limit}
  `);
  const orderedFacts = frozenIds === undefined
    ? facts
    : frozenIds.flatMap((id) => {
        const fact = facts.find(({ factVersionId }) => factVersionId === id);
        return fact ? [fact] : [];
      });
  const refs: MemoryFactContextRef[] = [];
  for (const fact of orderedFacts) {
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
    factVersionIds?: readonly string[];
    messages: readonly MemoryFactInputMessage[];
    userId: string;
  }>
): Promise<readonly MemoryFactContextRef[]> {
  const messages = messageRefs(input.messages);
  const facts = await factRefs(
    tx,
    input.userId,
    MEMORY_FACT_MAX_CONTEXT_REFS - messages.length,
    input.factVersionIds
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
