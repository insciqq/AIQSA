import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  memoryItemEmbeddingJobFingerprint
} from "../embedding/contract";
import type {
  MemoryExtractedCandidate,
  MemoryFactExtractionInput,
  MemoryFactExtractionPlan
} from "../learning/extraction/contract";
import { MEMORY_FACT_EXTRACTION_PIPELINE_VERSION } from "../learning/extraction/contract";
import { enqueueMemoryJob } from "../persistence/jobs";
import {
  memorySha256,
  normalizeMemorySearchText
} from "../persistence/lexical";
import { ensureGlobalMemoryScope } from "../persistence/scopes";
import {
  advanceMemoryMutation,
  requireActiveMemoryIndex,
  type LockedMemorySettings,
  type MemoryActiveIndex,
  type MemoryTransaction
} from "../persistence/transaction";

type ActiveFact = Readonly<{
  currentVersionId: string | null;
  id: string;
  lastConfirmedAt: Date | null;
  state: string;
}>;

type ActiveVersion = Readonly<{
  displayText: string | null;
  id: string;
  sourceMode: "AUTOMATIC" | "EXPLICIT";
  state: string;
  structuredValue: Prisma.JsonValue | null;
}>;

type ExtractionSafety = Readonly<{
  safetyClassificationReasonCode: "automatic_extraction";
  safetyClassificationState: "CLASSIFIED";
  safetyClassifiedAt: Date;
  safetyClassifierExecutionId: string;
  safetyClassifierModelId: string;
  safetyClassifierPolicyVersion: string;
  safetyClassifierProviderId: string;
}>;

export type MemoryVNextCommitResult = Readonly<{
  attachedEvidence: number;
  createdVersions: number;
}>;

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
  if (!message) {
    throw new Error("memory_vnext_source_message_invalid");
  }
  return candidate.evidence.map((evidence) => {
    const quote = message.text.slice(evidence.startOffset, evidence.endOffset);
    if (
      evidence.messageId !== message.id ||
      evidence.sourceTextHash !== memorySha256(message.text) ||
      evidence.startOffset < 0 ||
      evidence.endOffset <= evidence.startOffset ||
      evidence.endOffset > message.text.length ||
      !quote || evidence.quote !== quote
    ) {
      throw new Error("memory_vnext_evidence_invalid");
    }
    return {
      branchGeneration: input.source.branchGeneration,
      chatId: input.source.chatId,
      endOffset: evidence.endOffset,
      messageId: message.id,
      observedAt: new Date(message.createdAt),
      quote,
      sourceTextHash: evidence.sourceTextHash,
      startOffset: evidence.startOffset
    };
  });
}

async function extractionSafety(
  tx: MemoryTransaction,
  userId: string,
  bindingId: string
): Promise<ExtractionSafety> {
  const binding = await tx.memoryExecutionBinding.findFirst({
    select: {
      completedAt: true,
      policyVersion: true,
      providerId: true,
      providerModelId: true
    },
    where: {
      id: bindingId,
      logicalRole: "MEMORY_FACT_EXTRACT",
      ownerType: "JOB",
      state: "SUCCEEDED",
      userId
    }
  });
  if (!binding?.completedAt || !binding.providerId || !binding.policyVersion) {
    throw new Error("memory_vnext_extraction_provenance_invalid");
  }
  const usage = await tx.usageEvent.findUnique({
    select: { provider: true, providerModelId: true },
    where: { memoryExecutionBindingId: bindingId }
  });
  const providerModelId = binding.providerModelId ?? usage?.providerModelId;
  if (!usage || usage.provider !== binding.providerId || !providerModelId ||
    (binding.providerModelId !== null &&
      usage.providerModelId !== binding.providerModelId)) {
    throw new Error("memory_vnext_extraction_provenance_invalid");
  }
  return {
    safetyClassificationReasonCode: "automatic_extraction",
    safetyClassificationState: "CLASSIFIED",
    safetyClassifiedAt: binding.completedAt,
    safetyClassifierExecutionId: bindingId,
    safetyClassifierModelId: providerModelId,
    safetyClassifierPolicyVersion: binding.policyVersion,
    safetyClassifierProviderId: binding.providerId
  };
}

function eventId(
  claim: MemoryJobClaim,
  candidate: MemoryExtractedCandidate,
  operation: "PROMOTE" | "REINFORCE"
): string {
  return memorySha256({
    candidateId: candidate.id,
    domain: "aiqsa.memory.vnext.event",
    jobId: claim.id,
    operation,
    version: 1
  });
}

function versionId(candidate: MemoryExtractedCandidate): string {
  return memorySha256({
    candidateId: candidate.id,
    domain: "aiqsa.memory.vnext.version",
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
  operation: "PROMOTE" | "REINFORCE"
): Promise<string> {
  const id = eventId(claim, candidate, operation);
  await tx.memoryEvent.create({
    data: {
      actorType: "JOB",
      factId,
      factVersionId,
      id,
      metadata: {
        extractionExecutionId: bindingId,
        ingestionJobId: claim.id,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        schemaVersion: "memory-vnext-observation-event-v1"
      },
      operation,
      sourceChatId: claim.chatId,
      sourceGeneration: claim.branchGeneration,
      userId: claim.userId
    }
  });
  return id;
}

function searchEntryData(
  index: MemoryActiveIndex,
  userId: string,
  factVersionId: string,
  candidate: MemoryExtractedCandidate,
  input: MemoryFactExtractionInput
) {
  const normalizedSearchText = normalizeMemorySearchText(candidate.displayText);
  return {
    embeddingState: index.indexMode === "HYBRID"
      ? "PENDING" as const
      : "NOT_APPLICABLE" as const,
    factVersionId,
    indexGenerationId: index.id,
    itemType: "FACT_VERSION" as const,
    languageCode: candidate.languageCode,
    normalizedSearchText,
    safeContentHash: memorySha256({
      displayText: candidate.displayText,
      structuredValue: candidate.proposedValue
    }),
    safetyIdentitySnapshot: memorySha256({
      safetyClass: "NORMAL",
      secretTaintedSourceWindow: false
    }),
    sourceIdentitySnapshot: memorySha256({
      messageId: input.source.sourceMessageId,
      sourceProjectionHash: input.sourceProjectionHash,
      sourceProjectionVersion: input.sourceProjectionVersion
    }),
    suppressionIdentitySnapshot: memorySha256({
      canonicalKey: candidate.canonicalKey,
      normalizedValue: normalizedSearchText
    }),
    userId
  };
}

async function ensureSearchEntry(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  factVersionId: string,
  candidate: MemoryExtractedCandidate,
  input: MemoryFactExtractionInput,
  triggerId: string
): Promise<void> {
  const index = await requireActiveMemoryIndex(tx, settings);
  if (!index) throw new Error("memory_active_generation_invalid");
  let entry = await tx.memorySearchEntry.findFirst({
    select: { embeddingState: true, id: true },
    where: {
      factVersionId,
      indexGenerationId: index.id,
      userId: settings.userId
    }
  });
  entry ??= await tx.memorySearchEntry.create({
    data: searchEntryData(
      index,
      settings.userId,
      factVersionId,
      candidate,
      input
    ),
    select: { embeddingState: true, id: true }
  });
  if (entry.embeddingState === "PENDING") {
    await enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryItemEmbeddingJobFingerprint(entry.id, triggerId),
      kind: "EMBED_ITEMS",
      pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION
    });
  }
}

async function activeFact(
  tx: MemoryTransaction,
  userId: string,
  scopeId: string,
  canonicalKey: string
): Promise<ActiveFact | null> {
  const rows = await tx.$queryRaw<ActiveFact[]>(Prisma.sql`
    SELECT "id", "currentVersionId", "lastConfirmedAt", "state"::text AS "state"
    FROM "MemoryFact"
    WHERE "userId" = ${userId}
      AND "scopeId" = ${scopeId}
      AND "canonicalKey" = ${canonicalKey}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function createObservation(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  candidate: MemoryExtractedCandidate,
  bindingId: string,
  now: Date
): Promise<MemoryVNextCommitResult> {
  if (candidate.scope.type !== "GLOBAL_USER" || candidate.scope.targetId !== null ||
    candidate.directness !== "DIRECT" || candidate.sensitivity !== "NORMAL") {
    return { attachedEvidence: 0, createdVersions: 0 };
  }
  const evidence = exactEvidence(plan.input, candidate);
  if (evidence.length !== 1) {
    throw new Error("memory_vnext_evidence_invalid");
  }
  const scope = await ensureGlobalMemoryScope(tx, settings);
  const fact = await activeFact(
    tx,
    settings.userId,
    scope.id,
    candidate.canonicalKey
  );
  if (fact) {
    if (fact.state !== "ACTIVE" || fact.currentVersionId === null) {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    const version = await tx.memoryFactVersion.findFirst({
      select: {
        displayText: true,
        id: true,
        sourceMode: true,
        state: true,
        structuredValue: true
      },
      where: {
        factId: fact.id,
        id: fact.currentVersionId,
        userId: settings.userId
      }
    }) as ActiveVersion | null;
    if (!version || version.state !== "ACTIVE" ||
      version.sourceMode !== "AUTOMATIC" || version.displayText === null ||
      version.structuredValue === null ||
      normalizeMemorySearchText(version.displayText) !==
        normalizeMemorySearchText(candidate.displayText)) {
      return { attachedEvidence: 0, createdVersions: 0 };
    }
    const existing = await tx.memoryEvidence.findFirst({
      select: { id: true },
      where: {
        chatId: plan.input.source.chatId,
        factVersionId: version.id,
        messageId: plan.input.source.sourceMessageId,
        sourceProjectionVersion: plan.input.sourceProjectionVersion,
        sourceType: "MESSAGE",
        stance: "SUPPORTS",
        userId: settings.userId
      }
    });
    if (existing) return { attachedEvidence: 0, createdVersions: 0 };

    await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
    const reinforcementEventId = await createEvent(
      tx,
      claim,
      candidate,
      fact.id,
      version.id,
      bindingId,
      "REINFORCE"
    );
    await tx.memoryEvidence.create({
      data: {
        branchGeneration: evidence[0]!.branchGeneration,
        chatId: evidence[0]!.chatId,
        factVersionId: version.id,
        messageId: evidence[0]!.messageId,
        observedAt: evidence[0]!.observedAt,
        safeExcerpt: evidence[0]!.quote,
        safeSourceHash: evidence[0]!.sourceTextHash,
        safetyClass: "NORMAL",
        sourceProjectionVersion: plan.input.sourceProjectionVersion,
        sourceRole: "user",
        sourceType: "MESSAGE",
        stance: "SUPPORTS",
        userId: settings.userId
      }
    });
    await tx.memoryFact.update({
      data: {
        lastConfirmedAt: new Date(Math.max(
          fact.lastConfirmedAt?.getTime() ?? -1,
          evidence[0]!.observedAt.getTime()
        ))
      },
      where: { id: fact.id }
    });
    await ensureSearchEntry(
      tx,
      settings,
      version.id,
      candidate,
      plan.input,
      reinforcementEventId
    );
    return { attachedEvidence: 1, createdVersions: 0 };
  }

  await advanceMemoryMutation(tx, settings, "AUTOMATIC_ADD_OR_REINFORCE");
  const factId = randomUUID();
  const factVersionId = versionId(candidate);
  await tx.memoryFact.create({
    data: {
      canonicalKey: candidate.canonicalKey,
      category: candidate.category,
      currentVersionId: factVersionId,
      id: factId,
      lastConfirmedAt: evidence[0]!.observedAt,
      scopeId: scope.id,
      state: "ACTIVE",
      userId: settings.userId
    }
  });
  const promotionEventId = await createEvent(
    tx,
    claim,
    candidate,
    factId,
    factVersionId,
    bindingId,
    "PROMOTE"
  );
  const safety = await extractionSafety(tx, settings.userId, bindingId);
  await tx.memoryFactVersion.create({
    data: {
      ...safety,
      category: candidate.category,
      confidence: candidate.confidence,
      coreEligible: candidate.coreEligible,
      coreSalience: candidate.coreSalience,
      createdByEventId: promotionEventId,
      directness: "DIRECT",
      displayText: candidate.displayText,
      factId,
      id: factVersionId,
      importance: candidate.importance,
      languageCode: candidate.languageCode,
      modality: candidate.modality,
      normalizedSearchText: normalizeMemorySearchText(candidate.displayText),
      observedAt: evidence[0]!.observedAt,
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      rawTemporalExpression: candidate.rawTemporalExpression,
      sensitivityClass: "NORMAL",
      sourceMode: "AUTOMATIC",
      sourceTimezone: plan.input.timeZone,
      state: "ACTIVE",
      structuredValue: candidate.proposedValue === null
        ? Prisma.JsonNull
        : candidate.proposedValue as Prisma.InputJsonValue,
      systemFrom: now,
      temporalResolutionEvidence: candidate.temporalResolutionEvidence === null
        ? Prisma.DbNull
        : candidate.temporalResolutionEvidence as Prisma.InputJsonValue,
      temporalResolverVersion: null,
      userId: settings.userId,
      validFrom: candidate.validFrom ? new Date(candidate.validFrom) : null,
      validTo: candidate.validTo ? new Date(candidate.validTo) : null
    }
  });
  await tx.memoryEvidence.create({
    data: {
      branchGeneration: evidence[0]!.branchGeneration,
      chatId: evidence[0]!.chatId,
      factVersionId,
      messageId: evidence[0]!.messageId,
      observedAt: evidence[0]!.observedAt,
      safeExcerpt: evidence[0]!.quote,
      safeSourceHash: evidence[0]!.sourceTextHash,
      safetyClass: "NORMAL",
      sourceProjectionVersion: plan.input.sourceProjectionVersion,
      sourceRole: "user",
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId: settings.userId
    }
  });
  await ensureSearchEntry(
    tx,
    settings,
    factVersionId,
    candidate,
    plan.input,
    promotionEventId
  );
  return { attachedEvidence: 1, createdVersions: 1 };
}

export async function commitMemoryVNextExtractionPlan(
  tx: MemoryTransaction,
  settings: LockedMemorySettings,
  claim: MemoryJobClaim,
  plan: MemoryFactExtractionPlan,
  bindingId: string,
  now: Date
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
      now
    );
    attachedEvidence += result.attachedEvidence;
    createdVersions += result.createdVersions;
  }
  return { attachedEvidence, createdVersions };
}
