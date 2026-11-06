import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "@/lib/domain/content";
import { prisma } from "@/lib/server/prisma";
import { assertCurrentSkillRunBindings, insertAcceptedSkillRunBindings } from "@/lib/server/runs/prismaRepositoryBindings";
import { createSkillBundle } from "@/lib/server/skills/bundle";
import { createBuiltInSkillAdminService } from "@/lib/server/skills/builtInSkillsAdmin";
import { createSkillCatalogRepository } from "@/lib/server/skills/catalogRepository";
import { createSkillPreferenceService } from "@/lib/server/skills/preferenceService";
import { createPrismaSkillRepository } from "@/lib/server/skills/prismaRepository";
import { shippedSkillContent, type ShippedSkill } from "@/lib/server/skills/shippedSkills";
import { synchronizeShippedSkills } from "./shippedSkills";

function shipped(key: string, instructions: string): ShippedSkill {
  return { key, content: shippedSkillContent(createSkillBundle(
    { name: `Shipped ${key.slice(0, 8)}`, description: "Load for a synthetic shipped procedure.", instructions },
    [{ path: "references/steps.md", bytes: Buffer.from(`Steps for ${instructions}`) }]
  )) };
}

describe("shipped Skills", () => {
  afterAll(() => prisma.$disconnect());

  it("installs, stays unchanged, revises, keeps Off and frozen runs, then retires and restores on upgrades", async () => {
    const suffix = randomUUID();
    const key = `t-${suffix}`;
    const [existing, off, later] = ["existing", "off", "later"].map((name) => `shipped-${name}-${suffix}`) as [string, string, string];
    await prisma.user.createMany({ data: [existing, off].map((id) => ({ id, displayName: "Shipped fixture", status: "active" })) });
    const catalog = createSkillCatalogRepository(prisma), skills = createPrismaSkillRepository(prisma);
    const preferences = createSkillPreferenceService(prisma), admin = createBuiltInSkillAdminService(prisma);
    let skillId = "";
    const enabled = async (userId: string) => (await catalog.listEnabledForRun(userId)).filter((entry) => entry.skillId === skillId);
    try {
      expect(await synchronizeShippedSkills(prisma, [shipped(key, "First text.")])).toEqual({ created: 1, updated: 0, retired: 0 });
      const installed = await prisma.skillDefinition.findUniqueOrThrow({ where: { shippedKey: key }, include: { revisions: true } });
      skillId = installed.id;
      const first = installed.currentRevisionId!;
      expect(installed).toMatchObject({ ownerUserId: null, sharedRevisionId: first, archivedAt: null, version: 1 });
      expect(installed.revisions).toEqual([expect.objectContaining({ authorUserId: null, bundleReady: true, revisionNumber: 1 })]);

      // On for a user who never touched Skills, and visible as built in.
      expect(await enabled(existing)).toEqual([expect.objectContaining({ revisionId: first, fileCount: 1 })]);
      expect(await skills.getForUser(existing, skillId)).toMatchObject({ builtIn: true, enabled: true, owned: false, ownerDisplayName: "AIQSA" });
      expect((await skills.listForUser(existing, { limit: 100 })).entries.find((entry) => entry.id === skillId))
        .toMatchObject({ builtIn: true, enabled: true });
      expect((await skills.listForUser(existing, { limit: 100, query: `Shipped ${key.slice(0, 8)}` })).entries.map((entry) => entry.id))
        .toContain(skillId);
      expect(await preferences.set(off, skillId, false)).toEqual({ skillId, enabled: false });
      expect(await enabled(off)).toEqual([]);

      // Nobody owns it, so no owner-scoped write reaches it.
      const draft = { name: "Hijacked", description: "Changed", instructions: "Changed." };
      expect(await skills.revise(existing, skillId, 1, draft)).toEqual({ kind: "not_found" });
      expect(await skills.setArchived(existing, skillId, 1, true)).toEqual({ kind: "not_found" });
      expect(await skills.delete(existing, skillId)).toBe("not_found");

      // An accepted run binds the revision without any publication.
      const chat = await prisma.chat.create({ data: { title: "Shipped Skill binding", userId: existing } });
      const message = await prisma.message.create({ data: { chatId: chat.id, role: "user", content: textMessageContent("Help") } });
      const run = await prisma.modelRun.create({ data: { chatId: chat.id, modelId: "shipped-model", normalizedRequest: {},
        provider: "shipped-provider", status: "queued", userId: existing, userMessageId: message.id } });
      const binding = { skillId, revisionId: first };
      await prisma.$transaction((tx) => insertAcceptedSkillRunBindings(tx, { bindings: [binding], runId: run.id, userId: existing }));
      await prisma.$transaction((tx) => assertCurrentSkillRunBindings(tx, { bindings: [binding], runId: run.id, userId: existing }));

      // A second upgrade with the same text writes nothing.
      const before = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } });
      expect(await synchronizeShippedSkills(prisma, [shipped(key, "First text.")])).toEqual({ created: 0, updated: 0, retired: 0 });
      expect(await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).toEqual(before);
      expect(await prisma.skillRevision.count({ where: { skillId } })).toBe(1);

      // Changed text: a new revision for future messages; Off stays Off; the accepted run keeps its own.
      expect(await synchronizeShippedSkills(prisma, [shipped(key, "Second text.")])).toEqual({ created: 0, updated: 1, retired: 0 });
      const revised = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } });
      expect(revised.currentRevisionId).not.toBe(first);
      expect(revised).toMatchObject({ sharedRevisionId: revised.currentRevisionId, version: 2 });
      expect(await enabled(existing)).toEqual([expect.objectContaining({ revisionId: revised.currentRevisionId })]);
      expect(await enabled(off)).toEqual([]);
      expect((await prisma.userSkillPreference.findUniqueOrThrow({ where: { userId_skillId: { userId: off, skillId } } })).enabled).toBe(false);
      expect(await catalog.resolveFrozen({ userId: existing, skillId, revisionId: first })).toMatchObject({ instructions: "First text." });
      expect(await prisma.modelRunSkillBinding.findMany({ where: { modelRunId: run.id } }))
        .toEqual([expect.objectContaining({ revisionId: first })]);

      // A user created afterwards has it too.
      await prisma.user.create({ data: { id: later, displayName: "Shipped fixture", status: "active" } });
      expect(await enabled(later)).toHaveLength(1);

      // The administrator's Off removes it for everyone and survives an upgrade.
      expect(await admin.setEnabled(skillId, false, 1)).toEqual({ kind: "version_conflict" });
      expect(await admin.setEnabled(skillId, false, 2)).toMatchObject({ kind: "ok", skill: { enabled: false, version: 3 } });
      expect(await enabled(existing)).toEqual([]);
      expect(await skills.getForUser(existing, skillId)).toBeNull();
      await expect(prisma.$transaction((tx) => assertCurrentSkillRunBindings(tx, { bindings: [binding], runId: run.id, userId: existing })))
        .rejects.toThrow();
      expect(await synchronizeShippedSkills(prisma, [shipped(key, "Second text.")])).toEqual({ created: 0, updated: 0, retired: 0 });
      expect((await prisma.skillDefinition.findUniqueOrThrow({ where: { id: skillId } })).archivedAt).not.toBeNull();
      expect(await admin.list()).toContainEqual(expect.objectContaining({ id: skillId, enabled: false }));
      expect(await admin.setEnabled(skillId, true, 3)).toMatchObject({ kind: "ok", skill: { enabled: true, version: 4 } });
      expect(await enabled(existing)).toHaveLength(1);

      // Removed from the release: retired, history kept; shipping it again restores it.
      expect(await synchronizeShippedSkills(prisma, [])).toEqual({ created: 0, updated: 0, retired: 1 });
      expect(await enabled(existing)).toEqual([]);
      expect(await admin.list()).not.toContainEqual(expect.objectContaining({ id: skillId }));
      expect(await admin.setEnabled(skillId, false, 5)).toEqual({ kind: "not_found" });
      expect(await prisma.skillRevision.count({ where: { skillId } })).toBe(2);
      expect(await prisma.modelRunSkillBinding.count({ where: { modelRunId: run.id } })).toBe(1);
      expect(await synchronizeShippedSkills(prisma, [shipped(key, "Second text.")])).toEqual({ created: 0, updated: 1, retired: 0 });
      expect(await prisma.skillRevision.count({ where: { skillId } })).toBe(2);
      expect(await enabled(existing)).toHaveLength(1);
      expect(await enabled(off)).toEqual([]);
    } finally {
      const users = [existing, off, later];
      await prisma.modelRun.deleteMany({ where: { userId: { in: users } } });
      await prisma.chat.deleteMany({ where: { userId: { in: users } } });
      if (skillId) {
        await prisma.userSkillPreference.deleteMany({ where: { skillId } });
        await prisma.skillDefinition.update({ where: { id: skillId }, data: { currentRevisionId: null, sharedRevisionId: null } });
        await prisma.skillRevisionFile.deleteMany({ where: { skillId } });
        await prisma.skillRevision.deleteMany({ where: { skillId } });
        await prisma.skillDefinition.delete({ where: { id: skillId } });
      }
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  });

  it("refuses an owner and a shipped key together or neither in the database", async () => {
    const userId = `shipped-check-${randomUUID()}`;
    await prisma.user.create({ data: { id: userId, displayName: "Shipped fixture", status: "active" } });
    try {
      await expect(prisma.skillDefinition.create({ data: { ownerUserId: userId, shippedKey: `t-${randomUUID()}` } })).rejects.toThrow();
      await expect(prisma.skillDefinition.create({ data: { ownerUserId: null } })).rejects.toThrow();
    } finally {
      await prisma.user.delete({ where: { id: userId } });
    }
  });
});
