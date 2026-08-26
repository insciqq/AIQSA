import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
} from "../../../contracts/memory";
import {
  decodeMemoryActionIntent,
  type MemoryActionIntent
} from "../../../contracts/memoryActionIntent";
import { textMessageContent } from "../../../domain/content";
import { MEMORY_DECAY_POLICY_VERSION } from "../../../domain/memory/retrieval";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  resolveCurrentMemoryUtilityPolicy,
  type ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import { createMemorySettingsService } from "../settings/service";
import { memoryActionLifecycleBudgetSnapshot } from "../actions/lifecycleSnapshot";
import {
  memoryControlAcceptedOutputHash,
  memoryControlIntentHash
} from "../actions/controlRuntime";
import {
  memoryTargetCandidateMapHash,
  memoryTargetSelectionAcceptedOutputHash
} from "../actions/targetSelector";
import { scheduleTemporaryChatDeletion } from "../temporaryRetention";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { MemoryPersistenceError } from "./errors";
import { memorySha256 } from "./lexical";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactSaveInput,
  type MemoryFactValueInput
} from "./facts";
import { createPrismaMemoryScopeRepository } from "./scopes";
import { createPrismaMemorySettingsRepository } from "./settings";
import {
  createPrismaMemoryDeletionRepository,
  createPrismaMemoryJobRepository,
  createPrismaMemorySuppressionRepository
} from "@/tests/support/memoryPersistence";
import {
  consumeMemoryMutationAuthorization,
  createPrismaMemoryMutationAuthorizationRepository,
  memoryMutationNonceHash,
  memoryTargetAuthorizationPayloadHash
} from "./authorizations";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const suppressionKeyring = MemorySuppressionKeyring.parse(
  `current=test-v1,test-v1=${keyBytes.toString("base64")}`
);

function createTestMemoryFactRepository() {
  return createPrismaMemoryFactRepository(suppressionKeyring, prisma, {
    consumeExplicitAuthorization: async () => undefined
  });
}

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Memory ${label}`,
      email: `memory-${label}-${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function cleanupUser(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

function factValue(
  canonicalKey: string,
  displayText: string,
  structuredValue: string
): MemoryFactValueInput {
  return {
    canonicalKey,
    category: "profile",
    confidence: 1,
    directness: "DIRECT",
    displayText,
    importance: 0.8,
    languageCode: "en",
    modality: "STATE",
    pipelineVersion: "memory-persistence-test-v1",
    secretTaintedSourceWindow: false,
    sensitivityClass: "NORMAL",
    sourceMode: "EXPLICIT",
    structuredValue: { value: structuredValue }
  };
}

function saveInput(
  scopeId: string,
  idempotencyFingerprint: string,
  value: MemoryFactValueInput
): MemoryFactSaveInput {
  return {
    authorization: {
      action: "SAVE",
      authorizationId: `authorization-${idempotencyFingerprint}`,
      authorizedPayloadHash: "f".repeat(64)
    },
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: new Date("2026-08-10T10:00:00.000Z"),
      safeExcerpt: value.displayText,
      safeSourceHash: "a".repeat(64),
      safetyClass: value.sensitivityClass,
      sourceProjectionVersion: "memory-test-projection-v1"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint,
    requestId: `request-${idempotencyFingerprint}`,
    scopeId,
    value
  };
}

function controlExecutionSnapshot(input: Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  providerModelId: string;
}>) {
  return {
    acceptedUtilityEgressFingerprint: "1".repeat(64),
    compatibilityId: "memory-control-test-v2",
    compatibilityRequirement: {
      compatibilityVersion: "memory-runtime-compatibility-v2",
      configFingerprint: "2".repeat(64),
      deploymentFingerprint: "3".repeat(64),
      modelFingerprint: "4".repeat(64),
      pipelineVersion: "memory-control-v2",
      policyVersion: "memory-control-policy-v1",
      promptVersion: "memory-control-prompt-v1",
      providerFingerprint: "5".repeat(64),
      retrievalConfigFingerprint: "6".repeat(64),
      role: "MEMORY_CONTROL",
      schemaVersion: "memory-action-intent-v1",
      vectorSpaceFingerprint: null
    },
    credentialSource: "default",
    destinationFingerprint: "7".repeat(64),
    executionTargetFingerprint: "8".repeat(64),
    logicalRole: "MEMORY_CONTROL",
    policyRevision: null,
    providerExecutionSnapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://memory-control.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: "Memory control race provider",
      connectionId: input.connectionId,
      credentialId: input.credentialId,
      credentialVersionId: input.credentialVersionId,
      model: {
        adapterKind: "openai_responses_native",
        answerSelectable: true,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          structuredOutput: true,
          toolCalling: true,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "memory-control-race-model"
      },
      modelDisplayName: "Memory control race model",
      providerFamily: "openai",
      providerModelId: input.providerModelId,
      version: 1
    },
    requiresStrictStructuredOutput: true,
    utilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
    version: 2
  } as const;
}

async function createControlAuthorizedSave(
  userId: string,
  label: string,
  options: Readonly<{
    controlIntent?: MemoryActionIntent;
    mutation?: Readonly<{
      action: "EDIT" | "FORGET" | "SAVE";
      authorizedPayloadHash: string;
      expectedTargetVersionId?: string;
      targetFactId?: string;
    }>;
  }> = {}
) {
  const providerSuffix = randomUUID();
  const connectionId = `memory-control-connection-${providerSuffix}`;
  const credentialId = `memory-control-credential-${providerSuffix}`;
  const credentialVersionId = `memory-control-version-${providerSuffix}`;
  const providerModelId = `memory-control-model-${providerSuffix}`;
  const activatedAt = new Date("2026-08-21T06:00:00.000Z");
  const connectionConfig = {
    allowPrivateNetwork: false,
    apiRoot: "https://memory-control.example.test/v1",
    authenticationMode: "bearer",
    responseTimeoutMs: 30_000
  };
  await prisma.providerConnection.create({
    data: {
      activeConfig: connectionConfig,
      activeVersion: 1,
      activatedAt,
      displayName: "Memory control race provider",
      draftConfig: connectionConfig,
      draftVersion: 1,
      enabled: true,
      family: "openai_compatible",
      id: connectionId,
      unassignedPolicy: "use_default"
    }
  });
  await prisma.providerCredential.create({
    data: {
      activatedAt,
      connectionId,
      draftVersion: 1,
      enabled: true,
      id: credentialId,
      label: "Memory control race credential",
      testedAt: activatedAt
    }
  });
  await prisma.providerCredentialVersion.create({
    data: {
      activatedAt,
      credentialId,
      id: credentialVersionId,
      secretEnvelope: "test-only-envelope",
      testedAt: activatedAt,
      testEvidence: { authenticationMode: "bearer" },
      version: 1
    }
  });
  await prisma.providerCredential.update({
    data: { activeVersionId: credentialVersionId },
    where: { id: credentialId }
  });
  await prisma.providerConnection.update({
    data: { defaultCredentialId: credentialId },
    where: { id: connectionId }
  });
  await prisma.providerModel.create({
    data: {
      activeConfig: {},
      activeVersion: 1,
      activatedAt,
      capabilities: {},
      connectionId,
      defaultParams: {},
      displayName: "Memory control race model",
      draftConfig: {},
      draftVersion: 1,
      enabled: true,
      id: providerModelId,
      modelClass: "answer",
      modelId: "memory-control-race-model",
      provider: "openai_compatible"
    }
  });
  const sourceText = `Remember my ${label} preference.`;
  const statement = "I prefer concise answers.";
  const defaultControlIntent = {
    action: "SAVE",
    applyResponsePreferences: false,
    category: "preferences",
    categoryHint: null,
    confidenceBand: "HIGH",
    entityMentions: [] as MemoryActionIntent["entityMentions"],
    includePatterns: false,
    memoryUseful: false,
    pastChatsUseful: false,
    profileRequested: false,
    queryText: null,
    reasonCode: "save_request",
    recencyRequested: false,
    retrievalMode: "TARGETED_CURRENT",
    referencedMemoryRef: null,
    replacementStatement: null,
    responsePreference: true,
    sensitiveDomainHint: null,
    sensitivity: "NORMAL",
    statement,
    targetQuery: null,
    temporalAsOf: null,
    temporalFrom: null,
    temporalIntent: "CURRENT",
    temporalTo: null,
    thisChatOnly: false
  } as const;
  const controlIntent = options.controlIntent ?? defaultControlIntent;
  const executionSnapshot = controlExecutionSnapshot({
    connectionId,
    credentialId,
    credentialVersionId,
    providerModelId
  });
  const chat = await prisma.chat.create({
    data: { title: `Control ${label}`, userId }
  });
  if (label === "temporary") {
    const now = new Date();
    const deadline = new Date(now.getTime() + 60_000);
    await prisma.$transaction(async (tx) => {
      await tx.chat.update({
        data: {
          memoryMode: "TEMPORARY",
          temporaryRetentionDeadline: deadline,
          temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
        },
        where: { id: chat.id }
      });
      await scheduleTemporaryChatDeletion(tx, {
        chatId: chat.id,
        deadline,
        now,
        userId
      });
    });
  }
  const userMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(sourceText),
      role: "user",
      status: "complete"
    }
  });
  const assistantMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(""),
      parentMessageId: userMessage.id,
      role: "assistant",
      status: "streaming"
    }
  });
  const admittedChat = await prisma.chat.update({
    data: { activeLeafMessageId: assistantMessage.id },
    where: { id: chat.id }
  });
  const settings = await prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } });
  const { binding, run } = await prisma.$transaction(async (tx) => {
    const run = await tx.modelRun.create({
      data: {
        assistantMessageId: assistantMessage.id,
        chatId: chat.id,
        modelId: "memory-control-race-model",
        provider: "memory-control-race-provider",
        status: "preparing",
        userId,
        userMessageId: userMessage.id
      }
    });
    const attempt = await tx.memoryRetrievalAttempt.create({
      data: {
        admissionKind: "NORMAL_SEND",
        admittedAssistantLeafMessageId: assistantMessage.id,
        admittedUserMessageId: userMessage.id,
        attemptOrdinal: 0,
        baseRequestHash: "b".repeat(64),
        boundedPrivateBaseRequestSnapshot: {},
        budgetSnapshot: memoryActionLifecycleBudgetSnapshot({
          activeLeafMessageId: assistantMessage.id,
          branchGeneration: admittedChat.memoryBranchGeneration,
          sourceRevision: admittedChat.memorySourceRevision
        }),
        chatId: chat.id,
        chatMemoryModeSnapshot: "NORMAL",
        expiresAt: new Date(Date.now() + 60_000),
        memoryGenerationSnapshot: settings.memoryGeneration,
        modelRunId: run.id,
        queryHash: "c".repeat(64),
        retrievalRevisionSnapshot: settings.memoryRevision,
        settingsSnapshot: {},
        state: "EXECUTING",
        userId,
        utilityEgressMode: "LOCAL_ONLY"
      }
    });
    const executionAt = new Date();
    const binding = await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memoryControlAcceptedOutputHash(
          "f".repeat(64),
          memoryControlIntentHash(controlIntent)
        ),
        completedAt: executionAt,
        connectionId,
        createdAt: executionAt,
        credentialId,
        credentialVersionId,
        destinationFingerprint: "e".repeat(64),
        inputHash: "f".repeat(64),
        logicalRole: "MEMORY_CONTROL",
        ordinal: 0,
        ownerType: "RETRIEVAL_ATTEMPT",
        pipelineVersion: "memory-control-race-v1",
        policyVersion: "memory-control-race-v1",
        promptVersion: "memory-control-race-v1",
        providerId: "openai_compatible",
        providerModelId,
        retrievalAttemptId: attempt.id,
        schemaVersion: "memory-control-race-v1",
        secretFreeExecutionSnapshot: executionSnapshot,
        startedAt: executionAt,
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.usageEvent.create({
      data: {
        cachedInputTokens: 0,
        inputTokens: 1,
        memoryExecutionBindingId: binding.id,
        modelId: providerModelId,
        outputTokens: 1,
        provider: "openai_compatible",
        providerModelId,
        reasoningTokens: 0,
        totalTokens: 2,
        userId
      }
    });
    return { binding, run };
  });
  const mutation = options.mutation ?? {
    action: "SAVE" as const,
    authorizedPayloadHash: memorySha256(statement)
  };
  const authorizedPayloadHash = mutation.authorizedPayloadHash;
  const authorization = await createPrismaMemoryMutationAuthorizationRepository(prisma)
    .mintForControl(userId, {
      action: mutation.action,
      admissionDeadlineAtMs: Date.now() + 4_000,
      authorizedPayloadHash,
      bindingId: binding.id,
      chatId: chat.id,
      controlIntent,
      modelRunId: run.id,
      sourceText,
      expectedTargetVersionId: mutation.expectedTargetVersionId,
      targetFactId: mutation.targetFactId
    });
  return {
    authorization,
    authorizedPayloadHash,
    binding,
    chat,
    controlIntent,
    executionSnapshot,
    run,
    sourceText,
    settings,
    async cleanupProvider() {
      await prisma.providerConnection.updateMany({
        data: { defaultCredentialId: null },
        where: { id: connectionId }
      });
      await prisma.providerCredential.updateMany({
        data: { activeVersionId: null },
        where: { id: credentialId }
      });
      await prisma.providerModel.deleteMany({ where: { id: providerModelId } });
      await prisma.providerCredentialVersion.deleteMany({ where: { credentialId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
  };
}

function expectRejectedCode(
  result: PromiseSettledResult<unknown>,
  code: MemoryPersistenceError["code"]
): void {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  expect(result.reason).toBeInstanceOf(MemoryPersistenceError);
  expect((result.reason as MemoryPersistenceError).code).toBe(code);
}

describe("Prisma Memory persistence", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("serializes settings CAS and bootstraps one settled lexical generation", async () => {
    const userId = await createActiveUser("settings-cas");
    const repository = createPrismaMemorySettingsRepository(prisma);
    try {
      const results = await Promise.allSettled([
        repository.patch(userId, {
          expectedMemoryRevision: 0,
          expectedSettingsRevision: 0,
          useMemoryFacts: false
        }),
        repository.patch(userId, {
          expectedMemoryRevision: 0,
          expectedSettingsRevision: 0,
          referenceChatHistory: false
        })
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expectRejectedCode(rejected[0]!, "memory_settings_conflict");

      const [settings, generations] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryIndexGeneration.findMany({ where: { userId } })
      ]);
      const winner = fulfilled[0]?.status === "fulfilled"
        ? fulfilled[0].value as { useMemoryFacts: boolean }
        : null;
      expect(settings).toMatchObject({
        memoryRevision: 1,
        settingsRevision: 1
      });
      expect(settings.memoryGeneration).toBe(winner?.useMemoryFacts === false ? 1 : 0);
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        id: settings.activeIndexGenerationId,
        indexMode: "LEXICAL_ONLY",
        indexedThroughMemoryRevision: 1,
        state: "ACTIVE",
        targetMemoryRevision: 1
      });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("persists reversible versioned decay opt-in without resetting its policy", async () => {
    const userId = await createActiveUser("settings-decay");
    const repository = createPrismaMemorySettingsRepository(prisma);
    try {
      await expect(repository.get(userId)).resolves.toMatchObject({
        decayEnabled: false,
        decayPolicyVersion: null,
        memoryRevision: 0,
        settingsRevision: 0
      });
      const enabled = await repository.patch(userId, {
        decayEnabled: true,
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0
      });
      expect(enabled).toMatchObject({
        decayEnabled: true,
        decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION,
        memoryRevision: 1,
        settingsRevision: 1
      });
      const disabled = await repository.patch(userId, {
        decayEnabled: false,
        expectedMemoryRevision: enabled.memoryRevision,
        expectedSettingsRevision: enabled.settingsRevision
      });
      expect(disabled).toMatchObject({
        decayEnabled: false,
        decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION,
        memoryRevision: 2,
        settingsRevision: 2
      });
      const reenabled = await repository.patch(userId, {
        decayEnabled: true,
        expectedMemoryRevision: disabled.memoryRevision,
        expectedSettingsRevision: disabled.settingsRevision
      });
      expect(reenabled).toMatchObject({
        decayEnabled: true,
        decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION,
        memoryRevision: 3,
        settingsRevision: 3
      });
      await expect(prisma.userMemorySettings.update({
        data: { decayPolicyVersion: null },
        where: { userId }
      })).rejects.toThrow(/UserMemorySettings_decay_shape_check/u);
      await expect(repository.patch(userId, {
        decayEnabled: true,
        expectedMemoryRevision: reenabled.memoryRevision,
        expectedSettingsRevision: reenabled.settingsRevision
      })).resolves.toMatchObject({
        decayEnabled: true,
        decayPolicyVersion: MEMORY_DECAY_POLICY_VERSION,
        memoryRevision: reenabled.memoryRevision,
        settingsRevision: reenabled.settingsRevision + 1
      });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("pauses all personal work without changing subordinate preferences or backfilling on resume", async () => {
    const userId = await createActiveUser("master-pause");
    const pausedAt = new Date("2026-08-21T10:00:00.000Z");
    const resumedAt = new Date("2026-08-21T10:10:00.000Z");
    let currentTime = pausedAt;
    const repository = createPrismaMemorySettingsRepository(prisma, {
      now: () => currentTime
    });
    try {
      const queued = await prisma.memoryJob.create({
        data: {
          idempotencyFingerprint: `master-pause-${randomUUID()}`,
          kind: "REBUILD_INDEX",
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "master-pause-test-v1",
          state: "QUEUED",
          userId
        }
      });

      const paused = await repository.patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        useMemoryFacts: false
      });
      expect(paused).toMatchObject({
        learnAutomatically: true,
        memoryGeneration: 1,
        memoryRevision: 1,
        referenceChatHistory: true,
        settingsRevision: 1,
        useMemoryFacts: false
      });
      await expect(prisma.memoryPauseInterval.findFirstOrThrow({
        where: { scope: "MASTER", userId }
      })).resolves.toMatchObject({
        memoryGeneration: 1,
        pausedAt,
        resumedAt: null
      });
      await expect(prisma.memorySourceBarrier.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryJob.findUniqueOrThrow({ where: { id: queued.id } }))
        .resolves.toMatchObject({
          errorCode: "memory_master_paused",
          state: "CANCELLED"
        });

      currentTime = resumedAt;
      const resumed = await repository.patch(userId, {
        expectedMemoryRevision: paused.memoryRevision,
        expectedSettingsRevision: paused.settingsRevision,
        useMemoryFacts: true
      });
      expect(resumed).toMatchObject({
        learnAutomatically: true,
        memoryGeneration: paused.memoryGeneration,
        memoryRevision: paused.memoryRevision + 1,
        referenceChatHistory: true,
        settingsRevision: paused.settingsRevision + 1,
        useMemoryFacts: true
      });
      await expect(prisma.memoryPauseInterval.findFirstOrThrow({
        where: { scope: "MASTER", userId }
      })).resolves.toMatchObject({ pausedAt, resumedAt });
      await expect(prisma.memorySourceBarrier.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("opens independent Search and Learn intervals and cancels only affected delayed work", async () => {
    const userId = await createActiveUser("subordinate-pauses");
    const pausedAt = new Date("2026-08-21T11:00:00.000Z");
    const resumedAt = new Date("2026-08-21T11:10:00.000Z");
    let currentTime = pausedAt;
    const repository = createPrismaMemorySettingsRepository(prisma, {
      now: () => currentTime
    });
    try {
      const jobs = await Promise.all(([
        "INDEX_HISTORY",
        "EXTRACT_FACTS",
        "CONSOLIDATE_CANDIDATE",
        "VERIFY_CANDIDATE",
        "REBUILD_INDEX"
      ] as const).map((kind) => prisma.memoryJob.create({
        data: {
          idempotencyFingerprint: `subordinate-pause-${kind}-${randomUUID()}`,
          kind,
          memoryGenerationSnapshot: 0,
          memoryRevisionSnapshot: 0,
          pipelineVersion: "subordinate-pause-test-v1",
          state: "QUEUED",
          userId
        }
      })));

      const paused = await repository.patch(userId, {
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0,
        learnAutomatically: false,
        referenceChatHistory: false
      });
      expect(paused).toMatchObject({
        learnAutomatically: false,
        referenceChatHistory: false,
        useMemoryFacts: true
      });
      const intervals = await prisma.memoryPauseInterval.findMany({ where: { userId } });
      expect(intervals).toHaveLength(2);
      expect(intervals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          pausedAt,
          resumedAt: null,
          scope: "AUTOMATIC_LEARNING"
        }),
        expect.objectContaining({
          pausedAt,
          resumedAt: null,
          scope: "SEARCH_HISTORY"
        })
      ]));
      const pausedJobs = await prisma.memoryJob.findMany({
        orderBy: { kind: "asc" },
        select: { kind: true, state: true },
        where: { id: { in: jobs.map(({ id }) => id) } }
      });
      expect(pausedJobs).toHaveLength(5);
      expect(pausedJobs).toEqual(expect.arrayContaining([
        { kind: "CONSOLIDATE_CANDIDATE", state: "CANCELLED" },
        { kind: "EXTRACT_FACTS", state: "CANCELLED" },
        { kind: "INDEX_HISTORY", state: "CANCELLED" },
        { kind: "REBUILD_INDEX", state: "QUEUED" },
        { kind: "VERIFY_CANDIDATE", state: "CANCELLED" }
      ]));

      currentTime = resumedAt;
      await repository.patch(userId, {
        expectedMemoryRevision: paused.memoryRevision,
        expectedSettingsRevision: paused.settingsRevision,
        learnAutomatically: true,
        referenceChatHistory: true
      });
      await expect(prisma.memoryPauseInterval.findMany({ where: { userId } }))
        .resolves.toSatisfy((intervals: Array<{ resumedAt: Date | null }>) =>
          intervals.length === 2 && intervals.every((interval) =>
            interval.resumedAt?.getTime() === resumedAt.getTime()));
      await expect(prisma.memorySourceBarrier.count({ where: { userId } }))
        .resolves.toBe(0);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("consumes an authorization monotonically across a backwards wall-clock step", async () => {
    const userId = await createActiveUser("authorization-clock");
    const createdAt = new Date("2026-08-10T10:00:00.500Z");
    const rolledBackAt = new Date("2026-08-10T09:59:59.900Z");
    const requestId = `memory-clock-${randomUUID()}`;
    const authorizedPayloadHash = "c".repeat(64);
    try {
      const authorization = await createPrismaMemoryMutationAuthorizationRepository(
        prisma
      ).mint(userId, {
        action: "SAVE",
        authorizedPayloadHash,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expiresAt: new Date(createdAt.getTime() + 60_000),
        nonceHash: memoryMutationNonceHash(userId, requestId),
        requestId
      }, createdAt);

      await prisma.$transaction((tx) => consumeMemoryMutationAuthorization(
        tx,
        userId,
        {
          action: "SAVE",
          authorizationId: authorization.id,
          authorizedPayloadHash,
          requestId
        },
        rolledBackAt
      ));

      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: authorization.id }
      })).resolves.toMatchObject({ consumedAt: createdAt, createdAt });
    } finally {
      await cleanupUser(userId);
    }
  });

  it.each([
    ["master pause", "PAUSED"],
    ["Normal to Temporary", "TEMPORARY"],
    ["Normal to Excluded", "EXCLUDED"]
  ] as const)("rejects a control-backed save after %s before commit", async (_label, race) => {
    const userId = await createActiveUser(`control-race-${race.toLowerCase()}`);
    let cleanupProvider: (() => Promise<void>) | undefined;
    try {
      const admitted = await createControlAuthorizedSave(userId, race.toLowerCase());
      cleanupProvider = admitted.cleanupProvider;
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      if (race === "PAUSED") {
        await createPrismaMemorySettingsRepository(prisma).patch(userId, {
          expectedMemoryRevision: admitted.settings.memoryRevision,
          expectedSettingsRevision: admitted.settings.settingsRevision,
          useMemoryFacts: false
        });
      } else if (race !== "TEMPORARY") {
        await prisma.chat.update({
          data: { memoryMode: race },
          where: { id: admitted.chat.id }
        });
      }

      const before = await Promise.all([
        prisma.memoryFact.count({ where: { userId } }),
        prisma.memoryFactVersion.count({ where: { userId } })
      ]);
      const value = factValue(
        `control.race.${race.toLowerCase()}`,
        "I prefer concise answers.",
        "concise"
      );
      await expect(createPrismaMemoryFactRepository(suppressionKeyring, prisma).save(userId, {
        ...saveInput(scope.id, `control-race-${race}-${randomUUID()}`, value),
        authorization: {
          action: "SAVE",
          authorizationId: admitted.authorization.id,
          authorizedPayloadHash: admitted.authorizedPayloadHash
        },
        requestId: admitted.authorization.requestId
      })).rejects.toMatchObject({ code: "memory_mutation_authorization_invalid" });

      await expect(Promise.all([
        prisma.memoryFact.count({ where: { userId } }),
        prisma.memoryFactVersion.count({ where: { userId } })
      ])).resolves.toEqual(before);
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: admitted.authorization.id }
      })).resolves.toMatchObject({ consumedAt: null });
    } finally {
      if (race === "TEMPORARY") {
        await prisma.$transaction(async (tx) => {
          await tx.memoryDeletionOutbox.updateMany({
            data: {
              leaseExpiresAt: new Date(Date.now() + 60_000),
              leaseToken: "control-race-cleanup",
              state: "RUNNING"
            },
            where: { operation: "TEMPORARY_DELETE", userId }
          });
          await tx.memoryMutationAuthorization.deleteMany({ where: { userId } });
          await tx.usageEvent.deleteMany({ where: { userId } });
          await tx.chat.deleteMany({ where: { userId } });
          await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
          await tx.user.deleteMany({ where: { id: userId } });
        });
      } else {
        await cleanupUser(userId);
      }
      await cleanupProvider?.();
    }
  });

  it("keeps a control-backed save valid across an unrelated Memory revision advance", async () => {
    const userId = await createActiveUser("control-unrelated-revision");
    let cleanupProvider: (() => Promise<void>) | undefined;
    try {
      const admitted = await createControlAuthorizedSave(
        userId,
        "unrelated-revision"
      );
      cleanupProvider = admitted.cleanupProvider;
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      await createTestMemoryFactRepository().save(userId, saveInput(
        scope.id,
        `unrelated-revision-${randomUUID()}`,
        factValue(
          `profile.unrelated.${randomUUID()}`,
          "An unrelated Memory write completed.",
          "unrelated"
        )
      ));

      const value: MemoryFactValueInput = {
        ...factValue(
          `control.unrelated-revision.${randomUUID()}`,
          admitted.controlIntent.statement!,
          "concise"
        ),
        category: "preferences",
        modality: "PREFERENCE",
        safetyClassification: {
          executionId: admitted.binding.id,
          intent: admitted.controlIntent,
          kind: "CONTROL"
        }
      };
      const saved = await createPrismaMemoryFactRepository(
        suppressionKeyring,
        prisma
      ).save(userId, {
        ...saveInput(
          scope.id,
          `control-unrelated-revision-${randomUUID()}`,
          value
        ),
        authorization: {
          action: "SAVE",
          authorizationId: admitted.authorization.id,
          authorizedPayloadHash: admitted.authorizedPayloadHash
        },
        modelRunId: admitted.run.id,
        requestId: admitted.authorization.requestId
      });

      expect(saved).toMatchObject({ outcome: "CREATED", replayed: false });
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: admitted.authorization.id }
      })).resolves.toMatchObject({ consumedAt: expect.any(Date) });
      await expect(prisma.memoryOperationReceipt.count({
        where: { modelRunId: admitted.run.id, operation: "SAVE", userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupUser(userId);
      await cleanupProvider?.();
    }
  });

  it("binds fact safety to the exact ordinal-zero control decision", async () => {
    const userId = await createActiveUser("control-safety-receipt");
    let cleanupProvider: (() => Promise<void>) | undefined;
    try {
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const admitted = await createControlAuthorizedSave(userId, "safety-receipt");
      cleanupProvider = admitted.cleanupProvider;
      const selectorAt = new Date();
      const selector = await prisma.memoryExecutionBinding.create({
        data: {
          acceptedOutputHash: "9".repeat(64),
          completedAt: selectorAt,
          connectionId: admitted.binding.connectionId,
          createdAt: selectorAt,
          credentialId: admitted.binding.credentialId,
          credentialVersionId: admitted.binding.credentialVersionId,
          destinationFingerprint: admitted.binding.destinationFingerprint,
          inputHash: "8".repeat(64),
          logicalRole: "MEMORY_CONTROL",
          ordinal: 1,
          ownerType: "RETRIEVAL_ATTEMPT",
          pipelineVersion: "memory-target-selection-v2",
          policyVersion: "memory-target-selection-policy-v1",
          promptVersion: "memory-target-selection-prompt-v1",
          providerId: admitted.binding.providerId,
          providerModelId: admitted.binding.providerModelId,
          retrievalAttemptId: admitted.binding.retrievalAttemptId,
          schemaVersion: "memory-target-selection-v1",
          secretFreeExecutionSnapshot: admitted.executionSnapshot,
          startedAt: selectorAt,
          state: "SUCCEEDED",
          userId
        }
      });
      await prisma.usageEvent.create({
        data: {
          cachedInputTokens: 0,
          inputTokens: 1,
          memoryExecutionBindingId: selector.id,
          modelId: admitted.binding.providerModelId!,
          outputTokens: 1,
          provider: admitted.binding.providerId!,
          providerModelId: admitted.binding.providerModelId!,
          reasoningTokens: 0,
          totalTokens: 2,
          userId
        }
      });
      const value: MemoryFactValueInput = {
        ...factValue(
          `control.safety.${randomUUID()}`,
          admitted.controlIntent.statement!,
          "control-safety"
        ),
        category: "preferences",
        modality: "PREFERENCE",
        safetyClassification: {
          executionId: selector.id,
          intent: admitted.controlIntent,
          kind: "CONTROL"
        }
      };
      const input: MemoryFactSaveInput = {
        ...saveInput(scope.id, `control-safety-${randomUUID()}`, value),
        authorization: {
          action: "SAVE",
          authorizationId: admitted.authorization.id,
          authorizedPayloadHash: admitted.authorizedPayloadHash
        },
        modelRunId: admitted.run.id,
        requestId: admitted.authorization.requestId
      };
      const repository = createPrismaMemoryFactRepository(suppressionKeyring, prisma);
      await expect(repository.save(userId, input)).rejects.toMatchObject({
        code: "memory_input_invalid"
      });
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: admitted.authorization.id }
      })).resolves.toMatchObject({ consumedAt: null });

      await expect(repository.save(userId, {
        ...input,
        value: {
          ...value,
          safetyClassification: {
            executionId: admitted.binding.id,
            intent: admitted.controlIntent,
            kind: "CONTROL"
          }
        }
      })).resolves.toMatchObject({ outcome: "CREATED" });
      await expect(prisma.memoryFactVersion.findFirstOrThrow({
        where: { userId }
      })).resolves.toMatchObject({
        safetyClassificationReasonCode: "save_request",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifierExecutionId: admitted.binding.id
      });
    } finally {
      await cleanupUser(userId);
      await cleanupProvider?.();
    }
  });

  it("accepts a legacy SENSITIVE control decision only as ordinary persisted memory", async () => {
    const userId = await createActiveUser("control-sensitive-normalization");
    let cleanupProvider: (() => Promise<void>) | undefined;
    try {
      const legacyIntent = {
        action: "SAVE",
        applyResponsePreferences: false,
        category: "sensitive",
        categoryHint: "preferences",
        confidenceBand: "HIGH",
        entityMentions: [] as MemoryActionIntent["entityMentions"],
        includePatterns: false,
        memoryUseful: false,
        pastChatsUseful: false,
        profileRequested: false,
        queryText: null,
        reasonCode: "save_request",
        recencyRequested: false,
        retrievalMode: "TARGETED_CURRENT",
        referencedMemoryRef: null,
        replacementStatement: null,
        responsePreference: false,
        sensitiveDomainHint: "legacy-private",
        sensitivity: "SENSITIVE",
        statement: "I prefer concise answers.",
        targetQuery: null,
        temporalAsOf: null,
        temporalFrom: null,
        temporalIntent: "CURRENT",
        temporalTo: null,
        thisChatOnly: false
      } as const;
      const decoded = decodeMemoryActionIntent(legacyIntent);
      if (!decoded.ok) throw new Error("legacy_sensitive_intent_invalid");
      const admitted = await createControlAuthorizedSave(
        userId,
        "sensitive-normalization",
        { controlIntent: decoded.value }
      );
      cleanupProvider = admitted.cleanupProvider;
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const value: MemoryFactValueInput = {
        ...factValue(
          `control.sensitive-normalization.${randomUUID()}`,
          legacyIntent.statement,
          "concise"
        ),
        category: "preferences",
        safetyClassification: {
          executionId: admitted.binding.id,
          intent: legacyIntent,
          kind: "CONTROL"
        }
      };
      const repository = createPrismaMemoryFactRepository(suppressionKeyring, prisma);

      const saved = await repository.save(userId, {
        ...saveInput(scope.id, `control-sensitive-${randomUUID()}`, value),
        authorization: {
          action: "SAVE",
          authorizationId: admitted.authorization.id,
          authorizedPayloadHash: admitted.authorizedPayloadHash
        },
        modelRunId: admitted.run.id,
        requestId: admitted.authorization.requestId
      });

      await expect(prisma.memoryFactVersion.findUniqueOrThrow({
        where: { id: saved.versionId }
      })).resolves.toMatchObject({
        category: "preferences",
        sensitivityClass: "NORMAL"
      });
    } finally {
      await cleanupUser(userId);
      await cleanupProvider?.();
    }
  });

  it("rejects swapped selected target, control action, and payload evidence", async () => {
    const userId = await createActiveUser("control-evidence-swap");
    let cleanupProvider: (() => Promise<void>) | undefined;
    try {
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const repository = createTestMemoryFactRepository();
      const first = await repository.save(userId, saveInput(
        scope.id,
        `control-evidence-first-${randomUUID()}`,
        factValue("control.evidence.first", "I prefer concise answers.", "concise")
      ));
      const second = await repository.save(userId, saveInput(
        scope.id,
        `control-evidence-second-${randomUUID()}`,
        factValue("control.evidence.second", "I prefer detailed answers.", "detailed")
      ));
      const controlIntent: MemoryActionIntent = {
        action: "FORGET",
        applyResponsePreferences: false,
        category: null,
        categoryHint: null,
        confidenceBand: "HIGH",
        entityMentions: [] as MemoryActionIntent["entityMentions"],
        includePatterns: false,
        memoryUseful: false,
        pastChatsUseful: false,
        profileRequested: false,
        queryText: null,
        reasonCode: "forget_request",
        recencyRequested: false,
        retrievalMode: "TARGETED_CURRENT",
        referencedMemoryRef: null,
        replacementStatement: null,
        responsePreference: false,
        sensitiveDomainHint: null,
        sensitivity: "NORMAL",
        statement: null,
        targetQuery: "the concise answer preference",
        temporalAsOf: null,
        temporalFrom: null,
        temporalIntent: "CURRENT",
        temporalTo: null,
        thisChatOnly: false
      };
      const firstPayload = memoryTargetAuthorizationPayloadHash({
        action: "FORGET",
        expectedTargetVersionId: first.versionId,
        targetFactId: first.factId
      });
      const admitted = await createControlAuthorizedSave(userId, "evidence-swap", {
        controlIntent,
        mutation: {
          action: "FORGET",
          authorizedPayloadHash: firstPayload,
          expectedTargetVersionId: first.versionId,
          targetFactId: first.factId
        }
      });
      cleanupProvider = admitted.cleanupProvider;
      const candidates = [
        {
          handle: "c0",
          target: {
            factId: first.factId,
            statement: "I prefer concise answers.",
            summary: {} as never,
            versionId: first.versionId
          }
        },
        {
          handle: "c1",
          target: {
            factId: second.factId,
            statement: "I prefer detailed answers.",
            summary: {} as never,
            versionId: second.versionId
          }
        }
      ];
      const candidateMapHash = memoryTargetCandidateMapHash(candidates);
      const selectorInputHash = memorySha256({ candidateMapHash, version: 2 });
      const selectorOutputHash = memoryTargetSelectionAcceptedOutputHash({
        candidateMapHash,
        inputHash: selectorInputHash,
        selectedFactId: first.factId,
        selectedHandle: "c0",
        selectedVersionId: first.versionId
      });
      const selectorExecutionAt = new Date();
      const selector = await prisma.memoryExecutionBinding.create({
        data: {
          acceptedOutputHash: selectorOutputHash,
          completedAt: selectorExecutionAt,
          connectionId: admitted.binding.connectionId,
          createdAt: selectorExecutionAt,
          credentialId: admitted.binding.credentialId,
          credentialVersionId: admitted.binding.credentialVersionId,
          destinationFingerprint: admitted.binding.destinationFingerprint,
          inputHash: selectorInputHash,
          logicalRole: "MEMORY_CONTROL",
          ordinal: 1,
          ownerType: "RETRIEVAL_ATTEMPT",
          pipelineVersion: "memory-target-selection-v2",
          policyVersion: "memory-target-selection-policy-v1",
          promptVersion: "memory-target-selection-prompt-v1",
          providerId: admitted.binding.providerId,
          providerModelId: admitted.binding.providerModelId,
          retrievalAttemptId: admitted.binding.retrievalAttemptId,
          schemaVersion: "memory-target-selection-v1",
          secretFreeExecutionSnapshot: admitted.executionSnapshot,
          startedAt: selectorExecutionAt,
          state: "SUCCEEDED",
          userId
        }
      });
      const authorizations = createPrismaMemoryMutationAuthorizationRepository(prisma);
      const before = await prisma.memoryMutationAuthorization.count({ where: { userId } });
      const selectorEvidence = {
        admissionDeadlineAtMs: Date.now() + 4_000,
        targetSelectionBindingId: selector.id,
        targetSelectionCandidateMapHash: candidateMapHash,
        targetSelectionOutputHash: selectorOutputHash,
        targetSelectionSelectedHandle: "c0"
      };
      const selectorAuthorization = await authorizations.mintForControl(userId, {
        action: "FORGET",
        authorizedPayloadHash: firstPayload,
        bindingId: admitted.binding.id,
        chatId: admitted.chat.id,
        controlIntent,
        expectedTargetVersionId: first.versionId,
        modelRunId: admitted.run.id,
        sourceText: admitted.sourceText,
        targetFactId: first.factId,
        ...selectorEvidence
      });
      await expect(authorizations.mintForControl(userId, {
        action: "FORGET",
        authorizedPayloadHash: memoryTargetAuthorizationPayloadHash({
          action: "FORGET",
          expectedTargetVersionId: second.versionId,
          targetFactId: second.factId
        }),
        bindingId: admitted.binding.id,
        chatId: admitted.chat.id,
        controlIntent,
        expectedTargetVersionId: second.versionId,
        modelRunId: admitted.run.id,
        sourceText: admitted.sourceText,
        targetFactId: second.factId,
        ...selectorEvidence
      })).rejects.toMatchObject({ code: "memory_mutation_authorization_invalid" });
      await expect(authorizations.mintForControl(userId, {
        action: "SAVE",
        admissionDeadlineAtMs: Date.now() + 4_000,
        authorizedPayloadHash: memorySha256("I prefer concise answers."),
        bindingId: admitted.binding.id,
        chatId: admitted.chat.id,
        controlIntent,
        modelRunId: admitted.run.id,
        sourceText: admitted.sourceText
      })).rejects.toMatchObject({ code: "memory_input_invalid" });
      await expect(authorizations.mintForControl(userId, {
        action: "FORGET",
        authorizedPayloadHash: "9".repeat(64),
        bindingId: admitted.binding.id,
        chatId: admitted.chat.id,
        controlIntent,
        expectedTargetVersionId: first.versionId,
        modelRunId: admitted.run.id,
        sourceText: admitted.sourceText,
        targetFactId: first.factId,
        ...selectorEvidence
      })).rejects.toMatchObject({ code: "memory_input_invalid" });
      await expect(prisma.memoryMutationAuthorization.count({ where: { userId } }))
        .resolves.toBe(before + 1);

      const consumeTampered = async (input: Readonly<{
        action: "FORGET" | "SAVE";
        authorizedPayloadHash: string;
        expectedTargetVersionId?: string;
        targetFactId?: string;
      }>) => prisma.$transaction((tx) => consumeMemoryMutationAuthorization(
        tx,
        userId,
        {
          ...input,
          authorizationId: selectorAuthorization.id,
          requestId: selectorAuthorization.requestId
        }
      ));
      const tamperedTargetPayload = memoryTargetAuthorizationPayloadHash({
        action: "FORGET",
        expectedTargetVersionId: second.versionId,
        targetFactId: second.factId
      });
      await prisma.memoryMutationAuthorization.update({
        data: {
          authorizedPayloadHash: tamperedTargetPayload,
          expectedTargetVersionId: second.versionId,
          targetFactId: second.factId
        },
        where: { id: selectorAuthorization.id }
      });
      await expect(consumeTampered({
        action: "FORGET",
        authorizedPayloadHash: tamperedTargetPayload,
        expectedTargetVersionId: second.versionId,
        targetFactId: second.factId
      })).rejects.toMatchObject({ code: "memory_mutation_authorization_invalid" });

      const tamperedSavePayload = memorySha256("I prefer concise answers.");
      await prisma.memoryMutationAuthorization.update({
        data: {
          action: "SAVE",
          authorizedPayloadHash: tamperedSavePayload,
          expectedTargetVersionId: null,
          targetFactId: null
        },
        where: { id: selectorAuthorization.id }
      });
      await expect(consumeTampered({
        action: "SAVE",
        authorizedPayloadHash: tamperedSavePayload
      })).rejects.toMatchObject({ code: "memory_mutation_authorization_invalid" });

      const tamperedPayload = "9".repeat(64);
      await prisma.memoryMutationAuthorization.update({
        data: {
          action: "FORGET",
          authorizedPayloadHash: tamperedPayload,
          expectedTargetVersionId: first.versionId,
          targetFactId: first.factId
        },
        where: { id: selectorAuthorization.id }
      });
      await expect(consumeTampered({
        action: "FORGET",
        authorizedPayloadHash: tamperedPayload,
        expectedTargetVersionId: first.versionId,
        targetFactId: first.factId
      })).rejects.toMatchObject({ code: "memory_mutation_authorization_invalid" });
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: selectorAuthorization.id }
      })).resolves.toMatchObject({ consumedAt: null });
    } finally {
      await cleanupUser(userId);
      await cleanupProvider?.();
    }
  });

  it("mints tool authority only from the exact current USER turn and current owned target", async () => {
    const userId = await createActiveUser("tool-authorization");
    const otherUserId = await createActiveUser("tool-authorization-other");
    const sourceText = "Replace my saved answer preference with concise replies.";
    const repository = createPrismaMemoryMutationAuthorizationRepository(prisma);
    try {
      const chat = await prisma.chat.create({
        data: { title: "Tool authorization", userId }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent(sourceText),
          role: "user",
          status: "complete"
        }
      });
      const run = await prisma.modelRun.create({
        data: {
          chatId: chat.id,
          modelId: "memory-tool-authorization-model",
          normalizedRequest: {},
          provider: "memory-tool-authorization-provider",
          status: "complete",
          userId,
          userMessageId: userMessage.id
        }
      });
      const [saveCall, editCall] = await Promise.all([
        prisma.modelRunToolCall.create({
          data: {
            arguments: { text: "Keep replies concise." },
            modelRunId: run.id,
            ordinal: 0,
            providerCallId: randomUUID(),
            roundIndex: 0,
            toolName: "save_memory"
          }
        }),
        prisma.modelRunToolCall.create({
          data: {
            arguments: { replacement_text: "Keep replies concise." },
            modelRunId: run.id,
            ordinal: 1,
            providerCallId: randomUUID(),
            roundIndex: 0,
            toolName: "edit_memory"
          }
        })
      ]);

      const saved = await repository.mintForTool(userId, {
        action: "SAVE",
        authorizedPayloadHash: "1".repeat(64),
        chatId: chat.id,
        modelRunId: run.id,
        persistedToolCallId: saveCall.id,
        sourceText,
        toolName: saveCall.toolName
      });
      expect(saved).toMatchObject({
        action: "SAVE",
        exactSourceEnd: sourceText.length,
        exactSourceStart: 0,
        modelRunId: run.id,
        persistedToolCallId: saveCall.id,
        sourceChatId: chat.id,
        sourceMessageId: userMessage.id
      });
      await expect(repository.mintForTool(userId, {
        action: "SAVE",
        authorizedPayloadHash: "2".repeat(64),
        chatId: chat.id,
        modelRunId: run.id,
        persistedToolCallId: saveCall.id,
        sourceText: "Replace an earlier turn instead.",
        toolName: saveCall.toolName
      })).rejects.toMatchObject({ code: "memory_mutation_authorization_invalid" });

      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const current = await createTestMemoryFactRepository().save(userId, saveInput(
        scope.id,
        `tool-owned-${randomUUID()}`,
        factValue(`opaque.${randomUUID()}`, "I prefer detailed replies.", "detailed")
      ));
      await expect(repository.mintForTool(userId, {
        action: "EDIT",
        authorizedPayloadHash: "3".repeat(64),
        chatId: chat.id,
        expectedTargetVersionId: current.versionId,
        modelRunId: run.id,
        persistedToolCallId: editCall.id,
        sourceText,
        targetFactId: current.factId,
        toolName: editCall.toolName
      })).resolves.toMatchObject({
        action: "EDIT",
        expectedTargetVersionId: current.versionId,
        targetFactId: current.factId
      });

      const legacyFolder = await prisma.folder.create({
        data: { name: "Legacy authorization target", userId }
      });
      const legacyScope = await createPrismaMemoryScopeRepository(prisma).ensure(userId, {
        targetId: legacyFolder.id,
        type: "FOLDER"
      });
      const legacy = await createTestMemoryFactRepository().save(userId, saveInput(
        legacyScope.id,
        `tool-legacy-${randomUUID()}`,
        factValue(
          `legacy.tool.${randomUUID()}`,
          "Legacy folder preference must remain dormant.",
          "legacy"
        )
      ));
      const legacyEditCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { replacement_text: "Never authorize this legacy target." },
          modelRunId: run.id,
          ordinal: 2,
          providerCallId: randomUUID(),
          roundIndex: 0,
          toolName: "edit_memory"
        }
      });
      await expect(repository.mintForTool(userId, {
        action: "EDIT",
        authorizedPayloadHash: "5".repeat(64),
        chatId: chat.id,
        expectedTargetVersionId: legacy.versionId,
        modelRunId: run.id,
        persistedToolCallId: legacyEditCall.id,
        sourceText,
        targetFactId: legacy.factId,
        toolName: legacyEditCall.toolName
      })).rejects.toMatchObject({ code: "memory_fact_not_found" });

      const otherScope = await createPrismaMemoryScopeRepository(prisma)
        .ensureGlobal(otherUserId);
      const other = await createTestMemoryFactRepository().save(otherUserId, saveInput(
        otherScope.id,
        `tool-other-${randomUUID()}`,
        factValue(`opaque.${randomUUID()}`, "Other user's preference.", "other")
      ));
      const foreignCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { replacement_text: "Do not cross owners." },
          modelRunId: run.id,
          ordinal: 3,
          providerCallId: randomUUID(),
          roundIndex: 0,
          toolName: "edit_memory"
        }
      });
      await expect(repository.mintForTool(userId, {
        action: "EDIT",
        authorizedPayloadHash: "4".repeat(64),
        chatId: chat.id,
        expectedTargetVersionId: other.versionId,
        modelRunId: run.id,
        persistedToolCallId: foreignCall.id,
        sourceText,
        targetFactId: other.factId,
        toolName: foreignCall.toolName
      })).rejects.toMatchObject({ code: "memory_fact_not_found" });
    } finally {
      await cleanupUser(userId);
      await cleanupUser(otherUserId);
    }
  });

  it("persists all independent gate combinations and fences consent policy drift", async () => {
    const userId = await createActiveUser("settings-matrix");
    let currentFingerprint = "c".repeat(64);
    const repository = createPrismaMemorySettingsRepository(prisma, {
      resolveCurrentUtilityPolicy: async () => ({
        destinations: [],
        fingerprint: currentFingerprint,
        policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
        targets: new Map()
      } satisfies ResolvedMemoryUtilityPolicy)
    });
    try {
      await expect(repository.patch(userId, {
        embeddingDeploymentId: randomUUID(),
        expectedMemoryRevision: 0,
        expectedSettingsRevision: 0
      })).rejects.toMatchObject({ code: "memory_embedding_unavailable" });
      await expect(repository.get(userId)).resolves.toMatchObject({
        embeddingProviderModelId: null,
        memoryRevision: 0,
        settingsRevision: 0
      });
      const initialProjection = await createMemorySettingsService({
        egressConsentMode: "PER_USER",
        repository,
        resolveCurrentUtilityPolicy: (ownerUserId, ownerSettings) =>
          resolveCurrentMemoryUtilityPolicy(prisma, ownerUserId, ownerSettings)
      }).get(userId);
      expect(initialProjection).toMatchObject({
        capabilities: {
          automaticLearning: true,
          explicitMemory: true,
          historyRecall: true,
          permanentChatDeletion: false,
          temporaryChats: true
        },
        egress: {
          acceptedAt: null,
          acceptedUtilityEgressFingerprint: null,
          acceptedUtilityPolicyVersion: null,
          reviewRequired: true
        },
        settings: {
          embeddingDeployment: null,
          settingsRevision: 0
        }
      });
      expect(initialProjection.egress.currentUtilityEgressFingerprint).toMatch(
        /^[a-f0-9]{64}$/u
      );
      expect(JSON.stringify(initialProjection)).not.toMatch(/credential/iu);

      const combinations = [
        [true, true, true],
        [false, true, false],
        [false, false, false],
        [false, false, true],
        [false, true, true],
        [true, true, false],
        [true, false, true],
        [true, false, false]
      ] as const;
      await expect(repository.get(userId)).resolves.toMatchObject({
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true
      });
      for (let index = 1; index < combinations.length; index += 1) {
        const [useMemoryFacts, referenceChatHistory, learnAutomatically] =
          combinations[index]!;
        const updated = await repository.patch(userId, {
          expectedMemoryRevision: index - 1,
          expectedSettingsRevision: index - 1,
          learnAutomatically,
          referenceChatHistory,
          useMemoryFacts
        });
        expect(updated).toMatchObject({
          learnAutomatically,
          memoryRevision: index,
          referenceChatHistory,
          settingsRevision: index,
          useMemoryFacts
        });
      }

      const observedFingerprint = currentFingerprint;
      currentFingerprint = "d".repeat(64);
      await expect(repository.acceptUtilityEgress(userId, {
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        currentUtilityEgressFingerprint: observedFingerprint,
        currentUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
        expectedMemoryConsentRevision: 0,
        expectedMemoryRevision: 7,
        expectedSettingsRevision: 7
      })).rejects.toMatchObject({ code: "memory_consent_policy_changed" });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }))
        .resolves.toMatchObject({
          acceptedUtilityEgressFingerprint: null,
          memoryConsentRevision: 0,
          memoryRevision: 7,
          settingsRevision: 7
        });

      const accepted = await repository.acceptUtilityEgress(userId, {
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        currentUtilityEgressFingerprint: currentFingerprint,
        currentUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
        expectedMemoryConsentRevision: 0,
        expectedMemoryRevision: 7,
        expectedSettingsRevision: 7
      });
      expect(accepted).toMatchObject({
        acceptedUtilityEgressFingerprint: currentFingerprint,
        acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
        memoryConsentRevision: 1,
        memoryRevision: 8,
        settingsRevision: 8
      });
      await expect(repository.patch(userId, {
        expectedMemoryRevision: 7,
        expectedSettingsRevision: 8,
        useMemoryFacts: false
      })).rejects.toMatchObject({ code: "memory_revision_conflict" });
      await expect(repository.get(userId)).resolves.toMatchObject({
        memoryRevision: 8,
        settingsRevision: 8,
        useMemoryFacts: true
      });
      const generations = await prisma.memoryIndexGeneration.findMany({
        where: { userId }
      });
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        indexedThroughMemoryRevision: 8,
        state: "ACTIVE",
        targetMemoryRevision: 1
      });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("deduplicates fact retries and permits exactly one edit for an exact version", async () => {
    const userId = await createActiveUser("fact-cas");
    try {
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const repository = createTestMemoryFactRepository();
      const initial = saveInput(
        scope.id,
        "save-favorite-color-v1",
        factValue("profile.favorite_color", "My favorite color is red.", "red")
      );
      const saves = await Promise.all([
        repository.save(userId, initial),
        repository.save(userId, initial)
      ]);
      expect(new Set(saves.map((result) => result.factId))).toHaveLength(1);
      expect(new Set(saves.map((result) => result.versionId))).toHaveLength(1);
      expect(saves.map((result) => result.replayed).sort()).toEqual([false, true]);

      const original = saves[0]!;
      const editBase = {
        authorization: {
          action: "EDIT" as const,
          authorizationId: "authorization-edit-favorite-color",
          authorizedPayloadHash: "e".repeat(64),
          expectedTargetVersionId: original.versionId,
          targetFactId: original.factId
        },
        evidence: {
          kind: "EXPLICIT_ACTION" as const,
          observedAt: new Date("2026-08-10T10:05:00.000Z"),
          safeSourceHash: "b".repeat(64),
          safetyClass: "NORMAL" as const,
          sourceProjectionVersion: "memory-test-projection-v1"
        },
        expectedVersionId: original.versionId,
        explicitSuppressionOverride: false,
        factId: original.factId,
        scopeId: scope.id
      };
      const edits = await Promise.allSettled([
        repository.edit(userId, {
          ...editBase,
          evidence: { ...editBase.evidence, safeExcerpt: "My favorite color is blue." },
          idempotencyFingerprint: "edit-favorite-color-blue-v1",
          requestId: "request-edit-blue",
          value: factValue(
            "profile.favorite_color",
            "My favorite color is blue.",
            "blue"
          )
        }),
        repository.edit(userId, {
          ...editBase,
          evidence: { ...editBase.evidence, safeExcerpt: "My favorite color is green." },
          idempotencyFingerprint: "edit-favorite-color-green-v1",
          requestId: "request-edit-green",
          value: factValue(
            "profile.favorite_color",
            "My favorite color is green.",
            "green"
          )
        })
      ]);
      const applied = edits.filter((result) => result.status === "fulfilled");
      const stale = edits.filter((result) => result.status === "rejected");
      expect(applied).toHaveLength(1);
      expect(stale).toHaveLength(1);
      expectRejectedCode(stale[0]!, "memory_fact_version_stale");

      const [settings, generations, counts, currentFact, activeSearchEntries] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryIndexGeneration.findMany({ where: { userId } }),
        Promise.all([
          prisma.memoryFact.count({ where: { userId } }),
          prisma.memoryFactVersion.count({ where: { userId } }),
          prisma.memoryEvent.count({ where: { userId } }),
          prisma.memoryEvidence.count({ where: { userId } }),
          prisma.memoryOperationReceipt.count({ where: { userId } })
        ]),
        prisma.memoryFact.findUniqueOrThrow({ where: { id: original.factId } }),
        prisma.memorySearchEntry.findMany({ where: { userId } })
      ]);
      expect(settings).toMatchObject({ memoryGeneration: 0, memoryRevision: 2 });
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        indexedThroughMemoryRevision: 2,
        targetMemoryRevision: 1
      });
      expect(counts).toEqual([1, 2, 2, 2, 2]);
      expect(activeSearchEntries).toHaveLength(1);
      expect(activeSearchEntries[0]?.factVersionId).toBe(currentFact.currentVersionId);
      expect(currentFact.currentVersionId).toBe(
        applied[0]?.status === "fulfilled" ? applied[0].value.versionId : "unreachable"
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  it("rejects foreign and absent scopes without leaving mutation effects", async () => {
    const ownerUserId = await createActiveUser("scope-owner");
    const foreignUserId = await createActiveUser("scope-foreign");
    try {
      const foreignScope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(foreignUserId);
      const repository = createTestMemoryFactRepository();
      await Promise.all([
        expect(repository.save(ownerUserId, saveInput(
          foreignScope.id,
          "save-foreign-scope-v1",
          factValue("profile.city", "I live in Moscow.", "Moscow")
        ))).rejects.toMatchObject({ code: "memory_scope_unavailable" }),
        expect(repository.save(ownerUserId, saveInput(
          randomUUID(),
          "save-absent-scope-v1",
          factValue("profile.city", "I live in Moscow.", "Moscow")
        ))).rejects.toMatchObject({ code: "memory_scope_unavailable" })
      ]);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: ownerUserId } }))
        .resolves.toMatchObject({
          activeIndexGenerationId: null,
          memoryGeneration: 0,
          memoryRevision: 0
        });
      await expect(prisma.memoryFact.count({ where: { userId: ownerUserId } })).resolves.toBe(0);
    } finally {
      await cleanupUser(ownerUserId);
      await cleanupUser(foreignUserId);
    }
  });

  it("records suppressions idempotently and requires an allowed explicit override", async () => {
    const userId = await createActiveUser("suppression");
    try {
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const suppressions = createPrismaMemorySuppressionRepository(suppressionKeyring, prisma);
      const facts = createTestMemoryFactRepository();
      const blockedInput = {
        canonicalKey: "profile.favorite_color",
        explicitOverrideAllowed: false,
        scope: "FACT" as const,
        suppressionId: randomUUID()
      };
      const first = await suppressions.create(userId, blockedInput);
      const replay = await suppressions.create(userId, blockedInput);
      expect(first).toMatchObject({ created: true, deletionGeneration: 1 });
      expect(replay).toMatchObject({ created: false, id: first.id });

      const blockedSave = saveInput(
        scope.id,
        "save-suppressed-color-v1",
        factValue("profile.favorite_color", "My favorite color is red.", "red")
      );
      await expect(facts.save(userId, blockedSave)).rejects.toMatchObject({
        code: "memory_fact_suppressed"
      });
      await expect(facts.save(userId, {
        ...blockedSave,
        explicitSuppressionOverride: true,
        idempotencyFingerprint: "save-suppressed-color-override-v1",
        requestId: "request-suppressed-color-override"
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });

      await suppressions.create(userId, {
        canonicalKey: "profile.pet",
        explicitOverrideAllowed: true,
        scope: "FACT",
        suppressionId: randomUUID()
      });
      const allowed = saveInput(
        scope.id,
        "save-suppressed-pet-override-v1",
        factValue("profile.pet", "My pet is named Ada.", "Ada")
      );
      await expect(facts.save(userId, {
        ...allowed,
        explicitSuppressionOverride: true
      })).resolves.toMatchObject({ outcome: "CREATED" });

      const [settings, suppressionCount, factCount] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memorySuppression.count({ where: { userId } }),
        prisma.memoryFact.count({ where: { userId } })
      ]);
      expect(settings).toMatchObject({ memoryGeneration: 2, memoryRevision: 3 });
      expect(suppressionCount).toBe(2);
      expect(factCount).toBe(1);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("deduplicates jobs and destructive deletion obligations", async () => {
    const userId = await createActiveUser("work-queues");
    try {
      const jobs = createPrismaMemoryJobRepository(prisma);
      const deletion = createPrismaMemoryDeletionRepository(prisma);
      const jobInput = {
        idempotencyFingerprint: "memory-rebuild-index-test-v1",
        kind: "REBUILD_INDEX" as const,
        pipelineVersion: "memory-persistence-test-v1"
      };
      const firstJob = await jobs.enqueue(userId, jobInput);
      const replayedJob = await jobs.enqueue(userId, jobInput);
      expect(firstJob).toMatchObject({ created: true, state: "QUEUED" });
      expect(replayedJob).toMatchObject({ created: false, id: firstJob.id });

      const deletionInput = {
        operation: "BULK_CLEAR" as const,
        targetId: "all-reusable-memory",
        targetType: "USER_MEMORY"
      };
      const firstDeletion = await deletion.enqueueDestructive(userId, deletionInput);
      const replayedDeletion = await deletion.enqueueDestructive(userId, deletionInput);
      expect(firstDeletion).toMatchObject({
        created: true,
        memoryGeneration: 1,
        state: "PENDING"
      });
      expect(replayedDeletion).toMatchObject({ created: false, id: firstDeletion.id });

      const [settings, jobCount, deletionCount] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryJob.count({ where: { userId } }),
        prisma.memoryDeletionOutbox.count({ where: { userId } })
      ]);
      expect(settings).toMatchObject({ memoryGeneration: 1, memoryRevision: 1 });
      expect(jobCount).toBe(1);
      expect(deletionCount).toBe(1);
    } finally {
      await cleanupUser(userId);
    }
  });
});
