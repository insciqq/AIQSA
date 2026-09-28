import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { decodeAssistantDetailResponse } from "../../contracts/assistants";
import { defaultProviderModels } from "../../domain/catalog";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { prisma } from "../prisma";
import { createPrismaAdoptChatSetup } from "./adoptChatSetup";
import { createAdoptChatSetupHandler } from "./handlers";
import { createPrismaAssistantRepository } from "./prismaRepository";

const avatar = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

/** The seeded Fake QSA model under its database id; Chat defaults: Load all, no Knowledge. */
function stubCatalog(): Promise<CatalogData> {
  const fake = defaultProviderModels.find((model) => model.provider === "fake")!;
  return Promise.resolve({
    entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
    models: [{ ...fake, modelId: providerTemplateIds.fakeModel, provider: providerTemplateIds.fakeConnection }],
    searchStrategies: [],
    settings: {
      defaultControlValues: {},
      defaultKnowledgePlan: null,
      defaultMcpMode: "load_all",
      defaultProviderModelId: providerTemplateIds.fakeModel,
      defaultSearchPlan: null,
      showCitations: true,
      showReasoningBlocks: false
    }
  });
}

function session(userId: string, role: "admin" | "user" = "user"): AuthenticatedSession {
  return {
    expiresAt: new Date(Date.now() + 60_000),
    id: `session-${userId}`,
    user: { displayName: userId, email: `${userId}@example.test`, id: userId, role, status: "active" },
    userId
  };
}

type AdoptFixture = Readonly<{
  assistantId: string;
  otherAssistantId: string;
  otherUserId: string;
  userId: string;
}>;

async function withAdoptFixture<T>(run: (fixture: AdoptFixture) => Promise<T>): Promise<T> {
  const suffix = randomUUID();
  const userId = `adopt-owner-${suffix}`;
  const otherUserId = `adopt-other-${suffix}`;
  const assistantIds: string[] = [];
  for (const [id, displayName] of [[userId, "Adopt owner"], [otherUserId, "Adopt other"]] as const) {
    await prisma.user.create({
      data: {
        displayName,
        id,
        settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel } },
        status: "active"
      }
    });
  }
  const define = async (name: string, extra: Partial<Prisma.AssistantDefinitionUncheckedCreateInput> = {}) => {
    const created = await prisma.assistantDefinition.create({
      data: {
        avatar,
        knowledgePolicy: "adjustable",
        modelPolicy: "adjustable",
        name,
        ownerUserId: userId,
        providerModelId: providerTemplateIds.fakeModel,
        searchPlan: { mode: "off" },
        searchPolicy: "adjustable",
        skillsPolicy: "adjustable",
        systemPrompt: "Answer directly.",
        // Tools stay fixed: a stored Tools value is never adopted.
        toolsPolicy: "fixed",
        ...extra
      }
    });
    assistantIds.push(created.id);
    return created.id;
  };
  try {
    const assistantId = await define("Adoptable helper");
    const otherAssistantId = await define("Other helper");
    await prisma.assistantPublication.create({
      data: { assistantId, publishedByUserId: userId, scope: "installation" }
    });
    return await run({ assistantId, otherAssistantId, otherUserId, userId });
  } finally {
    await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
    await prisma.modelRun.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.chat.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  }
}

const chats = createPrismaChatRepository(prisma, { loadCatalogData: stubCatalog });

async function boundChat(userId: string, assistantId: string, overrides: Prisma.InputJsonValue | undefined) {
  const chatId = (await chats.createChat({ title: "Adopt chat", userId }))!.id;
  await prisma.chat.update({ data: { assistantId, assistantOverrides: overrides }, where: { id: chatId } });
  return chatId;
}

function adopt(userId: string, assistantId: string, body: unknown, role: "admin" | "user" = "user") {
  const handler = createAdoptChatSetupHandler({
    adoptChatSetup: createPrismaAdoptChatSetup(prisma, { loadCatalogData: stubCatalog }),
    loadCatalogData: stubCatalog,
    repository: createPrismaAssistantRepository(prisma),
    resolveAuth: async () => session(userId, role)
  });
  return handler(new Request(`http://test/api/me/assistants/${assistantId}/adopt-chat-setup`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  }), { params: { assistantId } });
}

async function state(assistantId: string, chatId: string) {
  const [definition, chat] = await Promise.all([
    prisma.assistantDefinition.findUniqueOrThrow({
      select: { knowledgeSelection: true, mcpMode: true, skillsMode: true, skillsPolicy: true, toolsPolicy: true, version: true },
      where: { id: assistantId }
    }),
    prisma.chat.findUniqueOrThrow({ select: { assistantOverrides: true }, where: { id: chatId } })
  ]);
  return { chat, definition };
}

describe("adopt chat setup", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("writes the rows changed for the chat, keeps policies and clears exactly those overrides", async () => {
    await withAdoptFixture(async ({ assistantId, userId }) => {
      const chatId = await boundChat(userId, assistantId, { skills: { mode: "off" }, tools: { mode: "load_all" } });
      const before = await state(assistantId, chatId);

      const response = await adopt(userId, assistantId, { chatId, expectedVersion: before.definition.version });
      expect(response.status).toBe(200);
      const detail = decodeAssistantDetailResponse(await response.json())?.assistant;
      expect(detail).toMatchObject({ id: assistantId, version: before.definition.version + 1 });
      expect(detail?.content.rows.skills).toEqual({ policy: "adjustable", value: { links: [], mode: "off" } });

      await expect(state(assistantId, chatId)).resolves.toEqual({
        // The fixed Tools row's stale value stays for admission to clear.
        chat: { assistantOverrides: { tools: { mode: "load_all" } } },
        definition: { ...before.definition, skillsMode: "off", version: before.definition.version + 1 }
      });
      const projected = (await chats.getChat({ chatId, userId }))?.assistant;
      expect(projected).toMatchObject({ rows: { skills: { provenance: "assistant", value: { mode: "off" } } }, state: "bound" });

      // Nothing left to adopt: the ordinary success, nothing written.
      const again = await adopt(userId, assistantId, { chatId, expectedVersion: before.definition.version + 1 });
      expect(again.status).toBe(200);
      await expect(state(assistantId, chatId)).resolves.toMatchObject({ definition: { version: before.definition.version + 1 } });
    });
  });

  it("adopts a chat mode over the owner's own resources as inherit only when inherit means it", async () => {
    await withAdoptFixture(async ({ assistantId, userId }) => {
      await prisma.assistantDefinition.update({ data: { toolsPolicy: "adjustable" }, where: { id: assistantId } });
      const { version } = await prisma.assistantDefinition.findUniqueOrThrow({ select: { version: true }, where: { id: assistantId } });

      const unexpressible = await boundChat(userId, assistantId, { knowledge: { mode: "all_my_knowledge" } });
      const refused = await adopt(userId, assistantId, { chatId: unexpressible, expectedVersion: version });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: "assistant_knowledge_bases_invalid", row: "knowledge" });
      await expect(state(assistantId, unexpressible)).resolves.toMatchObject({
        chat: { assistantOverrides: { knowledge: { mode: "all_my_knowledge" } } },
        definition: { version }
      });

      // The owner's Chat defaults use Load all, so inherit reproduces it.
      const loadAll = await boundChat(userId, assistantId, { tools: { mode: "load_all" } });
      expect((await adopt(userId, assistantId, { chatId: loadAll, expectedVersion: version })).status).toBe(200);
      await expect(state(assistantId, loadAll)).resolves.toMatchObject({
        chat: { assistantOverrides: null },
        definition: { mcpMode: "inherit", toolsPolicy: "adjustable", version: version + 1 }
      });
    });
  });

  it("refuses neutrally unless the owner adopts from their own chat bound to this Assistant", async () => {
    await withAdoptFixture(async ({ assistantId, otherAssistantId, otherUserId, userId }) => {
      const overrides = { skills: { mode: "off" } };
      const version = (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version;
      const foreignChat = await boundChat(otherUserId, assistantId, overrides);
      const otherBinding = await boundChat(userId, otherAssistantId, overrides);
      const ownChat = await boundChat(userId, assistantId, overrides);

      for (const [caller, target, chatId, role] of [
        // A consumer of the published Assistant, in their own bound chat.
        [otherUserId, assistantId, foreignChat],
        // An administrator who does not own the Assistant, with the owner's chat and their own.
        [otherUserId, assistantId, ownChat, "admin"],
        [otherUserId, assistantId, foreignChat, "admin"],
        // The owner with another user's chat.
        [userId, assistantId, foreignChat],
        // The owner with a chat bound to another of their Assistants.
        [userId, assistantId, otherBinding],
        [userId, assistantId, randomUUID()],
        [userId, randomUUID(), ownChat]
      ] as ReadonlyArray<readonly [string, string, string, ("admin" | "user")?]>) {
        const response = await adopt(caller, target, { chatId, expectedVersion: version }, role);
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: "assistant_not_available" });
      }

      const stale = await adopt(userId, assistantId, { chatId: ownChat, expectedVersion: version + 1 });
      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "assistant_version_conflict" });

      await prisma.assistantDefinition.update({ data: { archivedAt: new Date() }, where: { id: assistantId } });
      const archivedVersion = (await prisma.assistantDefinition.findUniqueOrThrow({ where: { id: assistantId } })).version;
      const archived = await adopt(userId, assistantId, { chatId: ownChat, expectedVersion: archivedVersion });
      expect(archived.status).toBe(409);
      expect(await archived.json()).toEqual({ error: "assistant_archived" });

      for (const chatId of [foreignChat, otherBinding, ownChat]) {
        await expect(prisma.chat.findUniqueOrThrow({ select: { assistantOverrides: true }, where: { id: chatId } }))
          .resolves.toEqual({ assistantOverrides: overrides });
      }
      await expect(prisma.assistantDefinition.findUniqueOrThrow({ select: { skillsMode: true }, where: { id: assistantId } }))
        .resolves.toEqual({ skillsMode: "auto" });
    });
  });

  it("waits for the chat's active run, as a chat update does", async () => {
    await withAdoptFixture(async ({ assistantId, userId }) => {
      const overrides = { skills: { mode: "off" } };
      const chatId = await boundChat(userId, assistantId, overrides);
      const before = await state(assistantId, chatId);
      const question = await prisma.message.create({
        data: { chatId, content: textMessageContent("Question"), role: "user", status: "complete" }
      });
      const answer = await prisma.message.create({
        data: { chatId, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: "streaming" }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: answer.id,
          chatId,
          modelId: "fake-qsa",
          normalizedRequest: {},
          provider: "fake",
          status: "streaming",
          userId,
          userMessageId: question.id
        }
      });

      const busy = await adopt(userId, assistantId, { chatId, expectedVersion: before.definition.version });
      expect(busy.status).toBe(409);
      expect(await busy.json()).toEqual({ error: "active_run_in_progress" });
      await expect(state(assistantId, chatId)).resolves.toEqual(before);
    });
  });
});
