import { Prisma } from "@prisma/client";
import { projectMemoryHistorySafeText } from "../history/safety";
import type {
  MemoryFactCandidateEvidenceSnapshot,
  MemoryFactCandidateScope,
  MemoryFactCandidateSnapshot,
  MemoryFactConsolidationInput
} from "../learning/consolidation/contract";
import {
  memoryFactConsolidationInputHash,
  memoryFactRelatedSnapshotHash
} from "../learning/consolidation/contract";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION } from "../learning/extraction/contract";
import {
  inspectMemoryFactSourceSafety,
  memoryFactCandidateSensitivityAllowed
} from "../learning/extraction/safety";
import { memorySha256, memoryStableJson, normalizeMemorySearchText } from "../persistence/lexical";
import { findMatchingMemorySuppressions } from "../persistence/suppressions";
import type {
  LockedMemorySettings,
  MemoryTransaction
} from "../persistence/transaction";
import { loadMemorySourceSnapshot } from "../sourceState";
import type { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  memoryGlobalDreamResultHash,
  type MemoryGlobalDreamSemanticSelection
} from "./contract";
import { prepareGlobalDreamTargetContext } from "./selection";

const categoryPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const canonicalKeyPattern = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const languageCodePattern = /^(mixed|und|[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*)$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const modalities = new Set<MemoryFactCandidateSnapshot["modality"]>([
  "CONSIDERATION",
  "CONSTRAINT",
  "EVENT",
  "HABIT",
  "INTENTION",
  "PLAN",
  "PREFERENCE",
  "STATE",
  "WORKFLOW"
]);

type DeferredCandidateRow = Readonly<{
  branchGeneration: number;
  chatId: string;
  confidence: number | null;
  contentPurgedAt: Date | null;
  createdAt: Date;
  createdByExecutionId: string;
  id: string;
  importance: number | null;
  jobId: string;
  languageCode: string | null;
  negated: boolean | null;
  pipelineVersion: string;
  proposedCanonicalKey: string | null;
  proposedCategory: string | null;
  proposedDirectness: string | null;
  proposedDisplayText: string | null;
  proposedModality: string | null;
  proposedScope: Prisma.JsonValue | null;
  proposedSensitivity: string | null;
  proposedValidFrom: Date | null;
  proposedValidTo: Date | null;
  proposedValue: Prisma.JsonValue | null;
  rawTemporalExpression: string | null;
  reasonCode: string | null;
  sourceHash: string;
  sourceProjectionHash: string;
  sourceProjectionVersion: string;
  sourceRevision: number;
  sourceTimezone: string | null;
  state: string;
  temporalResolutionEvidence: Prisma.JsonValue | null;
  temporalResolverVersion: string | null;
  userId: string;
}>;

type CandidateEvidenceRow = Readonly<{
  content: Prisma.JsonValue;
  createdAt: Date;
  endOffset: number;
  messageId: string;
  ordinal: number;
  role: string;
  sourceTextHash: string;
  startOffset: number;
  status: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directText(value: Prisma.JsonValue): string | null {
  if (!isRecord(value) || !Array.isArray(value.blocks) || value.blocks.length > 128) {
    return null;
  }
  const parts: string[] = [];
  for (const block of value.blocks) {
    if (!isRecord(block)) return null;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }
    if (
      (block.type === "file" || block.type === "image") &&
      typeof block.attachmentId === "string" && block.attachmentId.length > 0
    ) continue;
    return null;
  }
  return parts.join("\n");
}

function exactScope(value: Prisma.JsonValue | null): MemoryFactCandidateScope | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "target_id,type") {
    return null;
  }
  if (value.type === "GLOBAL_USER" && value.target_id === null) {
    return { targetId: null, type: "GLOBAL_USER" };
  }
  if (
    (value.type === "ASSISTANT" || value.type === "CHAT" || value.type === "FOLDER") &&
    typeof value.target_id === "string" && value.target_id.length > 0 &&
    value.target_id.length <= 256 && !/\s/u.test(value.target_id)
  ) return { targetId: value.target_id, type: value.type };
  return null;
}

function temporalEvidence(
  value: Prisma.JsonValue | null
): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

async function scopeAvailable(
  tx: MemoryTransaction,
  row: DeferredCandidateRow,
  scope: MemoryFactCandidateScope
): Promise<boolean> {
  if (scope.type === "GLOBAL_USER") return true;
  if (scope.type === "CHAT") return scope.targetId === row.chatId;
  if (scope.type === "FOLDER") {
    const chat = await tx.chat.findFirst({
      select: { folderId: true },
      where: { id: row.chatId, userId: row.userId }
    });
    return chat?.folderId === scope.targetId;
  }
  const assistant = await tx.assistantDefinition.findFirst({
    select: { id: true },
    where: { archivedAt: null, id: scope.targetId, ownerUserId: row.userId }
  });
  return assistant?.id === scope.targetId;
}

async function candidateProvenanceCurrent(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  row: DeferredCandidateRow
): Promise<Awaited<ReturnType<typeof loadMemorySourceSnapshot>> | null> {
  if (!settings.learnAutomatically) return null;
  const sourceJob = await tx.memoryJob.findFirst({
      select: { activeLeafMessageId: true },
      where: {
        branchGeneration: row.branchGeneration,
        chatId: row.chatId,
        id: row.jobId,
        kind: "EXTRACT_FACTS",
        sourceHash: row.sourceHash,
        sourceRevision: row.sourceRevision,
        state: "SUCCEEDED",
        userId: row.userId
      }
    });
  const execution = await tx.memoryExecutionBinding.findFirst({
      select: { id: true },
      where: {
        id: row.createdByExecutionId,
        logicalRole: "MEMORY_FACT_EXTRACT",
        memoryJobId: row.jobId,
        ownerType: "JOB",
        state: "SUCCEEDED",
        userId: row.userId
      }
    });
  const decision = await tx.memoryCandidateDecision.findFirst({
      select: { id: true },
      where: { candidateId: row.id, userId: row.userId }
    });
  if (!sourceJob?.activeLeafMessageId || !execution || decision) return null;
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: row.chatId,
    lock: "SHARE",
    userId: row.userId
  });
  return source && source.memoryMode === "NORMAL" &&
    source.activeLeafMessageId === sourceJob.activeLeafMessageId &&
    source.memoryBranchGeneration === row.branchGeneration &&
    source.memorySourceRevision === row.sourceRevision &&
    source.sourceHash === row.sourceHash
    ? source
    : null;
}

function scopeSql(scope: MemoryFactCandidateScope): Prisma.Sql {
  return scope.type === "GLOBAL_USER"
    ? Prisma.sql`scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
        AND scope."targetIdSnapshot" IS NULL`
    : Prisma.sql`scope."scopeType"::text = ${scope.type}
        AND scope."targetIdSnapshot" = ${scope.targetId}`;
}

async function newerTargetFactId(
  tx: MemoryTransaction,
  row: DeferredCandidateRow,
  scope: MemoryFactCandidateScope
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ factId: string }>>(Prisma.sql`
    SELECT fact."id" AS "factId"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."factId" = fact."id"
      AND version."id" = fact."currentVersionId"
    WHERE fact."userId" = ${row.userId}
      AND fact."canonicalKey" = ${row.proposedCanonicalKey!}
      AND fact."category" = ${row.proposedCategory!}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."pinned" = FALSE
      AND fact."movedToFactId" IS NULL
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND (${scopeSql(scope)})
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
      AND version."sensitivityClass" = 'NORMAL'::"MemorySensitivityClass"
      AND version."contentPurgedAt" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "MemoryFactVersion" AS explicit_version
        WHERE explicit_version."userId" = fact."userId"
          AND explicit_version."factId" = fact."id"
          AND explicit_version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
      )
      AND (
        version."systemFrom" > ${row.createdAt}
        OR EXISTS (
          SELECT 1 FROM "MemoryEvidence" AS evidence
          WHERE evidence."userId" = version."userId"
            AND evidence."factVersionId" = version."id"
            AND evidence."createdAt" > ${row.createdAt}
        )
      )
    LIMIT 1
    FOR SHARE OF fact, scope, version
  `);
  return rows[0]?.factId ?? null;
}

export async function prepareGlobalDreamDeferredSelection(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  settings: LockedMemorySettings,
  input: Readonly<{ candidateId: string; now: Date }>
): Promise<Extract<
  MemoryGlobalDreamSemanticSelection,
  { kind: "REVISIT_DEFERRED" }
> | null> {
  const row = await tx.memoryCandidate.findFirst({
    select: {
      branchGeneration: true,
      chatId: true,
      confidence: true,
      contentPurgedAt: true,
      createdAt: true,
      createdByExecutionId: true,
      id: true,
      importance: true,
      jobId: true,
      languageCode: true,
      negated: true,
      pipelineVersion: true,
      proposedCanonicalKey: true,
      proposedCategory: true,
      proposedDirectness: true,
      proposedDisplayText: true,
      proposedModality: true,
      proposedScope: true,
      proposedSensitivity: true,
      proposedValidFrom: true,
      proposedValidTo: true,
      proposedValue: true,
      rawTemporalExpression: true,
      reasonCode: true,
      sourceHash: true,
      sourceProjectionHash: true,
      sourceProjectionVersion: true,
      sourceRevision: true,
      sourceTimezone: true,
      state: true,
      temporalResolutionEvidence: true,
      temporalResolverVersion: true,
      userId: true
    },
    where: { id: input.candidateId, userId: settings.userId }
  }) as DeferredCandidateRow | null;
  if (
    !row || row.state !== "DEFERRED" || !row.reasonCode || row.contentPurgedAt ||
    row.pipelineVersion !== MEMORY_FACT_EXTRACTION_PIPELINE_VERSION ||
    !sha256Pattern.test(row.id) || !sha256Pattern.test(row.sourceHash) ||
    !sha256Pattern.test(row.sourceProjectionHash) ||
    !row.proposedCanonicalKey || !canonicalKeyPattern.test(row.proposedCanonicalKey) ||
    !row.proposedCategory || !categoryPattern.test(row.proposedCategory) ||
    row.proposedDirectness !== "DIRECT" || row.proposedSensitivity !== "NORMAL" ||
    !row.proposedDisplayText || row.proposedDisplayText.length > 2_000 ||
    !row.proposedModality || !modalities.has(
      row.proposedModality as MemoryFactCandidateSnapshot["modality"]
    ) || !row.languageCode || !languageCodePattern.test(row.languageCode) ||
    row.confidence === null || !Number.isFinite(row.confidence) ||
    row.confidence < 0 || row.confidence > 1 ||
    row.importance === null || !Number.isFinite(row.importance) ||
    row.importance < 0 || row.importance > 1 ||
    row.negated === null || !row.sourceTimezone || row.sourceTimezone.length > 64 ||
    !row.sourceProjectionVersion || row.sourceProjectionVersion.length > 64 ||
    row.reasonCode.length > 64 ||
    !normalizeMemorySearchText(row.proposedDisplayText)
  ) return null;
  try {
    if (memoryStableJson(row.proposedValue).length > 8_192) return null;
  } catch {
    return null;
  }
  const scope = exactScope(row.proposedScope);
  if (!scope || !await scopeAvailable(tx, row, scope)) return null;
  const source = await candidateProvenanceCurrent(tx, settings, row);
  if (!source) return null;
  const barrier = await tx.memorySourceBarrier.findFirst({
    orderBy: [{ sourceCreatedAtCutoff: "desc" }, { id: "desc" }],
    select: { sourceCreatedAtCutoff: true },
    where: { kind: { in: ["ALL_REUSABLE", "AUTOMATIC_FACTS"] }, userId: row.userId }
  });
  const evidenceRows = await tx.$queryRaw<CandidateEvidenceRow[]>(Prisma.sql`
    SELECT
      source."messageId", source."ordinal", source."startOffset",
      source."endOffset", source."sourceTextHash", message."content",
      message."role", message."status"::text AS "status", message."createdAt"
    FROM "MemoryCandidateMessage" AS source
    INNER JOIN "Message" AS message
      ON message."chatId" = source."chatId" AND message."id" = source."messageId"
    WHERE source."userId" = ${row.userId}
      AND source."candidateId" = ${row.id}
      AND source."chatId" = ${row.chatId}
    ORDER BY source."ordinal", source."messageId"
  `);
  if (evidenceRows.length < 1 || evidenceRows.length > 6) return null;
  const activeMessageIds = new Set(source.messages.map(({ id }) => id));
  if (evidenceRows.some(({ messageId }) => !activeMessageIds.has(messageId))) return null;
  const evidence: MemoryFactCandidateEvidenceSnapshot[] = [];
  for (const item of evidenceRows) {
    const text = directText(item.content);
    if (
      item.role !== "user" || item.status !== "complete" || text === null ||
      (barrier && item.createdAt <= barrier.sourceCreatedAtCutoff) ||
      memorySha256(text) !== item.sourceTextHash ||
      item.startOffset < 0 || item.endOffset <= item.startOffset ||
      item.endOffset > text.length
    ) return null;
    const projected = projectMemoryHistorySafeText(text);
    if (
      !projected.eligible || projected.safetyClass !== "NORMAL" ||
      projected.redactionState !== "NOT_NEEDED" || projected.safeText !== text ||
      !inspectMemoryFactSourceSafety(text).eligible
    ) return null;
    const quote = text.slice(item.startOffset, item.endOffset);
    if (!quote || quote.length > 2_000) return null;
    const suppressions = await findMatchingMemorySuppressions(
      tx,
      keyring,
      row.userId,
      {
        canonicalKey: row.proposedCanonicalKey,
        category: row.proposedCategory,
        normalizedValue: row.proposedDisplayText,
        source: {
          branchGeneration: row.branchGeneration,
          chatId: row.chatId,
          messageId: item.messageId
        }
      }
    );
    if (suppressions.some(({ expiresAt }) => expiresAt === null || expiresAt > input.now)) {
      return null;
    }
    evidence.push({
      endOffset: item.endOffset,
      messageId: item.messageId,
      observedAt: item.createdAt.toISOString(),
      quote,
      sourceTextHash: item.sourceTextHash,
      startOffset: item.startOffset
    });
  }
  if (
    !evidence.some(({ quote }) => quote === row.proposedDisplayText) ||
    !memoryFactCandidateSensitivityAllowed(
      evidence.map(({ quote }) => quote).join("\n"),
      row.proposedCategory,
      row.proposedDisplayText
    )
  ) return null;
  const targetFactId = await newerTargetFactId(tx, row, scope);
  if (!targetFactId) return null;
  const target = await prepareGlobalDreamTargetContext(
    tx,
    keyring,
    settings,
    targetFactId,
    input.now
  );
  if (!target) return null;
  const candidate: MemoryFactCandidateSnapshot = {
    branchGeneration: row.branchGeneration,
    canonicalKey: row.proposedCanonicalKey,
    category: row.proposedCategory,
    chatId: row.chatId,
    confidence: row.confidence,
    directness: "DIRECT",
    displayText: row.proposedDisplayText,
    evidence,
    id: row.id,
    importance: row.importance,
    languageCode: row.languageCode,
    modality: row.proposedModality as MemoryFactCandidateSnapshot["modality"],
    negated: row.negated,
    proposedValue: row.proposedValue,
    rawTemporalExpression: row.rawTemporalExpression,
    scope,
    sensitivity: "NORMAL",
    sourceHash: source.sourceHash,
    sourceProjectionVersion: row.sourceProjectionVersion,
    sourceRevision: source.memorySourceRevision,
    sourceTimezone: row.sourceTimezone,
    temporalResolverVersion: row.temporalResolverVersion,
    temporalResolutionEvidence: temporalEvidence(row.temporalResolutionEvidence),
    validFrom: row.proposedValidFrom?.toISOString() ?? null,
    validTo: row.proposedValidTo?.toISOString() ?? null
  };
  const relatedFacts = [target.related];
  const relatedSnapshotHash = memoryFactRelatedSnapshotHash(relatedFacts);
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate,
    memoryRevision: 0,
    relatedFacts,
    relatedSnapshotHash
  };
  const consolidationInput = {
    ...withoutHash,
    inputHash: memoryFactConsolidationInputHash(withoutHash)
  };
  const snapshotHash = memorySha256({
    candidate: row,
    evidence,
    inputHash: consolidationInput.inputHash,
    sourceHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    targetSnapshotHash: target.snapshotHash,
    version: 1
  });
  return {
    input: consolidationInput,
    kind: "REVISIT_DEFERRED",
    resultHash: memoryGlobalDreamResultHash({
      inputHash: consolidationInput.inputHash,
      kind: "REVISIT_DEFERRED",
      snapshotHash
    }),
    scopeChanged: true,
    snapshotHash,
    sourceEvidenceIds: [],
    sourceFactId: null,
    sourceVersionId: null,
    targetEvidenceIds: target.evidenceIds,
    targetFactId,
    targetVersionId: target.versionId
  };
}
