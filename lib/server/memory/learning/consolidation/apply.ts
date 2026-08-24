import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { MemoryJobClaim } from "../../coordinator/types";
import {
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryItemEmbeddingJobFingerprint
} from "../../embedding/contract";
import { enqueueMemoryJob } from "../../persistence/jobs";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../../persistence/lexical";
import { memoryPersonalFactEvidencePredicate } from "../../persistence/eligibility";
import {
  ensureGlobalMemoryScope,
  memoryCanonicalGlobalScopePredicate
} from "../../persistence/scopes";
import {
  advanceMemoryMutation,
  lockMemorySettings,
  requireActiveMemoryIndex,
  type LockedMemorySettings,
  type MemoryActiveIndex,
  type MemoryTransaction
} from "../../persistence/transaction";
import type { MemorySuppressionKeyring } from "../../suppressionKeyring";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION as MEMORY_FACT_EXTRACTION_V1 } from "../extraction/contract";
import {
  memoryFactDecisionId,
  MEMORY_FACT_CONSOLIDATION_V1_OPERATIONS,
  MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
  type MemoryFactCandidateEvidenceSnapshot,
  type MemoryFactCandidateSnapshot,
  type MemoryFactConsolidationInput,
  type MemoryFactConsolidationPlanOperation,
  type MemoryFactConsolidationPlan,
  type MemoryFactVerificationInput,
  type MemoryFactVerificationPlan
} from "./contract";
import { evaluateMemoryFactConsolidationPlan } from "./policy";
import {
  prepareMemoryFactConsolidation,
  prepareMemoryFactVerification
} from "./source";

type CurrentFactRow = Readonly<{
  canonicalKey: string;
  category: string;
  currentVersionId: string | null;
  id: string;
  lastConfirmedAt: Date | null;
  movedToFactId: string | null;
  scopeId: string;
  state: "ACTIVE" | "CONFLICTED" | "EXPIRED" | "ORPHANED" | "RETRACTED";
}>;

type CurrentVersionRow = Readonly<{
  category: string;
  confidence: number;
  directness: "DIRECT" | "INFERRED" | "PARAPHRASED";
  displayText: string | null;
  id: string;
  importance: number;
  languageCode: string;
  modality: MemoryFactCandidateSnapshot["modality"];
  sensitivityClass: "HIGHLY_SENSITIVE" | "NORMAL" | "SECRET" | "SENSITIVE";
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state: "ACTIVE";
  structuredValue: Prisma.JsonValue | null;
  systemFrom: Date;
  systemTo: Date | null;
  validFrom: Date | null;
  validTo: Date | null;
}>;

type SemanticApplyResult = Readonly<{
  factId: string;
  semanticMutation: boolean;
  versionId: string;
}>;

function isV1Operation(
  operation: MemoryFactConsolidationPlanOperation
): boolean {
  return (MEMORY_FACT_CONSOLIDATION_V1_OPERATIONS as readonly string[])
    .includes(operation);
}

function isV1Candidate(candidate: MemoryFactCandidateSnapshot): boolean {
  return candidate.confidenceBand === "HIGH" &&
    typeof candidate.proposedValue === "object" &&
    candidate.proposedValue !== null &&
    !Array.isArray(candidate.proposedValue) &&
    typeof (candidate.proposedValue as { statement?: unknown }).statement === "string";
}

/** The durable enum retains retired names for old rows. New v1 decisions are
 * projected without reviving those workflows: REPLACE is the immutable
 * version transition historically named SUPERSEDE, and REJECT is a terminal
 * candidate outcome represented by the legacy DEFER enum value. */
function persistedOperation(
  operation: MemoryFactConsolidationPlanOperation
): "ADD" | "REINFORCE" | "SUPERSEDE" | "CONFLICT" | "EXPIRE" | "NOOP" | "DEFER" {
  if (operation === "REPLACE") return "SUPERSEDE";
  if (operation === "REJECT") return "DEFER";
  return operation as ReturnType<typeof persistedOperation>;
}

function transitionAt(now: Date, ...prior: Array<Date | null | undefined>): Date {
  return new Date(Math.max(
    now.getTime(),
    ...prior.map((value) => (value?.getTime() ?? -1) + 1)
  ));
}

function candidateCategory(candidate: MemoryFactCandidateSnapshot): string {
  return candidate.category === "sensitive" ? "about_you" : candidate.category;
}

function candidateValue(candidate: MemoryFactCandidateSnapshot) {
  return {
    category: candidateCategory(candidate),
    confidence: candidate.confidence,
    coreEligible: false,
    coreSalience: "NONE" as const,
    directness: candidate.directness,
    displayText: candidate.displayText,
    importance: candidate.importance,
    languageCode: candidate.languageCode,
    modality: candidate.modality,
    normalizedSearchText: normalizeMemorySearchText(candidate.displayText),
    pipelineVersion: MEMORY_FACT_CONSOLIDATION_PIPELINE_VERSION,
    rawTemporalExpression: candidate.rawTemporalExpression,
    sensitivityClass: "NORMAL" as const,
    sourceTimezone: candidate.sourceTimezone,
    sourceMode: "AUTOMATIC" as const,
    structuredValue: candidate.proposedValue === null
      ? Prisma.JsonNull
      : candidate.proposedValue as Prisma.InputJsonValue,
    temporalResolutionEvidence: candidate.temporalResolutionEvidence === null
      ? Prisma.DbNull
      : candidate.temporalResolutionEvidence as Prisma.InputJsonValue,
    temporalResolverVersion: candidate.temporalResolverVersion,
    validFrom: candidate.validFrom ? new Date(candidate.validFrom) : null,
    validTo: candidate.validTo ? new Date(candidate.validTo) : null
  };
}

async function extractionSafetyData(
  tx: MemoryTransaction,
  userId: string,
  candidate: MemoryFactCandidateSnapshot
) {
  const binding = await tx.memoryExecutionBinding.findFirst({
    select: {
      acceptedOutputHash: true,
      completedAt: true,
      policyVersion: true,
      providerId: true,
      providerModelId: true
    },
    where: {
      id: candidate.extractionExecutionId,
      logicalRole: "MEMORY_FACT_EXTRACT",
      ownerType: "JOB",
      state: "SUCCEEDED",
      userId
    }
  });
  if (
    !binding?.acceptedOutputHash || !binding.completedAt ||
    !binding.providerId || !binding.policyVersion
  ) {
    throw new Error("memory_fact_extraction_provenance_invalid");
  }
  const usage = await tx.usageEvent.findUnique({
    select: { id: true, provider: true, providerModelId: true },
    where: { memoryExecutionBindingId: candidate.extractionExecutionId }
  });
  const providerModelId = binding.providerModelId ?? usage?.providerModelId;
  if (
    !usage || usage.provider !== binding.providerId || !providerModelId ||
    (binding.providerModelId !== null &&
      usage.providerModelId !== binding.providerModelId)
  ) {
    throw new Error("memory_fact_extraction_provenance_invalid");
  }
  return {
    safetyClassificationReasonCode: "automatic_extraction",
    safetyClassificationState: "CLASSIFIED" as const,
    safetyClassifiedAt: binding.completedAt,
    safetyClassifierExecutionId: candidate.extractionExecutionId,
    safetyClassifierModelId: providerModelId,
    safetyClassifierPolicyVersion: binding.policyVersion,
    safetyClassifierProviderId: binding.providerId
  };
}

async function requireSucceededBinding(
  tx: MemoryTransaction,
  input: Readonly<{
    acceptedOutputHash: string;
    bindingId: string;
    inputHash: string;
    jobId: string;
    role: "MEMORY_CONSOLIDATE" | "MEMORY_VERIFY";
    userId: string;
  }>
): Promise<void> {
  const binding = await tx.memoryExecutionBinding.findFirst({
    select: { id: true },
    where: {
      acceptedOutputHash: input.acceptedOutputHash,
      id: input.bindingId,
      inputHash: input.inputHash,
      logicalRole: input.role,
      memoryJobId: input.jobId,
      ownerType: "JOB",
      state: "SUCCEEDED",
      userId: input.userId
    }
  });
  if (!binding) throw new Error("memory_fact_decision_binding_stale");
}

async function createEvent(
  tx: MemoryTransaction,
  input: Readonly<{
    candidate: MemoryFactCandidateSnapshot;
    decisionId: string;
    executionId: string;
    factId: string;
    operation: "CONFLICT" | "EXPIRE" | "PROMOTE" | "REINFORCE" | "SUPERSEDE";
    userId: string;
    versionId: string;
  }>
): Promise<string> {
  const id = randomUUID();
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId: input.factId,
      factVersionId: input.versionId,
      id,
      metadata: {
        candidateId: input.candidate.id,
        consolidationDecisionId: input.decisionId,
        consolidationExecutionId: input.executionId,
        schemaVersion: "memory-automatic-fact-event-v1"
      },
      operation: input.operation,
      sourceChatId: input.candidate.chatId,
      sourceGeneration: input.candidate.branchGeneration,
      userId: input.userId
    }
  });
  return id;
}

function evidenceData(
  userId: string,
  factVersionId: string,
  candidate: MemoryFactCandidateSnapshot,
  stance: "CONTRADICTS" | "SUPPORTS",
  evidence: MemoryFactCandidateEvidenceSnapshot
) {
  return {
    branchGeneration: candidate.branchGeneration,
    chatId: candidate.chatId,
    factVersionId,
    messageId: evidence.messageId,
    observedAt: new Date(evidence.observedAt),
    safeExcerpt: evidence.quote,
    safeSourceHash: evidence.sourceTextHash,
    safetyClass: "NORMAL" as const,
    sourceProjectionVersion: candidate.sourceProjectionVersion,
    sourceRole: "user",
    sourceType: "MESSAGE" as const,
    stance,
    userId
  };
}

async function createEvidence(
  tx: MemoryTransaction,
  userId: string,
  versionId: string,
  candidate: MemoryFactCandidateSnapshot,
  stance: "CONTRADICTS" | "SUPPORTS"
): Promise<number> {
  const result = await tx.memoryEvidence.createMany({
    data: candidate.evidence.map((evidence) =>
      evidenceData(userId, versionId, candidate, stance, evidence)),
    skipDuplicates: true
  });
  return result.count;
}

async function createSearchEntry(
  tx: MemoryTransaction,
  index: MemoryActiveIndex,
  userId: string,
  versionId: string,
  candidate: MemoryFactCandidateSnapshot,
  retrievable: boolean
) {
  const normalizedSearchText = normalizeMemorySearchText(candidate.displayText);
  return tx.memorySearchEntry.create({
    data: {
      embeddingState: retrievable && index.indexMode === "HYBRID"
        ? "PENDING"
        : "NOT_APPLICABLE",
      factVersionId: versionId,
      indexGenerationId: index.id,
      itemType: "FACT_VERSION",
      languageCode: candidate.languageCode,
      safeContentHash: memorySha256({
        displayText: candidate.displayText,
        structuredValue: candidate.proposedValue
      }),
      normalizedSearchText,
      safetyIdentitySnapshot: memorySha256({
        safetyClass: "NORMAL",
        secretTaintedSourceWindow: false
      }),
      sourceIdentitySnapshot: memorySha256({
        branchGeneration: candidate.branchGeneration,
        evidence: candidate.evidence.map((evidence) => ({
          messageId: evidence.messageId,
          sourceTextHash: evidence.sourceTextHash
        })),
        sourceHash: candidate.sourceHash,
        sourceProjectionVersion: candidate.sourceProjectionVersion,
        sourceRevision: candidate.sourceRevision
      }),
      suppressionIdentitySnapshot: memorySha256({
        canonicalKey: candidate.canonicalKey,
        category: candidateCategory(candidate),
        normalizedValue: normalizedSearchText
      }),
      userId
    },
    select: { embeddingState: true, id: true }
  });
}

async function enqueueDerivedWork(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  candidate: MemoryFactCandidateSnapshot,
  decisionId: string,
  factId: string,
  searchEntry: Readonly<{ embeddingState: string; id: string }> | null
): Promise<void> {
  if (searchEntry?.embeddingState === "PENDING") {
    await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(
        searchEntry.id,
        decisionId
      ),
      kind: "EMBED_ITEMS",
      pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
    });
  }
  void candidate;
  void factId;
}

async function lockTargetFact(
  tx: MemoryTransaction,
  userId: string,
  factId: string,
  versionId: string
): Promise<Readonly<{ fact: CurrentFactRow; version: CurrentVersionRow }> | null> {
  const rows = await tx.$queryRaw<CurrentFactRow[]>(Prisma.sql`
    SELECT
      fact."id", fact."scopeId", fact."canonicalKey", fact."category",
      fact."state"::text AS "state", fact."currentVersionId",
      fact."lastConfirmedAt", fact."movedToFactId"
    FROM "MemoryFact" AS fact
    INNER JOIN "MemoryScope" AS scope
      ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
    INNER JOIN "MemoryFactVersion" AS version
      ON version."userId" = fact."userId"
      AND version."factId" = fact."id"
      AND version."id" = ${versionId}
    WHERE fact."userId" = ${userId} AND fact."id" = ${factId}
      AND scope."state" = 'ACTIVE'::"MemoryScopeState"
      AND ${memoryCanonicalGlobalScopePredicate()}
      AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
      AND (version."expiresAt" IS NULL OR version."expiresAt" > CURRENT_TIMESTAMP)
      AND version."safetyClassificationState" =
        'CLASSIFIED'::"MemorySafetyClassificationState"
      AND version."contentPurgedAt" IS NULL
      AND ${memoryPersonalFactEvidencePredicate(userId)}
    FOR UPDATE OF fact, scope, version
  `);
  const fact = rows[0];
  if (
    !fact || fact.state !== "ACTIVE" || fact.currentVersionId !== versionId ||
    fact.movedToFactId !== null
  ) return null;
  const version = await tx.memoryFactVersion.findFirst({
    select: {
      category: true,
      confidence: true,
      directness: true,
      displayText: true,
      id: true,
      importance: true,
      languageCode: true,
      modality: true,
      sensitivityClass: true,
      sourceMode: true,
      state: true,
      structuredValue: true,
      systemFrom: true,
      systemTo: true,
      validFrom: true,
      validTo: true
    },
    where: { factId, id: versionId, state: "ACTIVE", userId }
  }) as CurrentVersionRow | null;
  return version ? { fact, version } : null;
}

async function applyAdd(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  candidate: MemoryFactCandidateSnapshot,
  decisionId: string,
  executionId: string,
  now: Date
): Promise<SemanticApplyResult | null> {
  const scope = await ensureGlobalMemoryScope(tx, settings);
  const facts = await tx.$queryRaw<CurrentFactRow[]>(Prisma.sql`
    SELECT
      "id", "scopeId", "canonicalKey", "category", "state"::text AS "state",
      "currentVersionId", "lastConfirmedAt", "movedToFactId"
    FROM "MemoryFact"
    WHERE "userId" = ${settings.userId}
      AND "scopeId" = ${scope.id}
      AND "canonicalKey" = ${candidate.canonicalKey}
    FOR UPDATE
  `);
  const existing = facts[0] ?? null;
  if (
    existing && (
      !["EXPIRED", "RETRACTED"].includes(existing.state) ||
      existing.currentVersionId !== null || existing.movedToFactId !== null
    )
  ) return null;
  let priorVersion: Readonly<{ id: string; systemFrom: Date }> | null = null;
  if (existing) {
    const explicit = await tx.memoryFactVersion.count({
      where: { factId: existing.id, sourceMode: "EXPLICIT", userId: settings.userId }
    });
    if (explicit > 0) return null;
    priorVersion = await tx.memoryFactVersion.findFirst({
      orderBy: [{ systemFrom: "desc" }, { id: "desc" }],
      select: { id: true, systemFrom: true },
      where: { factId: existing.id, userId: settings.userId }
    });
  }
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const factId = existing?.id ?? randomUUID();
  const versionId = randomUUID();
  const systemFrom = transitionAt(now, priorVersion?.systemFrom);
  if (existing) {
    const updated = await tx.memoryFact.updateMany({
      data: {
        category: candidateCategory(candidate),
        currentVersionId: versionId,
        lastConfirmedAt: new Date(Math.max(...candidate.evidence.map((item) =>
          new Date(item.observedAt).getTime()))),
        state: "ACTIVE"
      },
      where: {
        currentVersionId: null,
        id: factId,
        state: existing.state,
        userId: settings.userId
      }
    });
    if (updated.count !== 1) throw new Error("memory_fact_add_stale");
  } else {
    await tx.memoryFact.create({
      data: {
        canonicalKey: candidate.canonicalKey,
        category: candidateCategory(candidate),
        currentVersionId: versionId,
        id: factId,
        lastConfirmedAt: new Date(Math.max(...candidate.evidence.map((item) =>
          new Date(item.observedAt).getTime()))),
        scopeId: scope.id,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
  }
  const eventId = await createEvent(tx, {
    candidate,
    decisionId,
    executionId,
    factId,
    operation: "PROMOTE",
    userId: settings.userId,
    versionId
  });
  const safety = await extractionSafetyData(tx, settings.userId, candidate);
  await tx.memoryFactVersion.create({
    data: {
      ...candidateValue(candidate),
      ...safety,
      createdByEventId: eventId,
      factId,
      id: versionId,
      state: "ACTIVE",
      supersedesVersionId: priorVersion?.id,
      systemFrom,
      userId: settings.userId
    }
  });
  await createEvidence(tx, settings.userId, versionId, candidate, "SUPPORTS");
  const entry = await createSearchEntry(
    tx,
    index,
    settings.userId,
    versionId,
    candidate,
    true
  );
  await enqueueDerivedWork(tx, settings, candidate, decisionId, factId, entry);
  return { factId, semanticMutation: true, versionId };
}

async function applyReinforce(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  candidate: MemoryFactCandidateSnapshot,
  decisionId: string,
  executionId: string,
  factId: string,
  versionId: string
): Promise<SemanticApplyResult | null> {
  const target = await lockTargetFact(tx, settings.userId, factId, versionId);
  if (!target) return null;
  const factCandidate = { ...candidate, canonicalKey: target.fact.canonicalKey };
  const existing = await tx.memoryEvidence.findMany({
    select: { messageId: true, sourceProjectionVersion: true },
    where: {
      factVersionId: versionId,
      messageId: { in: candidate.evidence.map((item) => item.messageId) },
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId: settings.userId
    }
  });
  const existingKeys = new Set(existing.map((item) =>
    `${item.messageId}:${item.sourceProjectionVersion}`));
  const fresh = candidate.evidence.filter((item) =>
    !existingKeys.has(`${item.messageId}:${candidate.sourceProjectionVersion}`));
  if (fresh.length === 0) {
    return { factId, semanticMutation: false, versionId };
  }
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
  const eventId = await createEvent(tx, {
    candidate,
    decisionId,
    executionId,
    factId,
    operation: "REINFORCE",
    userId: settings.userId,
    versionId
  });
  await tx.memoryEvidence.createMany({
    data: fresh.map((item) =>
      evidenceData(settings.userId, versionId, candidate, "SUPPORTS", item)),
    skipDuplicates: true
  });
  const confirmedAt = new Date(Math.max(
    target.fact.lastConfirmedAt?.getTime() ?? -1,
    ...fresh.map((item) => new Date(item.observedAt).getTime())
  ));
  await tx.memoryFact.update({
    data: { lastConfirmedAt: confirmedAt },
    where: { id: factId }
  });
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  let entry = await tx.memorySearchEntry.findFirst({
    select: { embeddingState: true, id: true },
    where: {
      factVersionId: versionId,
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  if (!entry && target.version.displayText && target.version.structuredValue !== null) {
    entry = await createSearchEntry(
      tx,
      index,
      settings.userId,
      versionId,
      factCandidate,
      true
    );
  }
  await enqueueDerivedWork(tx, settings, candidate, decisionId, factId, entry);
  void eventId;
  return { factId, semanticMutation: true, versionId };
}

async function applyVersionTransition(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  candidate: MemoryFactCandidateSnapshot,
  decisionId: string,
  executionId: string,
  plan: MemoryFactConsolidationPlan,
  now: Date
): Promise<SemanticApplyResult | null> {
  if (!plan.targetFactId || !plan.targetVersionId) return null;
  const target = await lockTargetFact(
    tx,
    settings.userId,
    plan.targetFactId,
    plan.targetVersionId
  );
  if (!target) return null;
  const factCandidate = { ...candidate, canonicalKey: target.fact.canonicalKey };
  if (plan.operation === "EXPIRE" && target.version.sourceMode !== "AUTOMATIC") {
    return null;
  }
  await advanceMemoryMutation(tx, settings, "AUTOMATIC_VERSION_TRANSITION");
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  const at = transitionAt(now, target.version.systemFrom);
  if (plan.operation === "EXPIRE") {
    const eventId = await createEvent(tx, {
      candidate,
      decisionId,
      executionId,
      factId: target.fact.id,
      operation: "EXPIRE",
      userId: settings.userId,
      versionId: target.version.id
    });
    const observedEnd = new Date(Math.max(...candidate.evidence.map((item) =>
      new Date(item.observedAt).getTime())));
    const validTo = !target.version.validFrom || observedEnd > target.version.validFrom
      ? observedEnd
      : target.version.validTo;
    const version = await tx.memoryFactVersion.updateMany({
      data: { state: "EXPIRED", systemTo: at, validTo },
      where: {
        factId: target.fact.id,
        id: target.version.id,
        sourceMode: "AUTOMATIC",
        state: "ACTIVE",
        systemTo: null,
        userId: settings.userId
      }
    });
    const fact = await tx.memoryFact.updateMany({
      data: { currentVersionId: null, state: "EXPIRED" },
      where: {
        currentVersionId: target.version.id,
        id: target.fact.id,
        state: "ACTIVE",
        userId: settings.userId
      }
    });
    if (version.count !== 1 || fact.count !== 1) {
      throw new Error("memory_fact_expire_stale");
    }
    await createEvidence(
      tx,
      settings.userId,
      target.version.id,
      candidate,
      "CONTRADICTS"
    );
    await tx.memorySearchEntry.deleteMany({
      where: {
        factVersionId: target.version.id,
        indexGenerationId: index.id,
        userId: settings.userId
      }
    });
    await enqueueDerivedWork(tx, settings, candidate, decisionId, target.fact.id, null);
    void eventId;
    return {
      factId: target.fact.id,
      semanticMutation: true,
      versionId: target.version.id
    };
  }

  const newVersionId = randomUUID();
  const eventOperation = plan.operation === "SUPERSEDE" || plan.operation === "REPLACE"
    ? "SUPERSEDE"
    : "CONFLICT";
  const eventId = await createEvent(tx, {
    candidate: factCandidate,
    decisionId,
    executionId,
    factId: target.fact.id,
    operation: eventOperation,
    userId: settings.userId,
    versionId: newVersionId
  });
  const replacing = plan.operation === "SUPERSEDE" || plan.operation === "REPLACE";
  const nextState = replacing ? "SUPERSEDED" : "CONFLICTING";
  const priorValidTo = replacing && plan.effectiveFrom &&
      (!target.version.validFrom || new Date(plan.effectiveFrom) > target.version.validFrom)
    ? new Date(plan.effectiveFrom)
    : target.version.validTo;
  const transitioned = await tx.memoryFactVersion.updateMany({
    data: {
      state: nextState,
      ...(replacing ? { systemTo: at, validTo: priorValidTo } : {})
    },
    where: {
      factId: target.fact.id,
      id: target.version.id,
      state: "ACTIVE",
      systemTo: null,
      userId: settings.userId
    }
  });
  if (transitioned.count !== 1) {
    throw new Error("memory_fact_transition_stale");
  }
  const safety = await extractionSafetyData(tx, settings.userId, factCandidate);
  await tx.memoryFactVersion.create({
    data: {
      ...candidateValue(factCandidate),
      ...safety,
      createdByEventId: eventId,
      factId: target.fact.id,
      id: newVersionId,
      state: replacing ? "ACTIVE" : "CONFLICTING",
      supersedesVersionId: replacing ? target.version.id : null,
      systemFrom: at,
      userId: settings.userId
    }
  });
  const updatedFact = await tx.memoryFact.updateMany({
    data: replacing
      ? {
          category: candidateCategory(candidate),
          currentVersionId: newVersionId,
          lastConfirmedAt: new Date(Math.max(...candidate.evidence.map((item) =>
            new Date(item.observedAt).getTime()))),
          state: "ACTIVE"
        }
      : { currentVersionId: null, state: "CONFLICTED" },
    where: {
      currentVersionId: target.version.id,
      id: target.fact.id,
      state: "ACTIVE",
      userId: settings.userId
    }
  });
  if (updatedFact.count !== 1) {
    throw new Error("memory_fact_transition_stale");
  }
  await createEvidence(tx, settings.userId, newVersionId, candidate, "SUPPORTS");
  if (replacing) {
    await tx.memorySearchEntry.deleteMany({
      where: {
        factVersionId: target.version.id,
        indexGenerationId: index.id,
        userId: settings.userId
      }
    });
  }
  const entry = await createSearchEntry(
    tx,
    index,
    settings.userId,
    newVersionId,
    factCandidate,
    replacing
  );
  await enqueueDerivedWork(
    tx,
    settings,
    candidate,
    decisionId,
    target.fact.id,
    entry
  );
  return { factId: target.fact.id, semanticMutation: true, versionId: newVersionId };
}

async function applySemanticTransition(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan,
  decisionId: string,
  executionId: string,
  now: Date
): Promise<SemanticApplyResult | null> {
  if (input.candidate.scope.type !== "GLOBAL_USER" ||
    input.candidate.scope.targetId !== null) return null;
  if (plan.operation === "ADD") {
    return applyAdd(tx, settings, input.candidate, decisionId, executionId, now);
  }
  if (plan.operation === "REINFORCE" && plan.targetFactId && plan.targetVersionId) {
    return applyReinforce(
      tx,
      settings,
      input.candidate,
      decisionId,
      executionId,
      plan.targetFactId,
      plan.targetVersionId
    );
  }
  if (["CONFLICT", "EXPIRE", "SUPERSEDE", "REPLACE"].includes(plan.operation)) {
    return applyVersionTransition(
      tx,
      settings,
      input.candidate,
      decisionId,
      executionId,
      plan,
      now
    );
  }
  return null;
}

async function markCandidateDeferred(
  tx: MemoryTransaction,
  userId: string,
  candidateId: string,
  reasonCode: string
): Promise<void> {
  await tx.memoryCandidate.updateMany({
    data: { reasonCode: reasonCode.slice(0, 64), state: "DEFERRED" },
    where: { id: candidateId, state: "PENDING", userId }
  });
}

async function markCandidateRejected(
  tx: MemoryTransaction,
  userId: string,
  candidateId: string,
  reasonCode: string,
  now: Date
): Promise<void> {
  await tx.memoryCandidate.updateMany({
    data: {
      reasonCode: reasonCode.slice(0, 64),
      resolvedAt: now,
      state: "REJECTED"
    },
    where: { id: candidateId, state: "PENDING", userId }
  });
}

async function createAppliedDecision(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  input: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan,
  executionId: string,
  now: Date,
  decisionId: string
): Promise<void> {
  await tx.memoryCandidateDecision.create({
    data: {
      candidateId: input.candidate.id,
      consolidationExecutionId: executionId,
      consolidationInputHash: input.inputHash,
      consolidationJobId: claim.id,
      consolidationOutputHash: plan.outputHash,
      effectiveFrom: plan.effectiveFrom ? new Date(plan.effectiveFrom) : null,
      id: decisionId,
      operation: persistedOperation(plan.operation),
      reasonCode: plan.reasonCode,
      relatedSnapshotHash: input.relatedSnapshotHash,
      requiresVerification: false,
      resolvedAt: now,
      state: "APPLIED",
      targetFactId: plan.targetFactId,
      targetVersionId: plan.targetVersionId,
      userId: claim.userId
    }
  });
}

export async function applyMemoryFactConsolidation(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  expectedInput: MemoryFactConsolidationInput,
  plan: MemoryFactConsolidationPlan,
  executionId: string,
  keyring: MemorySuppressionKeyring,
  now: Date
): Promise<void> {
  const settings = await lockMemorySettings(tx, claim.userId, true);
  const prepared = await prepareMemoryFactConsolidation(
    tx,
    settings,
    claim,
    keyring,
    now,
    expectedInput.relatedFacts.flatMap((fact) =>
      fact.currentVersionId ? [fact.currentVersionId] : [])
  );
  if ("decision" in prepared || prepared.input.inputHash !== expectedInput.inputHash) {
    if (isV1Candidate(expectedInput.candidate)) {
      await markCandidateRejected(
        tx,
        claim.userId,
        expectedInput.candidate.id,
        "consolidation_precondition_stale",
        now
      );
    } else {
      await markCandidateDeferred(
        tx,
        claim.userId,
        expectedInput.candidate.id,
        "consolidation_precondition_stale"
      );
    }
    return;
  }
  await requireSucceededBinding(tx, {
    acceptedOutputHash: plan.outputHash,
    bindingId: executionId,
    inputHash: expectedInput.inputHash,
    jobId: claim.id,
    role: "MEMORY_CONSOLIDATE",
    userId: claim.userId
  });
  const policy = evaluateMemoryFactConsolidationPlan(prepared.input, plan);
  if (policy.status === "DEFER") {
    if (isV1Operation(plan.operation) || isV1Candidate(expectedInput.candidate)) {
      await markCandidateRejected(
        tx,
        claim.userId,
        expectedInput.candidate.id,
        policy.reasonCode,
        now
      );
    } else {
      await markCandidateDeferred(tx, claim.userId, expectedInput.candidate.id, policy.reasonCode);
    }
    return;
  }
  const decisionId = memoryFactDecisionId(expectedInput, plan);
  if (plan.operation === "NOOP" || plan.operation === "REJECT") {
    const updated = await tx.memoryCandidate.updateMany({
      data: {
        reasonCode: plan.operation === "REJECT"
          ? plan.reasonCode.slice(0, 64)
          : "consolidation_noop",
        resolvedAt: now,
        state: "REJECTED"
      },
      where: { id: expectedInput.candidate.id, state: "PENDING", userId: claim.userId }
    });
    if (updated.count !== 1) return;
    await createAppliedDecision(
      tx,
      claim,
      expectedInput,
      plan,
      executionId,
      now,
      decisionId
    );
    return;
  }
  const result = await applySemanticTransition(
    tx,
    settings,
    prepared.input,
    plan,
    decisionId,
    executionId,
    now
  );
  if (!result) {
    if (isV1Candidate(expectedInput.candidate)) {
      await markCandidateRejected(
        tx,
        claim.userId,
        expectedInput.candidate.id,
        "transition_precondition_stale",
        now
      );
    } else {
      await markCandidateDeferred(
        tx,
        claim.userId,
        expectedInput.candidate.id,
        "transition_precondition_stale"
      );
    }
    return;
  }
  const promoted = await tx.memoryCandidate.updateMany({
    data: {
      reasonCode: null,
      resolvedAt: now,
      resolvedFactId: result.factId,
      state: "PROMOTED"
    },
    where: { id: expectedInput.candidate.id, state: "PENDING", userId: claim.userId }
  });
  if (promoted.count !== 1) throw new Error("memory_fact_candidate_stale");
  await createAppliedDecision(
    tx,
    claim,
    expectedInput,
    plan,
    executionId,
    now,
    decisionId
  );
}

export async function deferMemoryFactConsolidationResult(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  candidateId: string,
  reasonCode: string
): Promise<void> {
  const candidate = await tx.memoryCandidate.findFirst({
    select: { pipelineVersion: true },
    where: { id: candidateId, userId: claim.userId }
  });
  if (candidate?.pipelineVersion === MEMORY_FACT_EXTRACTION_V1) {
    await tx.memoryCandidate.updateMany({
      data: { reasonCode: reasonCode.slice(0, 64), resolvedAt: new Date(), state: "REJECTED" },
      where: { id: candidateId, state: "PENDING", userId: claim.userId }
    });
    return;
  }
  await markCandidateDeferred(tx, claim.userId, candidateId, reasonCode);
}

export async function applyMemoryFactVerification(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  expectedInput: MemoryFactVerificationInput,
  plan: MemoryFactVerificationPlan,
  executionId: string,
  keyring: MemorySuppressionKeyring,
  now: Date
): Promise<void> {
  const settings = await lockMemorySettings(tx, claim.userId, true);
  const prepared = await prepareMemoryFactVerification(
    tx,
    settings,
    claim,
    keyring,
    now
  );
  if ("decision" in prepared || prepared.input.inputHash !== expectedInput.inputHash) {
    await staleMemoryFactVerification(
      tx,
      claim,
      expectedInput.decision.id,
      executionId,
      plan.outputHash,
      now
    );
    return;
  }
  await requireSucceededBinding(tx, {
    acceptedOutputHash: plan.outputHash,
    bindingId: executionId,
    inputHash: expectedInput.inputHash,
    jobId: claim.id,
    role: "MEMORY_VERIFY",
    userId: claim.userId
  });
  if (plan.verdict !== "APPROVE") {
    await markCandidateDeferred(
      tx,
      claim.userId,
      expectedInput.candidate.id,
      `verifier_${plan.reasonCode}`
    );
    await tx.memoryCandidateDecision.updateMany({
      data: {
        resolvedAt: now,
        state: "REJECTED",
        verificationExecutionId: executionId,
        verificationOutputHash: plan.outputHash
      },
      where: {
        id: expectedInput.decision.id,
        state: "PENDING_VERIFICATION",
        userId: claim.userId,
        verificationJobId: claim.id
      }
    });
    return;
  }
  const decisionRow = await tx.memoryCandidateDecision.findFirst({
    select: { effectiveFrom: true, consolidationExecutionId: true },
    where: {
      id: expectedInput.decision.id,
      state: "PENDING_VERIFICATION",
      userId: claim.userId,
      verificationJobId: claim.id
    }
  });
  if (!decisionRow) return;
  const consolidationPlan: MemoryFactConsolidationPlan = {
    candidateId: expectedInput.candidate.id,
    effectiveFrom: decisionRow.effectiveFrom?.toISOString() ?? null,
    evidenceIds: expectedInput.candidate.evidence.map((item) => item.messageId),
    operation: expectedInput.decision.operation,
    outputHash: expectedInput.decision.consolidationOutputHash,
    reasonCode: expectedInput.decision.reasonCode,
    targetFactId: expectedInput.decision.targetFactId,
    targetVersionId: expectedInput.decision.targetVersionId
  };
  const consolidationInput: MemoryFactConsolidationInput = {
    candidate: prepared.input.candidate,
    inputHash: expectedInput.decision.consolidationInputHash,
    memoryRevision: settings.memoryRevision,
    relatedFacts: prepared.input.target ? [prepared.input.target] : [],
    relatedSnapshotHash: expectedInput.decision.relatedSnapshotHash
  };
  const result = await applySemanticTransition(
    tx,
    settings,
    consolidationInput,
    consolidationPlan,
    expectedInput.decision.id,
    decisionRow.consolidationExecutionId,
    now
  );
  if (!result) {
    await staleMemoryFactVerification(
      tx,
      claim,
      expectedInput.decision.id,
      executionId,
      plan.outputHash,
      now
    );
    return;
  }
  const promoted = await tx.memoryCandidate.updateMany({
    data: {
      reasonCode: null,
      resolvedAt: now,
      resolvedFactId: result.factId,
      state: "PROMOTED"
    },
    where: { id: expectedInput.candidate.id, state: "PENDING", userId: claim.userId }
  });
  const resolved = await tx.memoryCandidateDecision.updateMany({
    data: {
      resolvedAt: now,
      state: "APPLIED",
      verificationExecutionId: executionId,
      verificationOutputHash: plan.outputHash
    },
    where: {
      id: expectedInput.decision.id,
      state: "PENDING_VERIFICATION",
      userId: claim.userId,
      verificationJobId: claim.id
    }
  });
  if (promoted.count !== 1 || resolved.count !== 1) {
    throw new Error("memory_fact_verification_stale");
  }
}

export async function staleMemoryFactVerification(
  tx: MemoryTransaction,
  claim: MemoryJobClaim,
  decisionId: string,
  verificationExecutionId: string | null,
  verificationOutputHash: string | null,
  now: Date
): Promise<void> {
  const decision = await tx.memoryCandidateDecision.findFirst({
    select: { candidateId: true },
    where: {
      id: decisionId,
      state: "PENDING_VERIFICATION",
      userId: claim.userId,
      verificationJobId: claim.id
    }
  });
  if (!decision) return;
  await markCandidateDeferred(
    tx,
    claim.userId,
    decision.candidateId,
    "verification_precondition_stale"
  );
  await tx.memoryCandidateDecision.updateMany({
    data: {
      resolvedAt: now,
      state: "STALE",
      ...(verificationExecutionId && verificationOutputHash
        ? { verificationExecutionId, verificationOutputHash }
        : {})
    },
    where: { id: decisionId, state: "PENDING_VERIFICATION", userId: claim.userId }
  });
}
