import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { SkillSuggestionRequest } from "../../contracts/skillSuggestions";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaSkillRepository } from "./prismaRepository";
import { createSkillSuggestionContextLoader } from "./suggestionRepository";

const input: SkillSuggestionRequest = { requestId: "00000000-0000-4000-8000-000000000001", draft: "Help with this task",
  chatId: null, projectId: null, expectedActiveLeafMessageId: null, excludedIds: [] };
afterAll(() => prisma.$disconnect());

describe("Skill suggestion authorized metadata", () => {
  it("keeps personal, Workspace and Project grants distinct and hides instructions, revoked and archived entries", async () => {
    const suffix = randomUUID();
    const users = [`suggest-owner-${suffix}`, `suggest-reader-${suffix}`];
    await prisma.user.createMany({ data: users.map(id => ({ id, displayName: "Fixture", status: "active" })) });
    const group = await prisma.group.create({ data: { name: `Suggestion fixture ${suffix}` } });
    const project = await prisma.project.create({ data: { name: "Suggestion Project", createdByDisplayName: "Fixture",
      grants: { create: [{ userId: users[0]!, role: "OWNER" }, { userId: users[1]!, role: "CONTRIBUTOR" }] } } });
    const skillIds: string[] = [];
    try {
      const repository = createPrismaSkillRepository(prisma);
      for (const [index, userId] of [users[1]!, users[0]!, users[0]!, users[0]!].entries()) {
        skillIds.push(await repository.create(userId, { name: `Procedure ${index}`, description: "Metadata only", instructions: "HIDDEN_INSTRUCTIONS" }));
      }
      const [personal, shared, projectOnly, invisible] = skillIds;
      await prisma.userGroup.create({ data: { userId: users[1]!, groupId: group.id } });
      await prisma.skillPublication.create({ data: { skillId: shared!, scope: "group", groupId: group.id } });
      await prisma.projectSkillBinding.create({ data: { projectId: project.id, skillId: projectOnly! } });
      const load = createSkillSuggestionContextLoader(prisma);
      const personalResult = await load(users[1]!, input);
      expect(personalResult?.candidates.map(c => c.id).sort()).toEqual([personal, shared].sort());
      expect(JSON.stringify(personalResult)).not.toContain("HIDDEN_INSTRUCTIONS");
      expect(JSON.stringify(personalResult)).not.toContain(invisible);
      const projectInput = { ...input, projectId: project.id };
      expect((await load(users[1]!, projectInput))?.candidates.map(c => c.id)).toEqual([projectOnly]);
      await prisma.userGroup.deleteMany({ where: { userId: users[1]!, groupId: group.id } });
      expect((await load(users[1]!, input))?.candidates.map(c => c.id)).toEqual([personal]);
      await repository.setArchived(users[1]!, personal!, 1, true);
      expect((await load(users[1]!, input))?.candidates).toEqual([]);
      await prisma.projectGrant.deleteMany({ where: { projectId: project.id, userId: users[1]! } });
      expect(await load(users[1]!, projectInput)).toBeNull();
      await prisma.user.update({ where: { id: users[1]! }, data: { status: "disabled" } });
      expect(await load(users[1]!, input)).toBeNull();
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
      await prisma.skillPublication.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.updateMany({ where: { id: { in: skillIds } }, data: { currentRevisionId: null } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
      await prisma.userGroup.deleteMany({ where: { groupId: group.id } });
      await prisma.group.delete({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  });
  it("uses the authorized current branch and rejects another user, stale leaf or invented Project scope", async () => {
    const users = [`suggest-chat-${randomUUID()}`, `suggest-other-${randomUUID()}`];
    await prisma.user.createMany({ data: users.map(id => ({ id, displayName: "Fixture", status: "active" })) });
    const chat = await prisma.chat.create({ data: { userId: users[0]!, title: "Suggestion context" } });
    try {
      const leaf = await prisma.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
        content: textMessageContent("Visible context") } });
      await prisma.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: leaf.id } });
      const load = createSkillSuggestionContextLoader(prisma);
      const chatInput = { ...input, chatId: chat.id, expectedActiveLeafMessageId: leaf.id };
      expect((await load(users[0]!, chatInput))?.context).toEqual([{ role: "user", text: "Visible context" }]);
      expect(await load(users[1]!, chatInput)).toBeNull();
      expect(await load(users[0]!, { ...chatInput, expectedActiveLeafMessageId: null })).toBeNull();
      expect(await load(users[0]!, { ...chatInput, projectId: "foreign" })).toBeNull();
    } finally {
      await prisma.chat.delete({ where: { id: chat.id } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
  });
});
