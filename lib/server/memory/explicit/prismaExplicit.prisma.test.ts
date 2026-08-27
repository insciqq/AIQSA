import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryCreateInput
} from "../../../contracts/memory";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import {
  createPrismaMemoryMutationAuthorizationRepository,
  memoryMutationNonceHash,
  memoryTargetAuthorizationPayloadHash
} from "../persistence/authorizations";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactSaveInput
} from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { createPrismaExplicitMemoryRepository } from "./repository";
import {
  createExplicitMemoryService,
  ExplicitMemoryServiceError
} from "./service";
import type { MemoryStatementClassifier } from "./statementClassifier";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 33));
const keyring = MemorySuppressionKeyring.parse(
  `current=explicit-v1,explicit-v1=${keyBytes.toString("base64")}`
);

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Explicit ${label}`,
      email: `explicit-${label}-${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function cleanupUser(userId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { id: userId } });
}

function service(
  clock?: () => Date,
  classifier?: MemoryStatementClassifier
) {
  return createExplicitMemoryService({
    authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
    clock,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository: createPrismaExplicitMemoryRepository(prisma),
    scopeRepository: createPrismaMemoryScopeRepository(prisma),
    ...(classifier ? { statementClassifier: classifier } : {})
  });
}

function legacyFactInput(
  scopeId: string,
  statement: string
): MemoryFactSaveInput {
  const nonce = randomUUID();
  return {
    authorization: {
      action: "SAVE",
      authorizationId: `legacy-authorization-${nonce}`,
      authorizedPayloadHash: "f".repeat(64)
    },
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: new Date("2026-08-21T08:00:00.000Z"),
      safeExcerpt: statement,
      safeSourceHash: "e".repeat(64),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-explicit-stateful-v1"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint: `legacy-save-${nonce}`,
    requestId: `legacy-request-${nonce}`,
    scopeId,
    value: {
      canonicalKey: `legacy.folder.${nonce}`,
      category: "preference",
      confidence: 1,
      directness: "DIRECT",
      displayText: statement,
      importance: 0.8,
      languageCode: "en",
      modality: "PREFERENCE",
      pipelineVersion: "memory-explicit-stateful-v1",
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "EXPLICIT",
      structuredValue: { statement }
    }
  };
}

async function saveAuthorization(
  memoryService: ReturnType<typeof service>,
  userId: string,
  statement: string,
  nonce: string = randomUUID()
) {
  return memoryService.mintAuthorization(userId, {
    action: "SAVE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement),
    requestNonce: nonce
  });
}

async function createMemory(
  memoryService: ReturnType<typeof service>,
  userId: string,
  statement: string,
  nonce: string = randomUUID(),
  overrides: Partial<MemoryCreateInput> = {}
) {
  const authorization = await saveAuthorization(
    memoryService,
    userId,
    statement,
    nonce
  );
  const input: MemoryCreateInput = {
    category: "preference",
    modality: "PREFERENCE",
    mutationAuthorizationId: authorization.mutationAuthorizationId,
    scope: { type: "GLOBAL_USER" },
    statement,
    validFrom: null,
    validTo: null,
    ...overrides
  };
  return {
    authorization,
    input,
    response: await memoryService.create(userId, input)
  };
}

describe("Prisma explicit Memory API", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("commits exact Russian text through Safety Lite without provider work", async () => {
    const userId = await createActiveUser("lexical");
    const memoryService = service();
    const russian = "  Я предпочитаю ответы о ёлках на русском языке.  ";
    try {
      const initialSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(initialSettings).toMatchObject({
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      });

      const pendingAuthorization = await saveAuthorization(
        memoryService,
        userId,
        russian,
        "nonce-russian"
      );
      const repeatedAuthorization = await saveAuthorization(
        memoryService,
        userId,
        russian,
        "nonce-russian"
      );
      expect(repeatedAuthorization).toEqual(pendingAuthorization);
      const created = await createMemory(memoryService, userId, russian, "nonce-russian");
      expect(created.authorization).toEqual(pendingAuthorization);
      expect(created.response.memory).toMatchObject({
        displayText: russian,
        indexingState: "LEXICAL_READY",
        sourceMode: "EXPLICIT"
      });
      const factId = created.response.memory.id;
      const versionId = created.response.memory.currentVersionId!;
      await expect(memoryService.search(userId, {
        query: "русском",
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({ memories: [{ id: factId }] });
      await expect(memoryService.search(userId, {
        query: "ЕЛКАХ",
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({ memories: [{ id: factId }] });
      await expect(memoryService.search(userId, {
        query: "Я ПРЕДПОЧИТАЮ ОТВЕТЫ О ЕЛКАХ НА РУССКОМ ЯЗЫКЕ."
      })).resolves.toMatchObject({ memories: [{ id: factId }] });

      const [searchShape] = await prisma.$queryRaw<Array<{
        lexicalReady: boolean;
        normalizedSearchText: string;
      }>>`
        SELECT
          "searchVectorSimple" IS NOT NULL AS "lexicalReady",
          "normalizedSearchText"
        FROM "MemorySearchEntry"
        WHERE "userId" = ${userId} AND "factVersionId" = ${versionId}
      `;
      expect(searchShape).toEqual({
        lexicalReady: true,
        normalizedSearchText: "я предпочитаю ответы о елках на русском языке."
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })).resolves.toMatchObject({
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierModelId: null,
        safetyClassifierPolicyVersion: "memory-safety-lite-v1",
        safetyClassifierProviderId: null
      });
      await expect(Promise.all([
        prisma.memoryExecutionBinding.count({ where: { userId } }),
        prisma.usageEvent.count({ where: { userId } })
      ])).resolves.toEqual([0, 0]);
      await expect(prisma.memoryJob.findMany({
        select: { kind: true, state: true },
        where: { userId }
      })).resolves.toEqual([]);

      const replay = await memoryService.create(userId, created.input);
      expect(replay.memory).toMatchObject({ id: factId, currentVersionId: versionId });
      await expect(prisma.memoryExecutionBinding.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(1);
      await expect(memoryService.create(userId, {
        ...created.input,
        category: "changed"
      })).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_intent_confirmation_required")
      );

      const second = await createMemory(
        memoryService,
        userId,
        "For work travel, I prefer quiet cities and avoid елки.",
        "nonce-english"
      );
      await expect(memoryService.search(userId, {
        query: "cities",
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({ memories: [{ id: second.response.memory.id }] });
      await expect(memoryService.search(userId, {
        query: "ЁЛКИ",
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({ memories: [{ id: second.response.memory.id }] });
      const firstPage = await memoryService.list(userId, {
        pageSize: 1,
        scope: { type: "GLOBAL_USER" },
        sourceMode: "EXPLICIT"
      });
      expect(firstPage.memories).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();
      await expect(memoryService.list(userId, {
        cursor: firstPage.nextCursor,
        pageSize: 1,
        scope: { type: "GLOBAL_USER" }
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_contract_invalid"));
      const secondPage = await memoryService.list(userId, {
        cursor: firstPage.nextCursor,
        pageSize: 1,
        scope: { type: "GLOBAL_USER" },
        sourceMode: "EXPLICIT"
      });
      expect(new Set([
        firstPage.memories[0]?.id,
        secondPage.memories[0]?.id
      ])).toEqual(new Set([factId, second.response.memory.id]));

      const evidence = await memoryService.evidence(userId, factId, null);
      expect(evidence).toMatchObject({
        evidence: [{
          factVersionId: versionId,
          safeExcerpt: russian,
          sourceChatId: null,
          sourceMessageId: null,
          sourceRole: null,
          sourceType: "EXPLICIT_ACTION"
        }],
        nextCursor: null
      });

      const secret = "API key: sk-abcdefghijklmnopqrstuvwxyz123456";
      const secretAuthorization = await saveAuthorization(
        memoryService,
        userId,
        secret,
        "nonce-secret"
      );
      await expect(memoryService.create(userId, {
        mutationAuthorizationId: secretAuthorization.mutationAuthorizationId,
        scope: { type: "GLOBAL_USER" },
        statement: secret
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_secret_rejected"));
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: secretAuthorization.mutationAuthorizationId }
      })).resolves.toMatchObject({ consumedAt: null });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(2);

      await prisma.$transaction([
        prisma.memoryFact.update({
          data: { currentVersionId: null, state: "RETRACTED" },
          where: { id: factId }
        }),
        prisma.memoryFactVersion.update({
          data: { state: "RETRACTED" },
          where: { id: versionId }
        })
      ]);
      await expect(memoryService.search(userId, {
        query: "Я ПРЕДПОЧИТАЮ ОТВЕТЫ О ЁЛКАХ НА РУССКОМ ЯЗЫКЕ.",
        state: "RETRACTED"
      })).resolves.toMatchObject({ memories: [{ id: factId }] });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("persists a hash-bound exact correction through Safety Lite and database guards", async () => {
    const userId = await createActiveUser("exact-correction-projection");
    const initialService = service();
    const exactStatement = "Use visual summaries for deployment reports.";
    let classifierCalls = 0;
    try {
      const created = await createMemory(
        initialService,
        userId,
        "Use text-only summaries for deployment reports.",
        "nonce-exact-correction-source"
      );
      const factId = created.response.memory.id;
      const expectedVersionId = created.response.memory.currentVersionId!;
      const exactStatementHash = memorySha256(exactStatement);
      const authorizedPayloadHash = memoryTargetAuthorizationPayloadHash({
        action: "EDIT",
        expectedTargetVersionId: expectedVersionId,
        replacementStatementHash: exactStatementHash,
        targetFactId: factId
      });
      const now = new Date();
      const authorization = await createPrismaMemoryMutationAuthorizationRepository(prisma)
        .mint(userId, {
          action: "EDIT",
          authorizedPayloadHash,
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedTargetVersionId: expectedVersionId,
          expiresAt: new Date(now.getTime() + 60_000),
          nonceHash: memoryMutationNonceHash(
            userId,
            `exact-correction:${randomUUID()}`
          ),
          requestId: randomUUID(),
          targetFactId: factId
        }, now);
      const chat = await prisma.chat.create({
        data: { title: "Exact correction", userId }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Apply the confirmed exact correction."),
          role: "user",
          status: "complete"
        }
      });
      const run = await prisma.modelRun.create({
        data: {
          chatId: chat.id,
          modelId: "exact-correction-test-model",
          normalizedRequest: {},
          provider: "exact-correction-test-provider",
          status: "complete",
          userId,
          userMessageId: userMessage.id
        }
      });
      const exactClassifier: MemoryStatementClassifier = {
        async classify() {
          classifierCalls += 1;
          throw new Error("safety_lite_must_not_invoke_legacy_classifier");
        }
      };
      const exactService = service(undefined, exactClassifier);

      const corrected = await exactService.update(userId, factId, {
        expectedVersionId,
        mutationAuthorizationId: authorization.id,
        statement: exactStatement
      }, {
        exactStatementHash,
        modelRunId: run.id,
        persistedToolCallId: null
      });

      expect(corrected.memory).toMatchObject({
        displayText: exactStatement,
        sourceMode: "EXPLICIT"
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: corrected.memory.currentVersionId! }
      })).resolves.toMatchObject({
        displayText: exactStatement,
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierProviderId: null
      });
      expect(classifierCalls).toBe(0);
      await expect(prisma.memoryEvidence.findFirstOrThrow({
        where: { factVersionId: corrected.memory.currentVersionId!, userId }
      })).resolves.toMatchObject({ safeExcerpt: exactStatement });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("keeps the legacy classifier dependency inert on the explicit new path", async () => {
    const userId = await createActiveUser("classifier-inert");
    let classifierCalls = 0;
    const classifier: MemoryStatementClassifier = Object.freeze({
      async classify() {
        classifierCalls += 1;
        throw new Error("safety_lite_must_not_invoke_legacy_classifier");
      }
    });
    const memoryService = service(undefined, classifier);
    const statement = "Keep deployment summaries concise.";
    try {
      const created = await createMemory(
        memoryService,
        userId,
        statement,
        "classifier-inert"
      );
      expect(created.response.memory).toMatchObject({
        displayText: statement,
        sourceMode: "EXPLICIT"
      });
      expect(classifierCalls).toBe(0);
      await expect(Promise.all([
        prisma.memoryExecutionBinding.count({ where: { userId } }),
        prisma.usageEvent.count({ where: { userId } })
      ])).resolves.toEqual([0, 0]);
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: created.response.memory.currentVersionId! }
      })).resolves.toMatchObject({
        safetyClassificationReasonCode: "lite_non_secret_default",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: null,
        safetyClassifierProviderId: null
      });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("appends edits, fences stale concurrent versions, and keeps one current lexical entry", async () => {
    const userId = await createActiveUser("edit-cas");
    const memoryService = service();
    try {
      const created = await createMemory(
        memoryService,
        userId,
        "My preferred editor is Emacs.",
        "nonce-editor"
      );
      const factId = created.response.memory.id;
      const originalVersionId = created.response.memory.currentVersionId!;
      const editAuthorization = await memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: originalVersionId,
        requestNonce: "nonce-edit-neovim",
        targetFactId: factId
      });
      const editInput = {
        expectedVersionId: originalVersionId,
        mutationAuthorizationId: editAuthorization.mutationAuthorizationId,
        pinned: true,
        statement: "My preferred editor is Neovim."
      } as const;
      const edited = await memoryService.update(userId, factId, editInput);
      expect(edited.memory).toMatchObject({
        displayText: "My preferred editor is Neovim.",
        pinned: true
      });
      const editedVersionId = edited.memory.currentVersionId!;
      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: { systemFrom: "asc" },
        where: { factId, userId }
      });
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({
        id: originalVersionId,
        state: "SUPERSEDED"
      });
      expect(versions[0]?.systemTo).not.toBeNull();
      expect(versions[1]).toMatchObject({ id: editedVersionId, state: "ACTIVE" });
      await expect(memoryService.update(userId, factId, editInput)).resolves.toEqual(edited);
      await expect(prisma.memoryFactVersion.count({ where: { factId, userId } }))
        .resolves.toBe(2);
      await expect(memoryService.update(userId, factId, {
        ...editInput,
        statement: "A changed replay must not apply."
      })).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_intent_confirmation_required")
      );
      await expect(prisma.memoryFactVersion.count({ where: { factId, userId } }))
        .resolves.toBe(2);
      await expect(memoryService.search(userId, { query: "Emacs" }))
        .resolves.toMatchObject({ memories: [] });
      await expect(memoryService.search(userId, { query: "Neovim" }))
        .resolves.toMatchObject({ memories: [{ id: factId }] });
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(1);

      await expect(memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: originalVersionId,
        requestNonce: "nonce-stale-edit",
        targetFactId: factId
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_version_stale"));

      const authorizationA = await memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: editedVersionId,
        requestNonce: "nonce-edit-a",
        targetFactId: factId
      });
      const authorizationB = await memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: editedVersionId,
        requestNonce: "nonce-edit-b",
        targetFactId: factId
      });
      const concurrent = await Promise.allSettled([
        memoryService.update(userId, factId, {
          expectedVersionId: editedVersionId,
          mutationAuthorizationId: authorizationA.mutationAuthorizationId,
          statement: "My preferred editor is Helix."
        }),
        memoryService.update(userId, factId, {
          expectedVersionId: editedVersionId,
          mutationAuthorizationId: authorizationB.mutationAuthorizationId,
          statement: "My preferred editor is Zed."
        })
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = concurrent.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" ? rejected.reason : null).toEqual(
        new ExplicitMemoryServiceError("memory_version_stale")
      );
      await expect(prisma.memoryFactVersion.count({ where: { factId, userId } }))
        .resolves.toBe(3);
      await expect(prisma.memoryFactVersion.count({
        where: { factId, state: "ACTIVE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(1);
      const evidence = await memoryService.evidence(userId, factId, null);
      expect(evidence.evidence).toHaveLength(3);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("keeps foreign targets indistinguishable and rejects expired grants without rows", async () => {
    const ownerUserId = await createActiveUser("owner");
    const foreignUserId = await createActiveUser("foreign");
    const currentService = service();
    try {
      const created = await createMemory(
        currentService,
        ownerUserId,
        "I prefer concise status reports.",
        "nonce-owner"
      );
      const factId = created.response.memory.id;
      const versionId = created.response.memory.currentVersionId!;
      await expect(currentService.get(foreignUserId, factId)).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_not_found")
      );
      await expect(currentService.mintAuthorization(foreignUserId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId,
        requestNonce: "nonce-foreign-target",
        targetFactId: factId
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_not_found"));
      await expect(currentService.search(foreignUserId, { query: "concise" }))
        .resolves.toEqual({ memories: [], nextCursor: null });

      const past = new Date(Date.now() - 10 * 60 * 1_000);
      const expiredService = service(() => past);
      const expiredStatement = "I prefer expired grants to fail closed.";
      const expiredAuthorization = await saveAuthorization(
        expiredService,
        foreignUserId,
        expiredStatement,
        "nonce-expired"
      );
      await expect(expiredService.create(foreignUserId, {
        mutationAuthorizationId: expiredAuthorization.mutationAuthorizationId,
        scope: { type: "GLOBAL_USER" },
        statement: expiredStatement
      })).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_intent_confirmation_required")
      );
      await expect(prisma.memoryFact.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryFact.count({ where: { userId: foreignUserId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryScope.count({ where: { userId: foreignUserId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: expiredAuthorization.mutationAuthorizationId }
      })).resolves.toMatchObject({ consumedAt: null });
    } finally {
      await cleanupUser(ownerUserId);
      await cleanupUser(foreignUserId);
    }
  });

  it("keeps matching legacy-scoped facts out of the authoritative summary projection", async () => {
    const userId = await createActiveUser("legacy-summary-fence");
    const memoryService = service();
    const readRepository = createPrismaExplicitMemoryRepository(prisma);
    try {
      const canonical = await createMemory(
        memoryService,
        userId,
        "Canonical global summary remains visible.",
        "nonce-canonical-summary"
      );
      const folder = await prisma.folder.create({
        data: { name: "Legacy summary folder", userId }
      });
      const legacyScope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: folder.id,
        type: "FOLDER"
      });
      const legacy = await createPrismaMemoryFactRepository(keyring, prisma, {
        consumeExplicitAuthorization: async () => undefined
      }).save(userId, legacyFactInput(
        legacyScope.id,
        "Matching legacy folder summary must remain dormant."
      ));

      await expect(readRepository.get(userId, legacy.factId)).resolves.toBeNull();
      await expect(readRepository.list(userId, {
        scope: { targetId: folder.id, type: "FOLDER" }
      })).resolves.toEqual({ memories: [], nextCursor: null });
      await expect(readRepository.search(userId, {
        query: "matching legacy folder summary",
        scope: { targetId: folder.id, type: "FOLDER" }
      })).resolves.toEqual({ memories: [], nextCursor: null });
      await expect(readRepository.list(userId, {
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({
        memories: [{ id: canonical.response.memory.id, scope: { type: "GLOBAL_USER" } }]
      });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("omits a pending legacy version while listing a classified active fact", async () => {
    const userId = await createActiveUser("pending-summary-fence");
    const memoryService = service();
    try {
      const classified = await createMemory(
        memoryService,
        userId,
        "Classified active summary remains available.",
        "nonce-classified-summary"
      );
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const factId = randomUUID();
      const versionId = randomUUID();
      const eventId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.memoryFact.create({
          data: {
            canonicalKey: `legacy.pending.${randomUUID()}`,
            category: "about_you",
            id: factId,
            scopeId: scope.id,
            state: "ORPHANED",
            userId
          }
        });
        await tx.memoryEvent.create({
          data: {
            actorType: "USER",
            actorUserId: userId,
            factId,
            factVersionId: versionId,
            id: eventId,
            operation: "EXPLICIT_SAVE",
            userId
          }
        });
        await tx.memoryFactVersion.create({
          data: {
            category: "about_you",
            confidence: 1,
            createdByEventId: eventId,
            directness: "DIRECT",
            displayText: "Pending legacy summary must not break the list.",
            factId,
            id: versionId,
            importance: 1,
            languageCode: "en",
            modality: "STATE",
            normalizedSearchText: "pending legacy summary must not break the list.",
            pipelineVersion: "legacy-memory-test-v1",
            safetyClassificationState: "PENDING",
            sensitivityClass: "NORMAL",
            sourceMode: "EXPLICIT",
            state: "ACTIVE",
            structuredValue: { statement: "Pending legacy summary must not break the list." },
            userId
          }
        });
        await tx.memoryFact.update({
          data: { currentVersionId: versionId, state: "ACTIVE" },
          where: { id: factId }
        });
      });

      const result = await createPrismaExplicitMemoryRepository(prisma).list(userId, {
        pageSize: 1,
        scope: { type: "GLOBAL_USER" },
        state: "ACTIVE"
      });
      expect(result.memories.map(({ id }) => id)).toEqual([
        classified.response.memory.id
      ]);
      expect(result.nextCursor).toBeNull();
    } finally {
      await cleanupUser(userId);
    }
  });
});
