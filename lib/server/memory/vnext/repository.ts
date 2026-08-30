import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_TEMPORAL_RESOLVER_VERSION,
  memoryFactEvidenceFingerprint,
  memoryFactNormalizedValue,
  memoryFactObservationFingerprint,
  type MemoryExtractedCandidate,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "../learning/extraction/contract";
import type { MemorySemanticAdjudication } from "../learning/extraction/contract";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { ensureClassifiedSearchEntry } from "../persistence/factSearchEntry";
import { memorySafetyLiteFactClassification } from "../safetyLite";
import { memoryExactVNextDirectAuthorityPredicate } from
  "../persistence/eligibility";
import { ensureGlobalMemoryScope } from "../persistence/scopes";
import {
  advanceMemoryMutation,
  type LockedMemorySettings,
  type MemoryTransaction
} from "../persistence/transaction";
import {
  memoryFactDependenciesAreValid,
  persistMemoryFactDependencies
} from "../learning/dependencies/repository";
import { persistMemoryCandidateEntities } from "../learning/entities/repository";

type LockedFact = Readonly<{
  currentVersionId: string | null;
  id: string;
  lastConfirmedAt: Date | null;
  movedToFactId: string | null;
  state: string;
}>;

type StoredVersion = Readonly<{
  displayText: string | null;
  expectedAt: Date | null;
  expiresAt: Date | null;
  id: string;
  occurredAt: Date | null;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state: string;
  structuredValue: Prisma.JsonValue | null;
  validFrom: Date | null;
  validTo: Date | null;
}>;

type LockedReinforcementTarget = Readonly<{
  factId: string;
  lastConfirmedAt: Date | null;
  versionId: string;
}>;

type ExactEvidence = ReturnType<typeof exactEvidence>[number];

export type MemoryVNextCommitResult = Readonly<{
  attachedEvidence: number;
  createdVersions: number;
}>;

type ResolvedSemanticAdjudication = Readonly<
  MemorySemanticAdjudication & {
    resolvedEntityId: string | null;
    resolvedTargetVersionId: string | null;
  }
>;

function resolveSemanticAdjudication(
  plan: MemoryFactExtractionPlan,
  decision: MemorySemanticAdjudication | null
): ResolvedSemanticAdjudication | null {
  if (!decision) return null;
  const target = decision.targetRef === null ? null : plan.input.contextRefs.find(
    ({ ref }) => ref === decision.targetRef
  );
  const entity = decision.entityRef === null ? null : plan.input.contextRefs.find(
    ({ ref }) => ref === decision.entityRef
  );
  if ((decision.targetRef !== null && !target?.source.factVersionId) ||
    (decision.entityRef !== null && !entity?.entityId)) return null;
  return {
    ...decision,
    resolvedEntityId: entity?.entityId ?? null,
    resolvedTargetVersionId: target?.source.factVersionId ?? null
  };
}

function exactEvidence(
  input: MemoryFactExtractionInput,
  candidate: MemoryExtractedCandidate
) {
  const eligible = input.messages.filter((message) => message.evidenceEligible);
  const message = eligible.length === 1 &&
    eligible[0]?.id === input.source.sourceMessageId &&
    eligible[0].role === "user"
    ? eligible[0]
    : null;
  if (!message) throw new Error("memory_vnext_source_message_invalid");
  return candidate.evidence.map((evidence) => {
    const quote = message.text.slice(evidence.startOffset, evidence.endOffset);
    if (
      evidence.messageId !== message.id ||
      evidence.sourceTextHash !== memorySha256(message.text) ||
      evidence.startOffset < 0 ||
      evidence.endOffset <= evidence.startOffset ||
      evidence.endOffset > message.text.length ||
      message.redactionSpans.some((redacted) =>
        evidence.startOffset < redacted.endOffset &&
        evidence.endOffset > redacted.startOffset) ||
      !quote || evidence.quote !== quote
    ) {
      throw new Error("memory_vnext_evidence_invalid");
    }
    return {
      branchGeneration: input.source.branchGeneration,
      chatId: input.source.chatId,
      endOffset: evidence.endOffset,
      evidenceFingerprint: memoryFactEvidenceFingerprint(input, candidate, evidence),
      ingestionFingerprint: memoryFactObservationFingerprint(input, candidate, evidence),
      messageId: message.id,
      observedAt: new Date(message.createdAt),
      quote,
      sourceTextHash: evidence.sourceTextHash,
      startOffset: evidence.startOffset
    };
  });
}

function eventId(
  claim: MemoryJobClaim,
  candidate: MemoryExtractedCandidate,
  operation: "AUTO_PROPOSE" | "PROMOTE" | "REINFORCE"
): string {
  return memorySha256({
    candidateId: candidate.id,
    domain: "aiqsa.memory.vnext.event",
    jobId: claim.id,
    operation,
    version: 2
  });
}

function versionId(ingestionFingerprint: string): string {
  return memorySha256({
    domain: "aiqsa.memory.vnext.version",
    ingestionFingerprint,
    version: 1
  });
}

async function createEvent(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  candidate: MemoryExtractedCandidate,
  factId: string,
  factVersionId: string,
  bindingId: string,
  operation: "AUTO_PROPOSE" | "PROMOTE" | "REINFORCE"
): Promise<string> {
  const id = eventId(claim, candidate, operation);
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId,
      factVersionId,
      id,
      metadata: {
        confidenceBand: candidate.confidenceBand,
        extractionExecutionId: bindingId,
        identityKind: candidate.identityKind,
        identityVersion: candidate.identityVersion,
        ingestionJobId: claim.id,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        schemaVersion: "memory-vnext-observation-event-v3"
      },
      operation,
      sourceChatId: claim.chatId,
      sourceGeneration: claim.branchGeneration,
      userId: claim.userId
    }
  });
  return id;
}

async function createExpirationEvent(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  factId: string,
  factVersionId: string,
  now: Date
): Promise<void> {
  await tx.memoryEvent.create({
    data: {
      actorType: "SYSTEM",
      factId,
      factVersionId,
      id: memorySha256({
        domain: "aiqsa.memory.vnext.expiration-event",
        factVersionId,
        version: 1
      }),
      metadata: {
        expiredAt: now.toISOString(),
        reasonCode: "explicit_ttl_elapsed",
        schemaVersion: "memory-vnext-expiration-event-v1"
      },
      operation: "EXPIRE",
      sourceChatId: claim.chatId,
      sourceGeneration: claim.branchGeneration,
      userId: claim.userId
    }
  });
}

async function lockedFact(
  tx: MemoryTransaction,
  userId: string,
  scopeId: string,
  canonicalKey: string
): Promise<LockedFact | null> {
  const rows = await tx.$queryRaw<LockedFact[]>(Prisma.sql`
    SELECT "id", "currentVersionId", "lastConfirmedAt", "movedToFactId",
      "state"::text AS "state"
    FROM "MemoryFact"
    WHERE "userId" = ${userId}
      AND "scopeId" = ${scopeId}
      AND "canonicalKey" = ${canonicalKey}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

function normalizedStoredValue(version: StoredVersion) {
  return {
    expectedAt: version.expectedAt?.toISOString() ?? null,
    expiresAt: version.expiresAt?.toISOString() ?? null,
    occurredAt: version.occurredAt?.toISOString() ?? null,
    structuredValue: version.structuredValue,
    validFrom: version.validFrom?.toISOString() ?? null,
    validTo: version.validTo?.toISOString() ?? null
  };
}

function sameValue(
  version: StoredVersion,
  candidate: MemoryExtractedCandidate
): boolean {
  return memorySha256(normalizedStoredValue(version)) ===
    memorySha256(memoryFactNormalizedValue(candidate));
}

async function attachEvidence(
  tx: MemoryTransaction,
  userId: string,
  factVersionId: string,
  input: MemoryFactExtractionInput,
  evidence: ExactEvidence
): Promise<string> {
  const id = memorySha256({
    domain: "aiqsa.memory.evidence-row",
    evidenceFingerprint: evidence.evidenceFingerprint,
    userId,
    version: 1
  });
  await tx.memoryEvidence.create({
    data: {
      branchGeneration: evidence.branchGeneration,
      chatId: evidence.chatId,
      evidenceFingerprint: evidence.evidenceFingerprint,
      factVersionId,
      id,
      messageId: evidence.messageId,
      observedAt: evidence.observedAt,
      safeExcerpt: evidence.quote,
      safeSourceHash: evidence.sourceTextHash,
      safetyClass: "NORMAL",
      sourceEndOffset: evidence.endOffset,
      sourceMessageContentHash: evidence.sourceTextHash,
      sourceProjectionVersion: input.sourceProjectionVersion,
      sourceRole: "user",
      sourceStartOffset: evidence.startOffset,
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId
    }
  });
  return id;
}

async function lockedReinforcementTarget(
  tx: MemoryTransaction,
  userId: string,
  scopeId: string,
  versionId: string,
  now: Date
): Promise<LockedReinforcementTarget | null> {
  const rows = await tx.$queryRaw<LockedReinforcementTarget[]>(Prisma.sql`
    SELECT fact."id" AS "factId", fact."lastConfirmedAt",
      version."id" AS "versionId"
    FROM "MemoryFactVersion" AS version
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
      AND fact."scopeId" = ${scopeId}
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."movedToFactId" IS NULL
      AND fact."currentVersionId" = version."id"
    WHERE version."userId" = ${userId}
      AND version."id" = ${versionId}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."displayText" IS NOT NULL
      AND version."contentPurgedAt" IS NULL
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."sensitivityClass" IN (
        'NORMAL'::"MemorySensitivityClass",
        'SENSITIVE'::"MemorySensitivityClass"
      )
      AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
      AND ${memoryExactVNextDirectAuthorityPredicate(userId)}
    FOR UPDATE OF fact, version
  `);
  return rows[0] ?? null;
}

async function reinforceTarget(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  candidate: MemoryExtractedCandidate,
  evidence: ExactEvidence,
  bindingId: string,
  now: Date,
  target: LockedReinforcementTarget
): Promise<MemoryVNextCommitResult> {
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
  await createEvent(
    tx,
    claim,
    candidate,
    target.factId,
    target.versionId,
    bindingId,
    "REINFORCE"
  );
  const evidenceId = await attachEvidence(
    tx,
    settings.userId,
    target.versionId,
    plan.input,
    evidence
  );
  await persistMemoryCandidateEntities(tx, {
    candidate,
    evidenceId,
    factVersionId: target.versionId,
    userId: settings.userId
  });
  await tx.memoryFact.update({
    data: {
      lastConfirmedAt: new Date(Math.max(
        target.lastConfirmedAt?.getTime() ?? -1,
        evidence.observedAt.getTime()
      ))
    },
    where: { id: target.factId, userId: settings.userId }
  });
  await ensureClassifiedSearchEntry(
    tx,
    settings,
    target.versionId,
    bindingId,
    now
  );
  return { attachedEvidence: 1, createdVersions: 0 };
}

async function insertVersion(
  tx: MemoryTransaction,
  input: Readonly<{
    candidate: MemoryExtractedCandidate;
    createdByEventId: string;
    evidence: ExactEvidence;
    factId: string;
    id: string;
    inputTimeZone: string;
    now: Date;
    semanticAdjudication: ResolvedSemanticAdjudication | null;
    state: "ACTIVE" | "PENDING_RELATION";
    userId: string;
  }>
): Promise<void> {
  const candidate = input.candidate;
  await tx.memoryFactVersion.create({
    data: {
      category: candidate.category,
      confidence: candidate.confidence,
      coreEligible: false,
      coreSalience: "NONE",
      createdByEventId: input.createdByEventId,
      directness: "DIRECT",
      displayText: candidate.displayText,
      expectedAt: candidate.expectedAt ? new Date(candidate.expectedAt) : null,
      expiresAt: candidate.expiresAt ? new Date(candidate.expiresAt) : null,
      factId: input.factId,
      id: input.id,
      importance: candidate.importance,
      ingestionFingerprint: input.evidence.ingestionFingerprint,
      languageCode: candidate.languageCode,
      modality: candidate.modality,
      normalizedSearchText: normalizeMemorySearchText(candidate.displayText),
      observedAt: input.evidence.observedAt,
      occurredAt: candidate.occurredAt ? new Date(candidate.occurredAt) : null,
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      rawTemporalExpression: candidate.rawTemporalExpression,
      ...memorySafetyLiteFactClassification(input.now),
      sensitivityClass: "NORMAL",
      semanticAdjudication: input.semanticAdjudication === null
        ? Prisma.DbNull
        : input.semanticAdjudication as Prisma.InputJsonValue,
      semanticFrame: candidate.semanticFrame as Prisma.InputJsonValue,
      sourceMode: "AUTOMATIC",
      sourceTimezone: input.inputTimeZone,
      state: input.state,
      structuredValue: candidate.proposedValue === null
        ? Prisma.JsonNull
        : candidate.proposedValue as Prisma.InputJsonValue,
      systemFrom: input.now,
      temporalResolutionEvidence: candidate.temporalResolutionEvidence === null
        ? Prisma.DbNull
        : candidate.temporalResolutionEvidence as Prisma.InputJsonValue,
      temporalResolverVersion: MEMORY_FACT_TEMPORAL_RESOLVER_VERSION,
      userId: input.userId,
      validFrom: candidate.validFrom ? new Date(candidate.validFrom) : null,
      validTo: candidate.validTo ? new Date(candidate.validTo) : null
    }
  });
}

async function currentVersion(
  tx: MemoryTransaction,
  userId: string,
  factId: string,
  currentVersionId: string
): Promise<StoredVersion | null> {
  return tx.memoryFactVersion.findFirst({
    select: {
      displayText: true,
      expectedAt: true,
      expiresAt: true,
      id: true,
      occurredAt: true,
      sourceMode: true,
      state: true,
      structuredValue: true,
      validFrom: true,
      validTo: true
    },
    where: { factId, id: currentVersionId, userId }
  }) as Promise<StoredVersion | null>;
}

async function matchingPendingVersion(
  tx: MemoryTransaction,
  userId: string,
  factId: string,
  candidate: MemoryExtractedCandidate
): Promise<StoredVersion | null> {
  const pending = await tx.memoryFactVersion.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      displayText: true,
      expectedAt: true,
      expiresAt: true,
      id: true,
      occurredAt: true,
      sourceMode: true,
      state: true,
      structuredValue: true,
      validFrom: true,
      validTo: true
    },
    where: { factId, state: "PENDING_RELATION", userId }
  }) as StoredVersion[];
  return pending.find((version) => sameValue(version, candidate)) ?? null;
}

async function materializeExpiredCurrent(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  fact: LockedFact,
  version: StoredVersion,
  now: Date
): Promise<boolean> {
  if (version.expiresAt === null || version.expiresAt > now) return false;
  const closedAt = new Date(Math.max(
    now.getTime(),
    version.expiresAt.getTime(),
    1
  ));
  const expired = await tx.memoryFactVersion.updateMany({
    data: { state: "EXPIRED", systemTo: closedAt },
    where: {
      factId: fact.id,
      id: version.id,
      state: "ACTIVE",
      userId: claim.userId
    }
  });
  if (expired.count !== 1) return false;
  await tx.memorySearchEntry.deleteMany({
    where: { factVersionId: version.id, userId: claim.userId }
  });
  await tx.memoryFact.update({
    data: {
      currentVersionId: null,
      state: "EXPIRED",
      updatedAt: now
    },
    where: { id: fact.id }
  });
  await createExpirationEvent(tx, claim, fact.id, version.id, now);
  return true;
}

async function createFirstOrReactivatedVersion(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  candidate: MemoryExtractedCandidate,
  evidence: ExactEvidence,
  bindingId: string,
  now: Date,
  scopeId: string,
  existingFact: LockedFact | null,
  semanticAdjudication: ResolvedSemanticAdjudication | null
): Promise<MemoryVNextCommitResult> {
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
  const factId = existingFact?.id ?? randomUUID();
  const factVersionId = versionId(evidence.ingestionFingerprint);
  if (!existingFact) {
    await tx.memoryFact.create({
      data: {
        canonicalKey: candidate.canonicalKey,
        category: candidate.category,
        currentVersionId: factVersionId,
        dimensionKey: candidate.dimensionKey,
        id: factId,
        identityKind: candidate.identityKind,
        identityVersion: candidate.identityVersion,
        lastConfirmedAt: evidence.observedAt,
        predicateKey: candidate.predicateKey,
        scopeId,
        state: "ACTIVE",
        subjectEntityId: candidate.subjectEntityId ?? null,
        subjectKey: candidate.subjectKey,
        userId: settings.userId
      }
    });
  } else {
    await tx.memoryFact.update({
      data: {
        category: candidate.category,
        currentVersionId: factVersionId,
        forgottenAt: null,
        lastConfirmedAt: evidence.observedAt,
        state: "ACTIVE",
        updatedAt: now
      },
      where: { id: factId }
    });
  }
  const promotionEventId = await createEvent(
    tx,
    claim,
    candidate,
    factId,
    factVersionId,
    bindingId,
    candidate.confidenceBand === "MEDIUM" ? "AUTO_PROPOSE" : "PROMOTE"
  );
  await insertVersion(tx, {
    candidate,
    createdByEventId: promotionEventId,
    evidence,
    factId,
    id: factVersionId,
    inputTimeZone: plan.input.timeZone,
    now,
    semanticAdjudication,
    state: "ACTIVE",
    userId: settings.userId
  });
  const evidenceId = await attachEvidence(
    tx,
    settings.userId,
    factVersionId,
    plan.input,
    evidence
  );
  await persistMemoryFactDependencies(
    tx,
    settings.userId,
    factVersionId,
    candidate.dependencies
  );
  await persistMemoryCandidateEntities(tx, {
    candidate,
    evidenceId,
    factVersionId,
    userId: settings.userId
  });
  await ensureClassifiedSearchEntry(
    tx,
    settings,
    factVersionId,
    bindingId,
    now
  );
  return { attachedEvidence: 1, createdVersions: 1 };
}

async function correctionTargetVersionId(
  tx: MemoryTransaction,
  userId: string,
  candidate: MemoryExtractedCandidate
): Promise<string | null> {
  const correction = candidate.dependencies.find(({ dependencyKind }) =>
    dependencyKind === "CORRECTION_TARGET");
  if (!correction) return null;
  if (correction.source.factVersionId !== null) {
    const targets = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT version."id"
      FROM "MemoryFactVersion" AS version
      INNER JOIN "MemoryFact" AS fact
        ON fact."userId" = version."userId"
        AND fact."id" = version."factId"
        AND fact."state" = 'ACTIVE'::"MemoryFactState"
        AND fact."currentVersionId" = version."id"
      WHERE version."userId" = ${userId}
        AND version."id" = ${correction.source.factVersionId}
        AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
        AND version."systemTo" IS NULL
    `);
    return targets[0]?.id ?? null;
  }
  if (correction.source.messageId === null) return null;
  const targets = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT version."id"
    FROM "MemoryEvidence" AS evidence
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = evidence."userId"
      AND version."id" = evidence."factVersionId"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."currentVersionId" = version."id"
    WHERE evidence."userId" = ${userId}
      AND evidence."messageId" = ${correction.source.messageId}
      AND evidence."stance" = 'SUPPORTS'::"MemoryEvidenceStance"
      AND fact."predicateKey" IS NOT DISTINCT FROM ${candidate.predicateKey}
    ORDER BY version."id"
    LIMIT 2
  `);
  return targets.length === 1 ? targets[0]!.id : null;
}

async function createCrossFactRelationVersion(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  candidate: MemoryExtractedCandidate,
  evidence: ExactEvidence,
  bindingId: string,
  now: Date,
  scopeId: string,
  semanticAdjudication: ResolvedSemanticAdjudication | null
): Promise<MemoryVNextCommitResult> {
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
  const factId = randomUUID();
  const factVersionId = versionId(evidence.ingestionFingerprint);
  await tx.memoryFact.create({
    data: {
      canonicalKey: candidate.canonicalKey,
      category: candidate.category,
      currentVersionId: null,
      dimensionKey: candidate.dimensionKey,
      id: factId,
      identityKind: candidate.identityKind,
      identityVersion: candidate.identityVersion,
      lastConfirmedAt: evidence.observedAt,
      predicateKey: candidate.predicateKey,
      scopeId,
      state: "CONFLICTED",
      subjectEntityId: candidate.subjectEntityId ?? null,
      subjectKey: candidate.subjectKey,
      userId: settings.userId
    }
  });
  const proposalEventId = await createEvent(
    tx,
    claim,
    candidate,
    factId,
    factVersionId,
    bindingId,
    "AUTO_PROPOSE"
  );
  await insertVersion(tx, {
    candidate,
    createdByEventId: proposalEventId,
    evidence,
    factId,
    id: factVersionId,
    inputTimeZone: plan.input.timeZone,
    now,
    semanticAdjudication,
    state: "PENDING_RELATION",
    userId: settings.userId
  });
  const evidenceId = await attachEvidence(
    tx,
    settings.userId,
    factVersionId,
    plan.input,
    evidence
  );
  await persistMemoryFactDependencies(
    tx,
    settings.userId,
    factVersionId,
    candidate.dependencies
  );
  await persistMemoryCandidateEntities(tx, {
    candidate,
    evidenceId,
    factVersionId,
    userId: settings.userId
  });
  return { attachedEvidence: 1, createdVersions: 1 };
}

async function relatedContextTargetVersionId(
  tx: MemoryTransaction,
  userId: string,
  candidate: MemoryExtractedCandidate,
  now: Date
): Promise<string | null> {
  const entityIds = [...new Set(candidate.entities
    .filter(({ contextEntityId, role }) => role === "SUBJECT" &&
      contextEntityId !== null)
    .map(({ contextEntityId }) => contextEntityId!))];
  if (entityIds.length === 0 || candidate.predicateKey === null) return null;
  const targets = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT version."id"
    FROM "MemoryFactVersionEntity" AS link
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = link."userId"
      AND version."id" = link."factVersionId"
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND version."systemTo" IS NULL
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND (version."expiresAt" IS NULL OR version."expiresAt" > ${now})
    INNER JOIN "MemoryFact" AS fact
      ON fact."userId" = version."userId"
      AND fact."id" = version."factId"
      AND fact."state" = 'ACTIVE'::"MemoryFactState"
      AND fact."currentVersionId" = version."id"
      AND fact."predicateKey" IS NOT DISTINCT FROM ${candidate.predicateKey}
      AND fact."dimensionKey" IS NOT DISTINCT FROM ${candidate.dimensionKey}
    WHERE link."userId" = ${userId}
      AND aiqsa_memory_entity_root_id(link."userId", link."entityId")
        IN (${Prisma.join(entityIds)})
      AND link."role" = 'SUBJECT'::"MemoryEntityLinkRole"
      AND ${memoryExactVNextDirectAuthorityPredicate(userId)}
    ORDER BY version."id"
    LIMIT 2
  `);
  return targets.length === 1 ? targets[0]!.id : null;
}

async function createObservation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  candidate: MemoryExtractedCandidate,
  bindingId: string,
  now: Date,
  decision: MemorySemanticAdjudication | null
): Promise<MemoryVNextCommitResult> {
  if (candidate.scope.type !== "GLOBAL_USER" || candidate.scope.targetId !== null ||
    candidate.directness !== "DIRECT" || candidate.sensitivity !== "NORMAL") {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  const evidence = exactEvidence(plan.input, candidate);
  if (evidence.length !== 1) throw new Error("memory_vnext_evidence_invalid");
  if (candidate.expiresAt !== null && new Date(candidate.expiresAt) <= now) {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  const proposedVersionId = versionId(evidence[0]!.ingestionFingerprint);
  if (!await memoryFactDependenciesAreValid(
    tx,
    settings.userId,
    proposedVersionId,
    candidate.dependencies
  )) {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  const replay = await tx.memoryEvidence.findFirst({
    select: { factVersionId: true, id: true },
    where: {
      evidenceFingerprint: evidence[0]!.evidenceFingerprint,
      userId: settings.userId
    }
  });
  if (replay) {
    await ensureClassifiedSearchEntry(
      tx,
      settings,
      replay.factVersionId,
      evidence[0]!.evidenceFingerprint,
      now
    );
    return { attachedEvidence: 0, createdVersions: 0 };
  }

  const semanticAdjudication = resolveSemanticAdjudication(plan, decision);
  if (decision !== null && semanticAdjudication === null) {
    return { attachedEvidence: 0, createdVersions: 0 };
  }

  const scope = await ensureGlobalMemoryScope(tx, settings);
  if (semanticAdjudication?.operation === "REINFORCE" &&
    semanticAdjudication.resolvedTargetVersionId !== null) {
    const target = await lockedReinforcementTarget(
      tx,
      settings.userId,
      scope.id,
      semanticAdjudication.resolvedTargetVersionId,
      now
    );
    if (!target) return { attachedEvidence: 0, createdVersions: 0 };
    return reinforceTarget(
      tx,
      settings,
      claim,
      plan,
      candidate,
      evidence[0]!,
      bindingId,
      now,
      target
    );
  }
  // A proposition with a model-selected target may only converge through the
  // revalidated reinforcement path above. Other pointer operations belong to
  // SLOT relation resolution and must not fall through into a second active
  // proposition when the target semantics or representation are uncertain.
  if (candidate.identityKind === "PROPOSITION" &&
    semanticAdjudication !== null &&
    semanticAdjudication.resolvedTargetVersionId !== null) {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  const fact = await lockedFact(
    tx,
    settings.userId,
    scope.id,
    candidate.canonicalKey
  );
  if (!fact) {
    const correctionTarget = await correctionTargetVersionId(
      tx,
      settings.userId,
      candidate
    );
    const contextTarget = correctionTarget ?? await relatedContextTargetVersionId(
      tx,
      settings.userId,
      candidate,
      now
    );
    if (contextTarget !== null && candidate.identityKind === "SLOT") {
      if (!semanticAdjudication ||
        semanticAdjudication.resolvedTargetVersionId !== contextTarget ||
        ![
          "MERGE_NEW_INTO_TARGET",
          "MERGE_TARGET_INTO_NEW",
          "MOVE_TO_DISTINCT_FACT",
          "SUPERSEDE_TARGET"
        ].includes(semanticAdjudication.operation)) {
        return { attachedEvidence: 0, createdVersions: 0 };
      }
      return createCrossFactRelationVersion(
      tx, settings, claim, plan, candidate, evidence[0]!, bindingId, now,
        scope.id, semanticAdjudication
      );
    }
    if (candidate.identityKind === "SLOT" && (
      semanticAdjudication?.operation !== "NO_RELATION" ||
      semanticAdjudication.resolvedTargetVersionId !== null
    )) return { attachedEvidence: 0, createdVersions: 0 };
    return createFirstOrReactivatedVersion(
      tx, settings, claim, plan, candidate, evidence[0]!, bindingId, now,
      scope.id, null, semanticAdjudication
    );
  }
  if (fact.state === "FORGOTTEN" || fact.state === "ORPHANED" ||
    fact.state === "CONFLICTED" || fact.movedToFactId !== null) {
    return { attachedEvidence: 0, createdVersions: 0 };
  }

  // Source invalidation retracts the old immutable version and clears the
  // pointer. A later independent direct-user observation may establish a new
  // version of the same logical identity; it must never revive the old row or
  // bypass explicit forget/orphan/move states fenced above.
  if (fact.state === "RETRACTED") {
    if (fact.currentVersionId !== null) {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    if (candidate.identityKind === "SLOT" &&
      semanticAdjudication?.operation !== "NO_RELATION") {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    return createFirstOrReactivatedVersion(
      tx, settings, claim, plan, candidate, evidence[0]!, bindingId, now,
      scope.id, fact, semanticAdjudication
    );
  }

  let active: StoredVersion | null = null;
  let expiredCurrent = false;
  let expiredVersionId: string | null = null;
  if (fact.currentVersionId !== null) {
    active = await currentVersion(
      tx,
      settings.userId,
      fact.id,
      fact.currentVersionId
    );
    if (!active || active.state !== "ACTIVE" || active.displayText === null ||
      active.structuredValue === null) {
      throw new Error("memory_vnext_current_version_invalid");
    }
    if (await materializeExpiredCurrent(tx, claim, fact, active, now)) {
      expiredCurrent = true;
      expiredVersionId = active.id;
      active = null;
    }
  }
  if (active === null) {
    if (!expiredCurrent && fact.state !== "EXPIRED") {
      throw new Error("memory_vnext_fact_pointer_invalid");
    }
    const explicitlyObservedExpiredTarget =
      semanticAdjudication?.resolvedTargetVersionId === expiredVersionId && [
        "REINFORCE",
        "MERGE_NEW_INTO_TARGET",
        "MERGE_TARGET_INTO_NEW",
        "SUPERSEDE_TARGET"
      ].includes(semanticAdjudication.operation);
    if (candidate.identityKind === "SLOT" &&
      semanticAdjudication?.operation !== "NO_RELATION" &&
      !explicitlyObservedExpiredTarget) {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    return createFirstOrReactivatedVersion(
      tx, settings, claim, plan, candidate, evidence[0]!, bindingId, now,
      scope.id, fact, semanticAdjudication
    );
  }

  if (sameValue(active, candidate)) {
    const explicitTargetMatch =
      semanticAdjudication?.resolvedTargetVersionId === active.id && [
        "REINFORCE",
        "MERGE_NEW_INTO_TARGET",
        "MERGE_TARGET_INTO_NEW"
      ].includes(semanticAdjudication.operation);
    // A same-value row may have appeared after the bounded adjudication
    // snapshot. Mechanical equality can safely converge its evidence without
    // moving a pointer; different values still require an explicit fresh ref.
    const concurrentSameValue = semanticAdjudication?.operation === "NO_RELATION" &&
      semanticAdjudication.resolvedTargetVersionId === null;
    if (candidate.identityKind === "SLOT" &&
      !explicitTargetMatch && !concurrentSameValue) {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    return reinforceTarget(
      tx,
      settings,
      claim,
      plan,
      candidate,
      evidence[0]!,
      bindingId,
      now,
      {
        factId: fact.id,
        lastConfirmedAt: fact.lastConfirmedAt,
        versionId: active.id
      }
    );
  }

  if (candidate.identityKind !== "SLOT") {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  if (!semanticAdjudication ||
    semanticAdjudication.resolvedTargetVersionId !== active.id ||
    ![
      "MERGE_NEW_INTO_TARGET",
      "MERGE_TARGET_INTO_NEW",
      "MOVE_TO_DISTINCT_FACT",
      "SUPERSEDE_TARGET"
    ].includes(semanticAdjudication.operation)) {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  const pending = await matchingPendingVersion(
    tx,
    settings.userId,
    fact.id,
    candidate
  );
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
  if (pending) {
    await createEvent(
      tx,
      claim,
      candidate,
      fact.id,
      pending.id,
      bindingId,
      "REINFORCE"
    );
    const evidenceId = await attachEvidence(
      tx,
      settings.userId,
      pending.id,
      plan.input,
      evidence[0]!
    );
    await persistMemoryCandidateEntities(tx, {
      candidate,
      evidenceId,
      factVersionId: pending.id,
      userId: settings.userId
    });
    return { attachedEvidence: 1, createdVersions: 0 };
  }

  const pendingVersionId = versionId(evidence[0]!.ingestionFingerprint);
  const proposalEventId = await createEvent(
    tx,
    claim,
    candidate,
    fact.id,
    pendingVersionId,
    bindingId,
    "AUTO_PROPOSE"
  );
  await insertVersion(tx, {
    candidate,
    createdByEventId: proposalEventId,
    evidence: evidence[0]!,
    factId: fact.id,
    id: pendingVersionId,
    inputTimeZone: plan.input.timeZone,
    now,
    semanticAdjudication,
    state: "PENDING_RELATION",
    userId: settings.userId
  });
  const evidenceId = await attachEvidence(
    tx,
    settings.userId,
    pendingVersionId,
    plan.input,
    evidence[0]!
  );
  await persistMemoryFactDependencies(
    tx,
    settings.userId,
    pendingVersionId,
    candidate.dependencies
  );
  await persistMemoryCandidateEntities(tx, {
    candidate,
    evidenceId,
    factVersionId: pendingVersionId,
    userId: settings.userId
  });
  return { attachedEvidence: 1, createdVersions: 1 };
}

export async function commitMemoryVNextExtractionPlan(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  bindingId: string,
  now: Date,
  semanticDecision: MemorySemanticAdjudication | null = null
): Promise<MemoryVNextCommitResult> {
  let attachedEvidence = 0;
  let createdVersions = 0;
  for (const candidate of plan.candidates) {
    const result = await createObservation(
      tx,
      settings,
      claim,
      plan,
      candidate,
      bindingId,
      now,
      semanticDecision
    );
    attachedEvidence += result.attachedEvidence;
    createdVersions += result.createdVersions;
  }
  return { attachedEvidence, createdVersions };
}
