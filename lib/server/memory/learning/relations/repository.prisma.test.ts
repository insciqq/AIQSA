import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../../domain/content";
import { prisma } from "../../../prisma";
import { createPrismaMemoryCoordinatorRepository } from "../../coordinator/prismaRepository";
import type { MemoryJobClaim, MemoryJobDescriptor } from "../../coordinator/types";
import { memorySha256, normalizeMemorySearchText } from "../../persistence/lexical";
import {
  memoryFactDependenciesAreValid
} from "../dependencies/repository";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  type MemorySemanticAdjudication,
  type MemorySemanticChangeIntent,
  type MemorySemanticTemporalPerspective
} from "../extraction/contract";
import { createPrismaMemoryRelationHandler } from "./handler";
import {
  decideMemoryFactRelation,
  MEMORY_FACT_RELATION_PIPELINE_VERSION,
  MEMORY_FACT_RELATION_POLICY_VERSION,
  MEMORY_FACT_RELATION_PROMPT_VERSION,
  MEMORY_FACT_RELATION_SCHEMA_VERSION,
  type MemoryRelationDecision
} from "./policy";
import {
  createPrismaMemoryRelationRepository,
  type MemoryRelationApplyPlan,
  type MemoryRelationRepository
} from "./repository";
import {
  memoryRelationAcceptedOutputHash,
  type MemoryRelationProviderDecision,
  type MemoryRelationProviderResult
} from "./resolver";
import { reconcileMemoryFactRelationJobs } from "./reconcile";

const suiteStart = new Date(Date.now() + 10 * 60_000);

type SourceFixture = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  messageId: string;
  observedAt: Date;
  sourceRevision: number;
  text: string;
}>;

type VersionFixture = Readonly<{
  evidenceId: string;
  factId: string;
  source: SourceFixture;
  versionId: string;
}>;

type SlotIdentity = Readonly<{
  canonicalKey: string;
  dimensionKey: string | null;
  predicateKey:
    | "constraint"
    | "employment_status"
    | "goal_status"
    | "preference"
    | "product_status"
    | "project_status"
    | "residence"
    | "routine";
  subjectKey: string;
}>;

const repository = createPrismaMemoryRelationRepository(prisma);
const coordinator = createPrismaMemoryCoordinatorRepository(prisma);

afterAll(async () => {
  await prisma.$disconnect();
});

function at(minutes: number): Date {
  return new Date(suiteStart.getTime() + minutes * 60_000);
}

async function createOwner(label: string): Promise<Readonly<{
  classifierBindingId: string;
  scopeId: string;
  userId: string;
}>> {
  const suffix = randomUUID();
  const userId = `memory-relations-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Memory relations test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: {
      learnAutomatically: true,
      referenceChatHistory: false,
      useMemoryFacts: true
    },
    where: { userId }
  });
  const scope = await prisma.memoryScope.create({
    data: { scopeType: "GLOBAL_USER", userId }
  });
  const authorizationId = randomUUID();
  const classifierBindingId = randomUUID();
  const completedAt = at(0);
  await prisma.$transaction(async (tx) => {
    await tx.memoryMutationAuthorization.create({
      data: {
        action: "SAVE",
        authorizedPayloadHash: memorySha256({ authorizationId }),
        confirmationCopyVersion: "memory-relation-test-v1",
        consumedAt: completedAt,
        expiresAt: at(120),
        id: authorizationId,
        nonceHash: memorySha256({ authorizationId, userId }),
        requestId: `memory-relation-test-${authorizationId}`,
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memorySha256({ classifierBindingId, result: "NORMAL" }),
        completedAt,
        createdAt: new Date(completedAt.getTime() - 2_000),
        destinationFingerprint: memorySha256({ destination: "classifier-fixture" }),
        id: classifierBindingId,
        inputHash: memorySha256({ classifierBindingId, input: "fixture" }),
        logicalRole: "MEMORY_STATEMENT_CLASSIFY",
        mutationAuthorizationId: authorizationId,
        ordinal: 0,
        ownerType: "MUTATION_AUTHORIZATION",
        pipelineVersion: "memory-relation-test-v1",
        policyVersion: "memory-relation-test-v1",
        promptVersion: "memory-relation-test-v1",
        providerId: "memory-relation-fixture",
        recoverableUntil: completedAt,
        relationsDetachedAt: completedAt,
        schemaVersion: "memory-relation-test-v1",
        secretFreeExecutionSnapshot: {},
        startedAt: new Date(completedAt.getTime() - 1_000),
        state: "SUCCEEDED",
        userId
      }
    });
  });
  return { classifierBindingId, scopeId: scope.id, userId };
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.memoryAuxiliarySemanticCall.deleteMany({ where: { userId } });
    await tx.memoryFactVersionRelation.deleteMany({ where: { userId } });
    await tx.memoryFactVersionSourceDependency.deleteMany({ where: { userId } });
    await tx.memoryEntityAliasSupport.deleteMany({ where: { userId } });
    await tx.memoryFactVersionEntity.deleteMany({ where: { userId } });
    await tx.memoryEntityAlias.deleteMany({ where: { userId } });
    await tx.memoryFactVersion.updateMany({
      data: { mergedIntoVersionId: null, state: "ORPHANED" },
      where: { state: "MERGED", userId }
    });
    await tx.memoryFactVersion.updateMany({
      data: { movedFromVersionId: null, supersedesVersionId: null },
      where: { userId }
    });
    await tx.memoryFact.updateMany({
      data: { movedToFactId: null },
      where: { userId }
    });
    await tx.memoryEntity.updateMany({
      data: { mergedIntoId: null, state: "ACTIVE" },
      where: { state: "MERGED", userId }
    });
    await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });
  });
}

async function createSource(
  userId: string,
  text: string,
  observedAt: Date
): Promise<SourceFixture> {
  const chat = await prisma.chat.create({
    data: { title: "Memory relation source", userId }
  });
  const message = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(text),
      createdAt: observedAt,
      role: "user",
      status: "complete",
      updatedAt: observedAt
    }
  });
  const settled = await prisma.chat.update({
    data: {
      activeLeafMessageId: message.id,
      memorySourceRevision: 1
    },
    where: { id: chat.id }
  });
  return {
    activeLeafMessageId: message.id,
    branchGeneration: settled.memoryBranchGeneration,
    chatId: chat.id,
    messageId: message.id,
    observedAt,
    sourceRevision: settled.memorySourceRevision,
    text
  };
}

async function createEntity(
  userId: string,
  canonicalKey: string,
  displayName: string
): Promise<string> {
  const entity = await prisma.memoryEntity.create({
    data: {
      canonicalKey,
      displayName,
      entityType: "DEVICE",
      languageCode: "en",
      userId
    }
  });
  return entity.id;
}

async function addExactEvidence(
  userId: string,
  factVersionId: string,
  source: SourceFixture
): Promise<string> {
  const id = randomUUID();
  const sourceHash = memorySha256(source.text);
  await prisma.memoryEvidence.create({
    data: {
      branchGeneration: source.branchGeneration,
      chatId: source.chatId,
      createdAt: source.observedAt,
      evidenceFingerprint: memorySha256({
        domain: "memory-relation-test-evidence",
        messageId: source.messageId,
        versionId: factVersionId
      }),
      factVersionId,
      id,
      messageId: source.messageId,
      observedAt: source.observedAt,
      safeExcerpt: source.text,
      safeSourceHash: sourceHash,
      safetyClass: "NORMAL",
      sourceEndOffset: source.text.length,
      sourceMessageContentHash: sourceHash,
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      sourceRole: "user",
      sourceStartOffset: 0,
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId
    }
  });
  return id;
}

function fixturePrimaryValue(value: Prisma.InputJsonObject): string | null {
  for (const key of ["state", "placeKey", "value"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

async function createSlotVersion(input: Readonly<{
  changeIntent?: MemorySemanticChangeIntent;
  classifierBindingId: string;
  correctionTargetVersionId?: string;
  directness?: "DIRECT" | "INFERRED" | "PARAPHRASED";
  displayText: string;
  entityId?: string;
  expiresAt?: Date;
  factId?: string;
  identity: SlotIdentity;
  languageCode?: string;
  scopeId: string;
  semanticOperation?: MemorySemanticAdjudication["operation"] | null;
  source: SourceFixture;
  sourceMode?: "AUTOMATIC" | "EXPLICIT";
  state: "ACTIVE" | "PENDING_RELATION";
  structuredValue: Prisma.InputJsonObject;
  temporalPerspective?: MemorySemanticTemporalPerspective;
  userId: string;
}>): Promise<VersionFixture> {
  const factId = input.factId ?? randomUUID();
  const versionId = randomUUID();
  const eventId = randomUUID();
  const evidenceId = randomUUID();
  const sourceMode = input.sourceMode ?? "AUTOMATIC";
  const sourceHash = memorySha256(input.source.text);
  await prisma.$transaction(async (tx) => {
    let targetVersionId = input.correctionTargetVersionId ?? null;
    if (targetVersionId === null && input.factId) {
      targetVersionId = (await tx.memoryFact.findUnique({
        select: { currentVersionId: true },
        where: { id: input.factId }
      }))?.currentVersionId ?? null;
    }
    if (targetVersionId === null && input.entityId) {
      const [linked] = await tx.$queryRaw<Array<{ versionId: string }>>(Prisma.sql`
        SELECT version."id" AS "versionId"
        FROM "MemoryFactVersionEntity" AS link
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = link."userId"
          AND version."id" = link."factVersionId"
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."systemTo" IS NULL
        INNER JOIN "MemoryFact" AS fact
          ON fact."userId" = version."userId"
          AND fact."id" = version."factId"
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND fact."currentVersionId" = version."id"
          AND fact."predicateKey" = ${input.identity.predicateKey}
        WHERE link."userId" = ${input.userId}
          AND link."entityId" = ${input.entityId}
          AND link."role" = 'SUBJECT'::"MemoryEntityLinkRole"
        ORDER BY version."id"
        LIMIT 1
      `);
      targetVersionId = linked?.versionId ?? null;
    }
    const targetValue = targetVersionId === null
      ? null
      : await tx.memoryFactVersion.findUnique({
          select: { structuredValue: true },
          where: { id: targetVersionId }
        });
    const samePrimaryValue = targetValue?.structuredValue !== null &&
      typeof targetValue?.structuredValue === "object" &&
      !Array.isArray(targetValue.structuredValue) &&
      fixturePrimaryValue(targetValue.structuredValue as Prisma.InputJsonObject) ===
        fixturePrimaryValue(input.structuredValue);
    const defaultOperation: MemorySemanticAdjudication["operation"] | null =
      targetVersionId === null
        ? null
        : input.correctionTargetVersionId
          ? "MOVE_TO_DISTINCT_FACT"
          : samePrimaryValue
            ? "MERGE_NEW_INTO_TARGET"
            : "SUPERSEDE_TARGET";
    const semanticOperation = input.semanticOperation === undefined
      ? defaultOperation
      : input.semanticOperation;
    const semanticFrame = {
      assertionStatus: "ASSERTED",
      changeIntent: input.changeIntent ?? (
        input.correctionTargetVersionId
          ? "CORRECTION"
          : samePrimaryValue ? "NONE" : "STATE_CHANGE"
      ),
      memoryDirective: "NONE",
      polarity: input.correctionTargetVersionId ? "CORRECTION" : "AFFIRMED",
      speechAct: "ASSERTION",
      subjectScope: "CURRENT_USER",
      temporalPerspective: input.temporalPerspective ?? "CURRENT"
    } as const;
    const semanticAdjudication = input.state === "PENDING_RELATION" &&
      targetVersionId !== null && semanticOperation !== null
      ? {
          assertionStatus: "ASSERTED",
          candidateRef: `fixture-${versionId}`,
          confidenceBand: "HIGH",
          entailment: "ENTAILED",
          entityRef: input.entityId ? "E1" : null,
          operation: semanticOperation,
          reasonCode: "stateful-fixture",
          resolvedEntityId: input.entityId ?? null,
          resolvedTargetVersionId: targetVersionId,
          subjectScope: "CURRENT_USER",
          targetRef: "F1",
          temporalPerspective: input.temporalPerspective ?? "CURRENT"
        } as const
      : null;
    if (!input.factId) {
      await tx.memoryFact.create({
        data: {
          canonicalKey: input.identity.canonicalKey,
          category: "about_you",
          dimensionKey: input.identity.dimensionKey,
          id: factId,
          identityKind: "SLOT",
          identityVersion: "slot-v2",
          predicateKey: input.identity.predicateKey,
          scopeId: input.scopeId,
          state: input.state === "ACTIVE" ? "ORPHANED" : "CONFLICTED",
          subjectKey: input.identity.subjectKey,
          userId: input.userId
        }
      });
    }
    await tx.memoryEvent.create({
      data: {
        actorType: "JOB",
        createdAt: input.source.observedAt,
        factId,
        factVersionId: versionId,
        id: eventId,
        operation: "AUTO_PROPOSE",
        sourceChatId: input.source.chatId,
        sourceGeneration: input.source.branchGeneration,
        userId: input.userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "about_you",
        confidence: 1,
        createdAt: input.source.observedAt,
        createdByEventId: eventId,
        directness: input.directness ?? "DIRECT",
        displayText: input.displayText,
        expiresAt: input.expiresAt,
        factId,
        id: versionId,
        importance: 0.8,
        ...(sourceMode === "AUTOMATIC" ? {
          ingestionFingerprint: memorySha256({
            domain: "memory-relation-test-ingestion",
            sourceMessageId: input.source.messageId,
            versionId
          })
        } : {}),
        languageCode: input.languageCode ?? "en",
        modality: "STATE",
        normalizedSearchText: normalizeMemorySearchText(input.displayText),
        observedAt: input.source.observedAt,
        pipelineVersion: sourceMode === "AUTOMATIC"
          ? MEMORY_FACT_EXTRACTION_PIPELINE_VERSION
          : "memory-relation-explicit-test-v1",
        safetyClassificationReasonCode: "ordinary_personal",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifiedAt: input.source.observedAt,
        safetyClassifierExecutionId: input.classifierBindingId,
        safetyClassifierModelId: "memory-relation-fixture",
        safetyClassifierPolicyVersion: "memory-relation-test-v1",
        safetyClassifierProviderId: "memory-relation-fixture",
        semanticAdjudication: semanticAdjudication === null
          ? undefined
          : semanticAdjudication,
        semanticFrame,
        sensitivityClass: "NORMAL",
        sourceMode,
        state: input.state,
        structuredValue: input.structuredValue,
        systemFrom: input.source.observedAt,
        userId: input.userId
      }
    });
    await tx.memoryEvidence.create({
      data: {
        branchGeneration: input.source.branchGeneration,
        chatId: input.source.chatId,
        createdAt: input.source.observedAt,
        evidenceFingerprint: memorySha256({
          domain: "memory-relation-test-evidence",
          messageId: input.source.messageId,
          versionId
        }),
        factVersionId: versionId,
        id: evidenceId,
        messageId: input.source.messageId,
        observedAt: input.source.observedAt,
        safeExcerpt: input.source.text,
        safeSourceHash: sourceHash,
        safetyClass: "NORMAL",
        sourceEndOffset: input.source.text.length,
        sourceMessageContentHash: sourceHash,
        sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
        sourceRole: "user",
        sourceStartOffset: 0,
        sourceType: "MESSAGE",
        stance: "SUPPORTS",
        userId: input.userId
      }
    });
    if (input.correctionTargetVersionId) {
      await tx.memoryFactVersionSourceDependency.create({
        data: {
          dependencyKind: "CORRECTION_TARGET",
          id: memorySha256({
            domain: "memory-relation-test-dependency",
            sourceFactVersionId: input.correctionTargetVersionId,
            targetFactVersionId: versionId
          }),
          sourceFactVersionId: input.correctionTargetVersionId,
          targetFactVersionId: versionId,
          userId: input.userId
        }
      });
    }
    if (input.entityId) {
      await tx.memoryFactVersionEntity.create({
        data: {
          confidence: 1,
          entityId: input.entityId,
          factVersionId: versionId,
          mentionText: "MacBook Air",
          normalizedMention: "macbook air",
          role: "SUBJECT",
          userId: input.userId
        }
      });
    }
    if (input.state === "ACTIVE") {
      await tx.memoryFact.update({
        data: {
          currentVersionId: versionId,
          lastConfirmedAt: input.source.observedAt,
          state: "ACTIVE"
        },
        where: { id: factId }
      });
    }
  });
  return { evidenceId, factId, source: input.source, versionId };
}

async function relationDescriptor(
  fixture: VersionFixture,
  userId: string,
  id = randomUUID()
): Promise<MemoryJobDescriptor> {
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({
    where: { userId }
  });
  return {
    activeLeafMessageId: fixture.source.activeLeafMessageId,
    attemptCount: 1,
    branchGeneration: fixture.source.branchGeneration,
    chatId: fixture.source.chatId,
    id,
    idempotencyFingerprint: memorySha256({
      domain: "memory-relation-test-job",
      id,
      versionId: fixture.versionId
    }),
    kind: "RESOLVE_FACT_RELATIONS",
    memoryGenerationSnapshot: settings.memoryGeneration,
    memoryRevisionSnapshot: settings.memoryRevision,
    pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
    sourceHash: memorySha256({
      domain: "memory-relation-test-source",
      messageId: fixture.source.messageId,
      versionId: fixture.versionId
    }),
    sourceMessageId: fixture.source.messageId,
    sourceRevision: fixture.source.sourceRevision,
    stage: null,
    targetFactVersionId: fixture.versionId,
    userId
  };
}

async function createRelationJob(
  fixture: VersionFixture,
  userId: string
): Promise<MemoryJobDescriptor> {
  const job = await relationDescriptor(fixture, userId);
  await prisma.memoryJob.create({ data: { ...job, stage: undefined } });
  return job;
}

async function claimRelationJob(
  job: MemoryJobDescriptor,
  now: Date
): Promise<MemoryJobClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60 * 60_000);
  const claimed = await prisma.memoryJob.update({
    data: {
      attemptCount: { increment: 1 },
      leaseExpiresAt,
      leaseToken: claimToken,
      state: "CLAIMED"
    },
    where: { id: job.id }
  });
  return {
    activeLeafMessageId: claimed.activeLeafMessageId,
    attemptCount: claimed.attemptCount,
    branchGeneration: claimed.branchGeneration,
    chatId: claimed.chatId,
    claimToken,
    id: claimed.id,
    idempotencyFingerprint: claimed.idempotencyFingerprint,
    kind: claimed.kind,
    leaseExpiresAt,
    memoryGenerationSnapshot: claimed.memoryGenerationSnapshot,
    memoryRevisionSnapshot: claimed.memoryRevisionSnapshot,
    pipelineVersion: claimed.pipelineVersion,
    recoveredLease: false,
    sourceHash: claimed.sourceHash,
    sourceMessageId: claimed.sourceMessageId,
    sourceRevision: claimed.sourceRevision,
    stage: claimed.stage,
    targetFactVersionId: claimed.targetFactVersionId,
    userId: claimed.userId
  };
}

function deterministicHandler(repositoryOverride = repository) {
  return createPrismaMemoryRelationHandler(prisma, {
    provider: {
      async resolve() {
        throw new Error("memory_relation_provider_was_not_expected");
      }
    },
    repository: repositoryOverride
  });
}

async function preparePlan(
  job: MemoryJobDescriptor,
  now: Date,
  repositoryOverride: MemoryRelationRepository = repository
): Promise<Readonly<{
  decision: MemoryRelationDecision;
  plan: MemoryRelationApplyPlan;
}>> {
  const prepared = await repositoryOverride.prepare(job, now);
  if (prepared.status !== "READY") {
    throw new Error(`memory_relation_fixture_not_ready:${prepared.reason}`);
  }
  const decision = decideMemoryFactRelation(prepared.prepared.snapshot, now);
  return {
    decision,
    plan: {
      decision,
      executionId: null,
      expectedSnapshotHash: prepared.prepared.snapshotHash
    }
  };
}

async function resolveDirect(
  fixture: VersionFixture,
  userId: string,
  now: Date
): Promise<Readonly<{
  claim: MemoryJobClaim;
  decision: MemoryRelationDecision;
  plan: MemoryRelationApplyPlan;
}>> {
  const descriptor = await relationDescriptor(fixture, userId);
  const claim: MemoryJobClaim = {
    ...descriptor,
    claimToken: randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + 60 * 60_000),
    recoveredLease: false
  };
  const prepared = await preparePlan(claim, now);
  await prisma.$transaction((tx) => repository.apply(tx, claim, prepared.plan, now));
  return { claim, ...prepared };
}

async function executeClaim(
  claim: MemoryJobClaim,
  now: Date
) {
  return deterministicHandler().execute(claim, {
    now: () => now,
    setStage: async () => undefined,
    signal: AbortSignal.timeout(30_000)
  });
}

async function commitClaim(
  claim: MemoryJobClaim,
  now: Date,
  result: Awaited<ReturnType<typeof executeClaim>>
): Promise<boolean> {
  return coordinator.commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash,
    apply: result.apply,
    claim,
    now,
    stage: result.stage ?? null
  });
}

describe("Prisma Memory fact relation lifecycle", () => {
  it("[E03] preserves one multilingual product lifecycle and merges richer detail", async () => {
    const owner = await createOwner("macbook-lifecycle");
    const identity: SlotIdentity = {
      canonicalKey: "slot:v2:device:macbook-air:product_status:_",
      dimensionKey: null,
      predicateKey: "product_status",
      subjectKey: "device:macbook-air"
    };
    try {
      const considered = await createSlotVersion({
        ...owner,
        displayText: "The user is considering an Apple laptop.",
        identity,
        languageCode: "es",
        source: await createSource(
          owner.userId,
          "Estoy considerando un portátil Apple MacBook Air.",
          at(0)
        ),
        state: "ACTIVE",
        structuredValue: { state: "considering" }
      });
      const ordered = await createSlotVersion({
        ...owner,
        displayText: "Пользователь заказал MacBook Air.",
        factId: considered.factId,
        identity,
        languageCode: "ru",
        source: await createSource(owner.userId, "Я заказал макбук Air.", at(1)),
        state: "PENDING_RELATION",
        structuredValue: { state: "ordered" }
      });
      await expect(resolveDirect(ordered, owner.userId, at(2)))
        .resolves.toMatchObject({ decision: { operation: "SUPERSEDE_TARGET" } });
      const owned = await createSlotVersion({
        ...owner,
        displayText: "The user owns a MacBook Air.",
        factId: ordered.factId,
        identity,
        source: await createSource(owner.userId, "I bought a MacBook Air.", at(3)),
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" }
      });

      const ownedJob = await createRelationJob(owned, owner.userId);
      const ownedClaim = await claimRelationJob(ownedJob, at(4));
      const ownedResult = await executeClaim(ownedClaim, at(4));
      await expect(commitClaim(ownedClaim, at(4), ownedResult)).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: ownedJob.id } }))
        .resolves.toMatchObject({ state: "SUCCEEDED" });

      const richer = await createSlotVersion({
        ...owner,
        displayText: "The user owns a personal midnight MacBook Air with 24 GB RAM.",
        factId: ordered.factId,
        identity,
        source: await createSource(
          owner.userId,
          "My personal midnight MacBook Air has 24 GB RAM.",
          at(5)
        ),
        state: "PENDING_RELATION",
        structuredValue: {
          color: "midnight",
          brand: "Apple",
          memory: "24 GB",
          model: "MacBook Air",
          ownership: "personal",
          state: "owned"
        }
      });
      const richerJob = await createRelationJob(richer, owner.userId);
      const richerClaim = await claimRelationJob(richerJob, at(6));
      const richerResult = await executeClaim(richerClaim, at(6));
      expect(richerResult.stage).toBe("relation_merge_target_into_new");

      // Simulate a worker crash after the semantic transaction lands but
      // before the claimed job is marked successful.
      await prisma.$transaction((tx) => richerResult.apply!(tx, richerClaim));
      const landedRevision = (await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: owner.userId }
      })).memoryRevision;
      const landedEventCount = await prisma.memoryEvent.count({
        where: { factVersionId: richer.versionId, operation: "MERGE", userId: owner.userId }
      });
      await expect(commitClaim(richerClaim, at(6), richerResult)).resolves.toBe(true);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: owner.userId }
      })).resolves.toMatchObject({ memoryRevision: landedRevision });
      await expect(prisma.memoryEvent.count({
        where: { factVersionId: richer.versionId, operation: "MERGE", userId: owner.userId }
      })).resolves.toBe(landedEventCount);

      const returned = await createSlotVersion({
        ...owner,
        displayText: "The user returned the MacBook Air.",
        factId: ordered.factId,
        identity,
        source: await createSource(owner.userId, "I returned the MacBook Air.", at(7)),
        state: "PENDING_RELATION",
        structuredValue: { state: "returned" }
      });
      await expect(resolveDirect(returned, owner.userId, at(8)))
        .resolves.toMatchObject({ decision: { operation: "SUPERSEDE_TARGET" } });

      const fact = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: ordered.factId }
      });
      expect(fact).toMatchObject({
        currentVersionId: returned.versionId,
        state: "ACTIVE"
      });
      const versions = await prisma.memoryFactVersion.findMany({
        where: { factId: ordered.factId, userId: owner.userId }
      });
      const byId = new Map(versions.map((version) => [version.id, version]));
      expect(byId.get(considered.versionId)).toMatchObject({ state: "SUPERSEDED" });
      expect(byId.get(ordered.versionId)).toMatchObject({
        state: "SUPERSEDED",
        supersedesVersionId: considered.versionId
      });
      expect(byId.get(owned.versionId)).toMatchObject({
        mergedIntoVersionId: richer.versionId,
        state: "MERGED",
        supersedesVersionId: ordered.versionId
      });
      expect(byId.get(richer.versionId)).toMatchObject({
        state: "SUPERSEDED",
        supersedesVersionId: null
      });
      expect(byId.get(returned.versionId)).toMatchObject({
        state: "ACTIVE",
        supersedesVersionId: richer.versionId
      });
      expect(new Set(versions.map(({ id }) => id)).size).toBe(5);
      await expect(prisma.memoryFactVersion.count({
        where: { factId: ordered.factId, state: "ACTIVE", userId: owner.userId }
      })).resolves.toBe(1);
      const indexedRows = await prisma.memorySearchEntry.findMany({
        select: { factVersionId: true },
        where: { userId: owner.userId }
      });
      expect(indexedRows).toEqual(expect.arrayContaining([
        { factVersionId: returned.versionId }
      ]));
      const indexedVersionIds = new Set(
        indexedRows.map(({ factVersionId }) => factVersionId)
      );
      expect(indexedVersionIds.has(owned.versionId)).toBe(false);
      for (const versionId of indexedVersionIds) {
        if (!versionId) throw new Error("memory_relation_index_fixture_invalid");
        expect(["ACTIVE", "SUPERSEDED"]).toContain(byId.get(versionId)?.state);
      }
      await expect(prisma.memoryFactVersionRelation.findMany({
        select: { kind: true, sourceVersionId: true, targetVersionId: true },
        where: { userId: owner.userId }
      })).resolves.toEqual(expect.arrayContaining([
        {
          kind: "MERGED_INTO",
          sourceVersionId: owned.versionId,
          targetVersionId: richer.versionId
        },
        {
          kind: "ENRICHES",
          sourceVersionId: richer.versionId,
          targetVersionId: owned.versionId
        }
      ]));

      await expect(prisma.memoryFactVersion.update({
        data: { supersedesVersionId: returned.versionId },
        where: { id: richer.versionId }
      })).rejects.toThrow();
      await expect(prisma.memoryFactVersion.update({
        data: { relationSnapshotHash: "f".repeat(64) },
        where: { id: richer.versionId }
      })).rejects.toThrow();
      const mergeTrace = await prisma.memoryFactVersionRelation.findFirstOrThrow({
        where: { kind: "MERGED_INTO", userId: owner.userId }
      });
      await expect(prisma.memoryFactVersionRelation.update({
        data: { reasonCode: "rewritten" },
        where: { id: mergeTrace.id }
      })).rejects.toThrow();
    } finally {
      await cleanupOwner(owner.userId);
    }
  });

  it("moves an identity correction and merges a redundant cross-fact representation", async () => {
    const owner = await createOwner("cross-fact");
    try {
      const m3Entity = await createEntity(
        owner.userId,
        "device:apple:macbook-air-m3",
        "MacBook Air M3"
      );
      const m3 = await createSlotVersion({
        ...owner,
        displayText: "The user owns a MacBook Air M3.",
        entityId: m3Entity,
        identity: {
          canonicalKey: "slot:v2:device:macbook-air-m3:product_status:_",
          dimensionKey: null,
          predicateKey: "product_status",
          subjectKey: "device:macbook-air-m3"
        },
        source: await createSource(owner.userId, "I own a MacBook Air M3.", at(20)),
        state: "ACTIVE",
        structuredValue: { model: "M3", state: "owned" }
      });
      const m4Entity = await createEntity(
        owner.userId,
        "device:apple:macbook-air-m4",
        "MacBook Air M4"
      );
      const m4 = await createSlotVersion({
        ...owner,
        correctionTargetVersionId: m3.versionId,
        displayText: "The user owns a MacBook Air M4, not an M3.",
        entityId: m4Entity,
        identity: {
          canonicalKey: "slot:v2:device:macbook-air-m4:product_status:_",
          dimensionKey: null,
          predicateKey: "product_status",
          subjectKey: "device:macbook-air-m4"
        },
        source: await createSource(
          owner.userId,
          "Actually, it is a MacBook Air M4, not an M3.",
          at(21)
        ),
        state: "PENDING_RELATION",
        structuredValue: { model: "M4", state: "owned" }
      });
      await expect(resolveDirect(m4, owner.userId, at(22)))
        .resolves.toMatchObject({ decision: { operation: "MOVE_TO_DISTINCT_FACT" } });

      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: m3.factId } }))
        .resolves.toMatchObject({
          currentVersionId: null,
          movedToFactId: m4.factId,
          state: "RETRACTED"
        });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: m4.factId } }))
        .resolves.toMatchObject({ currentVersionId: m4.versionId, state: "ACTIVE" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: m4.versionId }
      })).resolves.toMatchObject({
        movedFromVersionId: m3.versionId,
        state: "ACTIVE",
        supersedesVersionId: m3.versionId
      });
      await expect(prisma.memoryFactVersionRelation.findFirst({
        where: {
          kind: "MOVED_FROM",
          sourceVersionId: m4.versionId,
          targetVersionId: m3.versionId,
          userId: owner.userId
        }
      })).resolves.not.toBeNull();
      await expect(prisma.memoryEvidence.count({
        where: { factVersionId: m4.versionId, userId: owner.userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryFactVersionEntity.count({
        where: { factVersionId: m4.versionId, userId: owner.userId }
      })).resolves.toBe(1);
      await expect(prisma.memoryFactVersionSourceDependency.count({
        where: { targetFactVersionId: m4.versionId, userId: owner.userId }
      })).resolves.toBe(1);
      await expect(memoryFactDependenciesAreValid(
        prisma,
        owner.userId,
        m4.versionId,
        [{
          dependencyKind: "CORRECTION_TARGET",
          ref: "F1",
          source: {
            contentHash: null,
            factVersionId: m3.versionId,
            messageId: null,
            messageUpdatedAt: null,
            projectionVersion: null
          }
        }]
      )).resolves.toBe(true);
      await expect(prisma.memoryFact.update({
        data: { movedToFactId: m3.factId },
        where: { id: m4.factId }
      })).rejects.toThrow();

      const sharedEntity = await createEntity(
        owner.userId,
        "device:apple:shared-macbook-air",
        "Shared MacBook Air"
      );
      const canonical = await createSlotVersion({
        ...owner,
        displayText: "The user owns a shared MacBook Air.",
        entityId: sharedEntity,
        identity: {
          canonicalKey: "slot:v2:device:shared-macbook-air:product_status:_",
          dimensionKey: null,
          predicateKey: "product_status",
          subjectKey: "device:shared-macbook-air"
        },
        source: await createSource(
          owner.userId,
          "I own our shared MacBook Air.",
          at(23)
        ),
        state: "ACTIVE",
        structuredValue: { owner: "shared", state: "owned" }
      });
      const redundant = await createSlotVersion({
        ...owner,
        displayText: "The user owns the MacBook.",
        entityId: sharedEntity,
        identity: {
          canonicalKey: "slot:v2:device:family-macbook:product_status:_",
          dimensionKey: null,
          predicateKey: "product_status",
          subjectKey: "device:family-macbook"
        },
        source: await createSource(owner.userId, "I own the MacBook.", at(24)),
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" }
      });
      await expect(resolveDirect(redundant, owner.userId, at(25)))
        .resolves.toMatchObject({
          decision: { operation: "MERGE_NEW_INTO_TARGET" }
        });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: redundant.factId }
      })).resolves.toMatchObject({
        currentVersionId: null,
        movedToFactId: canonical.factId,
        state: "RETRACTED"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: redundant.versionId }
      })).resolves.toMatchObject({
        mergedIntoVersionId: canonical.versionId,
        state: "MERGED"
      });
      await expect(prisma.memoryFactVersionEntity.count({
        where: { factVersionId: redundant.versionId, userId: owner.userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(owner.userId);
    }
  });

  it("handles scheduler lag, retrospective residence, and explicit authority conservatively", async () => {
    const owner = await createOwner("temporal-authority");
    try {
      const expiringIdentity: SlotIdentity = {
        canonicalKey: "slot:v2:device:expiring-macbook:product_status:_",
        dimensionKey: null,
        predicateKey: "product_status",
        subjectKey: "device:expiring-macbook"
      };
      const expiring = await createSlotVersion({
        ...owner,
        displayText: "The user has an ordered MacBook until the reservation lapses.",
        expiresAt: at(42),
        identity: expiringIdentity,
        source: await createSource(owner.userId, "I ordered a reserved MacBook.", at(40)),
        state: "ACTIVE",
        structuredValue: { state: "ordered" }
      });
      const replacement = await createSlotVersion({
        ...owner,
        displayText: "The user owns the replacement MacBook.",
        factId: expiring.factId,
        identity: expiringIdentity,
        source: await createSource(owner.userId, "I own the replacement MacBook.", at(41)),
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" }
      });
      await expect(resolveDirect(replacement, owner.userId, at(43)))
        .resolves.toMatchObject({
          decision: { operation: "ACTIVATE_AFTER_EXPIRY" }
        });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: expiring.versionId }
      })).resolves.toMatchObject({ state: "EXPIRED" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: replacement.versionId }
      })).resolves.toMatchObject({ state: "ACTIVE", supersedesVersionId: null });
      await expect(prisma.memoryEvent.count({
        where: {
          factVersionId: { in: [expiring.versionId, replacement.versionId] },
          operation: { in: ["EXPIRE", "PROMOTE"] },
          userId: owner.userId
        }
      })).resolves.toBe(2);

      const residenceIdentity: SlotIdentity = {
        canonicalKey: "slot:v2:user:self:residence:primary",
        dimensionKey: "primary",
        predicateKey: "residence",
        subjectKey: "user:self"
      };
      const moscow = await createSlotVersion({
        ...owner,
        displayText: "The user lives in Moscow.",
        identity: residenceIdentity,
        source: await createSource(owner.userId, "I live in Moscow.", at(44)),
        state: "ACTIVE",
        structuredValue: { placeKey: "city:moscow" }
      });
      const parisHistory = await createSlotVersion({
        ...owner,
        displayText: "The user previously lived in Paris.",
        factId: moscow.factId,
        identity: residenceIdentity,
        source: await createSource(owner.userId, "I previously lived in Paris.", at(45)),
        state: "PENDING_RELATION",
        structuredValue: { placeKey: "city:paris" },
        temporalPerspective: "FORMER"
      });
      await expect(resolveDirect(parisHistory, owner.userId, at(46)))
        .resolves.toMatchObject({ decision: { operation: "CONFLICT" } });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: moscow.factId } }))
        .resolves.toMatchObject({ currentVersionId: moscow.versionId, state: "ACTIVE" });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: parisHistory.versionId }
      })).resolves.toMatchObject({ state: "CONFLICTING" });

      const explicitIdentity: SlotIdentity = {
        canonicalKey: "slot:v2:device:explicit-macbook:product_status:_",
        dimensionKey: null,
        predicateKey: "product_status",
        subjectKey: "device:explicit-macbook"
      };
      const explicitCurrent = await createSlotVersion({
        ...owner,
        displayText: "The user explicitly saved an ordered MacBook.",
        identity: explicitIdentity,
        source: await createSource(owner.userId, "Save that I ordered a MacBook.", at(47)),
        sourceMode: "EXPLICIT",
        state: "ACTIVE",
        structuredValue: { state: "ordered" }
      });
      const automaticConflict = await createSlotVersion({
        ...owner,
        displayText: "The user owns the explicitly tracked MacBook.",
        factId: explicitCurrent.factId,
        identity: explicitIdentity,
        source: await createSource(owner.userId, "I bought that MacBook.", at(48)),
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" }
      });
      await expect(resolveDirect(automaticConflict, owner.userId, at(49)))
        .resolves.toMatchObject({ decision: { operation: "CONFLICT" } });
      await expect(prisma.memoryFact.findUniqueOrThrow({
        where: { id: explicitCurrent.factId }
      })).resolves.toMatchObject({ currentVersionId: explicitCurrent.versionId });

      const unavailableIdentity: SlotIdentity = {
        canonicalKey: "slot:v2:device:unavailable-macbook:product_status:_",
        dimensionKey: null,
        predicateKey: "product_status",
        subjectKey: "device:unavailable-macbook"
      };
      const unavailableCurrent = await createSlotVersion({
        ...owner,
        displayText: "The user ordered an unavailable-source MacBook.",
        identity: unavailableIdentity,
        source: await createSource(
          owner.userId,
          "I ordered an unavailable-source MacBook.",
          at(50)
        ),
        state: "ACTIVE",
        structuredValue: { state: "ordered" }
      });
      const stranded = await createSlotVersion({
        ...owner,
        displayText: "The user owns the unavailable-source MacBook.",
        factId: unavailableCurrent.factId,
        identity: unavailableIdentity,
        source: await createSource(
          owner.userId,
          "I bought the unavailable-source MacBook.",
          at(51)
        ),
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" }
      });
      await prisma.chat.update({
        data: { memoryMode: "EXCLUDED" },
        where: { id: unavailableCurrent.source.chatId }
      });
      const strandedJob = await createRelationJob(stranded, owner.userId);
      const strandedClaim = await claimRelationJob(strandedJob, at(52));
      const strandedResult = await executeClaim(strandedClaim, at(52));
      expect(strandedResult.stage).toBe("relation_current_ineligible");
      await expect(commitClaim(strandedClaim, at(52), strandedResult))
        .resolves.toBe(true);
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: stranded.versionId }
      })).resolves.toMatchObject({ state: "CONFLICTING" });
    } finally {
      await cleanupOwner(owner.userId);
    }
  });

  it("fences source invalidation and serializes competing current-pointer updates", async () => {
    const invalidatedOwner = await createOwner("source-invalidation");
    try {
      const identity: SlotIdentity = {
        canonicalKey: "slot:v2:device:source-fenced:product_status:_",
        dimensionKey: null,
        predicateKey: "product_status",
        subjectKey: "device:source-fenced"
      };
      const current = await createSlotVersion({
        ...invalidatedOwner,
        displayText: "The user ordered a source-fenced MacBook.",
        identity,
        source: await createSource(
          invalidatedOwner.userId,
          "I ordered a source-fenced MacBook.",
          at(60)
        ),
        state: "ACTIVE",
        structuredValue: { state: "ordered" }
      });
      const pending = await createSlotVersion({
        ...invalidatedOwner,
        displayText: "The user owns the source-fenced MacBook.",
        factId: current.factId,
        identity,
        source: await createSource(
          invalidatedOwner.userId,
          "I bought the source-fenced MacBook.",
          at(61)
        ),
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" }
      });
      const job = await createRelationJob(pending, invalidatedOwner.userId);
      const claim = await claimRelationJob(job, at(62));
      const result = await executeClaim(claim, at(62));
      const recoverySource = await createSource(
        invalidatedOwner.userId,
        "I still own the source-fenced MacBook.",
        at(62)
      );
      await addExactEvidence(
        invalidatedOwner.userId,
        pending.versionId,
        recoverySource
      );
      await prisma.chat.update({
        data: { memoryMode: "EXCLUDED" },
        where: { id: pending.source.chatId }
      });
      await expect(commitClaim(claim, at(62), result)).resolves.toBe(true);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: job.id } }))
        .resolves.toMatchObject({ errorCode: "memory_source_stale", state: "STALE" });
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: current.factId } }))
        .resolves.toMatchObject({ currentVersionId: current.versionId });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: pending.versionId }
      })).resolves.toMatchObject({ state: "PENDING_RELATION" });
      await expect(reconcileMemoryFactRelationJobs(prisma)).resolves.toBe(1);
      await expect(prisma.memoryJob.findFirst({
        where: {
          id: { not: job.id },
          kind: "RESOLVE_FACT_RELATIONS",
          sourceMessageId: recoverySource.messageId,
          state: "QUEUED",
          targetFactVersionId: pending.versionId,
          userId: invalidatedOwner.userId
        }
      })).resolves.not.toBeNull();
    } finally {
      await cleanupOwner(invalidatedOwner.userId);
    }

    const raceOwner = await createOwner("pointer-race");
    try {
      const identity: SlotIdentity = {
        canonicalKey: "slot:v2:device:racing-macbook:product_status:_",
        dimensionKey: null,
        predicateKey: "product_status",
        subjectKey: "device:racing-macbook"
      };
      const current = await createSlotVersion({
        ...raceOwner,
        displayText: "The user ordered a racing MacBook.",
        identity,
        source: await createSource(raceOwner.userId, "I ordered a racing MacBook.", at(63)),
        state: "ACTIVE",
        structuredValue: { state: "ordered" }
      });
      const owned = await createSlotVersion({
        ...raceOwner,
        displayText: "The user owns the racing MacBook.",
        factId: current.factId,
        identity,
        source: await createSource(raceOwner.userId, "I bought the racing MacBook.", at(64)),
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" }
      });
      const cancelled = await createSlotVersion({
        ...raceOwner,
        displayText: "The user cancelled the racing MacBook order.",
        factId: current.factId,
        identity,
        source: await createSource(
          raceOwner.userId,
          "I cancelled the racing MacBook order.",
          at(65)
        ),
        state: "PENDING_RELATION",
        structuredValue: { state: "cancelled" }
      });
      const ownedClaim = {
        ...await relationDescriptor(owned, raceOwner.userId),
        claimToken: randomUUID(),
        leaseExpiresAt: at(120),
        recoveredLease: false
      } satisfies MemoryJobClaim;
      const cancelledClaim = {
        ...await relationDescriptor(cancelled, raceOwner.userId),
        claimToken: randomUUID(),
        leaseExpiresAt: at(120),
        recoveredLease: false
      } satisfies MemoryJobClaim;
      const ownedPlan = (await preparePlan(ownedClaim, at(66))).plan;
      const cancelledPlan = (await preparePlan(cancelledClaim, at(66))).plan;
      const outcomes = await Promise.allSettled([
        prisma.$transaction((tx) => repository.apply(
          tx,
          ownedClaim,
          ownedPlan,
          at(66)
        )),
        prisma.$transaction((tx) => repository.apply(
          tx,
          cancelledClaim,
          cancelledPlan,
          at(66)
        ))
      ]);
      expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
      await expect(prisma.memoryFactVersion.count({
        where: { factId: current.factId, state: "ACTIVE", userId: raceOwner.userId }
      })).resolves.toBe(1);
      const fact = await prisma.memoryFact.findUniqueOrThrow({
        where: { id: current.factId }
      });
      const active = await prisma.memoryFactVersion.findFirstOrThrow({
        where: { factId: current.factId, state: "ACTIVE", userId: raceOwner.userId }
      });
      expect(fact.currentVersionId).toBe(active.id);
    } finally {
      await cleanupOwner(raceOwner.userId);
    }
  });

  it("reserves one auxiliary call per source and recovers its strict receipt", async () => {
    const owner = await createOwner("auxiliary-budget");
    try {
      const identity: SlotIdentity = {
        canonicalKey: "slot:v2:device:auxiliary-macbook:product_status:_",
        dimensionKey: null,
        predicateKey: "product_status",
        subjectKey: "device:auxiliary-macbook"
      };
      const current = await createSlotVersion({
        ...owner,
        displayText: "The user may have an auxiliary MacBook.",
        identity,
        source: await createSource(owner.userId, "I may have an auxiliary MacBook.", at(70)),
        state: "ACTIVE",
        structuredValue: { state: "considering" }
      });
      const sharedSource = await createSource(
        owner.userId,
        "The auxiliary MacBook situation changed.",
        at(71)
      );
      const pending = await createSlotVersion({
        ...owner,
        displayText: "The auxiliary MacBook situation is unclear.",
        factId: current.factId,
        identity,
        source: sharedSource,
        state: "PENDING_RELATION",
        structuredValue: { state: "unknown_custom_state" }
      });
      const first = await createRelationJob(pending, owner.userId);
      const secondDescriptor = await relationDescriptor(pending, owner.userId);
      await prisma.memoryJob.create({ data: { ...secondDescriptor, stage: undefined } });

      await expect(repository.auxiliaryCallAvailable(first)).resolves.toBe(true);
      const reservations = await Promise.all([
        repository.reserveAuxiliaryCall(first),
        repository.reserveAuxiliaryCall(secondDescriptor)
      ]);
      expect(reservations.map(({ status }) => status).sort())
        .toEqual(["ACQUIRED", "UNAVAILABLE"]);
      const ownerJob = reservations[0]?.status === "ACQUIRED" ? first : secondDescriptor;
      const excludedJob = ownerJob.id === first.id ? secondDescriptor : first;

      const decision: MemoryRelationProviderDecision = {
        confidenceBand: "HIGH",
        operation: "MERGE_NEW_INTO_TARGET",
        reasonCode: "same_truth_representation",
        targetRef: "R1"
      };
      const inputHash = memorySha256({ domain: "memory-relation-aux-input" });
      const acceptedOutputHash = memoryRelationAcceptedOutputHash(inputHash, decision);
      const executionId = randomUUID();
      await prisma.memoryExecutionBinding.create({
        data: {
          acceptedOutputHash,
          completedAt: at(72),
          createdAt: at(71),
          destinationFingerprint: memorySha256({ destination: "relation-fixture" }),
          id: executionId,
          inputHash,
          logicalRole: "MEMORY_CONSOLIDATE",
          memoryJobId: ownerJob.id,
          ordinal: 0,
          ownerType: "JOB",
          pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
          policyVersion: MEMORY_FACT_RELATION_POLICY_VERSION,
          promptVersion: MEMORY_FACT_RELATION_PROMPT_VERSION,
          providerId: "memory-relation-fixture",
          recoverableUntil: at(72),
          relationsDetachedAt: at(72),
          schemaVersion: MEMORY_FACT_RELATION_SCHEMA_VERSION,
          secretFreeExecutionSnapshot: {},
          startedAt: new Date(at(72).getTime() - 1_000),
          state: "SUCCEEDED",
          userId: owner.userId
        }
      });
      const result: MemoryRelationProviderResult = {
        acceptedOutputHash,
        decision,
        executionId,
        inputHash,
        modelId: "memory-relation-model",
        policyVersion: MEMORY_FACT_RELATION_POLICY_VERSION,
        providerId: "memory-relation-fixture"
      };
      await repository.recordAuxiliaryResult(ownerJob, result, at(73));
      await expect(repository.reserveAuxiliaryCall(ownerJob)).resolves.toEqual({
        result,
        status: "RECOVERED"
      });
      await expect(repository.reserveAuxiliaryCall(excludedJob)).resolves.toEqual({
        status: "UNAVAILABLE"
      });
      await expect(prisma.memoryAuxiliarySemanticCall.updateMany({
        data: { inputHash: "f".repeat(64) },
        where: { ownerJobId: ownerJob.id, userId: owner.userId }
      })).rejects.toThrow();
    } finally {
      await cleanupOwner(owner.userId);
    }
  });
});
