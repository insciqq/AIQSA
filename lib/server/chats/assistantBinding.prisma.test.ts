import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { CHAT_ASSISTANT_DELETED_MARKER, type ChatAssistantOverridesPatch } from "../../contracts/chats";
import type { KnowledgePlan } from "../../contracts/knowledge";
import { textMessageContent } from "../../domain/content";
import { defaultProviderModels } from "../../domain/catalog";
import { providerTemplateIds } from "../../domain/providerTemplates";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import { ActiveRunConflictError } from "../runs/runRepositoryContract";
import { ChatAssistantUpdateError } from "./assistantUpdateError";
import { createPrismaChatNavigationRepository } from "./navigation";
import { createPrismaChatRepository } from "./prismaRepository";

const avatar = {
  accents: [0, 4],
  backgroundShape: "circle",
  foregroundShape: "diamond",
  kind: "generated",
  paletteId: "ocean",
  recipeVersion: 1,
  rotations: [0, 2]
};

type BindingFixture = Readonly<{
  assistants: Readonly<{
    archived: string;
    foreign: string;
    groupShared: string;
    installation: string;
    own: string;
    ownArchived: string;
    ownFixed: string;
  }>;
  groupId: string;
  projectIds: string[];
  userId: string;
}>;

/** A requester, another owner, and one Assistant for every availability case. */
async function withBindingFixture<T>(run: (fixture: BindingFixture) => Promise<T>): Promise<T> {
  const suffix = randomUUID();
  const userId = `chat-binding-user-${suffix}`;
  const ownerId = `chat-binding-owner-${suffix}`;
  const assistantIds: string[] = [];
  const projectIds: string[] = [];
  await prisma.user.create({
    data: {
      displayName: "Binding user",
      id: userId,
      settings: {
        create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel }
      },
      status: "active"
    }
  });
  await prisma.user.create({ data: { displayName: "Binding owner", id: ownerId, status: "active" } });
  const group = await prisma.group.create({ data: { name: `Chat binding group ${suffix}` } });
  await prisma.userGroup.create({ data: { groupId: group.id, userId } });
  const define = async (
    ownerUserId: string,
    name: string,
    extra: Partial<Prisma.AssistantDefinitionUncheckedCreateInput> = {}
  ) => {
    const created = await prisma.assistantDefinition.create({
      data: {
        avatar,
        name,
        ownerUserId,
        providerModelId: providerTemplateIds.fakeModel,
        searchPlan: { mode: "off" },
        systemPrompt: "Answer directly.",
        ...extra
      }
    });
    assistantIds.push(created.id);
    return created.id;
  };

  try {
    const own = await define(userId, "Own helper", {
      knowledgePolicy: "adjustable",
      modelPolicy: "adjustable",
      searchPolicy: "adjustable",
      skillsPolicy: "adjustable",
      toolsPolicy: "adjustable"
    });
    const ownFixed = await define(userId, "Own fixed helper");
    const ownArchived = await define(userId, "Own archived helper");
    const installation = await define(ownerId, "Installation helper");
    const groupShared = await define(ownerId, "Group helper");
    const foreign = await define(ownerId, "Foreign helper");
    const archived = await define(ownerId, "Archived helper");
    await prisma.assistantPublication.createMany({
      data: [
        { assistantId: installation, publishedByUserId: ownerId, scope: "installation" },
        { assistantId: groupShared, groupId: group.id, publishedByUserId: ownerId, scope: "group" },
        { assistantId: archived, publishedByUserId: ownerId, scope: "installation" }
      ]
    });
    await prisma.assistantDefinition.updateMany({
      data: { archivedAt: new Date() },
      where: { id: { in: [archived, ownArchived] } }
    });
    return await run({
      assistants: { archived, foreign, groupShared, installation, own, ownArchived, ownFixed },
      groupId: group.id,
      projectIds,
      userId
    });
  } finally {
    await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
    await prisma.projectAssistantBinding.deleteMany({ where: { assistantId: { in: assistantIds } } });
    await prisma.modelRun.deleteMany({ where: { userId } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.userSettings.updateMany({ data: { defaultAssistantId: null }, where: { userId } });
    await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
    await prisma.group.deleteMany({ where: { id: group.id } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, ownerId] } } });
  }
}

/** A deterministic catalog, so override checks do not depend on seeded providers. */
function stubCatalog(): Promise<CatalogData> {
  return Promise.resolve({
    entitlements: {
      modelKeys: new Set(["openai:gpt-5.5"]),
      providerKeys: new Set(),
      searchStrategies: new Set()
    },
    models: defaultProviderModels,
    searchStrategies: [],
    settings: {
      defaultControlValues: {},
      defaultProviderModelId: "gpt-5.5",
      defaultSearchPlan: null,
      showCitations: true,
      showReasoningBlocks: false
    }
  });
}

function repository() {
  return createPrismaChatRepository(prisma, { loadCatalogData: stubCatalog });
}

async function bindingColumns(chatId: string) {
  return prisma.chat.findUniqueOrThrow({
    select: {
      assistantId: true,
      assistantOverrides: true,
      defaultKnowledgePlan: true,
      defaultProviderModelId: true,
      defaultSearchPlan: true,
      updatedAt: true
    },
    where: { id: chatId }
  });
}

describe("chat Assistant binding", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("binds, reloads and removes an Assistant without touching the chat's ordinary defaults", async () => {
    await withBindingFixture(async ({ assistants, userId }) => {
      const chats = repository();
      const created = await chats.createChat({ title: "Bound chat", userId });
      const chatId = created!.id;
      const knowledge: KnowledgePlan = { baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: 1 };
      await chats.updateChat({
        chatId,
        defaultKnowledgePlan: knowledge,
        defaultSearchPlan: { mode: "all_selected", optionIds: [] },
        userId
      });
      const ordinary = await bindingColumns(chatId);

      await expect(chats.updateChat({ assistantId: assistants.own, chatId, userId }))
        .resolves.toMatchObject({ assistantId: assistants.own });
      await expect(chats.getChat({ chatId, userId })).resolves.toMatchObject({ assistantId: assistants.own });
      expect((await chats.listWorkspace(userId))?.chats.find((chat) => chat.id === chatId))
        .toMatchObject({ assistantId: assistants.own });

      await chats.updateChat({ assistantOverrides: { tools: { mode: "load_all" } }, chatId, userId });
      await expect(bindingColumns(chatId)).resolves.toMatchObject({
        assistantId: assistants.own,
        assistantOverrides: { tools: { mode: "load_all" } }
      });

      // Changing the Assistant starts from its own values again.
      for (const assistantId of [assistants.installation, assistants.groupShared]) {
        await expect(chats.updateChat({ assistantId, chatId, userId })).resolves.toMatchObject({ assistantId });
        await expect(bindingColumns(chatId)).resolves.toMatchObject({ assistantId, assistantOverrides: null });
      }

      // A chat left with a deleted Assistant's marker binds again cleanly.
      await prisma.chat.update({
        data: { assistantId: null, assistantOverrides: CHAT_ASSISTANT_DELETED_MARKER },
        where: { id: chatId }
      });
      await chats.updateChat({ assistantId: assistants.own, chatId, userId });
      await expect(bindingColumns(chatId)).resolves.toMatchObject({ assistantId: assistants.own, assistantOverrides: null });

      await chats.updateChat({ assistantOverrides: { skills: { mode: "off" } }, chatId, userId });
      await expect(chats.updateChat({ assistantId: null, chatId, userId })).resolves.toMatchObject({ assistantId: null });
      const removed = await bindingColumns(chatId);
      expect(removed).toMatchObject({
        assistantId: null,
        assistantOverrides: null,
        defaultKnowledgePlan: ordinary.defaultKnowledgePlan,
        defaultProviderModelId: ordinary.defaultProviderModelId,
        defaultSearchPlan: ordinary.defaultSearchPlan
      });

      // "Continue without the Assistant" also clears a deleted Assistant's marker.
      await prisma.chat.update({ data: { assistantOverrides: CHAT_ASSISTANT_DELETED_MARKER }, where: { id: chatId } });
      await chats.updateChat({ assistantId: null, chatId, userId });
      await expect(bindingColumns(chatId)).resolves.toMatchObject({ assistantId: null, assistantOverrides: null });
    });
  });

  it("answers foreign, archived and missing Assistants alike and changes nothing", async () => {
    await withBindingFixture(async ({ assistants, groupId, userId }) => {
      const chats = repository();
      const chatId = (await chats.createChat({ title: "Neutral chat", userId }))!.id;
      await chats.updateChat({ assistantId: assistants.own, chatId, userId });
      const before = await bindingColumns(chatId);

      await prisma.group.update({ data: { archivedAt: new Date() }, where: { id: groupId } });
      for (const assistantId of [
        assistants.foreign,
        assistants.archived,
        assistants.ownArchived,
        assistants.groupShared,
        randomUUID()
      ]) {
        const refusal = await chats.updateChat({ assistantId, chatId, userId }).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(ChatAssistantUpdateError);
        expect(refusal).toMatchObject({ code: "assistant_not_available", message: "assistant_not_available" });
      }
      await expect(bindingColumns(chatId)).resolves.toEqual(before);
    });
  });

  it("checks overrides against the Assistant's row policies and the requester's catalog", async () => {
    await withBindingFixture(async ({ assistants, userId }) => {
      const chats = repository();
      const chatId = (await chats.createChat({ title: "Override chat", userId }))!.id;
      const code = (update: Parameters<typeof chats.updateChat>[0]) =>
        chats.updateChat(update).then(() => null, (error: unknown) =>
          error instanceof ChatAssistantUpdateError ? error.code : error);

      await expect(code({ assistantOverrides: { tools: { mode: "off" } }, chatId, userId }))
        .resolves.toBe("assistant_overrides_not_allowed");

      await chats.updateChat({ assistantId: assistants.ownFixed, chatId, userId });
      await expect(code({ assistantOverrides: { tools: { mode: "off" } }, chatId, userId }))
        .resolves.toBe("assistant_overrides_not_allowed");
      await expect(code({ assistantOverrides: { tools: null }, chatId, userId })).resolves.toBeNull();

      await chats.updateChat({ assistantId: assistants.own, chatId, userId });
      await expect(code({
        assistantOverrides: {
          controls: { maxOutputTokens: 1_000 },
          knowledge: { mode: "all_my_knowledge" },
          model: { mode: "model", modelId: "gpt-5.5" },
          search: { mode: "off" }
        },
        chatId,
        userId
      })).resolves.toBeNull();
      await expect(bindingColumns(chatId)).resolves.toMatchObject({
        assistantOverrides: {
          controls: { maxOutputTokens: 1_000 },
          knowledge: { mode: "all_my_knowledge" },
          model: { mode: "model", modelId: "gpt-5.5" },
          search: { mode: "off" }
        }
      });
      // Parameters follow the model they were chosen for.
      await expect(code({ assistantOverrides: { model: null }, chatId, userId })).resolves.toBeNull();
      await expect(bindingColumns(chatId)).resolves.toMatchObject({
        assistantOverrides: { knowledge: { mode: "all_my_knowledge" }, search: { mode: "off" } }
      });

      const invalid: ChatAssistantOverridesPatch[] = [
        { model: { mode: "model", modelId: "not-in-catalog" } },
        { search: { mode: "all_selected", optionIds: ["unknown-search"] } },
        { knowledge: { baseIds: [randomUUID()], mode: "explicit", sourceIds: [] } }
      ];
      for (const assistantOverrides of invalid) {
        await expect(code({ assistantOverrides, chatId, userId })).resolves.toBe("assistant_overrides_invalid");
      }
      await expect(bindingColumns(chatId)).resolves.toMatchObject({
        assistantOverrides: { knowledge: { mode: "all_my_knowledge" }, search: { mode: "off" } }
      });

      // A binding that stopped being available cannot be adjusted.
      await chats.updateChat({ assistantId: assistants.installation, chatId, userId });
      await prisma.assistantPublication.deleteMany({ where: { assistantId: assistants.installation } });
      await expect(code({ assistantOverrides: { tools: null }, chatId, userId }))
        .resolves.toBe("assistant_not_available");
    });
  });

  it("keeps a Project chat to its Project's Assistants and checks its values against the Project", async () => {
    await withBindingFixture(async ({ assistants, projectIds, userId }) => {
      const project = await createPrismaProjectRepository(prisma).create({
        actorDisplayName: "Binding user",
        description: "",
        name: `Binding project ${randomUUID()}`,
        preferredModelId: providerTemplateIds.fakeModel,
        userId
      });
      if (project.kind !== "ok") throw new Error(project.kind);
      projectIds.push(project.value.id);
      const chat = await prisma.chat.create({
        data: {
          createdByDisplayName: "Binding user",
          createdByUserId: userId,
          memoryMode: "EXCLUDED",
          projectId: project.value.id,
          title: "Project chat",
          userId: null
        }
      });
      const chats = repository();
      const code = (assistantOverrides: ChatAssistantOverridesPatch) =>
        chats.updateChat({ assistantOverrides, chatId: chat.id, userId }).then(() => null, (error: unknown) =>
          error instanceof ChatAssistantUpdateError ? error.code : error);
      const projectDefaults = async () => (await prisma.project.findUniqueOrThrow({
        select: { defaults: true },
        where: { id: project.value.id }
      })).defaults;
      const defaultsBefore = await projectDefaults();

      // Owning the Assistant is not enough: the Project must bind it.
      await expect(chats.updateChat({ assistantId: assistants.own, chatId: chat.id, userId }))
        .rejects.toMatchObject({ code: "assistant_not_available" });
      await prisma.projectAssistantBinding.create({
        data: { addedByUserId: userId, assistantId: assistants.own, projectId: project.value.id }
      });
      await expect(chats.updateChat({ assistantId: assistants.own, chatId: chat.id, userId }))
        .resolves.toMatchObject({ assistantId: assistants.own });

      // Values the Project provides are stored for the chat.
      await expect(code({
        model: { mode: "model", modelId: providerTemplateIds.fakeModel },
        tools: { mode: "off" }
      })).resolves.toBeNull();
      await expect(bindingColumns(chat.id)).resolves.toMatchObject({
        assistantId: assistants.own,
        assistantOverrides: { model: { mode: "model", modelId: providerTemplateIds.fakeModel }, tools: { mode: "off" } }
      });

      // The member's personal model, Search, Knowledge and "All my knowledge" never run in a Project.
      const personal: ChatAssistantOverridesPatch[] = [
        { model: { mode: "model", modelId: "gpt-5.5" } },
        { search: { mode: "all_selected", optionIds: ["unknown-search"] } },
        { knowledge: { baseIds: [randomUUID()], mode: "explicit", sourceIds: [] } },
        { knowledge: { mode: "all_my_knowledge" } }
      ];
      for (const assistantOverrides of personal) {
        await expect(code(assistantOverrides)).resolves.toBe("assistant_overrides_invalid");
      }
      await expect(bindingColumns(chat.id)).resolves.toMatchObject({
        assistantOverrides: { model: { mode: "model", modelId: providerTemplateIds.fakeModel }, tools: { mode: "off" } }
      });

      // Changing the chat's Assistant never changes the Project's defaults.
      await expect(chats.updateChat({ assistantId: null, chatId: chat.id, userId }))
        .resolves.toMatchObject({ assistantId: null });
      await expect(bindingColumns(chat.id)).resolves.toMatchObject({ assistantId: null, assistantOverrides: null });
      await expect(projectDefaults()).resolves.toEqual(defaultsBefore);
    });
  });

  it("waits for an active run before changing the Assistant", async () => {
    await withBindingFixture(async ({ assistants, userId }) => {
      const chats = repository();
      const chatId = (await chats.createChat({ title: "Busy chat", userId }))!.id;
      const userMessage = await prisma.message.create({
        data: { chatId, content: textMessageContent("Question"), role: "user", status: "complete" }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId,
          content: textMessageContent(""),
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "streaming"
        }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId,
          modelId: "fake-qsa",
          normalizedRequest: {},
          provider: "fake",
          status: "streaming",
          userId,
          userMessageId: userMessage.id
        }
      });
      await expect(chats.updateChat({ assistantId: assistants.own, chatId, userId }))
        .rejects.toBeInstanceOf(ActiveRunConflictError);
      await expect(chats.updateChat({ assistantOverrides: { tools: null }, chatId, userId }))
        .rejects.toBeInstanceOf(ActiveRunConflictError);
      await expect(bindingColumns(chatId)).resolves.toMatchObject({ assistantId: null });
    });
  });

  it("shows an Assistant avatar in navigation only while the viewer can use it", async () => {
    await withBindingFixture(async ({ assistants, userId }) => {
      const bound = async (title: string, assistantId: string | null) => (await prisma.chat.create({
        data: { assistantId, title, userId }
      })).id;
      const ownChat = await bound("Roadmap own", assistants.own);
      const installationChat = await bound("Roadmap installation", assistants.installation);
      const foreignChat = await bound("Roadmap foreign", assistants.foreign);
      const plainChat = await bound("Roadmap plain", null);
      const navigation = createPrismaChatNavigationRepository(prisma);
      const identities = async () => {
        const pages = await Promise.all([
          navigation.listPage({ cursor: null, limit: 50, userId }),
          navigation.searchPage({ cursor: null, limit: 50, query: "roadmap", userId })
        ]);
        return pages.map((page) => Object.fromEntries(
          (page.kind === "ok" ? page.page.chats : []).map((chat) => [chat.id, chat.assistant?.name ?? null])
        ));
      };

      const expected = {
        [ownChat]: "Own helper",
        [installationChat]: "Installation helper",
        [foreignChat]: null,
        [plainChat]: null
      };
      await expect(identities()).resolves.toEqual([expected, expected]);

      await prisma.assistantPublication.deleteMany({ where: { assistantId: assistants.installation } });
      const revoked = { ...expected, [installationChat]: null };
      await expect(identities()).resolves.toEqual([revoked, revoked]);
    });
  });

  it("reports whether the saved default Assistant is available without clearing it", async () => {
    await withBindingFixture(async ({ assistants, userId }) => {
      const loadCatalogData = createPrismaCatalogDataLoader({ prisma });
      await prisma.userSettings.update({ data: { defaultAssistantId: assistants.installation }, where: { userId } });
      await expect(loadCatalogData(userId)).resolves.toMatchObject({
        settings: { defaultAssistantAvailable: true, defaultAssistantId: assistants.installation }
      });
      await prisma.assistantPublication.deleteMany({ where: { assistantId: assistants.installation } });
      await expect(loadCatalogData(userId)).resolves.toMatchObject({
        settings: { defaultAssistantAvailable: false, defaultAssistantId: assistants.installation }
      });
      await expect(prisma.userSettings.findUniqueOrThrow({ select: { defaultAssistantId: true }, where: { userId } }))
        .resolves.toEqual({ defaultAssistantId: assistants.installation });
    });
  });
});
