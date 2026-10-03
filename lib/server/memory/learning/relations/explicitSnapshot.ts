import { Prisma, type PrismaClient } from "@prisma/client";
import { MEMORY_STATEMENT_MAX_LENGTH } from "../../../../contracts/memory";
import type { MemoryJobDescriptor } from "../../coordinator/types";
import { isValidMemoryExecutionIdentifier } from "../../execution/owner";
import { projectMemoryHistorySafeText } from "../../history/safety";
import { loadPersonalMemoryEvidenceSnapshots } from "../../persistence/eligibility";
import { memoryAutomaticEquivalenceUnprotectedPredicate } from "../../persistence/explicitEquivalence";
import { memorySha256 } from "../../persistence/lexical";
import {
  memoryExplicitFactReceiptAuthorityPredicate,
  memoryReusableFactAuthorityPredicate
} from "../../persistence/reusableFactAuthority";
import {
  assertMemoryExplicitRelationSnapshot,
  isMemoryExplicitRelationJob,
  MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES,
  MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION,
  type MemoryExplicitRelationFact,
  type MemoryExplicitRelationPipelineVersion,
  type MemoryExplicitRelationSnapshot
} from "./explicitPolicy";

type Reader = Pick<PrismaClient, "$queryRaw">;

type FactRow = Readonly<{
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
  /** Owner receipts of an explicit save; an automatic fact has none here. */
  evidence: readonly MemoryExplicitRelationEvidence[];
  fact: MemoryExplicitRelationFact;
  /** Newest exact support: an owner receipt or a current direct-user message. */
  latestSupportAt: Date;
  memoryGeneration: number;
}>;

function safeExactText(value: string): boolean {
  const safe = projectMemoryHistorySafeText(value);
  return safe.eligible && safe.safeText === value;
}

function relationFact(
  row: FactRow,
  sourceMode: MemoryExplicitRelationFact["sourceMode"],
  evidenceHash: string
): MemoryExplicitRelationFact {
  return Object.freeze({
    createdAt: row.createdAt.toISOString(),
    evidenceHash,
    expectedAt: row.expectedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    factId: row.factId,
    modality: row.modality,
    observedAt: row.observedAt?.toISOString() ?? null,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    pinned: row.pinned,
    scopeId: row.scopeId,
    sourceMode,
    statement: row.statement,
    systemFrom: row.systemFrom.toISOString(),
    validFrom: row.validFrom?.toISOString() ?? null,
    validTo: row.validTo?.toISOString() ?? null,
    versionId: row.versionId
  });
}

function latest(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

const factColumns = Prisma.sql`
  fact."createdAt", fact."id" AS "factId", fact."pinned", fact."scopeId",
  version."id" AS "versionId", version."displayText" AS "statement",
  version."expectedAt", version."expiresAt", version."modality"::text AS "modality",
  version."observedAt", version."occurredAt", version."systemFrom",
  version."validFrom", version."validTo", settings."memoryGeneration"
`;

const factJoins = Prisma.sql`
  FROM "MemoryFactVersion" AS version
  JOIN "MemoryFact" AS fact
    ON fact."userId" = version."userId" AND fact."id" = version."factId"
  JOIN "MemoryScope" AS scope
    ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
  JOIN "UserMemorySettings" AS settings ON settings."userId" = version."userId"
  JOIN "User" AS owner ON owner."id" = version."userId"
`;

async function loadExplicitFacts(
  db: Reader,
  userId: string,
  versionIds: readonly string[]
): Promise<Map<string, MemoryExplicitRelationCurrentFact>> {
  const rows = await db.$queryRaw<FactRow[]>(Prisma.sql`
    SELECT ${factColumns}
    ${factJoins}
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
    result.set(row.versionId, Object.freeze({
      evidence: Object.freeze(supports),
      fact: relationFact(row, "EXPLICIT", memorySha256(supports)),
      latestSupportAt: latest(supports.map(({ observedAt }) => observedAt)),
      memoryGeneration: row.memoryGeneration
    }));
  }
  return result;
}

/** A current automatic fact joins only while its lineage is untouched by the
 * owner and its exact direct-user message support is current. The evidence
 * hash binds the comparison to those exact sources; they are never copied. */
async function loadAutomaticFacts(
  db: Reader,
  userId: string,
  versionIds: readonly string[]
): Promise<Map<string, MemoryExplicitRelationCurrentFact>> {
  const rows = await db.$queryRaw<FactRow[]>(Prisma.sql`
    SELECT ${factColumns}
    ${factJoins}
    WHERE version."id" IN (${Prisma.join(versionIds)})
      AND owner."status" = 'active'::"UserStatus"
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND ${memoryReusableFactAuthorityPredicate(userId)}
      AND ${memoryAutomaticEquivalenceUnprotectedPredicate()}
    ORDER BY version."id"
  `);
  const eligible = rows.filter((row) => !row.pinned &&
    row.statement.length <= MEMORY_STATEMENT_MAX_LENGTH && safeExactText(row.statement));
  if (eligible.length === 0) return new Map();
  const supports = await loadPersonalMemoryEvidenceSnapshots(
    db, userId, eligible.map(({ versionId }) => versionId), { exactVNext: true }
  );
  const result = new Map<string, MemoryExplicitRelationCurrentFact>();
  for (const row of eligible) {
    const exact = supports.filter(({ factVersionId }) => factVersionId === row.versionId);
    if (exact.length === 0) continue;
    result.set(row.versionId, Object.freeze({
      evidence: Object.freeze([]),
      fact: relationFact(row, "AUTOMATIC", memorySha256(exact)),
      latestSupportAt: latest(exact.map(({ observedAt }) => observedAt)),
      memoryGeneration: row.memoryGeneration
    }));
  }
  return result;
}

/** Rejoins exact current global explicit versions, owner receipts and safe
 * independent support; v2 also rejoins unprotected automatic versions with
 * exact current message support. Retrieval candidates alone never reach the
 * provider. */
export async function loadCurrentMemoryExplicitRelationFacts(
  db: Reader,
  userId: string,
  versionIds: readonly string[],
  pipelineVersion: MemoryExplicitRelationPipelineVersion
): Promise<ReadonlyMap<string, MemoryExplicitRelationCurrentFact>> {
  if (!isValidMemoryExecutionIdentifier(userId) ||
    versionIds.length > MEMORY_EXPLICIT_RELATION_MAX_CANDIDATES + 1 ||
    versionIds.some((id) => !isValidMemoryExecutionIdentifier(id)) ||
    new Set(versionIds).size !== versionIds.length) {
    throw new Error("memory_explicit_relation_snapshot_invalid");
  }
  if (versionIds.length === 0) return new Map();
  const explicit = await loadExplicitFacts(db, userId, versionIds);
  if (pipelineVersion === MEMORY_EXPLICIT_RELATION_V1_PIPELINE_VERSION) return explicit;
  const remaining = versionIds.filter((id) => !explicit.has(id));
  if (remaining.length === 0) return explicit;
  const automatic = await loadAutomaticFacts(db, userId, remaining);
  return new Map([...explicit, ...automatic]);
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
  const pipelineVersion = job.pipelineVersion as MemoryExplicitRelationPipelineVersion;
  const ids = [job.targetFactVersionId!, ...candidateVersionIds];
  const facts = await loadCurrentMemoryExplicitRelationFacts(db, job.userId, ids, pipelineVersion);
  if (facts.size !== ids.length || [...facts.values()].some((value) =>
    value.memoryGeneration !== job.memoryGenerationSnapshot)) return null;
  const snapshot: MemoryExplicitRelationSnapshot = {
    candidates: candidateVersionIds.map((id) => facts.get(id)!.fact),
    memoryGeneration: job.memoryGenerationSnapshot,
    pipelineVersion,
    source: facts.get(job.targetFactVersionId!)!.fact,
    userId: job.userId
  };
  try {
    assertMemoryExplicitRelationSnapshot(snapshot);
  } catch {
    // Participants that no longer form a valid comparison (for example two
    // automatic facts) make a stale snapshot, never a merge.
    return null;
  }
  return Object.freeze({ facts, snapshot });
}
