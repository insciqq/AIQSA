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
import { memoryPersistenceFailure } from "../persistence/errors";
import {
  memorySha256,
  normalizeMemorySearchText,
  normalizeMemorySearchTextYo
} from "../persistence/lexical";
import { memoryPurgeTargetType } from "../purge/contract";

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
      COALESCE(evidence."sourceCount", 0)::integer AS "sourceCount",
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
      SELECT COUNT(*)::integer AS "sourceCount"
      FROM "MemoryEvidence" AS item
      WHERE item."userId" = fact."userId"
        AND item."factVersionId" = version."id"
    ) AS evidence ON true
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
  `);
  return new Map(rows.map((row) => [row.id, summaryFromRow(row)]));
}

function orderedSummaries(
  ids: readonly string[],
  byId: ReadonlyMap<string, MemorySummary>
): MemorySummary[] {
  return ids.map((id) => {
    const summary = byId.get(id);
    if (!summary) return memoryPersistenceFailure("memory_counter_contract_invalid");
    return summary;
  });
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
          where: { factId, userId }
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
      const fact = await client.memoryFact.findFirst({
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
      const scope = await client.memoryScope.findFirst({
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
        ? await client.memoryFactVersion.findFirst({
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
            userId
          }
        })
        : await client.memoryFactVersion.findFirst({
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
            userId
          }
        });
      if (
        !scope ||
        !version ||
        !version.displayText ||
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
        scope: input.scope ?? null,
        sourceMode: input.sourceMode ?? null,
        state: input.state ?? null,
        userId
      });
      const cursor = input.cursor ? decodeListCursor(input.cursor, filterHash) : null;
      const conditions = [
        Prisma.sql`fact."userId" = ${userId}`
      ];
      if (input.scope) conditions.push(scopeFilter(input.scope));
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
          SELECT candidate."sourceMode"
          FROM "MemoryFactVersion" AS candidate
          WHERE candidate."userId" = fact."userId"
            AND candidate."factId" = fact."id"
            AND (fact."currentVersionId" IS NULL OR candidate."id" = fact."currentVersionId")
          ORDER BY candidate."systemFrom" DESC, candidate."id" DESC
          LIMIT 1
        ) AS version ON true
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
      const normalizedYoQuery = normalizeMemorySearchTextYo(input.query);
      if (!normalizedQuery || !normalizedYoQuery) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      const filterHash = memorySha256({
        query: normalizedYoQuery,
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
          Prisma.sql`fact."state" = ${requestedState}::"MemoryFactState"`,
          Prisma.sql`version."state" = ${versionState}::"MemoryFactVersionState"`,
          Prisma.sql`version."contentPurgedAt" IS NULL`,
          Prisma.sql`(
            version."normalizedSearchText" = ${normalizedQuery}
            OR strpos(version."normalizedSearchText", ${normalizedQuery}) > 0
            OR translate(version."normalizedSearchText", 'ё', 'е') = ${normalizedYoQuery}
            OR strpos(translate(version."normalizedSearchText", 'ё', 'е'), ${normalizedYoQuery}) > 0
          )`
        ];
        if (requestedState === "ORPHANED") {
          inactiveConditions.push(
            Prisma.sql`version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"`
          );
        }
        if (input.scope) inactiveConditions.push(scopeFilter(input.scope));
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
        Prisma.sql`(
          scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
          OR (
            scope."scopeType" = 'FOLDER'::"MemoryScopeType"
            AND EXISTS (
              SELECT 1 FROM "Folder" AS target
              WHERE target."userId" = fact."userId"
                AND target."id" = scope."folderId"
            )
          )
          OR (
            scope."scopeType" = 'ASSISTANT'::"MemoryScopeType"
            AND EXISTS (
              SELECT 1 FROM "AssistantDefinition" AS target
              WHERE target."ownerUserId" = fact."userId"
                AND target."id" = scope."assistantId"
                AND target."archivedAt" IS NULL
            )
          )
          OR (
            scope."scopeType" = 'CHAT'::"MemoryScopeType"
            AND EXISTS (
              SELECT 1 FROM "Chat" AS target
              WHERE target."userId" = fact."userId"
                AND target."id" = scope."chatId"
                AND target."memoryMode" <> 'TEMPORARY'::"MemoryChatMode"
            )
          )
        )`,
        Prisma.sql`(
          search."safeSearchTextYoNormalized" = ${normalizedYoQuery}
          OR strpos(search."safeSearchTextYoNormalized", ${normalizedYoQuery}) > 0
          OR search."searchVectorSimple" @@ plainto_tsquery('simple', ${normalizedYoQuery})
          OR search."searchVectorRussian" @@ plainto_tsquery('russian', ${normalizedYoQuery})
          OR search."searchVectorEnglish" @@ plainto_tsquery('english', ${normalizedQuery})
        )`
      ];
      if (input.scope) conditions.push(scopeFilter(input.scope));
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
          AND version."id" = fact."currentVersionId"
          AND version."state" = 'ACTIVE'
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
          (search."safeSearchTextYoNormalized" = ${normalizedYoQuery}) DESC,
          GREATEST(
            ts_rank_cd(search."searchVectorSimple", plainto_tsquery('simple', ${normalizedYoQuery})),
            ts_rank_cd(search."searchVectorRussian", plainto_tsquery('russian', ${normalizedYoQuery})),
            ts_rank_cd(search."searchVectorEnglish", plainto_tsquery('english', ${normalizedQuery}))
          ) DESC,
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
