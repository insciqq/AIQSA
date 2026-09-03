import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { pdfInputVerificationEvidence } from "../providers/pdfInputEvidence";
import { createPrismaProjectContentRepository } from "./contentRepository";
import { createPrismaProjectMemoryRepository } from "./memoryRepository";
import { createPrismaProjectRepository } from "./prismaRepository";

type ProjectFixture = Readonly<{
  ownerId: string;
  projectId: string;
  userIds: readonly string[];
}>;

async function withProjectFixture<T>(
  run: (fixture: ProjectFixture) => Promise<T>,
  additionalUsers = 0,
  preferredModelId?: string
): Promise<T> {
  const suffix = randomUUID();
  const ownerId = `project-owner-${suffix}`;
  const userIds = [ownerId, ...Array.from(
    { length: additionalUsers },
    (_, index) => `project-member-${index}-${suffix}`
  )];
  await prisma.user.createMany({
    data: userIds.map((id, index) => ({
      displayName: index === 0 ? "Project Owner" : `Project Member ${index}`,
      id,
      status: "active" as const
    }))
  });
  const repository = createPrismaProjectRepository(prisma);
  const created = await repository.create({
    actorDisplayName: "Project Owner",
    description: "Disposable Project integration fixture",
    name: `Project ${suffix}`,
    ...(preferredModelId ? { preferredModelId } : {}),
    userId: ownerId
  });
  if (created.kind !== "ok") throw new Error(`project_fixture_create_${created.kind}`);
  const projectId = created.value.id;

  try {
    return await run({ ownerId, projectId, userIds });
  } finally {
    await prisma.modelRun.deleteMany({ where: { chat: { projectId } } });
    await prisma.project.deleteMany({ where: { id: projectId } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

type AssistantSourceFixture = ProjectFixture & Readonly<{
  createAssistant: (sourceId: string) => Promise<Readonly<{
    assistantId: string;
    revisionId: string;
  }>>;
  foreignSourceId: string;
  notReadySourceId: string;
  readySourceId: string;
}>;

// Profile revisions are immutable, so the serialized stateful lane reuses one
// deterministic disposable revision instead of accumulating one per test.
const projectSourceProfileRevisionId = "project-assistant-direct-source-test-profile-v1";

async function withAssistantSourceFixture<T>(
  run: (fixture: AssistantSourceFixture) => Promise<T>
): Promise<T> {
  return withProjectFixture(async (project) => {
    const suffix = randomUUID();
    const foreignOwnerId = project.userIds[1]!;
    const readySourceId = `project-ready-source-${suffix}`;
    const notReadySourceId = `project-pending-source-${suffix}`;
    const foreignSourceId = `project-foreign-source-${suffix}`;
    const sourceIds = [readySourceId, notReadySourceId, foreignSourceId];
    const sourceVersionIds = sourceIds.map((sourceId) => `${sourceId}-v1`);
    const artifactIds = sourceIds.map((sourceId) => `${sourceId}-artifact`);
    const assistantIds: string[] = [];

    const previousProfile = await prisma.knowledgeIndexProfile.findUniqueOrThrow({
      select: { activeRevisionId: true },
      where: { id: "installation" }
    });
    try {
      const fixtureProfileRevision = await prisma.knowledgeIndexProfileRevision.findUnique({
        select: { id: true },
        where: { id: projectSourceProfileRevisionId }
      });
      if (!fixtureProfileRevision) {
        const latestRevision = await prisma.knowledgeIndexProfileRevision.findFirst({
          orderBy: { revisionNumber: "desc" },
          select: { revisionNumber: true },
          where: { profileId: "installation" }
        });
        await prisma.knowledgeIndexProfileRevision.create({
          data: {
            activatedAt: new Date(),
            chunkingProfileVersion: 1,
            egressPolicy: {},
            embeddingConfiguration: {},
            embeddingProviderModelId: providerTemplateIds.fakeModel,
            executionAuthority: "installation",
            id: projectSourceProfileRevisionId,
            preflightCheckedAt: new Date(),
            preflightStatus: "ready",
            profileConfiguration: {},
            profileId: "installation",
            revisionNumber: (latestRevision?.revisionNumber ?? 0) + 1,
            targetDimension: 8,
            vectorSpaceFingerprint: "9".repeat(64)
          }
        });
      }
      await prisma.knowledgeIndexProfile.update({
        data: { activeRevisionId: projectSourceProfileRevisionId },
        where: { id: "installation" }
      });

      const owners = [project.ownerId, project.ownerId, foreignOwnerId];
      for (const [index, sourceId] of sourceIds.entries()) {
        const ownerUserId = owners[index]!;
        const sourceVersionId = sourceVersionIds[index]!;
        const artifactId = artifactIds[index]!;
        await prisma.knowledgeSource.create({
          data: {
            description: `Direct Source fixture ${index}`,
            id: sourceId,
            name: index === 0
              ? "Ready direct Project Source"
              : index === 1 ? "Pending direct Project Source" : "Foreign direct Project Source",
            ownerUserId
          }
        });
        await prisma.knowledgeSourceVersion.create({
          data: {
            byteSize: 128,
            checksum: String(index + 1).repeat(64),
            fileName: `project-source-${index}.md`,
            id: sourceVersionId,
            mimeType: "text/markdown",
            ownerUserId,
            sourceId,
            versionNumber: 1
          }
        });
        await prisma.knowledgeSource.update({
          data: { currentVersionId: sourceVersionId },
          where: { id: sourceId }
        });
        await prisma.knowledgeSourceIndexArtifact.create({
          data: index === 1
            ? {
                id: artifactId,
                processingStage: "queued",
                profileRevisionId: projectSourceProfileRevisionId,
                sourceVersionId,
                state: "pending"
              }
            : {
                chunkCount: 1,
                embeddedPassageCount: 1,
                id: artifactId,
                normalizedTextByteSize: 64,
                normalizedTextChecksum: "a".repeat(64),
                normalizedTextStorageKey: `project-source/${sourceId}/normalized`,
                pageCount: 1,
                profileRevisionId: projectSourceProfileRevisionId,
                readyAt: new Date(),
                sourceVersionId,
                state: "ready"
              }
        });
        if (index !== 1) {
          await prisma.knowledgeHierarchicalIndexArtifact.create({
            data: {
              checksum: "b".repeat(64),
              derivationMode: "normalized_v2",
              documentCount: 1,
              exactEntryCount: 1,
              id: `${artifactId}-hierarchy`,
              passageCount: 1,
              readyAt: new Date(),
              schemaVersion: 2,
              sectionCount: 1,
              sourceArtifactId: artifactId,
              sourceVersionId,
              state: "ready"
            }
          });
        }
      }

      const createAssistant = async (sourceId: string) => {
        const assistant = await prisma.assistantDefinition.create({
          data: { ownerUserId: project.ownerId },
          select: { id: true }
        });
        assistantIds.push(assistant.id);
        const revision = await prisma.assistantRevision.create({
          data: {
            assistantId: assistant.id,
            authorUserId: project.ownerId,
            avatar: {
              accents: [0, 4],
              backgroundShape: "circle",
              foregroundShape: "diamond",
              kind: "generated",
              paletteId: "ocean",
              recipeVersion: 1,
              rotations: [0, 2]
            },
            knowledgeSelection: {
              baseIds: [],
              mode: "explicit",
              sourceIds: [sourceId],
              version: 1
            },
            name: `Direct Source Assistant ${assistantIds.length}`,
            providerModelId: providerTemplateIds.fakeModel,
            revisionNumber: 1,
            runControls: {},
            searchPlan: { mode: "all_selected", optionIds: [] },
            systemPrompt: "Use the explicitly selected direct Source."
          },
          select: { id: true }
        });
        await prisma.assistantDefinition.update({
          data: { currentRevisionId: revision.id },
          where: { id: assistant.id }
        });
        return { assistantId: assistant.id, revisionId: revision.id };
      };

      return await run({
        ...project,
        createAssistant,
        foreignSourceId,
        notReadySourceId,
        readySourceId
      });
    } finally {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL aiqsa.knowledge_purge = 'on'`;
        await tx.projectAssistantBinding.deleteMany({ where: { projectId: project.projectId } });
        await tx.projectKnowledgeSourceBinding.deleteMany({ where: { projectId: project.projectId } });
        await tx.assistantDefinition.updateMany({
          data: { currentRevisionId: null },
          where: { id: { in: assistantIds } }
        });
        await tx.assistantRevision.deleteMany({ where: { assistantId: { in: assistantIds } } });
        await tx.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
        await tx.knowledgeSource.updateMany({
          data: { currentVersionId: null, pendingVersionId: null },
          where: { id: { in: sourceIds } }
        });
        await tx.knowledgeSourceIndexArtifact.deleteMany({ where: { id: { in: artifactIds } } });
        await tx.knowledgeSourceVersion.deleteMany({ where: { id: { in: sourceVersionIds } } });
        await tx.knowledgeSource.deleteMany({ where: { id: { in: sourceIds } } });
        await tx.knowledgeIndexProfile.update({
          data: { activeRevisionId: previousProfile.activeRevisionId },
          where: { id: "installation" }
        });
      });
    }
  }, 1, providerTemplateIds.fakeModel);
}

describe("Prisma-backed Project repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("atomically bootstraps the Owner, preferred eligible model, default, and outbox event", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const detail = await createPrismaProjectRepository(prisma).getDetail(ownerId, projectId);
      expect(detail).toMatchObject({
        defaults: { providerModelId: providerTemplateIds.fakeModel },
        directRole: "OWNER",
        effectiveRole: "OWNER",
        readiness: "READY"
      });
      await expect(prisma.projectGrant.count({
        where: { projectId, role: "OWNER", userId: ownerId }
      })).resolves.toBe(1);
      await expect(prisma.projectModelBinding.count({
        where: { projectId, providerModelId: providerTemplateIds.fakeModel }
      })).resolves.toBe(1);
      await expect(prisma.projectEvent.findMany({
        select: { eventType: true },
        where: { projectId }
      })).resolves.toContainEqual({ eventType: "project_created" });
    }, 0, providerTemplateIds.fakeModel);
  });

  it("publishes direct PDF input only from exact active credential evidence", async () => {
    const suffix = randomUUID();
    const connectionId = `project-pdf-connection-${suffix}`;
    const credentialId = `project-pdf-credential-${suffix}`;
    const credentialVersionId = `project-pdf-credential-version-${suffix}`;
    const modelId = `project-pdf-model-${suffix}`;
    const upstreamModelId = `project-pdf-upstream-${suffix}`;
    const now = new Date("2026-08-23T08:00:00.000Z");
    const connectionConfiguration = {
      allowPrivateNetwork: false,
      apiRoot: "https://project-pdf-provider.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    };
    const modelConfiguration = {
      adapterKind: "openai_responses_compatible",
      answerSelectable: true,
      capabilities: {
        nativePdfInput: true,
        nativeSearch: false,
        pdf: true,
        reasoning: false,
        streaming: false,
        toolCalling: false,
        vision: true
      },
      defaultParams: {},
      modelClass: "answer",
      upstreamModelId
    };

    await prisma.providerConnection.create({
      data: {
        activeConfig: connectionConfiguration,
        activeVersion: 1,
        activatedAt: now,
        displayName: "Project direct PDF provider",
        draftConfig: connectionConfiguration,
        draftVersion: 1,
        enabled: true,
        family: "openai_compatible",
        id: connectionId,
        unassignedPolicy: "use_default"
      }
    });
    await prisma.providerCredential.create({
      data: {
        activatedAt: now,
        connectionId,
        draftVersion: 1,
        enabled: true,
        id: credentialId,
        label: "Project direct PDF account",
        testedAt: now
      }
    });
    await prisma.providerCredentialVersion.create({
      data: {
        activatedAt: now,
        credentialId,
        id: credentialVersionId,
        secretEnvelope: "test-only-envelope",
        testedAt: now,
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
        activeConfig: modelConfiguration,
        activeVersion: 1,
        activatedAt: now,
        capabilities: modelConfiguration.capabilities,
        connectionId,
        defaultParams: {},
        displayName: "Project direct PDF model",
        draftConfig: modelConfiguration,
        draftVersion: 1,
        enabled: true,
        id: modelId,
        modelClass: "answer",
        modelId: upstreamModelId,
        provider: "openai_compatible",
        supportsPdf: true,
        supportsVision: true
      }
    });
    const check = await prisma.providerModelCredentialCheck.create({
      data: {
        checkedAt: now,
        connectionId,
        connectionVersion: 1,
        credentialId,
        credentialVersionId,
        evidence: {
          pdfInput: pdfInputVerificationEvidence(
            modelConfiguration.adapterKind,
            upstreamModelId
          )
        },
        modelVersion: 1,
        providerModelId: modelId,
        status: "available"
      }
    });

    try {
      await withProjectFixture(async ({ ownerId, projectId }) => {
        const repository = createPrismaProjectRepository(prisma);
        const verified = await repository.getDetail(ownerId, projectId);
        expect(verified?.composer?.catalog.models).toContainEqual(expect.objectContaining({
          capabilities: expect.objectContaining({ documentInputMode: "native_pdf" }),
          modelId
        }));

        await prisma.providerModelCredentialCheck.update({
          data: { evidence: {} },
          where: { id: check.id }
        });

        const unverified = await repository.getDetail(ownerId, projectId);
        expect(unverified?.composer?.catalog.models).toContainEqual(expect.objectContaining({
          capabilities: expect.objectContaining({ documentInputMode: "pdf_text_extraction" }),
          modelId
        }));
      }, 0, modelId);
    } finally {
      await prisma.providerModelCredentialCheck.deleteMany({ where: { providerModelId: modelId } });
      await prisma.providerModel.deleteMany({ where: { id: modelId } });
      await prisma.providerConnection.update({
        data: { defaultCredentialId: null },
        where: { id: connectionId }
      });
      await prisma.providerCredential.update({
        data: { activeVersionId: null },
        where: { id: credentialId }
      });
      await prisma.providerCredentialVersion.deleteMany({ where: { id: credentialVersionId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
      await prisma.providerConnection.deleteMany({ where: { id: connectionId } });
    }
  });

  it("writes durable Project outbox rows for run artifacts and tool checkpoints", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Project Owner",
          createdByUserId: ownerId,
          memoryMode: "EXCLUDED",
          projectId,
          title: "Run outbox",
          userId: null
        }
      });
      const message = await prisma.message.create({
        data: {
          authorDisplayName: "Project Owner",
          authorProjectRole: "OWNER",
          authorUserId: ownerId,
          chatId: chat.id,
          content: { blocks: [{ text: "Shared question", type: "text" }] },
          role: "user"
        }
      });
      const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
      const run = await prisma.$transaction(async (tx) => {
        const created = await tx.modelRun.create({
          data: {
            chatId: chat.id,
            modelId: "fake-qsa",
            normalizedRequest: {},
            provider: "fake",
            status: "streaming",
            userId: ownerId,
            userMessageId: message.id
          }
        });
        await tx.projectRunBinding.create({
          data: {
            acceptedRole: "OWNER",
            accessRevision: project.accessRevision,
            initiatorUserId: ownerId,
            instructionsRevision: project.instructionsRevision,
            memoryRevision: project.memoryRevision,
            modelRunId: created.id,
            personalMemoryDisabled: true,
            policyRevision: project.policyRevision,
            projectId,
            providerAdmissionFingerprint: "a".repeat(64),
            providerConnectionId: providerTemplateIds.fakeConnection,
            providerModelId: providerTemplateIds.fakeModel,
            providerRequiresClientTools: false,
            providerSearchPlan: { mode: "all_selected", optionIds: [] }
          }
        });
        return created;
      });
      const before = await prisma.projectEvent.count({ where: { projectId } });

      await prisma.modelRunEvent.create({
        data: {
          eventType: "artifact",
          modelRunId: run.id,
          payload: { artifactType: "search", payload: { action: { sources: [] } } },
          sequence: 0
        }
      });
      const toolCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: {},
          modelRunId: run.id,
          ordinal: 0,
          providerCallId: "call-1",
          roundIndex: 0,
          toolName: "safe_tool"
        }
      });
      await prisma.modelRunToolCall.update({
        data: { result: { status: "complete" }, state: "complete" },
        where: { id: toolCall.id }
      });

      const events = await prisma.projectEvent.findMany({
        orderBy: { sequence: "asc" },
        select: { entityId: true, entityType: true, eventType: true },
        skip: before,
        where: { projectId }
      });
      expect(events).toEqual([
        { entityId: run.id, entityType: "run", eventType: "run_output_changed" },
        { entityId: run.id, entityType: "run", eventType: "run_tool_changed" },
        { entityId: run.id, entityType: "run", eventType: "run_tool_changed" }
      ]);
    });
  });

  it("omits a disabled resource identity and clears it from the safe defaults projection", async () => {
    const original = await prisma.providerModel.findUniqueOrThrow({
      select: { enabled: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    try {
      await withProjectFixture(async ({ ownerId, projectId }) => {
        await prisma.providerModel.update({
          data: { enabled: false },
          where: { id: providerTemplateIds.fakeModel }
        });
        const detail = await createPrismaProjectRepository(prisma).getDetail(ownerId, projectId);

        expect(detail).toMatchObject({
          defaults: { providerModelId: null },
          readiness: "SETUP_REQUIRED"
        });
        expect(detail?.resources).toEqual([]);
        expect(JSON.stringify(detail)).not.toContain(providerTemplateIds.fakeModel);
        expect(JSON.stringify(detail)).not.toContain("Fake QSA");
      }, 0, providerTemplateIds.fakeModel);
    } finally {
      await prisma.providerModel.update({
        data: { enabled: original.enabled },
        where: { id: providerTemplateIds.fakeModel }
      });
    }
  });

  it("does not treat installation can-use publication as Project delegation authority", async () => {
    await withProjectFixture(async ({ ownerId, projectId, userIds }) => {
      const foreignOwnerId = userIds[1]!;
      const skill = await prisma.skillDefinition.create({
        data: { ownerUserId: foreignOwnerId }
      });
      const revision = await prisma.skillRevision.create({
        data: {
          authorUserId: foreignOwnerId,
          instructions: "Private owner instructions",
          name: "Foreign installation skill",
          revisionNumber: 1,
          skillId: skill.id
        }
      });
      await prisma.skillDefinition.update({
        data: { currentRevisionId: revision.id },
        where: { id: skill.id }
      });
      await prisma.skillPublication.create({
        data: {
          publishedByUserId: foreignOwnerId,
          scope: "installation",
          skillId: skill.id
        }
      });

      try {
        const repository = createPrismaProjectRepository(prisma);
        const detail = await repository.getDetail(ownerId, projectId);
        if (!detail) throw new Error("project_fixture_detail_missing");
        const candidates = await repository.candidates({
          limit: 20,
          projectId,
          query: "Foreign",
          type: "skill",
          userId: ownerId
        });
        expect(candidates?.items).toEqual([]);
        await expect(repository.addResource({
          actorDisplayName: "Project Owner",
          expectedPolicyRevision: detail.policyRevision,
          projectId,
          resourceId: skill.id,
          type: "skill",
          userId: ownerId
        })).resolves.toEqual({ kind: "unavailable", reason: "project_skill_unavailable" });
        await expect(prisma.projectSkillBinding.count({
          where: { projectId, skillId: skill.id }
        })).resolves.toBe(0);
      } finally {
        await prisma.skillPublication.deleteMany({ where: { skillId: skill.id } });
        await prisma.skillDefinition.update({
          data: { currentRevisionId: null },
          where: { id: skill.id }
        });
        await prisma.skillRevision.deleteMany({ where: { skillId: skill.id } });
        await prisma.skillDefinition.delete({ where: { id: skill.id } });
      }
    }, 1);
  });

  it("publishes an Assistant direct Source without creating a proxy Base and remains idempotent", async () => {
    await withAssistantSourceFixture(async ({
      createAssistant,
      ownerId,
      projectId,
      readySourceId
    }) => {
      const repository = createPrismaProjectRepository(prisma);
      const assistant = await createAssistant(readySourceId);
      const initial = await repository.getDetail(ownerId, projectId);
      if (!initial) throw new Error("project_source_fixture_detail_missing");
      const initialBaseCount = await prisma.projectKnowledgeBaseBinding.count({
        where: { projectId }
      });

      const preview = await repository.previewResourceChange({
        action: "add",
        expectedPolicyRevision: initial.policyRevision,
        projectId,
        resourceId: assistant.assistantId,
        type: "assistant",
        userId: ownerId
      });
      expect(preview).toMatchObject({
        kind: "ok",
        value: {
          canCommit: true,
          dependencies: expect.arrayContaining([{
            label: "Ready direct Project Source",
            reason: null,
            state: "will_add",
            type: "knowledge"
          }]),
          revisionId: assistant.revisionId
        }
      });

      const added = await repository.addResource({
        actorDisplayName: "Project Owner",
        expectedPolicyRevision: initial.policyRevision,
        projectId,
        resourceId: assistant.assistantId,
        revisionId: assistant.revisionId,
        type: "assistant",
        userId: ownerId
      });
      expect(added.kind).toBe("ok");
      if (added.kind !== "ok") throw new Error(`project_source_add_${added.kind}`);
      expect(added.value).toEqual(expect.arrayContaining([
        expect.objectContaining({
          resourceId: assistant.assistantId,
          revisionId: assistant.revisionId,
          type: "assistant"
        })
      ]));
      await expect(prisma.projectKnowledgeSourceBinding.findUnique({
        where: { projectId_sourceId: { projectId, sourceId: readySourceId } }
      })).resolves.toMatchObject({ addedByUserId: ownerId, projectId, sourceId: readySourceId });
      await expect(prisma.projectKnowledgeBaseBinding.count({
        where: { projectId }
      })).resolves.toBe(initialBaseCount);

      const afterFirstCommit = await repository.getDetail(ownerId, projectId);
      if (!afterFirstCommit) throw new Error("project_source_fixture_detail_after_add_missing");
      expect(afterFirstCommit.composer?.knowledgeSources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: readySourceId, readiness: "ready" })
      ]));
      expect(afterFirstCommit.composer?.knowledgeDocumentTotal)
        .toBe(afterFirstCommit.composer?.knowledgeSources.length);
      expect(afterFirstCommit.composer?.assistants).toEqual(expect.arrayContaining([
        expect.objectContaining({
          revision: expect.objectContaining({
            knowledgeSelection: expect.objectContaining({
              mode: "explicit",
              sourceIds: [readySourceId]
            })
          }),
          summary: expect.objectContaining({
            fingerprint: expect.objectContaining({
              knowledgeLabel: "Knowledge · 1",
              knowledgeResourceCount: 1
            }),
            id: assistant.assistantId
          })
        })
      ]));
      await expect(repository.previewResourceChange({
        action: "add",
        expectedPolicyRevision: afterFirstCommit.policyRevision,
        projectId,
        resourceId: assistant.assistantId,
        type: "assistant",
        userId: ownerId
      })).resolves.toMatchObject({
        kind: "ok",
        value: {
          canCommit: true,
          dependencies: expect.arrayContaining([expect.objectContaining({
            label: "Ready direct Project Source",
            state: "active"
          })])
        }
      });

      await expect(repository.addResource({
        actorDisplayName: "Project Owner",
        expectedPolicyRevision: afterFirstCommit.policyRevision,
        projectId,
        resourceId: assistant.assistantId,
        revisionId: assistant.revisionId,
        type: "assistant",
        userId: ownerId
      })).resolves.toMatchObject({ kind: "ok" });
      await expect(prisma.projectKnowledgeSourceBinding.count({
        where: { projectId, sourceId: readySourceId }
      })).resolves.toBe(1);
      await expect(prisma.projectKnowledgeBaseBinding.count({
        where: { projectId }
      })).resolves.toBe(initialBaseCount);
    });
  });

  it("fails closed for invalid, foreign, and not-ready Assistant direct Sources", async () => {
    await withAssistantSourceFixture(async ({
      createAssistant,
      foreignSourceId,
      notReadySourceId,
      ownerId,
      projectId
    }) => {
      const repository = createPrismaProjectRepository(prisma);
      const initial = await repository.getDetail(ownerId, projectId);
      if (!initial) throw new Error("project_source_fixture_detail_missing");
      const cases = [
        { label: "invalid", sourceId: `missing-source-${randomUUID()}` },
        { label: "foreign", sourceId: foreignSourceId },
        { label: "not_ready", sourceId: notReadySourceId }
      ];

      for (const candidate of cases) {
        const assistant = await createAssistant(candidate.sourceId);
        const preview = await repository.previewResourceChange({
          action: "add",
          expectedPolicyRevision: initial.policyRevision,
          projectId,
          resourceId: assistant.assistantId,
          type: "assistant",
          userId: ownerId
        });
        expect(preview, candidate.label).toMatchObject({
          kind: "ok",
          value: {
            canCommit: false,
            dependencies: expect.arrayContaining([expect.objectContaining({
              state: "ineligible",
              type: "knowledge"
            })])
          }
        });
        await expect(repository.addResource({
          actorDisplayName: "Project Owner",
          expectedPolicyRevision: initial.policyRevision,
          projectId,
          resourceId: assistant.assistantId,
          revisionId: assistant.revisionId,
          type: "assistant",
          userId: ownerId
        }), candidate.label).resolves.toEqual({
          kind: "unavailable",
          reason: "project_assistant_dependency_unavailable"
        });
      }

      await expect(prisma.projectKnowledgeSourceBinding.count({
        where: { projectId }
      })).resolves.toBe(0);
      await expect(prisma.projectAssistantBinding.count({
        where: { projectId }
      })).resolves.toBe(0);
      await expect(prisma.projectKnowledgeBaseBinding.count({
        where: { projectId }
      })).resolves.toBe(0);
      await expect(prisma.project.findUniqueOrThrow({
        select: { policyRevision: true },
        where: { id: projectId }
      })).resolves.toEqual({ policyRevision: initial.policyRevision });
    });
  });

  it("rolls back stale unlink and atomically clears Project and chat defaults on commit", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const repository = createPrismaProjectRepository(prisma);
      const content = createPrismaProjectContentRepository(prisma);
      const detail = await repository.getDetail(ownerId, projectId);
      if (!detail) throw new Error("project_fixture_detail_missing");
      const model = detail.resources.find((resource) =>
        resource.type === "model" && resource.resourceId === providerTemplateIds.fakeModel
      );
      if (!model) throw new Error("project_fixture_model_missing");
      const createdChat = await content.createChat({
        actorDisplayName: "Project Owner",
        projectId,
        title: "Default cleanup",
        userId: ownerId
      });
      if (createdChat.kind !== "ok") throw new Error(`project_chat_${createdChat.kind}`);
      const eventsBefore = await prisma.projectEvent.count({ where: { projectId } });

      await expect(repository.removeResource({
        actorDisplayName: "Project Owner",
        bindingId: model.id,
        expectedPolicyRevision: detail.policyRevision - 1,
        projectId,
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "policy_revision_conflict" });
      await expect(prisma.projectEvent.count({ where: { projectId } })).resolves.toBe(eventsBefore);

      await expect(repository.removeResource({
        actorDisplayName: "Project Owner",
        bindingId: model.id,
        expectedPolicyRevision: detail.policyRevision,
        projectId,
        userId: ownerId
      })).resolves.toEqual({ kind: "ok", value: { id: model.id } });
      const stored = await prisma.project.findUniqueOrThrow({
        select: { defaults: true },
        where: { id: projectId }
      });
      expect(stored.defaults).toMatchObject({ providerModelId: null });
      await expect(prisma.chat.findUniqueOrThrow({
        select: { defaultProviderModelId: true },
        where: { id: createdChat.value.id }
      })).resolves.toEqual({ defaultProviderModelId: null });
      await expect(prisma.projectEvent.count({ where: { projectId } })).resolves.toBeGreaterThan(eventsBefore);
      const activity = await repository.activity({ limit: 20, projectId, userId: ownerId });
      expect(JSON.stringify(activity)).not.toContain(providerTemplateIds.fakeModel);
    }, 0, providerTemplateIds.fakeModel);
  });

  it("counts only active direct Owners when protecting the last Owner", async () => {
    await withProjectFixture(async ({ ownerId, projectId, userIds }) => {
      const repository = createPrismaProjectRepository(prisma);
      const secondOwnerId = userIds[1]!;
      const initial = await repository.getDetail(ownerId, projectId);
      if (!initial) throw new Error("project_fixture_detail_missing");
      const secondOwner = await repository.addGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: initial.accessRevision,
        projectId,
        role: "OWNER",
        targetUserId: secondOwnerId,
        userId: ownerId
      });
      expect(secondOwner.kind).toBe("ok");

      await prisma.user.update({
        data: { status: "disabled" },
        where: { id: secondOwnerId }
      });
      const directOwner = await prisma.projectGrant.findFirstOrThrow({
        where: { projectId, role: "OWNER", userId: ownerId }
      });
      const afterDisable = await repository.getDetail(ownerId, projectId);
      if (!afterDisable) throw new Error("project_fixture_detail_missing");

      await expect(repository.updateGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: afterDisable.accessRevision,
        grantId: directOwner.id,
        projectId,
        role: "MANAGER",
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "last_owner_required" });
    }, 1);
  });

  it("uses access and policy revisions as mutation CAS baselines", async () => {
    await withProjectFixture(async ({ ownerId, projectId, userIds }) => {
      const repository = createPrismaProjectRepository(prisma);
      const initial = await repository.getDetail(ownerId, projectId);
      if (!initial) throw new Error("project_fixture_detail_missing");

      await expect(repository.addGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: initial.accessRevision - 1,
        projectId,
        role: "CONTRIBUTOR",
        targetUserId: userIds[1],
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "access_revision_conflict" });

      const added = await repository.addGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: initial.accessRevision,
        projectId,
        role: "CONTRIBUTOR",
        targetUserId: userIds[1],
        userId: ownerId
      });
      if (added.kind !== "ok") throw new Error(`project_fixture_grant_${added.kind}`);
      const afterAdd = await repository.getDetail(ownerId, projectId);
      if (!afterAdd) throw new Error("project_fixture_detail_missing_after_add");
      expect(afterAdd.accessRevision).toBe(initial.accessRevision + 1);

      await expect(repository.updateGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: initial.accessRevision,
        grantId: added.value.id,
        projectId,
        role: "VIEWER",
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "access_revision_conflict" });

      const updated = await repository.updateGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: afterAdd.accessRevision,
        grantId: added.value.id,
        projectId,
        role: "VIEWER",
        userId: ownerId
      });
      expect(updated.kind).toBe("ok");
      const afterUpdate = await repository.getDetail(ownerId, projectId);
      if (!afterUpdate) throw new Error("project_fixture_detail_missing_after_update");
      expect(afterUpdate.accessRevision).toBe(afterAdd.accessRevision + 1);

      const removed = await repository.removeGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: afterUpdate.accessRevision,
        grantId: added.value.id,
        projectId,
        userId: ownerId
      });
      expect(removed.kind).toBe("ok");
      const afterRemove = await repository.getDetail(ownerId, projectId);
      if (!afterRemove) throw new Error("project_fixture_detail_missing_after_remove");
      expect(afterRemove.accessRevision).toBe(afterUpdate.accessRevision + 1);

      const readded = await repository.addGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: afterRemove.accessRevision,
        projectId,
        role: "CONTRIBUTOR",
        targetUserId: userIds[1],
        userId: ownerId
      });
      expect(readded.kind).toBe("ok");
      const memberDetail = await repository.getDetail(userIds[1]!, projectId);
      if (!memberDetail) throw new Error("project_fixture_member_detail_missing");
      const left = await repository.leave({
        actorDisplayName: "Project Member 1",
        expectedAccessRevision: memberDetail.accessRevision,
        projectId,
        userId: userIds[1]!
      });
      expect(left).toEqual({ kind: "ok", value: { accessRemaining: false } });
      const afterLeave = await prisma.project.findUniqueOrThrow({
        select: { accessRevision: true },
        where: { id: projectId }
      });
      expect(afterLeave.accessRevision).toBe(memberDetail.accessRevision + 1);
      await expect(prisma.projectEvent.findFirstOrThrow({
        orderBy: { sequence: "desc" },
        select: { accessRevision: true, eventType: true },
        where: { projectId }
      })).resolves.toEqual({
        accessRevision: afterLeave.accessRevision,
        eventType: "user_left_project"
      });

      const policyUpdate = await repository.update({
        actorDisplayName: "Project Owner",
        expectedPolicyRevision: initial.policyRevision,
        policy: { externalToolsEnabled: false },
        projectId,
        userId: ownerId
      });
      expect(policyUpdate.kind).toBe("ok");
      await expect(repository.update({
        actorDisplayName: "Project Owner",
        expectedPolicyRevision: initial.policyRevision,
        policy: { externalToolsEnabled: true },
        projectId,
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "policy_revision_conflict" });
    }, 1);
  });

  it("keeps archived Projects read-only until an Owner restores them", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const repository = createPrismaProjectRepository(prisma);
      const initial = await repository.getDetail(ownerId, projectId);
      if (!initial) throw new Error("project_fixture_detail_missing");
      const archived = await repository.update({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: initial.accessRevision,
        projectId,
        status: "ARCHIVED",
        userId: ownerId
      });
      if (archived.kind !== "ok") throw new Error(`project_archive_${archived.kind}`);

      await expect(repository.update({
        actorDisplayName: "Project Owner",
        description: "Archived mutation",
        projectId,
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "project_archived" });

      const restored = await repository.update({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: archived.value.accessRevision,
        projectId,
        status: "ACTIVE",
        userId: ownerId
      });
      expect(restored).toMatchObject({ kind: "ok", value: { status: "ACTIVE" } });
    });
  });

  it("retains shared message history while still allowing branching", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Project Owner",
          createdByUserId: ownerId,
          memoryMode: "EXCLUDED",
          projectId,
          title: "Shared history",
          userId: null
        }
      });
      const message = await prisma.message.create({
        data: {
          authorDisplayName: "Project Owner",
          authorProjectRole: "OWNER",
          authorUserId: ownerId,
          chatId: chat.id,
          content: { blocks: [{ text: "Keep this shared question", type: "text" }] },
          role: "user",
          status: "complete"
        }
      });
      const repository = createPrismaMessageBranchRepository(prisma);

      await expect(repository.deleteMessageSubtree({
        messageId: message.id,
        userId: ownerId
      })).resolves.toBeNull();
      await expect(prisma.message.count({ where: { chatId: chat.id } })).resolves.toBe(1);
    });
  });

  it("keeps dormant Project Memory fact writes fail closed without persisting evidence", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Project Owner",
          createdByUserId: ownerId,
          memoryMode: "EXCLUDED",
          projectId,
          title: "Memory evidence",
          userId: null
        }
      });
      const message = await prisma.message.create({
        data: {
          authorDisplayName: "Project Owner",
          authorProjectRole: "OWNER",
          authorUserId: ownerId,
          chatId: chat.id,
          content: { blocks: [{ text: "Deploy on Tuesdays.", type: "text" }] },
          role: "user",
          status: "complete"
        }
      });

      await expect(createPrismaProjectMemoryRepository(prisma).createFact({
        actorDisplayName: "Project Owner",
        projectId,
        sourceMessageId: message.id,
        text: "The team deploys on Tuesdays.",
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "project_memory_disabled" });
      await expect(prisma.projectMemoryFact.count({ where: { projectId } })).resolves.toBe(0);
      await expect(prisma.projectMemoryFactVersion.count({
        where: { projectId, sourceMessageId: message.id }
      })).resolves.toBe(0);
    });
  });

  it("keeps dormant Project Memory proposals fail closed without persisting user-message evidence", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Project Owner",
          createdByUserId: ownerId,
          memoryMode: "EXCLUDED",
          projectId,
          title: "Proposal authority",
          userId: null
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          authorDisplayName: "Project Owner",
          authorProjectRole: "OWNER",
          authorUserId: ownerId,
          chatId: chat.id,
          content: { blocks: [{ text: "The release window is Tuesday.", type: "text" }] },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: { blocks: [{ text: "Retrieved output must not authorize Memory.", type: "text" }] },
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "complete"
        }
      });
      const memory = createPrismaProjectMemoryRepository(prisma);

      await expect(memory.propose({
        actorDisplayName: "Project Owner",
        projectId,
        sourceMessageId: assistantMessage.id,
        text: "Do not accept this assistant text.",
        userId: ownerId
      })).resolves.toEqual({ kind: "not_found" });
      await expect(memory.propose({
        actorDisplayName: "Project Owner",
        projectId,
        sourceMessageId: userMessage.id,
        text: "The release window is Tuesday.",
        userId: ownerId
      })).resolves.toEqual({ kind: "conflict", reason: "project_memory_disabled" });
      await expect(prisma.projectMemoryProposal.count({
        where: { projectId }
      })).resolves.toBe(0);
    });
  });

  it("preserves Project authorship snapshots and run evidence after an initiator is deleted", async () => {
    await withProjectFixture(async ({ ownerId, projectId, userIds }) => {
      const memberId = userIds[1]!;
      const repository = createPrismaProjectRepository(prisma);
      const initial = await repository.getDetail(ownerId, projectId);
      if (!initial) throw new Error("project_fixture_detail_missing");
      const granted = await repository.addGrant({
        actorDisplayName: "Project Owner",
        expectedAccessRevision: initial.accessRevision,
        projectId,
        role: "CONTRIBUTOR",
        targetUserId: memberId,
        userId: ownerId
      });
      if (granted.kind !== "ok") throw new Error(`project_fixture_grant_${granted.kind}`);
      const accepted = await repository.getDetail(memberId, projectId);
      if (!accepted) throw new Error("project_fixture_member_detail_missing");

      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Project Member 1",
          createdByUserId: memberId,
          memoryMode: "EXCLUDED",
          projectId,
          title: "Durable shared evidence",
          userId: null
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          authorDisplayName: "Project Member 1",
          authorProjectRole: "CONTRIBUTOR",
          authorUserId: memberId,
          chatId: chat.id,
          content: { blocks: [{ text: "Keep my attribution", type: "text" }] },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: { blocks: [{ text: "Keep the accepted answer", type: "text" }] },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "complete"
        }
      });
      const run = await prisma.$transaction(async (tx) => {
        const created = await tx.modelRun.create({
          data: {
            assistantMessageId: assistantMessage.id,
            chatId: chat.id,
            modelId: "fake-qsa",
            normalizedRequest: {},
            provider: "fake",
            status: "complete",
            userId: memberId,
            userMessageId: userMessage.id
          }
        });
        await tx.projectRunBinding.create({
          data: {
            acceptedRole: "CONTRIBUTOR",
            accessRevision: accepted.accessRevision,
            initiatorUserId: memberId,
            instructionsRevision: accepted.instructionsRevision,
            memoryRevision: accepted.memoryRevision,
            modelRunId: created.id,
            personalMemoryDisabled: true,
            policyRevision: accepted.policyRevision,
            projectId
          }
        });
        return created;
      });

      await prisma.user.delete({ where: { id: memberId } });

      await expect(prisma.chat.findUnique({ where: { id: chat.id } })).resolves.not.toBeNull();
      await expect(prisma.message.findUnique({
        select: {
          authorDisplayName: true,
          authorProjectRole: true,
          authorUserId: true
        },
        where: { id: userMessage.id }
      })).resolves.toEqual({
        authorDisplayName: "Project Member 1",
        authorProjectRole: "CONTRIBUTOR",
        authorUserId: null
      });
      await expect(prisma.modelRun.findUnique({ where: { id: run.id } })).resolves.not.toBeNull();
      await expect(prisma.projectRunBinding.findUnique({
        where: { modelRunId: run.id }
      })).resolves.toMatchObject({ initiatorUserId: memberId, projectId });

      // Fixture cleanup may remove the restrictive evidence only after the
      // survival contract above has been observed.
      await prisma.modelRun.delete({ where: { id: run.id } });
    }, 1);
  });

  it("erases restrictive run evidence as part of owner-authorized Project deletion", async () => {
    await withProjectFixture(async ({ ownerId, projectId }) => {
      const knowledgeBase = await prisma.knowledgeBase.create({
        data: { name: "Durable Project Knowledge", ownerUserId: ownerId },
        select: { id: true }
      });
      const source = await prisma.knowledgeSource.create({
        data: { name: "Durable Project Source", ownerUserId: ownerId },
        select: { id: true }
      });
      const sourceVersion = await prisma.knowledgeSourceVersion.create({
        data: {
          byteSize: 128,
          checksum: "f".repeat(64),
          fileName: "durable-project-source.md",
          mimeType: "text/markdown",
          ownerUserId: ownerId,
          sourceId: source.id,
          versionNumber: 1
        },
        select: { id: true }
      });
      await prisma.knowledgeSource.update({
        data: { currentVersionId: sourceVersion.id },
        where: { id: source.id }
      });
      await prisma.knowledgeBaseSource.create({
        data: { knowledgeBaseId: knowledgeBase.id, ownerUserId: ownerId, sourceId: source.id }
      });
      await prisma.projectKnowledgeBaseBinding.create({
        data: {
          addedByUserId: ownerId,
          knowledgeBaseId: knowledgeBase.id,
          projectId
        }
      });

      try {
      const parentFolder = await prisma.projectFolder.create({
        data: { name: "Parent", projectId }
      });
      const childFolder = await prisma.projectFolder.create({
        data: { name: "Child", parentId: parentFolder.id, projectId }
      });
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Project Owner",
          createdByUserId: ownerId,
          memoryMode: "EXCLUDED",
          projectFolderId: childFolder.id,
          projectId,
          title: "Disposable run",
          userId: null
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          authorDisplayName: "Project Owner",
          authorProjectRole: "OWNER",
          authorUserId: ownerId,
          chatId: chat.id,
          content: { blocks: [{ text: "Disposable question", type: "text" }] },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: { blocks: [{ text: "Disposable answer", type: "text" }] },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "complete"
        }
      });
      const factId = randomUUID();
      const versionId = randomUUID();
      await prisma.$transaction(async (tx) => {
        await tx.projectMemoryFact.create({
          data: {
            createdByDisplayName: "Project Owner",
            createdByUserId: ownerId,
            id: factId,
            projectId
          }
        });
        await tx.projectMemoryFactVersion.create({
          data: {
            createdByDisplayName: "Project Owner",
            createdByUserId: ownerId,
            factId,
            id: versionId,
            normalizedText: "disposable project fact",
            projectId,
            text: "Disposable Project fact",
            versionNumber: 1
          }
        });
        await tx.projectMemoryFact.update({
          data: { currentVersionId: versionId },
          where: { projectId_id: { id: factId, projectId } }
        });
        await tx.projectMemoryProposal.create({
          data: {
            normalizedText: "disposable project fact",
            projectId,
            proposedByDisplayName: "Project Owner",
            proposedByUserId: ownerId,
            proposedText: "Disposable Project fact",
            resultingFactId: factId,
            reviewedAt: new Date(),
            reviewedByDisplayName: "Project Owner",
            reviewedByUserId: ownerId,
            state: "APPROVED"
          }
        });
      });
      const runData = {
        assistantMessageId: assistantMessage.id,
        chatId: chat.id,
        modelId: "fake-qsa",
        normalizedRequest: {},
        provider: "fake",
        status: "complete" as const,
        userId: ownerId,
        userMessageId: userMessage.id
      };
      await expect(prisma.modelRun.create({ data: runData })).rejects.toThrow(
        /ModelRun ownership must match/u
      );

      const run = await prisma.$transaction(async (tx) => {
        const created = await tx.modelRun.create({ data: runData });
        await tx.projectRunBinding.create({
          data: {
            acceptedRole: "OWNER",
            accessRevision: 1,
            initiatorUserId: ownerId,
            instructionsRevision: 1,
            memoryRevision: 0,
            modelRunId: created.id,
            personalMemoryDisabled: true,
            policyRevision: 1,
            projectId
          }
        });
        await tx.projectMemoryRunItem.create({
          data: {
            factId,
            factVersionId: versionId,
            includedText: "Disposable Project fact",
            ordinal: 0,
            projectId,
            projectRunBindingId: created.id
          }
        });
        return created;
      });

      const deleted = await createPrismaProjectRepository(prisma).delete({
        actorDisplayName: "Project Owner",
        projectId,
        userId: ownerId
      });

      expect(deleted).toEqual({ kind: "ok", value: { id: projectId } });
      await expect(prisma.project.findUnique({ where: { id: projectId } })).resolves.toBeNull();
      await expect(prisma.projectRunBinding.findUnique({
        where: { modelRunId: run.id }
      })).resolves.toBeNull();
      await expect(prisma.projectKnowledgeBaseBinding.count({
        where: { knowledgeBaseId: knowledgeBase.id, projectId }
      })).resolves.toBe(0);
      await expect(prisma.knowledgeBase.findUnique({
        where: { id: knowledgeBase.id }
      })).resolves.not.toBeNull();
      await expect(prisma.knowledgeSource.findUnique({
        where: { id: source.id }
      })).resolves.not.toBeNull();
      await expect(prisma.knowledgeBaseSource.findUnique({
        where: {
          knowledgeBaseId_sourceId: {
            knowledgeBaseId: knowledgeBase.id,
            sourceId: source.id
          }
        }
      })).resolves.not.toBeNull();
      } finally {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL aiqsa.knowledge_purge = 'on'");
          await tx.projectKnowledgeBaseBinding.deleteMany({
            where: { knowledgeBaseId: knowledgeBase.id }
          });
          await tx.knowledgeBaseSource.deleteMany({
            where: { knowledgeBaseId: knowledgeBase.id }
          });
          await tx.knowledgeSource.update({
            data: { currentVersionId: null, pendingVersionId: null },
            where: { id: source.id }
          });
          await tx.knowledgeSourceVersion.deleteMany({ where: { sourceId: source.id } });
          await tx.knowledgeSource.delete({ where: { id: source.id } });
          await tx.knowledgeBase.delete({ where: { id: knowledgeBase.id } });
        });
      }
    });
  });
});
