import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { AssistantDraft } from "../../contracts/assistants";
import { prisma } from "../prisma";
import { createPrismaSkillRepository } from "../skills/prismaRepository";
import { createPrismaAssistantRepository } from "./prismaRepository";

function assistantDraft(providerModelId: string, skillIds: string[]): AssistantDraft {
  return {
    avatar: {
      accents: [0, 4],
      backgroundShape: "circle",
      foregroundShape: "diamond",
      kind: "generated",
      paletteId: "ocean",
      recipeVersion: 1,
      rotations: [0, 2]
    },
    category: "analysis",
    description: "Uses an ordered workflow.",
    developerPrompt: null,
    knowledgeBaseIds: [],
    mcpServerIds: [],
    name: "Workflow assistant",
    providerModelId,
    runControls: {},
    searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds,
    starterPrompts: [],
    systemPrompt: "Follow the included workflows."
  };
}

describe("Prisma Assistant Skill links", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps ordered live links, enforces publication audiences, and detaches on delete", async () => {
    const suffix = randomUUID();
    const ownerUserId = `assistant-skill-owner-${suffix}`;
    const memberUserId = `assistant-skill-member-${suffix}`;
    const providerConnectionId = `assistant-skill-connection-${suffix}`;
    const providerModelId = `assistant-skill-model-${suffix}`;
    const group = await prisma.group.create({
      data: { name: `Assistant Skill Workspace ${suffix}` }
    });
    const skillIds: string[] = [];
    let assistantId: string | null = null;

    await prisma.user.createMany({
      data: [{
        displayName: "Assistant Skill owner",
        id: ownerUserId,
        status: "active"
      }, {
        displayName: "Assistant Skill member",
        id: memberUserId,
        status: "active"
      }]
    });
    await prisma.userGroup.createMany({
      data: [
        { groupId: group.id, userId: ownerUserId },
        { groupId: group.id, userId: memberUserId }
      ]
    });
    await prisma.providerConnection.create({
      data: {
        displayName: "Assistant Skill test provider",
        family: "test",
        id: providerConnectionId
      }
    });
    await prisma.providerModel.create({
      data: {
        capabilities: {},
        connectionId: providerConnectionId,
        defaultParams: {},
        displayName: "Assistant Skill test model",
        id: providerModelId,
        modelId: `model-${suffix}`,
        provider: "test"
      }
    });

    try {
      const skillRepository = createPrismaSkillRepository(prisma);
      const assistantRepository = createPrismaAssistantRepository(prisma);
      const firstSkillId = await skillRepository.create(ownerUserId, {
        description: "Ends with next actions.",
        instructions: "End with a short action list.",
        name: "Action closer"
      });
      const liveSkillId = await skillRepository.create(ownerUserId, {
        description: "Checks claims.",
        instructions: "Verify every factual claim.",
        name: "Careful reviewer"
      });
      skillIds.push(firstSkillId, liveSkillId);

      await expect(skillRepository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId: firstSkillId,
        userId: ownerUserId
      })).resolves.toMatchObject({ kind: "ok" });

      const created = await assistantRepository.create(
        ownerUserId,
        assistantDraft(providerModelId, [liveSkillId, firstSkillId])
      );
      expect(created.kind).toBe("ok");
      if (created.kind !== "ok") throw new Error("assistant_skill_fixture_create_failed");
      assistantId = created.assistantId;

      const firstRevision = await prisma.assistantRevision.findFirstOrThrow({
        select: { id: true },
        where: { assistantId, revisionNumber: 1 }
      });
      await expect(prisma.assistantRevisionSkill.findMany({
        orderBy: { ordinal: "asc" },
        select: { ordinal: true, skillId: true },
        where: { assistantRevisionId: firstRevision.id }
      })).resolves.toEqual([
        { ordinal: 0, skillId: liveSkillId },
        { ordinal: 1, skillId: firstSkillId }
      ]);
      await expect(assistantRepository.resolveForRun(ownerUserId, assistantId)).resolves.toMatchObject({
        assistant: { revisionNumber: 1, skillIds: [liveSkillId, firstSkillId] },
        ok: true
      });

      await expect(assistantRepository.publish({
        actorIsAdmin: false,
        assistantId,
        groupId: group.id,
        revisionNumber: 1,
        scope: "group",
        userId: ownerUserId
      })).resolves.toEqual({ kind: "skill_audience_mismatch" });

      const livePublication = await skillRepository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId: liveSkillId,
        userId: ownerUserId
      });
      expect(livePublication.kind).toBe("ok");
      await expect(assistantRepository.revise(
        ownerUserId,
        assistantId,
        1,
        assistantDraft(providerModelId, [firstSkillId])
      )).resolves.toEqual({ assistantId, kind: "ok" });

      const published = await assistantRepository.publish({
        actorIsAdmin: false,
        assistantId,
        groupId: group.id,
        revisionNumber: 1,
        scope: "group",
        userId: ownerUserId
      });
      expect(published.kind).toBe("ok");
      if (published.kind !== "ok") throw new Error("assistant_skill_fixture_publish_failed");

      const memberAssistant = await assistantRepository.resolveForRun(memberUserId, assistantId);
      expect(memberAssistant).toMatchObject({
        assistant: { revisionNumber: 1, skillIds: [liveSkillId, firstSkillId] },
        ok: true
      });
      if (!memberAssistant.ok) throw new Error("assistant_skill_fixture_resolution_failed");
      await expect(assistantRepository.getDetail(memberUserId, assistantId)).resolves.toMatchObject({
        revision: {
          skillIds: [liveSkillId, firstSkillId],
          skillSummaries: [
            { id: liveSkillId, name: "Careful reviewer" },
            { id: firstSkillId, name: "Action closer" }
          ]
        }
      });
      const beforeEdit = await skillRepository.resolveForRun(
        memberUserId,
        memberAssistant.assistant.skillIds
      );
      expect(beforeEdit).toMatchObject({
        ok: true,
        skills: [{ instructions: "Verify every factual claim." }, { skillId: firstSkillId }]
      });
      if (!beforeEdit.ok) throw new Error("assistant_skill_fixture_skill_resolution_failed");
      const acceptedLiveRevisionId = beforeEdit.skills[0]!.revisionId;

      await expect(skillRepository.revise(ownerUserId, liveSkillId, 1, {
        description: "Checks claims and sources.",
        instructions: "Verify every factual claim and cite its source.",
        name: "Careful reviewer"
      })).resolves.toEqual({ kind: "ok", skillId: liveSkillId });
      const afterEditAssistant = await assistantRepository.resolveForRun(memberUserId, assistantId);
      expect(afterEditAssistant).toMatchObject({
        assistant: { revisionNumber: 1, skillIds: [liveSkillId, firstSkillId] },
        ok: true
      });
      if (!afterEditAssistant.ok) throw new Error("assistant_skill_fixture_resolution_failed");
      const afterEdit = await skillRepository.resolveForRun(
        memberUserId,
        afterEditAssistant.assistant.skillIds
      );
      expect(afterEdit).toMatchObject({
        ok: true,
        skills: [
          { instructions: "Verify every factual claim and cite its source." },
          { skillId: firstSkillId }
        ]
      });
      if (!afterEdit.ok) throw new Error("assistant_skill_fixture_skill_resolution_failed");
      expect(afterEdit.skills[0]!.revisionId).not.toBe(acceptedLiveRevisionId);
      await expect(skillRepository.getForUser(ownerUserId, liveSkillId)).resolves.toMatchObject({
        assistantUsageCount: 1
      });

      await expect(skillRepository.revokePublication({
        actorIsAdmin: false,
        publicationId: livePublication.kind === "ok" ? livePublication.id : "",
        skillId: liveSkillId,
        userId: ownerUserId
      })).resolves.toBe("dependency_conflict");
      await expect(assistantRepository.revokePublication({
        actorIsAdmin: false,
        assistantId,
        publicationId: published.publication.id,
        userId: ownerUserId
      })).resolves.toBe("revoked");
      await expect(skillRepository.revokePublication({
        actorIsAdmin: false,
        publicationId: livePublication.kind === "ok" ? livePublication.id : "",
        skillId: liveSkillId,
        userId: ownerUserId
      })).resolves.toBe("ok");

      await expect(skillRepository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId: liveSkillId,
        userId: ownerUserId
      })).resolves.toMatchObject({ kind: "ok" });
      await expect(assistantRepository.publish({
        actorIsAdmin: false,
        assistantId,
        groupId: group.id,
        revisionNumber: 1,
        scope: "group",
        userId: ownerUserId
      })).resolves.toMatchObject({ kind: "ok" });

      await expect(skillRepository.delete(ownerUserId, liveSkillId)).resolves.toBe("ok");
      await expect(prisma.assistantRevisionSkill.count({ where: { skillId: liveSkillId } }))
        .resolves.toBe(0);
      await expect(prisma.skillPublication.count({ where: { skillId: liveSkillId } }))
        .resolves.toBe(0);
      await expect(assistantRepository.resolveForRun(memberUserId, assistantId)).resolves.toMatchObject({
        assistant: { revisionNumber: 1, skillIds: [firstSkillId] },
        ok: true
      });
      await expect(skillRepository.resolveForRun(memberUserId, [liveSkillId])).resolves.toEqual({
        code: "skill_not_available",
        ok: false,
        status: 404
      });
    } finally {
      const assistantIds = assistantId
        ? [assistantId]
        : (await prisma.assistantDefinition.findMany({
            select: { id: true },
            where: { ownerUserId }
          })).map((definition) => definition.id);
      const revisionIds = (await prisma.assistantRevision.findMany({
        select: { id: true },
        where: { assistantId: { in: assistantIds } }
      })).map((revision) => revision.id);
      await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantPin.deleteMany({ where: { assistantId: { in: assistantIds } } });
      await prisma.assistantDefinition.updateMany({
        data: { currentRevisionId: null },
        where: { id: { in: assistantIds } }
      });
      await prisma.assistantRevisionSkill.deleteMany({
        where: { assistantRevisionId: { in: revisionIds } }
      });
      await prisma.assistantRevision.deleteMany({ where: { id: { in: revisionIds } } });
      await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });

      await prisma.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.updateMany({
        data: { currentRevisionId: null },
        where: { id: { in: skillIds } }
      });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
      await prisma.providerModel.deleteMany({ where: { id: providerModelId } });
      await prisma.providerConnection.deleteMany({ where: { id: providerConnectionId } });
      await prisma.group.deleteMany({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, memberUserId] } } });
    }
  });
});
