import { Prisma } from "@prisma/client";
import type { MemorySafeProjectionKind } from "../../domain/memory/retrieval";
import {
  memoryActiveSuppressionPredicate,
  memoryChunkSourceSafetyPredicate,
  memoryFactScopePredicate
} from "../memory/retrieval/localRepository";
import {
  memoryExactMessageEvidenceIsCurrent,
  memoryPersonalEvidenceRowPredicate
} from "../memory/persistence/eligibility";
import { memoryReusableFactAuthorityPredicate } from
  "../memory/synthesis/eligibility";
import {
  memoryChunkConversationFeedbackPredicate,
  memoryFactConversationFeedbackPredicate
} from "../memory/persistence/feedback";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../memory/history/chunking";
import {
  MEMORY_CHAT_DIGEST_MAX_SOURCE_MESSAGES,
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION
} from "../memory/history/contract";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../memory/history/sourceProjection";
import {
  memoryRedactionHasMeaningfulRemainder,
  redactMemorySecrets
} from "../memory/explicit/safety";
import { memoryHistoryChunkSourceAuthorityPredicate } from
  "../memory/persistence/pauseIntervals";
import {
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
  targetVersionId: string;
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
    kind !== "CHAT_DIGEST_SAFE_TEXT" &&
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
  ) throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
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
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
  }
  const feature = record(input.featureSnapshot);
  const core = feature?.tier === "CORE";
  const retrieval = factRetrievalContract(feature, core);
  const direct = !core && feature?.directFactAuthority === true;
  if (!core && feature?.directFactAuthority !== true &&
    feature?.directFactAuthority !== false) {
    throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
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
          relation."targetVersionId"
        FROM "MemoryFactVersionRelation" AS relation
        WHERE relation."userId" = ${authority.userId}
          AND relation."sourceVersionId" = ${input.factVersionId}
          AND relation."kind" =
            'SYNTHESIZED_FROM'::"MemoryFactVersionRelationKind"
        ORDER BY relation."targetVersionId"
        FOR SHARE OF relation
      `)
    : [];
  const sourceMessageIds = primaryEvidence
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
    synthesisRelations,
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
  const digestMode = retrievalMode === "HISTORY_OVERVIEW" ||
    retrievalMode === "PAST_CHAT_SEARCH" && feature?.aggregationRequested === true;
  if (projection.kind === "CHAT_DIGEST_SAFE_TEXT") {
    if (projection.supportingItemId === null || !digestMode) {
      throw new MemoryPreparingRunConflictError("memory_attempt_item_invalid", false);
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
    projection.supportingItemId !== null || digestMode) {
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
