import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { MEMORY_PHASE2_PURGE_MANIFEST_VERSION, memoryPurgeTargetType } from "../purge/contract";
import {
  MEMORY_PROFILE_PROJECTION_VERSION,
  MEMORY_PROFILE_VERSIONS,
  memoryProfileAsOf,
  memoryProfileJobFingerprint,
  memoryProfileOutputHash
} from "./contract";
import {
  countInvalidMemoryProfileProjections,
  memoryProfileDeletionContributor,
  purgeInvalidMemoryProfileProjections
} from "./purge";
import { prepareGlobalMemoryProfileInput } from "./repository";
import { createMemoryProfileService } from "./service";

const now = new Date("2026-08-11T12:00:00.000Z");
const prefix = `memory-profile-purge-${randomUUID()}`;
const provider = {
  connectionId: `${prefix}-connection`,
  credentialId: `${prefix}-credential`,
  credentialVersionId: `${prefix}-credential-v1`,
  modelId: `${prefix}-model`
};
let providerReady: Promise<void> | null = null;

type ProfileFixture = Readonly<{
  factId: string;
  profileId: string;
  searchEntryId: string;
  userId: string;
  versionId: string;
}>;

async function ensureProvider(): Promise<void> {
  providerReady ??= (async () => {
    const configuration = {
      allowPrivateNetwork: false,
      apiRoot: "https://memory-profile.example.test/v1",
      responseTimeoutMs: 30_000
    };
    await prisma.providerConnection.create({
      data: {
        activeConfig: configuration,
        activeVersion: 1,
        activatedAt: now,
        displayName: "Memory profile purge provider",
        draftConfig: configuration,
        draftVersion: 1,
        enabled: true,
        family: "openai_compatible",
        id: provider.connectionId,
        unassignedPolicy: "use_default"
      }
    });
    await prisma.providerCredential.create({
      data: {
        activatedAt: now,
        connectionId: provider.connectionId,
        draftVersion: 1,
        enabled: true,
        id: provider.credentialId,
        label: "Memory profile purge credential",
        testedAt: now
      }
    });
    await prisma.providerCredentialVersion.create({
      data: {
        activatedAt: now,
        credentialId: provider.credentialId,
        id: provider.credentialVersionId,
        secretEnvelope: "test-only-envelope",
        testedAt: now,
        testEvidence: { authenticationMode: "bearer" },
        version: 1
      }
    });
    await prisma.providerCredential.update({
      data: { activeVersionId: provider.credentialVersionId },
      where: { id: provider.credentialId }
    });
    await prisma.providerConnection.update({
      data: { defaultCredentialId: provider.credentialId },
      where: { id: provider.connectionId }
    });
    await prisma.providerModel.create({
      data: {
        activeConfig: {},
        activeVersion: 1,
        activatedAt: now,
        capabilities: { toolCalling: true },
        connectionId: provider.connectionId,
        contextWindow: 32_768,
        defaultParams: {},
        displayName: "Memory profile purge model",
        draftConfig: {},
        draftVersion: 1,
        enabled: true,
        id: provider.modelId,
        modelClass: "answer",
        modelId: "memory-profile-purge-model",
        provider: "openai_compatible"
      }
    });
  })();
  await providerReady;
}

async function createFixture(label: string): Promise<ProfileFixture> {
  await ensureProvider();
  const suffix = randomUUID();
  const userId = `${prefix}-${label}-${suffix}`;
  const factId = `${userId}-fact`;
  const versionId = `${userId}-version`;
  const eventId = `${userId}-event`;
  const scopeId = `${userId}-scope`;
  const generationId = `${userId}-generation`;
  const searchEntryId = `${userId}-search`;
  const jobId = `${userId}-job`;
  const bindingId = `${userId}-binding`;
  const profileId = `${userId}-profile`;
  const statement = `Профиль ${label}: отвечай кратко.`;
  const profileAsOf = memoryProfileAsOf(now);
  await prisma.user.create({
    data: {
      displayName: "Memory profile purge owner",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.memoryScope.create({
    data: { id: scopeId, scopeType: "GLOBAL_USER", state: "ACTIVE", userId }
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryIndexGeneration.create({
      data: {
        activatedAt: now,
        chunkingVersion: "memory-chunking-v1",
        createdAt: now,
        generation: 1,
        id: generationId,
        indexMode: "LEXICAL_ONLY",
        indexedThroughMemoryRevision: 0,
        languageProfile: "RU_EN_MULTILINGUAL_V1",
        normalizationVersion: "memory-normalization-v1",
        readyAt: now,
        retrievalPipelineVersion: "memory-retrieval-v1",
        state: "ACTIVE",
        targetMemoryRevision: 0,
        userId
      }
    });
    await tx.userMemorySettings.update({
      data: {
        activeIndexGenerationId: generationId,
        learnAutomatically: false,
        referenceChatHistory: false,
        useMemoryFacts: true
      },
      where: { userId }
    });
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryFact.create({
      data: {
        canonicalKey: `profile.${label}`,
        category: "preference",
        currentVersionId: versionId,
        id: factId,
        lastConfirmedAt: now,
        scopeId,
        state: "ACTIVE",
        temperatureClass: "HOT",
        temperatureScore: 1,
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
        metadata: { fixture: true },
        operation: "EXPLICIT_SAVE",
        userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "preference",
        confidence: 1,
        createdByEventId: eventId,
        directness: "DIRECT",
        displayText: statement,
        factId,
        id: versionId,
        importance: 1,
        languageCode: "ru",
        modality: "PREFERENCE",
        normalizedSearchText: normalizeMemorySearchText(statement),
        pipelineVersion: "memory-profile-purge-fixture-v1",
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        state: "ACTIVE",
        structuredValue: { statement },
        systemFrom: new Date(now.getTime() - 60_000),
        userId
      }
    });
    await tx.memoryEvidence.create({
      data: {
        factVersionId: versionId,
        memoryEventId: eventId,
        observedAt: now,
        safeExcerpt: statement,
        safeSourceHash: memorySha256(statement),
        safetyClass: "NORMAL",
        sourceProjectionVersion: "memory-profile-purge-source-v1",
        sourceRole: "user",
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS",
        userId
      }
    });
    await tx.memorySearchEntry.create({
      data: {
        embeddingState: "NOT_APPLICABLE",
        factVersionId: versionId,
        id: searchEntryId,
        indexGenerationId: generationId,
        itemType: "FACT_VERSION",
        languageCode: "ru",
        safeContentHash: "a".repeat(64),
        safeSearchText: statement,
        safeSearchTextYoNormalized: statement,
        safetyIdentitySnapshot: "b".repeat(64),
        sourceIdentitySnapshot: "c".repeat(64),
        suppressionIdentitySnapshot: "d".repeat(64),
        userId
      }
    });
  });
  const input = await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    prepareGlobalMemoryProfileInput(tx, settings, profileAsOf));
  const candidate = input?.candidates.find((value) => value.factVersionId === versionId);
  if (!input || !candidate) throw new Error("memory_profile_fixture_input_missing");
  const segments = [{ factVersionId: versionId, text: statement }] as const;
  const outputHash = memoryProfileOutputHash(input, segments);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryJob.create({
      data: {
        acceptedResultHash: outputHash,
        completedAt: now,
        createdAt: now,
        id: jobId,
        idempotencyFingerprint: memoryProfileJobFingerprint(input.inputHash, jobId),
        kind: "RECALCULATE_WORKING_SET",
        memoryGenerationSnapshot: 0,
        memoryRevisionSnapshot: 0,
        pipelineVersion: "memory-working-set-profile-v1",
        state: "SUCCEEDED",
        updatedAt: now,
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: outputHash,
        completedAt: now,
        connectionId: provider.connectionId,
        createdAt: now,
        credentialId: provider.credentialId,
        credentialVersionId: provider.credentialVersionId,
        destinationFingerprint: "2".repeat(64),
        id: bindingId,
        inputHash: input.inputHash,
        logicalRole: "MEMORY_PROFILE",
        memoryJobId: jobId,
        ordinal: 0,
        ownerType: "JOB",
        pipelineVersion: MEMORY_PROFILE_VERSIONS.pipelineVersion,
        policyVersion: MEMORY_PROFILE_VERSIONS.policyVersion,
        promptVersion: MEMORY_PROFILE_VERSIONS.promptVersion,
        providerId: "openai_compatible",
        providerModelId: provider.modelId,
        schemaVersion: MEMORY_PROFILE_VERSIONS.schemaVersion,
        secretFreeExecutionSnapshot: {},
        startedAt: now,
        state: "SUCCEEDED",
        userId
      }
    });
    await tx.usageEvent.create({
      data: {
        id: `${userId}-usage`,
        memoryExecutionBindingId: bindingId,
        modelId: "memory-profile-purge-model",
        provider: "openai_compatible",
        providerModelId: provider.modelId,
        userId
      }
    });
    await tx.memoryProfileProjection.create({
      data: {
        asOf: profileAsOf,
        createdAt: now,
        createdByExecutionId: bindingId,
        id: profileId,
        inputHash: input.inputHash,
        languageCode: input.languageCode,
        memoryGeneration: input.memoryGeneration,
        memoryRevision: input.memoryRevision,
        outputHash,
        projectionVersion: MEMORY_PROFILE_PROJECTION_VERSION,
        redactionState: input.redactionState,
        safeContentHash: memorySha256({
          factVersionIds: [versionId],
          languageCode: input.languageCode,
          summary: statement,
          version: 1
        }),
        safetyClass: "NORMAL",
        safetyIdentitySnapshot: memorySha256({
          contributors: [{
            factVersionId: versionId,
            safetyIdentitySnapshot: candidate.safetyIdentitySnapshot
          }],
          version: 1
        }),
        scopeId: input.scopeId,
        sourceIdentitySnapshot: memorySha256({
          contributors: [{
            factVersionId: versionId,
            sourceIdentitySnapshot: candidate.sourceIdentitySnapshot
          }],
          version: 1
        }),
        state: "ACTIVE",
        summary: statement,
        suppressionIdentitySnapshot: memorySha256({
          contributors: [{
            factVersionId: versionId,
            suppressionIdentitySnapshot: candidate.suppressionIdentitySnapshot
          }],
          version: 1
        }),
        updatedAt: now,
        userId
      }
    });
    await tx.memoryProfileProjectionFact.create({
      data: {
        factId,
        factVersionContentHash: candidate.factVersionContentHash,
        factVersionId: versionId,
        ordinal: 0,
        projectionId: profileId,
        safetyIdentitySnapshot: candidate.safetyIdentitySnapshot,
        sourceIdentitySnapshot: candidate.sourceIdentitySnapshot,
        suppressionIdentitySnapshot: candidate.suppressionIdentitySnapshot,
        userId
      }
    });
  });
  return { factId, profileId, searchEntryId, userId, versionId };
}

afterAll(async () => {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryProfileProjectionFact.deleteMany({
      where: { userId: { startsWith: prefix } }
    });
    await tx.memoryProfileProjection.deleteMany({
      where: { userId: { startsWith: prefix } }
    });
  });
  await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.providerModel.deleteMany({ where: { connectionId: provider.connectionId } });
  await prisma.providerConnection.updateMany({
    data: { defaultCredentialId: null },
    where: { id: provider.connectionId }
  });
  await prisma.providerCredential.updateMany({
    data: { activeVersionId: null },
    where: { id: provider.credentialId }
  });
  await prisma.providerCredentialVersion.deleteMany({
    where: { credentialId: provider.credentialId }
  });
  await prisma.providerCredential.deleteMany({ where: { id: provider.credentialId } });
  await prisma.providerConnection.deleteMany({ where: { id: provider.connectionId } });
});

describe("Memory profile purge", () => {
  it("scrubs a source-invalid profile idempotently without touching another owner", async () => {
    const target = await createFixture("invalid-target");
    const other = await createFixture("invalid-other");
    const service = createMemoryProfileService(prisma);
    await expect(service.get(target.userId, now)).resolves.toMatchObject({
      memoryRevision: 0,
      profile: {
        contributors: [{ factId: target.factId, factVersionId: target.versionId }],
        summary: "Профиль invalid-target: отвечай кратко."
      },
      state: "READY"
    });
    await prisma.memorySearchEntry.delete({ where: { id: target.searchEntryId } });
    await expect(service.get(target.userId, now)).resolves.toEqual({
      memoryRevision: 0,
      profile: null,
      state: "EMPTY"
    });
    await expect(prisma.$transaction((tx) =>
      countInvalidMemoryProfileProjections(tx, target.userId))).resolves.toBe(1);
    await prisma.$transaction((tx) =>
      purgeInvalidMemoryProfileProjections(tx, target.userId));
    await prisma.$transaction((tx) =>
      purgeInvalidMemoryProfileProjections(tx, target.userId));
    await expect(prisma.memoryProfileProjection.findUniqueOrThrow({
      where: { id: target.profileId }
    })).resolves.toMatchObject({
      plaintextPurgedAt: expect.any(Date),
      redactionState: "EXCLUDED",
      state: "INVALIDATED",
      summary: null
    });
    await expect(prisma.memoryProfileProjectionFact.count({
      where: { projectionId: target.profileId }
    })).resolves.toBe(0);
    await expect(prisma.memoryProfileProjection.findUniqueOrThrow({
      where: { id: other.profileId }
    })).resolves.toMatchObject({ state: "ACTIVE", summary: expect.any(String) });
  });

  it("preserves monotonic profile time when purge transaction time is older", async () => {
    const target = await createFixture("monotonic-purge");
    const laterUpdatedAt = new Date("2099-01-01T00:00:00.000Z");
    await prisma.memoryProfileProjection.update({
      data: { updatedAt: laterUpdatedAt },
      where: { id: target.profileId }
    });
    await prisma.memorySearchEntry.delete({ where: { id: target.searchEntryId } });

    await prisma.$transaction((tx) =>
      purgeInvalidMemoryProfileProjections(tx, target.userId));

    await expect(prisma.memoryProfileProjection.findUniqueOrThrow({
      where: { id: target.profileId }
    })).resolves.toMatchObject({
      plaintextPurgedAt: expect.any(Date),
      state: "INVALIDATED",
      summary: null,
      updatedAt: laterUpdatedAt
    });
    await expect(prisma.memoryProfileProjection.findUniqueOrThrow({
      select: { plaintextPurgedAt: true },
      where: { id: target.profileId }
    })).resolves.toEqual({ plaintextPurgedAt: laterUpdatedAt });
  });

  it("makes a forgotten-fact deletion contributor replay-complete", async () => {
    const fixture = await createFixture("forgotten");
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
      await tx.memorySearchEntry.delete({ where: { id: fixture.searchEntryId } });
      await tx.memoryFactVersion.update({
        data: { state: "FORGOTTEN", systemTo: now },
        where: { id: fixture.versionId }
      });
      await tx.memoryFact.update({
        data: {
          currentVersionId: null,
          forgottenAt: now,
          pinned: false,
          state: "FORGOTTEN"
        },
        where: { id: fixture.factId }
      });
    });
    const target = {
      kind: "MEMORY_FACT" as const,
      manifestVersion: MEMORY_PHASE2_PURGE_MANIFEST_VERSION,
      operation: "FORGET_PURGE" as const,
      targetId: fixture.factId,
      targetType: memoryPurgeTargetType("MEMORY_FACT"),
      userId: fixture.userId
    };
    await expect(prisma.$transaction((tx) =>
      memoryProfileDeletionContributor.audit(tx, target))).resolves.toBe(1);
    await prisma.$transaction((tx) =>
      memoryProfileDeletionContributor.purge(tx, target));
    await expect(prisma.$transaction((tx) =>
      memoryProfileDeletionContributor.audit(tx, target))).resolves.toBe(0);
    await expect(prisma.memoryProfileProjection.findUniqueOrThrow({
      where: { id: fixture.profileId }
    })).resolves.toMatchObject({
      plaintextPurgedAt: expect.any(Date),
      purgeReason: "fact_forgotten",
      state: "INVALIDATED",
      summary: null
    });
  });
});
