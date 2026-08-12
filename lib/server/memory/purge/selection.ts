import { Prisma } from "@prisma/client";
import type { MemoryPurgeTarget } from "./contract";

/** SQL predicate for a query whose target version alias is exactly `version`. */
export function memoryPurgeVersionCondition(target: MemoryPurgeTarget): Prisma.Sql {
  if (target.kind === "MEMORY_FACT") {
    return Prisma.sql`
      version."userId" = ${target.userId}
      AND version."factId" = ${target.targetId}
      AND version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
    `;
  }
  if (target.kind === "AUTOMATIC_SET") {
    return Prisma.sql`
      version."userId" = ${target.userId}
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
      AND version."createdAt" <= (
        SELECT barrier."createdAt"
        FROM "MemorySourceBarrier" AS barrier
        WHERE barrier."userId" = ${target.userId}
          AND barrier."id" = ${target.targetId}
          AND barrier."kind" = 'AUTOMATIC_FACTS'::"MemorySourceBarrierKind"
      )
    `;
  }
  if (target.kind === "ALL_REUSABLE") {
    return Prisma.sql`
      version."userId" = ${target.userId}
      AND version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
      AND (
        version."createdAt" <= (
          SELECT barrier."createdAt"
          FROM "MemorySourceBarrier" AS barrier
          WHERE barrier."userId" = ${target.userId}
            AND barrier."id" = ${target.targetId}
            AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryEvidence" AS source_evidence
          INNER JOIN "Message" AS source_message
            ON source_message."chatId" = source_evidence."chatId"
            AND source_message."id" = source_evidence."messageId"
          WHERE source_evidence."userId" = version."userId"
            AND source_evidence."factVersionId" = version."id"
            AND source_evidence."sourceType" = 'MESSAGE'::"MemoryEvidenceSourceType"
            AND source_message."createdAt" <= (
              SELECT barrier."sourceCreatedAtCutoff"
              FROM "MemorySourceBarrier" AS barrier
              WHERE barrier."userId" = ${target.userId}
                AND barrier."id" = ${target.targetId}
                AND barrier."kind" = 'ALL_REUSABLE'::"MemorySourceBarrierKind"
            )
        )
      )
    `;
  }
  return Prisma.sql`
    version."userId" = ${target.userId}
    AND version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
    AND EXISTS (
      SELECT 1
      FROM "MemoryFactVersion" AS explicit_marker
      WHERE explicit_marker."userId" = version."userId"
        AND explicit_marker."factId" = version."factId"
        AND explicit_marker."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        AND explicit_marker."state" = 'FORGOTTEN'::"MemoryFactVersionState"
    )
  `;
}
