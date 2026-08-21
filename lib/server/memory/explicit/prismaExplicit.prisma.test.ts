import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryCreateInput
} from "../../../contracts/memory";
import { prisma } from "../../prisma";
import { memoryExecutionSha256 } from "../execution/canonical";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
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
import {
  memoryStatementClassificationDecision,
  memoryStatementClassificationInputHash,
  type MemoryStatementClassification,
  type MemoryStatementClassifier
} from "./statementClassifier";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 33));
const keyring = MemorySuppressionKeyring.parse(
  `current=explicit-v1,explicit-v1=${keyBytes.toString("base64")}`
);

const classifierProvider = {
  connectionId: `explicit-classifier-connection-${randomUUID()}`,
  credentialId: `explicit-classifier-credential-${randomUUID()}`,
  credentialVersionId: `explicit-classifier-version-${randomUUID()}`,
  modelId: `explicit-classifier-model-${randomUUID()}`
};

const classifierModelConfiguration = {
  adapterKind: "openai_responses_native",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: true,
    structuredOutput: true,
    vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "explicit-classifier-test-model"
} as const;

async function createClassifierProvider(): Promise<void> {
  const now = new Date();
  const connection = {
    allowPrivateNetwork: false,
    apiRoot: "https://explicit-classifier.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 30_000
  };
  await prisma.providerConnection.create({
    data: {
      activeConfig: connection,
      activeVersion: 1,
      activatedAt: now,
      defaultCredentialId: null,
      displayName: "Explicit classifier test provider",
      draftConfig: connection,
      draftVersion: 1,
      enabled: true,
      family: "openai",
      id: classifierProvider.connectionId,
      unassignedPolicy: "use_default"
    }
  });
  await prisma.providerCredential.create({
    data: {
      activatedAt: now,
      connectionId: classifierProvider.connectionId,
      draftVersion: 1,
      enabled: true,
      id: classifierProvider.credentialId,
      label: "Explicit classifier credential",
      testedAt: now
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt: now,
      credentialId: classifierProvider.credentialId,
      id: classifierProvider.credentialVersionId,
      secretEnvelope: "explicit-classifier-test-only-envelope",
      testedAt: now,
      testEvidence: { authenticationMode: "bearer" },
      version: 1
    }
  });
  await prisma.providerCredential.update({
    data: { activeVersionId: classifierProvider.credentialVersionId },
    where: { id: classifierProvider.credentialId }
  });
  await prisma.providerConnection.update({
    data: { defaultCredentialId: classifierProvider.credentialId },
    where: { id: classifierProvider.connectionId }
  });
  await prisma.providerModel.create({
    data: {
      activeConfig: classifierModelConfiguration,
      activeVersion: 1,
      activatedAt: now,
      capabilities: classifierModelConfiguration.capabilities,
      connectionId: classifierProvider.connectionId,
      defaultParams: {},
      displayName: "Explicit classifier test model",
      draftConfig: classifierModelConfiguration,
      draftVersion: 1,
      enabled: true,
      id: classifierProvider.modelId,
      modelClass: "answer",
      modelId: classifierModelConfiguration.upstreamModelId,
      provider: "openai"
    }
  });
}

async function cleanupClassifierProvider(): Promise<void> {
  await prisma.providerConnection.updateMany({
    data: { defaultCredentialId: null },
    where: { id: classifierProvider.connectionId }
  });
  await prisma.providerCredential.updateMany({
    data: { activeVersionId: null },
    where: { id: classifierProvider.credentialId }
  });
  await prisma.providerModel.deleteMany({ where: { id: classifierProvider.modelId } });
  await prisma.providerCredentialVersion.deleteMany({
    where: { id: classifierProvider.credentialVersionId }
  });
  await prisma.providerCredential.deleteMany({
    where: { id: classifierProvider.credentialId }
  });
  await prisma.providerConnection.deleteMany({
    where: { id: classifierProvider.connectionId }
  });
}

type ManualStatementClassification = MemoryStatementClassification & Readonly<{
  acceptedOutputHash: string;
  classifiedAt: Date;
  executionId: string;
  inputHash: string;
  modelId: string;
  policyVersion: string;
  providerId: string;
}>;

async function createStatementClassificationReceipt(
  statement: string,
  execution: Readonly<{
    mutationAuthorizationId: string;
    userId: string;
  }>
): Promise<ManualStatementClassification> {
  const executionId = randomUUID();
  const inputHash = memoryStatementClassificationInputHash(statement);
  const decision = {
    category: "preferences" as const,
    normalizedStatement: statement,
    reasonCode: "response_preference" as const,
    responsePreference: true,
    sensitivity: "NORMAL" as const,
    storageDecision: "ALLOW" as const
  };
  const acceptedOutputHash = memoryExecutionSha256({
    inputHash,
    output: decision,
    role: "MEMORY_STATEMENT_CLASSIFY",
    version: 1
  });
  const startedAt = new Date();
  const completedAt = new Date(startedAt.getTime() + 1);
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash,
      cachedInputTokens: 0,
      completedAt,
      connectionId: classifierProvider.connectionId,
      createdAt: startedAt,
      credentialId: classifierProvider.credentialId,
      credentialVersionId: classifierProvider.credentialVersionId,
      destinationFingerprint: "b".repeat(64),
      id: executionId,
      inputHash,
      inputTokens: 5,
      logicalRole: "MEMORY_STATEMENT_CLASSIFY",
      mutationAuthorizationId: execution.mutationAuthorizationId,
      ordinal: 0,
      outputTokens: 2,
      ownerType: "MUTATION_AUTHORIZATION",
      pipelineVersion: "memory-statement-classification-v1",
      policyVersion: "memory-statement-safety-policy-v1",
      promptVersion: "memory-statement-classification-prompt-v1",
      providerId: "openai",
      providerModelId: classifierProvider.modelId,
      providerResponseId: `explicit-classifier-response-${randomUUID()}`,
      reasoningTokens: 0,
      recoverableUntil: new Date(completedAt.getTime() + 24 * 60 * 60 * 1_000),
      schemaVersion: "memory-statement-classification-schema-v1",
      secretFreeExecutionSnapshot: {
        providerExecutionSnapshot: {
          providerFamily: "openai",
          providerModelId: classifierProvider.modelId
        },
        version: 1
      },
      startedAt,
      state: "SUCCEEDED",
      totalTokens: 7,
      usageCompleteness: "COMPLETE",
      userId: execution.userId
    }
  });
  await prisma.usageEvent.create({
    data: {
      cachedInputTokens: 0,
      inputTokens: 5,
      memoryExecutionBindingId: executionId,
      modelId: classifierProvider.modelId,
      outputTokens: 2,
      provider: "openai",
      providerModelId: classifierProvider.modelId,
      reasoningTokens: 0,
      totalTokens: 7,
      userId: execution.userId
    }
  });
  return {
    acceptedOutputHash,
    classifiedAt: completedAt,
    ...decision,
    executionId,
    inputHash,
    modelId: classifierProvider.modelId,
    policyVersion: "memory-statement-safety-policy-v1",
    providerId: "openai"
  };
}

const statementClassifier: MemoryStatementClassifier = Object.freeze({
  async classify(statement, options) {
    const execution = options?.execution;
    if (!execution) throw new Error("explicit_classifier_execution_missing");
    return createStatementClassificationReceipt(statement, execution);
  }
});

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
  classifier: MemoryStatementClassifier = statementClassifier
) {
  return createExplicitMemoryService({
    authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
    clock,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository: createPrismaExplicitMemoryRepository(prisma),
    scopeRepository: createPrismaMemoryScopeRepository(prisma),
    statementClassifier: classifier
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
  beforeAll(async () => {
    await createClassifierProvider();
  });

  afterAll(async () => {
    await cleanupClassifierProvider();
    await prisma.$disconnect();
  });

  it("commits exact Russian text and classifier provenance without a worker or network provider", async () => {
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
      const classifierBinding = await prisma.memoryExecutionBinding.findFirstOrThrow({
        where: { userId }
      });
      expect(classifierBinding).toMatchObject({
        credentialId: classifierProvider.credentialId,
        credentialVersionId: classifierProvider.credentialVersionId,
        logicalRole: "MEMORY_STATEMENT_CLASSIFY",
        ownerType: "MUTATION_AUTHORIZATION",
        providerId: "openai",
        providerModelId: classifierProvider.modelId,
        state: "SUCCEEDED",
        usageCompleteness: "COMPLETE"
      });
      expect(classifierBinding.providerResponseId).toMatch(
        /^explicit-classifier-response-/
      );
      await expect(prisma.usageEvent.findUniqueOrThrow({
        where: { memoryExecutionBindingId: classifierBinding.id }
      })).resolves.toMatchObject({
        inputTokens: 5,
        outputTokens: 2,
        providerModelId: classifierProvider.modelId,
        totalTokens: 7,
        userId
      });
      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: versionId }
      })).resolves.toMatchObject({
        safetyClassificationReasonCode: "response_preference",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: classifierBinding.id,
        safetyClassifierModelId: classifierProvider.modelId,
        safetyClassifierPolicyVersion: "memory-statement-safety-policy-v1",
        safetyClassifierProviderId: "openai"
      });
      await expect(prisma.memoryJob.findMany({
        select: { kind: true, state: true },
        where: { userId }
      })).resolves.toEqual([]);

      const replay = await memoryService.create(userId, created.input);
      expect(replay.memory).toMatchObject({ id: factId, currentVersionId: versionId });
      await expect(prisma.memoryExecutionBinding.count({ where: { userId } }))
        .resolves.toBe(1);
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

  it("rejects valid statement-classifier receipts swapped across input, decision, output, or binding", async () => {
    const userId = await createActiveUser("classifier-receipt-swap");
    const setupService = service();
    const swaps = ["input", "decision", "output", "binding"] as const;
    const attempts = new Map<string, Readonly<{
      authorizationId: string;
      classification: MemoryStatementClassification;
    }>>();
    const authorizationIds: string[] = [];
    try {
      await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      for (const swap of swaps) {
        const targetStatement = `Classifier ${swap} receipt target must not persist.`;
        const donorStatement = `Classifier ${swap} receipt donor must stay detached.`;
        const targetAuthorization = await saveAuthorization(
          setupService,
          userId,
          targetStatement,
          `classifier-swap-target-${swap}`
        );
        const donorAuthorization = await saveAuthorization(
          setupService,
          userId,
          donorStatement,
          `classifier-swap-donor-${swap}`
        );
        authorizationIds.push(
          targetAuthorization.mutationAuthorizationId,
          donorAuthorization.mutationAuthorizationId
        );
        const target = await createStatementClassificationReceipt(targetStatement, {
          mutationAuthorizationId: targetAuthorization.mutationAuthorizationId,
          userId
        });
        const donor = await createStatementClassificationReceipt(donorStatement, {
          mutationAuthorizationId: donorAuthorization.mutationAuthorizationId,
          userId
        });
        const classification = swap === "input"
          ? { ...target, inputHash: donor.inputHash }
          : swap === "decision"
            ? { ...target, ...memoryStatementClassificationDecision(donor) }
            : swap === "output"
              ? { ...target, acceptedOutputHash: donor.acceptedOutputHash }
              : { ...target, executionId: donor.executionId };
        attempts.set(targetStatement, {
          authorizationId: targetAuthorization.mutationAuthorizationId,
          classification
        });
      }
      const baselineSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      const swappedClassifier: MemoryStatementClassifier = Object.freeze({
        async classify(statement, options) {
          const attempt = attempts.get(statement);
          const execution = options?.execution;
          if (!attempt || !execution || execution.mutationAuthorizationId !==
            attempt.authorizationId || execution.userId !== userId) {
            throw new Error("explicit_classifier_swap_fixture_invalid");
          }
          return attempt.classification;
        }
      });
      const memoryService = service(undefined, swappedClassifier);

      for (const [statement, attempt] of attempts) {
        await expect(memoryService.create(userId, {
          mutationAuthorizationId: attempt.authorizationId,
          scope: { type: "GLOBAL_USER" },
          statement
        })).rejects.toEqual(new ExplicitMemoryServiceError("memory_contract_invalid"));
      }

      const [settings, authorizations] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryMutationAuthorization.findMany({
          orderBy: { id: "asc" },
          where: { id: { in: authorizationIds }, userId }
        })
      ]);
      expect(settings).toMatchObject({
        memoryGeneration: baselineSettings.memoryGeneration,
        memoryRevision: baselineSettings.memoryRevision,
        settingsRevision: baselineSettings.settingsRevision
      });
      expect(authorizations).toHaveLength(authorizationIds.length);
      expect(authorizations.every(({ consumedAt }) => consumedAt === null)).toBe(true);
      await expect(Promise.all([
        prisma.memoryFact.count({ where: { userId } }),
        prisma.memoryFactVersion.count({ where: { userId } }),
        prisma.memoryEvidence.count({ where: { userId } }),
        prisma.memoryEvent.count({ where: { userId } }),
        prisma.memoryOperationReceipt.count({ where: { userId } }),
        prisma.memorySearchEntry.count({ where: { userId } }),
        prisma.memoryJob.count({ where: { userId } }),
        prisma.memoryScope.count({ where: { userId } })
      ])).resolves.toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
      await expect(prisma.memoryExecutionBinding.count({ where: { userId } }))
        .resolves.toBe(swaps.length * 2);
      await expect(prisma.usageEvent.count({ where: { userId } }))
        .resolves.toBe(swaps.length * 2);
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
