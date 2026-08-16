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

  it("keeps publications live while accepted bindings retain their exact revision through delete", async () => {
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
      const firstBinding = { revisionId: firstRevisionId, skillId };
      await prisma.$transaction((tx) => insertAcceptedSkillRunBindings(tx, {
        bindings: [firstBinding],
        runId: run.id,
        userId: memberUserId
      }));

      await expect(repository.revise(ownerUserId, skillId, 1, {
        description: "Checks claims and sources",
        instructions: "Verify every factual claim and cite its source.",
        name: "Careful editor"
      })).resolves.toEqual({ kind: "ok", skillId });
      await expect(repository.resolveForRun(memberUserId, [skillId])).resolves.toMatchObject({
        ok: true,
        skills: [{
          instructions: "Verify every factual claim and cite its source.",
          skillId
        }]
      });
      const currentResolution = await repository.resolveForRun(memberUserId, [skillId]);
      if (!currentResolution.ok) throw new Error("skill_fixture_resolution_failed");
      expect(currentResolution.skills[0]!.revisionId).not.toBe(firstRevisionId);
      await expect(prisma.skillPublication.count({ where: { skillId } })).resolves.toBe(1);
      await expect(prisma.modelRunSkillBinding.findUnique({
        where: { modelRunId_skillId: { modelRunId: run.id, skillId } }
      })).resolves.toMatchObject(firstBinding);
      await expect(prisma.$transaction((tx) => assertCurrentSkillRunBindings(tx, {
        bindings: [firstBinding],
        runId: run.id,
        userId: memberUserId
      }))).resolves.toBeUndefined();

      await expect(repository.revokePublication({
        actorIsAdmin: false,
        publicationId: firstPublication.kind === "ok" ? firstPublication.id : "",
        skillId,
        userId: ownerUserId
      })).resolves.toBe("ok");
      await expect(prisma.$transaction((tx) => assertCurrentSkillRunBindings(tx, {
        bindings: [firstBinding],
        runId: run.id,
        userId: memberUserId
      }))).rejects.toBeInstanceOf(SkillRunConflictError);
      await expect(repository.resolveForRun(memberUserId, [skillId])).resolves.toEqual({
        code: "skill_not_available",
        ok: false,
        status: 404
      });

      const replacementPublication = await repository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId,
        userId: ownerUserId
      });
      expect(replacementPublication.kind).toBe("ok");
      await expect(repository.delete(ownerUserId, skillId)).resolves.toBe("ok");
      await expect(prisma.skillPublication.count({ where: { skillId } })).resolves.toBe(0);
      await expect(prisma.skillDefinition.findUnique({
        select: { deletedAt: true },
        where: { id: skillId }
      })).resolves.toMatchObject({ deletedAt: expect.any(Date) });
      await expect(repository.listForUser(ownerUserId, { limit: 30 })).resolves.toEqual({
        entries: [],
        nextCursor: null
      });
      await expect(repository.listForUser(memberUserId, { limit: 30 })).resolves.toEqual({
        entries: [],
        nextCursor: null
      });
      await expect(repository.getForUser(ownerUserId, skillId)).resolves.toBeNull();
      await expect(repository.getForUser(memberUserId, skillId)).resolves.toBeNull();
      await expect(repository.resolveForRun(ownerUserId, [skillId])).resolves.toEqual({
        code: "skill_not_available",
        ok: false,
        status: 404
      });
      await expect(repository.resolveForRun(memberUserId, [skillId])).resolves.toEqual({
        code: "skill_not_available",
        ok: false,
        status: 404
      });

      const historicalBinding = await prisma.modelRunSkillBinding.findUnique({
        include: { revision: true },
        where: { modelRunId_skillId: { modelRunId: run.id, skillId } }
      });
      expect(historicalBinding).toMatchObject({
        revision: {
          id: firstRevisionId,
          instructions: "Verify every factual claim."
        },
        revisionId: firstRevisionId,
        skillId
      });
      await expect(repository.delete(ownerUserId, skillId)).resolves.toBe("not_found");
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

  it("paginates metadata and searches names, descriptions, owners, and Workspace audiences", async () => {
    const suffix = randomUUID();
    const ownerUserId = `skill-list-owner-${suffix}`;
    const memberUserId = `skill-list-member-${suffix}`;
    const ownerDisplayName = `Skill catalog owner ${suffix}`;
    const workspaceName = `Atlas Workspace ${suffix}`;
    const group = await prisma.group.create({ data: { name: workspaceName } });
    const skillIds: string[] = [];

    await prisma.user.createMany({
      data: [{
        displayName: ownerDisplayName,
        id: ownerUserId,
        status: "active"
      }, {
        displayName: "Skill catalog member",
        id: memberUserId,
        status: "active"
      }]
    });
    await prisma.userGroup.createMany({
      data: [{ groupId: group.id, userId: ownerUserId }, { groupId: group.id, userId: memberUserId }]
    });

    try {
      const repository = createPrismaSkillRepository(prisma);
      for (const draft of [{
        description: "Drafts launch checklists",
        instructions: "Check launch owners and rollback steps.",
        name: `Alpha planner ${suffix}`
      }, {
        description: "Rewrites notes",
        instructions: "Make notes concise.",
        name: `Beta editor ${suffix}`
      }, {
        description: "Finds open questions",
        instructions: "List unresolved questions.",
        name: `Gamma reviewer ${suffix}`
      }]) {
        skillIds.push(await repository.create(ownerUserId, draft));
      }
      await expect(repository.publish({
        actorIsAdmin: false,
        groupId: group.id,
        scope: "group",
        skillId: skillIds[0]!,
        userId: ownerUserId
      })).resolves.toMatchObject({ kind: "ok" });

      const paginatedIds: string[] = [];
      let cursor: { id: string; updatedAt: Date } | undefined;
      do {
        const page = await repository.listForUser(ownerUserId, {
          ...(cursor ? { cursor } : {}),
          limit: 1
        });
        paginatedIds.push(...page.entries.map((entry) => entry.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(paginatedIds).toHaveLength(3);
      expect(new Set(paginatedIds)).toEqual(new Set(skillIds));

      const byDescription = await repository.listForUser(ownerUserId, {
        limit: 30,
        query: "launch checklists"
      });
      expect(byDescription.entries.map((entry) => entry.id)).toEqual([skillIds[0]]);

      const byOwner = await repository.listForUser(ownerUserId, {
        limit: 30,
        query: ownerDisplayName
      });
      expect(new Set(byOwner.entries.map((entry) => entry.id))).toEqual(new Set(skillIds));

      const byWorkspace = await repository.listForUser(memberUserId, {
        limit: 30,
        query: workspaceName
      });
      expect(byWorkspace.entries).toHaveLength(1);
      expect(byWorkspace.entries[0]).toMatchObject({
        id: skillIds[0],
        memberWorkspaceNames: [workspaceName],
        owned: false
      });
      expect(byWorkspace.entries[0]).not.toHaveProperty("instructions");

      await expect(repository.getForUser(memberUserId, skillIds[0]!)).resolves.toMatchObject({
        audiences: [{ kind: "workspace", name: workspaceName, workspaceId: group.id }],
        revision: { instructions: "Check launch owners and rollback steps." },
        workspaceUsageCount: 1
      });
      await expect(repository.getForUser(memberUserId, skillIds[1]!)).resolves.toBeNull();
    } finally {
      await prisma.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.updateMany({
        data: { currentRevisionId: null },
        where: { id: { in: skillIds } }
      });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
      await prisma.group.deleteMany({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerUserId, memberUserId] } } });
    }
  });
});
