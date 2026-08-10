import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryMutationAuthorizationInput
} from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { providerTemplateIds } from "../../../domain/providerTemplates";
import { prisma } from "../../prisma";
import type { NormalizedRunRequest } from "../../providers/types";
import { createPrismaRunRepository } from "../../runs/prismaRepository";
import { createPrismaMemoryCoordinatorRepository } from "../coordinator/prismaRepository";
import type { MemoryDeletionClaim } from "../coordinator/types";
import { createPrismaExplicitMemoryRepository } from "../explicit/repository";
import {
  createExplicitMemoryService,
  ExplicitMemoryServiceError
} from "../explicit/service";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactValueInput
} from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import {
  MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS
} from "../purge/contract";
import { registerPhase2MemoryDeletionContributors } from "../purge/leaves";
import { auditMemoryDeletion } from "../purge/reconciliation";
import {
  type MemoryDeletionContributor,
  MemoryDeletionContributorRegistry
} from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { createPrismaMemoryLifecycleRepository } from "./repository";
import {
  createMemoryLifecycleService,
  MemoryLifecycleServiceError
} from "./service";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 81));
const keyring = MemorySuppressionKeyring.parse(
  `current=lifecycle-v1,lifecycle-v1=${keyBytes.toString("base64")}`
);

function phase2Registry(): MemoryDeletionContributorRegistry {
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS
  });
  registerPhase2MemoryDeletionContributors(registry);
  return registry;
}

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Memory lifecycle ${label}`,
      email: `memory-lifecycle-${label}-${id}@example.test`,
      id,
      settings: {
        create: {
          defaultControlValues: {},
          defaultProviderModelId: providerTemplateIds.fakeModel,
          defaultSearchStrategyId: "search-disabled"
        }
      },
      status: "active"
    }
  });
  return id;
}

async function cleanupUsers(userIds: readonly string[]): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({
    where: { userId: { in: [...userIds] } }
  });
  await prisma.user.deleteMany({ where: { id: { in: [...userIds] } } });
}

function services(registry: MemoryDeletionContributorRegistry) {
  const authorizationRepository =
    createPrismaMemoryMutationAuthorizationRepository(prisma);
  const readRepository = createPrismaExplicitMemoryRepository(prisma);
  const explicit = createExplicitMemoryService({
    authorizationRepository,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository,
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
  });
  const lifecycle = createMemoryLifecycleService({
    authorizationRepository,
    mutationRepository: createPrismaMemoryLifecycleRepository(
      keyring,
      registry,
      prisma
    ),
    readRepository
  });
  return { explicit, lifecycle };
}

async function saveExplicit(
  explicit: ReturnType<typeof services>["explicit"],
  userId: string,
  statement: string,
  nonce: string
) {
  const authorization = await explicit.mintAuthorization(userId, {
    action: "SAVE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement),
    requestNonce: nonce
  });
  return explicit.create(userId, {
    mutationAuthorizationId: authorization.mutationAuthorizationId,
    scope: { type: "GLOBAL_USER" },
    statement
  });
}

function normalizedRequest(
  chatId: string,
  content = "Use my saved preference."
): NormalizedRunRequest {
  return {
    attachmentIds: [],
    chatId,
    content: textMessageContent(content),
    modelCapabilities: {
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: false,
      vision: false
    },
    modelId: providerTemplateIds.fakeModel,
    params: {},
    prompt: { developer: null, system: null },
    provider: providerTemplateIds.fakeConnection,
    searchStrategy: "search-disabled"
  };
}

async function createUnacceptedAttemptItem(input: Readonly<{
  factVersionId: string;
  statement: string;
  userId: string;
}>): Promise<Readonly<{
  attemptId: string;
  assistantMessageId: string;
  chatId: string;
  messageId: string;
  runId: string;
}>> {
  const chat = await prisma.chat.create({
    data: {
      defaultProviderModelId: providerTemplateIds.fakeModel,
      title: "Memory purge fixture",
      userId: input.userId
    }
  });
  const request = normalizedRequest(chat.id);
  const admitted = await createPrismaRunRepository(prisma).admitPreparingRun({
    admissionKind: "NORMAL_SEND",
    chatId: chat.id,
    content: request.content,
    expectedActiveLeafId: null,
    modelId: request.modelId,
    normalizedRequest: request,
    provider: request.provider,
    providerRequestPreview: { request: "base" },
    userId: input.userId
  });
  await prisma.memoryRetrievalAttempt.update({
    data: {
      preparedContextHash: memorySha256(input.statement),
      preparedContextText: `Remembered context: ${input.statement}`,
      preparedContextTokenCount: 8
    },
    where: { id: admitted.attemptId }
  });
  await prisma.memoryRetrievalAttemptItem.create({
    data: {
      attemptId: admitted.attemptId,
      exactItemId: input.factVersionId,
      exactSafeText: input.statement,
      factVersionId: input.factVersionId,
      featureSnapshot: {},
      itemType: "FACT_VERSION",
      laneRanks: {},
      ordinal: 0,
      selectionReason: "memory-lifecycle-purge-test",
      sourceSnapshot: {},
      textHash: memorySha256(input.statement),
      userId: input.userId,
      versionSnapshot: {}
    }
  });
  return {
    attemptId: admitted.attemptId,
    assistantMessageId: admitted.assistantMessageId,
    chatId: chat.id,
    messageId: admitted.userMessageId,
    runId: admitted.runId
  };
}

async function claimDeletion(
  userId: string,
  deletionId: string,
  now: Date
): Promise<MemoryDeletionClaim> {
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const claimed = await prisma.memoryDeletionOutbox.updateMany({
    data: {
      attemptCount: { increment: 1 },
      errorCode: null,
      leaseExpiresAt,
      leaseToken: claimToken,
      nextAttemptAt: null,
      state: "RUNNING",
      updatedAt: now
    },
    where: {
      id: deletionId,
      state: { in: ["BLOCKED_REQUIRES_ADMIN", "PENDING", "RETRY_WAIT"] },
      userId
    }
  });
  expect(claimed.count).toBe(1);
  const row = await prisma.memoryDeletionOutbox.findUniqueOrThrow({
    where: { id: deletionId }
  });
  return {
    attemptCount: row.attemptCount,
    claimToken,
    id: deletionId,
    leaseExpiresAt,
    memoryGeneration: row.memoryGeneration,
    operation: row.operation,
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: row.targetId,
    targetType: row.targetType,
    userId
  };
}

async function commitDeletion(
  registry: MemoryDeletionContributorRegistry,
  userId: string,
  deletionId: string,
  now: Date
): Promise<void> {
  const claim = await claimDeletion(userId, deletionId, now);
  const execution = await registry.handler().execute(claim, {
    now: () => now,
    signal: new AbortController().signal
  });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitDeletionSuccess({
    apply: execution.apply,
    claim,
    now
  })).resolves.toBe(true);
}

function automaticValue(
  canonicalKey: string,
  statement: string
): MemoryFactValueInput {
  return {
    canonicalKey,
    category: "preference",
    confidence: 0.9,
    directness: "DIRECT",
    displayText: statement,
    importance: 0.8,
    languageCode: "en",
    modality: "PREFERENCE",
    pipelineVersion: "memory-lifecycle-test-v1",
    secretTaintedSourceWindow: false,
    sensitivityClass: "NORMAL",
    sourceMode: "AUTOMATIC",
    structuredValue: { statement }
  };
}

function upgradedRegistry(): MemoryDeletionContributorRegistry {
  const lateContributor: MemoryDeletionContributor = Object.freeze({
    async audit(tx, target) {
      if (target.kind !== "MEMORY_FACT") return 0;
      const rows = await tx.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS "count"
        FROM "MemoryEvent"
        WHERE "userId" = ${target.userId}
          AND "factId" = ${target.targetId}
          AND "operation" = 'FORGET'::"MemoryEventOperation"
          AND COALESCE("metadata" ->> 'lateContributorApplied', 'false') <> 'true'
      `);
      return rows[0]?.count ?? 0;
    },
    id: "late-derived",
    async purge(tx, target) {
      if (target.kind !== "MEMORY_FACT") return;
      await tx.$executeRaw(Prisma.sql`
        UPDATE "MemoryEvent"
        SET "metadata" = "metadata" || ${JSON.stringify({
          lateContributorApplied: true
        })}::jsonb
        WHERE "userId" = ${target.userId}
          AND "factId" = ${target.targetId}
          AND "operation" = 'FORGET'::"MemoryEventOperation"
      `);
    },
    version: "v2"
  });
  const registry = new MemoryDeletionContributorRegistry({
    operation: "FORGET_PURGE",
    requirements: [
      ...MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS,
      { id: lateContributor.id, version: lateContributor.version }
    ]
  });
  registerPhase2MemoryDeletionContributors(registry);
  registry.register(lateContributor);
  return registry;
}

describe("Prisma Memory Forget and purge lifecycle", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("fences synchronously, purges durably, blocks rebuilding, and replays upgraded obligations", async () => {
    const registry = phase2Registry();
    const ownerUserId = await createActiveUser("forget-owner");
    const foreignUserId = await createActiveUser("forget-foreign");
    const { explicit, lifecycle } = services(registry);
    const statement = "I prefer quiet hotels near a railway station.";
    try {
      const created = await saveExplicit(
        explicit,
        ownerUserId,
        statement,
        "forget-save"
      );
      const factId = created.memory.id;
      const versionId = created.memory.currentVersionId!;
      const attempt = await createUnacceptedAttemptItem({
        factVersionId: versionId,
        statement,
        userId: ownerUserId
      });
      const before = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId: ownerUserId }
      });
      const authorization = await explicit.mintAuthorization(ownerUserId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId,
        requestNonce: "forget-authorize",
        targetFactId: factId
      });
      const forgetInput = {
        expectedVersionId: versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      };

      const forgotten = await lifecycle.forget(ownerUserId, factId, forgetInput);
      expect(forgotten.memory).toMatchObject({
        currentVersionId: null,
        displayText: null,
        factState: "FORGOTTEN",
        id: factId,
        pinned: false,
        versionState: "FORGOTTEN"
      });
      await expect(lifecycle.forget(ownerUserId, factId, forgetInput)).resolves
        .toEqual(forgotten);

      const [settings, fact, version, event, deletion, authorizationRow] =
        await Promise.all([
          prisma.userMemorySettings.findUniqueOrThrow({
            where: { userId: ownerUserId }
          }),
          prisma.memoryFact.findUniqueOrThrow({ where: { id: factId } }),
          prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: versionId } }),
          prisma.memoryEvent.findFirstOrThrow({
            where: { factId, operation: "FORGET", userId: ownerUserId }
          }),
          prisma.memoryDeletionOutbox.findFirstOrThrow({
            where: { operation: "FORGET_PURGE", userId: ownerUserId }
          }),
          prisma.memoryMutationAuthorization.findUniqueOrThrow({
            where: { id: authorization.mutationAuthorizationId }
          })
        ]);
      expect(settings).toMatchObject({
        memoryGeneration: before.memoryGeneration + 1,
        memoryRevision: before.memoryRevision + 1,
        settingsRevision: before.settingsRevision
      });
      expect(fact).toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
      expect(version).toMatchObject({
        contentPurgedAt: null,
        displayText: statement,
        state: "FORGOTTEN"
      });
      expect(JSON.stringify(event.metadata)).not.toContain(statement);
      expect(event).toMatchObject({ actorType: "USER", actorUserId: ownerUserId });
      expect(authorizationRow.consumedAt).toEqual(expect.any(Date));
      await expect(prisma.memorySearchEntry.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(0);
      await expect(prisma.memorySuppression.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(2);
      await expect(prisma.memoryOperationReceipt.count({
        where: { operation: "FORGET", userId: ownerUserId }
      })).resolves.toBe(1);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: attempt.attemptId, userId: ownerUserId }
      })).resolves.toBe(1);
      await expect(lifecycle.status(foreignUserId, deletion.id)).rejects.toEqual(
        new MemoryLifecycleServiceError("memory_not_found")
      );

      const pending = await auditMemoryDeletion(
        registry,
        deletion.id,
        ownerUserId,
        prisma
      );
      expect(pending).toMatchObject({
        lastAuditAt: expect.any(Date),
        progress: { completedUnits: 1, totalUnits: 4 },
        state: "PENDING",
      });

      const failureRegistry = new MemoryDeletionContributorRegistry({
        operation: "FORGET_PURGE",
        requirements: [
          ...MEMORY_PHASE2_PURGE_REQUIRED_CONTRIBUTORS,
          { id: "failure-fixture", version: "v1" }
        ]
      });
      registerPhase2MemoryDeletionContributors(failureRegistry);
      failureRegistry.register({
        audit: async () => 0,
        id: "failure-fixture",
        purge: async () => {
          throw new Error("memory_purge_failure_fixture");
        },
        version: "v1"
      });
      const failedAt = new Date("2026-08-10T11:58:00.000Z");
      const failedClaim = await claimDeletion(ownerUserId, deletion.id, failedAt);
      const failedExecution = await failureRegistry.handler().execute(failedClaim, {
        now: () => failedAt,
        signal: new AbortController().signal
      });
      await expect(createPrismaMemoryCoordinatorRepository(prisma)
        .commitDeletionSuccess({
          apply: failedExecution.apply,
          claim: failedClaim,
          now: failedAt
        })).rejects.toThrow("memory_purge_failure_fixture");
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })).resolves.toMatchObject({ contentPurgedAt: null, displayText: statement });
      await expect(prisma.memoryEvidence.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: attempt.attemptId, userId: ownerUserId }
      })).resolves.toBe(1);
      await expect(createPrismaMemoryCoordinatorRepository(prisma).retryDeletion({
        blocked: false,
        claim: failedClaim,
        errorCode: "memory_purge_failure_fixture",
        nextAttemptAt: new Date("2026-08-10T11:59:00.000Z"),
        now: failedAt
      })).resolves.toBe(true);
      await commitDeletion(
        registry,
        ownerUserId,
        deletion.id,
        new Date("2026-08-10T12:00:00.000Z")
      );
      const succeeded = await auditMemoryDeletion(
        registry,
        deletion.id,
        ownerUserId,
        prisma,
        new Date("2026-08-10T12:00:01.000Z")
      );
      expect(succeeded).toMatchObject({
        progress: { completedUnits: 4, totalUnits: 4 },
        state: "SUCCEEDED",
      });

      const [purgedVersion, purgedAttempt, settledRun, settledMessage] = await Promise.all([
        prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: versionId } }),
        prisma.memoryRetrievalAttempt.findUniqueOrThrow({
          where: { id: attempt.attemptId }
        }),
        prisma.modelRun.findUniqueOrThrow({ where: { id: attempt.runId } }),
        prisma.message.findUniqueOrThrow({
          where: { id: attempt.assistantMessageId }
        })
      ]);
      expect(purgedVersion).toMatchObject({
        contentPurgedAt: expect.any(Date),
        displayText: null,
        normalizedSearchText: null,
        structuredValue: null
      });
      expect(purgedAttempt).toMatchObject({
        errorCode: "memory_item_forgotten",
        preparedContextHash: null,
        preparedContextText: null,
        preparedContextTokenCount: null,
        state: "STALE"
      });
      expect(settledRun).toMatchObject({
        errorPayload: { code: "memory_item_forgotten" },
        status: "error"
      });
      expect(settledMessage).toMatchObject({
        errorMessage:
          "Memory preparation stopped because a selected Memory item was forgotten.",
        status: "error"
      });
      await expect(prisma.memoryRetrievalAttemptItem.count({
        where: { attemptId: attempt.attemptId, userId: ownerUserId }
      })).resolves.toBe(0);
      await expect(prisma.memoryEvidence.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(0);

      const scope = await createPrismaMemoryScopeRepository(prisma)
        .ensureGlobal(ownerUserId);
      await expect(createPrismaMemoryFactRepository(keyring, prisma).save(ownerUserId, {
        evidence: {
          branchGeneration: 0,
          chatId: attempt.chatId,
          kind: "MESSAGE",
          messageId: attempt.messageId,
          observedAt: new Date("2026-08-10T12:01:00.000Z"),
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-lifecycle-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: `automatic-rebuild-${randomUUID()}`,
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue("learned.rebuild", statement)
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });

      const revived = await saveExplicit(
        explicit,
        ownerUserId,
        statement,
        "forget-revive"
      );
      expect(revived.memory).toMatchObject({
        factState: "ACTIVE",
        id: factId,
        sourceMode: "EXPLICIT"
      });
      expect(revived.memory.currentVersionId).not.toBe(versionId);

      const upgraded = upgradedRegistry();
      const reopened = await auditMemoryDeletion(
        upgraded,
        deletion.id,
        ownerUserId,
        prisma,
        new Date("2026-08-10T12:02:00.000Z")
      );
      expect(reopened).toMatchObject({
        progress: { completedUnits: 4, complete: false, totalUnits: 5 },
        state: "PENDING"
      });
      await commitDeletion(
        upgraded,
        ownerUserId,
        deletion.id,
        new Date("2026-08-10T12:03:00.000Z")
      );
      const upgradedStatus = await auditMemoryDeletion(
        upgraded,
        deletion.id,
        ownerUserId,
        prisma,
        new Date("2026-08-10T12:04:00.000Z")
      );
      expect(upgradedStatus).toMatchObject({
        progress: { completedUnits: 5, complete: true, totalUnits: 5 },
        state: "SUCCEEDED"
      });
      await expect(explicit.get(ownerUserId, factId)).resolves.toMatchObject({
        memory: {
          currentVersionId: revived.memory.currentVersionId,
          displayText: statement,
          factState: "ACTIVE"
        }
      });
    } finally {
      await cleanupUsers([ownerUserId, foreignUserId]);
    }
  });

  it("suppresses the exact retained source of a forgotten automatic fact", async () => {
    const registry = phase2Registry();
    const userId = await createActiveUser("automatic-source");
    const { explicit, lifecycle } = services(registry);
    const statement = "I prefer overnight trains for long trips.";
    try {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Retained automatic source",
          userId
        }
      });
      const request = normalizedRequest(chat.id, statement);
      const admitted = await createPrismaRunRepository(prisma).admitPreparingRun({
        admissionKind: "NORMAL_SEND",
        chatId: chat.id,
        content: request.content,
        expectedActiveLeafId: null,
        modelId: request.modelId,
        normalizedRequest: request,
        provider: request.provider,
        providerRequestPreview: { request: "base" },
        userId
      });
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const facts = createPrismaMemoryFactRepository(keyring, prisma);
      const created = await facts.save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: chat.id,
          kind: "MESSAGE",
          messageId: admitted.userMessageId,
          observedAt: new Date("2026-08-10T14:00:00.000Z"),
          safeExcerpt: statement,
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-lifecycle-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: `automatic-source-${randomUUID()}`,
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue("learned.travel.mode", statement)
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "FORGET",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: created.versionId,
        requestNonce: "automatic-source-forget",
        targetFactId: created.factId
      });
      await expect(lifecycle.forget(userId, created.factId, {
        expectedVersionId: created.versionId,
        mutationAuthorizationId: authorization.mutationAuthorizationId
      })).resolves.toMatchObject({
        memory: { displayText: null, factState: "FORGOTTEN" }
      });

      const suppressions = await prisma.memorySuppression.findMany({
        orderBy: { scope: "asc" },
        where: { userId }
      });
      expect(suppressions).toHaveLength(3);
      expect(suppressions).toContainEqual(expect.objectContaining({
        explicitOverrideAllowed: true,
        scope: "SOURCE_MESSAGE",
        sourceBranchGeneration: 0,
        sourceChatId: chat.id,
        sourceMessageId: admitted.userMessageId
      }));
      await expect(facts.save(userId, {
        evidence: {
          branchGeneration: 0,
          chatId: chat.id,
          kind: "MESSAGE",
          messageId: admitted.userMessageId,
          observedAt: new Date("2026-08-10T14:01:00.000Z"),
          safeExcerpt: "For long journeys, sleeper rail is my first choice.",
          safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-lifecycle-test-v1",
          sourceRole: "user"
        },
        explicitSuppressionOverride: false,
        idempotencyFingerprint: `automatic-source-rebuild-${randomUUID()}`,
        requestId: randomUUID(),
        scopeId: scope.id,
        value: automaticValue(
          "learned.travel.mode.paraphrase",
          "For long journeys, sleeper rail is my first choice."
        )
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });

      const deletion = await prisma.memoryDeletionOutbox.findFirstOrThrow({
        where: { operation: "FORGET_PURGE", userId }
      });
      await commitDeletion(
        registry,
        userId,
        deletion.id,
        new Date("2026-08-10T14:02:00.000Z")
      );
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: created.versionId }
      })).resolves.toMatchObject({
        contentPurgedAt: expect.any(Date),
        displayText: null,
        structuredValue: null
      });
      const retainedSource = await prisma.message.findUniqueOrThrow({
        where: { id: admitted.userMessageId }
      });
      expect(retainedSource.chatId).toBe(chat.id);
      expect(JSON.stringify(retainedSource.content)).toContain(statement);
    } finally {
      await cleanupUsers([userId]);
    }
  });

  it("binds DELETE_EXPLICIT to exact counters and rejects later bulk variants", async () => {
    const registry = phase2Registry();
    const userId = await createActiveUser("bulk");
    const { explicit, lifecycle } = services(registry);
    try {
      await saveExplicit(explicit, userId, "My preferred editor is Helix.", "bulk-a");
      await saveExplicit(explicit, userId, "I prefer compact answers.", "bulk-b");
      const staleSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const staleAuthorization = await explicit.mintAuthorization(userId, {
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedMemoryRevision: staleSettings.memoryRevision,
        expectedSettingsRevision: staleSettings.settingsRevision,
        operation: "DELETE_EXPLICIT",
        requestNonce: "bulk-stale"
      });
      await saveExplicit(explicit, userId, "My timezone is Europe/Moscow.", "bulk-c");
      await expect(lifecycle.deleteExplicit(userId, {
        expectedMemoryRevision: staleSettings.memoryRevision,
        expectedSettingsRevision: staleSettings.settingsRevision,
        mutationAuthorizationId: staleAuthorization.mutationAuthorizationId,
        operation: "DELETE_EXPLICIT"
      })).rejects.toEqual(new MemoryLifecycleServiceError("memory_version_stale"));
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: staleAuthorization.mutationAuthorizationId }
      })).resolves.toMatchObject({ consumedAt: null });

      const current = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const authorization = await explicit.mintAuthorization(userId, {
        action: "BULK_DELETE",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedMemoryRevision: current.memoryRevision,
        expectedSettingsRevision: current.settingsRevision,
        operation: "DELETE_EXPLICIT",
        requestNonce: "bulk-current"
      });
      const deleteInput = {
        expectedMemoryRevision: current.memoryRevision,
        expectedSettingsRevision: current.settingsRevision,
        mutationAuthorizationId: authorization.mutationAuthorizationId,
        operation: "DELETE_EXPLICIT"
      } as const;
      const status = await lifecycle.deleteExplicit(userId, deleteInput);
      expect(status).toMatchObject({
        lastAuditAt: expect.any(String),
        memoryGeneration: current.memoryGeneration + 1,
        memoryRevision: current.memoryRevision + 1,
        operation: "DELETE_EXPLICIT",
        settingsRevision: current.settingsRevision,
        state: "PENDING"
      });
      await expect(prisma.memoryFact.count({
        where: { state: "FORGOTTEN", userId }
      })).resolves.toBe(3);
      await expect(prisma.memorySearchEntry.count({ where: { userId } })).resolves.toBe(0);
      await expect(prisma.memoryDeletionOutbox.count({ where: { userId } }))
        .resolves.toBe(1);
      const postAdmission = await saveExplicit(
        explicit,
        userId,
        "I added this explicit memory after bulk admission.",
        "bulk-after-admission"
      );
      await expect(lifecycle.status(userId, status.deletionId)).resolves.toMatchObject({
        memoryGeneration: status.memoryGeneration,
        memoryRevision: status.memoryRevision,
        settingsRevision: status.settingsRevision,
        state: "PENDING"
      });
      await expect(lifecycle.deleteExplicit(userId, deleteInput)).resolves.toMatchObject({
        deletionId: status.deletionId,
        memoryGeneration: status.memoryGeneration,
        memoryRevision: status.memoryRevision,
        settingsRevision: status.settingsRevision,
        state: "PENDING"
      });
      await commitDeletion(
        registry,
        userId,
        status.deletionId,
        new Date("2026-08-10T13:00:00.000Z")
      );
      await expect(lifecycle.status(userId, status.deletionId)).resolves.toMatchObject({
        completedUnits: 4,
        memoryRevision: status.memoryRevision,
        state: "SUCCEEDED",
        totalUnits: 4
      });
      await expect(explicit.get(userId, postAdmission.memory.id)).resolves.toMatchObject({
        memory: {
          currentVersionId: postAdmission.memory.currentVersionId,
          displayText: "I added this explicit memory after bulk admission.",
          factState: "ACTIVE"
        }
      });

      for (const operation of [
        "CLEAR_HISTORY_INDEX",
        "DELETE_ALL_REUSABLE",
        "DELETE_LEARNED"
      ] as const) {
        const input: MemoryMutationAuthorizationInput = {
          action: "BULK_DELETE",
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedMemoryRevision: current.memoryRevision + 1,
          expectedSettingsRevision: current.settingsRevision,
          operation,
          requestNonce: `unsupported-${operation}`
        };
        await expect(explicit.mintAuthorization(userId, input)).rejects.toEqual(
          new ExplicitMemoryServiceError("memory_operation_unsupported")
        );
      }
    } finally {
      await cleanupUsers([userId]);
    }
  });
});
