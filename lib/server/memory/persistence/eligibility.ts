import { Prisma, type PrismaClient } from "@prisma/client";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "../learning/extraction/contract";
import { projectMemoryHistorySafeText } from "../history/safety";
import { memorySha256 } from "./lexical";
import { memoryAutomaticEvidencePausePredicate } from "./pauseIntervals";
import { memoryFactDependenciesPredicate } from "../learning/dependencies/repository";

export type PersonalMemoryEvidenceSnapshot = Readonly<{
  branchGeneration: number;
  chatId: string;
  evidenceFingerprint: string | null;
  factVersionId: string;
  id: string;
  messageId: string;
  observedAt: Date;
  safeSourceHash: string;
  sourceMessageContentHash: string | null;
  sourceProjectionVersion: string;
}>;

type PersonalMemoryEvidenceQueryRow = PersonalMemoryEvidenceSnapshot & Readonly<{
  content: Prisma.JsonValue;
  safeExcerpt: string;
  sourceEndOffset: number | null;
  sourceStartOffset: number | null;
}>;

export function memoryExactMessageEvidenceIsCurrent(input: Readonly<{
  content: Prisma.JsonValue;
  evidenceFingerprint: string | null;
  safeExcerpt: string;
  safeSourceHash: string;
  sourceEndOffset: number | null;
  sourceMessageContentHash: string | null;
  sourceProjectionVersion: string;
  sourceStartOffset: number | null;
}>): boolean {
  if (
    input.sourceProjectionVersion !== MEMORY_FACT_SOURCE_PROJECTION_VERSION ||
    input.evidenceFingerprint === null ||
    !/^[a-f0-9]{64}$/u.test(input.evidenceFingerprint) ||
    input.sourceMessageContentHash === null ||
    !/^[a-f0-9]{64}$/u.test(input.sourceMessageContentHash) ||
    input.safeSourceHash !== input.sourceMessageContentHash ||
    !Number.isSafeInteger(input.sourceStartOffset) ||
    !Number.isSafeInteger(input.sourceEndOffset) ||
    input.sourceStartOffset === null || input.sourceEndOffset === null ||
    input.sourceStartOffset < 0 || input.sourceEndOffset <= input.sourceStartOffset
  ) return false;
  const projected = projectMemoryHistorySafeText(
    textFromContentBlocks(input.content as { blocks?: unknown[] })
  );
  return projected.eligible && projected.safeText !== null &&
    memorySha256(projected.safeText) === input.sourceMessageContentHash &&
    projected.safeText.slice(input.sourceStartOffset, input.sourceEndOffset) ===
      input.safeExcerpt;
}

function personalEvidenceWhere(
  userId: string | Prisma.Sql,
  factVersionId: Prisma.Sql,
  exactVNext = false
): Prisma.Sql {
  const exact = exactVNext
    ? Prisma.sql`
        AND support."evidenceFingerprint" IS NOT NULL
        AND support."sourceStartOffset" IS NOT NULL
        AND support."sourceEndOffset" IS NOT NULL
        AND support."sourceMessageContentHash" IS NOT NULL
        AND support."safeSourceHash" = support."sourceMessageContentHash"
        AND support."sourceProjectionVersion" =
          ${MEMORY_FACT_SOURCE_PROJECTION_VERSION}
      `
    : Prisma.empty;
  return Prisma.sql`
    support."userId" = ${userId}
    AND support."factVersionId" = ${factVersionId}
    AND support."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
    AND support."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
    AND support."sourceRole" = 'user'
    ${exact}
    AND evidence_message."status" = 'complete'::"MessageStatus"
    AND EXISTS (
      WITH RECURSIVE active_path AS (
        SELECT
          leaf."id",
          leaf."parentMessageId",
          ARRAY[leaf."id"]::text[] AS visited,
          FALSE AS cycle
        FROM "Message" AS leaf
        WHERE leaf."chatId" = evidence_chat."id"
          AND leaf."id" = evidence_chat."activeLeafMessageId"

        UNION ALL

        SELECT
          parent."id",
          parent."parentMessageId",
          child.visited || parent."id",
          parent."id" = ANY(child.visited)
        FROM active_path AS child
        INNER JOIN "Message" AS parent
          ON parent."chatId" = evidence_chat."id"
          AND parent."id" = child."parentMessageId"
        WHERE NOT child.cycle
      )
      SELECT 1
      FROM active_path
      WHERE active_path."id" = support."messageId"
        AND NOT active_path.cycle
    )
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

/**
 * Canonical row-level authority for an automatic fact's exact Message
 * evidence. Callers expose `support`, `evidence_chat`, and `evidence_message`
 * with the joins used by this module.
 */
export function memoryPersonalEvidenceRowPredicate(
  userId: string | Prisma.Sql,
  factVersionId: Prisma.Sql = Prisma.sql`version."id"`,
  options: Readonly<{ exactVNext?: boolean }> = {}
): Prisma.Sql {
  return personalEvidenceWhere(userId, factVersionId, options.exactVNext === true);
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
    INNER JOIN "Message" AS evidence_message
      ON evidence_message."chatId" = support."chatId"
      AND evidence_message."id" = support."messageId"
      AND evidence_message."role" = 'user'
  `;
}

export function memoryPersonalEvidenceCount(
  userId: string | Prisma.Sql,
  factVersionId: Prisma.Sql = Prisma.sql`version."id"`,
  options: Readonly<{ exactVNext?: boolean }> = {}
): Prisma.Sql {
  return Prisma.sql`(
    SELECT COUNT(*)::integer
    ${personalEvidenceJoins()}
    WHERE ${personalEvidenceWhere(userId, factVersionId, options.exactVNext === true)}
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
    exactVNext?: boolean;
    factVersionId?: Prisma.Sql;
    sourceMode?: Prisma.Sql;
  }> = {}
): Prisma.Sql {
  const factVersionId = input.factVersionId ?? Prisma.sql`version."id"`;
  const sourceMode = input.sourceMode ?? Prisma.sql`version."sourceMode"`;
  return Prisma.sql`(
    (
      ${sourceMode} = 'EXPLICIT'::"MemoryFactSourceMode"
      OR ${memoryPersonalEvidenceCount(userId, factVersionId, {
        exactVNext: input.exactVNext
      })} > 0
    )
    AND ${memoryFactDependenciesPredicate(userId, factVersionId)}
  )`;
}

/**
 * Exact provenance fence for direct reusable facts. Explicit rows keep their
 * user-authored authority; automatic rows must come from the current governed
 * extraction pipeline and carry both the version-level ingestion identity and
 * exact current Message evidence. Callers remain responsible for lifecycle,
 * safety, and scope policy.
 */
export function memoryExactVNextDirectAuthorityPredicate(
  userId: string | Prisma.Sql,
  input: Readonly<{
    factVersionId?: Prisma.Sql;
    sourceMode?: Prisma.Sql;
    version?: Prisma.Sql;
  }> = {}
): Prisma.Sql {
  const version = input.version ?? Prisma.sql`version`;
  const factVersionId = input.factVersionId ?? Prisma.sql`${version}."id"`;
  const sourceMode = input.sourceMode ?? Prisma.sql`${version}."sourceMode"`;
  return Prisma.sql`(
    ${version}."modality" <> 'PATTERN'::"MemoryFactModality"
    AND ${version}."directness" IN (
      'DIRECT'::"MemoryDirectness",
      'PARAPHRASED'::"MemoryDirectness"
    )
    AND ${version}."synthesisDepth" = 0
    AND ${version}."synthesisGeneration" IS NULL
    AND ${version}."synthesisSourceSetFingerprint" IS NULL
    AND
    (
      ${sourceMode} = 'EXPLICIT'::"MemoryFactSourceMode"
      OR (
        ${sourceMode} = 'AUTOMATIC'::"MemoryFactSourceMode"
        AND ${version}."ingestionFingerprint" ~ '^[a-f0-9]{64}$'
        AND ${version}."pipelineVersion" =
          ${MEMORY_FACT_EXTRACTION_PIPELINE_VERSION}
      )
    )
    AND ${memoryPersonalFactEvidencePredicate(userId, {
      exactVNext: true,
      factVersionId,
      sourceMode
    })}
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
  factVersionIds: readonly string[],
  options: Readonly<{ exactVNext?: boolean }> = {}
): Promise<readonly PersonalMemoryEvidenceSnapshot[]> {
  const ids = [...new Set(factVersionIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await client.$queryRaw<PersonalMemoryEvidenceQueryRow[]>(Prisma.sql`
    SELECT
      support."branchGeneration",
      support."chatId",
      evidence_message."content",
      support."evidenceFingerprint",
      support."factVersionId",
      support."id",
      support."messageId",
      support."observedAt",
      support."safeExcerpt",
      support."safeSourceHash",
      support."sourceEndOffset",
      support."sourceMessageContentHash",
      support."sourceProjectionVersion",
      support."sourceStartOffset"
    ${personalEvidenceJoins()}
    WHERE support."factVersionId" IN (${Prisma.join(ids)})
      AND ${personalEvidenceWhere(
        userId,
        Prisma.sql`support."factVersionId"`,
        options.exactVNext === true
      )}
    ORDER BY support."factVersionId", support."createdAt", support."id"
  `);
  return rows.flatMap((row) => {
    if (options.exactVNext && !memoryExactMessageEvidenceIsCurrent(row)) return [];
    const {
      content: _content,
      safeExcerpt: _safeExcerpt,
      sourceEndOffset: _sourceEndOffset,
      sourceStartOffset: _sourceStartOffset,
      ...snapshot
    } = row;
    return [snapshot];
  });
}
