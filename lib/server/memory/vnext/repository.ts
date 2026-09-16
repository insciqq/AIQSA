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
  type MemoryFactCandidateDependency,
  type MemoryFactExtractionInput,
  type MemoryFactExtractionPlan
} from "../learning/extraction/contract";
import type { MemorySemanticAdjudication } from "../learning/extraction/contract";
import {
  decodeStoredMemorySemanticFrame,
  memoryRelationshipReplacementIsAuthorized
} from "../learning/extraction/adjudication";
import {
  memoryRepresentationTransitionTimeAllowed,
  type MemoryRelationVersionSnapshot
} from "../learning/relations/policy";
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
import { memoryGroundedEntityCanonicalKey } from "../learning/entities/normalization";
import {
  memoryLegacyIdentityIsUnambiguous,
  memoryRecordedLegacyIdentityKeys,
  registerMemoryIdentityCompatibility
} from "../learning/identity/compatibility";

type LockedFact = Readonly<{
  canonicalKey: string;
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

type LockedCurrentTarget = Readonly<{
  expectedAt: Date | null;
  factId: string;
  identityKind: "PROPOSITION" | "SLOT";
  lastConfirmedAt: Date | null;
  modality: MemoryRelationVersionSnapshot["modality"];
  observedAt: Date | null;
  semanticFrame: Prisma.JsonValue | null;
  subjectEntityIds: readonly string[];
  subjectEntityCanonicalKeys: readonly string[];
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  versionId: string;
}>;

type ExactEvidence = ReturnType<typeof exactEvidence>[number];

export type MemoryVNextCommitResult = Readonly<{
  attachedEvidence: number;
  createdVersions: number;
  reasonCode?: string;
  receiptOutcome?: "REPLAY" | "SUPERSEDED";
  resultingEvidenceId?: string;
  replayedEvidenceIds?: readonly string[];
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
  operation: "AUTO_PROPOSE" | "PROMOTE" | "REINFORCE" | "RETRACT"
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
  operation: "AUTO_PROPOSE" | "PROMOTE" | "REINFORCE" | "RETRACT",
  relatedEvidenceId: string | null = null
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
        schemaVersion: "memory-vnext-observation-event-v3",
        ...(relatedEvidenceId === null ? {} : { relatedEvidenceId })
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
  candidate: MemoryExtractedCandidate,
  now: Date
): Promise<Readonly<{
  fact: LockedFact | null;
  legacyWriteBlocked: boolean;
}>> {
  // Only accepted historical outputs carry a legacy key. New decoders never
  // calculate one; mapping registration consumes those recorded opaque bytes.
  const legacyKey = candidate.legacyCanonicalKey;
  if (legacyKey !== undefined) {
    await registerMemoryIdentityCompatibility(tx, {
      containerId: scopeId,
      legacyCanonicalKey: legacyKey,
      namespace: "FACT",
      now,
      unicodeCanonicalKey: candidate.unicodeCanonicalKey,
      userId
    });
  }
  const recorded = await memoryRecordedLegacyIdentityKeys(tx, {
    containerId: scopeId, namespace: "FACT",
    unicodeCanonicalKey: candidate.unicodeCanonicalKey, userId
  });
  const reusable = recorded.filter(({ unambiguous }) => unambiguous);
  const legacyIsUnambiguous = legacyKey !== undefined &&
    await memoryLegacyIdentityIsUnambiguous(tx, {
      containerId: scopeId, legacyCanonicalKey: legacyKey, namespace: "FACT",
      unicodeCanonicalKey: candidate.unicodeCanonicalKey, userId
    });
  const canonicalKeys = [...new Set([
    candidate.unicodeCanonicalKey,
    ...(reusable.length === 1 ? [reusable[0]!.canonicalKey] : []),
    ...(legacyIsUnambiguous && legacyKey !== undefined ? [legacyKey] : [])
  ])];
  const rows = await tx.$queryRaw<LockedFact[]>(Prisma.sql`
    SELECT "id", "canonicalKey", "currentVersionId", "lastConfirmedAt",
      "movedToFactId",
      "state"::text AS "state"
    FROM "MemoryFact"
    WHERE "userId" = ${userId}
      AND "scopeId" = ${scopeId}
      AND "canonicalKey" IN (${Prisma.join(canonicalKeys)})
    ORDER BY CASE "canonicalKey"
      WHEN ${candidate.unicodeCanonicalKey} THEN 0
      ELSE 1
    END
    FOR UPDATE
  `);
  const fact = rows.find((row) => row.canonicalKey === candidate.unicodeCanonicalKey) ??
    (rows.length === 1 ? rows[0]! : null);
  return {
    fact,
    legacyWriteBlocked:
      (fact === null && rows.length > 1) ||
      (fact === null &&
      candidate.identityProfile === "LEGACY_V1" &&
      candidate.legacyCanonicalKey !== candidate.unicodeCanonicalKey &&
      !legacyIsUnambiguous)
  };
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
  candidate: MemoryExtractedCandidate,
  factCanonicalKey: string
): boolean {
  const structuredValue = factCanonicalKey === candidate.legacyCanonicalKey
    ? candidate.legacyProposedValue
    : factCanonicalKey === candidate.unicodeCanonicalKey
      ? candidate.unicodeProposedValue
      : candidate.proposedValue;
  return memorySha256(normalizedStoredValue(version)) ===
    memorySha256({
      ...memoryFactNormalizedValue(candidate),
      structuredValue
    });
}

async function existingMessageSupport(
  tx: MemoryTransaction,
  userId: string,
  factVersionId: string,
  input: MemoryFactExtractionInput,
  evidence: ExactEvidence
): Promise<string | null> {
  // Different spans or phrasings in one message are the same testimony for
  // this version. Match PostgreSQL's message identity before any semantic
  // mutation, retaining the original immutable excerpt and provenance.
  const existing = await tx.memoryEvidence.findFirst({
    select: { id: true, sourceMessageContentHash: true, sourceRole: true },
    where: {
      chatId: evidence.chatId,
      factVersionId,
      messageId: evidence.messageId,
      sourceProjectionVersion: input.sourceProjectionVersion,
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId
    }
  });
  if (!existing) return null;
  if (existing.sourceRole !== "user" ||
    existing.sourceMessageContentHash !== evidence.sourceTextHash) {
    throw new Error("memory_vnext_evidence_identity_conflict");
  }
  return existing.id;
}

async function attachEvidence(
  tx: MemoryTransaction,
  userId: string,
  factVersionId: string,
  input: MemoryFactExtractionInput,
  evidence: ExactEvidence,
  stance: "CONTRADICTS" | "SUPPORTS" = "SUPPORTS"
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
      evidenceFingerprint: stance === "SUPPORTS" ? evidence.evidenceFingerprint : null,
      factVersionId,
      id,
      messageId: evidence.messageId,
      observedAt: evidence.observedAt,
      safeExcerpt: evidence.quote,
      safeSourceHash: evidence.sourceTextHash,
      safetyClass: "NORMAL",
      sourceEndOffset: stance === "SUPPORTS" ? evidence.endOffset : null,
      sourceMessageContentHash: stance === "SUPPORTS" ? evidence.sourceTextHash : null,
      sourceProjectionVersion: input.sourceProjectionVersion,
      sourceRole: "user",
      sourceStartOffset: stance === "SUPPORTS" ? evidence.startOffset : null,
      sourceType: "MESSAGE",
      stance,
      userId
    }
  });
  return id;
}

async function retractCurrentTarget(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  candidate: MemoryExtractedCandidate,
  evidence: ExactEvidence,
  bindingId: string,
  now: Date,
  scopeId: string,
  adjudication: ResolvedSemanticAdjudication
): Promise<MemoryVNextCommitResult> {
  const guarded = (reasonCode: string): MemoryVNextCommitResult => ({
    attachedEvidence: 0,
    createdVersions: 0,
    reasonCode
  });
  const frame = candidate.semanticFrame;
  const relationshipContext = frame.subjectScope === "USER_RELATIONSHIP_CONTEXT";
  if (frame.polarity !== "RETRACTION" || frame.changeIntent !== "RETRACTION" ||
    frame.speechAct !== "ASSERTION" || frame.assertionStatus !== "ASSERTED" ||
    (frame.subjectScope !== "CURRENT_USER" && !relationshipContext) ||
    frame.temporalPerspective !== "CURRENT" ||
    candidate.confidenceBand !== "HIGH" || adjudication.operation !== "RETRACT_TARGET" ||
    adjudication.entailment !== "ENTAILED" || adjudication.confidenceBand !== "HIGH" ||
    adjudication.assertionStatus !== "ASSERTED" ||
    adjudication.subjectScope !== frame.subjectScope ||
    adjudication.temporalPerspective !== "CURRENT" ||
    adjudication.resolvedTargetVersionId === null) {
    return guarded("withdrawal_semantic_guard");
  }
  const targetContext = plan.input.contextRefs.find(({ kind, ref, source }) =>
    kind === "FACT_VERSION" && ref === adjudication.targetRef &&
    source.factVersionId === adjudication.resolvedTargetVersionId);
  if (!targetContext) return guarded("withdrawal_target_binding_stale");
  const declaredFactTargets = candidate.dependencies
    .map(({ source }) => source.factVersionId)
    .filter((versionId): versionId is string => versionId !== null);
  if (declaredFactTargets.some((versionId) =>
    versionId !== adjudication.resolvedTargetVersionId)) {
    return guarded("withdrawal_dependency_target_mismatch");
  }
  const target = await lockedCurrentTarget(
    tx,
    settings.userId,
    scopeId,
    adjudication.resolvedTargetVersionId,
    now
  );
  if (!target) return guarded("withdrawal_target_not_current_or_authorized");
  const targetScope = decodeStoredMemorySemanticFrame(target.semanticFrame)?.subjectScope;
  if ((relationshipContext && targetScope !== "USER_RELATIONSHIP_CONTEXT") ||
    (!relationshipContext && targetScope === "USER_RELATIONSHIP_CONTEXT")) {
    return guarded("withdrawal_target_subject_mismatch");
  }
  if (relationshipContext && !relationshipSubjectMatches(candidate, target)) {
    return guarded("withdrawal_target_subject_mismatch");
  }
  if (target.sourceMode !== "AUTOMATIC") {
    return guarded("withdrawal_explicit_authority");
  }
  const lastAuthorityAt = Math.max(
    target.observedAt?.getTime() ?? -1,
    target.lastConfirmedAt?.getTime() ?? -1
  );
  if (evidence.observedAt.getTime() <= lastAuthorityAt) {
    return guarded("withdrawal_stale_testimony");
  }

  await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  const retractionEvidenceId = await attachEvidence(
    tx,
    settings.userId,
    target.versionId,
    plan.input,
    evidence,
    "CONTRADICTS"
  );
  await createEvent(
    tx,
    claim,
    candidate,
    target.factId,
    target.versionId,
    bindingId,
    "RETRACT",
    retractionEvidenceId
  );
  const version = await tx.memoryFactVersion.updateMany({
    data: { state: "RETRACTED", systemTo: now },
    where: {
      factId: target.factId,
      id: target.versionId,
      state: "ACTIVE",
      systemTo: null,
      userId: settings.userId
    }
  });
  const fact = await tx.memoryFact.updateMany({
    data: { currentVersionId: null, state: "RETRACTED", updatedAt: now },
    where: {
      currentVersionId: target.versionId,
      id: target.factId,
      state: "ACTIVE",
      userId: settings.userId
    }
  });
  if (version.count !== 1 || fact.count !== 1) {
    throw new Error("memory_vnext_withdrawal_state_conflict");
  }
  await tx.memorySearchEntry.deleteMany({
    where: { factVersionId: target.versionId, userId: settings.userId }
  });
  return {
    attachedEvidence: 1,
    createdVersions: 0,
    reasonCode: "target_retracted",
    receiptOutcome: "SUPERSEDED",
    resultingEvidenceId: retractionEvidenceId
  };
}

async function lockedCurrentTarget(
  tx: MemoryTransaction,
  userId: string,
  scopeId: string,
  versionId: string,
  now: Date
): Promise<LockedCurrentTarget | null> {
  const rows = await tx.$queryRaw<LockedCurrentTarget[]>(Prisma.sql`
    SELECT fact."id" AS "factId", fact."lastConfirmedAt",
      fact."identityKind"::text AS "identityKind",
      version."expectedAt", version."observedAt", version."semanticFrame",
      version."modality"::text AS "modality",
      version."sourceMode"::text AS "sourceMode", version."id" AS "versionId",
      COALESCE((SELECT ARRAY_AGG(DISTINCT aiqsa_memory_entity_root_id(
        link."userId", link."entityId")::text)
        FROM "MemoryFactVersionEntity" AS link
        WHERE link."userId" = version."userId"
          AND link."factVersionId" = version."id"
          AND link."role" = 'SUBJECT'::"MemoryEntityLinkRole"
      ), ARRAY[]::text[]) AS "subjectEntityIds",
      COALESCE((SELECT ARRAY_AGG(DISTINCT root."canonicalKey")
        FROM "MemoryFactVersionEntity" AS link
        INNER JOIN "MemoryEntity" AS root
          ON root."userId" = link."userId"
          AND root."id" = aiqsa_memory_entity_root_id(
            link."userId", link."entityId")
        WHERE link."userId" = version."userId"
          AND link."factVersionId" = version."id"
          AND link."role" = 'SUBJECT'::"MemoryEntityLinkRole"
      ), ARRAY[]::text[]) AS "subjectEntityCanonicalKeys"
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

function relationshipSubjectMatches(
  candidate: MemoryExtractedCandidate,
  target: LockedCurrentTarget
): boolean {
  const candidateContextIds = new Set(candidate.entities
    .filter(({ role, contextEntityId }) => role === "SUBJECT" &&
      contextEntityId !== null)
    .map(({ contextEntityId }) => contextEntityId!));
  const candidateCanonicalKeys = new Set(candidate.entities
    .filter(({ role }) => role === "SUBJECT")
    .map((entity) => memoryGroundedEntityCanonicalKey(entity))
    .filter((key): key is string => key !== null));
  const targetIds = new Set(target.subjectEntityIds);
  const targetKeys = new Set(target.subjectEntityCanonicalKeys);
  const idMatch = candidateContextIds.size > 0 && candidateContextIds.size ===
    targetIds.size && [...candidateContextIds].every((id) => targetIds.has(id));
  const keyMatch = candidateCanonicalKeys.size > 0 &&
    candidateCanonicalKeys.size === targetKeys.size &&
    [...candidateCanonicalKeys].every((key) => targetKeys.has(key));
  return idMatch || keyMatch;
}

function relationshipSubjectReplacementAllowed(
  candidate: MemoryExtractedCandidate,
  target: LockedCurrentTarget | null,
  decision: MemorySemanticAdjudication
): boolean {
  const subjects = candidate.entities.filter(({ role }) => role === "SUBJECT");
  const subject = subjects[0];
  return memoryRelationshipReplacementIsAuthorized(decision) && target !== null &&
    candidate.identityKind === "PROPOSITION" && target.identityKind === "PROPOSITION" &&
    candidate.modality === "STATE" &&
    candidate.semanticFrame.subjectScope === "USER_RELATIONSHIP_CONTEXT" &&
    candidate.semanticFrame.assertionStatus === "ASSERTED" &&
    candidate.semanticFrame.temporalPerspective === "CURRENT" &&
    subjects.length === 1 && subject !== undefined &&
    (subject.mentionKind === "NAMED" || subject.mentionKind === "NOMINAL") &&
    memoryGroundedEntityCanonicalKey(subject) !== null &&
    target.subjectEntityIds.length === 1 &&
    !relationshipSubjectMatches(candidate, target);
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
  target: Pick<LockedCurrentTarget, "factId" | "lastConfirmedAt" | "versionId">
): Promise<MemoryVNextCommitResult> {
  const replayedEvidenceId = await existingMessageSupport(
    tx, settings.userId, target.versionId, plan.input, evidence
  );
  if (replayedEvidenceId) {
    return { attachedEvidence: 0, createdVersions: 0, replayedEvidenceIds: [replayedEvidenceId] };
  }
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
  factCanonicalKey: string,
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
  return pending.find((version) =>
    sameValue(version, candidate, factCanonicalKey)) ?? null;
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
  candidate: MemoryExtractedCandidate,
  adjudicatedTargetVersionId?: string
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
      AND ${adjudicatedTargetVersionId === undefined
        ? Prisma.sql`fact."predicateKey" IS NOT DISTINCT FROM ${candidate.predicateKey}`
        : Prisma.sql`version."id" = ${adjudicatedTargetVersionId}`}
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
  semanticAdjudication: ResolvedSemanticAdjudication | null,
  correctionDependency: MemoryFactCandidateDependency | null = null
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
    correctionDependency === null
      ? candidate.dependencies
      : [
          ...candidate.dependencies.map((dependency) =>
            dependency.dependencyKind === "CORRECTION_TARGET" &&
              dependency.source.messageId !== null
              ? { ...dependency, dependencyKind: "RELATION_CONTEXT" as const }
              : dependency),
          correctionDependency
        ]
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
    return {
      attachedEvidence: 0,
      createdVersions: 0,
      reasonCode: "dependency_source_stale"
    };
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
    return {
      attachedEvidence: 0,
      createdVersions: 0,
      reasonCode: candidate.semanticFrame.changeIntent === "RETRACTION"
        ? "withdrawal_replay"
        : "evidence_replay",
      receiptOutcome: "REPLAY",
      replayedEvidenceIds: [replay.id]
    };
  }

  const semanticAdjudication = resolveSemanticAdjudication(plan, decision);
  if (decision !== null && semanticAdjudication === null) {
    return {
      attachedEvidence: 0,
      createdVersions: 0,
      reasonCode: "adjudication_reference_stale"
    };
  }

  const scope = await ensureGlobalMemoryScope(tx, settings);
  if (semanticAdjudication?.operation === "RETRACT_TARGET") {
    return retractCurrentTarget(
      tx,
      settings,
      claim,
      plan,
      candidate,
      evidence[0]!,
      bindingId,
      now,
      scope.id,
      semanticAdjudication
    );
  }
  if (semanticAdjudication?.operation === "REINFORCE" &&
    semanticAdjudication.resolvedTargetVersionId !== null) {
    const target = await lockedCurrentTarget(
      tx,
      settings.userId,
      scope.id,
      semanticAdjudication.resolvedTargetVersionId,
      now
    );
    const targetScope = target === null
      ? undefined
      : decodeStoredMemorySemanticFrame(target.semanticFrame)?.subjectScope;
    if (target && ((candidate.semanticFrame.subjectScope ===
      "USER_RELATIONSHIP_CONTEXT" && targetScope !== "USER_RELATIONSHIP_CONTEXT") ||
      (candidate.semanticFrame.subjectScope === "CURRENT_USER" &&
        targetScope === "USER_RELATIONSHIP_CONTEXT"))) {
      return {
        attachedEvidence: 0,
        createdVersions: 0,
        reasonCode: "relationship_target_subject_mismatch"
      };
    }
    if (target && candidate.semanticFrame.subjectScope ===
      "USER_RELATIONSHIP_CONTEXT" && !relationshipSubjectMatches(candidate, target)) {
      return {
        attachedEvidence: 0,
        createdVersions: 0,
        reasonCode: "relationship_target_subject_mismatch"
      };
    }
    if (target) {
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
    // An exact target can have crossed its TTL after adjudication. SLOT
    // identity must fall through to the canonical locked path, which alone
    // may materialize that exact expired version and create a fresh one.
    // Stale/non-current targets still fail its target/pointer revalidation.
  }
  // A direct state or schedule update retains its exact target and enters guarded
  // relation resolution. It must not create a second active proposition or
  // allow weaker testimony to replace an explicit or structured current fact.
  const transitionTarget = semanticAdjudication !== null &&
    semanticAdjudication.resolvedTargetVersionId !== null
    ? await lockedCurrentTarget(
        tx, settings.userId, scope.id,
        semanticAdjudication.resolvedTargetVersionId, now
      )
    : null;
  if (semanticAdjudication !== null &&
    semanticAdjudication.resolvedTargetVersionId !== null &&
    (candidate.identityKind === "PROPOSITION" ||
      transitionTarget?.identityKind === "PROPOSITION")) {
    const replacesRelationship = semanticAdjudication.operation ===
      "REPLACE_RELATIONSHIP_TARGET";
    if (candidate.confidenceBand !== "HIGH" ||
      (replacesRelationship && !relationshipSubjectReplacementAllowed(
        candidate, transitionTarget, semanticAdjudication
      )) ||
      (candidate.semanticFrame.changeIntent !== "CORRECTION" &&
        candidate.semanticFrame.changeIntent !== "STATE_CHANGE") ||
      !memoryRepresentationTransitionTimeAllowed(
        { ...candidate, observedAt: evidence[0]!.observedAt.toISOString() },
        transitionTarget === null ? null : {
          expectedAt: transitionTarget.expectedAt?.toISOString() ?? null,
          modality: transitionTarget.modality,
          observedAt: transitionTarget.observedAt?.toISOString() ?? null,
          semanticFrame: decodeStoredMemorySemanticFrame(transitionTarget.semanticFrame)
        },
        semanticAdjudication.temporalPerspective
      ) ||
      semanticAdjudication.entailment !== "ENTAILED" ||
      semanticAdjudication.confidenceBand !== "HIGH" ||
      (candidate.semanticFrame.subjectScope === "USER_RELATIONSHIP_CONTEXT"
        ? semanticAdjudication.subjectScope !== "USER_RELATIONSHIP_CONTEXT" ||
          decodeStoredMemorySemanticFrame(transitionTarget?.semanticFrame ?? null)
            ?.subjectScope !== "USER_RELATIONSHIP_CONTEXT" ||
          transitionTarget === null ||
          (!replacesRelationship && !relationshipSubjectMatches(candidate, transitionTarget))
        : semanticAdjudication.subjectScope !== "CURRENT_USER" ||
          decodeStoredMemorySemanticFrame(transitionTarget?.semanticFrame ?? null)
            ?.subjectScope === "USER_RELATIONSHIP_CONTEXT") ||
      semanticAdjudication.assertionStatus !== "ASSERTED" ||
      !["SUPERSEDE_TARGET", "MOVE_TO_DISTINCT_FACT", "REPLACE_RELATIONSHIP_TARGET"].includes(
        semanticAdjudication.operation
      )) return { attachedEvidence: 0, createdVersions: 0 };
    const declaredTarget = await correctionTargetVersionId(
      tx, settings.userId, candidate, semanticAdjudication.resolvedTargetVersionId
    );
    const hasDeclaredTarget = candidate.dependencies.some(({ dependencyKind }) =>
      dependencyKind === "CORRECTION_TARGET");
    const correctionTarget = semanticAdjudication.resolvedTargetVersionId;
    if (hasDeclaredTarget && declaredTarget !== correctionTarget) {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    if (transitionTarget === null || transitionTarget.sourceMode !== "AUTOMATIC") {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    const existing = await lockedFact(tx, settings.userId, scope.id, candidate, now);
    if (existing.fact !== null || existing.legacyWriteBlocked) {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    // A message antecedent may support several facts. Verify membership above,
    // retain that message as source context, and bind the selected immutable
    // fact separately so relation resolution never has to guess again.
    const targetContext = plan.input.contextRefs.find(({ kind, ref, source }) =>
      kind === "FACT_VERSION" && ref === semanticAdjudication.targetRef &&
      source.factVersionId === correctionTarget);
    if (!targetContext) return { attachedEvidence: 0, createdVersions: 0 };
    const correctionDependency: MemoryFactCandidateDependency | null = candidate.dependencies.some(
      ({ dependencyKind, source }) => dependencyKind === "CORRECTION_TARGET" &&
        source.factVersionId === correctionTarget)
      ? null
      : {
          dependencyKind: "CORRECTION_TARGET",
          ref: targetContext.ref,
          source: targetContext.source
        };
    if (correctionDependency !== null && !await memoryFactDependenciesAreValid(
      tx, settings.userId, proposedVersionId, [correctionDependency]
    )) return { attachedEvidence: 0, createdVersions: 0 };
    return createCrossFactRelationVersion(
      tx, settings, claim, plan, candidate, evidence[0]!, bindingId, now,
      scope.id, semanticAdjudication, correctionDependency
    );
  }
  const factLookup = await lockedFact(
    tx,
    settings.userId,
    scope.id,
    candidate,
    now
  );
  // Once one legacy key is known to represent multiple complete Unicode
  // identities, rollback may continue to read/reinforce an existing Unicode
  // fact but must never create or merge through the ambiguous legacy key.
  if (factLookup.legacyWriteBlocked) {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  const fact = factLookup.fact;
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

  if (sameValue(active, candidate, fact.canonicalKey)) {
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
    fact.canonicalKey,
    candidate
  );
  if (pending) {
    const replayedEvidenceId = await existingMessageSupport(
      tx, settings.userId, pending.id, plan.input, evidence[0]!
    );
    if (replayedEvidenceId) {
      return { attachedEvidence: 0, createdVersions: 0, replayedEvidenceIds: [replayedEvidenceId] };
    }
    await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
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

  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
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
  let reasonCode: string | undefined;
  let receiptOutcome: MemoryVNextCommitResult["receiptOutcome"];
  let resultingEvidenceId: string | undefined;
  const replayedEvidenceIds: string[] = [];
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
    reasonCode = result.reasonCode ?? reasonCode;
    receiptOutcome = result.receiptOutcome ?? receiptOutcome;
    resultingEvidenceId = result.resultingEvidenceId ?? resultingEvidenceId;
    replayedEvidenceIds.push(...result.replayedEvidenceIds ?? []);
  }
  return {
    attachedEvidence,
    createdVersions,
    ...(plan.candidates.length !== 1 || reasonCode === undefined
      ? {}
      : { reasonCode }),
    ...(plan.candidates.length !== 1 || receiptOutcome === undefined
      ? {}
      : { receiptOutcome }),
    ...(plan.candidates.length !== 1 || resultingEvidenceId === undefined
      ? {}
      : { resultingEvidenceId }),
    ...(replayedEvidenceIds.length > 0 ? { replayedEvidenceIds } : {})
  };
}
