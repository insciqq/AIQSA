import { Prisma } from "@prisma/client";
import {
  canonicalMemoryPackedSafeText,
  MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS,
  MEMORY_CONTEXT_PATTERN_MIN_SUPPORTS,
  type MemorySafeProjectionKind
} from "../../domain/memory/retrieval";
import {
  memoryActiveSuppressionPredicate,
  memoryChunkSourceSafetyPredicate,
  memoryFactScopePredicate,
  memoryRoundSourceSafetyPredicate
} from "../memory/retrieval/localRepository";
import {
  memoryExactMessageEvidenceIsCurrent,
  memoryPersonalEvidenceRowPredicate
} from "../memory/persistence/eligibility";
import { memoryReusableFactAuthorityPredicate } from
  "../memory/synthesis/eligibility";
import {
  memoryChunkConversationFeedbackPredicate,
  memoryFactConversationFeedbackPredicate,
  memoryRoundConversationFeedbackPredicate
} from "../memory/persistence/feedback";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../memory/history/chunking";
import {
  MEMORY_CHAT_DIGEST_MAX_SOURCE_MESSAGES,
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../memory/history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../memory/history/sourceProjection";
import {
  boundedMemoryRecallRoundEvidenceText,
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  MEMORY_RECALL_ROUND_PROJECTION_VERSION
} from "../memory/history/rounds";
import { MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION } from
  "../memory/history/segments";
import { MEMORY_TOOL_EVENT_PROJECTION_VERSION } from
  "../memory/history/toolEvents";
import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets
} from "../memory/explicit/safety";
import {
  memoryHistoryChunkSourceAuthorityPredicate,
  memoryHistoryRoundSourceAuthorityPredicate
} from "../memory/persistence/pauseIntervals";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
  memorySha256
} from "../memory/persistence/lexical";
import { memoryCanonicalFactRootIdSql } from
  "../memory/persistence/canonicalFact";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from
  "../memory/retrieval/vector";
import {
  MemoryPreparingRunConflictError,
  memoryPreparingHash,
  memoryPreparingItemTarget,
  memoryPreparingTextHash,
  type MemoryPreparingItemInput
} from "./preparingRun";

type PreparingItemTransaction = Prisma.TransactionClient;

function compatibleActiveGenerationPredicate(): Prisma.Sql {
  return Prisma.sql`
    generation."chunkingVersion" = ${MEMORY_LEXICAL_CHUNKING_VERSION}
    AND generation."languageProfile" = ${MEMORY_LEXICAL_LANGUAGE_PROFILE}
    AND generation."normalizationVersion" = ${MEMORY_LEXICAL_NORMALIZATION_VERSION}
    AND (
      (generation."indexMode" = 'HYBRID'::"MemoryIndexMode"
        AND generation."retrievalPipelineVersion" =
          ${MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION})
      OR
      (generation."indexMode" = 'LEXICAL_ONLY'::"MemoryIndexMode"
        AND generation."retrievalPipelineVersion" =
          ${MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION})
    )
  `;
}

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
  itemType: "FACT_VERSION" | "RECALL_CHUNK" | "RECALL_ROUND" | "TOOL_EVENT";
  laneRanks: Readonly<Record<string, unknown>>;
  projectionKind: MemorySafeProjectionKind;
  recallChunkId: string | null;
  recallRoundId: string | null;
  recallRoundSegmentId: string | null;
  toolEventId: string | null;
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
  expectedAt: Date | null;
  expiresAt: Date | null;
  factCanonicalKey: string;
  factCategory: string;
  factId: string;
  factState: string;
  identityKind: string | null;
  languageCode: string;
  modality: string;
  mergedIntoVersionId: string | null;
  movedFromVersionId: string | null;
  observedAt: Date | null;
  occurredAt: Date | null;
  pinned: boolean;
  scopeAssistantId: string | null;
  scopeChatId: string | null;
  scopeFolderId: string | null;
  scopeId: string;
  scopeState: string;
  scopeTargetIdSnapshot: string | null;
  scopeType: string;
  searchSafeContentHash: string | null;
  sensitivityClass: string;
  sourceMode: string;
  systemFrom: Date;
  systemTo: Date | null;
  supersedesVersionId: string | null;
  structuredValue: Prisma.JsonValue;
  validFrom: Date | null;
  validTo: Date | null;
  versionState: string;
}>;

type FactMessageEvidenceRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  content: Prisma.JsonValue;
  endOffset: number;
  evidenceId: string;
  evidenceFingerprint: string;
  messageId: string;
  safeExcerpt: string;
  safeSourceHash: string;
  sourceMessageContentHash: string;
  sourceProjectionVersion: string;
  startOffset: number;
}>;

type FactSynthesisRelationRow = Readonly<{
  pipelineVersion: string;
  sourceEligibilityHash: string;
  targetDisplayText: string;
  targetObservedAt: Date;
  targetSourceMode: string;
  targetVersionId: string;
}>;

type FactPatternEvidenceRow = FactMessageEvidenceRow & Readonly<{
  evidenceObservedAt: Date;
  targetVersionId: string;
}>;

type PatternSupportingEvidenceSnapshot = Readonly<{
  factVersionId: string;
  observedAt: string;
  sourceAuthority: "learned_from_user" | "user_saved";
  sourceRootHash: string;
  textHash: string;
}>;

type FactEntityRootRow = Readonly<{
  cycle: boolean;
  entityId: string;
  role: string;
  rootId: string | null;
}>;

type FactDependencyRow = Readonly<{
  dependencyKind: string;
  id: string;
  sourceFactVersionId: string | null;
  sourceMessageContentHash: string | null;
  sourceMessageId: string | null;
  sourceMessageUpdatedAt: Date | null;
  sourceProjectionVersion: string | null;
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

type DigestAuthorityRow = HistoryAuthorityRow & Readonly<{
  digestContentHash: string;
  digestId: string;
  digestPipelineVersion: string;
  digestSafetyPolicyVersion: string;
  digestText: string;
}>;

type RoundAuthorityRow = HistoryAuthorityRow & Readonly<{
  contextualKeyPolicyVersion: string;
  contextualKeyState: string;
  contextualNarrativeText: string;
  evidenceRootHash: string;
  parentChunkId: string;
  projectionVersion: string;
  supportingRoundIds: string[];
}>;

type RoundSegmentAuthorityRow = RoundAuthorityRow & Readonly<{
  parentRawSafeText: string;
  rawEndOffsetUtf16: number;
  rawSafeTextHash: string;
  rawStartOffsetUtf16: number;
  segmentId: string;
  segmentPosition: string;
  segmentProjectionVersion: string;
  segmentSourceRevision: number;
}>;

type ToolEventAuthorityRow = Readonly<{
  assistantMessageId: string;
  branchGeneration: number;
  chatId: string;
  contentHash: string;
  evidenceRootHash: string;
  languageCode: string;
  occurredAt: Date;
  operation: string;
  outcome: string;
  projectionVersion: string;
  redactionState: string;
  safeText: string;
  safetyClass: string;
  sourceAssistantId: string | null;
  sourceCallUpdatedAt: Date;
  sourceFolderId: string | null;
  sourcePayloadHash: string;
  sourceRevision: number;
  state: string;
  toolName: string;
}>;

function isRoundSegmentAuthorityRow(
  row: RoundAuthorityRow
): row is RoundSegmentAuthorityRow {
  return "segmentId" in row && typeof row.segmentId === "string" &&
    "segmentProjectionVersion" in row &&
    typeof row.segmentProjectionVersion === "string";
}

function exactRoundSegmentAuthority(row: RoundSegmentAuthorityRow): boolean {
  return Number.isSafeInteger(row.rawStartOffsetUtf16) &&
    Number.isSafeInteger(row.rawEndOffsetUtf16) &&
    row.rawStartOffsetUtf16 >= 0 &&
    row.rawEndOffsetUtf16 > row.rawStartOffsetUtf16 &&
    row.rawEndOffsetUtf16 <= row.parentRawSafeText.length &&
    row.segmentSourceRevision === row.sourceRevision &&
    row.parentRawSafeText.slice(
      row.rawStartOffsetUtf16,
      row.rawEndOffsetUtf16
    ) === row.safeText &&
    memorySha256(row.safeText) === row.rawSafeTextHash;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function patternSupportingEvidenceSnapshot(
  feature: Record<string, unknown> | null
): readonly PatternSupportingEvidenceSnapshot[] {
  const value = feature?.patternSupportingEvidence;
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_pattern_support_invalid",
      false
    );
  }
  const decoded = value.flatMap((entry) => {
    const item = record(entry);
    if (!item || Object.keys(item).sort().join("\u0000") !==
        "factVersionId\u0000observedAt\u0000sourceAuthority\u0000sourceRootHash\u0000textHash" ||
      typeof item.factVersionId !== "string" || !item.factVersionId ||
      item.factVersionId.length > 256 ||
      typeof item.observedAt !== "string" ||
      (item.sourceAuthority !== "learned_from_user" &&
        item.sourceAuthority !== "user_saved") ||
      typeof item.sourceRootHash !== "string" ||
      !/^[a-f0-9]{64}$/u.test(item.sourceRootHash) ||
      typeof item.textHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.textHash)) {
      return [];
    }
    const observedAt = new Date(item.observedAt);
    return Number.isNaN(observedAt.getTime()) ||
      observedAt.toISOString() !== item.observedAt
      ? []
      : [{
          factVersionId: item.factVersionId,
          observedAt: item.observedAt,
          sourceAuthority: item.sourceAuthority as
            "learned_from_user" | "user_saved",
          sourceRootHash: item.sourceRootHash,
          textHash: item.textHash
        }];
  });
  if (decoded.length !== value.length ||
    new Set(decoded.map(({ factVersionId }) => factVersionId)).size !== decoded.length ||
    new Set(decoded.map(({ sourceRootHash }) => sourceRootHash)).size !== decoded.length) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_pattern_support_invalid",
      false
    );
  }
  return Object.freeze(decoded);
}

function compactFactProjection(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
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
    : input.itemType === "RECALL_ROUND"
      ? "RECALL_ROUND_RAW_SAFE_TEXT"
      : input.itemType === "TOOL_EVENT"
        ? "TOOL_EVENT_SAFE_TEXT"
        : "FACT_DISPLAY_TEXT";
  const kind = input.projectionKind ?? feature?.projectionKind ?? inferredKind;
  const supportingItemId = input.supportingItemId !== undefined
    ? input.supportingItemId
    : feature?.supportingItemId;
  if (
    kind !== "CHAT_DIGEST_SAFE_TEXT" &&
    kind !== "FACT_DISPLAY_TEXT" &&
    kind !== "RECALL_CHUNK_SAFE_PROJECTED_TEXT" &&
    kind !== "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT" &&
    kind !== "RECALL_ROUND_RAW_SAFE_TEXT" &&
    kind !== "TOOL_EVENT_SAFE_TEXT"
  ) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_projection_invalid",
      false
    );
  }
  if (supportingItemId !== null && supportingItemId !== undefined &&
    (typeof supportingItemId !== "string" || supportingItemId.length === 0 ||
      supportingItemId.length > 256)) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_supporting_invalid",
      false
    );
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

type FactRetrievalContract = Readonly<{
  historical: boolean;
  includePatterns: boolean;
  mode: "CURRENT_PROFILE" | "HISTORICAL_MEMORY" | "HISTORY_OVERVIEW" |
    "PAST_CHAT_SEARCH" | "TARGETED_CURRENT";
}>;

function safeFactProjectionText(value: string): string | null {
  const redaction = redactMemorySecrets(value);
  if (redaction.containsSecret &&
    !memoryRedactionHasMeaningfulRemainder(value, redaction)) return null;
  return redaction.redactedText;
}

function factRetrievalContract(
  feature: Record<string, unknown> | null,
  core: boolean
): FactRetrievalContract {
  const mode = feature?.retrievalMode;
  const historical = feature?.historical;
  const includePatterns = feature?.includePatterns;
  if (
    (mode !== "CURRENT_PROFILE" && mode !== "TARGETED_CURRENT" &&
      mode !== "HISTORICAL_MEMORY" && mode !== "PAST_CHAT_SEARCH" &&
      mode !== "HISTORY_OVERVIEW") ||
    typeof historical !== "boolean" || typeof includePatterns !== "boolean" ||
    core && historical ||
    !core && mode === "HISTORY_OVERVIEW" ||
    historical && mode !== "HISTORICAL_MEMORY" ||
    includePatterns && mode !== "TARGETED_CURRENT"
  ) throw new MemoryPreparingRunConflictError(
    "memory_attempt_item_fact_retrieval_invalid",
    false
  );
  return { historical, includePatterns, mode };
}

function exactEvidenceValid(row: FactMessageEvidenceRow): boolean {
  return memoryExactMessageEvidenceIsCurrent({
    content: row.content,
    evidenceFingerprint: row.evidenceFingerprint,
    safeExcerpt: row.safeExcerpt,
    safeSourceHash: row.safeSourceHash,
    sourceEndOffset: row.endOffset,
    sourceMessageContentHash: row.sourceMessageContentHash,
    sourceProjectionVersion: row.sourceProjectionVersion,
    sourceStartOffset: row.startOffset
  });
}

async function factEntityRoots(
  tx: PreparingItemTransaction,
  userId: string,
  factVersionId: string
): Promise<readonly FactEntityRootRow[]> {
  const rows = await tx.$queryRaw<FactEntityRootRow[]>(Prisma.sql`
    WITH RECURSIVE roots AS (
      SELECT link."entityId" AS "originId", link."entityId", link."role"::text AS role,
        entity."mergedIntoId", ARRAY[entity."id"]::text[] AS visited, FALSE AS cycle
      FROM "MemoryFactVersionEntity" AS link
      INNER JOIN "MemoryEntity" AS entity
        ON entity."userId" = link."userId" AND entity."id" = link."entityId"
      WHERE link."userId" = ${userId} AND link."factVersionId" = ${factVersionId}

      UNION ALL

      SELECT roots."originId", entity."id", roots.role, entity."mergedIntoId",
        roots.visited || entity."id", entity."id" = ANY(roots.visited)
      FROM roots
      INNER JOIN "MemoryEntity" AS entity
        ON entity."userId" = ${userId} AND entity."id" = roots."mergedIntoId"
      WHERE NOT roots.cycle
    )
    SELECT "originId" AS "entityId", role,
      MAX("entityId") FILTER (WHERE "mergedIntoId" IS NULL AND NOT cycle) AS "rootId",
      BOOL_OR(cycle) AS cycle
    FROM roots
    GROUP BY "originId", role
    ORDER BY "originId", role
  `);
  if (rows.some((row) => row.cycle || row.rootId === null)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  return rows;
}

async function factDependencies(
  tx: PreparingItemTransaction,
  userId: string,
  factVersionId: string
): Promise<readonly FactDependencyRow[]> {
  return tx.$queryRaw<FactDependencyRow[]>(Prisma.sql`
    SELECT dependency."dependencyKind"::text AS "dependencyKind",
      dependency."id", dependency."sourceFactVersionId",
      dependency."sourceMessageContentHash", dependency."sourceMessageId",
      dependency."sourceMessageUpdatedAt", dependency."sourceProjectionVersion"
    FROM "MemoryFactVersionSourceDependency" AS dependency
    WHERE dependency."userId" = ${userId}
      AND dependency."targetFactVersionId" = ${factVersionId}
    ORDER BY dependency."dependencyKind", dependency."id"
    FOR SHARE OF dependency
  `);
}

async function resolveFact(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  input: MemoryPreparingItemInput & Readonly<{ factVersionId: string }>
): Promise<ResolvedPreparingMemoryItem> {
  const projection = itemProjection(input);
  if (projection.kind !== "FACT_DISPLAY_TEXT" || projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_fact_projection_invalid",
      false
    );
  }
  const feature = record(input.featureSnapshot);
  const patternSupports = patternSupportingEvidenceSnapshot(feature);
  const core = feature?.tier === "CORE";
  const retrieval = factRetrievalContract(feature, core);
  const direct = !core && feature?.directFactAuthority === true;
  if (!core && feature?.directFactAuthority !== true &&
    feature?.directFactAuthority !== false) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_fact_authority_invalid",
      false
    );
  }
  if (!core && !direct && !authority.indexGenerationId) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const settingsJoin = core || direct
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
          AND (
            (generation."indexMode" = 'HYBRID'::"MemoryIndexMode"
              AND generation."retrievalPipelineVersion" =
                ${MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION})
            OR
            (generation."indexMode" = 'LEXICAL_ONLY'::"MemoryIndexMode"
              AND generation."retrievalPipelineVersion" =
                ${MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION})
          )
        INNER JOIN "MemorySearchEntry" AS entry
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
    : direct ? Prisma.sql`TRUE` : Prisma.sql`entry."id" IS NOT NULL`;
  const lifecycleAuthority = retrieval.historical
    ? Prisma.sql`
        version."state" = 'SUPERSEDED'::"MemoryFactVersionState"
        AND version."systemTo" IS NOT NULL
        AND (
          fact."state" = 'ACTIVE'::"MemoryFactState"
          OR (fact."state" = 'RETRACTED'::"MemoryFactState"
            AND fact."movedToFactId" IS NOT NULL)
        )
      `
    : Prisma.sql`
        version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND fact."currentVersionId" = version."id"
      `;
  const lockTargets = core || direct
    ? Prisma.sql`version, fact, root_fact, scope, root_scope, settings`
    : Prisma.sql`version, fact, root_fact, scope, root_scope, settings, generation, entry`;
  const searchSafeContentHash = core || direct
    ? Prisma.sql`NULL::text AS "searchSafeContentHash"`
    : Prisma.sql`entry."safeContentHash" AS "searchSafeContentHash"`;
  const [row] = await tx.$queryRaw<FactAuthorityRow[]>(Prisma.sql`
    SELECT
      version."coreEligible", version."coreSalience"::text AS "coreSalience",
      version."createdByEventId",
      version."displayText",
      version."expectedAt", version."expiresAt",
      version."languageCode",
      version."modality"::text AS "modality",
      version."mergedIntoVersionId", version."movedFromVersionId",
      version."observedAt", version."occurredAt",
      version."sensitivityClass"::text AS "sensitivityClass",
      version."sourceMode"::text AS "sourceMode",
      version."state"::text AS "versionState",
      version."supersedesVersionId",
      version."structuredValue",
      version."systemFrom", version."systemTo", version."validFrom", version."validTo",
      root_fact."canonicalKey" AS "factCanonicalKey",
      root_fact."category" AS "factCategory", root_fact."currentVersionId",
      root_fact."identityKind"::text AS "identityKind",
      root_fact."id" AS "factId", root_fact."pinned",
      root_fact."state"::text AS "factState",
      root_scope."assistantId" AS "scopeAssistantId",
      root_scope."chatId" AS "scopeChatId",
      root_scope."folderId" AS "scopeFolderId", root_scope."id" AS "scopeId",
      root_scope."state"::text AS "scopeState",
      root_scope."targetIdSnapshot" AS "scopeTargetIdSnapshot",
      root_scope."scopeType"::text AS "scopeType",
      ${searchSafeContentHash}
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryFact" AS root_fact
      ON root_fact."userId" = fact."userId"
      AND root_fact."id" = ${memoryCanonicalFactRootIdSql(
        authority.userId,
        Prisma.sql`fact."id"`
      )}
      AND root_fact."state" = 'ACTIVE'::"MemoryFactState"
      AND root_fact."movedToFactId" IS NULL
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryScope" AS root_scope
      ON root_scope."userId" = root_fact."userId"
      AND root_scope."id" = root_fact."scopeId"
      AND root_scope."state" = 'ACTIVE'::"MemoryScopeState"
    ${settingsJoin}
    WHERE version."userId" = ${authority.userId}
      AND version."id" = ${input.factVersionId}
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
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
      AND ${memoryReusableFactAuthorityPredicate(authority.userId, {
        includePatterns: retrieval.includePatterns,
        lifecycle: retrieval.historical ? "CURRENT_OR_HISTORICAL" : "CURRENT"
      })}
      AND ${memoryFactConversationFeedbackPredicate(
        authority.userId,
        authority.chatId
      )}
      AND ${memoryActiveSuppressionPredicate(authority.userId)}
      AND ${lifecycleAuthority}
      AND ${currentAuthority}
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
    FOR SHARE OF ${lockTargets}
  `);
  const safeDisplayText = row ? safeFactProjectionText(row.displayText) : null;
  const expectedSearchHashes = row && safeDisplayText
    ? [row.displayText, safeDisplayText].map((displayText) => memorySha256({
        displayText,
        structuredValue: row.structuredValue
      }))
    : [];
  if (
    !row || !safeDisplayText ||
    !exactTextContainsProjection(input.exactSafeText, safeDisplayText) ||
    !core && !direct && !row.searchSafeContentHash ||
    !core && !direct && !expectedSearchHashes.includes(row.searchSafeContentHash!)
  ) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  if (row.modality === "PATTERN") {
    if (patternSupports.length < MEMORY_CONTEXT_PATTERN_MIN_SUPPORTS) {
      throw new MemoryPreparingRunConflictError(
        "memory_attempt_item_pattern_support_invalid",
        false
      );
    }
  }
  else if (patternSupports.length > 0) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_pattern_support_invalid",
      false
    );
  }
  const messageEvidence = row.sourceMode === "AUTOMATIC" && row.modality !== "PATTERN"
    ? await tx.$queryRaw<FactMessageEvidenceRow[]>(Prisma.sql`
        SELECT
          support."branchGeneration", support."chatId",
          evidence_message."content", support."sourceEndOffset" AS "endOffset",
          support."id" AS "evidenceId", support."evidenceFingerprint",
          support."messageId", support."safeExcerpt", support."safeSourceHash",
          support."sourceMessageContentHash", support."sourceProjectionVersion",
          support."sourceStartOffset" AS "startOffset"
        FROM "MemoryEvidence" AS support
        INNER JOIN "Chat" AS evidence_chat
          ON evidence_chat."userId" = support."userId"
          AND evidence_chat."id" = support."chatId"
          AND evidence_chat."projectId" IS NULL
          AND evidence_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
        INNER JOIN "Message" AS evidence_message
          ON evidence_message."chatId" = support."chatId"
          AND evidence_message."id" = support."messageId"
          AND evidence_message."role" = 'user'
        WHERE support."userId" = ${authority.userId}
          AND support."factVersionId" = ${input.factVersionId}
          AND ${memoryPersonalEvidenceRowPredicate(
            authority.userId,
            Prisma.sql`support."factVersionId"`,
            { exactVNext: true }
          )}
          AND support."evidenceFingerprint" IS NOT NULL
          AND support."sourceStartOffset" IS NOT NULL
          AND support."sourceEndOffset" IS NOT NULL
          AND support."sourceMessageContentHash" IS NOT NULL
        ORDER BY support."createdAt", support."id"
        LIMIT 50
        FOR SHARE OF support, evidence_chat, evidence_message
      `)
    : [];
  const exactMessageEvidence = messageEvidence.filter(exactEvidenceValid);
  const primaryEvidence = exactMessageEvidence[0] ?? null;
  if (row.sourceMode === "AUTOMATIC" && row.modality !== "PATTERN" && !primaryEvidence) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const synthesisRelations = row.modality === "PATTERN"
    ? await tx.$queryRaw<FactSynthesisRelationRow[]>(Prisma.sql`
        SELECT relation."pipelineVersion", relation."sourceEligibilityHash",
          relation."targetVersionId",
          target_version."displayText" AS "targetDisplayText",
          target_version."observedAt" AS "targetObservedAt",
          target_version."sourceMode"::text AS "targetSourceMode"
        FROM "MemoryFactVersionRelation" AS relation
        INNER JOIN "MemoryFactVersion" AS target_version
          ON target_version."userId" = relation."userId"
          AND target_version."id" = relation."targetVersionId"
        WHERE relation."userId" = ${authority.userId}
          AND relation."sourceVersionId" = ${input.factVersionId}
          AND relation."kind" =
            'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
        ORDER BY relation."targetVersionId"
        FOR SHARE OF relation, target_version
      `)
    : [];
  const automaticPatternSourceIds = patternSupports.flatMap((support) => {
    const relation = synthesisRelations.find(({ targetVersionId }) =>
      targetVersionId === support.factVersionId);
    return relation?.targetSourceMode === "AUTOMATIC"
      ? [support.factVersionId]
      : [];
  });
  const patternEvidence = automaticPatternSourceIds.length > 0
    ? await tx.$queryRaw<FactPatternEvidenceRow[]>(Prisma.sql`
        SELECT
          support."branchGeneration", support."chatId",
          evidence_message."content", support."sourceEndOffset" AS "endOffset",
          support."id" AS "evidenceId", support."evidenceFingerprint",
          support."observedAt" AS "evidenceObservedAt",
          support."messageId", support."safeExcerpt", support."safeSourceHash",
          support."sourceMessageContentHash", support."sourceProjectionVersion",
          support."sourceStartOffset" AS "startOffset",
          relation."targetVersionId"
        FROM "MemoryFactVersionRelation" AS relation
        INNER JOIN "MemoryEvidence" AS support
          ON support."userId" = relation."userId"
          AND support."factVersionId" = relation."targetVersionId"
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
        WHERE relation."userId" = ${authority.userId}
          AND relation."sourceVersionId" = ${input.factVersionId}
          AND relation."targetVersionId" IN (${Prisma.join(
            automaticPatternSourceIds
          )})
          AND relation."kind" =
            'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
          AND ${memoryPersonalEvidenceRowPredicate(
            authority.userId,
            Prisma.sql`relation."targetVersionId"`,
            { exactVNext: true }
          )}
        ORDER BY relation."targetVersionId", support."observedAt" DESC, support."id"
        FOR SHARE OF relation, support, evidence_chat, evidence_message
      `)
    : [];
  const exactPatternEvidence = patternEvidence.filter(exactEvidenceValid);
  const primaryPatternEvidence = new Map<string, FactPatternEvidenceRow>();
  for (const evidence of exactPatternEvidence) {
    if (!primaryPatternEvidence.has(evidence.targetVersionId)) {
      primaryPatternEvidence.set(evidence.targetVersionId, evidence);
    }
  }
  for (const support of patternSupports) {
    const relation = synthesisRelations.find(({ targetVersionId }) =>
      targetVersionId === support.factVersionId);
    const projected = relation && typeof relation.targetDisplayText === "string"
      ? safeFactProjectionText(relation.targetDisplayText)
      : null;
    const observedAt = relation?.targetObservedAt;
    const sourceAuthority = relation?.targetSourceMode === "EXPLICIT"
      ? "user_saved"
      : relation?.targetSourceMode === "AUTOMATIC"
        ? "learned_from_user"
        : null;
    const primary = relation?.targetSourceMode === "AUTOMATIC"
      ? primaryPatternEvidence.get(support.factVersionId) ?? null
      : null;
    const rootHash = relation?.targetSourceMode === "EXPLICIT"
      ? memorySha256(`explicit:${support.factVersionId}`)
      : primary
        ? memorySha256(`message:${primary.messageId}`)
        : null;
    if (!relation || !projected || !(observedAt instanceof Date) ||
      !Number.isFinite(observedAt.getTime()) || sourceAuthority === null ||
      support.observedAt !== observedAt.toISOString() ||
      support.sourceAuthority !== sourceAuthority ||
      support.textHash !== memoryPreparingTextHash(compactFactProjection(projected)) ||
      support.sourceRootHash !== rootHash) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
  }
  const synthesisRelationSnapshot = synthesisRelations.map((relation) => ({
    pipelineVersion: relation.pipelineVersion,
    sourceEligibilityHash: relation.sourceEligibilityHash,
    targetVersionId: relation.targetVersionId
  }));
  const sourceMessageIds = row.modality === "PATTERN"
    ? [...new Set(exactPatternEvidence.map(({ messageId }) => messageId))]
    : primaryEvidence
    ? exactMessageEvidence.flatMap((evidence) =>
        evidence.chatId === primaryEvidence.chatId &&
          evidence.branchGeneration === primaryEvidence.branchGeneration
          ? [evidence.messageId]
          : [])
    : [];
  const sourceSnapshot = {
    createdByEventId: row.createdByEventId,
    evidenceIds: primaryEvidence
      ? exactMessageEvidence.flatMap((evidence) =>
          evidence.chatId === primaryEvidence.chatId &&
            evidence.branchGeneration === primaryEvidence.branchGeneration
            ? [{
                endOffset: evidence.endOffset,
                evidenceFingerprint: evidence.evidenceFingerprint,
                evidenceId: evidence.evidenceId,
                sourceMessageContentHash: evidence.sourceMessageContentHash,
                sourceProjectionVersion: evidence.sourceProjectionVersion,
                startOffset: evidence.startOffset
              }]
            : [])
      : [],
    projectedTextHash: memoryPreparingTextHash(compactProjection(safeDisplayText)),
    projectionKind: projection.kind,
    schemaVersion: 3,
    patternSupportingEvidence: patternSupports,
    synthesisRelations: synthesisRelationSnapshot,
    sourceMode: row.sourceMode
  };
  const entityRoots = await factEntityRoots(
    tx,
    authority.userId,
    input.factVersionId
  );
  const dependencySnapshot = await factDependencies(
    tx,
    authority.userId,
    input.factVersionId
  );
  const versionSnapshot = {
    currentVersionId: row.currentVersionId,
    coreEligible: row.coreEligible,
    coreSalience: row.coreSalience,
    dependencySnapshot,
    factCanonicalKey: redactMemorySecrets(row.factCanonicalKey).redactedText,
    factCategory: redactMemorySecrets(row.factCategory).redactedText,
    factId: row.factId,
    factState: row.factState,
    factVersionId: input.factVersionId,
    languageCode: row.languageCode,
    entityRoots,
    expectedAt: iso(row.expectedAt),
    expiresAt: iso(row.expiresAt),
    identityKind: row.identityKind,
    mergedIntoVersionId: row.mergedIntoVersionId,
    modality: row.modality,
    movedFromVersionId: row.movedFromVersionId,
    observedAt: iso(row.observedAt),
    occurredAt: iso(row.occurredAt),
    pinned: row.pinned,
    scopeAssistantId: row.scopeAssistantId,
    scopeChatId: row.scopeChatId,
    scopeFolderId: row.scopeFolderId,
    scopeId: row.scopeId,
    scopeState: row.scopeState,
    scopeTargetIdSnapshot: row.scopeTargetIdSnapshot,
    scopeType: row.scopeType,
    schemaVersion: 3,
    sensitivityClass: row.sensitivityClass,
    systemFrom: iso(row.systemFrom),
    systemTo: iso(row.systemTo),
    supersedesVersionId: row.supersedesVersionId,
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
    recallRoundId: null,
    recallRoundSegmentId: null,
    toolEventId: null,
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
      AND ${compatibleActiveGenerationPredicate()}
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
      AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND ${memoryHistoryChunkSourceAuthorityPredicate({
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
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

async function resolveDigestRow(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  digestId: string,
  anchorChunkId: string
): Promise<DigestAuthorityRow | null> {
  if (!authority.indexGenerationId) return null;
  const [row] = await tx.$queryRaw<DigestAuthorityRow[]>(Prisma.sql`
    SELECT
      chunk."branchGeneration", chunk."chatId", chunk."contentHash",
      digest."contentHash" AS "digestContentHash", digest."id" AS "digestId",
      digest."pipelineVersion" AS "digestPipelineVersion",
      digest."safetyPolicyVersion" AS "digestSafetyPolicyVersion",
      digest."safeDigestText" AS "digestText", digest."languageCode",
      digest."redactionState"::text AS "redactionState",
      digest."safeDigestText" AS "safeText",
      digest."safetyClass"::text AS "safetyClass",
      digest."sourceAssistantId", digest."sourceFolderId",
      chunk."sourceRevisionAtCreation" AS "sourceRevision",
      digest."state"::text AS "state"
    FROM "ChatMemoryDigest" AS digest
    INNER JOIN "MemoryRecallChunk" AS chunk
      ON chunk."userId" = digest."userId" AND chunk."chatId" = digest."chatId"
      AND chunk."id" = digest."anchorChunkId"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = digest."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = ${authority.indexGenerationId}
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND ${compatibleActiveGenerationPredicate()}
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = digest."userId" AND source_chat."id" = digest."chatId"
      AND source_chat."projectId" IS NULL
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = digest."userId" AND checkpoint."chatId" = digest."chatId"
    WHERE digest."userId" = ${authority.userId}
      AND digest."id" = ${digestId}
      AND digest."anchorChunkId" = ${anchorChunkId}
      AND digest."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND digest."pipelineVersion" = ${MEMORY_CHAT_DIGEST_PIPELINE_VERSION}
      AND digest."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND digest."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND digest."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND digest."branchGeneration" = checkpoint."branchGeneration"
      AND digest."sourceRevisionAtCreation" = checkpoint."sourceRevision"
      AND digest."activeLeafMessageId" = checkpoint."activeLeafMessageId"
      AND digest."sourceContentHash" = checkpoint."sourceContentHash"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND chunk."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND chunk."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND chunk."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND ${memoryHistoryChunkSourceAuthorityPredicate({
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryChunkConversationFeedbackPredicate(
        authority.userId,
        authority.chatId
      )}
      AND ${memoryChunkSourceSafetyPredicate()}
      AND EXISTS (
        SELECT 1 FROM "ChatMemoryDigestChunk" AS digest_anchor
        WHERE digest_anchor."digestId" = digest."id"
          AND digest_anchor."chunkId" = digest."anchorChunkId"
      )
      AND EXISTS (
        SELECT 1 FROM "ChatMemoryDigestMessage" AS digest_source_message
        WHERE digest_source_message."digestId" = digest."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ChatMemoryDigestChunk" AS digest_source
        LEFT JOIN "MemoryRecallChunk" AS source_chunk
          ON source_chunk."userId" = digest_source."userId"
          AND source_chunk."chatId" = digest_source."chatId"
          AND source_chunk."id" = digest_source."chunkId"
        WHERE digest_source."digestId" = digest."id"
          AND (source_chunk."id" IS NULL
            OR source_chunk."state" <> 'ACTIVE'::"MemoryHistoryItemState"
            OR source_chunk."chunkingVersion" <> ${MEMORY_HISTORY_CHUNKING_VERSION}
            OR source_chunk."sourceProjectionVersion" <>
              ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
            OR source_chunk."safetyClass" NOT IN (
              'NORMAL'::"MemoryDerivedSafetyClass",
              'SENSITIVE'::"MemoryDerivedSafetyClass"
            )
            OR source_chunk."redactionState" = 'EXCLUDED'::"MemoryRedactionState")
      )
      AND NOT EXISTS (
        SELECT 1 FROM "ChatMemoryDigestMessage" AS digest_source_message
        LEFT JOIN "ChatMemoryCheckpointMessage" AS current_source_message
          ON current_source_message."userId" = digest_source_message."userId"
          AND current_source_message."chatId" = digest_source_message."chatId"
          AND current_source_message."messageId" = digest_source_message."messageId"
        WHERE digest_source_message."digestId" = digest."id"
          AND (current_source_message."messageId" IS NULL
            OR current_source_message."sourceMessageUpdatedAt" <>
              digest_source_message."sourceMessageUpdatedAt")
      )
    FOR SHARE OF digest, chunk, settings, generation, source_chat, checkpoint
  `);
  return row ?? null;
}

async function digestMessageIds(
  tx: PreparingItemTransaction,
  userId: string,
  digestId: string
): Promise<string[]> {
  const rows = await tx.chatMemoryDigestMessage.findMany({
    orderBy: { ordinal: "asc" },
    select: { messageId: true },
    take: MEMORY_CHAT_DIGEST_MAX_SOURCE_MESSAGES + 1,
    where: { digestId, userId }
  });
  if (rows.length === 0 ||
    rows.length > MEMORY_CHAT_DIGEST_MAX_SOURCE_MESSAGES) {
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
  const feature = record(input.featureSnapshot);
  const retrievalMode = feature?.retrievalMode;
  const laneRankKeys = Object.keys(input.laneRanks ?? {});
  const targetedDerivedDigest = retrievalMode === "PAST_CHAT_SEARCH" &&
    feature?.aggregationRequested === false && feature.derived === true &&
    feature.evidenceType === "derived_session_synopsis" &&
    (feature.retrievalReason === "fused" ||
      feature.retrievalReason === "semantic_sort") &&
    feature.sourceAuthority === "past_chat" &&
    feature.speakerScope === "derived" && laneRankKeys.length === 1 &&
    laneRankKeys[0] === "HISTORY_DIGEST_FTS_SIMPLE";
  const digestMode = retrievalMode === "HISTORY_OVERVIEW" ||
    retrievalMode === "PAST_CHAT_SEARCH" && feature?.aggregationRequested === true ||
    targetedDerivedDigest;
  if (projection.kind === "CHAT_DIGEST_SAFE_TEXT") {
    if (projection.supportingItemId === null || !digestMode) {
      throw new MemoryPreparingRunConflictError(
        "memory_attempt_item_digest_mode_invalid",
        false
      );
    }
    const row = await resolveDigestRow(
      tx,
      authority,
      projection.supportingItemId,
      input.recallChunkId
    );
    if (!row || !exactTextContainsProjection(input.exactSafeText, row.digestText)) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
    const sourceMessageIds = await digestMessageIds(
      tx,
      authority.userId,
      row.digestId
    );
    const snapshots = historySnapshots(
      row,
      projection.kind,
      sourceMessageIds,
      row.digestId
    );
    return {
      ...commonResolved(input, projection.kind),
      ...snapshots,
      exactItemId: input.recallChunkId,
      factVersionId: null,
      featureSnapshot: {
        ...commonResolved(input, projection.kind).featureSnapshot,
        supportingItemId: row.digestId
      },
      itemStateAtAdmission: row.state,
      itemType: "RECALL_CHUNK",
      recallChunkId: input.recallChunkId,
      recallRoundId: null,
      recallRoundSegmentId: null,
      toolEventId: null,
      sourceBranchGenerationSnapshot: row.branchGeneration,
      sourceChatIdSnapshot: row.chatId,
      sourceContentHashSnapshot: row.contentHash,
      sourceMessageIdsSnapshot: sourceMessageIds,
      sourceRevisionSnapshot: row.sourceRevision,
      sourceSnapshot: {
        ...snapshots.sourceSnapshot,
        digestContentHash: row.digestContentHash,
        digestId: row.digestId,
        schemaVersion: 3
      },
      versionSnapshot: {
        ...snapshots.versionSnapshot,
        digestPipelineVersion: row.digestPipelineVersion,
        digestSafetyPolicyVersion: row.digestSafetyPolicyVersion,
        schemaVersion: 3
      }
    };
  }
  if (projection.kind !== "RECALL_CHUNK_SAFE_PROJECTED_TEXT" ||
    projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_chunk_projection_invalid",
      false
    );
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
    recallRoundId: null,
    recallRoundSegmentId: null,
    toolEventId: null,
    sourceBranchGenerationSnapshot: row.branchGeneration,
    sourceChatIdSnapshot: row.chatId,
    sourceContentHashSnapshot: row.contentHash,
    sourceMessageIdsSnapshot: sourceMessageIds,
    sourceRevisionSnapshot: row.sourceRevision
  };
}

async function resolveRoundRow(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  roundId: string
): Promise<RoundAuthorityRow | null> {
  if (!authority.indexGenerationId) return null;
  const [row] = await tx.$queryRaw<RoundAuthorityRow[]>(Prisma.sql`
    SELECT
      round."branchGeneration", round."chatId", round."contentHash",
      round."contextualKeyPolicyVersion", round."contextualKeyState",
      round."contextualNarrativeText", round."supportingRoundIds",
      round."evidenceRootHash", round."languageCode", round."parentChunkId",
      round."projectionVersion", round."rawSafeText" AS "safeText",
      round."redactionState"::text AS "redactionState",
      round."safetyClass"::text AS "safetyClass",
      round."sourceAssistantId", round."sourceFolderId",
      round."sourceRevisionAtCreation" AS "sourceRevision",
      round."state"::text AS "state"
    FROM "MemoryRecallRound" AS round
    INNER JOIN "MemoryRecallChunk" AS parent
      ON parent."userId" = round."userId"
      AND parent."id" = round."parentChunkId"
      AND parent."chatId" = round."chatId"
      AND parent."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND parent."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND parent."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND parent."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND parent."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
    INNER JOIN "MemorySearchEntry" AS entry
      ON entry."userId" = round."userId"
      AND entry."indexGenerationId" = ${authority.indexGenerationId}
      AND entry."recallRoundId" = round."id"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = entry."indexGenerationId"
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND ${compatibleActiveGenerationPredicate()}
      AND generation."roundProjectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND generation."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND (generation."roundSegmentProjectionVersion" IS NULL OR
        generation."roundSegmentProjectionVersion" =
          ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION})
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = round."userId" AND source_chat."id" = round."chatId"
      AND source_chat."projectId" IS NULL
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = round."userId" AND checkpoint."chatId" = round."chatId"
    WHERE round."userId" = ${authority.userId}
      AND round."id" = ${roundId}
      AND round."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND round."projectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND round."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND round."contextualKeyState" IN ('GENERATED', 'RAW_FALLBACK')
      AND round."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND round."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND (
        generation."roundSegmentProjectionVersion" IS NULL
        AND entry."itemType" = 'RECALL_ROUND'::"MemorySearchItemType"
        AND entry."recallRoundSegmentId" IS NULL
        AND entry."safeContentHash" = round."contextualSearchHash"
        OR generation."roundSegmentProjectionVersion" =
          ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
        AND entry."itemType" = 'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
        AND EXISTS (
          SELECT 1
          FROM "MemoryRecallRoundSegment" AS authority_segment
          WHERE authority_segment."userId" = entry."userId"
            AND authority_segment."id" = entry."recallRoundSegmentId"
            AND authority_segment."roundId" = round."id"
            AND entry."safeContentHash" = authority_segment."contextualSearchHash"
            AND authority_segment."state" = 'ACTIVE'::"MemoryHistoryItemState"
            AND authority_segment."projectionVersion" =
              ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
            AND authority_segment."contextualKeyPolicyVersion" =
              ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
            AND authority_segment."contextualKeyPolicyVersion" =
              round."contextualKeyPolicyVersion"
            AND authority_segment."supportingRoundIds" = round."supportingRoundIds"
            AND authority_segment."contextualKeyState" IN ('GENERATED', 'RAW_FALLBACK')
            AND (authority_segment."contextualKeyState" <> 'GENERATED'
              OR round."contextualKeyState" = 'GENERATED')
            AND authority_segment."sourceRevisionAtCreation" =
              round."sourceRevisionAtCreation"
            AND authority_segment."evidenceRootHash" = round."evidenceRootHash"
            AND authority_segment."redactionState" <>
              'EXCLUDED'::"MemoryRedactionState"
            AND authority_segment."safetyClass" IN (
              'NORMAL'::"MemoryDerivedSafetyClass",
              'SENSITIVE'::"MemoryDerivedSafetyClass"
            )
        )
      )
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND ${memoryHistoryRoundSourceAuthorityPredicate({
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryRoundConversationFeedbackPredicate(
        authority.userId,
        authority.chatId
      )}
      AND ${memoryRoundSourceSafetyPredicate()}
      AND round."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
    FOR SHARE OF round, parent, entry, settings, generation, source_chat, checkpoint
  `);
  return row ?? null;
}

async function resolveRoundSegmentRow(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  roundId: string,
  segmentId: string
): Promise<RoundSegmentAuthorityRow | null> {
  if (!authority.indexGenerationId) return null;
  const [row] = await tx.$queryRaw<RoundSegmentAuthorityRow[]>(Prisma.sql`
    SELECT
      round."branchGeneration", round."chatId", round."contentHash",
      segment."contextualKeyPolicyVersion", segment."contextualKeyState",
      segment."contextualNarrativeText", segment."supportingRoundIds",
      segment."evidenceRootHash", segment."languageCode", round."parentChunkId",
      round."projectionVersion", round."rawSafeText" AS "parentRawSafeText",
      segment."rawSafeText" AS "safeText",
      segment."redactionState"::text AS "redactionState",
      segment."safetyClass"::text AS "safetyClass",
      round."sourceAssistantId", round."sourceFolderId",
      round."sourceRevisionAtCreation" AS "sourceRevision",
      segment."sourceRevisionAtCreation" AS "segmentSourceRevision",
      segment."state"::text AS "state",
      segment."id" AS "segmentId", segment."position" AS "segmentPosition",
      segment."projectionVersion" AS "segmentProjectionVersion",
      segment."rawStartOffsetUtf16", segment."rawEndOffsetUtf16",
      segment."rawSafeTextHash"
    FROM "MemoryRecallRoundSegment" AS segment
    INNER JOIN "MemoryRecallRound" AS round
      ON round."userId" = segment."userId" AND round."id" = segment."roundId"
    INNER JOIN "MemoryRecallChunk" AS parent
      ON parent."userId" = round."userId"
      AND parent."id" = round."parentChunkId"
      AND parent."chatId" = round."chatId"
      AND parent."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND parent."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND parent."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND parent."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND parent."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
    INNER JOIN "MemorySearchEntry" AS entry
      ON entry."userId" = segment."userId"
      AND entry."indexGenerationId" = ${authority.indexGenerationId}
      AND entry."itemType" = 'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
      AND entry."recallRoundId" = round."id"
      AND entry."recallRoundSegmentId" = segment."id"
      AND entry."safeContentHash" = segment."contextualSearchHash"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = entry."userId"
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = entry."indexGenerationId"
    INNER JOIN "MemoryIndexGeneration" AS generation
      ON generation."userId" = settings."userId"
      AND generation."id" = settings."activeIndexGenerationId"
      AND generation."state" = 'ACTIVE'::"MemoryIndexGenerationState"
      AND ${compatibleActiveGenerationPredicate()}
      AND generation."roundProjectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND generation."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND generation."roundSegmentProjectionVersion" =
        ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = round."userId" AND source_chat."id" = round."chatId"
      AND source_chat."projectId" IS NULL
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = round."userId" AND checkpoint."chatId" = round."chatId"
    WHERE segment."userId" = ${authority.userId}
      AND segment."id" = ${segmentId}
      AND segment."roundId" = ${roundId}
      AND segment."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND segment."projectionVersion" =
        ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
      AND segment."contextualKeyPolicyVersion" =
        ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND segment."contextualKeyPolicyVersion" = round."contextualKeyPolicyVersion"
      AND segment."supportingRoundIds" = round."supportingRoundIds"
      AND segment."contextualKeyState" IN ('GENERATED', 'RAW_FALLBACK')
      AND (segment."contextualKeyState" <> 'GENERATED'
        OR round."contextualKeyState" = 'GENERATED')
      AND segment."sourceRevisionAtCreation" = round."sourceRevisionAtCreation"
      AND segment."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND segment."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND segment."evidenceRootHash" = round."evidenceRootHash"
      AND round."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND round."projectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND round."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND round."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND round."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND round."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND checkpoint."activeLeafMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."lastIndexedMessageId" = source_chat."activeLeafMessageId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND ${memoryHistoryRoundSourceAuthorityPredicate({
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryRoundConversationFeedbackPredicate(
        authority.userId,
        authority.chatId
      )}
      AND ${memoryRoundSourceSafetyPredicate()}
    FOR SHARE OF segment, round, parent, entry, settings, generation,
      source_chat, checkpoint
  `);
  return row ?? null;
}

async function roundMessageIds(
  tx: PreparingItemTransaction,
  userId: string,
  roundId: string
): Promise<string[]> {
  const rows = await tx.memoryRecallRoundMessage.findMany({
    orderBy: { ordinal: "asc" },
    select: { messageId: true },
    take: 51,
    where: { roundId, userId }
  });
  if (rows.length === 0 || rows.length > 50) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  return rows.map(({ messageId }) => messageId);
}

async function roundSegmentMessageIds(
  tx: PreparingItemTransaction,
  userId: string,
  segmentId: string
): Promise<string[]> {
  const rows = await tx.memoryRecallRoundSegmentMessage.findMany({
    orderBy: { ordinal: "asc" },
    select: { messageId: true },
    take: 51,
    where: { segmentId, userId }
  });
  if (rows.length === 0 || rows.length > 50) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  return rows.map(({ messageId }) => messageId);
}

type ContextualDependencySnapshot = Readonly<{
  evidenceHashes: readonly string[];
  retrievalHintHash: string | null;
  roundIds: readonly string[];
}>;

function contextualDependencySnapshot(
  input: MemoryPreparingItemInput
): ContextualDependencySnapshot {
  const feature = record(input.featureSnapshot) ?? {};
  const retrievalHintHash = feature.contextualRetrievalHintHash ?? null;
  const roundIds = feature.contextualSupportingRoundIds ?? [];
  const evidenceHashes = feature.contextualSupportingEvidenceHashes ?? [];
  const hashPattern = /^[a-f0-9]{64}$/u;
  if ((retrievalHintHash !== null && (
    typeof retrievalHintHash !== "string" || !hashPattern.test(retrievalHintHash)
  )) || !Array.isArray(roundIds) || !Array.isArray(evidenceHashes) ||
    roundIds.length > 2 || roundIds.length !== evidenceHashes.length ||
    new Set(roundIds).size !== roundIds.length ||
    roundIds.some((id) => typeof id !== "string" || !hashPattern.test(id)) ||
    evidenceHashes.some((hash) => typeof hash !== "string" || !hashPattern.test(hash)) ||
    retrievalHintHash === null && roundIds.length > 0) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_contextual_dependency_invalid",
      false
    );
  }
  return {
    evidenceHashes: evidenceHashes as string[],
    retrievalHintHash: retrievalHintHash as string | null,
    roundIds: roundIds as string[]
  };
}

type ContextualDependencyAuthorityRow = Readonly<{
  id: string;
  rawSafeText: string;
}>;

async function resolveContextualDependencyRows(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  currentRoundId: string,
  sourceChatId: string,
  roundIds: readonly string[]
): Promise<readonly ContextualDependencyAuthorityRow[]> {
  if (roundIds.length === 0) return [];
  if (!authority.indexGenerationId) return [];
  return tx.$queryRaw<ContextualDependencyAuthorityRow[]>(Prisma.sql`
    SELECT round."id", round."rawSafeText"
    FROM "MemoryRecallRound" AS round
    INNER JOIN "MemoryRecallRound" AS current_round
      ON current_round."userId" = round."userId"
      AND current_round."chatId" = round."chatId"
      AND current_round."id" = ${currentRoundId}
      AND round."roundOrdinal" < current_round."roundOrdinal"
    INNER JOIN "MemoryRecallChunk" AS parent
      ON parent."userId" = round."userId"
      AND parent."id" = round."parentChunkId"
      AND parent."chatId" = round."chatId"
      AND parent."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND parent."chunkingVersion" = ${MEMORY_HISTORY_CHUNKING_VERSION}
      AND parent."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND parent."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND parent."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = round."userId"
      AND source_chat."id" = round."chatId"
      AND source_chat."projectId" IS NULL
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = round."userId"
      AND checkpoint."chatId" = round."chatId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
    WHERE round."userId" = ${authority.userId}
      AND round."chatId" = ${sourceChatId}
      AND round."id" IN (${Prisma.join(roundIds)})
      AND round."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND round."projectionVersion" = ${MEMORY_RECALL_ROUND_PROJECTION_VERSION}
      AND round."contextualKeyPolicyVersion" = ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
      AND round."sourceProjectionVersion" = ${MEMORY_HISTORY_SOURCE_PROJECTION_VERSION}
      AND round."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND round."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND ${memoryHistoryRoundSourceAuthorityPredicate({
        chat: "source_chat",
        checkpoint: "checkpoint"
      })}
      AND ${memoryRoundConversationFeedbackPredicate(
        authority.userId,
        authority.chatId
      )}
      AND ${memoryRoundSourceSafetyPredicate()}
      AND EXISTS (
        SELECT 1
        FROM "MemorySearchEntry" AS dependency_entry
        INNER JOIN "MemoryRecallRoundSegment" AS dependency_segment
          ON dependency_segment."userId" = dependency_entry."userId"
          AND dependency_segment."roundId" = dependency_entry."recallRoundId"
          AND dependency_segment."id" = dependency_entry."recallRoundSegmentId"
          AND dependency_segment."state" = 'ACTIVE'::"MemoryHistoryItemState"
          AND dependency_segment."evidenceRootHash" = round."evidenceRootHash"
          AND dependency_segment."sourceRevisionAtCreation" =
            round."sourceRevisionAtCreation"
          AND dependency_segment."contextualKeyPolicyVersion" =
            ${MEMORY_CONTEXTUAL_KEY_POLICY_VERSION}
          AND dependency_segment."projectionVersion" =
            ${MEMORY_RECALL_ROUND_SEGMENT_PROJECTION_VERSION}
          AND dependency_segment."redactionState" <>
            'EXCLUDED'::"MemoryRedactionState"
          AND dependency_segment."safetyClass" IN (
            'NORMAL'::"MemoryDerivedSafetyClass",
            'SENSITIVE'::"MemoryDerivedSafetyClass"
          )
        WHERE dependency_entry."userId" = round."userId"
          AND dependency_entry."indexGenerationId" = ${authority.indexGenerationId}
          AND dependency_entry."itemType" =
            'RECALL_ROUND_SEGMENT'::"MemorySearchItemType"
          AND dependency_entry."recallRoundId" = round."id"
          AND dependency_entry."safeContentHash" =
            dependency_segment."contextualSearchHash"
      )
    FOR SHARE OF round, parent, source_chat, checkpoint
  `);
}

async function resolveRound(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  input: MemoryPreparingItemInput & Readonly<{
    recallRoundId: string;
    recallRoundSegmentId?: string | null;
  }>
): Promise<ResolvedPreparingMemoryItem> {
  const projection = itemProjection(input);
  const segmentId = input.recallRoundSegmentId ?? null;
  if (projection.supportingItemId === null ||
    (segmentId === null && projection.kind !== "RECALL_ROUND_RAW_SAFE_TEXT") ||
    (segmentId !== null &&
      projection.kind !== "RECALL_ROUND_SEGMENT_RAW_SAFE_TEXT")) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_round_projection_invalid",
      false
    );
  }
  const row = segmentId
    ? await resolveRoundSegmentRow(tx, authority, input.recallRoundId, segmentId)
    : await resolveRoundRow(tx, authority, input.recallRoundId);
  const boundedRawSafeText = row
    ? segmentId ? row.safeText : boundedMemoryRecallRoundEvidenceText(row.safeText)
    : null;
  const authoritativeExactSafeText = boundedRawSafeText === null
    ? null
    : canonicalMemoryPackedSafeText("RECALL_ROUND", boundedRawSafeText);
  if (!row || projection.supportingItemId !== row.parentChunkId ||
    input.exactSafeText !== authoritativeExactSafeText ||
    segmentId !== null &&
      (!isRoundSegmentAuthorityRow(row) || row.segmentId !== segmentId ||
        !exactRoundSegmentAuthority(row))) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  const dependencySnapshot = contextualDependencySnapshot(input);
  if (dependencySnapshot.retrievalHintHash !== null) {
    if (row.contextualKeyState !== "GENERATED" ||
      memorySha256(row.contextualNarrativeText) !==
        dependencySnapshot.retrievalHintHash ||
      JSON.stringify(row.supportingRoundIds) !==
        JSON.stringify(dependencySnapshot.roundIds)) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
    const dependencies = await resolveContextualDependencyRows(
      tx,
      authority,
      input.recallRoundId,
      row.chatId,
      dependencySnapshot.roundIds
    );
    const dependencyById = new Map(dependencies.map((dependency) => [
      dependency.id,
      dependency
    ]));
    if (dependencies.length !== dependencySnapshot.roundIds.length ||
      dependencySnapshot.roundIds.some((roundId, index) => {
        const dependency = dependencyById.get(roundId);
        return !dependency || memorySha256(boundedMemoryRecallRoundEvidenceText(
          dependency.rawSafeText
        )) !== dependencySnapshot.evidenceHashes[index];
      })) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
    }
  }
  const sourceMessageIds = segmentId
    ? await roundSegmentMessageIds(tx, authority.userId, segmentId)
    : await roundMessageIds(tx, authority.userId, input.recallRoundId);
  const snapshots = historySnapshots(row, projection.kind, sourceMessageIds, row.parentChunkId);
  return {
    ...commonResolved(input, projection.kind),
    ...snapshots,
    exactItemId: input.recallRoundId,
    factVersionId: null,
    itemStateAtAdmission: row.state,
    itemType: "RECALL_ROUND",
    recallChunkId: null,
    recallRoundId: input.recallRoundId,
    recallRoundSegmentId: segmentId,
    toolEventId: null,
    sourceBranchGenerationSnapshot: row.branchGeneration,
    sourceChatIdSnapshot: row.chatId,
    sourceContentHashSnapshot: row.contentHash,
    sourceMessageIdsSnapshot: sourceMessageIds,
    sourceRevisionSnapshot: row.sourceRevision,
    sourceSnapshot: {
      ...snapshots.sourceSnapshot,
      evidenceRootHash: row.evidenceRootHash,
      parentChunkId: row.parentChunkId,
      ...(segmentId ? { segmentId } : {}),
      schemaVersion: 3
    },
    versionSnapshot: {
      ...snapshots.versionSnapshot,
      contextualKeyPolicyVersion: row.contextualKeyPolicyVersion,
      contextualKeyState: row.contextualKeyState,
      projectionVersion: row.projectionVersion,
      ...(isRoundSegmentAuthorityRow(row) ? {
        rawEndOffsetUtf16: row.rawEndOffsetUtf16,
        rawSafeTextHash: row.rawSafeTextHash,
        rawStartOffsetUtf16: row.rawStartOffsetUtf16,
        segmentPosition: row.segmentPosition,
        segmentProjectionVersion: row.segmentProjectionVersion
      } : {}),
      schemaVersion: 3
    }
  };
}

async function resolveToolEventRow(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  toolEventId: string
): Promise<ToolEventAuthorityRow | null> {
  if (!authority.indexGenerationId) return null;
  const [row] = await tx.$queryRaw<ToolEventAuthorityRow[]>(Prisma.sql`
    SELECT tool_event."assistantMessageId", tool_event."branchGeneration",
      tool_event."chatId", tool_event."contentHash", tool_event."evidenceRootHash",
      tool_event."languageCode", tool_event."occurredAt", tool_event."operation",
      tool_event."outcome"::text AS "outcome",
      tool_event."projectionVersion", tool_event."redactionState"::text AS "redactionState",
      tool_event."safeProjectedText" AS "safeText",
      tool_event."safetyClass"::text AS "safetyClass",
      tool_event."sourceAssistantId", tool_event."sourceFolderId",
      tool_event."sourceCallUpdatedAtAtCreation" AS "sourceCallUpdatedAt",
      tool_event."sourcePayloadHash",
      tool_event."sourceRevisionAtCreation" AS "sourceRevision",
      tool_event."state"::text AS "state", tool_event."toolName"
    FROM "MemoryToolEvent" AS tool_event
    INNER JOIN "MemorySearchEntry" AS entry
      ON entry."userId" = tool_event."userId"
      AND entry."toolEventId" = tool_event."id"
      AND entry."itemType" = 'TOOL_EVENT'::"MemorySearchItemType"
      AND entry."indexGenerationId" = ${authority.indexGenerationId}
      AND entry."safeContentHash" = tool_event."contentHash"
    INNER JOIN "UserMemorySettings" AS settings
      ON settings."userId" = tool_event."userId"
      AND settings."useMemoryFacts" = TRUE
      AND settings."referenceChatHistory" = TRUE
      AND settings."activeIndexGenerationId" = entry."indexGenerationId"
    INNER JOIN "Chat" AS source_chat
      ON source_chat."userId" = tool_event."userId"
      AND source_chat."id" = tool_event."chatId"
      AND source_chat."projectId" IS NULL
      AND source_chat."memoryMode" = 'NORMAL'::"MemoryChatMode"
      AND source_chat."permanentDeletionAt" IS NULL
    INNER JOIN "ChatMemoryCheckpoint" AS checkpoint
      ON checkpoint."userId" = tool_event."userId"
      AND checkpoint."chatId" = tool_event."chatId"
      AND checkpoint."status" = 'READY'::"MemoryHistoryCheckpointStatus"
      AND checkpoint."pipelineVersion" = ${MEMORY_HISTORY_INDEX_PIPELINE_VERSION}
      AND checkpoint."branchGeneration" = tool_event."branchGeneration"
      AND checkpoint."sourceRevision" = tool_event."sourceRevisionAtCreation"
      AND checkpoint."lastIndexedMessageId" = checkpoint."activeLeafMessageId"
    INNER JOIN "ChatMemoryCheckpointMessage" AS checkpoint_message
      ON checkpoint_message."userId" = tool_event."userId"
      AND checkpoint_message."chatId" = tool_event."chatId"
      AND checkpoint_message."messageId" = tool_event."assistantMessageId"
    INNER JOIN "Message" AS source_message
      ON source_message."chatId" = tool_event."chatId"
      AND source_message."id" = tool_event."assistantMessageId"
      AND source_message."updatedAt" = checkpoint_message."sourceMessageUpdatedAt"
    INNER JOIN "ModelRun" AS source_run
      ON source_run."userId" = tool_event."userId"
      AND source_run."id" = tool_event."modelRunId"
      AND source_run."chatId" = tool_event."chatId"
      AND source_run."assistantMessageId" = tool_event."assistantMessageId"
      AND source_run."status" = 'complete'::"ModelRunStatus"
    INNER JOIN "ModelRunToolCall" AS source_call
      ON source_call."modelRunId" = tool_event."modelRunId"
      AND source_call."id" = tool_event."modelRunToolCallId"
      AND source_call."state" IN (
        'complete'::"ModelRunToolCallState", 'error'::"ModelRunToolCallState"
      )
      AND source_call."completedAt" = tool_event."occurredAt"
      AND source_call."updatedAt" = tool_event."sourceCallUpdatedAtAtCreation"
    WHERE tool_event."userId" = ${authority.userId}
      AND tool_event."id" = ${toolEventId}
      AND tool_event."state" = 'ACTIVE'::"MemoryHistoryItemState"
      AND tool_event."projectionVersion" = ${MEMORY_TOOL_EVENT_PROJECTION_VERSION}
      AND tool_event."redactionState" <> 'EXCLUDED'::"MemoryRedactionState"
      AND tool_event."safetyClass" IN (
        'NORMAL'::"MemoryDerivedSafetyClass", 'SENSITIVE'::"MemoryDerivedSafetyClass"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "MemorySuppression" AS suppression
        WHERE suppression."userId" = tool_event."userId"
          AND (suppression."expiresAt" IS NULL
            OR suppression."expiresAt" > CURRENT_TIMESTAMP)
          AND (suppression."scope" = 'ALL'::"MemorySuppressionScope" OR (
            suppression."scope" = 'SOURCE_MESSAGE'::"MemorySuppressionScope"
            AND suppression."sourceChatId" = tool_event."chatId"
            AND suppression."sourceMessageId" = tool_event."assistantMessageId"
          ))
      )
    FOR SHARE OF tool_event, entry, settings, source_chat, checkpoint,
      source_message, source_run, source_call
  `);
  return row ?? null;
}

async function resolveToolEvent(
  tx: PreparingItemTransaction,
  authority: PreparingMemoryItemAuthority,
  input: MemoryPreparingItemInput & Readonly<{ toolEventId: string }>
): Promise<ResolvedPreparingMemoryItem> {
  const projection = itemProjection(input);
  if (projection.kind !== "TOOL_EVENT_SAFE_TEXT" ||
    projection.supportingItemId !== null) {
    throw new MemoryPreparingRunConflictError(
      "memory_attempt_item_tool_projection_invalid",
      false
    );
  }
  const row = await resolveToolEventRow(tx, authority, input.toolEventId);
  if (!row || input.exactSafeText !==
      canonicalMemoryPackedSafeText("TOOL_EVENT", row.safeText)) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_stale", true);
  }
  return {
    ...commonResolved(input, projection.kind),
    exactItemId: input.toolEventId,
    factVersionId: null,
    itemStateAtAdmission: row.state,
    itemType: "TOOL_EVENT",
    recallChunkId: null,
    recallRoundId: null,
    recallRoundSegmentId: null,
    sourceBranchGenerationSnapshot: row.branchGeneration,
    sourceChatIdSnapshot: row.chatId,
    sourceContentHashSnapshot: row.contentHash,
    sourceMessageIdsSnapshot: [row.assistantMessageId],
    sourceRevisionSnapshot: row.sourceRevision,
    sourceSnapshot: {
      assistantMessageId: row.assistantMessageId,
      evidenceRootHash: row.evidenceRootHash,
      projectedTextHash: memoryPreparingTextHash(row.safeText),
      projectionKind: projection.kind,
      schemaVersion: 1,
      sourceAssistantId: row.sourceAssistantId,
      sourceFolderId: row.sourceFolderId,
      sourceMessageIds: [row.assistantMessageId],
      sourceMode: "TOOL_OBSERVATION",
      supportingItemId: null
    },
    toolEventId: input.toolEventId,
    versionSnapshot: {
      languageCode: row.languageCode,
      occurredAt: row.occurredAt.toISOString(),
      operation: row.operation,
      outcome: row.outcome,
      projectionVersion: row.projectionVersion,
      redactionState: row.redactionState,
      safetyClass: row.safetyClass,
      schemaVersion: 1,
      sourceCallUpdatedAt: row.sourceCallUpdatedAt.toISOString(),
      sourcePayloadHash: row.sourcePayloadHash,
      state: row.state,
      toolName: row.toolName
    }
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
    throw new MemoryPreparingRunConflictError("memory_attempt_item_target_invalid", false);
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
  if (target.itemType === "RECALL_ROUND" && target.recallRoundId) {
    return resolveRound(tx, authority, {
      ...input,
      exactItemId: target.exactItemId,
      itemType: "RECALL_ROUND",
      recallRoundId: target.recallRoundId,
      recallRoundSegmentId: target.recallRoundSegmentId
    });
  }
  if (target.itemType === "TOOL_EVENT" && target.toolEventId) {
    return resolveToolEvent(tx, authority, {
      ...input,
      exactItemId: target.exactItemId,
      itemType: "TOOL_EVENT",
      toolEventId: target.toolEventId
    });
  }
  throw new MemoryPreparingRunConflictError("memory_attempt_item_target_invalid", false);
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
