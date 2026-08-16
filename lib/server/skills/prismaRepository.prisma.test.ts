import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import {
  assertCurrentSkillRunBindings,
  insertAcceptedSkillRunBindings
} from "../runs/prismaRepositoryBindings";
import { SkillRunConflictError } from "../runs/runRepositoryContract";
import { createPrismaSkillRepository } from "./prismaRepository";

describe("Prisma Skill repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("pins shared revisions and admits only an exact currently authorized run binding", async () => {
    const suffix = randomUUID();
    const ownerUserId = `skill-owner-${suffix}`;
    const memberUserId = `skill-member-${suffix}`;
    const group = await prisma.group.create({
      data: { name: `Skill test group ${suffix}` }
    });
    let skillId: string | null = null;

    await prisma.user.createMany({
      data: [{
        displayName: "Skill owner",
        id: ownerUserId,
        status: "active"
      }, {
        displayName: "Skill member",
        id: memberUserId,
        status: "active"
      }]
    });
    await prisma.userGroup.createMany({
      data: [{ groupId: group.id, userId: ownerUserId }, { groupId: group.id, userId: memberUserId }]
    });

    try {
      const repository = createPrismaSkillRepository(prisma);
      skillId = await repository.create(ownerUserId, {
        description: "Checks factual claims",
        instructions: "Verify every factual claim.",
        name: "Careful editor"
      });
      const firstPublication = await repository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId,
        userId: ownerUserId
      });
      expect(firstPublication.kind).toBe("ok");

      const firstResolution = await repository.resolveForRun(memberUserId, [skillId]);
      expect(firstResolution).toMatchObject({
        ok: true,
        skills: [{ instructions: "Verify every factual claim.", skillId }]
      });
      if (!firstResolution.ok) throw new Error("skill_fixture_resolution_failed");
      const firstRevisionId = firstResolution.skills[0]!.revisionId;

      await expect(repository.revise(ownerUserId, skillId, 1, {
        description: "Checks claims and sources",
        instructions: "Verify every factual claim and cite its source.",
        name: "Careful editor"
      })).resolves.toEqual({ kind: "ok", skillId });
      await expect(repository.resolveForRun(memberUserId, [skillId])).resolves.toMatchObject({
        ok: true,
        skills: [{ revisionId: firstRevisionId }]
      });

      const currentPublication = await repository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId,
        userId: ownerUserId
      });
      expect(currentPublication.kind).toBe("ok");
      if (currentPublication.kind !== "ok") throw new Error("skill_fixture_publish_failed");
      const currentResolution = await repository.resolveForRun(memberUserId, [skillId]);
      expect(currentResolution).toMatchObject({
        ok: true,
        skills: [{
          instructions: "Verify every factual claim and cite its source.",
          skillId
        }]
      });
      if (!currentResolution.ok) throw new Error("skill_fixture_resolution_failed");
      const binding = {
        revisionId: currentResolution.skills[0]!.revisionId,
        skillId
      };
      expect(binding.revisionId).not.toBe(firstRevisionId);

      const chat = await prisma.chat.create({
        data: { title: "Skill binding test", userId: memberUserId }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Use the shared workflow"),
          role: "user"
        }
      });
      const run = await prisma.modelRun.create({
        data: {
          chatId: chat.id,
          modelId: "skill-test-model",
          normalizedRequest: {},
          provider: "skill-test-provider",
          status: "queued",
          userId: memberUserId,
          userMessageId: userMessage.id
        }
      });

      await prisma.$transaction((tx) => insertAcceptedSkillRunBindings(tx, {
        bindings: [binding],
        runId: run.id,
        userId: memberUserId
      }));
      await expect(prisma.modelRunSkillBinding.findUnique({
        where: { modelRunId_skillId: { modelRunId: run.id, skillId } }
      })).resolves.toMatchObject(binding);
      await expect(prisma.$transaction((tx) => assertCurrentSkillRunBindings(tx, {
        bindings: [binding],
        runId: run.id,
        userId: memberUserId
      }))).resolves.toBeUndefined();

      await expect(repository.revokePublication({
        actorIsAdmin: false,
        publicationId: currentPublication.id,
        skillId,
        userId: ownerUserId
      })).resolves.toBe("ok");
      await expect(prisma.$transaction((tx) => assertCurrentSkillRunBindings(tx, {
        bindings: [binding],
        runId: run.id,
        userId: memberUserId
      }))).rejects.toBeInstanceOf(SkillRunConflictError);
      await expect(repository.resolveForRun(memberUserId, [skillId])).resolves.toEqual({
        code: "skill_not_available",
        ok: false,
        status: 404
      });
    } finally {
      await prisma.chat.deleteMany({ where: { userId: { in: [ownerUserId, memberUserId] } } });
      if (skillId) {
        await prisma.skillPublication.deleteMany({ where: { skillId } });
        await prisma.skillDefinition.updateMany({
          data: { currentRevisionId: null },
          where: { id: skillId }
        });
        await prisma.skillRevision.deleteMany({ where: { skillId } });
        await prisma.skillDefinition.deleteMany({ where: { id: skillId } });
      }
      await prisma.group.deleteMany({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, memberUserId] } } });
    }
  });
});
