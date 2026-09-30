import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  MemoryDetailResponse,
  MemoryEvidenceItem,
  MemoryEvidenceResponse,
  MemoryListInput,
  MemoryListResponse,
  MemoryListSearchInput,
  MemoryScopeSelection,
  MemorySummary
} from "../../../contracts/memory";
import { prisma } from "../../prisma";
import {
  memoryPersonalEvidenceCount,
  memoryPersonalFactEvidencePredicate
} from "../persistence/eligibility";
import { memoryPersistenceFailure } from "../persistence/errors";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { memoryCanonicalGlobalScopePredicate } from "../persistence/scopes";
import { memoryPurgeTargetType } from "../purge/contract";
import {
  memorySynthesisPatternAuthorityPredicate,
  memorySynthesisSourceAuthorityPredicate
} from "../synthesis/eligibility";
import {
  MEMORY_SYNTHESIS_COMBINED_REASONS,
  memorySynthesisIsCombination
} from "../synthesis/policy";

const DEFAULT_PAGE_SIZE = 20;
const SEARCH_OFFSET_MAX = 10_000;

type SummaryRow = Readonly<{
  actionVersionId: string | null;
  category: string;
  createdAt: Date;
  currentVersionId: string | null;
  deferredCandidateCount: number;
  displayText: string | null;
  embeddingState: "FAILED" | "NOT_APPLICABLE" | "PENDING" | "READY" | null;
  factState: "ACTIVE" | "CONFLICTED" | "EXPIRED" | "FORGOTTEN" | "ORPHANED" | "RETRACTED";
  id: string;
  indexMode: "HYBRID" | "LEXICAL_ONLY" | null;
  lastConfirmedAt: Date | null;
  lastUsedAt: Date | null;
  modality: MemorySummary["modality"] | null;
  pinned: boolean;
  reasonCode: string | null;
  searchEntryId: string | null;
  sensitivityClass: MemorySummary["sensitivityClass"] | null;
  sourceCount: number;
  sourceMode: MemorySummary["sourceMode"] | null;
  scopeTargetIdSnapshot: string | null;
  scopeType: MemoryScopeSelection["type"];
  updatedAt: Date;
  validFrom: Date | null;
  validTo: Date | null;
  versionState: MemorySummary["versionState"] | null;
}>;

type CombinedSourceRow = Readonly<{
  category: string;
  createdAt: Date;
  factId: string;
  patternVersionId: string;
  sourceMode: MemorySummary["sourceMode"];
  statement: string;
  updatedAt: Date;
  versionId: string;
}>;

type EvidenceRow = Readonly<{
  factVersionId: string;
  id: string;
  observedAt: Date;
  safeExcerpt: string;
  safetyClass: MemoryEvidenceItem["safetyClass"];
  sourceChatId: string | null;
  sourceMessageId: string | null;
  sourceRole: string | null;
  sourceType: MemoryEvidenceItem["sourceType"];
  stance: MemoryEvidenceItem["stance"];
}>;

export type ExplicitMemoryEditable = Readonly<{
  canonicalKey: string;
  category: string;
  currentVersionId: string;
  displayText: string;
  factState: "ACTIVE" | "ORPHANED" | "RETRACTED";
  factId: string;
  languageCode: string;
  modality: MemorySummary["modality"];
  pinned: boolean;
  scopeId: string;
  scope: MemoryScopeSelection;
  sensitivityClass: MemorySummary["sensitivityClass"];
  validFrom: Date | null;
  validTo: Date | null;
}>;

export type ExplicitMemoryConflictEditable = Readonly<{
  canonicalKey: string;
  category: string;
  factId: string;
  pinned: boolean;
  scope: MemoryScopeSelection;
  scopeId: string;
  versions: readonly Readonly<{
    displayText: string;
    id: string;
    modality: MemorySummary["modality"];
    sensitivityClass: MemorySummary["sensitivityClass"];
    validFrom: Date | null;
    validTo: Date | null;
  }>[];
}>;

export type ExplicitMemoryForgetUndoCandidate = Readonly<{
  canonicalKey: string;
  category: string;
  displayText: string;
  expiresAt: Date;
  modality: MemorySummary["modality"];
  scopeId: string;
  sensitivityClass: MemorySummary["sensitivityClass"];
  validFrom: Date | null;
  validTo: Date | null;
  versionId: string;
}>;

type ListCursor = Readonly<{
  filterHash: string;
  id: string;
  kind: "list";
  updatedAt: string;
}>;

type SearchCursor = Readonly<{
  filterHash: string;
  kind: "search";
  offset: number;
}>;

type EvidenceCursor = Readonly<{
  factHash: string;
  id: string;
  kind: "evidence";
  observedAt: string;
}>;

function encodeCursor(value: ListCursor | SearchCursor | EvidenceCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function cursorObject(value: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      return memoryPersistenceFailure("memory_input_invalid");
    }
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return memoryPersistenceFailure("memory_input_invalid");
    }
    return parsed as Record<string, unknown>;
  } catch {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

function exactCursorKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function validCursorId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value.trim() === value && !/[\u0000-\u0020\u007f]/u.test(value);
}

function validCursorTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function decodeListCursor(value: string, filterHash: string): ListCursor {
  const parsed = cursorObject(value);
  if (
    !exactCursorKeys(parsed, ["filterHash", "id", "kind", "updatedAt"]) ||
    parsed.kind !== "list" ||
    parsed.filterHash !== filterHash ||
    !validCursorId(parsed.id) ||
    !validCursorTimestamp(parsed.updatedAt)
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  return parsed as ListCursor;
}

function decodeSearchCursor(value: string, filterHash: string): SearchCursor {
  const parsed = cursorObject(value);
  if (
    !exactCursorKeys(parsed, ["filterHash", "kind", "offset"]) ||
    parsed.kind !== "search" ||
    parsed.filterHash !== filterHash ||
    typeof parsed.offset !== "number" ||
    !Number.isSafeInteger(parsed.offset) ||
    parsed.offset < 0 ||
    parsed.offset > SEARCH_OFFSET_MAX
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  return parsed as SearchCursor;
}

function decodeEvidenceCursor(value: string, factHash: string): EvidenceCursor {
  const parsed = cursorObject(value);
  if (
    !exactCursorKeys(parsed, ["factHash", "id", "kind", "observedAt"]) ||
    parsed.kind !== "evidence" ||
    parsed.factHash !== factHash ||
    !validCursorId(parsed.id) ||
    !validCursorTimestamp(parsed.observedAt)
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
  return parsed as EvidenceCursor;
}

function scopeSelection(row: Pick<
  SummaryRow,
  "scopeTargetIdSnapshot" | "scopeType"
>): MemoryScopeSelection {
  if (row.scopeType === "GLOBAL_USER") return { type: "GLOBAL_USER" };
  if (!row.scopeTargetIdSnapshot) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }
  return { targetId: row.scopeTargetIdSnapshot, type: row.scopeType };
}

function scopeFilter(selection: MemoryScopeSelection): Prisma.Sql {
  if (selection.type === "GLOBAL_USER") {
    return Prisma.sql`scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"`;
  }
  return Prisma.sql`
    scope."scopeType" = ${selection.type}::"MemoryScopeType"
    AND scope."targetIdSnapshot" = ${selection.targetId}
  `;
}

function indexingState(row: SummaryRow): MemorySummary["indexingState"] {
  if (!row.searchEntryId || !row.indexMode) return "DEGRADED";
  if (row.indexMode === "LEXICAL_ONLY") return "LEXICAL_READY";
  if (row.embeddingState === "READY") return "HYBRID_READY";
  if (row.embeddingState === "PENDING") return "VECTOR_PENDING";
  return "DEGRADED";
}

function summaryFromRow(row: SummaryRow): MemorySummary {
  if (!row.modality || !row.sensitivityClass || !row.sourceMode || !row.versionState) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }
  const active = row.factState === "ACTIVE";
  const reviewable = active || row.factState === "ORPHANED" ||
    row.factState === "CONFLICTED";
  if (
    (active && (!row.currentVersionId || !row.displayText || !row.actionVersionId)) ||
    ((row.factState === "ORPHANED" || row.factState === "CONFLICTED") &&
      (!row.actionVersionId || !row.displayText))
  ) {
    return memoryPersistenceFailure("memory_counter_contract_invalid");
  }
  return {
    actionVersionId: reviewable ? row.actionVersionId : null,
    category: row.category,
    createdAt: row.createdAt.toISOString(),
    currentVersionId: active ? row.currentVersionId : null,
    deferredCandidateCount: row.deferredCandidateCount,
    displayText: reviewable ? row.displayText : null,
    factState: row.factState,
    id: row.id,
    indexingState: indexingState(row),
    lastConfirmedAt: row.lastConfirmedAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    modality: row.modality,
    pinned: row.pinned,
    scope: scopeSelection(row),
    sensitivityClass: row.sensitivityClass,
    sourceCount: row.sourceCount,
    sourceMode: row.sourceMode,
    updatedAt: row.updatedAt.toISOString(),
    validFrom: row.validFrom?.toISOString() ?? null,
    validTo: row.validTo?.toISOString() ?? null,
    versionState: row.versionState
  };
}

async function summariesByIds(
  client: PrismaClient,
  userId: string,
  ids: readonly string[]
): Promise<ReadonlyMap<string, MemorySummary>> {
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<SummaryRow[]>(Prisma.sql`
    SELECT
      fact."id",
      fact."category",
      fact."state" AS "factState",
      fact."pinned",
      fact."currentVersionId",
      COALESCE(deferred."candidateCount", 0)::integer AS "deferredCandidateCount",
      fact."lastUsedAt",
      fact."lastConfirmedAt",
      fact."createdAt",
      fact."updatedAt",
      scope."scopeType"::text AS "scopeType",
      scope."targetIdSnapshot" AS "scopeTargetIdSnapshot",
      version."displayText",
      version."id" AS "actionVersionId",
      version."modality",
      version."sourceMode",
      version."sensitivityClass",
      version."validFrom",
      version."validTo",
      version."state"::text AS "versionState",
      version."structuredValue"->>'reasonCode' AS "reasonCode",
      CASE WHEN version."modality" = 'PATTERN'::"MemoryFactModality"
        THEN (
          SELECT COUNT(*)::integer
          FROM "MemoryFactVersionRelation" AS relation
          WHERE relation."userId" = version."userId"
            AND relation."sourceVersionId" = version."id"
            AND relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
        )
        ELSE ${memoryPersonalEvidenceCount(userId)}
      END AS "sourceCount",
      generation."indexMode",
      search."id" AS "searchEntryId",
      search."embeddingState"
    FROM "MemoryFact" AS fact
    INNER JOIN "User" AS owner
      ON owner."id" = fact."userId" AND owner."status" = 'active'
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId"
      AND scope."id" = fact."scopeId"
    LEFT JOIN LATERAL (
      SELECT candidate.*
      FROM "MemoryFactVersion" AS candidate
      WHERE candidate."userId" = fact."userId"
        AND candidate."factId" = fact."id"
        AND candidate."safetyClassificationState" =
          'CLASSIFIED'::"MemorySafetyClassificationState"
        AND (
          fact."state" <> 'ACTIVE'::"MemoryFactState"
          OR candidate."expiresAt" IS NULL
          OR candidate."expiresAt" > CURRENT_TIMESTAMP
        )
        AND (
          (fact."currentVersionId" IS NOT NULL AND candidate."id" = fact."currentVersionId")
          OR (
            fact."currentVersionId" IS NULL
            AND (
              fact."state" <> 'ORPHANED'::"MemoryFactState"
              OR (
                candidate."state" = 'ORPHANED'::"MemoryFactVersionState"
                AND candidate."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
              )
            )
          )
        )
      ORDER BY candidate."systemFrom" DESC, candidate."id" DESC
      LIMIT 1
    ) AS version ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS "candidateCount"
      FROM "MemoryCandidate" AS candidate
      WHERE candidate."userId" = fact."userId"
        AND candidate."state" = 'DEFERRED'::"MemoryCandidateState"
        AND (
          candidate."resolvedFactId" = fact."id"
          OR candidate."proposedCanonicalKey" = fact."canonicalKey"
        )
    ) AS deferred ON true
    LEFT JOIN "UserMemorySettings" AS settings
      ON settings."userId" = fact."userId"
    LEFT JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'
    LEFT JOIN "MemorySearchEntry" AS search
      ON search."userId" = fact."userId"
      AND search."indexGenerationId" = generation."id"
      AND search."factVersionId" = version."id"
    WHERE fact."userId" = ${userId}
      AND fact."id" IN (${Prisma.join(ids)})
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND version."id" IS NOT NULL
      AND (
        ${memoryPersonalFactEvidencePredicate(userId)}
        OR ${memorySynthesisPatternAuthorityPredicate(userId, { forManagement: true })}
      )
  `);
  const combinedVersions = rows.flatMap((row) => row.factState === "ACTIVE" &&
    row.modality === "PATTERN" &&
    memorySynthesisIsCombination(row.reasonCode ?? "") &&
    row.currentVersionId ? [row.currentVersionId] : []);
  const sources = combinedVersions.length ? await client.$queryRaw<CombinedSourceRow[]>(Prisma.sql`
    SELECT pattern_version."id" AS "patternVersionId",
      source_fact."category", source_fact."createdAt",
      source_version."sourceMode",
      source_fact."id" AS "factId", source_version."id" AS "versionId",
      source_version."displayText" AS "statement", source_fact."updatedAt"
    FROM "MemoryFactVersion" AS pattern_version
    INNER JOIN "MemoryFactVersionRelation" AS relation
      ON relation."userId" = pattern_version."userId"
     AND relation."sourceVersionId" = pattern_version."id"
     AND relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
    INNER JOIN "MemoryFactVersion" AS source_version
      ON source_version."userId" = relation."userId"
     AND source_version."id" = relation."targetVersionId"
    INNER JOIN "MemoryFact" AS source_fact
      ON source_fact."userId" = source_version."userId"
     AND source_fact."id" = source_version."factId"
    INNER JOIN "MemoryScope" AS source_scope
      ON source_scope."userId" = source_fact."userId"
     AND source_scope."id" = source_fact."scopeId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = source_version."userId"
    WHERE pattern_version."userId" = ${userId}
      AND pattern_version."id" IN (${Prisma.join(combinedVersions)})
      AND ${memorySynthesisSourceAuthorityPredicate(userId, { forManagement: true })}
    ORDER BY pattern_version."id", source_version."observedAt" DESC,
      source_version."id"
  `) : [];
  const sourcesByVersion = new Map<string, CombinedSourceRow[]>();
  for (const source of sources) {
    const group = sourcesByVersion.get(source.patternVersionId) ?? [];
    group.push(source);
    sourcesByVersion.set(source.patternVersionId, group);
  }
  return new Map(rows.flatMap((row) => {
    const combined = memorySynthesisIsCombination(row.reasonCode ?? "") &&
      row.modality === "PATTERN" && row.currentVersionId
      ? sourcesByVersion.get(row.currentVersionId) ?? [] : null;
    if (combined && (combined.length < 2 || combined.length !== row.sourceCount)) return [];
    return [[row.id, {
      ...summaryFromRow(row),
      ...(combined ? { combinedSources: combined.map((source) => ({
        category: source.category,
        createdAt: source.createdAt.toISOString(),
        factId: source.factId,
        sourceMode: source.sourceMode,
        statement: source.statement,
        updatedAt: source.updatedAt.toISOString(),
        versionId: source.versionId
      })) } : {})
    } satisfies MemorySummary] as const];
  }));
}

function orderedSummaries(
  ids: readonly string[],
  byId: ReadonlyMap<string, MemorySummary>
): MemorySummary[] {
  return ids.flatMap((id) => {
    const summary = byId.get(id);
    return summary ? [summary] : [];
  });
}

function uncollapsedSourcePredicate(
  userId: string,
  parentSearchQuery: string | null = null
): Prisma.Sql {
  return Prisma.sql`(
    NOT (
      version."modality" = 'PATTERN'::"MemoryFactModality"
      AND version."structuredValue"->>'reasonCode' IN
        (${Prisma.join(MEMORY_SYNTHESIS_COMBINED_REASONS)})
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryFactVersionRelation" AS parent_relation
        INNER JOIN "MemoryFactVersion" AS source_version
          ON source_version."userId" = parent_relation."userId"
          AND source_version."id" = parent_relation."targetVersionId"
        INNER JOIN "MemoryFact" AS source_fact
          ON source_fact."userId" = source_version."userId"
          AND source_fact."id" = source_version."factId"
        WHERE parent_relation."userId" = ${userId}
          AND parent_relation."sourceVersionId" = version."id"
          AND parent_relation."kind" = 'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
          AND source_version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
          AND source_fact."pinned" = FALSE
          AND NOT EXISTS (
            SELECT 1 FROM "MemoryEvent" AS protected_event
            WHERE protected_event."userId" = source_fact."userId"
              AND protected_event."factId" = source_fact."id"
              AND protected_event."actorType" = 'USER'::"MemoryActorType"
          )
      )
    )
    AND (
    version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
    OR fact."pinned" = TRUE
    OR EXISTS (
      SELECT 1 FROM "MemoryEvent" AS owner_event
      WHERE owner_event."userId" = fact."userId"
        AND owner_event."factId" = fact."id"
        AND owner_event."actorType" = 'USER'::"MemoryActorType"
    )
    OR NOT EXISTS (
    SELECT 1
    FROM "MemoryFactVersionRelation" AS combined_relation
    INNER JOIN "MemoryFactVersion" AS pattern_version
      ON pattern_version."userId" = combined_relation."userId"
     AND pattern_version."id" = combined_relation."sourceVersionId"
     AND pattern_version."structuredValue"->>'reasonCode' IN
       (${Prisma.join(MEMORY_SYNTHESIS_COMBINED_REASONS)})
    INNER JOIN "MemoryFact" AS pattern_fact
      ON pattern_fact."userId" = pattern_version."userId"
     AND pattern_fact."id" = pattern_version."factId"
    INNER JOIN "MemoryScope" AS pattern_scope
      ON pattern_scope."userId" = pattern_fact."userId"
     AND pattern_scope."id" = pattern_fact."scopeId"
    WHERE combined_relation."userId" = ${userId}
      AND combined_relation."targetVersionId" = version."id"
      AND combined_relation."kind" =
        'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
      AND ${memorySynthesisPatternAuthorityPredicate(userId, {
        forManagement: true,
        fact: Prisma.sql`pattern_fact`,
        scope: Prisma.sql`pattern_scope`,
        version: Prisma.sql`pattern_version`
      })}
      ${parentSearchQuery === null ? Prisma.empty : Prisma.sql`
        AND EXISTS (
          SELECT 1
          FROM "MemoryIndexGeneration" AS pattern_generation
          INNER JOIN "MemorySearchEntry" AS pattern_search
            ON pattern_search."userId" = pattern_generation."userId"
           AND pattern_search."indexGenerationId" = pattern_generation."id"
           AND pattern_search."factVersionId" = pattern_version."id"
          WHERE pattern_generation."userId" = ${userId}
            AND pattern_generation."id" = settings."activeIndexGenerationId"
            AND pattern_generation."state" = 'ACTIVE'
            AND (
              pattern_search."normalizedSearchText" = ${parentSearchQuery}
              OR strpos(pattern_search."normalizedSearchText", ${parentSearchQuery}) > 0
              OR pattern_search."searchVectorSimple" @@
                plainto_tsquery('simple', ${parentSearchQuery})
            )
        )
      `}
    )
    )
  )`;
}

export function createPrismaExplicitMemoryRepository(client: PrismaClient = prisma) {
  return Object.freeze({
    async evidence(
      userId: string,
      factId: string,
      cursor: string | null
    ): Promise<MemoryEvidenceResponse | null> {
      const visible = await summariesByIds(client, userId, [factId]);
      const memory = visible.get(factId);
      if (!memory) return null;
      if (memory.factState === "FORGOTTEN") {
        return { evidence: [], nextCursor: null };
      }
      const factHash = memorySha256({ factId, userId });
      const decodedCursor = cursor ? decodeEvidenceCursor(cursor, factHash) : null;
      const conditions = [
        Prisma.sql`fact."userId" = ${userId}`,
        Prisma.sql`fact."id" = ${factId}`
      ];
      if (decodedCursor) {
        const observedAt = new Date(decodedCursor.observedAt);
        conditions.push(Prisma.sql`(
          evidence."observedAt" < ${observedAt}
          OR (evidence."observedAt" = ${observedAt} AND evidence."id" < ${decodedCursor.id})
        )`);
      }
      const rows = await client.$queryRaw<EvidenceRow[]>(Prisma.sql`
        SELECT
          evidence."id",
          evidence."factVersionId",
          evidence."stance",
          evidence."sourceType",
          evidence."chatId" AS "sourceChatId",
          evidence."messageId" AS "sourceMessageId",
          evidence."sourceRole",
          evidence."safeExcerpt",
          evidence."safetyClass",
          evidence."observedAt"
        FROM "MemoryFact" AS fact
        INNER JOIN "User" AS owner
          ON owner."id" = fact."userId" AND owner."status" = 'active'
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = fact."userId" AND version."factId" = fact."id"
        INNER JOIN "MemoryEvidence" AS evidence
          ON evidence."userId" = version."userId"
          AND evidence."factVersionId" = version."id"
        LEFT JOIN "Chat" AS source_chat
          ON source_chat."userId" = evidence."userId"
          AND source_chat."id" = evidence."chatId"
        WHERE ${Prisma.join(conditions, " AND ")}
          AND (evidence."chatId" IS NULL OR source_chat."permanentDeletionAt" IS NULL)
        ORDER BY evidence."observedAt" DESC, evidence."id" DESC
        LIMIT ${DEFAULT_PAGE_SIZE + 1}
      `);
      const page = rows.slice(0, DEFAULT_PAGE_SIZE);
      const last = page.at(-1);
      return {
        evidence: page.map((row) => ({
          factVersionId: row.factVersionId,
          id: row.id,
          observedAt: row.observedAt.toISOString(),
          safeExcerpt: row.safeExcerpt,
          safetyClass: row.safetyClass,
          sourceChatId: row.sourceChatId,
          sourceMessageId: row.sourceMessageId,
          sourceRole: row.sourceRole,
          sourceType: row.sourceType,
          stance: row.stance
        })),
        nextCursor: rows.length > DEFAULT_PAGE_SIZE && last
          ? encodeCursor({
              factHash,
              id: last.id,
              kind: "evidence",
              observedAt: last.observedAt.toISOString()
            })
          : null
      };
    },

    async get(userId: string, factId: string): Promise<MemorySummary | null> {
      const summaries = await summariesByIds(client, userId, [factId]);
      return summaries.get(factId) ?? null;
    },

    async getForgetUndoCandidate(
      userId: string,
      factId: string,
      deletionId: string,
      now: Date
    ): Promise<ExplicitMemoryForgetUndoCandidate | null> {
      if (!Number.isFinite(now.getTime())) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      const rows = await client.$queryRaw<ExplicitMemoryForgetUndoCandidate[]>(Prisma.sql`
        SELECT
          fact."canonicalKey",
          fact."category",
          version."displayText",
          deletion."nextAttemptAt" AS "expiresAt",
          version."modality"::text AS "modality",
          fact."scopeId",
          version."sensitivityClass"::text AS "sensitivityClass",
          version."validFrom",
          version."validTo",
          version."id" AS "versionId"
        FROM "MemoryDeletionOutbox" AS deletion
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = deletion."userId"
          AND fact."id" = deletion."targetId"
          AND fact."state" = 'FORGOTTEN'::"MemoryFactState"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId"
          AND scope."id" = fact."scopeId"
          AND scope."state" = 'ACTIVE'::"MemoryScopeState"
        INNER JOIN "MemoryEvent" AS event
          ON event."userId" = fact."userId"
          AND event."factId" = fact."id"
          AND event."operation" = 'FORGET'::"MemoryEventOperation"
          AND event."metadata" ->> 'deletionId' = deletion."id"
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = event."userId"
          AND version."factId" = event."factId"
          AND version."id" = event."factVersionId"
          AND version."state" = 'FORGOTTEN'::"MemoryFactVersionState"
          AND version."contentPurgedAt" IS NULL
          AND version."displayText" IS NOT NULL
        WHERE deletion."id" = ${deletionId}
          AND deletion."userId" = ${userId}
          AND deletion."operation" = 'FORGET_PURGE'::"MemoryDeletionOperation"
          AND deletion."targetType" = ${memoryPurgeTargetType("MEMORY_FACT")}
          AND deletion."targetId" = ${factId}
          AND deletion."state" = 'PENDING'::"MemoryDeletionState"
          AND deletion."nextAttemptAt" > ${now}
        ORDER BY event."createdAt" DESC, event."id" DESC
        LIMIT 1
      `);
      return rows[0] ?? null;
    },

    async detail(userId: string, factId: string): Promise<MemoryDetailResponse | null> {
      const summaries = await summariesByIds(client, userId, [factId]);
      const memory = summaries.get(factId);
      if (!memory) return null;
      const [versions, events] = await Promise.all([
        client.memoryFactVersion.findMany({
          orderBy: [{ systemFrom: "desc" }, { id: "desc" }],
          select: {
            category: true,
            createdAt: true,
            displayText: true,
            id: true,
            modality: true,
            sensitivityClass: true,
            sourceMode: true,
            state: true,
            systemFrom: true,
            systemTo: true,
            validFrom: true,
            validTo: true
          },
          take: 50,
          where: {
            factId,
            safetyClassificationState: "CLASSIFIED",
            userId
          }
        }),
        client.memoryEvent.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            actorType: true,
            createdAt: true,
            factVersionId: true,
            id: true,
            operation: true,
            sourceChatId: true,
            sourceDeletedAt: true,
            sourceGeneration: true
          },
          take: 50,
          where: { factId, userId }
        })
      ]);
      const versionIds = versions.map(({ id }) => id);
      const [sourceChats, evidenceCounts, feedbackRows] = await Promise.all([
        client.chat.findMany({
          select: {
            id: true,
            memoryBranchGeneration: true,
            memoryMode: true
          },
          where: {
            id: { in: events.flatMap(({ sourceChatId }) => sourceChatId ? [sourceChatId] : []) },
            permanentDeletionAt: null,
            userId
          }
        }),
        versionIds.length > 0
          ? client.memoryEvidence.groupBy({
              _count: { _all: true },
              by: ["factVersionId"],
              where: { factVersionId: { in: versionIds }, userId }
            })
          : Promise.resolve([]),
        client.memoryFeedback.findMany({
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            comment: true,
            createdAt: true,
            feedbackType: true,
            id: true,
            memoryFactVersionId: true
          },
          take: 20,
          where: {
            contentPurgedAt: null,
            feedbackType: { not: "RETRACT" },
            memoryFactId: factId,
            memoryFactVersionId: { in: versionIds },
            userId
          }
        })
      ]);
      const retractions = feedbackRows.length > 0
        ? await client.memoryFeedback.findMany({
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { createdAt: true, retractsFeedbackId: true },
            where: {
              contentPurgedAt: null,
              feedbackType: "RETRACT",
              retractsFeedbackId: { in: feedbackRows.map(({ id }) => id) },
              userId
            }
          })
        : [];
      const sourceChatById = new Map(sourceChats.map((chat) => [chat.id, chat] as const));
      const sourceCountByVersion = new Map(evidenceCounts.map((entry) => [
        entry.factVersionId,
        entry._count._all
      ] as const));
      const retractedAtByFeedback = new Map(retractions.flatMap((entry) =>
        entry.retractsFeedbackId
          ? [[entry.retractsFeedbackId, entry.createdAt] as const]
          : []));
      return {
        feedback: memory.factState === "FORGOTTEN"
          ? []
          : feedbackRows.flatMap((entry) => entry.memoryFactVersionId ? [{
              comment: entry.comment,
              createdAt: entry.createdAt.toISOString(),
              feedbackType: entry.feedbackType as Exclude<typeof entry.feedbackType, "RETRACT">,
              id: entry.id,
              retractedAt: retractedAtByFeedback.get(entry.id)?.toISOString() ?? null,
              targetVersionId: entry.memoryFactVersionId
            }] : []),
        history: events.map((event) => ({
          actorType: event.actorType,
          createdAt: event.createdAt.toISOString(),
          factVersionId: event.factVersionId,
          id: event.id,
          operation: event.operation,
          sourceAvailable: event.sourceDeletedAt === null && (
            event.sourceChatId === null || (() => {
            const source = sourceChatById.get(event.sourceChatId);
            return source?.memoryMode === "NORMAL" &&
              (event.sourceGeneration === null ||
                source.memoryBranchGeneration === event.sourceGeneration);
            })()
          )
        })),
        memory,
        versions: versions.map((version) => ({
          category: version.category,
          createdAt: version.createdAt.toISOString(),
          displayText: memory.factState === "FORGOTTEN" ? null : version.displayText,
          id: version.id,
          modality: version.modality,
          sensitivityClass: version.sensitivityClass,
          sourceCount: sourceCountByVersion.get(version.id) ?? 0,
          sourceMode: version.sourceMode,
          state: version.state,
          systemFrom: version.systemFrom.toISOString(),
          systemTo: version.systemTo?.toISOString() ?? null,
          validFrom: version.validFrom?.toISOString() ?? null,
          validTo: version.validTo?.toISOString() ?? null
        }))
      };
    },

    async getEditable(
      userId: string,
      factId: string
    ): Promise<ExplicitMemoryEditable | null> {
      return client.$transaction(async (tx) => {
        const fact = await tx.memoryFact.findFirst({
          select: {
            canonicalKey: true,
            category: true,
            currentVersionId: true,
            id: true,
            movedToFactId: true,
            pinned: true,
            scopeId: true,
            state: true
          },
          where: { id: factId, userId }
        });
        if (
          !fact ||
          (fact.state !== "ACTIVE" &&
            fact.state !== "ORPHANED" &&
            !(fact.state === "RETRACTED" && fact.movedToFactId))
        ) return null;
        const scope = await tx.memoryScope.findFirst({
          select: {
            id: true,
            scopeType: true,
            state: true,
            targetIdSnapshot: true
          },
          where: {
            id: fact.scopeId,
            state: fact.state === "ACTIVE"
              ? "ACTIVE"
              : fact.state === "ORPHANED"
                ? "ORPHANED"
                : { in: ["ACTIVE", "ORPHANED"] },
            userId
          }
        });
        const version = fact.state === "ACTIVE" && fact.currentVersionId
          ? await tx.memoryFactVersion.findFirst({
              select: {
                displayText: true,
                id: true,
                languageCode: true,
                modality: true,
                sensitivityClass: true,
                sourceMode: true,
                validFrom: true,
                validTo: true
              },
              where: {
                factId,
                id: fact.currentVersionId,
                state: "ACTIVE",
                safetyClassificationState: "CLASSIFIED",
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
                userId
              }
            })
          : await tx.memoryFactVersion.findFirst({
              orderBy: [{ systemFrom: "desc" }, { id: "desc" }],
              select: {
                displayText: true,
                id: true,
                languageCode: true,
                modality: true,
                sensitivityClass: true,
                sourceMode: true,
                validFrom: true,
                validTo: true
              },
              where: {
                factId,
                sourceMode: "EXPLICIT",
                state: fact.state === "ORPHANED" ? "ORPHANED" : "RETRACTED",
                safetyClassificationState: "CLASSIFIED",
                userId
              }
            });
        if (
          !scope ||
          !version ||
          !version.displayText ||
          version.modality === "PATTERN" ||
          (fact.state !== "ACTIVE" && version.sourceMode !== "EXPLICIT")
        ) {
          return null;
        }
        const selection = scope.scopeType === "GLOBAL_USER"
          ? { type: "GLOBAL_USER" as const }
          : scope.targetIdSnapshot
            ? { targetId: scope.targetIdSnapshot, type: scope.scopeType }
            : null;
        if (!selection) return null;
        return {
          canonicalKey: fact.canonicalKey,
          category: fact.category,
          currentVersionId: version.id,
          displayText: version.displayText,
          factState: fact.state,
          factId: fact.id,
          languageCode: version.languageCode,
          modality: version.modality,
          pinned: fact.pinned,
          scopeId: fact.scopeId,
          scope: selection,
          sensitivityClass: version.sensitivityClass,
          validFrom: version.validFrom,
          validTo: version.validTo
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },

    async getConflict(
      userId: string,
      factId: string
    ): Promise<ExplicitMemoryConflictEditable | null> {
      const fact = await client.memoryFact.findFirst({
        select: {
          canonicalKey: true,
          category: true,
          currentVersionId: true,
          id: true,
          pinned: true,
          scopeId: true,
          state: true
        },
        where: { id: factId, userId }
      });
      if (!fact || fact.state !== "CONFLICTED" || fact.currentVersionId !== null) {
        return null;
      }
      const [scope, versions] = await Promise.all([
        client.memoryScope.findFirst({
          select: { scopeType: true, state: true, targetIdSnapshot: true },
          where: { id: fact.scopeId, state: "ACTIVE", userId }
        }),
        client.memoryFactVersion.findMany({
          orderBy: { id: "asc" },
          select: {
            displayText: true,
            id: true,
            modality: true,
            sensitivityClass: true,
            validFrom: true,
            validTo: true
          },
          where: {
            contentPurgedAt: null,
            factId,
            safetyClassificationState: "CLASSIFIED",
            state: "CONFLICTING",
            userId
          }
        })
      ]);
      if (!scope || versions.length < 2 || versions.some(({ displayText }) => !displayText)) {
        return null;
      }
      const selection = scope.scopeType === "GLOBAL_USER"
        ? { type: "GLOBAL_USER" as const }
        : scope.targetIdSnapshot
          ? { targetId: scope.targetIdSnapshot, type: scope.scopeType }
          : null;
      if (!selection) return null;
      return {
        canonicalKey: fact.canonicalKey,
        category: fact.category,
        factId: fact.id,
        pinned: fact.pinned,
        scope: selection,
        scopeId: fact.scopeId,
        versions: versions.map((version) => ({
          ...version,
          displayText: version.displayText!
        }))
      };
    },

    async list(userId: string, input: MemoryListInput): Promise<MemoryListResponse> {
      const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
      const filterHash = memorySha256({
        category: input.category ?? null,
        includePatterns: input.includePatterns !== false,
        scope: input.scope ?? null,
        sourceMode: input.sourceMode ?? null,
        state: input.state ?? null,
        userId
      });
      const cursor = input.cursor ? decodeListCursor(input.cursor, filterHash) : null;
      const conditions = [
        Prisma.sql`fact."userId" = ${userId}`,
        memoryCanonicalGlobalScopePredicate(),
        Prisma.sql`version."id" IS NOT NULL`,
        input.includePatterns === false
          ? memoryPersonalFactEvidencePredicate(userId)
          : Prisma.sql`(
              ${memoryPersonalFactEvidencePredicate(userId)}
              OR ${memorySynthesisPatternAuthorityPredicate(userId, { forManagement: true })}
            )`
      ];
      if (input.includePatterns === false) {
        conditions.push(Prisma.sql`version."modality" <> 'PATTERN'::"MemoryFactModality"`);
      } else if (!input.category &&
        (!input.sourceMode || input.sourceMode === "AUTOMATIC") &&
        (input.state ?? "ACTIVE") === "ACTIVE") {
        conditions.push(uncollapsedSourcePredicate(userId));
      }
      if (input.scope) conditions.push(scopeFilter(input.scope));
      if (input.category) {
        conditions.push(Prisma.sql`fact."category" = ${input.category}`);
      }
      if (input.state) conditions.push(Prisma.sql`fact."state" = ${input.state}::"MemoryFactState"`);
      if (input.sourceMode) {
        conditions.push(
          Prisma.sql`version."sourceMode" = ${input.sourceMode}::"MemoryFactSourceMode"`
        );
      }
      if (cursor) {
        const updatedAt = new Date(cursor.updatedAt);
        conditions.push(Prisma.sql`(
          fact."updatedAt" < ${updatedAt}
          OR (fact."updatedAt" = ${updatedAt} AND fact."id" < ${cursor.id})
        )`);
      }
      const rows = await client.$queryRaw<Array<{ id: string; updatedAt: Date }>>(Prisma.sql`
        SELECT fact."id", fact."updatedAt"
        FROM "MemoryFact" AS fact
        INNER JOIN "User" AS owner
          ON owner."id" = fact."userId" AND owner."status" = 'active'
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        LEFT JOIN LATERAL (
          SELECT candidate.*
          FROM "MemoryFactVersion" AS candidate
          WHERE candidate."userId" = fact."userId"
            AND candidate."factId" = fact."id"
            AND candidate."safetyClassificationState" =
              'CLASSIFIED'::"MemorySafetyClassificationState"
            AND (
              fact."state" <> 'ACTIVE'::"MemoryFactState"
              OR candidate."expiresAt" IS NULL
              OR candidate."expiresAt" > CURRENT_TIMESTAMP
            )
            AND (fact."currentVersionId" IS NULL OR candidate."id" = fact."currentVersionId")
          ORDER BY candidate."systemFrom" DESC, candidate."id" DESC
          LIMIT 1
        ) AS version ON true
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = fact."userId"
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY fact."updatedAt" DESC, fact."id" DESC
        LIMIT ${pageSize + 1}
      `);
      const page = rows.slice(0, pageSize);
      const summaries = await summariesByIds(client, userId, page.map((row) => row.id));
      const last = page.at(-1);
      return {
        memories: orderedSummaries(page.map((row) => row.id), summaries),
        nextCursor: rows.length > pageSize && last
          ? encodeCursor({
              filterHash,
              id: last.id,
              kind: "list",
              updatedAt: last.updatedAt.toISOString()
            })
          : null
      };
    },

    async search(
      userId: string,
      input: MemoryListSearchInput
    ): Promise<MemoryListResponse> {
      const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
      const normalizedQuery = normalizeMemorySearchText(input.query);
      if (!normalizedQuery) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      const filterHash = memorySha256({
        category: input.category ?? null,
        includePatterns: input.includePatterns !== false,
        query: normalizedQuery,
        scope: input.scope ?? null,
        sourceMode: input.sourceMode ?? null,
        state: input.state ?? null,
        userId
      });
      const cursor = input.cursor ? decodeSearchCursor(input.cursor, filterHash) : null;
      const offset = cursor?.offset ?? 0;
      const requestedState = input.state ?? "ACTIVE";
      if (requestedState !== "ACTIVE") {
        const versionState = requestedState === "CONFLICTED"
          ? "CONFLICTING"
          : requestedState;
        const inactiveConditions = [
          Prisma.sql`fact."userId" = ${userId}`,
          memoryCanonicalGlobalScopePredicate(),
          Prisma.sql`fact."state" = ${requestedState}::"MemoryFactState"`,
          Prisma.sql`version."state" = ${versionState}::"MemoryFactVersionState"`,
          Prisma.sql`version."contentPurgedAt" IS NULL`,
          Prisma.sql`version."safetyClassificationState" =
            'CLASSIFIED'::"MemorySafetyClassificationState"`,
          memoryPersonalFactEvidencePredicate(userId),
          Prisma.sql`(
            version."normalizedSearchText" = ${normalizedQuery}
            OR strpos(version."normalizedSearchText", ${normalizedQuery}) > 0
          )`
        ];
        if (requestedState === "ORPHANED") {
          inactiveConditions.push(
            Prisma.sql`version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"`
          );
        }
        if (input.scope) inactiveConditions.push(scopeFilter(input.scope));
        if (input.category) {
          inactiveConditions.push(Prisma.sql`fact."category" = ${input.category}`);
        }
        if (input.sourceMode) {
          inactiveConditions.push(
            Prisma.sql`version."sourceMode" = ${input.sourceMode}::"MemoryFactSourceMode"`
          );
        }
        const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT fact."id"
          FROM "MemoryFact" AS fact
          INNER JOIN "User" AS owner
            ON owner."id" = fact."userId" AND owner."status" = 'active'
          INNER JOIN "MemoryScope" AS scope
            ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
          INNER JOIN "MemoryFactVersion" AS version
            ON version."userId" = fact."userId" AND version."factId" = fact."id"
          WHERE ${Prisma.join(inactiveConditions, " AND ")}
          GROUP BY fact."id", fact."updatedAt"
          ORDER BY
            MAX((version."normalizedSearchText" = ${normalizedQuery})::integer) DESC,
            fact."updatedAt" DESC,
            fact."id" DESC
          OFFSET ${offset}
          LIMIT ${pageSize + 1}
        `);
        const page = rows.slice(0, pageSize);
        const ids = page.map(({ id }) => id);
        const summaries = await summariesByIds(client, userId, ids);
        const nextOffset = offset + page.length;
        return {
          memories: orderedSummaries(ids, summaries),
          nextCursor: rows.length > pageSize && nextOffset <= SEARCH_OFFSET_MAX
            ? encodeCursor({ filterHash, kind: "search", offset: nextOffset })
            : null
        };
      }
      const conditions = [
        Prisma.sql`fact."userId" = ${userId}`,
        Prisma.sql`scope."state" = 'ACTIVE'`,
        Prisma.sql`fact."state" = 'ACTIVE'`,
        Prisma.sql`version."safetyClassificationState" =
          'CLASSIFIED'::"MemorySafetyClassificationState"`,
        memoryCanonicalGlobalScopePredicate(),
        input.includePatterns === false
          ? memoryPersonalFactEvidencePredicate(userId)
          : Prisma.sql`(
              ${memoryPersonalFactEvidencePredicate(userId)}
              OR ${memorySynthesisPatternAuthorityPredicate(userId, { forManagement: true })}
            )`,
        Prisma.sql`(
          search."normalizedSearchText" = ${normalizedQuery}
          OR strpos(search."normalizedSearchText", ${normalizedQuery}) > 0
          OR search."searchVectorSimple" @@ plainto_tsquery('simple', ${normalizedQuery})
        )`
      ];
      if (input.includePatterns === false) {
        conditions.push(Prisma.sql`version."modality" <> 'PATTERN'::"MemoryFactModality"`);
      } else if (!input.category &&
        (!input.sourceMode || input.sourceMode === "AUTOMATIC")) {
        conditions.push(uncollapsedSourcePredicate(userId, normalizedQuery));
      }
      if (input.scope) conditions.push(scopeFilter(input.scope));
      if (input.category) {
        conditions.push(Prisma.sql`fact."category" = ${input.category}`);
      }
      if (input.state) conditions.push(Prisma.sql`fact."state" = ${input.state}::"MemoryFactState"`);
      if (input.sourceMode) {
        conditions.push(
          Prisma.sql`version."sourceMode" = ${input.sourceMode}::"MemoryFactSourceMode"`
        );
      }
      const rows = await client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT fact."id"
        FROM "MemoryFact" AS fact
        INNER JOIN "User" AS owner
          ON owner."id" = fact."userId" AND owner."status" = 'active'
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = fact."userId"
          AND version."factId" = fact."id"
          AND version."safetyClassificationState" =
            'CLASSIFIED'::"MemorySafetyClassificationState"
          AND version."id" = fact."currentVersionId"
          AND version."state" = 'ACTIVE'
          AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = fact."userId"
        INNER JOIN "MemoryIndexGeneration" AS generation
          ON generation."userId" = settings."userId"
          AND generation."id" = settings."activeIndexGenerationId"
          AND generation."state" = 'ACTIVE'
        INNER JOIN "MemorySearchEntry" AS search
          ON search."userId" = fact."userId"
          AND search."indexGenerationId" = generation."id"
          AND search."factVersionId" = version."id"
        WHERE ${Prisma.join(conditions, " AND ")}
        ORDER BY
          (search."normalizedSearchText" = ${normalizedQuery}) DESC,
          ts_rank_cd(search."searchVectorSimple", plainto_tsquery('simple', ${normalizedQuery})) DESC,
          fact."updatedAt" DESC,
          fact."id" DESC
        OFFSET ${offset}
        LIMIT ${pageSize + 1}
      `);
      const page = rows.slice(0, pageSize);
      const ids = page.map((row) => row.id);
      const summaries = await summariesByIds(client, userId, ids);
      const nextOffset = offset + page.length;
      return {
        memories: orderedSummaries(ids, summaries),
        nextCursor: rows.length > pageSize && nextOffset <= SEARCH_OFFSET_MAX
          ? encodeCursor({ filterHash, kind: "search", offset: nextOffset })
          : null
      };
    }
  });
}
