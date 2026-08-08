import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import {
  loadKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionPlan
} from "../knowledge/runAdmission";
import { createPrismaKnowledgeRepository } from "../knowledge/prismaRepository";
import { createPrismaRunRepository } from "./prismaRepository";
import {
  KnowledgeRunPlanConflictError,
  type RunRepository
} from "./runRepositoryContract";

const enabled = process.env.AIQSA_KNOWLEDGE_RUN_INTEGRATION_TEST === "1";
const integration = enabled ? describe : describe.skip;
const database = new PrismaClient();
const knowledge = createPrismaKnowledgeRepository(database);
const runs = createPrismaRunRepository(database);
const suffix = randomUUID();
const ownerId = `knowledge-run-owner-${suffix}`;
const memberId = `knowledge-run-member-${suffix}`;
const groupId = `knowledge-run-group-${suffix}`;
const connectionId = `knowledge-run-connection-${suffix}`;
const credentialId = `knowledge-run-credential-${suffix}`;
const credentialVersionId = `knowledge-run-credential-version-${suffix}`;
const embeddingModelId = `knowledge-run-embedding-${suffix}`;
let knowledgeBaseId = "";
let publicationId = "";

function embeddingConfiguration() {
  return {
    adapterKind: "openai_embeddings_compatible",
    answerSelectable: false,
    capabilities: {
      contextWindow: 32_768,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      streaming: false,
      toolCalling: false,
      vision: false
    },
    defaultParams: {},
    embedding: {
      nativeDimension: 1_536,
      providerFamily: "openai_compatible",
      queryInstructionTemplate: null,
      supportsMrl: false,
      targetDimension: 1_536
    },
    modelClass: "embedding",
    upstreamModelId: "embedding-v1"
  } as const;
}

async function createChat(label: string): Promise<string> {
  return (await database.chat.create({
    data: { title: label, userId: memberId },
    select: { id: true }
  })).id;
}

function createRunInput(
  chatId: string,
  knowledgeAdmissionPlan: KnowledgeRunAdmissionPlan
): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("Use the admitted Knowledge base");
  return {
    chatId,
    content,
    expectedActiveLeafId: null,
    knowledgeAdmissionPlan,
    modelId: "fake-answer-model",
    normalizedRequest: {
      attachmentIds: [],
      chatId,
      content,
      knowledgePlan: {
        baseIds: [...knowledgeAdmissionPlan.knowledgePlan.baseIds]
      },
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      modelId: "fake-answer-model",
      params: {},
      prompt: { developer: null, system: "Knowledge run integration" },
      provider: "fake",
      searchStrategy: null
    },
    provider: "fake",
    providerRequestPreview: {},
    userId: memberId
  };
}

integration("Knowledge run binding transaction", () => {
  beforeAll(async () => {
    const now = new Date();
    await database.user.createMany({
      data: [
        {
          displayName: "Knowledge run owner",
          email: `${ownerId}@example.test`,
          id: ownerId,
          role: "admin",
          status: "active"
        },
        {
          displayName: "Knowledge run member",
          email: `${memberId}@example.test`,
          id: memberId,
          status: "active"
        }
      ]
    });
    await database.group.create({
      data: { id: groupId, name: `Knowledge run group ${suffix}` }
    });
    await database.userGroup.create({
      data: { groupId, userId: memberId }
    });
    await database.providerConnection.create({
      data: {
        activatedAt: now,
        activeConfig: {
          allowPrivateNetwork: false,
          apiRoot: "https://embedding.example.test/v1"
        },
        activeVersion: 1,
        displayName: "Knowledge run embedding endpoint",
        draftConfig: {},
        enabled: true,
        family: "openai_compatible",
        id: connectionId
      }
    });
    await database.providerCredential.create({
      data: {
        activatedAt: now,
        connectionId,
        enabled: true,
        id: credentialId,
        label: "Knowledge run credential",
        testedAt: now
      }
    });
    await database.providerCredentialVersion.create({
      data: {
        activatedAt: now,
        credentialId,
        id: credentialVersionId,
        secretEnvelope: "integration-fixture-envelope",
        testEvidence: { authenticationMode: "bearer" },
        testedAt: now,
        version: 1
      }
    });
    await database.providerCredential.update({
      data: { activeVersionId: credentialVersionId },
      where: { id: credentialId }
    });
    await database.providerConnection.update({
      data: { defaultCredentialId: credentialId },
      where: { id: connectionId }
    });
    const configuration = embeddingConfiguration();
    await database.providerModel.create({
      data: {
        activatedAt: now,
        activeConfig: configuration,
        activeVersion: 1,
        capabilities: configuration.capabilities,
        connectionId,
        contextWindow: 32_768,
        defaultParams: {},
        displayName: "Knowledge run embedding model",
        draftConfig: {},
        enabled: true,
        id: embeddingModelId,
        modelClass: "embedding",
        modelId: "embedding-v1",
        provider: "openai_compatible"
      }
    });
    await database.providerModelCredentialCheck.create({
      data: {
        checkedAt: now,
        connectionId,
        connectionVersion: 1,
        credentialId,
        credentialVersionId,
        evidence: {},
        modelVersion: 1,
        providerModelId: embeddingModelId,
        status: "available"
      }
    });
    await database.accessGrant.createMany({
      data: [
        { enabled: true, providerModelId: embeddingModelId, userId: ownerId },
        { enabled: true, providerModelId: embeddingModelId, userId: memberId }
      ]
    });

    const created = await knowledge.create(ownerId, {
      description: "A deliberately empty base for run admission",
      embeddingDeploymentId: embeddingModelId,
      name: "Knowledge run zero-document base"
    });
    if (created.kind !== "ok") {
      throw new Error(`Knowledge run base fixture failed: ${created.kind}`);
    }
    knowledgeBaseId = created.id;
    publicationId = (await database.knowledgeBasePublication.create({
      data: {
        groupId,
        knowledgeBaseId,
        publishedByUserId: ownerId,
        scope: "group"
      },
      select: { id: true }
    })).id;
  });

  afterAll(async () => {
    await database.chat.deleteMany({ where: { userId: memberId } });
    if (knowledgeBaseId) {
      await database.knowledgeBasePublication.deleteMany({
        where: { knowledgeBaseId }
      });
      await database.knowledgeBase.updateMany({
        data: { activeIndexGenerationId: null },
        where: { id: knowledgeBaseId }
      });
      await database.knowledgeIndexGeneration.deleteMany({
        where: { knowledgeBaseId }
      });
      await database.knowledgeBase.deleteMany({ where: { id: knowledgeBaseId } });
    }
    await database.providerModelCredentialCheck.deleteMany({
      where: { providerModelId: embeddingModelId }
    });
    await database.accessGrant.deleteMany({
      where: { userId: { in: [ownerId, memberId] } }
    });
    await database.providerModel.deleteMany({ where: { id: embeddingModelId } });
    await database.providerConnection.updateMany({
      data: { defaultCredentialId: null },
      where: { id: connectionId }
    });
    await database.providerCredential.updateMany({
      data: { activeVersionId: null },
      where: { id: credentialId }
    });
    await database.providerCredentialVersion.deleteMany({
      where: { id: credentialVersionId }
    });
    await database.providerCredential.deleteMany({ where: { id: credentialId } });
    await database.providerConnection.deleteMany({ where: { id: connectionId } });
    await database.userGroup.deleteMany({ where: { groupId } });
    await database.group.deleteMany({ where: { id: groupId } });
    await database.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
    await database.$disconnect();
  });

  it("persists immutable zero-document evidence and rolls back a stale accepted plan", async () => {
    expect(await database.knowledgeDocument.count({ where: { knowledgeBaseId } })).toBe(0);
    const acceptedPlan = await loadKnowledgeRunAdmissionPlan(database, {
      knowledgePlan: { baseIds: [knowledgeBaseId] },
      userId: memberId
    });
    const acceptedChatId = await createChat("Accepted Knowledge run");
    const accepted = await runs.createRun(createRunInput(acceptedChatId, acceptedPlan));
    const persistedBeforeMutation = await database.knowledgeRunBinding.findFirstOrThrow({
      where: { modelRunId: accepted.runId }
    });

    expect(persistedBeforeMutation).toMatchObject({
      baseContentRevision: 0,
      embeddingConnectionId: connectionId,
      embeddingCredentialId: credentialId,
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: credentialVersionId,
      embeddingProviderModelId: embeddingModelId,
      indexedContentRevision: 0,
      knowledgeBaseId,
      ordinal: 0,
      targetDimension: 1_536
    });
    expect(persistedBeforeMutation.embeddingExecutionSnapshot).toMatchObject({
      connectionId,
      credentialId,
      credentialVersionId,
      providerModelId: embeddingModelId
    });
    const inspection = await runs.getRunForUser(accepted.runId, memberId);
    expect(inspection).toMatchObject({
      knowledgeBindings: [{
        indexGenerationId: persistedBeforeMutation.indexGenerationId,
        knowledgeBaseId,
        ordinal: 0
      }],
      knowledgePlan: { baseIds: [knowledgeBaseId] }
    });
    expect(inspection?.knowledgeBindings?.[0]).not.toHaveProperty("embeddingCredentialId");
    expect(inspection?.knowledgeBindings?.[0]).not.toHaveProperty("embeddingExecutionSnapshot");

    await database.knowledgeBasePublication.delete({ where: { id: publicationId } });
    const rejectedChatId = await createChat("Rejected Knowledge run");
    await expect(
      runs.createRun(createRunInput(rejectedChatId, acceptedPlan))
    ).rejects.toBeInstanceOf(KnowledgeRunPlanConflictError);
    await expect(database.chat.findUniqueOrThrow({
      select: {
        _count: { select: { messages: true, modelRuns: true } },
        activeLeafMessageId: true
      },
      where: { id: rejectedChatId }
    })).resolves.toEqual({
      _count: { messages: 0, modelRuns: 0 },
      activeLeafMessageId: null
    });

    const oldGeneration = await database.knowledgeIndexGeneration.findUniqueOrThrow({
      where: { id: persistedBeforeMutation.indexGenerationId }
    });
    const changedAt = new Date();
    const replacement = await database.knowledgeIndexGeneration.create({
      data: {
        activatedAt: changedAt,
        chunkingProfileVersion: oldGeneration.chunkingProfileVersion,
        embeddingConfiguration: oldGeneration.embeddingConfiguration as Prisma.InputJsonValue,
        embeddingProviderModelId: oldGeneration.embeddingProviderModelId,
        indexedContentRevision: 1,
        knowledgeBaseId,
        readyAt: changedAt,
        status: "active",
        targetDimension: oldGeneration.targetDimension,
        vectorSpaceFingerprint: oldGeneration.vectorSpaceFingerprint.trim()
      }
    });
    await database.$transaction([
      database.knowledgeBase.update({
        data: {
          activeIndexGenerationId: replacement.id,
          archivedAt: changedAt,
          contentRevision: { increment: 1 }
        },
        where: { id: knowledgeBaseId }
      }),
      database.knowledgeIndexGeneration.update({
        data: { retiredAt: changedAt, status: "retired" },
        where: { id: oldGeneration.id }
      })
    ]);

    const persistedAfterMutation = await database.knowledgeRunBinding.findUniqueOrThrow({
      where: { id: persistedBeforeMutation.id }
    });
    expect(persistedAfterMutation).toEqual(persistedBeforeMutation);
    expect((await runs.getRunForUser(accepted.runId, memberId))?.knowledgeBindings?.[0])
      .toMatchObject({
        baseContentRevision: 0,
        indexGenerationId: oldGeneration.id,
        indexedContentRevision: 0
      });
  });
});
