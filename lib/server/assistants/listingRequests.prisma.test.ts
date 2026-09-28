import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaSkillRepository } from "../skills/prismaRepository";
import { createListedAssistantService, loadAssistantRecentChatCounts, loadFeaturedAssistantOrders } from "./listedAssistants";
import { createAssistantListingService } from "./listingRequests";
import { countReviewableAssistantListingRequests } from "./listingShared";
import { createPrismaAssistantRepository } from "./prismaRepository";

const avatar = { accents: [0, 4], backgroundShape: "circle", foregroundShape: "diamond", kind: "generated",
  paletteId: "ocean", recipeVersion: 1, rotations: [0, 2] };

async function fixture() {
  const suffix = randomUUID();
  const owner = `listing-owner-${suffix}`, peer = `listing-peer-${suffix}`, admin = `listing-admin-${suffix}`;
  await prisma.user.createMany({ data: [owner, peer, admin].map((id) => ({ id, displayName: "Synthetic lister", status: "active", role: id === admin ? "admin" : "user" })) });
  const group = await prisma.group.create({ data: { name: `Listing ${suffix}` } });
  await prisma.userGroup.createMany({ data: [owner, peer].map((userId) => ({ userId, groupId: group.id })) });
  const repository = createPrismaAssistantRepository(prisma);
  const skillIds: string[] = [], knowledgeBaseIds: string[] = [];
  return { owner, peer, admin, group, repository, skillIds, knowledgeBaseIds,
    requests: createAssistantListingService(prisma), listed: createListedAssistantService(prisma, repository),
    async assistant(name = "Listing reviewer") {
      return prisma.assistantDefinition.create({ data: { ownerUserId: owner, name, avatar, systemPrompt: "Private review instructions",
        answerRules: "Cite every source.", modelPolicy: "adjustable", providerModelId: null, searchPlan: { mode: "off" } } });
    },
    async installation(assistantId: string) {
      return prisma.assistantPublication.create({ data: { assistantId, scope: "installation", publishedByUserId: admin } });
    },
    pending(assistantId: string) { return prisma.assistantListingRequest.findFirstOrThrow({ where: { assistantId, state: "pending" } }); },
    async version(assistantId: string) { return (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version; },
    async cleanup() {
      await prisma.chat.deleteMany({ where: { userId: { in: [owner, peer] } } });
      const ids = (await prisma.assistantDefinition.findMany({ where: { ownerUserId: owner }, select: { id: true } })).map(({ id }) => id);
      await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: ids } } });
      await prisma.assistantDefinition.deleteMany({ where: { id: { in: ids } } });
      await prisma.skillDefinition.updateMany({ where: { id: { in: skillIds } }, data: { currentRevisionId: null, sharedRevisionId: null } });
      await prisma.skillShareRequest.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillRevisionFile.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: skillIds } } });
      await prisma.knowledgeBasePublication.deleteMany({ where: { knowledgeBaseId: { in: knowledgeBaseIds } } });
      await prisma.knowledgeBase.deleteMany({ where: { id: { in: knowledgeBaseIds } } });
      await prisma.userGroup.deleteMany({ where: { groupId: group.id } });
      await prisma.group.delete({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: [owner, peer, admin] } } });
    }
  };
}

describe("Assistant listing persistence", () => {
  afterAll(() => prisma.$disconnect());

  it("lists exactly the requested version and reports edited requests as outdated", async () => {
    const f = await fixture();
    try {
      const assistant = await f.assistant();
      const reviewable = await countReviewableAssistantListingRequests(prisma);
      await f.requests.request(f.owner, assistant.id, 1);
      const first = await f.pending(assistant.id);
      expect(await countReviewableAssistantListingRequests(prisma)).toBe(reviewable + 1);
      await expect(f.requests.detail(f.peer, first.id)).rejects.toThrow("forbidden");
      const review = await f.requests.detail(f.admin, first.id);
      expect(review).toMatchObject({ canReview: true, outdated: false, definition: {
        version: 1, instructions: "Private review instructions", answerRules: "Cite every source.", rows: {
          model: { policy: "adjustable", value: { mode: "inherit" } }, search: { policy: "fixed", value: { mode: "off" } },
          tools: { policy: "fixed", value: { mode: "off" } }, knowledge: { policy: "fixed", value: { mode: "none" } } } } });
      expect(JSON.stringify(review)).not.toMatch(/requestedByUserId|ownerUserId|listing-owner/);
      expect(await f.requests.status(f.owner, assistant.id, false)).toMatchObject({ canRequest: false, canWithdraw: true, request: { state: "pending", outdated: false } });

      await prisma.assistantDefinition.update({ where: { id: assistant.id }, data: { description: "Changed after the request" } });
      expect(await f.version(assistant.id)).toBe(2);
      expect(await countReviewableAssistantListingRequests(prisma)).toBe(reviewable);
      expect(await f.requests.detail(f.admin, first.id)).toMatchObject({ outdated: true, canReview: false, definition: null });
      await expect(f.requests.decide(f.admin, first.id, "approve", null)).rejects.toThrow("assistant_listing_request_outdated");
      await expect(f.requests.decide(f.admin, first.id, "reject", null)).rejects.toThrow("assistant_listing_request_outdated");
      expect(await f.requests.status(f.owner, assistant.id, false)).toMatchObject({ canRequest: true, request: { id: first.id, outdated: true } });
      const queue = await f.requests.listRequests(f.admin, { limit: 50 });
      expect(queue.requests.find((row) => row.id === first.id)).toMatchObject({ outdated: true, canReview: false });

      await f.requests.request(f.owner, assistant.id, 2);
      const second = await f.pending(assistant.id);
      expect((await prisma.assistantListingRequest.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("superseded");
      expect(await f.repository.loadAccessEntry(f.peer, assistant.id)).toBeNull();
      const approved = await f.requests.decide(f.admin, second.id, "approve", "Welcome");
      expect(approved).toMatchObject({ state: "approved", reviewNote: "Welcome", canReview: false });
      expect(await prisma.assistantPublication.count({ where: { assistantId: assistant.id, scope: "installation" } })).toBe(1);
      expect(await f.version(assistant.id)).toBe(2);
      expect(await f.repository.loadAccessEntry(f.peer, assistant.id)).toMatchObject({ installationScope: true });
      expect(await f.requests.status(f.owner, assistant.id, false)).toMatchObject({ listed: true, canRequest: false, request: { state: "approved" } });
      await expect(f.requests.detail(f.admin, second.id)).rejects.toThrow("assistant_listing_request_not_available");
      await expect(f.requests.request(f.owner, assistant.id, 2)).rejects.toThrow("assistant_already_listed");
    } finally { await f.cleanup(); }
  });

  it("never shows a private Assistant to an administrator without a pending request", async () => {
    const f = await fixture();
    try {
      const assistant = await f.assistant("Private group helper");
      await prisma.assistantPublication.create({ data: { assistantId: assistant.id, scope: "group", groupId: f.group.id, publishedByUserId: f.owner } });
      expect(await f.repository.loadAccessEntry(f.admin, assistant.id)).toBeNull();
      await f.requests.request(f.owner, assistant.id, 1);
      const withdrawn = await f.pending(assistant.id);
      await f.requests.withdraw(f.owner, assistant.id, withdrawn.id);
      await expect(f.requests.withdraw(f.owner, assistant.id, withdrawn.id)).rejects.toThrow("assistant_listing_request_conflict");
      await f.requests.request(f.owner, assistant.id, 1);
      const rejected = await f.pending(assistant.id);
      await f.requests.decide(f.admin, rejected.id, "reject", "Narrow the instructions");
      for (const id of [withdrawn.id, rejected.id]) {
        await expect(f.requests.detail(f.admin, id)).rejects.toThrow("assistant_listing_request_not_available");
      }
      const queue = await f.requests.listRequests(f.admin, { limit: 50 });
      const listed = await f.listed.list(f.admin, { limit: 50 });
      expect(JSON.stringify([queue, listed])).not.toContain("Private group helper");
      expect(await f.requests.status(f.owner, assistant.id, false)).toMatchObject({ canRequest: true,
        request: { state: "rejected", reviewNote: "Narrow the instructions" } });
      expect(await f.requests.status(f.admin, assistant.id, true)).toBeNull();
    } finally { await f.cleanup(); }
  });

  it("names in the review only the Knowledge the administrator can open", async () => {
    const f = await fixture();
    try {
      const [ownerOnly, teamOnly, everyone] = await Promise.all(["Owner private notes", "Team only handbook", "Company handbook"]
        .map((name) => prisma.knowledgeBase.create({ data: { ownerUserId: f.owner, name } })));
      f.knowledgeBaseIds.push(ownerOnly!.id, teamOnly!.id, everyone!.id);
      await prisma.knowledgeBasePublication.createMany({ data: [
        { knowledgeBaseId: teamOnly!.id, scope: "group", groupId: f.group.id, publishedByUserId: f.owner },
        { knowledgeBaseId: everyone!.id, scope: "installation", publishedByUserId: f.admin }
      ] });
      const assistant = await prisma.assistantDefinition.create({ data: { ownerUserId: f.owner, name: "Handbook helper", avatar,
        systemPrompt: "Answer from the handbook.", modelPolicy: "adjustable", providerModelId: null,
        searchPolicy: "adjustable", searchPlan: { mode: "inherit" }, toolsPolicy: "adjustable", mcpMode: "inherit", knowledgePolicy: "fixed",
        knowledgeSelection: { mode: "explicit", baseIds: [ownerOnly!.id, teamOnly!.id, everyone!.id], sourceIds: [], version: 1 } } });
      await f.requests.request(f.owner, assistant.id, 1);
      const review = await f.requests.detail(f.admin, (await f.pending(assistant.id)).id);
      expect(review.definition).toMatchObject({
        rows: {
          model: { policy: "adjustable", value: { mode: "inherit" } },
          search: { policy: "adjustable", value: { mode: "inherit" } },
          tools: { policy: "adjustable", value: { mode: "inherit" } },
          knowledge: { policy: "fixed", value: { mode: "explicit", baseIds: [everyone!.id], sourceIds: [], hiddenCount: 2 } }
        },
        names: { knowledgeBases: [{ id: everyone!.id, name: "Company handbook" }], knowledgeSources: [], models: [] }
      });
      expect(JSON.stringify(review)).not.toMatch(new RegExp(`${ownerOnly!.id}|${teamOnly!.id}|Owner private notes|Team only handbook`, "u"));
    } finally { await f.cleanup(); }
  });

  it("makes approval versus withdrawal a single winner", async () => {
    const f = await fixture();
    try {
      const assistant = await f.assistant();
      await f.requests.request(f.owner, assistant.id, 1);
      const pending = await f.pending(assistant.id);
      const outcomes = await Promise.allSettled([
        f.requests.decide(f.admin, pending.id, "approve", null), f.requests.withdraw(f.owner, assistant.id, pending.id)
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const request = await prisma.assistantListingRequest.findUniqueOrThrow({ where: { id: pending.id } });
      expect(await prisma.assistantPublication.count({ where: { assistantId: assistant.id, scope: "installation" } }))
        .toBe(request.state === "approved" ? 1 : 0);
    } finally { await f.cleanup(); }
  });

  it("names linked Skills that do not reach everyone", async () => {
    const f = await fixture();
    try {
      const assistant = await f.assistant();
      const skillId = await createPrismaSkillRepository(prisma).create(f.owner, {
        description: "Private procedure", instructions: "Follow the private procedure.", name: "Unlisted procedure" });
      f.skillIds.push(skillId);
      await prisma.assistantSkill.create({ data: { assistantId: assistant.id, skillId, ordinal: 0 } });
      const version = await f.version(assistant.id);
      await expect(f.requests.request(f.owner, assistant.id, version)).rejects.toMatchObject({
        code: "assistant_skill_audience_mismatch", skillNames: ["Unlisted procedure"] });
      expect(await prisma.assistantListingRequest.count({ where: { assistantId: assistant.id } })).toBe(0);
      expect(await f.repository.publish({ actorIsAdmin: false, assistantId: assistant.id, groupId: f.group.id, scope: "group", userId: f.owner }))
        .toEqual({ kind: "skill_audience_mismatch", skillNames: ["Unlisted procedure"] });
    } finally { await f.cleanup(); }
  });

  it("keeps Featured positions unique, bounded, and cleared by unlisting", async () => {
    const f = await fixture();
    try {
      const assistants = [];
      for (let index = 0; index < 10; index++) {
        const assistant = await f.assistant(`Featured ${index}`);
        await f.installation(assistant.id);
        assistants.push(assistant.id);
      }
      const [a, b, ...rest] = assistants as [string, string, ...string[]];
      await prisma.assistantPublication.create({ data: { assistantId: a, scope: "group", groupId: f.group.id, publishedByUserId: f.owner } });
      await expect(f.listed.setFeatured(f.owner, a, 0)).rejects.toThrow("forbidden");
      await f.listed.setFeatured(f.admin, a, 0);
      expect(await f.listed.setFeatured(f.admin, b, 0)).toEqual([{ assistantId: b, featuredOrder: 0 }, { assistantId: a, featuredOrder: 1 }]);
      expect(await f.listed.setFeatured(f.admin, a, 0)).toEqual([{ assistantId: a, featuredOrder: 0 }, { assistantId: b, featuredOrder: 1 }]);
      for (const id of rest.slice(0, 5)) await f.listed.setFeatured(f.admin, id, 7);
      const outcomes = await Promise.allSettled([f.listed.setFeatured(f.admin, rest[5]!, 7), f.listed.setFeatured(f.admin, rest[6]!, 7)]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const extra = outcomes[0]!.status === "fulfilled" ? rest[6]! : rest[5]!;
      await expect(f.listed.setFeatured(f.admin, extra, 0)).rejects.toThrow("assistant_featured_limit");
      expect((await f.listed.setFeatured(f.admin, rest[4]!, 0))[0]).toEqual({ assistantId: rest[4], featuredOrder: 0 });
      const stored = await prisma.assistantPublication.findMany({ where: { featuredOrder: { not: null } }, select: { featuredOrder: true } });
      expect(new Set(stored.map((row) => row.featuredOrder)).size).toBe(8);

      const page = await f.listed.list(f.admin, { limit: 50 });
      expect(page.assistants.slice(0, 8).map((row) => row.featuredOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(page.assistants.find((row) => row.assistantId === extra)).toMatchObject({ featuredOrder: null, chatCount30Days: 0 });

      await f.listed.unlist(f.admin, a);
      expect(await prisma.assistantPublication.findMany({ where: { assistantId: a }, select: { scope: true } })).toEqual([{ scope: "group" }]);
      await expect(f.listed.unlist(f.admin, a)).rejects.toThrow("assistant_not_available");
      await expect(f.listed.setFeatured(f.admin, a, 0)).rejects.toThrow("assistant_not_available");
      const featured = await loadFeaturedAssistantOrders(prisma);
      expect(featured.has(a)).toBe(false);
      expect([...featured.values()].sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
      await prisma.assistantDefinition.update({ where: { id: b }, data: { archivedAt: new Date() } });
      expect((await loadFeaturedAssistantOrders(prisma)).has(b)).toBe(false);
      expect((await f.listed.list(f.admin, { limit: 50 })).assistants.some((row) => row.assistantId === b)).toBe(false);
      const refreshed = await f.listed.setFeatured(f.admin, extra, 7);
      expect(refreshed.map((row) => row.featuredOrder)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(refreshed.some((row) => row.assistantId === b)).toBe(false);
    } finally { await f.cleanup(); }
  });

  it("counts distinct chats with a run of the Assistant in the last 30 days", async () => {
    const f = await fixture();
    try {
      const assistant = await f.assistant();
      await f.installation(assistant.id);
      const now = new Date();
      const run = async (chatId: string, createdAt: Date) => {
        const question = await prisma.message.create({ data: { chatId, content: textMessageContent("Question"), role: "user", status: "complete" } });
        const answer = await prisma.message.create({ data: { chatId, content: textMessageContent("Answer"), modelId: "fake-qsa",
          parentMessageId: question.id, provider: "fake", role: "assistant", status: "complete" } });
        await prisma.modelRun.create({ data: { assistantId: assistant.id, assistantIdentity: { name: assistant.name, avatar },
          assistantMessageId: answer.id, chatId, createdAt, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
          status: "complete", userId: f.peer, userMessageId: question.id } });
      };
      const chats = await Promise.all(["First", "Second", "Old"].map((title) => prisma.chat.create({ data: { title, userId: f.peer } })));
      await run(chats[0]!.id, now);
      await run(chats[0]!.id, now);
      await run(chats[1]!.id, new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000));
      await run(chats[2]!.id, new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000));
      expect(await loadAssistantRecentChatCounts(prisma, [assistant.id], now)).toEqual(new Map([[assistant.id, 2]]));
      const page = await f.listed.list(f.admin, { limit: 50 });
      expect(page.assistants.find((row) => row.assistantId === assistant.id)).toMatchObject({ chatCount30Days: 2 });
      expect(JSON.stringify(page)).not.toMatch(/First|Second|listing-peer/);
    } finally { await f.cleanup(); }
  });
});
