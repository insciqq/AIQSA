import { Prisma, type PrismaClient } from "@prisma/client";
import { MEMORY_STATEMENT_MAX_LENGTH } from "../../../../contracts/memory";
import type { MemoryJobDescriptor } from "../../coordinator/types";
import { isValidMemoryExecutionIdentifier } from "../../execution/owner";
import { projectMemoryHistorySafeText } from "../../history/safety";
import { memorySha256 } from "../../persistence/lexical";
import {
  memoryExplicitFactReceiptAuthorityPredicate,
  memoryReusableFactAuthorityPredicate
} from "../../synthesis/eligibility";
import {
  assertMemoryExplicitRelationSnapshot,
  isMemoryExplicitRelationJob,
  MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES,
  type MemoryExplicitRelationFact,
  type MemoryExplicitRelationSnapshot
} from "./explicitPolicy";

type Reader = Pick<PrismaClient, "$queryRaw">;

type ExplicitFactRow = Readonly<{
  createdAt: Date;
  expectedAt: Date | null;
  expiresAt: Date | null;
  factId: string;
  memoryGeneration: number;
  modality: string;
  observedAt: Date | null;
  occurredAt: Date | null;
  pinned: boolean;
  scopeId: string;
  statement: string;
  systemFrom: Date;
  validFrom: Date | null;
  validTo: Date | null;
  versionId: string;
}>;

export type MemoryExplicitRelationEvidence = Readonly<{
  createdAt: Date;
  factVersionId: string;
  id: string;
  memoryEventId: string;
  observedAt: Date;
  safeExcerpt: string;
  safeSourceHash: string;
  safetyClass: "NORMAL" | "SENSITIVE";
  sourceProjectionVersion: string;
}>;

export type MemoryExplicitRelationCurrentFact = Readonly<{
  evidence: readonly MemoryExplicitRelationEvidence[];
  fact: MemoryExplicitRelationFact;
  memoryGeneration: number;
}>;

function safeExactText(value: string): boolean {
  const safe = projectMemoryHistorySafeText(value);
  return safe.eligible && safe.safeText === value;
}

/** Rejoins exact current global explicit versions, owner receipts and safe
 * independent support. Retrieval candidates alone never reach the provider. */
export async function loadCurrentMemoryExplicitRelationFacts(
  db: Reader,
  userId: string,
  versionIds: readonly string[]
): Promise<ReadonlyMap<string, MemoryExplicitRelationCurrentFact>> {
  if (!isValidMemoryExecutionIdentifier(userId) ||
    versionIds.length > MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES + 1 ||
    versionIds.some((id) => !isValidMemoryExecutionIdentifier(id)) ||
    new Set(versionIds).size !== versionIds.length) {
    throw new Error("memory_explicit_relation_snapshot_invalid");
  }
  if (versionIds.length === 0) return new Map();
  const rows = await db.$queryRaw<ExplicitFactRow[]>(Prisma.sql`
    SELECT fact."createdAt", fact."id" AS "factId", fact."pinned", fact."scopeId",
      version."id" AS "versionId", version."displayText" AS "statement",
      version."expectedAt", version."expiresAt", version."modality"::text AS "modality",
      version."observedAt", version."occurredAt", version."systemFrom",
      version."validFrom", version."validTo", settings."memoryGeneration"
    FROM "MemoryFactVersion" AS version
    JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    JOIN "UserMemorySettings" AS settings ON settings."userId" = version."userId"
    JOIN "User" AS owner ON owner."id" = version."userId"
    WHERE version."id" IN (${Prisma.join(versionIds)})
      AND owner."status" = 'active'::"UserStatus"
      AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      AND ${memoryReusableFactAuthorityPredicate(userId)}
      AND ${memoryExplicitFactReceiptAuthorityPredicate(Prisma.sql`version`)}
    ORDER BY version."id"
  `);
  const eligible = rows.filter((row) => row.statement.length <= MEMORY_STATEMENT_MAX_LENGTH &&
    safeExactText(row.statement));
  if (eligible.length === 0) return new Map();
  const evidence = await db.$queryRaw<MemoryExplicitRelationEvidence[]>(Prisma.sql`
    SELECT evidence."id", evidence."factVersionId", evidence."memoryEventId",
      evidence."createdAt", evidence."observedAt", evidence."safeExcerpt",
      evidence."safeSourceHash", evidence."safetyClass"::text AS "safetyClass",
      evidence."sourceProjectionVersion"
    FROM "MemoryEvidence" AS evidence
    JOIN "MemoryEvent" AS event
      ON event."userId" = evidence."userId" AND event."id" = evidence."memoryEventId"
    WHERE evidence."userId" = ${userId}
      AND evidence."factVersionId" IN (${Prisma.join(eligible.map(({ versionId }) => versionId))})
      AND evidence."sourceType" = 'EXPLICIT_ACTION'::"MemoryEvidenceSourceType"
      AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      AND evidence."chatId" IS NULL AND evidence."messageId" IS NULL
      AND evidence."sourceRole" IS NULL AND evidence."branchGeneration" IS NULL
      AND evidence."safetyClass" IN ('NORMAL'::"MemorySensitivityClass", 'SENSITIVE'::"MemorySensitivityClass")
      AND event."operation" IN ('EXPLICIT_SAVE'::"MemoryEventOperation", 'EDIT'::"MemoryEventOperation",
        'REINFORCE'::"MemoryEventOperation", 'SCOPE_CHANGE'::"MemoryEventOperation")
    ORDER BY evidence."factVersionId", evidence."createdAt", evidence."id"
  `);
  const result = new Map<string, MemoryExplicitRelationCurrentFact>();
  for (const row of eligible) {
    const supports = evidence.filter((item) => item.factVersionId === row.versionId &&
      item.safeSourceHash === memorySha256(item.safeExcerpt) && safeExactText(item.safeExcerpt));
    if (supports.length === 0) continue;
    const fact: MemoryExplicitRelationFact = {
      createdAt: row.createdAt.toISOString(),
      evidenceHash: memorySha256(supports),
      expectedAt: row.expectedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      factId: row.factId,
      modality: row.modality,
      observedAt: row.observedAt?.toISOString() ?? null,
      occurredAt: row.occurredAt?.toISOString() ?? null,
      pinned: row.pinned,
      scopeId: row.scopeId,
      statement: row.statement,
      systemFrom: row.systemFrom.toISOString(),
      validFrom: row.validFrom?.toISOString() ?? null,
      validTo: row.validTo?.toISOString() ?? null,
      versionId: row.versionId
    };
    result.set(row.versionId, Object.freeze({
      evidence: Object.freeze(supports), fact: Object.freeze(fact), memoryGeneration: row.memoryGeneration
    }));
  }
  return result;
}

export async function loadMemoryExplicitRelationSnapshot(
  db: Reader,
  job: MemoryJobDescriptor,
  candidateVersionIds: readonly string[]
): Promise<Readonly<{
  facts: ReadonlyMap<string, MemoryExplicitRelationCurrentFact>;
  snapshot: MemoryExplicitRelationSnapshot;
}> | null> {
  if (!isMemoryExplicitRelationJob(job)) throw new Error("memory_explicit_relation_job_invalid");
  const ids = [job.targetFactVersionId!, ...candidateVersionIds];
  const facts = await loadCurrentMemoryExplicitRelationFacts(db, job.userId, ids);
  if (facts.size !== ids.length || [...facts.values()].some((value) =>
    value.memoryGeneration !== job.memoryGenerationSnapshot)) return null;
  const snapshot = {
    candidates: candidateVersionIds.map((id) => facts.get(id)!.fact),
    memoryGeneration: job.memoryGenerationSnapshot,
    source: facts.get(job.targetFactVersionId!)!.fact,
    userId: job.userId
  };
  assertMemoryExplicitRelationSnapshot(snapshot);
  return Object.freeze({ facts, snapshot });
}
