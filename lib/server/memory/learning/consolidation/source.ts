import { Prisma } from "@prisma/client";
import type {
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../../coordinator/types";
import { projectMemoryHistorySafeText } from "../../history/safety";
import {
  memorySha256,
  memoryStableJson,
  normalizeMemorySearchText
} from "../../persistence/lexical";
import { memorySourceIsInsidePause } from "../../persistence/pauseIntervals";
import {
  memoryPersonalEvidenceCount,
  memoryPersonalEvidenceLatestAt,
  memoryPersonalFactEvidencePredicate
} from "../../persistence/eligibility";
import { memoryCanonicalGlobalScopePredicate } from "../../persistence/scopes";
import { findMatchingMemorySuppressions } from "../../persistence/suppressions";
import type {
  LockedMemorySettings,
  MemoryTransaction
} from "../../persistence/transaction";
import { loadMemorySourceSnapshot } from "../../sourceState";
import type { MemorySuppressionKeyring } from "../../suppressionKeyring";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_V1_CATEGORY_ALLOWLIST
} from "../extraction/contract";
import {
  MEMORY_FACT_MAX_RELATED_FACTS,
  MEMORY_FACT_MAX_RELATED_VERSIONS,
  memoryFactConsolidationInputHash,
  memoryFactRelatedSnapshotHash,
  memoryFactVerificationInputHash,
  parseMemoryFactConsolidationJob,
  parseMemoryFactVerificationJob,
  type MemoryFactCandidateEvidenceSnapshot,
  type MemoryFactCandidateScope,
  type MemoryFactCandidateSnapshot,
  type MemoryFactConsolidationInput,
  type MemoryFactDecisionSnapshot,
  type MemoryFactVerificationInput,
  type MemoryRelatedFactSnapshot,
  type MemoryRelatedFactVersionSnapshot
} from "./contract";

export type MemoryFactConsolidationPrepareResult =
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{ input: MemoryFactConsolidationInput }>;

export type MemoryFactVerificationPrepareResult =
  | Readonly<{ decision: Exclude<MemoryJobGateDecision, { status: "READY" }> }>
  | Readonly<{ input: MemoryFactVerificationInput }>;

const staleDecision = Object.freeze({
  errorCode: "memory_fact_candidate_stale",
  status: "STALE" as const
});
const disabledDecision = Object.freeze({
  errorCode: "memory_automatic_learning_disabled",
  status: "CANCELLED" as const
});
const invalidDecision = Object.freeze({
  errorCode: "memory_fact_candidate_invalid",
  status: "CANCELLED" as const
});

const categoryPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const legacyCategoryAllowlist = new Set([
  "constraint", "goal", "interest", "language", "preference", "professional_role",
  "routine", "tool", "work"
]);
const canonicalKeyPattern = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const modalities = new Set([
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

type CandidateRecord = Readonly<{
  branchGeneration: number;
  chatId: string;
  confidence: number | null;
  contentPurgedAt: Date | null;
  createdByExecutionId: string;
  proposedCoreEligible: boolean | null;
  proposedCoreSalience: string | null;
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
  sourceHash: string;
  sourceProjectionVersion: string;
  sourceRevision: number;
  sourceTimezone: string | null;
  state: string;
  temporalResolverVersion: string | null;
  temporalResolutionEvidence: Prisma.JsonValue | null;
  userId: string;
}>;

type EvidenceRecord = Readonly<{
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

type RelatedFactRow = Readonly<{
  canonicalKey: string;
  category: string;
  currentVersionId: string | null;
  id: string;
  scopeTargetId: string | null;
  scopeType: MemoryFactCandidateScope["type"];
  state: MemoryRelatedFactSnapshot["state"];
}>;

type RelatedVersionRow = Readonly<{
  category: string;
  confidence: number;
  directness: MemoryRelatedFactVersionSnapshot["directness"];
  displayText: string | null;
  factId: string;
  id: string;
  importance: number;
  languageCode: string;
  latestEvidenceAt: Date | null;
  modality: MemoryRelatedFactVersionSnapshot["modality"];
  sourceMode: MemoryRelatedFactVersionSnapshot["sourceMode"];
  state: MemoryRelatedFactVersionSnapshot["state"];
  structuredValue: Prisma.JsonValue | null;
  supportCount: bigint;
  systemFrom: Date;
  systemTo: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactScope(value: Prisma.JsonValue | null): MemoryFactCandidateScope | null {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "target_id,type") {
    return null;
  }
  const type = value.type;
  const targetId = value.target_id;
  if (type === "GLOBAL_USER" && targetId === null) {
    return { targetId: null, type };
  }
  return null;
}

function extractDirectText(content: Prisma.JsonValue): string | null {
  if (!isRecord(content) || !Array.isArray(content.blocks) || content.blocks.length > 128) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content.blocks) {
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

function temporalEvidence(value: Prisma.JsonValue | null): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function candidateSemanticFlags(value: Prisma.JsonValue | null): Readonly<{
  correction: boolean;
  futureUseful: boolean;
}> {
  return {
    correction: isRecord(value) && value.correction === true,
    futureUseful: !(isRecord(value) && value.futureUseful === false)
  };
}

function validLanguageCode(value: string): boolean {
  if (value === "und") return true;
  try {
    new Intl.Locale(value);
    return true;
  } catch {
    return false;
  }
}

function candidateIdentityHash(
  row: CandidateRecord,
  snapshot: Omit<MemoryFactCandidateSnapshot, "id">
): string {
  return memorySha256({
    candidate: {
      category: snapshot.category,
      confidence: snapshot.confidence,
      coreEligible: snapshot.coreEligible,
      coreSalience: snapshot.coreSalience,
      directness: snapshot.directness,
      displayText: snapshot.displayText,
      evidence: snapshot.evidence.map((evidence) => ({
        endOffset: evidence.endOffset,
        messageId: evidence.messageId,
        sourceTextHash: evidence.sourceTextHash,
        startOffset: evidence.startOffset
      })),
      importance: snapshot.importance,
      languageCode: snapshot.languageCode,
      modality: snapshot.modality,
      negated: snapshot.negated,
      proposedValue: snapshot.proposedValue,
      rawTemporalExpression: snapshot.rawTemporalExpression,
      reasonCode: null,
      scope: snapshot.scope,
      sensitivity: snapshot.sensitivity,
      state: "PENDING",
      temporalResolutionEvidence: snapshot.temporalResolutionEvidence,
      validFrom: snapshot.validFrom,
      validTo: snapshot.validTo
    },
    domain: "aiqsa.memory.fact-candidate",
    source: { chatId: row.chatId, userId: row.userId },
    version: 1
  });
}

async function sourceAndSettingsAreCurrent(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor,
  row: CandidateRecord
): Promise<boolean> {
  if (
    !settings.useMemoryFacts ||
    !settings.learnAutomatically ||
    settings.memoryGeneration !== job.memoryGenerationSnapshot ||
    row.userId !== job.userId || row.chatId !== job.chatId ||
    row.branchGeneration !== job.branchGeneration ||
    row.sourceRevision !== job.sourceRevision || row.sourceHash !== job.sourceHash
  ) return false;
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: row.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: row.userId
  });
  return Boolean(
    source && source.memoryMode === "NORMAL" &&
    source.activeLeafMessageId === job.activeLeafMessageId &&
    source.memoryBranchGeneration === row.branchGeneration &&
    source.memorySourceRevision === row.sourceRevision &&
    source.sourceHash === row.sourceHash &&
    source.messages.some((message) => message.id === job.activeLeafMessageId)
  );
}

async function evidenceIsAdmitted(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  row: CandidateRecord,
  candidate: MemoryFactCandidateSnapshot,
  evidence: readonly EvidenceRecord[],
  now: Date
): Promise<boolean> {
  const [cutoff, pauseIntervals] = await Promise.all([
    tx.memorySourceBarrier.findFirst({
      orderBy: [{ sourceCreatedAtCutoff: "desc" }, { id: "desc" }],
      select: { sourceCreatedAtCutoff: true },
      where: {
        explicitOverrideAllowed: false,
        kind: { in: ["ALL_REUSABLE", "AUTOMATIC_FACTS"] },
        userId: row.userId
      }
    }),
    tx.memoryPauseInterval.findMany({
      orderBy: [{ pausedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        memoryGeneration: true,
        pausedAt: true,
        resumedAt: true,
        scope: true
      },
      where: {
        scope: { in: ["MASTER", "AUTOMATIC_LEARNING"] },
        userId: row.userId
      }
    })
  ]);
  for (const item of evidence) {
    if (cutoff && item.createdAt <= cutoff.sourceCreatedAtCutoff) return false;
    if (memorySourceIsInsidePause(item.createdAt, pauseIntervals)) return false;
    const matches = await findMatchingMemorySuppressions(
      tx,
      keyring,
      row.userId,
      {
        canonicalKey: candidate.canonicalKey,
        category: candidate.category,
        normalizedValue: candidate.displayText,
        source: {
          branchGeneration: row.branchGeneration,
          chatId: row.chatId,
          messageId: item.messageId
        }
      }
    );
    if (matches.some((match) => match.expiresAt === null || match.expiresAt > now)) {
      return false;
    }
  }
  return true;
}

async function loadCandidate(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor,
  candidateId: string,
  keyring: MemorySuppressionKeyring,
  now: Date
): Promise<MemoryFactCandidateSnapshot | null> {
  const row = await tx.memoryCandidate.findFirst({
    select: {
      branchGeneration: true,
      chatId: true,
      confidence: true,
      contentPurgedAt: true,
      createdByExecutionId: true,
      id: true,
      importance: true,
      jobId: true,
      languageCode: true,
      negated: true,
      pipelineVersion: true,
      proposedCanonicalKey: true,
      proposedCategory: true,
      proposedCoreEligible: true,
      proposedCoreSalience: true,
      proposedDirectness: true,
      proposedDisplayText: true,
      proposedModality: true,
      proposedScope: true,
      proposedSensitivity: true,
      proposedValidFrom: true,
      proposedValidTo: true,
      proposedValue: true,
      rawTemporalExpression: true,
      sourceHash: true,
      sourceProjectionVersion: true,
      sourceRevision: true,
      sourceTimezone: true,
      state: true,
      temporalResolverVersion: true,
      temporalResolutionEvidence: true,
      userId: true
    },
    where: { id: candidateId, userId: job.userId }
  }) as CandidateRecord | null;
  if (
    !row || row.state !== "PENDING" || row.contentPurgedAt !== null ||
    !row.createdByExecutionId || row.createdByExecutionId.length > 256 ||
    row.pipelineVersion !== MEMORY_FACT_EXTRACTION_PIPELINE_VERSION ||
    !sha256Pattern.test(row.id) || !sha256Pattern.test(row.sourceHash) ||
    !row.proposedCanonicalKey || !canonicalKeyPattern.test(row.proposedCanonicalKey) ||
    !row.proposedCategory || !categoryPattern.test(row.proposedCategory) ||
    (!(MEMORY_V1_CATEGORY_ALLOWLIST as readonly string[]).includes(row.proposedCategory) &&
      !legacyCategoryAllowlist.has(row.proposedCategory)) ||
    (row.proposedDirectness !== "DIRECT" &&
      row.proposedDirectness !== "PARAPHRASED") ||
    row.proposedSensitivity !== "NORMAL" ||
    row.proposedCoreEligible === null ||
    !["HIGH", "MEDIUM", "LOW", "NONE"].includes(row.proposedCoreSalience ?? "") ||
    (row.proposedCoreEligible === (row.proposedCoreSalience === "NONE")) ||
    !row.proposedDisplayText || row.proposedDisplayText.length > 2_000 ||
    !row.proposedModality || !modalities.has(row.proposedModality) ||
    !row.languageCode || !validLanguageCode(row.languageCode) ||
    row.confidence === null || !Number.isFinite(row.confidence) ||
    row.confidence < 0 || row.confidence > 1 ||
    row.importance === null || !Number.isFinite(row.importance) ||
    row.importance < 0 || row.importance > 1 || row.negated === null ||
    !row.sourceTimezone || row.sourceTimezone.length > 64 ||
    !(await sourceAndSettingsAreCurrent(tx, settings, job, row))
  ) return null;
  const scope = exactScope(row.proposedScope);
  if (!scope) return null;
  const evidenceRows = await tx.$queryRaw<EvidenceRecord[]>(Prisma.sql`
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
  const v1Candidate = isRecord(row.proposedValue) &&
    typeof row.proposedValue.statement === "string";
  let currentDirectUserMessageId: string | null = null;
  if (v1Candidate) {
    // Re-check the turn boundary at consolidation time.  A forged or stale
    // candidate must not smuggle an older user message into a new fact even
    // when its chat/source revision metadata otherwise matches.
    const activeLeafMessageId = job.activeLeafMessageId;
    if (activeLeafMessageId === null) return null;
    const leaf = await tx.message.findFirst({
      select: { parentMessageId: true, role: true, status: true },
      where: { chatId: row.chatId, id: activeLeafMessageId }
    });
    if (
      !leaf || leaf.role !== "assistant" || leaf.status !== "complete" ||
      leaf.parentMessageId === null
    ) return null;
    const parent = await tx.message.findFirst({
      select: { id: true, role: true, status: true },
      where: { chatId: row.chatId, id: leaf.parentMessageId }
    });
    if (!parent || parent.role !== "user" || parent.status !== "complete") return null;
    currentDirectUserMessageId = parent.id;
  }
  if (
    v1Candidate &&
    (row.confidence !== 1 || evidenceRows.length !== 1 ||
      row.proposedSensitivity !== "NORMAL" ||
      !(MEMORY_V1_CATEGORY_ALLOWLIST as readonly string[]).includes(row.proposedCategory))
  ) return null;
  const evidence: MemoryFactCandidateEvidenceSnapshot[] = [];
  for (const item of evidenceRows) {
    if (v1Candidate && item.messageId !== currentDirectUserMessageId) return null;
    const text = extractDirectText(item.content);
    if (item.role !== "user" || item.status !== "complete" || text === null) return null;
    const projected = projectMemoryHistorySafeText(text);
    if (
      !projected.eligible || projected.safetyClass !== "NORMAL" ||
      projected.redactionState !== "NOT_NEEDED" || projected.safeText !== text ||
      memorySha256(text) !== item.sourceTextHash ||
      item.startOffset < 0 || item.endOffset <= item.startOffset ||
      item.endOffset > text.length
    ) return null;
    const quote = text.slice(item.startOffset, item.endOffset);
    if (!quote || quote.length > 2_000) return null;
    evidence.push({
      endOffset: item.endOffset,
      messageId: item.messageId,
      observedAt: item.createdAt.toISOString(),
      quote,
      sourceTextHash: item.sourceTextHash,
      startOffset: item.startOffset
    });
  }
  try {
    const encoded = memoryStableJson(row.proposedValue);
    if (!encoded || encoded.length > 8_192) return null;
  } catch {
    return null;
  }
  const candidateWithoutId: Omit<MemoryFactCandidateSnapshot, "id"> = {
    branchGeneration: row.branchGeneration,
    canonicalKey: row.proposedCanonicalKey,
    category: row.proposedCategory,
    chatId: row.chatId,
    confidence: row.confidence,
    confidenceBand: row.confidence >= 1 ? "HIGH" : row.confidence >= 0.5 ? "MEDIUM" : "LOW",
    ...candidateSemanticFlags(row.proposedValue),
    coreEligible: row.proposedCoreEligible,
    coreSalience: row.proposedCoreSalience as MemoryFactCandidateSnapshot["coreSalience"],
    directness: row.proposedDirectness as MemoryFactCandidateSnapshot["directness"],
    displayText: row.proposedDisplayText,
    evidence,
    extractionExecutionId: row.createdByExecutionId,
    importance: row.importance,
    languageCode: row.languageCode,
    modality: row.proposedModality as MemoryFactCandidateSnapshot["modality"],
    negated: row.negated,
    proposedValue: row.proposedValue,
    rawTemporalExpression: row.rawTemporalExpression,
    scope,
    sensitivity: "NORMAL",
    sourceHash: row.sourceHash,
    sourceProjectionVersion: row.sourceProjectionVersion,
    sourceRevision: row.sourceRevision,
    sourceTimezone: row.sourceTimezone,
    temporalResolverVersion: row.temporalResolverVersion,
    temporalResolutionEvidence: temporalEvidence(row.temporalResolutionEvidence),
    validFrom: row.proposedValidFrom?.toISOString() ?? null,
    validTo: row.proposedValidTo?.toISOString() ?? null
  };
  if (candidateIdentityHash(row, candidateWithoutId) !== row.id) return null;
  const candidate = { ...candidateWithoutId, id: row.id };
  return await evidenceIsAdmitted(tx, keyring, row, candidate, evidenceRows, now)
    ? candidate
    : null;
}

async function loadRelatedFacts(
  tx: MemoryTransaction,
  userId: string,
  candidate: MemoryFactCandidateSnapshot,
  relatedVersionIds: readonly string[] | null
): Promise<MemoryRelatedFactSnapshot[]> {
  const normalizedQuery = normalizeMemorySearchText(candidate.displayText);
  const boundedIds = [...new Set(relatedVersionIds ?? [])]
    .slice(0, MEMORY_FACT_MAX_RELATED_FACTS * 2);
  const neighborhood = relatedVersionIds === null
    ? Prisma.sql`TRUE`
    : boundedIds.length > 0
      ? Prisma.sql`(
          current_version."id" IN (${Prisma.join(boundedIds)})
          OR current_version."normalizedSearchText" = ${normalizedQuery}
        )`
      : Prisma.sql`current_version."normalizedSearchText" = ${normalizedQuery}`;
  const relatedQuery = Prisma.sql`
    SELECT
      fact."id", fact."canonicalKey", fact."category",
      fact."state"::text AS "state", fact."currentVersionId",
      scope."scopeType"::text AS "scopeType",
      scope."targetIdSnapshot" AS "scopeTargetId"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryFactVersion" AS current_version
      ON current_version."userId" = fact."userId"
      AND current_version."factId" = fact."id"
      AND current_version."id" = fact."currentVersionId"
    WHERE fact."userId" = ${userId}
      AND fact."state" <> 'FORGOTTEN'::"MemoryFactState"
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."category" = ${candidate.category}
      AND current_version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND current_version."systemTo" IS NULL
      AND current_version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
      AND current_version."contentPurgedAt" IS NULL
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND ${memoryPersonalFactEvidencePredicate(userId, {
        factVersionId: Prisma.sql`current_version."id"`,
        sourceMode: Prisma.sql`current_version."sourceMode"`
      })}
      AND (${neighborhood})
    ORDER BY
      (current_version."normalizedSearchText" = ${normalizedQuery}) DESC,
      fact."updatedAt" DESC,
      fact."id"
    LIMIT ${MEMORY_FACT_MAX_RELATED_FACTS}
  `;
  const rows = await tx.$queryRaw<RelatedFactRow[]>(relatedQuery);
  if (rows.length === 0) return [];
  const factIds = rows.map((row) => row.id);
  const versions = await tx.$queryRaw<RelatedVersionRow[]>(Prisma.sql`
    WITH ranked AS (
      SELECT
        version."factId", version."id", version."displayText",
        version."languageCode", version."structuredValue", version."category",
        version."modality"::text AS "modality",
        version."sourceMode"::text AS "sourceMode",
        version."state"::text AS "state", version."validFrom", version."validTo",
        version."systemFrom", version."systemTo", version."confidence",
        version."importance", version."directness"::text AS "directness",
        CASE
          WHEN version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
            THEN (${memoryPersonalEvidenceCount(userId)})::bigint
          ELSE count(evidence."id")
        END AS "supportCount",
        CASE
          WHEN version."sourceMode" = 'AUTOMATIC'::"MemoryFactSourceMode"
            THEN ${memoryPersonalEvidenceLatestAt(userId)}
          ELSE max(evidence."observedAt")
        END AS "latestEvidenceAt",
        row_number() OVER (
          PARTITION BY version."factId"
          ORDER BY
            (version."id" = fact."currentVersionId") DESC,
            version."systemFrom" DESC,
            version."id" DESC
        ) AS ordinal
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId" AND fact."id" = version."factId"
      LEFT JOIN "MemoryEvidence" AS evidence
        ON evidence."userId" = version."userId"
        AND evidence."factVersionId" = version."id"
        AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
        AND evidence."sourceType" = 'EXPLICIT_ACTION'::"MemoryEvidenceSourceType"
      WHERE version."userId" = ${userId}
        AND version."factId" IN (${Prisma.join(factIds)})
        AND version."state" <> 'FORGOTTEN'::"MemoryFactVersionState"
        AND version."safetyClassificationState" = 'CLASSIFIED'::"MemorySafetyClassificationState"
        AND version."contentPurgedAt" IS NULL
        AND ${memoryPersonalFactEvidencePredicate(userId)}
      GROUP BY version."id", fact."currentVersionId"
    )
    SELECT * FROM ranked
    WHERE ordinal <= ${MEMORY_FACT_MAX_RELATED_VERSIONS}
    ORDER BY "factId", ordinal
  `);
  const byFact = new Map<string, MemoryRelatedFactVersionSnapshot[]>();
  for (const version of versions) {
    if (version.displayText === null || version.structuredValue === null) continue;
    const list = byFact.get(version.factId) ?? [];
    list.push({
      category: version.category,
      confidence: version.confidence,
      directness: version.directness,
      displayText: version.displayText,
      id: version.id,
      importance: version.importance,
      languageCode: version.languageCode,
      latestEvidenceAt: version.latestEvidenceAt?.toISOString() ?? null,
      modality: version.modality,
      sourceMode: version.sourceMode,
      state: version.state,
      structuredValue: version.structuredValue,
      supportCount: Number(version.supportCount),
      systemFrom: version.systemFrom.toISOString(),
      systemTo: version.systemTo?.toISOString() ?? null,
      validFrom: version.validFrom?.toISOString() ?? null,
      validTo: version.validTo?.toISOString() ?? null
    });
    byFact.set(version.factId, list);
  }
  return rows.flatMap((row): MemoryRelatedFactSnapshot[] => {
    const factVersions = byFact.get(row.id) ?? [];
    if (factVersions.length === 0) return [];
    const scope = row.scopeType === "GLOBAL_USER"
      ? { targetId: null, type: "GLOBAL_USER" as const }
      : row.scopeTargetId
        ? { targetId: row.scopeTargetId, type: row.scopeType }
        : null;
    if (!scope) return [];
    return [{
      canonicalKey: row.canonicalKey,
      category: row.category,
      currentVersionId: row.currentVersionId,
      id: row.id,
      scope,
      state: row.state,
      versions: factVersions
    }];
  });
}

export async function probeMemoryFactConsolidation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor
): Promise<MemoryJobGateDecision> {
  const identity = parseMemoryFactConsolidationJob(job);
  if (!identity) return invalidDecision;
  if (!settings.useMemoryFacts || !settings.learnAutomatically) return disabledDecision;
  if (settings.memoryGeneration !== job.memoryGenerationSnapshot) return staleDecision;
  const candidate = await tx.memoryCandidate.findFirst({
    select: {
      branchGeneration: true,
      chatId: true,
      id: true,
      sourceHash: true,
      sourceRevision: true,
      state: true
    },
    where: { id: identity.candidateId, userId: job.userId }
  });
  if (
    !candidate || candidate.state !== "PENDING" ||
    candidate.chatId !== job.chatId ||
    candidate.branchGeneration !== job.branchGeneration ||
    candidate.sourceRevision !== job.sourceRevision ||
    candidate.sourceHash !== job.sourceHash
  ) return staleDecision;
  const decision = await tx.memoryCandidateDecision.findFirst({
    select: { id: true },
    where: { candidateId: candidate.id, userId: job.userId }
  });
  if (decision) return staleDecision;
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: candidate.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: job.userId
  });
  return source && source.memoryMode === "NORMAL" &&
    source.activeLeafMessageId === job.activeLeafMessageId &&
    source.memoryBranchGeneration === candidate.branchGeneration &&
    source.memorySourceRevision === candidate.sourceRevision &&
    source.sourceHash === candidate.sourceHash
    ? { status: "READY" }
    : staleDecision;
}

export async function prepareMemoryFactConsolidation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor,
  keyring: MemorySuppressionKeyring,
  now: Date,
  relatedVersionIds: readonly string[] | null = null
): Promise<MemoryFactConsolidationPrepareResult> {
  const gate = await probeMemoryFactConsolidation(tx, settings, job);
  if (gate.status !== "READY") return { decision: gate };
  const identity = parseMemoryFactConsolidationJob(job);
  if (!identity) return { decision: invalidDecision };
  const candidate = await loadCandidate(tx, settings, job, identity.candidateId, keyring, now);
  if (!candidate) return { decision: staleDecision };
  const relatedFacts = await loadRelatedFacts(
    tx,
    job.userId,
    candidate,
    relatedVersionIds
  );
  const relatedSnapshotHash = memoryFactRelatedSnapshotHash(relatedFacts);
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate,
    memoryRevision: settings.memoryRevision,
    relatedFacts,
    relatedSnapshotHash
  };
  return {
    input: {
      ...withoutHash,
      inputHash: memoryFactConsolidationInputHash(withoutHash)
    }
  };
}

export async function probeMemoryFactVerification(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor
): Promise<MemoryJobGateDecision> {
  const identity = parseMemoryFactVerificationJob(job);
  if (!identity) return invalidDecision;
  if (!settings.useMemoryFacts || !settings.learnAutomatically) return disabledDecision;
  if (settings.memoryGeneration !== job.memoryGenerationSnapshot) return staleDecision;
  const decision = await tx.memoryCandidateDecision.findFirst({
    select: {
      candidateId: true,
      state: true,
      verificationJobId: true
    },
    where: { id: identity.decisionId, userId: job.userId }
  });
  if (
    !decision || decision.state !== "PENDING_VERIFICATION" ||
    decision.verificationJobId !== job.id
  ) return staleDecision;
  const candidate = await tx.memoryCandidate.findFirst({
    select: {
      branchGeneration: true,
      chatId: true,
      sourceHash: true,
      sourceRevision: true,
      state: true
    },
    where: { id: decision.candidateId, userId: job.userId }
  });
  if (
    !candidate || candidate.state !== "PENDING" ||
    candidate.chatId !== job.chatId ||
    candidate.branchGeneration !== job.branchGeneration ||
    candidate.sourceRevision !== job.sourceRevision ||
    candidate.sourceHash !== job.sourceHash
  ) return staleDecision;
  const source = await loadMemorySourceSnapshot(tx, {
    chatId: candidate.chatId,
    lock: "SHARE",
    personalOnly: true,
    userId: job.userId
  });
  return source && source.memoryMode === "NORMAL" &&
    source.activeLeafMessageId === job.activeLeafMessageId &&
    source.memoryBranchGeneration === candidate.branchGeneration &&
    source.memorySourceRevision === candidate.sourceRevision &&
    source.sourceHash === candidate.sourceHash
    ? { status: "READY" }
    : staleDecision;
}

export async function prepareMemoryFactVerification(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  job: MemoryJobDescriptor,
  keyring: MemorySuppressionKeyring,
  now: Date
): Promise<MemoryFactVerificationPrepareResult> {
  const gate = await probeMemoryFactVerification(tx, settings, job);
  if (gate.status !== "READY") return { decision: gate };
  const identity = parseMemoryFactVerificationJob(job);
  if (!identity) return { decision: invalidDecision };
  const row = await tx.memoryCandidateDecision.findFirst({
    select: {
      candidateId: true,
      consolidationInputHash: true,
      consolidationOutputHash: true,
      id: true,
      operation: true,
      reasonCode: true,
      relatedSnapshotHash: true,
      requiresVerification: true,
      targetFactId: true,
      targetVersionId: true,
      verificationInputHash: true
    },
    where: { id: identity.decisionId, userId: job.userId }
  });
  if (!row || row.requiresVerification !== true || !row.verificationInputHash) {
    return { decision: staleDecision };
  }
  const candidate = await loadCandidate(tx, settings, job, row.candidateId, keyring, now);
  if (!candidate) return { decision: staleDecision };
  const related = await loadRelatedFacts(tx, job.userId, candidate, null);
  const target = row.targetFactId
    ? related.find((fact) => fact.id === row.targetFactId) ?? null
    : null;
  if (
    row.targetFactId &&
    (!target || target.currentVersionId !== row.targetVersionId || target.state !== "ACTIVE")
  ) return { decision: staleDecision };
  const decision: MemoryFactDecisionSnapshot = {
    consolidationInputHash: row.consolidationInputHash,
    consolidationOutputHash: row.consolidationOutputHash,
    id: row.id,
    operation: row.operation,
    reasonCode: row.reasonCode as MemoryFactDecisionSnapshot["reasonCode"],
    relatedSnapshotHash: row.relatedSnapshotHash,
    requiresVerification: true,
    targetFactId: row.targetFactId,
    targetVersionId: row.targetVersionId
  };
  const withoutHash: Omit<MemoryFactVerificationInput, "inputHash"> = {
    candidate,
    decision,
    target
  };
  const inputHash = memoryFactVerificationInputHash(withoutHash);
  return inputHash === row.verificationInputHash
    ? { input: { ...withoutHash, inputHash } }
    : { decision: staleDecision };
}
