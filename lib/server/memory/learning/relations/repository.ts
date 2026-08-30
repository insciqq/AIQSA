import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../../prisma";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type {
  MemoryJobClaim,
  MemoryJobDescriptor,
  MemoryJobGateDecision
} from "../../coordinator/types";
import {
  loadPersonalMemoryEvidenceSnapshots,
  memoryExactVNextDirectAuthorityPredicate
} from "../../persistence/eligibility";
import { memorySha256 } from "../../persistence/lexical";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../../persistence/transaction";
import { ensureClassifiedSearchEntry } from "../../persistence/factSearchEntry";
import {
  MEMORY_FACT_RELATION_PIPELINE_VERSION,
  MEMORY_FACT_RELATION_POLICY_VERSION,
  relationSnapshotHash,
  type MemoryRelationDecision,
  type MemoryRelationSnapshot,
  type MemoryRelationVersionSnapshot
} from "./policy";
import {
  decodeMemoryRelationProviderDecision,
  type MemoryRelationProviderResult
} from "./resolver";
import {
  decodeStoredMemorySemanticFrame,
  decodeStoredResolvedMemorySemanticAdjudication
} from "../extraction/adjudication";

type RelationReader = PrismaClient | Prisma.TransactionClient;

type RelationVersionRow = Readonly<{
  canonicalKey: string;
  dimensionKey: string | null;
  directness: "DIRECT" | "INFERRED" | "PARAPHRASED";
  expectedAt: Date | null;
  expiresAt: Date | null;
  factId: string;
  identityKind: "PROPOSITION" | "SLOT";
  mergedIntoVersionId: string | null;
  observedAt: Date | null;
  occurredAt: Date | null;
  predicateKey: string | null;
  semanticAdjudication: Prisma.JsonValue | null;
  semanticFrame: Prisma.JsonValue | null;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state: "ACTIVE" | "PENDING_RELATION";
  structuredValue: Prisma.JsonValue;
  subjectKey: string | null;
  supersedesVersionId: string | null;
  systemFrom: Date;
  validFrom: Date | null;
  validTo: Date | null;
  versionId: string;
}>;

type PendingFactRow = Readonly<{
  currentVersionId: string | null;
  factId: string;
  factState: string;
}>;

type RelationEntityRow = Readonly<{
  canonicalKey: string;
  entityType: string;
  factVersionId: string;
  role: "MENTION" | "OBJECT" | "SUBJECT";
}>;

export type PreparedMemoryRelation = Readonly<{
  snapshot: MemoryRelationSnapshot;
  snapshotHash: string;
}>;

export type MemoryRelationPrepareResult =
  | Readonly<{ reason: string; status: "TERMINAL" }>
  | Readonly<{ prepared: PreparedMemoryRelation; status: "READY" }>;

export type MemoryRelationApplyPlan = Readonly<{
  decision: MemoryRelationDecision;
  executionId: string | null;
  expectedSnapshotHash: string;
}>;

export type MemoryAuxiliaryCallReservation =
  | Readonly<{ status: "ACQUIRED" }>
  | Readonly<{ result: MemoryRelationProviderResult; status: "RECOVERED" }>
  | Readonly<{ status: "UNAVAILABLE" }>;

export type MemoryRelationRepository = Readonly<{
  apply(
    tx: MemoryTransaction,
    claim: MemoryJobClaim,
    plan: MemoryRelationApplyPlan,
    now: Date
  ): Promise<void>;
  auxiliaryCallAvailable(job: MemoryJobDescriptor): Promise<boolean>;
  preflight(job: MemoryJobDescriptor): Promise<MemoryJobGateDecision>;
  prepare(job: MemoryJobDescriptor, now: Date): Promise<MemoryRelationPrepareResult>;
  recordAuxiliaryResult(
    job: MemoryJobDescriptor,
    result: MemoryRelationProviderResult,
    now: Date
  ): Promise<void>;
  reserveAuxiliaryCall(
    job: MemoryJobDescriptor
  ): Promise<MemoryAuxiliaryCallReservation>;
  settleTerminal(
    tx: MemoryTransaction,
    claim: MemoryJobClaim,
    reason: string,
    now: Date
  ): Promise<void>;
}>;

const token = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,255}$/u;
const reasonCode = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,63}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function decodeStoredAuxiliaryResult(value: unknown): MemoryRelationProviderResult {
  const object = record(value);
  if (!object || Object.keys(object).sort().join("\u0000") !== [
    "acceptedOutputHash",
    "decision",
    "executionId",
    "inputHash",
    "modelId",
    "policyVersion",
    "providerId"
  ].join("\u0000") ||
    typeof object.acceptedOutputHash !== "string" ||
    !sha256.test(object.acceptedOutputHash) ||
    typeof object.inputHash !== "string" || !sha256.test(object.inputHash) ||
    !boundedString(object.executionId, 256) ||
    !boundedString(object.modelId, 256) ||
    !boundedString(object.policyVersion, 64) ||
    !boundedString(object.providerId, 64)) {
    throw new Error("memory_fact_relation_auxiliary_result_invalid");
  }
  return {
    acceptedOutputHash: object.acceptedOutputHash,
    decision: decodeMemoryRelationProviderDecision(object.decision),
    executionId: object.executionId,
    inputHash: object.inputHash,
    modelId: object.modelId,
    policyVersion: object.policyVersion,
    providerId: object.providerId
  };
}

function encodeStoredAuxiliaryResult(
  result: MemoryRelationProviderResult
): Prisma.InputJsonObject {
  return {
    acceptedOutputHash: result.acceptedOutputHash,
    decision: {
      confidence_band: result.decision.confidenceBand,
      operation: result.decision.operation,
      reason_code: result.decision.reasonCode,
      target_ref: result.decision.targetRef
    },
    executionId: result.executionId,
    inputHash: result.inputHash,
    modelId: result.modelId,
    policyVersion: result.policyVersion,
    providerId: result.providerId
  };
}

function validJob(job: MemoryJobDescriptor): boolean {
  return job.kind === "RESOLVE_FACT_RELATIONS" &&
    job.pipelineVersion === MEMORY_FACT_RELATION_PIPELINE_VERSION &&
    typeof job.targetFactVersionId === "string" &&
    token.test(job.targetFactVersionId) &&
    job.chatId !== null && job.sourceMessageId !== null &&
    Number.isSafeInteger(job.memoryGenerationSnapshot) &&
    job.memoryGenerationSnapshot >= 0;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function snapshotVersion(
  row: RelationVersionRow,
  ref: string,
  entities: readonly RelationEntityRow[]
): MemoryRelationVersionSnapshot {
  return Object.freeze({
    canonicalKey: row.canonicalKey,
    dimensionKey: row.dimensionKey,
    directness: row.directness,
    entities: Object.freeze(entities
      .filter(({ factVersionId }) => factVersionId === row.versionId)
      .map(({ canonicalKey, entityType, role }) =>
        Object.freeze({ canonicalKey, entityType, role }))),
    expectedAt: iso(row.expectedAt),
    expiresAt: iso(row.expiresAt),
    factId: row.factId,
    identityKind: row.identityKind,
    mergedIntoVersionId: row.mergedIntoVersionId,
    observedAt: iso(row.observedAt),
    occurredAt: iso(row.occurredAt),
    predicateKey: row.predicateKey,
    semanticAdjudication: decodeStoredResolvedMemorySemanticAdjudication(
      row.semanticAdjudication
    ),
    semanticFrame: decodeStoredMemorySemanticFrame(row.semanticFrame),
    ref,
    sourceMode: row.sourceMode,
    state: row.state,
    structuredValue: row.structuredValue,
    subjectKey: row.subjectKey,
    supersedesVersionId: row.supersedesVersionId,
    systemFrom: row.systemFrom.toISOString(),
    validFrom: iso(row.validFrom),
    validTo: iso(row.validTo),
    versionId: row.versionId
  });
}

const versionSelect = Prisma.sql`
  version."id" AS "versionId", version."factId",
  version."structuredValue", version."sourceMode"::text AS "sourceMode",
  version."state"::text AS "state", version."directness"::text AS "directness",
  version."observedAt",
  version."occurredAt", version."expectedAt", version."expiresAt",
  version."validFrom", version."validTo", version."systemFrom",
  version."semanticFrame", version."semanticAdjudication",
  version."supersedesVersionId", version."mergedIntoVersionId", fact."canonicalKey",
  fact."identityKind"::text AS "identityKind", fact."subjectKey",
  fact."predicateKey", fact."dimensionKey"
`;

async function loadPreparedRelation(
  db: RelationReader,
  job: MemoryJobDescriptor,
  now: Date
): Promise<MemoryRelationPrepareResult> {
  if (!validJob(job) || !Number.isFinite(now.getTime())) {
    return { reason: "relation_job_invalid", status: "TERMINAL" };
  }
  const targetId = job.targetFactVersionId!;
  const pendingFacts = await db.$queryRaw<PendingFactRow[]>(Prisma.sql`
    SELECT
      fact."id" AS "factId", fact."currentVersionId",
      fact."state"::text AS "factState"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE version."userId" = ${job.userId}
      AND version."id" = ${targetId}
      AND version."state" = 'PENDING_RELATION'::"MemoryFactVersionState"
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
      AND ${memoryExactVNextDirectAuthorityPredicate(job.userId)}
  `);
  const pendingFact = pendingFacts[0];
  if (!pendingFact) {
    const target = await db.memoryFactVersion.findFirst({
      select: { state: true },
      where: { id: targetId, userId: job.userId }
    });
    return {
      reason: target ? `relation_target_${target.state.toLocaleLowerCase("en-US")}` :
        "relation_target_missing",
      status: "TERMINAL"
    };
  }

  const correction = await db.memoryFactVersionSourceDependency.findFirst({
    orderBy: { id: "asc" },
    select: { sourceFactVersionId: true, sourceMessageId: true },
    where: {
      dependencyKind: "CORRECTION_TARGET",
      targetFactVersionId: targetId,
      userId: job.userId
    }
  });
  let correctionTargetVersionId = correction?.sourceFactVersionId ?? null;
  if (correctionTargetVersionId === null && correction?.sourceMessageId) {
    const targets = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT DISTINCT source_version."id"
      FROM "MemoryEvidence" AS source_evidence
      INNER JOIN "MemoryFactVersion" AS source_version
        ON source_version."userId" = source_evidence."userId"
        AND source_version."id" = source_evidence."factVersionId"
        AND source_version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND source_version."systemTo" IS NULL
      INNER JOIN "MemoryFact" AS source_fact
        ON source_fact."userId" = source_version."userId"
        AND source_fact."id" = source_version."factId"
        AND source_fact."state" = 'ACTIVE'::"MemoryFactState"
        AND source_fact."currentVersionId" = source_version."id"
      INNER JOIN "MemoryFact" AS pending_fact
        ON pending_fact."userId" = ${job.userId}
        AND pending_fact."id" = ${pendingFact.factId}
      WHERE source_evidence."userId" = ${job.userId}
        AND source_evidence."messageId" = ${correction.sourceMessageId}
        AND source_evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
        AND source_fact."predicateKey" IS NOT DISTINCT FROM pending_fact."predicateKey"
      ORDER BY source_version."id"
      LIMIT 2
    `);
    correctionTargetVersionId = targets.length === 1 ? targets[0]!.id : null;
  }
  let currentVersionId = pendingFact.currentVersionId ??
    correctionTargetVersionId;
  if (currentVersionId === null) {
    const candidates = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT version."id"
      FROM "MemoryFactVersion" AS pending_version
      INNER JOIN "MemoryFact" AS pending_fact
        ON pending_fact."userId" = pending_version."userId"
        AND pending_fact."id" = pending_version."factId"
      INNER JOIN "MemoryFact" AS active_fact
        ON active_fact."userId" = pending_fact."userId"
        AND active_fact."id" <> pending_fact."id"
        AND active_fact."state" = 'ACTIVE'::"MemoryFactState"
        AND active_fact."predicateKey" IS NOT DISTINCT FROM pending_fact."predicateKey"
        AND active_fact."dimensionKey" IS NOT DISTINCT FROM pending_fact."dimensionKey"
      INNER JOIN "MemoryFactVersion" AS version
        ON version."userId" = active_fact."userId"
        AND version."id" = active_fact."currentVersionId"
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
      WHERE pending_version."userId" = ${job.userId}
        AND pending_version."id" = ${targetId}
        AND (
          active_fact."subjectKey" IS NOT DISTINCT FROM pending_fact."subjectKey"
          OR EXISTS (
            SELECT 1
            FROM "MemoryFactVersionEntity" AS pending_entity
            INNER JOIN "MemoryFactVersionEntity" AS active_entity
              ON active_entity."userId" = pending_entity."userId"
              AND aiqsa_memory_entity_root_id(
                active_entity."userId", active_entity."entityId"
              ) = aiqsa_memory_entity_root_id(
                pending_entity."userId", pending_entity."entityId"
              )
              AND aiqsa_memory_entity_root_id(
                pending_entity."userId", pending_entity."entityId"
              ) IS NOT NULL
              AND active_entity."role" = 'SUBJECT'::"MemoryEntityLinkRole"
            WHERE pending_entity."userId" = pending_version."userId"
              AND pending_entity."factVersionId" = pending_version."id"
              AND pending_entity."role" = 'SUBJECT'::"MemoryEntityLinkRole"
              AND active_entity."factVersionId" = version."id"
          )
        )
        AND ${memoryExactVNextDirectAuthorityPredicate(job.userId)}
      ORDER BY
        CASE WHEN active_fact."subjectKey" IS NOT DISTINCT FROM pending_fact."subjectKey"
          THEN 0 ELSE 1 END,
        version."observedAt" DESC NULLS LAST,
        version."id"
      LIMIT 2
    `);
    currentVersionId = candidates.length === 1 ? candidates[0]!.id : null;
  }
  if (!currentVersionId || currentVersionId === targetId) {
    return { reason: "relation_current_missing", status: "TERMINAL" };
  }

  const pendingRows = await db.$queryRaw<RelationVersionRow[]>(Prisma.sql`
    SELECT ${versionSelect}
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
    WHERE version."userId" = ${job.userId}
      AND version."id" = ${targetId}
      AND version."state" = 'PENDING_RELATION'::"MemoryFactVersionState"
  `);
  const currentRows = await db.$queryRaw<RelationVersionRow[]>(Prisma.sql`
    SELECT ${versionSelect}
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
      AND fact."currentVersionId" = version."id"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    WHERE version."userId" = ${job.userId}
      AND version."id" = ${currentVersionId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND ${memoryExactVNextDirectAuthorityPredicate(job.userId)}
  `);
  const pending = pendingRows[0];
  const current = currentRows[0];
  if (!pending || !current) {
    return { reason: "relation_current_ineligible", status: "TERMINAL" };
  }
  if (pending.factId === current.factId &&
    pendingFact.currentVersionId !== current.versionId) {
    return { reason: "relation_current_stale", status: "TERMINAL" };
  }
  if (pending.factId !== current.factId &&
    correctionTargetVersionId !== current.versionId &&
    pendingFact.currentVersionId !== null) {
    return { reason: "relation_correction_target_stale", status: "TERMINAL" };
  }

  const evidenceRows = await loadPersonalMemoryEvidenceSnapshots(
    db,
    job.userId,
    [targetId],
    { exactVNext: true }
  );
  const sourceEvidence = evidenceRows.find(({ messageId }) =>
    messageId === job.sourceMessageId);
  if (!sourceEvidence) {
    return { reason: "relation_source_missing", status: "TERMINAL" };
  }
  const relatedRows = await db.$queryRaw<RelationVersionRow[]>(Prisma.sql`
    SELECT ${versionSelect}
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId" AND fact."id" = version."factId"
      AND fact."currentVersionId" = version."id"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryFactVersion" AS pending_version
      ON pending_version."userId" = version."userId"
      AND pending_version."id" = ${pending.versionId}
    WHERE version."userId" = ${job.userId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."structuredValue" IS NOT NULL
      AND (
        version."id" = ${current.versionId}
        OR version."expiresAt" IS NULL
        OR version."expiresAt" > ${now}
      )
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND (
        version."id" = ${current.versionId}
        OR (
          fact."identityKind" = 'SLOT'::"MemoryFactIdentityKind"
          AND fact."subjectKey" IS NOT DISTINCT FROM ${pending.subjectKey}
          AND fact."predicateKey" IS NOT DISTINCT FROM ${pending.predicateKey}
          AND fact."dimensionKey" IS NOT DISTINCT FROM ${pending.dimensionKey}
        )
        OR EXISTS (
          SELECT 1
          FROM "MemoryFactVersionEntity" AS candidate_entity
          INNER JOIN "MemoryFactVersionEntity" AS pending_entity
            ON pending_entity."userId" = candidate_entity."userId"
            AND aiqsa_memory_entity_root_id(
              pending_entity."userId", pending_entity."entityId"
            ) = aiqsa_memory_entity_root_id(
              candidate_entity."userId", candidate_entity."entityId"
            )
            AND aiqsa_memory_entity_root_id(
              candidate_entity."userId", candidate_entity."entityId"
            ) IS NOT NULL
          WHERE candidate_entity."userId" = version."userId"
            AND candidate_entity."factVersionId" = version."id"
            AND pending_entity."factVersionId" = ${pending.versionId}
        )
        OR (
          fact."predicateKey" IS NOT DISTINCT FROM ${pending.predicateKey}
          AND fact."dimensionKey" IS NOT DISTINCT FROM ${pending.dimensionKey}
          AND version."observedAt" >= ${now} - INTERVAL '365 days'
        )
        OR to_tsvector('simple', COALESCE(version."normalizedSearchText", ''))
          @@ plainto_tsquery('simple', COALESCE(
            pending_version."normalizedSearchText", ''
          ))
      )
      AND ${memoryExactVNextDirectAuthorityPredicate(job.userId)}
    ORDER BY
      CASE WHEN version."id" = ${current.versionId} THEN 0 ELSE 1 END,
      CASE WHEN version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
        THEN 0 ELSE 1 END,
      version."observedAt" DESC NULLS LAST,
      version."id"
    LIMIT 12
  `);
  const deduplicated = [current, ...relatedRows.filter(({ versionId }) =>
    versionId !== current.versionId)].slice(0, 12);
  const versionIds = [pending.versionId, ...deduplicated.map(({ versionId }) =>
    versionId)];
  const entityRows = await db.$queryRaw<RelationEntityRow[]>(Prisma.sql`
    SELECT
      link."factVersionId", link."role"::text AS "role",
      entity."canonicalKey", entity."entityType"
    FROM "MemoryFactVersionEntity" AS link
    INNER JOIN "MemoryEntity" AS entity
      ON entity."userId" = link."userId"
      AND entity."id" = aiqsa_memory_entity_root_id(
        link."userId", link."entityId"
      )
    WHERE link."userId" = ${job.userId}
      AND link."factVersionId" IN (${Prisma.join(versionIds)})
    ORDER BY link."factVersionId", link."role", entity."canonicalKey"
    LIMIT 64
  `);
  const related = deduplicated.map((row, index) =>
    snapshotVersion(row, `R${index + 1}`, entityRows));
  const dependencies = await db.memoryFactVersionSourceDependency.findMany({
    orderBy: [{ dependencyKind: "asc" }, { id: "asc" }],
    select: {
      dependencyKind: true,
      id: true,
      sourceFactVersionId: true,
      sourceMessageContentHash: true,
      sourceMessageId: true,
      sourceMessageUpdatedAt: true,
      sourceProjectionVersion: true
    },
    where: { targetFactVersionId: targetId, userId: job.userId }
  });
  const relationRows = await db.memoryFactVersionRelation.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      sourceVersionId: true,
      targetVersionId: true
    },
    take: 64,
    where: {
      OR: [
        { sourceVersionId: { in: versionIds } },
        { targetVersionId: { in: versionIds } }
      ],
      userId: job.userId
    }
  });
  const settings = await db.userMemorySettings.findUnique({
    select: { memoryGeneration: true, memoryRevision: true },
    where: { userId: job.userId }
  });
  if (!settings || settings.memoryGeneration !== job.memoryGenerationSnapshot) {
    return { reason: "relation_generation_stale", status: "TERMINAL" };
  }
  const snapshot: MemoryRelationSnapshot = Object.freeze({
    correctionTargetVersionId,
    current: related[0]!,
    dependencies: Object.freeze(dependencies.map((dependency) => Object.freeze({
      dependencyId: dependency.id,
      dependencyKind: dependency.dependencyKind,
      sourceFactVersionId: dependency.sourceFactVersionId,
      sourceMessageContentHash: dependency.sourceMessageContentHash,
      sourceMessageId: dependency.sourceMessageId,
      sourceMessageUpdatedAt: iso(dependency.sourceMessageUpdatedAt),
      sourceProjectionVersion: dependency.sourceProjectionVersion
    }))),
    evidence: Object.freeze(evidenceRows.map((evidence) => Object.freeze({
      branchGeneration: evidence.branchGeneration,
      evidenceFingerprint: evidence.evidenceFingerprint,
      evidenceId: evidence.id,
      messageId: evidence.messageId,
      observedAt: evidence.observedAt.toISOString(),
      safeSourceHash: evidence.safeSourceHash,
      sourceMessageContentHash: evidence.sourceMessageContentHash,
      sourceProjectionVersion: evidence.sourceProjectionVersion
    }))),
    memoryGeneration: settings.memoryGeneration,
    memoryRevision: settings.memoryRevision,
    pending: snapshotVersion(pending, "P0", entityRows),
    related: Object.freeze(related),
    relations: Object.freeze(relationRows.map((relation) => Object.freeze({
      kind: relation.kind,
      relationId: relation.id,
      sourceVersionId: relation.sourceVersionId,
      targetVersionId: relation.targetVersionId
    }))),
    sourceIdentity: Object.freeze({
      activeLeafMessageId: job.activeLeafMessageId,
      branchGeneration: job.branchGeneration,
      chatId: job.chatId!,
      sourceHash: job.sourceHash,
      sourceMessageId: job.sourceMessageId!,
      sourceRevision: job.sourceRevision
    })
  });
  return {
    prepared: Object.freeze({ snapshot, snapshotHash: relationSnapshotHash(snapshot) }),
    status: "READY"
  };
}

function closedAt(now: Date, systemFrom: string): Date {
  return new Date(Math.max(now.getTime(), new Date(systemFrom).getTime() + 1));
}

async function lockRelationGraph(
  tx: MemoryTransaction,
  userId: string,
  snapshot: MemoryRelationSnapshot
): Promise<void> {
  const factIds = [...new Set([
    snapshot.current.factId,
    snapshot.pending.factId,
    ...snapshot.related.map(({ factId }) => factId)
  ])].sort();
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryFact"
    WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(factIds)})
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryFactVersion"
    WHERE "userId" = ${userId} AND "id" = ${snapshot.current.versionId}
    FOR UPDATE
  `);
  const otherVersionIds = snapshot.related
    .map(({ versionId }) => versionId)
    .filter((versionId) => versionId !== snapshot.current.versionId &&
      versionId !== snapshot.pending.versionId)
    .sort();
  if (otherVersionIds.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "MemoryFactVersion"
      WHERE "userId" = ${userId}
        AND "id" IN (${Prisma.join(otherVersionIds)})
      ORDER BY "id"
      FOR UPDATE
    `);
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryFactVersion"
    WHERE "userId" = ${userId} AND "id" = ${snapshot.pending.versionId}
    FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryFactVersionSourceDependency"
    WHERE "userId" = ${userId}
      AND "targetFactVersionId" = ${snapshot.pending.versionId}
    ORDER BY "id"
    FOR SHARE
  `);
  const versionIds = [...new Set([
    snapshot.current.versionId,
    snapshot.pending.versionId,
    ...snapshot.related.map(({ versionId }) => versionId)
  ])].sort();
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MemoryEvidence"
    WHERE "userId" = ${userId}
      AND "factVersionId" IN (${Prisma.join(versionIds)})
    ORDER BY "id"
    FOR SHARE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT link."factVersionId", link."entityId", link."role"
    FROM "MemoryFactVersionEntity" AS link
    WHERE link."userId" = ${userId}
      AND link."factVersionId" IN (${Prisma.join(versionIds)})
    ORDER BY link."factVersionId", link."entityId", link."role"
    FOR SHARE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT entity."id"
    FROM "MemoryEntity" AS entity
    WHERE entity."userId" = ${userId}
      AND entity."id" IN (
        SELECT link."entityId"
        FROM "MemoryFactVersionEntity" AS link
        WHERE link."userId" = ${userId}
          AND link."factVersionId" IN (${Prisma.join(versionIds)})
      )
    ORDER BY entity."id"
    FOR SHARE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT relation."id"
    FROM "MemoryFactVersionRelation" AS relation
    WHERE relation."userId" = ${userId}
      AND (
        relation."sourceVersionId" IN (${Prisma.join(versionIds)})
        OR relation."targetVersionId" IN (${Prisma.join(versionIds)})
      )
    ORDER BY relation."id"
    FOR SHARE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT entry."id"
    FROM "MemorySearchEntry" AS entry
    WHERE entry."userId" = ${userId}
      AND entry."factVersionId" IN (${Prisma.join(versionIds)})
    ORDER BY entry."id"
    FOR UPDATE
  `);
}

async function createRelationEvent(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  plan: MemoryRelationApplyPlan,
  snapshot: MemoryRelationSnapshot
): Promise<void> {
  const operation = plan.decision.operation.startsWith("MERGE_")
    ? "MERGE" as const
    : plan.decision.operation === "SUPERSEDE_TARGET" ||
        plan.decision.operation === "MOVE_TO_DISTINCT_FACT"
      ? "SUPERSEDE" as const
      : plan.decision.operation === "EXPIRE"
        ? "EXPIRE" as const
        : plan.decision.operation === "ACTIVATE_AFTER_EXPIRY"
          ? "PROMOTE" as const
        : "CONFLICT" as const;
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId: snapshot.pending.factId,
      factVersionId: snapshot.pending.versionId,
      id: relationEventId(claim.id, plan),
      metadata: {
        executionId: plan.executionId,
        pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
        reasonCode: plan.decision.reasonCode,
        relationOperation: plan.decision.operation,
        relationSnapshotHash: plan.expectedSnapshotHash,
        schemaVersion: "memory-fact-relation-event-v2",
        targetVersionId: plan.decision.targetVersionId
      },
      operation,
      sourceChatId: claim.chatId,
      sourceGeneration: claim.branchGeneration,
      userId: claim.userId
    }
  });
}

async function createCurrentExpirationEvent(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  plan: MemoryRelationApplyPlan,
  snapshot: MemoryRelationSnapshot
): Promise<void> {
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId: snapshot.current.factId,
      factVersionId: snapshot.current.versionId,
      id: memorySha256({
        domain: "aiqsa.memory.fact-relation-expiration-event",
        jobId: claim.id,
        snapshotHash: plan.expectedSnapshotHash,
        version: 1
      }),
      metadata: {
        replacementVersionId: snapshot.pending.versionId,
        schemaVersion: "memory-fact-relation-expiration-v1"
      },
      operation: "EXPIRE",
      sourceChatId: claim.chatId,
      sourceGeneration: claim.branchGeneration,
      userId: claim.userId
    }
  });
}

function relationEventId(
  jobId: string,
  plan: MemoryRelationApplyPlan
): string {
  return memorySha256({
    domain: "aiqsa.memory.fact-relation-event",
    jobId,
    operation: plan.decision.operation,
    snapshotHash: plan.expectedSnapshotHash,
    version: 2
  });
}

function terminalResolutionHash(
  claim: MemoryJobClaim,
  reason: string
): string {
  return memorySha256({
    domain: "aiqsa.memory.fact-relation-terminal-resolution",
    jobId: claim.id,
    memoryGeneration: claim.memoryGenerationSnapshot,
    reason,
    sourceMessageId: claim.sourceMessageId,
    targetFactVersionId: claim.targetFactVersionId,
    version: 1
  });
}

function terminalRelationEventId(
  claim: MemoryJobClaim,
  resolutionHash: string
): string {
  return memorySha256({
    domain: "aiqsa.memory.fact-relation-terminal-event",
    jobId: claim.id,
    resolutionHash,
    version: 1
  });
}

async function createVersionRelation(
  tx: MemoryTransaction,
  input: Readonly<{
    confidence: number;
    executionId: string | null;
    kind: "DUPLICATE_OF" | "ENRICHES" | "MERGED_INTO" | "MOVED_FROM";
    reasonCode: string;
    sourceVersionId: string;
    targetVersionId: string;
    userId: string;
  }>
): Promise<void> {
  await tx.memoryFactVersionRelation.create({
    data: {
      confidence: input.confidence,
      executionId: input.executionId,
      id: memorySha256({
        domain: "aiqsa.memory.fact-version-relation",
        kind: input.kind,
        sourceVersionId: input.sourceVersionId,
        targetVersionId: input.targetVersionId,
        userId: input.userId,
        version: 1
      }),
      kind: input.kind,
      pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
      reasonCode: input.reasonCode,
      sourceVersionId: input.sourceVersionId,
      targetVersionId: input.targetVersionId,
      userId: input.userId
    }
  });
}

async function applyRelation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryRelationApplyPlan,
  snapshot: MemoryRelationSnapshot,
  now: Date
): Promise<void> {
  const pending = snapshot.pending;
  const current = snapshot.current;
  const closePendingAt = closedAt(now, pending.systemFrom);
  const closeCurrentAt = closedAt(now, current.systemFrom);
  const resolution = {
    relationResolutionVersion: MEMORY_FACT_RELATION_POLICY_VERSION,
    relationResolvedAt: now,
    relationSnapshotHash: plan.expectedSnapshotHash
  };
  await tx.memorySearchEntry.deleteMany({
    where: { factVersionId: pending.versionId, userId: claim.userId }
  });
  if ([
    "MERGE_TARGET_INTO_NEW",
    "ACTIVATE_AFTER_EXPIRY"
  ].includes(plan.decision.operation) ||
    (plan.decision.operation === "EXPIRE" && current.expiresAt !== null &&
      new Date(current.expiresAt) <= now)) {
    await tx.memorySearchEntry.deleteMany({
      where: { factVersionId: current.versionId, userId: claim.userId }
    });
  }

  if (plan.decision.operation === "CONFLICT" ||
    plan.decision.operation === "AMBIGUOUS") {
    const changed = await tx.memoryFactVersion.updateMany({
      data: { ...resolution, state: "CONFLICTING", systemTo: closePendingAt },
      where: {
        id: pending.versionId,
        state: "PENDING_RELATION",
        userId: claim.userId
      }
    });
    if (changed.count !== 1) throw new MemoryCoordinatorError(
      "memory_fact_relation_snapshot_stale", true);
  } else if (plan.decision.operation === "EXPIRE") {
    const changed = await tx.memoryFactVersion.updateMany({
      data: { ...resolution, state: "EXPIRED", systemTo: closePendingAt },
      where: {
        id: pending.versionId,
        state: "PENDING_RELATION",
        userId: claim.userId
      }
    });
    if (changed.count !== 1) throw new MemoryCoordinatorError(
      "memory_fact_relation_snapshot_stale", true);
    if (current.expiresAt !== null && new Date(current.expiresAt) <= now) {
      const retired = await tx.memoryFactVersion.updateMany({
        data: { state: "EXPIRED", systemTo: closeCurrentAt },
        where: {
          factId: current.factId,
          id: current.versionId,
          state: "ACTIVE",
          systemTo: null,
          userId: claim.userId
        }
      });
      const cleared = await tx.memoryFact.updateMany({
        data: { currentVersionId: null, state: "EXPIRED", updatedAt: now },
        where: {
          currentVersionId: current.versionId,
          id: current.factId,
          state: "ACTIVE",
          userId: claim.userId
        }
      });
      if (retired.count !== 1 || cleared.count !== 1) {
        throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
      }
      await createCurrentExpirationEvent(tx, claim, plan, snapshot);
    }
  } else if (plan.decision.operation === "ACTIVATE_AFTER_EXPIRY") {
    if (pending.factId !== current.factId || current.expiresAt === null ||
      new Date(current.expiresAt) > now) {
      throw new Error("memory_fact_relation_invalid");
    }
    const retired = await tx.memoryFactVersion.updateMany({
      data: { state: "EXPIRED", systemTo: closeCurrentAt },
      where: {
        factId: current.factId,
        id: current.versionId,
        state: "ACTIVE",
        systemTo: null,
        userId: claim.userId
      }
    });
    const activated = await tx.memoryFactVersion.updateMany({
      data: { ...resolution, state: "ACTIVE", systemTo: null },
      where: {
        factId: pending.factId,
        id: pending.versionId,
        state: "PENDING_RELATION",
        userId: claim.userId
      }
    });
    const pointed = await tx.memoryFact.updateMany({
      data: {
        currentVersionId: pending.versionId,
        lastConfirmedAt: pending.observedAt ? new Date(pending.observedAt) : now,
        updatedAt: now
      },
      where: {
        currentVersionId: current.versionId,
        id: current.factId,
        state: "ACTIVE",
        userId: claim.userId
      }
    });
    if (retired.count !== 1 || activated.count !== 1 || pointed.count !== 1) {
      throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
    }
    await createCurrentExpirationEvent(tx, claim, plan, snapshot);
  } else if (plan.decision.operation === "MERGE_NEW_INTO_TARGET") {
    const changed = await tx.memoryFactVersion.updateMany({
      data: {
        ...resolution,
        mergedIntoVersionId: current.versionId,
        state: "MERGED",
        systemTo: closePendingAt
      },
      where: {
        id: pending.versionId,
        state: "PENDING_RELATION",
        userId: claim.userId
      }
    });
    if (changed.count !== 1) throw new MemoryCoordinatorError(
      "memory_fact_relation_snapshot_stale", true);
    if (pending.factId !== current.factId) {
      const redundantFact = await tx.memoryFact.updateMany({
        data: {
          currentVersionId: null,
          movedToFactId: current.factId,
          state: "RETRACTED",
          updatedAt: now
        },
        where: {
          currentVersionId: null,
          id: pending.factId,
          state: "CONFLICTED",
          userId: claim.userId
        }
      });
      if (redundantFact.count !== 1) {
        throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
      }
    }
    await createVersionRelation(tx, {
      confidence: plan.decision.confidence,
      executionId: plan.executionId,
      kind: "MERGED_INTO",
      reasonCode: plan.decision.reasonCode,
      sourceVersionId: pending.versionId,
      targetVersionId: current.versionId,
      userId: claim.userId
    });
  } else if (plan.decision.operation === "MERGE_TARGET_INTO_NEW") {
    const retired = await tx.memoryFactVersion.updateMany({
      data: {
        mergedIntoVersionId: pending.versionId,
        state: "MERGED",
        systemTo: closeCurrentAt
      },
      where: {
        factId: current.factId,
        id: current.versionId,
        state: "ACTIVE",
        systemTo: null,
        userId: claim.userId
      }
    });
    const activated = await tx.memoryFactVersion.updateMany({
      data: {
        ...resolution,
        state: "ACTIVE",
        supersedesVersionId: null,
        systemTo: null
      },
      where: {
        factId: pending.factId,
        id: pending.versionId,
        state: "PENDING_RELATION",
        userId: claim.userId
      }
    });
    let factChanges = 0;
    if (pending.factId === current.factId) {
      const pointed = await tx.memoryFact.updateMany({
        data: {
          currentVersionId: pending.versionId,
          lastConfirmedAt: pending.observedAt ? new Date(pending.observedAt) : now,
          updatedAt: now
        },
        where: {
          currentVersionId: current.versionId,
          id: current.factId,
          state: "ACTIVE",
          userId: claim.userId
        }
      });
      factChanges = pointed.count;
    } else {
      const redundant = await tx.memoryFact.updateMany({
        data: {
          currentVersionId: null,
          movedToFactId: pending.factId,
          state: "RETRACTED",
          updatedAt: now
        },
        where: {
          currentVersionId: current.versionId,
          id: current.factId,
          state: "ACTIVE",
          userId: claim.userId
        }
      });
      const canonical = await tx.memoryFact.updateMany({
        data: {
          currentVersionId: pending.versionId,
          lastConfirmedAt: pending.observedAt ? new Date(pending.observedAt) : now,
          state: "ACTIVE",
          updatedAt: now
        },
        where: {
          currentVersionId: null,
          id: pending.factId,
          state: "CONFLICTED",
          userId: claim.userId
        }
      });
      factChanges = redundant.count + canonical.count;
    }
    const expectedFactChanges = pending.factId === current.factId ? 1 : 2;
    if (retired.count !== 1 || activated.count !== 1 ||
      factChanges !== expectedFactChanges) {
      throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
    }
    await createVersionRelation(tx, {
      confidence: plan.decision.confidence,
      executionId: plan.executionId,
      kind: "MERGED_INTO",
      reasonCode: plan.decision.reasonCode,
      sourceVersionId: current.versionId,
      targetVersionId: pending.versionId,
      userId: claim.userId
    });
    await createVersionRelation(tx, {
      confidence: plan.decision.confidence,
      executionId: plan.executionId,
      kind: "ENRICHES",
      reasonCode: plan.decision.reasonCode,
      sourceVersionId: pending.versionId,
      targetVersionId: current.versionId,
      userId: claim.userId
    });
  } else if (plan.decision.operation === "SUPERSEDE_TARGET") {
    if (pending.factId !== current.factId) throw new Error("memory_fact_relation_invalid");
    const retired = await tx.memoryFactVersion.updateMany({
      data: { state: "SUPERSEDED", systemTo: closeCurrentAt },
      where: {
        factId: current.factId,
        id: current.versionId,
        state: "ACTIVE",
        systemTo: null,
        userId: claim.userId
      }
    });
    const activated = await tx.memoryFactVersion.updateMany({
      data: {
        ...resolution,
        state: "ACTIVE",
        supersedesVersionId: current.versionId,
        systemTo: null
      },
      where: {
        factId: pending.factId,
        id: pending.versionId,
        state: "PENDING_RELATION",
        userId: claim.userId
      }
    });
    const pointed = await tx.memoryFact.updateMany({
      data: {
        currentVersionId: pending.versionId,
        lastConfirmedAt: pending.observedAt ? new Date(pending.observedAt) : now,
        updatedAt: now
      },
      where: {
        currentVersionId: current.versionId,
        id: current.factId,
        state: "ACTIVE",
        userId: claim.userId
      }
    });
    if (retired.count !== 1 || activated.count !== 1 || pointed.count !== 1) {
      throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
    }
  } else if (plan.decision.operation === "MOVE_TO_DISTINCT_FACT") {
    if (pending.factId === current.factId ||
      snapshot.correctionTargetVersionId !== current.versionId) {
      throw new Error("memory_fact_relation_invalid");
    }
    const retired = await tx.memoryFactVersion.updateMany({
      data: { state: "SUPERSEDED", systemTo: closeCurrentAt },
      where: {
        factId: current.factId,
        id: current.versionId,
        state: "ACTIVE",
        systemTo: null,
        userId: claim.userId
      }
    });
    const activated = await tx.memoryFactVersion.updateMany({
      data: {
        ...resolution,
        movedFromVersionId: current.versionId,
        state: "ACTIVE",
        supersedesVersionId: current.versionId,
        systemTo: null
      },
      where: {
        factId: pending.factId,
        id: pending.versionId,
        state: "PENDING_RELATION",
        userId: claim.userId
      }
    });
    const oldFact = await tx.memoryFact.updateMany({
      data: {
        currentVersionId: null,
        movedToFactId: pending.factId,
        state: "RETRACTED",
        updatedAt: now
      },
      where: {
        currentVersionId: current.versionId,
        id: current.factId,
        state: "ACTIVE",
        userId: claim.userId
      }
    });
    const newFact = await tx.memoryFact.updateMany({
      data: {
        currentVersionId: pending.versionId,
        lastConfirmedAt: pending.observedAt ? new Date(pending.observedAt) : now,
        state: "ACTIVE",
        updatedAt: now
      },
      where: {
        currentVersionId: null,
        id: pending.factId,
        state: "CONFLICTED",
        userId: claim.userId
      }
    });
    if (retired.count !== 1 || activated.count !== 1 || oldFact.count !== 1 ||
      newFact.count !== 1) {
      throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
    }
    await createVersionRelation(tx, {
      confidence: plan.decision.confidence,
      executionId: plan.executionId,
      kind: "MOVED_FROM",
      reasonCode: plan.decision.reasonCode,
      sourceVersionId: pending.versionId,
      targetVersionId: current.versionId,
      userId: claim.userId
    });
  }

  await createRelationEvent(tx, claim, plan, snapshot);
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  if ([
    "MERGE_TARGET_INTO_NEW",
    "SUPERSEDE_TARGET",
    "MOVE_TO_DISTINCT_FACT",
    "ACTIVATE_AFTER_EXPIRY"
  ].includes(plan.decision.operation)) {
    await ensureClassifiedSearchEntry(
      tx,
      settings,
      pending.versionId,
      plan.executionId ?? plan.expectedSnapshotHash,
      now
    );
  }
}

type AuxiliaryReservationRow = Readonly<{
  acceptedOutputHash: string | null;
  completedAt: Date | null;
  createdAt: Date;
  executionId: string | null;
  inputHash: string | null;
  ownerJobId: string;
  result: Prisma.JsonValue | null;
}>;

const auxiliaryReservationSelect = Object.freeze({
  acceptedOutputHash: true,
  completedAt: true,
  createdAt: true,
  executionId: true,
  inputHash: true,
  ownerJobId: true,
  result: true
});

function recoveredAuxiliaryResult(
  row: AuxiliaryReservationRow,
  ownerJobId: string
): MemoryRelationProviderResult | null {
  if (row.ownerJobId !== ownerJobId || row.completedAt === null ||
    row.result === null || row.inputHash === null ||
    row.acceptedOutputHash === null || row.executionId === null) {
    return null;
  }
  const result = decodeStoredAuxiliaryResult(row.result);
  if (result.inputHash !== row.inputHash ||
    result.acceptedOutputHash !== row.acceptedOutputHash ||
    result.executionId !== row.executionId) {
    throw new Error("memory_fact_relation_auxiliary_result_invalid");
  }
  return result;
}

async function legacyAuxiliaryBindingExists(
  db: RelationReader,
  job: MemoryJobDescriptor
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ used: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM "MemoryExecutionBinding" AS binding
      INNER JOIN "MemoryJob" AS owner_job
        ON owner_job."userId" = binding."userId"
        AND owner_job."id" = binding."memoryJobId"
      WHERE binding."userId" = ${job.userId}
        AND binding."ownerType" = 'JOB'::"MemoryExecutionOwnerType"
        AND binding."logicalRole" = 'MEMORY_CONSOLIDATE'
        AND owner_job."sourceMessageId" = ${job.sourceMessageId}
    ) AS used
  `);
  return rows[0]?.used === true;
}

export function createPrismaMemoryRelationRepository(
  client: PrismaClient = prisma
): MemoryRelationRepository {
  return Object.freeze({
    async auxiliaryCallAvailable(job) {
      if (!validJob(job) || job.sourceMessageId === null) return false;
      const reservation = await client.memoryAuxiliarySemanticCall.findFirst({
        select: auxiliaryReservationSelect,
        where: { sourceMessageId: job.sourceMessageId, userId: job.userId }
      });
      if (reservation) {
        return recoveredAuxiliaryResult(reservation, job.id) !== null;
      }
      return !await legacyAuxiliaryBindingExists(client, job);
    },

    async preflight(job) {
      if (!validJob(job)) {
        return { errorCode: "memory_fact_relation_job_invalid", status: "CANCELLED" };
      }
      const settings = await client.userMemorySettings.findUnique({
        select: { memoryGeneration: true, useMemoryFacts: true },
        where: { userId: job.userId }
      });
      if (!settings || !settings.useMemoryFacts) {
        return { errorCode: "memory_fact_relation_disabled", status: "CANCELLED" };
      }
      if (settings.memoryGeneration !== job.memoryGenerationSnapshot) {
        return { errorCode: "memory_fact_relation_generation_stale", status: "STALE" };
      }
      const target = await client.memoryFactVersion.findFirst({
        select: { safetyClassificationState: true, state: true },
        where: { id: job.targetFactVersionId!, userId: job.userId }
      });
      if (!target || target.state !== "PENDING_RELATION") {
        return { errorCode: "memory_fact_relation_target_settled", status: "CANCELLED" };
      }
      if (target.safetyClassificationState !== "CLASSIFIED") {
        return { errorCode: "memory_fact_relation_safety_pending", status: "CANCELLED" };
      }
      return { status: "READY" };
    },

    prepare(job, now) {
      return loadPreparedRelation(client, job, now);
    },

    async recordAuxiliaryResult(job, result, now) {
      if (!validJob(job) || job.sourceMessageId === null ||
        !Number.isFinite(now.getTime())) {
        throw new Error("memory_fact_relation_auxiliary_result_invalid");
      }
      const decoded = decodeStoredAuxiliaryResult(
        encodeStoredAuxiliaryResult(result)
      );
      if (decoded.inputHash !== result.inputHash ||
        decoded.acceptedOutputHash !== result.acceptedOutputHash ||
        decoded.executionId !== result.executionId) {
        throw new Error("memory_fact_relation_auxiliary_result_invalid");
      }
      await client.$transaction(async (tx) => {
        const reservation = await tx.memoryAuxiliarySemanticCall.findFirst({
          select: auxiliaryReservationSelect,
          where: {
            ownerJobId: job.id,
            sourceMessageId: job.sourceMessageId!,
            userId: job.userId
          }
        });
        if (!reservation) {
          throw new Error("memory_fact_relation_auxiliary_reservation_missing");
        }
        const existing = recoveredAuxiliaryResult(reservation, job.id);
        if (existing) {
          if (memorySha256(existing) !== memorySha256(result)) {
            throw new Error("memory_fact_relation_auxiliary_result_conflict");
          }
          return;
        }
        const completedAt = new Date(Math.max(now.getTime(),
          reservation.createdAt.getTime()));
        const changed = await tx.memoryAuxiliarySemanticCall.updateMany({
          data: {
            acceptedOutputHash: result.acceptedOutputHash,
            completedAt,
            executionId: result.executionId,
            inputHash: result.inputHash,
            result: encodeStoredAuxiliaryResult(result)
          },
          where: {
            completedAt: null,
            ownerJobId: job.id,
            sourceMessageId: job.sourceMessageId!,
            userId: job.userId
          }
        });
        if (changed.count !== 1) {
          throw new Error("memory_fact_relation_auxiliary_result_conflict");
        }
      });
    },

    async reserveAuxiliaryCall(job) {
      if (!validJob(job) || job.sourceMessageId === null) {
        return { status: "UNAVAILABLE" };
      }
      return client.$transaction(async (tx): Promise<MemoryAuxiliaryCallReservation> => {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(
            ${`aiqsa:memory:auxiliary:${job.userId}:${job.sourceMessageId}`}, 0
          ))::text AS "lock"
        `);
        const existing = await tx.memoryAuxiliarySemanticCall.findFirst({
          select: auxiliaryReservationSelect,
          where: { sourceMessageId: job.sourceMessageId!, userId: job.userId }
        });
        if (existing) {
          const result = recoveredAuxiliaryResult(existing, job.id);
          return result
            ? { result, status: "RECOVERED" }
            : { status: "UNAVAILABLE" };
        }
        if (await legacyAuxiliaryBindingExists(tx, job)) {
          return { status: "UNAVAILABLE" };
        }
        await tx.memoryAuxiliarySemanticCall.create({
          data: {
            id: memorySha256({
              domain: "aiqsa.memory.auxiliary-semantic-call",
              sourceMessageId: job.sourceMessageId,
              userId: job.userId,
              version: 1
            }),
            ownerJobId: job.id,
            purpose: "FACT_RELATION",
            sourceMessageId: job.sourceMessageId!,
            userId: job.userId
          }
        });
        return { status: "ACQUIRED" };
      });
    },

    async settleTerminal(tx, claim, reason, now) {
      if (!validJob(claim) || !reasonCode.test(reason) ||
        !Number.isFinite(now.getTime())) {
        throw new Error("memory_fact_relation_terminal_input_invalid");
      }
      const settings = await lockMemorySettings(tx, claim.userId, true);
      if (!settings.useMemoryFacts ||
        settings.memoryGeneration !== claim.memoryGenerationSnapshot) {
        throw new MemoryCoordinatorError("memory_fact_relation_generation_stale", false);
      }
      const rows = await tx.$queryRaw<Array<{
        factId: string;
        relationResolutionVersion: string | null;
        relationSnapshotHash: string | null;
        state: string;
        systemFrom: Date;
      }>>(Prisma.sql`
        SELECT
          "factId", "relationResolutionVersion", "relationSnapshotHash",
          "state"::text AS "state", "systemFrom"
        FROM "MemoryFactVersion"
        WHERE "userId" = ${claim.userId}
          AND "id" = ${claim.targetFactVersionId!}
        FOR UPDATE
      `);
      const target = rows[0];
      if (!target) return;
      const resolutionHash = terminalResolutionHash(claim, reason);
      const eventId = terminalRelationEventId(claim, resolutionHash);
      if (target.relationResolutionVersion === MEMORY_FACT_RELATION_POLICY_VERSION &&
        target.relationSnapshotHash === resolutionHash) {
        const event = await tx.memoryEvent.findFirst({
          select: { id: true },
          where: { id: eventId, userId: claim.userId }
        });
        if (!event) throw new Error("memory_fact_relation_receipt_missing");
        return;
      }
      if (target.state !== "PENDING_RELATION") return;
      await tx.memorySearchEntry.deleteMany({
        where: { factVersionId: claim.targetFactVersionId!, userId: claim.userId }
      });
      const changed = await tx.memoryFactVersion.updateMany({
        data: {
          relationResolutionVersion: MEMORY_FACT_RELATION_POLICY_VERSION,
          relationResolvedAt: now,
          relationSnapshotHash: resolutionHash,
          state: "CONFLICTING",
          systemTo: closedAt(now, target.systemFrom.toISOString())
        },
        where: {
          id: claim.targetFactVersionId!,
          relationResolutionVersion: null,
          state: "PENDING_RELATION",
          userId: claim.userId
        }
      });
      if (changed.count !== 1) {
        throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
      }
      await tx.memoryEvent.create({
        data: {
          actorType: "JOB",
          factId: target.factId,
          factVersionId: claim.targetFactVersionId!,
          id: eventId,
          metadata: {
            pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
            reasonCode: reason,
            relationSnapshotHash: resolutionHash,
            schemaVersion: "memory-fact-relation-terminal-v1"
          },
          operation: "CONFLICT",
          sourceChatId: claim.chatId,
          sourceGeneration: claim.branchGeneration,
          userId: claim.userId
        }
      });
      await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
    },

    async apply(tx, claim, plan, now) {
      if (!validJob(claim) || !Number.isFinite(now.getTime()) ||
        !/^[a-f0-9]{64}$/u.test(plan.expectedSnapshotHash) ||
        !reasonCode.test(plan.decision.reasonCode) ||
        !Number.isFinite(plan.decision.confidence) ||
        plan.decision.confidence < 0 || plan.decision.confidence > 1 ||
        plan.decision.targetVersionId === null) {
        throw new Error("memory_fact_relation_input_invalid");
      }
      const settings = await lockMemorySettings(tx, claim.userId, true);
      if (!settings.useMemoryFacts ||
        settings.memoryGeneration !== claim.memoryGenerationSnapshot) {
        throw new MemoryCoordinatorError("memory_fact_relation_generation_stale", false);
      }
      const settled = await tx.memoryFactVersion.findFirst({
        select: {
          relationResolutionVersion: true,
          relationSnapshotHash: true
        },
        where: { id: claim.targetFactVersionId!, userId: claim.userId }
      });
      if (settled?.relationResolutionVersion === MEMORY_FACT_RELATION_POLICY_VERSION &&
        settled.relationSnapshotHash === plan.expectedSnapshotHash) {
        const event = await tx.memoryEvent.findFirst({
          select: { id: true },
          where: { id: relationEventId(claim.id, plan), userId: claim.userId }
        });
        if (!event) throw new Error("memory_fact_relation_receipt_missing");
        return;
      }
      const prepared = await loadPreparedRelation(tx, claim, now);
      if (prepared.status !== "READY") {
        throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
      }
      await lockRelationGraph(tx, claim.userId, prepared.prepared.snapshot);
      const locked = await loadPreparedRelation(tx, claim, now);
      if (locked.status !== "READY" ||
        locked.prepared.snapshotHash !== plan.expectedSnapshotHash ||
        locked.prepared.snapshotHash !== prepared.prepared.snapshotHash ||
        plan.decision.targetVersionId !== locked.prepared.snapshot.current.versionId) {
        throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
      }
      const currentExpiresAt = locked.prepared.snapshot.current.expiresAt;
      const pendingExpiresAt = locked.prepared.snapshot.pending.expiresAt;
      const currentDue = currentExpiresAt !== null &&
        new Date(currentExpiresAt) <= now;
      const pendingDue = pendingExpiresAt !== null &&
        new Date(pendingExpiresAt) <= now;
      if ((currentDue && plan.decision.operation !== "ACTIVATE_AFTER_EXPIRY" &&
          plan.decision.operation !== "EXPIRE") ||
        (!currentDue && plan.decision.operation === "ACTIVATE_AFTER_EXPIRY") ||
        (pendingDue && plan.decision.operation !== "EXPIRE") ||
        (!pendingDue && plan.decision.operation === "EXPIRE")) {
        throw new MemoryCoordinatorError("memory_fact_relation_snapshot_stale", true);
      }
      await applyRelation(
        tx,
        settings,
        claim,
        plan,
        locked.prepared.snapshot,
        now
      );
    }
  });
}
