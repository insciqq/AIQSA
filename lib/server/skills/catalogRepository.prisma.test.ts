import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaSkillRepository } from "./prismaRepository";
import { createSkillCatalogRepository } from "./catalogRepository";
import { createSkillPreferenceService } from "./preferenceService";

describe("Skill enabled catalog persistence", () => {
  afterAll(() => prisma.$disconnect());

  it("enables all accessible active Skills beyond one page without changing other users or unavailable Skills", async () => {
    const suffix = randomUUID(), runner = `bulk-runner-${suffix}`, owner = `bulk-owner-${suffix}`;
    await prisma.user.createMany({ data: [runner, owner].map(id => ({ id, displayName: "Bulk fixture", status: "active" })) });
    const skills = createPrismaSkillRepository(prisma), preferences = createSkillPreferenceService(prisma);
    const ids: string[] = [];
    const create = async (userId: string, name: string) => {
      const id = await skills.create(userId, { name, description: "Synthetic workflow", instructions: "Review the fixture." });
      ids.push(id);
      return id;
    };
    try {
      const own: string[] = [];
      for (let index = 0; index < 51; index++) own.push(await create(runner, `Workflow ${index}`));
      const archived = await create(runner, "Archived"), deleted = await create(runner, "Deleted");
      const shared = await create(owner, "Shared"), hidden = await create(owner, "Private");
      const revision = (await prisma.skillDefinition.findUniqueOrThrow({ where: { id: shared } })).currentRevisionId!;
      await prisma.skillDefinition.update({ where: { id: shared }, data: { sharedRevisionId: revision } });
      await prisma.skillPublication.create({ data: { skillId: shared, scope: "installation" } });
      await prisma.userSkillPreference.createMany({ data: [
        ...own.map(skillId => ({ userId: runner, skillId, enabled: false })),
        ...[archived, deleted].map(skillId => ({ userId: runner, skillId, enabled: false })),
        { userId: owner, skillId: shared, enabled: false }
      ] });
      await prisma.skillDefinition.update({ where: { id: archived }, data: { archivedAt: new Date() } });
      await prisma.skillDefinition.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
      expect(await preferences.enableAll(runner)).toEqual({ enabledCount: 52 });
      expect(await prisma.userSkillPreference.count({ where: { userId: runner, enabled: true } })).toBe(52);
      expect(await prisma.userSkillPreference.count({ where: { userId: runner, skillId: { in: [archived, deleted] }, enabled: false } })).toBe(2);
      expect(await prisma.userSkillPreference.count({ where: { userId: runner, skillId: hidden } })).toBe(0);
      expect((await prisma.userSkillPreference.findUniqueOrThrow({ where: { userId_skillId: { userId: owner, skillId: shared } } })).enabled).toBe(false);
      expect(await preferences.enableAll(runner)).toEqual({ enabledCount: 52 });
      await prisma.user.update({ where: { id: runner }, data: { status: "disabled" } });
      expect(await preferences.enableAll(runner)).toBeNull();
    } finally {
      await prisma.skillPublication.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.updateMany({ where: { id: { in: ids } }, data: { currentRevisionId: null, sharedRevisionId: null } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: [runner, owner] } } });
    }
  });

  it("defaults own Skills on and shared Skills off, preserves approved metadata and rechecks frozen access", async () => {
    const suffix = randomUUID(), runner = `catalog-runner-${suffix}`, owner = `catalog-owner-${suffix}`;
    await prisma.user.createMany({ data: [runner, owner].map((id) => ({ id, displayName: "Catalog fixture", status: "active" })) });
    const group = await prisma.group.create({ data: { name: `Catalog ${suffix}` } });
    await prisma.userGroup.create({ data: { userId: runner, groupId: group.id } });
    const skills = createPrismaSkillRepository(prisma), catalog = createSkillCatalogRepository(prisma), preferences = createSkillPreferenceService(prisma);
    const ids: string[] = [];
    let projectId: string | undefined;
    try {
      const draft = { name: "Own workflow", description: "Synthetic procedure", instructions: "Original instructions" };
      const own = await skills.create(runner, draft); ids.push(own);
      const shared = await skills.create(owner, { ...draft, name: "Approved name" }); ids.push(shared);
      const privateId = await skills.create(owner, { ...draft, name: "Private workflow" }); ids.push(privateId);
      const approved = (await prisma.skillDefinition.findUniqueOrThrow({ where: { id: shared } })).currentRevisionId!;
      await prisma.skillDefinition.update({ where: { id: shared }, data: { sharedRevisionId: approved } });
      const publication = await prisma.skillPublication.create({ data: { skillId: shared, scope: "group", groupId: group.id } });
      expect((await catalog.listEnabledForRun(runner)).map((entry) => entry.skillId)).toEqual([own]);
      expect((await skills.getForUser(runner, own))?.enabled).toBe(true);
      expect((await skills.getForUser(runner, shared))?.enabled).toBe(false);
      expect(await preferences.set(runner, privateId, true)).toBeNull();
      expect(await prisma.userSkillPreference.count({ where: { userId: runner, skillId: privateId } })).toBe(0);

      await preferences.set(runner, own, false);
      await preferences.set(runner, shared, true);
      await skills.revise(owner, shared, 1, { ...draft, name: "Private newer name", instructions: "Newer private instructions" });
      expect(await catalog.listEnabledForRun(runner)).toEqual([expect.objectContaining({ skillId: shared, revisionId: approved, name: "Approved name" })]);
      expect((await skills.resolveForRun(runner, [own])).ok).toBe(true);
      const frozen = { userId: runner, skillId: shared, revisionId: approved };
      expect(await catalog.resolveFrozen(frozen)).toMatchObject({ instructions: draft.instructions, name: "Approved name" });
      await prisma.skillPublication.delete({ where: { id: publication.id } });
      expect(await catalog.listEnabledForRun(runner)).toEqual([]);
      expect(await catalog.resolveFrozen(frozen)).toBeNull();

      const project = await prisma.project.create({ data: { name: "Catalog Project", createdByDisplayName: "Fixture", grants: {
        create: { userId: runner, role: "OWNER" }
      } } });
      projectId = project.id;
      const binding = await prisma.projectSkillBinding.create({ data: { projectId, skillId: own } });
      const ownRevision = (await prisma.skillDefinition.findUniqueOrThrow({ where: { id: own } })).currentRevisionId!;
      const projected = { userId: runner, projectId, skillId: own, revisionId: ownRevision };
      expect(await catalog.resolveFrozen(projected)).toBeNull();
      await prisma.skillDefinition.update({ where: { id: own }, data: { sharedRevisionId: ownRevision } });
      expect(await catalog.resolveFrozen(projected)).toMatchObject({ instructions: draft.instructions });
      await prisma.projectSkillBinding.delete({ where: { id: binding.id } });
      expect(await catalog.resolveFrozen(projected)).toBeNull();
    } finally {
      if (projectId) await prisma.project.delete({ where: { id: projectId } });
      await prisma.skillPublication.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.updateMany({ where: { id: { in: ids } }, data: { currentRevisionId: null, sharedRevisionId: null } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: ids } } });
      await prisma.group.delete({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: [runner, owner] } } });
    }
  });
});
