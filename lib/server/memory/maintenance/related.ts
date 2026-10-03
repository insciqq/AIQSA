import { Prisma, type PrismaClient } from "@prisma/client";
import { logEvent } from "../../observability";
import { redactMemorySecrets } from "../explicit/safety";
import { loadPersonalMemoryEvidenceSnapshots } from "../persistence/eligibility";
import { memoryReusableFactAuthorityPredicate } from "../persistence/reusableFactAuthority";
import { createPrismaMemoryVectorRepository, type MemoryVectorProfile, type MemoryVectorRepository,
  type MemoryVectorSearchInput } from "../retrieval/vector";
import { MEMORY_MAINTENANCE_POLICY_VERSION, type MemoryMaintenanceRelatedMemory, type MemoryMaintenanceSource } from "./policy";
import type { MemoryMaintenanceTestimony } from "./precedence";
import { memoryMaintenanceProtectedFactPredicate } from "./source";

type QueryClient = Pick<PrismaClient, "$queryRaw">;
type VectorSearch = Pick<MemoryVectorRepository, "resolveActiveProfile" | "search">;

/** Related memories shown per reviewed source. The nearest current memories
 * by the owner's own embeddings, without the retrieval relevance floor: a
 * contradiction on the same subject can score below it. */
export const MEMORY_MAINTENANCE_RELATED_LIMIT = 3;
/** Candidates fetched per source, so a skipped one leaves room for the next. */
const RELATED_CANDIDATES = MEMORY_MAINTENANCE_RELATED_LIMIT * 2;
/** A related memory is shown whole or not at all: a cut statement could hide
 * the very qualification that decides a contradiction. */
const RELATED_STATEMENT_CHARACTERS = 1_000;
const RELATED_BATCH_CHARACTERS = 12_000;

export type MemoryMaintenanceRelatedStatement = Readonly<{
  factId: string;
  versionId: string;
  statement: string;
  observedAt: Date | null;
}>;

/** Exact versions that are still the current, reusable memory of the owner,
 * with their provider-safe statement. Anything else, or a statement too long
 * to show whole, is absent: such a memory is never disclosed. */
export async function loadMemoryMaintenanceRelatedStatements(client: QueryClient, userId: string,
  versionIds: readonly string[]): Promise<ReadonlyMap<string, MemoryMaintenanceRelatedStatement>> {
  const ids = [...new Set(versionIds)];
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ factId: string; versionId: string; statement: string; observedAt: Date | null }>>(Prisma.sql`
    SELECT fact."id" AS "factId", version."id" AS "versionId", version."displayText" AS statement, version."observedAt"
    FROM "MemoryFactVersion" AS version
    JOIN "MemoryFact" AS fact ON fact."id" = version."factId" AND fact."userId" = version."userId"
    JOIN "MemoryScope" AS scope ON scope."id" = fact."scopeId" AND scope."userId" = fact."userId"
    JOIN "UserMemorySettings" AS settings ON settings."userId" = fact."userId"
    WHERE version."userId" = ${userId} AND version."id" IN (${Prisma.join(ids)})
      AND ${memoryReusableFactAuthorityPredicate(userId, { lifecycle: "CURRENT" })}
  `);
  return new Map(rows.flatMap((row) => {
    const statement = redactMemorySecrets(row.statement).redactedText;
    return statement.length > 0 && statement.length <= RELATED_STATEMENT_CHARACTERS ? [[row.versionId, { ...row, statement }] as const] : [];
  }));
}

/** The stored embedding of each source version in the active generation. */
async function sourceEmbeddings(client: QueryClient, userId: string, profile: MemoryVectorProfile,
  versionIds: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
  if (versionIds.length === 0) return new Map();
  const rows = await client.$queryRaw<Array<{ factVersionId: string; embedding: string }>>(Prisma.sql`
    SELECT DISTINCT ON (entry."factVersionId") entry."factVersionId", entry."embedding"::text AS embedding
    FROM "MemorySearchEntry" AS entry
    WHERE entry."userId" = ${userId} AND entry."indexGenerationId" = ${profile.generationId}
      AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
      AND entry."embeddingState" = 'READY'::"MemoryEmbeddingState" AND entry."embedding" IS NOT NULL
      AND entry."embeddingDimension" = ${profile.dimension} AND entry."factVersionId" IN (${Prisma.join([...versionIds])})
    ORDER BY entry."factVersionId", entry."id"
  `);
  return new Map(rows.flatMap(({ factVersionId, embedding }) => {
    const vector = JSON.parse(embedding) as unknown;
    return Array.isArray(vector) && vector.length === profile.dimension &&
      vector.every((value) => typeof value === "number" && Number.isFinite(value)) ? [[factVersionId, vector as number[]] as const] : [];
  }));
}

function searchInput(userId: string, profile: MemoryVectorProfile, vector: readonly number[]): MemoryVectorSearchInput {
  return {
    eligibility: { allowedFactSensitivity: ["NORMAL", "SENSITIVE"], allowedHistorySafety: ["NORMAL", "SENSITIVE"],
      assistantId: null, chatId: null, factMode: "CURRENT", factTemporalAsOf: null, folderId: null, occurredFrom: null,
      occurredTo: null, sourceAssistantId: null, sourceChatIds: null, sourceFolderId: null },
    itemTypes: ["FACT_VERSION"], limit: RELATED_CANDIDATES + 1, minimumScore: 0, profile, userId, vector
  };
}

/** Read-only context of a review: for each source with a stored embedding,
 * the nearest other current memories of the same owner and scope, explicit
 * and pinned ones included, through the ordinary vector search and its
 * authority rejoin. Statements are redacted and bounded per memory and per
 * batch. Embeddings that are not configured, not ready or failing leave the
 * review without this context; they never block or fail it. */
export async function loadMemoryMaintenanceRelatedMemories(client: QueryClient, userId: string,
  sources: readonly Pick<MemoryMaintenanceSource, "ref" | "factId" | "versionId">[],
  options: Readonly<{ jobId: string; signal?: AbortSignal; vectors?: VectorSearch }>
): Promise<ReadonlyMap<string, readonly MemoryMaintenanceRelatedMemory[]>> {
  try {
    const vectors = options.vectors ?? createPrismaMemoryVectorRepository(client as PrismaClient);
    const resolution = await vectors.resolveActiveProfile(userId, { signal: options.signal });
    if (resolution.status !== "READY" || sources.length === 0) return new Map();
    const embeddings = await sourceEmbeddings(client, userId, resolution.profile, sources.map(({ versionId }) => versionId));
    const ranked = new Map<string, readonly string[]>();
    for (const source of sources) {
      const vector = embeddings.get(source.versionId);
      if (!vector) continue;
      const result = await vectors.search(searchInput(userId, resolution.profile, vector), { admission: "LANE", signal: options.signal });
      // A profile changed during the pass gives no further context.
      if (result.status !== "READY") break;
      ranked.set(source.ref, result.hits.map(({ itemId }) => itemId).filter((versionId) => versionId !== source.versionId));
    }
    const statements = await loadMemoryMaintenanceRelatedStatements(client, userId, [...ranked.values()].flat());
    const related = new Map<string, MemoryMaintenanceRelatedMemory[]>();
    let characters = 0;
    for (const source of sources) {
      const shown: MemoryMaintenanceRelatedMemory[] = [];
      for (const versionId of ranked.get(source.ref) ?? []) {
        const memory = statements.get(versionId);
        if (shown.length === MEMORY_MAINTENANCE_RELATED_LIMIT) break;
        if (!memory || memory.factId === source.factId || characters + memory.statement.length > RELATED_BATCH_CHARACTERS) continue;
        characters += memory.statement.length;
        shown.push({ ref: `${source.ref}M${shown.length + 1}`, ...memory });
      }
      if (shown.length) related.set(source.ref, shown);
    }
    return related;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logEvent("service_operation", { subsystem: "memory", stage: "prepare", outcome: "degraded",
      code: "memory_maintenance_related_context_unavailable", job_id: options.jobId });
    return new Map();
  }
}

/** `lasting`: the latest settled current-policy decision on this version kept
 * it as DURABLE or ONGOING. */
export type MemoryMaintenanceContradictionTarget = Readonly<{ factId: string; versionId: string; protected: boolean; lasting: boolean }>;
/** What settlement's precedence rule reads, inside its locked transaction:
 * which contradicting memories are still current and authorized, whether each
 * is protected or confirmed lasting, and the exact current testimony of every
 * version involved. */
export async function loadMemoryMaintenanceContradictionStates(client: QueryClient, userId: string,
  input: Readonly<{ sourceVersionIds: readonly string[]; targetVersionIds: readonly string[] }>): Promise<Readonly<{
    targets: ReadonlyMap<string, MemoryMaintenanceContradictionTarget>;
    testimony: ReadonlyMap<string, readonly MemoryMaintenanceTestimony[]>;
  }>> {
  const targetIds = [...new Set(input.targetVersionIds)];
  const rows = targetIds.length === 0 ? [] : await client.$queryRaw<Array<MemoryMaintenanceContradictionTarget>>(Prisma.sql`
    SELECT fact."id" AS "factId", version."id" AS "versionId", ${memoryMaintenanceProtectedFactPredicate()} AS "protected",
      COALESCE((SELECT decided."disposition" = 'KEEP' AND decided."usefulness" IN ('DURABLE', 'ONGOING')
        FROM "MemoryMaintenanceReview" AS decided
        WHERE decided."userId" = version."userId" AND decided."factVersionId" = version."id"
          AND decided."policyVersion" = ${MEMORY_MAINTENANCE_POLICY_VERSION} AND decided."disposition" IN ('KEEP', 'REJECTED')
        ORDER BY decided."reviewedAt" DESC, decided."id" DESC LIMIT 1), FALSE) AS "lasting"
    FROM "MemoryFactVersion" AS version
    JOIN "MemoryFact" AS fact ON fact."id" = version."factId" AND fact."userId" = version."userId"
    JOIN "MemoryScope" AS scope ON scope."id" = fact."scopeId" AND scope."userId" = fact."userId"
    JOIN "UserMemorySettings" AS settings ON settings."userId" = fact."userId"
    WHERE version."userId" = ${userId} AND version."id" IN (${Prisma.join(targetIds)})
      AND ${memoryReusableFactAuthorityPredicate(userId, { lifecycle: "CURRENT" })}
  `);
  const targets = new Map(rows.map((row) => [row.versionId, row]));
  const evidence = await loadPersonalMemoryEvidenceSnapshots(client, userId,
    [...input.sourceVersionIds, ...rows.filter((row) => !row.protected).map(({ versionId }) => versionId)], { exactVNext: true });
  const testimony = new Map<string, MemoryMaintenanceTestimony[]>();
  for (const { factVersionId, messageId, observedAt } of evidence) {
    testimony.set(factVersionId, [...testimony.get(factVersionId) ?? [], { messageId, observedAt }]);
  }
  return { targets, testimony };
}
