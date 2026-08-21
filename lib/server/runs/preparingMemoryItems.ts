import { Prisma } from "@prisma/client";
import type { MemorySafeProjectionKind } from "../../domain/memory/retrieval";
import {
  memoryActiveSuppressionPredicate,
  memoryChunkSourceSafetyPredicate,
  memoryFactScopePredicate
} from "../memory/retrieval/localRepository";
import { memoryPersonalFactEvidencePredicate } from "../memory/persistence/eligibility";
import {
  memoryChunkConversationFeedbackPredicate,
  memoryFactConversationFeedbackPredicate
} from "../memory/persistence/feedback";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../memory/history/chunking";
import { MEMORY_HISTORY_INDEX_PIPELINE_VERSION } from "../memory/history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../memory/history/sourceProjection";
import {
  MemoryPreparingRunConflictError,
  memoryPreparingHash,
  memoryPreparingItemTarget,
  memoryPreparingTextHash,
  type MemoryPreparingItemInput
} from "./preparingRun";

type PreparingItemTransaction = Prisma.TransactionClient;

export type PreparingMemoryItemAuthority = Readonly<{
  assistantId: string | null;
  chatId: string;
  folderId: string | null;
  indexGenerationId: string | null;
  userId: string;
}>;

export type ResolvedPreparingMemoryItem = Readonly<{
  exactItemId: string;
  exactSafeText: string;
  factVersionId: string | null;
  featureSnapshot: Readonly<Record<string, unknown>>;
  finalScore: number;
  itemStateAtAdmission: string;
  itemType: "FACT_VERSION" | "RECALL_CHUNK";
  laneRanks: Readonly<Record<string, unknown>>;
  projectionKind: MemorySafeProjectionKind;
  recallChunkId: string | null;
  selectionReason: string;
  sourceBranchGenerationSnapshot: number | null;
  sourceChatIdSnapshot: string | null;
  sourceContentHashSnapshot: string | null;
  sourceMessageIdsSnapshot: readonly string[];
  sourceRevisionSnapshot: number | null;
  sourceSnapshot: Readonly<Record<string, unknown>>;
  textHash: string;
  versionSnapshot: Readonly<Record<string, unknown>>;
}>;

type FactAuthorityRow = Readonly<{
  coreEligible: boolean;
  coreSalience: string;
  createdByEventId: string;
  currentVersionId: string | null;
  displayText: string;
  factCanonicalKey: string;
  factCategory: string;
  factId: string;
  factState: string;
  languageCode: string;
  pinned: boolean;
  scopeAssistantId: string | null;
  scopeChatId: string | null;
  scopeFolderId: string | null;
  scopeId: string;
  scopeState: string;
  scopeTargetIdSnapshot: string | null;
  scopeType: string;
  sensitivityClass: string;
  sourceMode: string;
  systemFrom: Date;
  systemTo: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
  versionState: string;
}>;

type FactMessageEvidenceRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  evidenceId: string;
  messageId: string;
}>;

type HistoryAuthorityRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  contentHash: string;
  languageCode: string;
  redactionState: string;
  safeText: string;
  safetyClass: string;
  sourceAssistantId: string | null;
  sourceFolderId: string | null;
  sourceRevision: number;
  state: string;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function compactProjection(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function exactTextContainsProjection(exactSafeText: string, projection: string): boolean {
  const compactExactText = compactProjection(exactSafeText);
  const compact = compactProjection(projection);
  return compact.length > 0 && (
    compactExactText === compact || compactExactText.endsWith(compact)
  );
}

function itemProjection(input: MemoryPreparingItemInput): Readonly<{
  kind: MemorySafeProjectionKind;
  supportingItemId: string | null;
}> {
  const feature = record(input.featureSnapshot);
  const inferredKind: MemorySafeProjectionKind = input.itemType === "RECALL_CHUNK"
    ? "RECALL_CHUNK_SAFE_PROJECTED_TEXT"
    : "FACT_DISPLAY_TEXT";
  const kind = input.projectionKind ?? feature?.projectionKind ?? inferredKind;
  const supportingItemId = input.supportingItemId !== undefined
    ? input.supportingItemId
    : feature?.supportingItemId;
  if (
    kind !== "FACT_DISPLAY_TEXT" &&
    kind !== "RECALL_CHUNK_SAFE_PROJECTED_TEXT"
  ) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  if (supportingItemId !== null && supportingItemId !== undefined &&
    (typeof supportingItemId !== "string" || supportingItemId.length === 0 ||
      supportingItemId.length > 256)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  return { kind, supportingItemId: supportingItemId ?? null };
}

function commonResolved(
  input: MemoryPreparingItemInput,
  projectionKind: MemorySafeProjectionKind
): Pick<
  ResolvedPreparingMemoryItem,
  "exactSafeText" | "featureSnapshot" | "finalScore" | "laneRanks" |
  "projectionKind" | "selectionReason" | "textHash"
> {
  return {
    exactSafeText: input.exactSafeText,
    featureSnapshot: {
      ...(input.featureSnapshot ?? {}),
      finalScore: input.finalScore,
      projectionKind
    },
    finalScore: input.finalScore,
    laneRanks: input.laneRanks ?? {},
    projectionKind,
    selectionReason: input.selectionReason,
    textHash: memoryPreparingTextHash(input.exactSafeText)
  };
}

async function resolveFact(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  input: MemoryPreparingItemInput & Readonly<{ factVersionId: string }>
): Promise<ResolvedPreparingMemoryItem> {
  const projection = itemProjection(input);
  if (projection.kind !== "FACT_DISPLAY_TEXT" || projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  const feature = record(input.featureSnapshot);
  const core = feature?.tier === "CORE";
  if (!core && !authority.indexGenerationId) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const settingsJoin = core
    ? Prisma.sql`
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = version."userId"
          AND settings."useMemoryFacts" = TRUE
      `
    : Prisma.sql`
        INNER JOIN "UserMemorySettings" AS settings
          ON settings."userId" = version."userId"
          AND settings."useMemoryFacts" = TRUE
          AND settings."activeIndexGenerationId" = ${authority.indexGenerationId}
        INNER JOIN "MemoryIndexGeneration" AS generation
          ON generation."userId" = settings."userId"
          AND generation."id" = settings."activeIndexGenerationId"
          AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
        LEFT JOIN "MemorySearchEntry" AS entry
          ON entry."userId" = version."userId"
          AND entry."indexGenerationId" = generation."id"
          AND entry."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
          AND entry."factVersionId" = version."id"
      `;
  const currentAuthority = core
    ? Prisma.sql`(
        fact."pinned"
        OR version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        OR version."coreEligible"
      )`
    : Prisma.sql`entry."id" IS NOT NULL`;
  const terminalCompatibility = core
    ? Prisma.sql`FALSE`
    : Prisma.sql`(
        version."state" IN (
          'SUPERSEDED'::"MemoryFactVersionState",
          'EXPIRED'::"MemoryFactVersionState",
          'CONFLICTING'::"MemoryFactVersionState"
        )
        AND fact."state" IN (
          'ACTIVE'::"MemoryFactState",
          'CONFLICTED'::"MemoryFactState",
          'EXPIRED'::"MemoryFactState"
        )
        AND (fact."currentVersionId" IS NULL OR fact."currentVersionId" <> version."id")
      )`;
  const lockTargets = core
    ? Prisma.sql`version, fact, scope, settings`
    : Prisma.sql`version, fact, scope, settings, generation`;
  const [row] = await tx.$queryRaw<FactAuthorityRow[]>(Prisma.sql`
    SELECT
      version."coreEligible", version."coreSalience"::text AS "coreSalience",
      version."createdByEventId",
      version."displayText",
      version."languageCode",
      version."sensitivityClass"::text AS "sensitivityClass",
      version."sourceMode"::text AS "sourceMode",
      version."state"::text AS "versionState",
      version."systemFrom", version."systemTo", version."validFrom", version."validTo",
      fact."canonicalKey" AS "factCanonicalKey",
      fact."category" AS "factCategory", fact."currentVersionId",
      fact."id" AS "factId", fact."pinned", fact."state"::text AS "factState",
      scope."assistantId" AS "scopeAssistantId", scope."chatId" AS "scopeChatId",
      scope."folderId" AS "scopeFolderId", scope."id" AS "scopeId",
      scope."state"::text AS "scopeState",
      scope."targetIdSnapshot" AS "scopeTargetIdSnapshot",
      scope."scopeType"::text AS "scopeType"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    ${settingsJoin}
    WHERE version."userId" = ${authority.userId}
      AND version."id" = ${input.factVersionId}
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."sourceMode" IN (
        'EXPLICIT'::"MemoryFactSourceMode",
        'AUTOMATIC'::"MemoryFactSourceMode"
      )
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND ${memoryFactScopePredicate({
        assistantId: authority.assistantId,
        chatId: authority.chatId,
        folderId: authority.folderId,
        userId: authority.userId
      })}
      AND ${memoryPersonalFactEvidencePredicate(authority.userId)}
      AND ${memoryFactConversationFeedbackPredicate(
        authority.userId,
        authority.chatId
      )}
      AND ${memoryActiveSuppressionPredicate(authority.userId)}
      AND (
        (
          version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."systemTo" IS NULL
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" = version."id"
          AND ${currentAuthority}
        )
        OR ${terminalCompatibility}
      )
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
    FOR SHARE OF ${lockTargets}
  `);
  if (!row || !exactTextContainsProjection(input.exactSafeText, row.displayText)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const messageEvidence = row.sourceMode === "AUTOMATIC"
    ? await tx.$queryRaw<FactMessageEvidenceRow[]>(Prisma.sql`
        SELECT
          support."branchGeneration", support."chatId",
          support."id" AS "evidenceId", support."messageId"
        FROM "MemoryEvidence" AS support
        INNER JOIN "Chat" AS evidence_chat
          ON evidence_chat."userId" = support."userId"
          AND evidence_chat."id" = support."chatId"
          AND evidence_chat."projectId" IS NULL
          AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
          AND evidence_chat."memoryBranchGeneration" = support."branchGeneration"
        INNER JOIN "Message" AS evidence_message
          ON evidence_message."chatId" = support."chatId"
          AND evidence_message."id" = support."messageId"
          AND evidence_message."role" = 'user'
        WHERE support."userId" = ${authority.userId}
          AND support."factVersionId" = ${input.factVersionId}
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
              AND evidence_message."createdAt" <= source_barrier."sourceCreatedAtCutoff"
          )
        ORDER BY support."createdAt", support."id"
        LIMIT 50
        FOR SHARE OF support, evidence_chat, evidence_message
      `)
    : [];
  const primaryEvidence = messageEvidence[0] ?? null;
  if (row.sourceMode === "AUTOMATIC" && !primaryEvidence) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const sourceMessageIds = primaryEvidence
    ? messageEvidence.flatMap((evidence) =>
        evidence.chatId === primaryEvidence.chatId &&
          evidence.branchGeneration === primaryEvidence.branchGeneration
          ? [evidence.messageId]
          : [])
    : [];
  const sourceSnapshot = {
    createdByEventId: row.createdByEventId,
    evidenceIds: primaryEvidence
      ? messageEvidence.flatMap((evidence) =>
          evidence.chatId === primaryEvidence.chatId &&
            evidence.branchGeneration === primaryEvidence.branchGeneration
            ? [evidence.evidenceId]
            : [])
      : [],
    projectedTextHash: memoryPreparingTextHash(compactProjection(row.displayText)),
    projectionKind: projection.kind,
    schemaVersion: 2,
    sourceMode: row.sourceMode
  };
  const versionSnapshot = {
    currentVersionId: row.currentVersionId,
    coreEligible: row.coreEligible,
    coreSalience: row.coreSalience,
    factCanonicalKey: row.factCanonicalKey,
    factCategory: row.factCategory,
    factId: row.factId,
    factState: row.factState,
    factVersionId: input.factVersionId,
    languageCode: row.languageCode,
    pinned: row.pinned,
    scopeAssistantId: row.scopeAssistantId,
    scopeChatId: row.scopeChatId,
    scopeFolderId: row.scopeFolderId,
    scopeId: row.scopeId,
    scopeState: row.scopeState,
    scopeTargetIdSnapshot: row.scopeTargetIdSnapshot,
    scopeType: row.scopeType,
    schemaVersion: 2,
    sensitivityClass: row.sensitivityClass,
    systemFrom: iso(row.systemFrom),
    systemTo: iso(row.systemTo),
    validFrom: iso(row.validFrom),
    validTo: iso(row.validTo),
    versionState: row.versionState
  };
  return {
    ...commonResolved(input, projection.kind),
    exactItemId: input.factVersionId,
    factVersionId: input.factVersionId,
    itemStateAtAdmission: row.versionState,
    itemType: "FACT_VERSION",
    recallChunkId: null,
    sourceBranchGenerationSnapshot: primaryEvidence?.branchGeneration ?? null,
    sourceChatIdSnapshot: primaryEvidence?.chatId ?? null,
    sourceContentHashSnapshot: null,
    sourceMessageIdsSnapshot: sourceMessageIds,
    sourceRevisionSnapshot: null,
    sourceSnapshot,
    versionSnapshot
  };
}

async function resolveChunkRow(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  chunkId: string
): Promise<HistoryAuthorityRow | null> {
  if (!authority.indexGenerationId) return null;
  const [row] = await tx.$queryRaw<HistoryAuthorityRow[]>(Prisma.sql`
    SELECT
      chunk."branchGeneration", chunk."chatId", chunk."contentHash",
      chunk."languageCode", chunk."redactionState"::text AS "redactionState",
      chunk."safeProjectedText" AS "safeText",
      chunk."safetyClass"::text AS "safetyClass",
      chunk."sourceAssistantId", chunk."sourceFolderId",
      chunk."sourceRevisionAtCreation" AS "sourceRevision",
      chunk."state"::text AS "state"
    FROM "MemoryRecallChunk" AS chunk
    INNER JOIN "MemorySearchEntry" AS entry
      ON entry."userId" = chunk."userId"
      AND entry."indexGenerationId" = ${authority.indexGenerationId}
      AND entry."itemType" = 'RECALL_CHUNK'::"MemorySearchItemType"
      AND entry."recallChunkId" = chunk."id"
      AND entry."safeContentHash" = chunk."contentHash"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = entry."indexGenerationId"
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = chunk."userId" AND source_chat."id" = chunk."chatId"
      AND source_chat."projectId" IS NULL
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = chunk."userId" AND checkpoint."chatId" = chunk."chatId"
    WHERE chunk."userId" = ${authority.userId}
      AND chunk."id" = ${chunkId}
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND chunk."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND chunk."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."memoryBranchGeneration" = chunk."branchGeneration"
      AND source_chat."memorySourceRevision" = chunk."sourceRevisionAtCreation"
      AND checkpoint."branchGeneration" = chunk."branchGeneration"
      AND checkpoint."sourceRevision" = chunk."sourceRevisionAtCreation"
      AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND ${memoryChunkConversationFeedbackPredicate(
        authority.userId,
        authority.chatId
      )}
      AND ${memoryChunkSourceSafetyPredicate()}
      AND chunk."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass",
        'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
    FOR SHARE OF chunk, entry, settings, generation, source_chat, checkpoint
  `);
  return row ?? null;
}

async function chunkMessageIds(
  tx: PreparingItemTransaction,
  userId: string,
  chunkId: string
): Promise<string[]> {
  const rows = await tx.memoryRecallChunkMessage.findMany({
    orderBy: { ordinal: "asc" },
    select: { messageId: true },
    take: 51,
    where: { chunkId, userId }
  });
  if (rows.length === 0 || rows.length > 50) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  return rows.map(({ messageId }) => messageId);
}

function historySnapshots(
  row: HistoryAuthorityRow,
  projectionKind: MemorySafeProjectionKind,
  sourceMessageIds: readonly string[],
  supportingItemId: string | null
): Readonly<{
  sourceSnapshot: Readonly<Record<string, unknown>>;
  versionSnapshot: Readonly<Record<string, unknown>>;
}> {
  return {
    sourceSnapshot: {
      projectedTextHash: memoryPreparingTextHash(compactProjection(row.safeText)),
      projectionKind,
      schemaVersion: 2,
      sourceAssistantId: row.sourceAssistantId,
      sourceFolderId: row.sourceFolderId,
      sourceMessageIds,
      sourceMode: "HISTORY",
      supportingItemId
    },
    versionSnapshot: {
      languageCode: row.languageCode,
      redactionState: row.redactionState,
      safetyClass: row.safetyClass,
      schemaVersion: 2,
      state: row.state
    }
  };
}

async function resolveChunk(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  input: MemoryPreparingItemInput & Readonly<{ recallChunkId: string }>
): Promise<ResolvedPreparingMemoryItem> {
  const projection = itemProjection(input);
  if (projection.kind !== "RECALL_CHUNK_SAFE_PROJECTED_TEXT" ||
    projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  const row = await resolveChunkRow(tx, authority, input.recallChunkId);
  if (!row || !exactTextContainsProjection(input.exactSafeText, row.safeText)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const sourceMessageIds = await chunkMessageIds(tx, authority.userId, input.recallChunkId);
  const snapshots = historySnapshots(row, projection.kind, sourceMessageIds, null);
  return {
    ...commonResolved(input, projection.kind),
    ...snapshots,
    exactItemId: input.recallChunkId,
    factVersionId: null,
    itemStateAtAdmission: row.state,
    itemType: "RECALL_CHUNK",
    recallChunkId: input.recallChunkId,
    sourceBranchGenerationSnapshot: row.branchGeneration,
    sourceChatIdSnapshot: row.chatId,
    sourceContentHashSnapshot: row.contentHash,
    sourceMessageIdsSnapshot: sourceMessageIds,
    sourceRevisionSnapshot: row.sourceRevision
  };
}

export async function resolvePreparingMemoryItem(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  _querySnapshot: string | null,
  input: MemoryPreparingItemInput
): Promise<ResolvedPreparingMemoryItem> {
  const target = memoryPreparingItemTarget(input);
  if (!target) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  if (target.itemType === "FACT_VERSION" && target.factVersionId) {
    return resolveFact(tx, authority, {
      ...input,
      factVersionId: target.factVersionId
    });
  }
  if (target.itemType === "RECALL_CHUNK" && target.recallChunkId) {
    return resolveChunk(tx, authority, {
      ...input,
      exactItemId: target.exactItemId,
      itemType: "RECALL_CHUNK",
      recallChunkId: target.recallChunkId
    });
  }
  throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
}

export function samePreparingMemoryItemSnapshot(
  left: Readonly<{
    exactSafeText: string;
    featureSnapshot: unknown;
    laneRanks: unknown;
    selectionReason: string;
    sourceSnapshot: unknown;
    textHash: string;
    versionSnapshot: unknown;
  }>,
  right: ResolvedPreparingMemoryItem
): boolean {
  return left.exactSafeText === right.exactSafeText &&
    left.textHash === right.textHash &&
    left.selectionReason === right.selectionReason &&
    memoryPreparingHash(left.featureSnapshot) === memoryPreparingHash(right.featureSnapshot) &&
    memoryPreparingHash(left.laneRanks) === memoryPreparingHash(right.laneRanks) &&
    memoryPreparingHash(left.sourceSnapshot) === memoryPreparingHash(right.sourceSnapshot) &&
    memoryPreparingHash(left.versionSnapshot) === memoryPreparingHash(right.versionSnapshot);
}
