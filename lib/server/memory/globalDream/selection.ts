import { Prisma } from "@prisma/client";
import { projectMemoryHistorySafeText } from "../history/safety";
import type {
  MemoryFactCandidateEvidenceSnapshot,
  MemoryFactCandidateScope,
  MemoryFactCandidateSnapshot,
  MemoryFactConsolidationInput,
  MemoryRelatedFactSnapshot,
  MemoryRelatedFactVersionSnapshot
} from "../learning/consolidation/contract";
import {
  memoryFactConsolidationInputHash,
  memoryFactRelatedSnapshotHash
} from "../learning/consolidation/contract";
import {
  findMatchingMemorySuppressions
} from "../persistence/suppressions";
import {
  memorySha256,
  memoryStableJson,
  normalizeMemorySearchText
} from "../persistence/lexical";
import type {
  LockedMemorySettings,
  MemoryTransaction
} from "../persistence/transaction";
import { loadMemorySourceSnapshot } from "../sourceState";
import type { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  MEMORY_GLOBAL_DREAM_MAX_EVIDENCE,
  memoryGlobalDreamResultHash,
  type MemoryGlobalDreamLocalSelection,
  type MemoryGlobalDreamSemanticSelection
} from "./contract";

const EVIDENCE_INSPECTION_LIMIT = 64;

type CurrentFactRow = Readonly<{
  canonicalKey: string;
  category: string;
  currentVersionId: string;
  factId: string;
  factState: "ACTIVE";
  lastConfirmedAt: Date | null;
  movedToFactId: string | null;
  pinned: boolean;
  scopeId: string;
  scopeState: "ACTIVE";
  scopeTargetId: string | null;
  scopeType: MemoryFactCandidateScope["type"];
  versionCategory: string;
  confidence: number;
  directness: MemoryRelatedFactVersionSnapshot["directness"];
  displayText: string;
  importance: number;
  languageCode: string;
  modality: MemoryFactCandidateSnapshot["modality"];
  normalizedSearchText: string;
  pipelineVersion: string;
  rawTemporalExpression: string | null;
  sensitivityClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET" | "SENSITIVE";
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  sourceTimezone: string | null;
  structuredValue: Prisma.JsonValue;
  systemFrom: Date;
  systemTo: Date | null;
  temporalResolutionEvidence: Prisma.JsonValue | null;
  temporalResolverVersion: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  versionState: "ACTIVE";
}>;

type EvidenceRow = Readonly<{
  branchGeneration: number | null;
  chatId: string | null;
  evidenceId: string;
  messageContent: Prisma.JsonValue | null;
  messageCreatedAt: Date | null;
  messageId: string | null;
  messageRole: string | null;
  messageStatus: string | null;
  observedAt: Date;
  safeExcerpt: string;
  safeSourceHash: string;
  safetyClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET" | "SENSITIVE";
  sourceProjectionVersion: string;
  sourceRole: string | null;
  sourceType: "EPISODE" | "EXPLICIT_ACTION" | "MESSAGE";
  stance: "CONTRADICTS" | "SUPPORTS";
}>;

type ValidEvidence = Readonly<{
  branchGeneration: number;
  candidate: MemoryFactCandidateEvidenceSnapshot;
  chatId: string;
  evidenceId: string;
  sourceHash: string;
  sourceProjectionVersion: string;
  sourceRevision: number;
}>;

type EvidenceInspection = Readonly<{
  overflow: boolean;
  snapshot: readonly Readonly<{
    branchGeneration: number | null;
    chatId: string | null;
    evidenceId: string;
    messageId: string | null;
    observedAt: string;
    safeExcerpt: string;
    safeSourceHash: string;
    safetyClass: EvidenceRow["safetyClass"];
    sourceProjectionVersion: string;
    sourceRole: string | null;
    sourceType: EvidenceRow["sourceType"];
  }>[];
  valid: readonly ValidEvidence[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directText(value: Prisma.JsonValue | null): string | null {
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

function exactScope(row: CurrentFactRow): MemoryFactCandidateScope | null {
  if (row.scopeType === "GLOBAL_USER") {
    return row.scopeTargetId === null ? { targetId: null, type: "GLOBAL_USER" } : null;
  }
  return row.scopeTargetId
    ? { targetId: row.scopeTargetId, type: row.scopeType }
    : null;
}

function temporalEvidence(
  value: Prisma.JsonValue | null
): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

export async function loadGlobalDreamCurrentFact(
  tx: MemoryTransaction,
  userId: string,
  factId: string,
  lock: "SHARE" | "UPDATE" = "SHARE"
): Promise<CurrentFactRow | null> {
  const lockSql = lock === "UPDATE"
    ? Prisma.sql`FOR UPDATE OF fact, version, scope`
    : Prisma.sql`FOR SHARE OF fact, version, scope`;
  const rows = await tx.$queryRaw<CurrentFactRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId", fact."scopeId", fact."canonicalKey",
      fact."category", fact."state"::text AS "factState",
      fact."currentVersionId", fact."movedToFactId", fact."lastConfirmedAt",
      fact."pinned",
      scope."scopeType"::text AS "scopeType",
      scope."targetIdSnapshot" AS "scopeTargetId",
      scope."state"::text AS "scopeState",
      version."category" AS "versionCategory", version."confidence",
      version."directness"::text AS "directness", version."displayText",
      version."importance", version."languageCode", version."modality"::text AS "modality",
      version."normalizedSearchText", version."pipelineVersion",
      version."rawTemporalExpression", version."sensitivityClass"::text AS "sensitivityClass",
      version."sourceMode"::text AS "sourceMode", version."sourceTimezone",
      version."structuredValue", version."systemFrom", version."systemTo",
      version."temporalResolutionEvidence", version."temporalResolverVersion",
      version."validFrom", version."validTo", version."state"::text AS "versionState"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."factId" = fact."id"
      AND version."id" = fact."currentVersionId"
    WHERE fact."userId" = ${userId}
      AND fact."id" = ${factId}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."movedToFactId" IS NULL
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."normalizedSearchText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
    ${lockSql}
  `);
  return rows[0] ?? null;
}

async function hasAnyExplicitVersion(
  tx: MemoryTransaction,
  userId: string,
  factId: string
): Promise<boolean> {
  return (await tx.memoryFactVersion.count({
    where: { factId, sourceMode: "EXPLICIT", userId }
  })) > 0;
}

async function evidenceRows(
  tx: MemoryTransaction,
  userId: string,
  versionId: string
): Promise<readonly EvidenceRow[]> {
  return tx.$queryRaw<EvidenceRow[]>(Prisma.sql`
    SELECT
      evidence."id" AS "evidenceId", evidence."stance"::text AS "stance",
      evidence."sourceType"::text AS "sourceType", evidence."chatId",
      evidence."messageId", evidence."branchGeneration", evidence."sourceRole",
      evidence."safeExcerpt", evidence."safeSourceHash",
      evidence."sourceProjectionVersion", evidence."safetyClass"::text AS "safetyClass",
      evidence."observedAt", message."content" AS "messageContent",
      message."role" AS "messageRole", message."status"::text AS "messageStatus",
      message."createdAt" AS "messageCreatedAt"
    FROM "MemoryEvidence" AS evidence
    LEFT JOIN "Message" AS message
      ON message."chatId" = evidence."chatId" AND message."id" = evidence."messageId"
    WHERE evidence."userId" = ${userId}
      AND evidence."factVersionId" = ${versionId}
      AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
    ORDER BY evidence."observedAt" DESC, evidence."id"
    LIMIT ${EVIDENCE_INSPECTION_LIMIT + 1}
  `);
}

export async function inspectGlobalDreamEvidence(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  fact: CurrentFactRow,
  userId: string,
  now: Date
): Promise<EvidenceInspection> {
  const rows = await evidenceRows(tx, userId, fact.currentVersionId);
  const overflow = rows.length > EVIDENCE_INSPECTION_LIMIT;
  const inspected = rows.slice(0, EVIDENCE_INSPECTION_LIMIT);
  const barrier = await tx.memorySourceBarrier.findFirst({
    orderBy: [{ sourceCreatedAtCutoff: "desc" }, { id: "desc" }],
    select: { sourceCreatedAtCutoff: true },
    where: { kind: { in: ["ALL_REUSABLE", "AUTOMATIC_FACTS"] }, userId }
  });
  const sources = new Map<string, Awaited<ReturnType<typeof loadMemorySourceSnapshot>>>();
  const valid: ValidEvidence[] = [];
  for (const row of inspected) {
    if (
      row.sourceType !== "MESSAGE" || row.sourceRole !== "user" ||
      row.safetyClass !== "NORMAL" || !row.chatId || !row.messageId ||
      row.branchGeneration === null || row.messageRole !== "user" ||
      row.messageStatus !== "complete" || !row.messageCreatedAt ||
      (barrier && row.messageCreatedAt <= barrier.sourceCreatedAtCutoff)
    ) continue;
    const text = directText(row.messageContent);
    if (text === null || memorySha256(text) !== row.safeSourceHash) continue;
    const projected = projectMemoryHistorySafeText(text);
    if (
      !projected.eligible || projected.safetyClass !== "NORMAL" ||
      projected.redactionState !== "NOT_NEEDED" || projected.safeText !== text
    ) continue;
    let source = sources.get(row.chatId);
    if (source === undefined) {
      source = await loadMemorySourceSnapshot(tx, {
        chatId: row.chatId,
        lock: "SHARE",
        userId
      });
      sources.set(row.chatId, source);
    }
    if (
      !source || source.memoryMode !== "NORMAL" ||
      source.memoryBranchGeneration !== row.branchGeneration ||
      !source.messages.some(({ id }) => id === row.messageId)
    ) continue;
    const suppressions = await findMatchingMemorySuppressions(
      tx,
      keyring,
      userId,
      {
        canonicalKey: fact.canonicalKey,
        category: fact.category,
        normalizedValue: fact.displayText,
        source: {
          branchGeneration: row.branchGeneration,
          chatId: row.chatId,
          messageId: row.messageId
        }
      }
    );
    if (suppressions.some(({ expiresAt }) => expiresAt === null || expiresAt > now)) {
      continue;
    }
    const startOffset = text.indexOf(row.safeExcerpt);
    if (startOffset < 0 || row.safeExcerpt.length === 0 || row.safeExcerpt.length > 2_000) {
      continue;
    }
    valid.push({
      branchGeneration: row.branchGeneration,
      candidate: {
        endOffset: startOffset + row.safeExcerpt.length,
        messageId: row.messageId,
        observedAt: row.observedAt.toISOString(),
        quote: row.safeExcerpt,
        sourceTextHash: row.safeSourceHash,
        startOffset
      },
      chatId: row.chatId,
      evidenceId: row.evidenceId,
      sourceHash: source.sourceHash,
      sourceProjectionVersion: row.sourceProjectionVersion,
      sourceRevision: source.memorySourceRevision
    });
  }
  return {
    overflow,
    snapshot: inspected.map((row) => ({
      branchGeneration: row.branchGeneration,
      chatId: row.chatId,
      evidenceId: row.evidenceId,
      messageId: row.messageId,
      observedAt: row.observedAt.toISOString(),
      safeExcerpt: row.safeExcerpt,
      safeSourceHash: row.safeSourceHash,
      safetyClass: row.safetyClass,
      sourceProjectionVersion: row.sourceProjectionVersion,
      sourceRole: row.sourceRole,
      sourceType: row.sourceType
    })),
    valid
  };
}

function localSnapshotHash(
  kind: MemoryGlobalDreamLocalSelection["kind"],
  fact: CurrentFactRow,
  evidence: EvidenceInspection
): string {
  return memorySha256({
    evidence: evidence.snapshot,
    validEvidence: evidence.valid.map((item) => ({
      branchGeneration: item.branchGeneration,
      chatId: item.chatId,
      evidenceId: item.evidenceId,
      sourceHash: item.sourceHash,
      sourceProjectionVersion: item.sourceProjectionVersion,
      sourceRevision: item.sourceRevision
    })),
    fact: {
      canonicalKey: fact.canonicalKey,
      currentVersionId: fact.currentVersionId,
      factId: fact.factId,
      scopeId: fact.scopeId,
      sourceMode: fact.sourceMode,
      validTo: fact.validTo?.toISOString() ?? null
    },
    kind,
    version: 1
  });
}

export async function prepareGlobalDreamLocalSelection(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  settings: LockedMemorySettings,
  input: Readonly<{
    factId: string;
    kind: MemoryGlobalDreamLocalSelection["kind"];
    now: Date;
  }>
): Promise<MemoryGlobalDreamLocalSelection | null> {
  const fact = await loadGlobalDreamCurrentFact(tx, settings.userId, input.factId);
  if (
    !fact || fact.pinned || fact.sourceMode !== "AUTOMATIC" ||
    fact.sensitivityClass !== "NORMAL" ||
    await hasAnyExplicitVersion(tx, settings.userId, fact.factId)
  ) return null;
  const evidence = await inspectGlobalDreamEvidence(
    tx,
    keyring,
    fact,
    settings.userId,
    input.now
  );
  if (evidence.overflow) return null;
  if (input.kind === "RETRACT_INVALID") {
    if (evidence.valid.length > 0) return null;
  } else if (
    evidence.valid.length === 0 || !fact.validTo || fact.validTo > input.now
  ) return null;
  const snapshotHash = localSnapshotHash(input.kind, fact, evidence);
  return {
    factId: fact.factId,
    kind: input.kind,
    resultHash: memoryGlobalDreamResultHash({ kind: input.kind, snapshotHash }),
    snapshotHash,
    versionId: fact.currentVersionId
  };
}

type RelatedVersionRow = Readonly<{
  category: string;
  confidence: number;
  directness: MemoryRelatedFactVersionSnapshot["directness"];
  displayText: string | null;
  id: string;
  importance: number;
  languageCode: string;
  latestEvidenceAt: Date | null;
  modality: MemoryFactCandidateSnapshot["modality"];
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state: MemoryRelatedFactVersionSnapshot["state"];
  structuredValue: Prisma.JsonValue | null;
  supportCount: bigint;
  systemFrom: Date;
  systemTo: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
}>;

async function relatedFactSnapshot(
  tx: MemoryTransaction,
  fact: CurrentFactRow,
  userId: string,
  currentEvidence: readonly ValidEvidence[]
): Promise<MemoryRelatedFactSnapshot | null> {
  const scope = exactScope(fact);
  if (!scope) return null;
  const versions = await tx.$queryRaw<RelatedVersionRow[]>(Prisma.sql`
    SELECT
      version."id", version."displayText", version."languageCode",
      version."structuredValue", version."category", version."modality"::text AS "modality",
      version."sourceMode"::text AS "sourceMode", version."state"::text AS "state",
      version."validFrom", version."validTo", version."systemFrom", version."systemTo",
      version."confidence", version."importance", version."directness"::text AS "directness",
      count(evidence."id") FILTER (
        WHERE evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      ) AS "supportCount",
      max(evidence."observedAt") FILTER (
        WHERE evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      ) AS "latestEvidenceAt"
    FROM "MemoryFactVersion" AS version
    LEFT JOIN "MemoryEvidence" AS evidence
      ON evidence."userId" = version."userId"
      AND evidence."factVersionId" = version."id"
    WHERE version."userId" = ${userId}
      AND version."factId" = ${fact.factId}
      AND version."state" <> 'FORGOTTEN'::"MemoryFactVersionState"
      AND version."contentPurgedAt" IS NULL
    GROUP BY version."id"
    ORDER BY
      (version."id" = ${fact.currentVersionId}) DESC,
      version."systemFrom" DESC,
      version."id"
    LIMIT 3
  `);
  const latestCurrentEvidence = currentEvidence.reduce<Date | null>((latest, item) => {
    const observedAt = new Date(item.candidate.observedAt);
    return !latest || observedAt > latest ? observedAt : latest;
  }, null);
  const snapshots = versions.flatMap((version): MemoryRelatedFactVersionSnapshot[] => {
    if (version.displayText === null || version.structuredValue === null) return [];
    return [{
      category: version.category,
      confidence: version.confidence,
      directness: version.directness,
      displayText: version.displayText,
      id: version.id,
      importance: version.importance,
      languageCode: version.languageCode,
      latestEvidenceAt: version.id === fact.currentVersionId
        ? latestCurrentEvidence?.toISOString() ?? null
        : version.latestEvidenceAt?.toISOString() ?? null,
      modality: version.modality,
      sourceMode: version.sourceMode,
      state: version.state,
      structuredValue: version.structuredValue,
      supportCount: version.id === fact.currentVersionId
        ? currentEvidence.length
        : Number(version.supportCount),
      systemFrom: version.systemFrom.toISOString(),
      systemTo: version.systemTo?.toISOString() ?? null,
      validFrom: version.validFrom?.toISOString() ?? null,
      validTo: version.validTo?.toISOString() ?? null
    }];
  });
  return snapshots.some(({ id, state }) =>
    id === fact.currentVersionId && state === "ACTIVE"
  ) ? {
      canonicalKey: fact.canonicalKey,
      category: fact.category,
      currentVersionId: fact.currentVersionId,
      id: fact.factId,
      scope,
      state: "ACTIVE",
      versions: snapshots
    } : null;
}

export type MemoryGlobalDreamTargetContext = Readonly<{
  evidenceIds: readonly string[];
  related: MemoryRelatedFactSnapshot;
  snapshotHash: string;
  versionId: string;
}>;

export async function prepareGlobalDreamTargetContext(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  settings: LockedMemorySettings,
  factId: string,
  now: Date
): Promise<MemoryGlobalDreamTargetContext | null> {
  const fact = await loadGlobalDreamCurrentFact(tx, settings.userId, factId);
  if (
    !fact || fact.pinned || fact.sourceMode !== "AUTOMATIC" ||
    fact.sensitivityClass !== "NORMAL" ||
    await hasAnyExplicitVersion(tx, settings.userId, fact.factId)
  ) return null;
  const evidence = await inspectGlobalDreamEvidence(
    tx,
    keyring,
    fact,
    settings.userId,
    now
  );
  if (evidence.overflow || evidence.valid.length === 0) return null;
  const related = await relatedFactSnapshot(
    tx,
    fact,
    settings.userId,
    evidence.valid
  );
  if (!related) return null;
  return {
    evidenceIds: evidence.valid.map(({ evidenceId }) => evidenceId).sort(),
    related,
    snapshotHash: memorySha256({
      evidence: evidence.snapshot,
      factId: fact.factId,
      related,
      validEvidence: evidence.valid.map((item) => ({
        branchGeneration: item.branchGeneration,
        chatId: item.chatId,
        evidenceId: item.evidenceId,
        sourceHash: item.sourceHash,
        sourceProjectionVersion: item.sourceProjectionVersion,
        sourceRevision: item.sourceRevision
      })),
      version: 1
    }),
    versionId: fact.currentVersionId
  };
}

function scopeMayNarrow(
  source: MemoryFactCandidateScope,
  target: MemoryFactCandidateScope
): boolean {
  if (source.type === target.type && source.targetId === target.targetId) return true;
  return source.type === "GLOBAL_USER" && target.type !== "GLOBAL_USER";
}

function semanticPairSnapshotHash(input: Readonly<{
  candidateInput: MemoryFactConsolidationInput;
  source: CurrentFactRow;
  sourceEvidence: EvidenceInspection;
  target: CurrentFactRow;
  targetEvidence: EvidenceInspection;
}>): string {
  return memorySha256({
    inputHash: input.candidateInput.inputHash,
    source: {
      evidence: input.sourceEvidence.snapshot,
      factId: input.source.factId,
      scopeId: input.source.scopeId,
      validEvidence: input.sourceEvidence.valid.map((item) => ({
        branchGeneration: item.branchGeneration,
        chatId: item.chatId,
        evidenceId: item.evidenceId,
        sourceHash: item.sourceHash,
        sourceProjectionVersion: item.sourceProjectionVersion,
        sourceRevision: item.sourceRevision
      })),
      versionId: input.source.currentVersionId
    },
    target: {
      evidence: input.targetEvidence.snapshot,
      factId: input.target.factId,
      scopeId: input.target.scopeId,
      validEvidence: input.targetEvidence.valid.map((item) => ({
        branchGeneration: item.branchGeneration,
        chatId: item.chatId,
        evidenceId: item.evidenceId,
        sourceHash: item.sourceHash,
        sourceProjectionVersion: item.sourceProjectionVersion,
        sourceRevision: item.sourceRevision
      })),
      versionId: input.target.currentVersionId
    },
    type: "RECONCILE_PAIR",
    version: 1
  });
}

function candidateFromFact(input: Readonly<{
  evidence: readonly ValidEvidence[];
  source: CurrentFactRow;
  target: CurrentFactRow;
}>): MemoryFactCandidateSnapshot | null {
  const scope = exactScope(input.target);
  const sourceScope = exactScope(input.source);
  const latest = input.evidence[0];
  if (
    !scope || !sourceScope || !latest || !scopeMayNarrow(sourceScope, scope) ||
    input.source.directness !== "DIRECT" || input.source.sensitivityClass !== "NORMAL" ||
    input.source.sourceMode !== "AUTOMATIC" || input.source.category !== input.target.category ||
    input.source.sourceTimezone === null
  ) return null;
  const evidence = input.evidence
    .filter((item) =>
      item.chatId === latest.chatId &&
      item.branchGeneration === latest.branchGeneration &&
      item.sourceHash === latest.sourceHash &&
      item.sourceProjectionVersion === latest.sourceProjectionVersion &&
      item.sourceRevision === latest.sourceRevision)
    .slice(0, MEMORY_GLOBAL_DREAM_MAX_EVIDENCE)
    .map(({ candidate }) => candidate);
  if (evidence.length === 0) return null;
  const withoutId: Omit<MemoryFactCandidateSnapshot, "id"> = {
    branchGeneration: latest.branchGeneration,
    canonicalKey: input.target.canonicalKey,
    category: input.source.category,
    chatId: latest.chatId,
    confidence: input.source.confidence,
    directness: "DIRECT",
    displayText: input.source.displayText,
    evidence,
    importance: input.source.importance,
    languageCode: input.source.languageCode,
    modality: input.source.modality,
    negated: false,
    proposedValue: input.source.structuredValue,
    rawTemporalExpression: input.source.rawTemporalExpression,
    scope,
    sensitivity: "NORMAL",
    sourceHash: latest.sourceHash,
    sourceProjectionVersion: latest.sourceProjectionVersion,
    sourceRevision: latest.sourceRevision,
    sourceTimezone: input.source.sourceTimezone,
    temporalResolverVersion: input.source.temporalResolverVersion,
    temporalResolutionEvidence: temporalEvidence(input.source.temporalResolutionEvidence),
    validFrom: input.source.validFrom?.toISOString() ?? null,
    validTo: input.source.validTo?.toISOString() ?? null
  };
  return {
    ...withoutId,
    id: memorySha256({
      domain: "aiqsa.memory.global-dream-pair-candidate",
      sourceFactId: input.source.factId,
      sourceVersionId: input.source.currentVersionId,
      targetFactId: input.target.factId,
      targetVersionId: input.target.currentVersionId,
      value: withoutId,
      version: 1
    })
  };
}

export async function prepareGlobalDreamPairSelection(
  tx: MemoryTransaction,
  keyring: MemorySuppressionKeyring,
  settings: LockedMemorySettings,
  input: Readonly<{
    now: Date;
    sourceFactId: string;
    targetFactId: string;
  }>
): Promise<MemoryGlobalDreamSemanticSelection | null> {
  if (input.sourceFactId === input.targetFactId) return null;
  const orderedIds = [input.sourceFactId, input.targetFactId].sort();
  const first = await loadGlobalDreamCurrentFact(tx, settings.userId, orderedIds[0]!);
  const second = await loadGlobalDreamCurrentFact(tx, settings.userId, orderedIds[1]!);
  const source = input.sourceFactId === orderedIds[0] ? first : second;
  const target = input.targetFactId === orderedIds[0] ? first : second;
  if (
    !source || !target || source.pinned || target.pinned ||
    source.sourceMode !== "AUTOMATIC" ||
    target.sourceMode !== "AUTOMATIC" || source.sensitivityClass !== "NORMAL" ||
    target.sensitivityClass !== "NORMAL" || source.category !== target.category
  ) return null;
  const sourceExplicit = await hasAnyExplicitVersion(
    tx,
    settings.userId,
    source.factId
  );
  const targetExplicit = await hasAnyExplicitVersion(
    tx,
    settings.userId,
    target.factId
  );
  if (sourceExplicit || targetExplicit) return null;
  const sourceEvidence = await inspectGlobalDreamEvidence(
    tx,
    keyring,
    source,
    settings.userId,
    input.now
  );
  const targetEvidence = await inspectGlobalDreamEvidence(
    tx,
    keyring,
    target,
    settings.userId,
    input.now
  );
  if (
    sourceEvidence.overflow || targetEvidence.overflow ||
    sourceEvidence.valid.length === 0 || targetEvidence.valid.length === 0
  ) return null;
  const sourceChats = new Set(sourceEvidence.valid.map(({ chatId }) => chatId));
  if (!targetEvidence.valid.some(({ chatId }) => !sourceChats.has(chatId))) return null;
  const candidate = candidateFromFact({
    evidence: sourceEvidence.valid,
    source,
    target
  });
  const related = await relatedFactSnapshot(
    tx,
    target,
    settings.userId,
    targetEvidence.valid
  );
  if (!candidate || !related) return null;
  const relatedFacts = [related];
  const relatedSnapshotHash = memoryFactRelatedSnapshotHash(relatedFacts);
  const withoutHash: Omit<MemoryFactConsolidationInput, "inputHash"> = {
    candidate,
    relatedFacts,
    relatedSnapshotHash
  };
  const candidateInput: MemoryFactConsolidationInput = {
    ...withoutHash,
    inputHash: memoryFactConsolidationInputHash(withoutHash)
  };
  const snapshotHash = semanticPairSnapshotHash({
    candidateInput,
    source,
    sourceEvidence,
    target,
    targetEvidence
  });
  return {
    input: candidateInput,
    kind: "RECONCILE_PAIR",
    resultHash: memoryGlobalDreamResultHash({
      inputHash: candidateInput.inputHash,
      kind: "RECONCILE_PAIR",
      snapshotHash
    }),
    scopeChanged: source.scopeType !== target.scopeType ||
      source.scopeTargetId !== target.scopeTargetId,
    snapshotHash,
    sourceEvidenceIds: sourceEvidence.valid.map(({ evidenceId }) => evidenceId).sort(),
    sourceFactId: source.factId,
    sourceVersionId: source.currentVersionId,
    targetEvidenceIds: targetEvidence.valid.map(({ evidenceId }) => evidenceId).sort(),
    targetFactId: target.factId,
    targetVersionId: target.currentVersionId
  };
}

export function memoryGlobalDreamPairLooksRelated(
  left: Readonly<{ displayText: string; structuredValue: unknown }>,
  right: Readonly<{ displayText: string; structuredValue: unknown }>
): boolean {
  try {
    if (memoryStableJson(left.structuredValue) === memoryStableJson(right.structuredValue)) {
      return true;
    }
  } catch {
    return false;
  }
  const leftTerms = new Set(normalizeMemorySearchText(left.displayText).split(" ")
    .filter((term) => term.length >= 3));
  const rightTerms = new Set(normalizeMemorySearchText(right.displayText).split(" ")
    .filter((term) => term.length >= 3));
  const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  return overlap >= 2 || (
    overlap === 1 && leftTerms.size === 1 && rightTerms.size === 1
  );
}
