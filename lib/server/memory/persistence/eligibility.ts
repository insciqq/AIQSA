import { Prisma, type PrismaClient } from "@prisma/client";
import { memoryAutomaticEvidencePausePredicate } from "./pauseIntervals";

export type PersonalMemoryEvidenceSnapshot = Readonly<{
  branchGeneration: number;
  chatId: string;
  factVersionId: string;
  id: string;
  messageId: string;
  observedAt: Date;
  safeSourceHash: string;
  sourceProjectionVersion: string;
}>;

function personalEvidenceWhere(
  userId: string | Prisma.Sql,
  factVersionId: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`
    support."userId" = ${userId}
    AND support."factVersionId" = ${factVersionId}
    AND support."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
    AND support."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
    AND support."sourceRole" = 'user'
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySuppression" AS source_suppression
      WHERE source_suppression."userId" = support."userId"
        AND source_suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
        AND source_suppression."sourceChatId" = support."chatId"
        AND source_suppression."sourceMessageId" = support."messageId"
        AND (source_suppression."sourceBranchGeneration" IS NULL
          OR source_suppression."sourceBranchGeneration" = support."branchGeneration")
        AND (source_suppression."expiresAt" IS NULL
          OR source_suppression."expiresAt" > CURRENT_TIMESTAMP)
    )
    AND NOT EXISTS (
      SELECT 1 FROM "MemorySourceBarrier" AS source_barrier
      WHERE source_barrier."userId" = support."userId"
        AND source_barrier."kind" IN (
          'AUTOMATIC_FACTS'::"MemorySourceBarrierKind",
          'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        AND source_barrier."explicitOverrideAllowed" = FALSE
        AND evidence_message."createdAt" <= source_barrier."sourceCreatedAtCutoff"
    )
    AND ${memoryAutomaticEvidencePausePredicate(userId)}
  `;
}

function personalEvidenceJoins(): Prisma.Sql {
  return Prisma.sql`
    FROM "MemoryEvidence" AS support
    INNER JOIN "Chat" AS evidence_chat
      ON evidence_chat."userId" = support."userId"
      AND evidence_chat."id" = support."chatId"
      AND evidence_chat."projectId" IS NULL
      AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND evidence_chat."permanentDeletionAt" IS NULL
      AND evidence_chat."memoryBranchGeneration" = support."branchGeneration"
    INNER JOIN "Message" AS evidence_message
      ON evidence_message."chatId" = support."chatId"
      AND evidence_message."id" = support."messageId"
      AND evidence_message."role" = 'user'
  `;
}

export function memoryPersonalEvidenceCount(
  userId: string | Prisma.Sql,
  factVersionId: Prisma.Sql = Prisma.sql`version."id"`
): Prisma.Sql {
  return Prisma.sql`(
    SELECT COUNT(*)::integer
    ${personalEvidenceJoins()}
    WHERE ${personalEvidenceWhere(userId, factVersionId)}
  )`;
}

export function memoryPersonalEvidenceLatestAt(
  userId: string | Prisma.Sql,
  factVersionId: Prisma.Sql = Prisma.sql`version."id"`
): Prisma.Sql {
  return Prisma.sql`(
    SELECT MAX(support."observedAt")
    ${personalEvidenceJoins()}
    WHERE ${personalEvidenceWhere(userId, factVersionId)}
  )`;
}

/**
 * Canonical Personal-v1 fact eligibility. Callers expose the current
 * MemoryFactVersion as `version`. Explicit facts are self-authored; automatic
 * facts must retain current, unsuppressed user evidence from a personal Normal
 * chat and from a source period that was eligible for learning.
 */
export function memoryPersonalFactEvidencePredicate(
  userId: string | Prisma.Sql,
  input: Readonly<{
    factVersionId?: Prisma.Sql;
    sourceMode?: Prisma.Sql;
  }> = {}
): Prisma.Sql {
  const factVersionId = input.factVersionId ?? Prisma.sql`version."id"`;
  const sourceMode = input.sourceMode ?? Prisma.sql`version."sourceMode"`;
  return Prisma.sql`(
    ${sourceMode} = 'EXPLICIT'::"MemoryFactSourceMode"
    OR ${memoryPersonalEvidenceCount(userId, factVersionId)} > 0
  )`;
}

export async function loadPersonalMemoryRunIds(
  client: Pick<PrismaClient, "modelRun">,
  userId: string,
  runIds: readonly string[]
): Promise<ReadonlySet<string>> {
  if (runIds.length === 0) return new Set();
  const runs = await client.modelRun.findMany({
    select: { id: true },
    where: {
      chat: {
        memoryMode: "NORMAL",
        permanentDeletionAt: null,
        projectId: null
      },
      id: { in: [...runIds] },
      userId
    }
  });
  return new Set(runs.map(({ id }) => id));
}

export async function loadPersonalEligibleFactVersionIds(
  client: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  factVersionIds: readonly string[]
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(factVersionIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT version."id"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE version."userId" = ${userId}
      AND version."id" IN (${Prisma.join(ids)})
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      AND scope."targetIdSnapshot" IS NULL
      AND scope."targetDisplaySnapshot" IS NULL
      AND scope."folderId" IS NULL
      AND scope."assistantId" IS NULL
      AND scope."chatId" IS NULL
      AND ${memoryPersonalFactEvidencePredicate(userId)}
  `);
  return new Set(rows.map(({ id }) => id));
}

export async function loadPersonalMemoryEvidenceSnapshots(
  client: Pick<PrismaClient, "$queryRaw">,
  userId: string,
  factVersionIds: readonly string[]
): Promise<readonly PersonalMemoryEvidenceSnapshot[]> {
  const ids = [...new Set(factVersionIds.filter(Boolean))];
  if (ids.length === 0) return [];
  return client.$queryRaw<PersonalMemoryEvidenceSnapshot[]>(Prisma.sql`
    SELECT
      support."branchGeneration",
      support."chatId",
      support."factVersionId",
      support."id",
      support."messageId",
      support."observedAt",
      support."safeSourceHash",
      support."sourceProjectionVersion"
    ${personalEvidenceJoins()}
    WHERE support."factVersionId" IN (${Prisma.join(ids)})
      AND ${personalEvidenceWhere(userId, Prisma.sql`support."factVersionId"`)}
    ORDER BY support."factVersionId", support."createdAt", support."id"
  `);
}
