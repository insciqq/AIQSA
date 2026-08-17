import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
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

describe("Prisma-backed Project repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("atomically bootstraps the Owner, preferred eligible model, default, and outbox event", async () => {
    const original = await prisma.providerModel.findUniqueOrThrow({
      select: { availableInProjects: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    await prisma.providerModel.update({
      data: { availableInProjects: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    try {
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
    } finally {
      await prisma.providerModel.update({
        data: { availableInProjects: original.availableInProjects },
        where: { id: providerTemplateIds.fakeModel }
      });
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

  it("omits globally ineligible resource identity and clears it from the safe defaults projection", async () => {
    const original = await prisma.providerModel.findUniqueOrThrow({
      select: { availableInProjects: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    await prisma.providerModel.update({
      data: { availableInProjects: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    try {
      await withProjectFixture(async ({ ownerId, projectId }) => {
        await prisma.providerModel.update({
          data: { availableInProjects: false },
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
        data: { availableInProjects: original.availableInProjects },
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

  it("rolls back stale unlink and atomically clears Project and chat defaults on commit", async () => {
    const original = await prisma.providerModel.findUniqueOrThrow({
      select: { availableInProjects: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    await prisma.providerModel.update({
      data: { availableInProjects: true },
      where: { id: providerTemplateIds.fakeModel }
    });
    try {
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
    } finally {
      await prisma.providerModel.update({
        data: { availableInProjects: original.availableInProjects },
        where: { id: providerTemplateIds.fakeModel }
      });
    }
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

  it("snapshots Project Memory evidence from the cited shared message", async () => {
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

      const created = await createPrismaProjectMemoryRepository(prisma).createFact({
        actorDisplayName: "Project Owner",
        projectId,
        sourceMessageId: message.id,
        text: "The team deploys on Tuesdays.",
        userId: ownerId
      });

      expect(created.kind).toBe("ok");
      const version = await prisma.projectMemoryFactVersion.findFirstOrThrow({
        where: { projectId, sourceMessageId: message.id }
      });
      expect(version.sourceSnapshot).toEqual({
        authorDisplayName: "Project Owner",
        createdAt: message.createdAt.toISOString(),
        messageId: message.id,
        role: "user",
        text: "Deploy on Tuesdays."
      });
    });
  });

  it("accepts Contributor proposals only from Project user messages", async () => {
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
      })).resolves.toMatchObject({
        kind: "ok",
        value: {
          source: { messageId: userMessage.id, role: "user" }
        }
      });
      await expect(prisma.projectMemoryProposal.count({
        where: { projectId }
      })).resolves.toBe(1);
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
    });
  });
});
