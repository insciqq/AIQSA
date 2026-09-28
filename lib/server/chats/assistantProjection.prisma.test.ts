import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHAT_ASSISTANT_DELETED_MARKER,
  decodeChatDetailResponse,
  type ChatAssistantProjection
} from "../../contracts/chats";
import { defaultProviderModels } from "../../domain/catalog";
import { providerTemplateIds } from "../../domain/providerTemplates";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import { loadChatAssistantProjection, loadProjectChatAssistant } from "./assistantProjection";
import { serializeChatDetail } from "./handlers";
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

/** The seeded Fake QSA model under its database id, so definitions can reference it. */
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

type ProjectionFixture = Readonly<{
  assistants: Readonly<{
    foreignArchived: string;
    foreignFixedTools: string;
    foreignUnpublished: string;
    own: string;
    ownArchived: string;
  }>;
  hidden: Readonly<{ knowledgeBaseId: string; mcpServerId: string }>;
  userId: string;
}>;

async function withProjectionFixture<T>(run: (fixture: ProjectionFixture) => Promise<T>): Promise<T> {
  const suffix = randomUUID();
  const userId = `chat-projection-user-${suffix}`;
  const ownerId = `chat-projection-owner-${suffix}`;
  const hidden = { knowledgeBaseId: `kb-hidden-${suffix}`, mcpServerId: `mcp-hidden-${suffix}` };
  const assistantIds: string[] = [];
  await prisma.user.create({
    data: {
      displayName: "Projection user",
      id: userId,
      settings: { create: { defaultControlValues: {}, defaultProviderModelId: providerTemplateIds.fakeModel } },
      status: "active"
    }
  });
  await prisma.user.create({ data: { displayName: "Projection owner", id: ownerId, status: "active" } });
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
        systemPrompt: "Private instructions that never leave the definition.",
        ...extra
      }
    });
    assistantIds.push(created.id);
    return created.id;
  };
  try {
    const own = await define(userId, "Own helper", {
      knowledgePolicy: "adjustable",
      knowledgeSelection: { mode: "inherit" },
      mcpMode: "exact",
      mcpServerIds: [hidden.mcpServerId],
      modelPolicy: "adjustable",
      searchPolicy: "adjustable",
      skillsPolicy: "adjustable",
      toolsPolicy: "adjustable"
    });
    const ownArchived = await define(userId, "Own archived helper", { archivedAt: new Date() });
    const foreignFixedTools = await define(ownerId, "Published helper", {
      knowledgePolicy: "adjustable",
      knowledgeSelection: { baseIds: [hidden.knowledgeBaseId], mode: "explicit", sourceIds: [], version: 1 },
      mcpMode: "exact",
      mcpServerIds: [hidden.mcpServerId]
    });
    const foreignUnpublished = await define(ownerId, "Unpublished helper");
    const foreignArchived = await define(ownerId, "Archived published helper");
    await prisma.assistantPublication.createMany({
      data: [
        { assistantId: foreignFixedTools, publishedByUserId: ownerId, scope: "installation" },
        { assistantId: foreignArchived, publishedByUserId: ownerId, scope: "installation" }
      ]
    });
    await prisma.assistantDefinition.update({ data: { archivedAt: new Date() }, where: { id: foreignArchived } });
    return await run({
      assistants: { foreignArchived, foreignFixedTools, foreignUnpublished, own, ownArchived },
      hidden,
      userId
    });
  } finally {
    await prisma.assistantPublication.deleteMany({ where: { assistantId: { in: assistantIds } } });
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.assistantDefinition.deleteMany({ where: { id: { in: assistantIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, ownerId] } } });
  }
}

function repository() {
  return createPrismaChatRepository(prisma, { loadCatalogData: stubCatalog });
}

async function projectionOf(
  userId: string,
  binding: Readonly<{ assistantId: string | null; assistantOverrides?: Prisma.InputJsonValue | null }>
): Promise<ChatAssistantProjection | null> {
  const chats = repository();
  const chatId = (await chats.createChat({ title: "Projected chat", userId }))!.id;
  await prisma.chat.update({
    data: {
      assistantId: binding.assistantId,
      assistantOverrides: binding.assistantOverrides ?? undefined
    },
    where: { id: chatId }
  });
  const before = await prisma.chat.findUniqueOrThrow({ select: { assistantOverrides: true, updatedAt: true }, where: { id: chatId } });
  const detail = await chats.getChat({ chatId, userId });
  // A read never writes.
  await expect(prisma.chat.findUniqueOrThrow({ select: { assistantOverrides: true, updatedAt: true }, where: { id: chatId } }))
    .resolves.toEqual(before);
  const wire = JSON.parse(JSON.stringify({ chat: serializeChatDetail(detail!) }));
  const decoded = decodeChatDetailResponse(wire);
  expect(decoded).not.toBeNull();
  expect(JSON.stringify(wire)).not.toContain("Private instructions");
  return decoded!.assistant;
}

describe("chat detail Assistant projection", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("projects no Assistant for an unbound chat and the deleted state for the marker", async () => {
    await withProjectionFixture(async ({ userId }) => {
      await expect(projectionOf(userId, { assistantId: null })).resolves.toBeNull();
      await expect(projectionOf(userId, { assistantId: null, assistantOverrides: CHAT_ASSISTANT_DELETED_MARKER }))
        .resolves.toEqual({ state: "deleted" });
    });
  });

  it("projects a bound Assistant with its rows, defaults and chat changes", async () => {
    await withProjectionFixture(async ({ assistants, hidden, userId }) => {
      const bound = await projectionOf(userId, { assistantId: assistants.own });
      expect(bound).toMatchObject({
        availability: { ok: true },
        id: assistants.own,
        name: "Own helper",
        owned: true,
        ownerDisplayName: "Projection user",
        state: "bound"
      });
      if (bound?.state !== "bound") throw new Error("expected a bound projection");
      expect(bound.rows.model).toMatchObject({
        policy: "adjustable",
        provenance: "assistant",
        value: { mode: "model", modelId: providerTemplateIds.fakeModel }
      });
      expect(bound.rows.knowledge).toMatchObject({ assistantValue: { mode: "inherit" }, provenance: "default", value: { mode: "none" } });
      // The owner's own MCP server they can no longer use: counted, the row falls back to their Chat default.
      expect(bound.rows.tools).toEqual({
        assistantValue: { hiddenCount: 1, mode: "exact", serverIds: [] },
        deviation: { dependencies: [{ kind: "mcp", name: "Required MCP tools" }], reason: "tools_access" },
        policy: "adjustable",
        provenance: "fallback",
        value: { mode: "load_all" }
      });
      expect(JSON.stringify(bound)).not.toContain(hidden.mcpServerId);

      const overridden = await projectionOf(userId, {
        assistantId: assistants.own,
        assistantOverrides: { search: { mode: "off" }, skills: { mode: "off" }, tools: { mode: "off" } }
      });
      if (overridden?.state !== "bound") throw new Error("expected a bound projection");
      expect(overridden.rows.tools).toMatchObject({ provenance: "chat", value: { mode: "off" } });
      expect(overridden.rows.skills).toMatchObject({ provenance: "chat", value: { links: [], mode: "off" } });
      expect(overridden.rows.search).toMatchObject({ provenance: "chat", value: { mode: "off" } });
    });
  });

  it("reports an unusable fixed dependency neutrally to a consumer and the archived state to the owner", async () => {
    await withProjectionFixture(async ({ assistants, hidden, userId }) => {
      const consumer = await projectionOf(userId, {
        assistantId: assistants.foreignFixedTools,
        // A stored value for a fixed row is ignored and stays stored.
        assistantOverrides: { tools: { mode: "auto" } }
      });
      expect(consumer).toMatchObject({
        availability: { ok: false, reason: "tools_access" },
        owned: false,
        ownerDisplayName: "Projection owner",
        state: "bound"
      });
      if (consumer?.state !== "bound") throw new Error("expected a bound projection");
      expect(consumer.availability).not.toHaveProperty("dependencies");
      expect(consumer.rows.tools).toMatchObject({
        provenance: "assistant",
        value: { hiddenCount: 1, mode: "exact", serverIds: [] }
      });
      expect(consumer.rows.knowledge).toMatchObject({
        assistantValue: { baseIds: [], hiddenCount: 1, mode: "explicit", sourceIds: [] },
        deviation: { reason: "knowledge_access" },
        provenance: "fallback"
      });
      expect(JSON.stringify(consumer)).not.toMatch(new RegExp(`${hidden.mcpServerId}|${hidden.knowledgeBaseId}`, "u"));

      await expect(projectionOf(userId, { assistantId: assistants.ownArchived })).resolves.toMatchObject({
        availability: { ok: false, reason: "archived" },
        owned: true,
        state: "bound"
      });
    });
  });

  it("projects a bound Project chat from the Project alone", async () => {
    await withProjectionFixture(async ({ assistants, hidden, userId }) => {
      const created = await createPrismaProjectRepository(prisma).create({
        actorDisplayName: "Projection user",
        description: "",
        name: `Projection project ${randomUUID()}`,
        preferredModelId: providerTemplateIds.fakeModel,
        userId
      });
      if (created.kind !== "ok") throw new Error(created.kind);
      const projectId = created.value.id;
      try {
        // The member's own Chat defaults say Load all; the Project's say Off.
        await prisma.project.update({
          data: { defaults: { ...created.value.defaults, mcpMode: "off" } },
          where: { id: projectId }
        });
        await prisma.projectAssistantBinding.createMany({
          data: [assistants.own, assistants.ownArchived].map((assistantId) => ({ addedByUserId: userId, assistantId, projectId }))
        });
        const projectChat = (assistantId: string) => prisma.chat.create({
          data: {
            assistantId,
            createdByDisplayName: "Projection user",
            createdByUserId: userId,
            memoryMode: "EXCLUDED",
            projectId,
            title: "Project chat",
            userId: null
          }
        });
        const read = async (chatId: string) => {
          const detail = await repository().getChat({ chatId, userId });
          const wire = JSON.parse(JSON.stringify({ chat: serializeChatDetail(detail!) }));
          expect(JSON.stringify(wire)).not.toContain("Private instructions");
          return decodeChatDetailResponse(wire)!.assistant;
        };
        const chat = await projectChat(assistants.own);

        const bound = await read(chat.id);
        // Members see the Assistant as consumers of the Project.
        expect(bound).toMatchObject({
          availability: { ok: true },
          id: assistants.own,
          owned: false,
          ownerDisplayName: "Project",
          state: "bound"
        });
        if (bound?.state !== "bound") throw new Error("expected a bound projection");
        expect(bound.rows.model).toMatchObject({
          provenance: "assistant",
          value: { mode: "model", modelId: providerTemplateIds.fakeModel }
        });
        // The owner's own MCP server is not the Project's: the row runs with the Project's default.
        expect(bound.rows.tools).toEqual({
          assistantValue: { hiddenCount: 1, mode: "exact", serverIds: [] },
          deviation: { reason: "tools_access" },
          policy: "adjustable",
          provenance: "fallback",
          value: { mode: "off" }
        });
        expect(bound.rows.knowledge).toMatchObject({ provenance: "default", value: { mode: "none" } });
        expect(JSON.stringify(bound)).not.toContain(hidden.mcpServerId);

        // Archived, or no longer bound to the Project: never bound, and archived says only that.
        await expect(read((await projectChat(assistants.ownArchived)).id))
          .resolves.toEqual({ reason: "archived", state: "unavailable" });
        await prisma.projectAssistantBinding.deleteMany({ where: { assistantId: assistants.own, projectId } });
        await expect(read(chat.id)).resolves.toEqual({ state: "unavailable" });
      } finally {
        await prisma.project.deleteMany({ where: { id: projectId } });
      }
    });
  });

  it("counts the statements the chat detail read adds for its Assistant", async () => {
    await withProjectionFixture(async ({ assistants, userId }) => {
      const created = await createPrismaProjectRepository(prisma).create({
        actorDisplayName: "Projection user",
        description: "",
        name: `Counted project ${randomUUID()}`,
        preferredModelId: providerTemplateIds.fakeModel,
        userId
      });
      if (created.kind !== "ok") throw new Error(created.kind);
      const projectId = created.value.id;
      // Counts every SQL statement, relation loads included.
      let statements = 0;
      const counting = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
      counting.$on("query", () => {
        statements += 1;
      });
      try {
        await prisma.projectAssistantBinding.create({ data: { addedByUserId: userId, assistantId: assistants.own, projectId } });
        const personalChat = (assistantId: string | null) => prisma.chat.create({
          data: { assistantId, title: "Counted chat", userId }
        });
        const projectChat = (assistantId: string | null) => prisma.chat.create({
          data: {
            assistantId,
            createdByDisplayName: "Projection user",
            createdByUserId: userId,
            memoryMode: "EXCLUDED",
            projectId,
            title: "Counted Project chat",
            userId: null
          }
        });
        const cases = [
          ["personal-owner", await personalChat(assistants.own)],
          // Published to the viewer; names an MCP server and a Knowledge base they cannot use.
          ["personal-consumer", await personalChat(assistants.foreignFixedTools)],
          ["personal-unbound", await personalChat(null)],
          ["project-bound", await projectChat(assistants.own)],
          ["project-unbound", await projectChat(null)]
        ] as const;
        // The application's default catalog read, on the counting client.
        const chats = createPrismaChatRepository(counting);
        await counting.$queryRaw`SELECT 1`;
        const counts: Record<string, { detail: number; projection: number }> = {};
        for (const [name, chat] of cases) {
          statements = 0;
          const projection = await loadChatAssistantProjection(counting, {
            chat: { assistantId: chat.assistantId, assistantOverrides: chat.assistantOverrides, projectId: chat.projectId },
            userId
          }, { loadProjectChatAssistant });
          const projectionStatements = statements;
          statements = 0;
          const detail = await chats.getChat({ chatId: chat.id, userId });
          counts[name] = { detail: statements, projection: projectionStatements };
          // The detail read carries exactly this projection.
          expect(detail?.assistant).toEqual(projection);
          expect(projection === null ? null : projection.state).toBe(name.endsWith("-unbound") ? null : "bound");
          console.log(`AV2_STATEMENTS case=${name} projection=${projectionStatements} detail=${statements}`);
        }
        // An unbound chat adds no statement.
        expect(counts["personal-unbound"]!.projection).toBe(0);
        expect(counts["project-unbound"]!.projection).toBe(0);
        // Measured for a viewer without groups, projection only (owner,
        // consumer, Project): 21, 24 and 18 before the shared group read; 20,
        // 21 and 16 with it inside a transaction, whose BEGIN and COMMIT are
        // gone now, which leaves 18, 19 and 16. The bounds add a margin of 2.
        expect(counts["personal-owner"]!.projection).toBeLessThanOrEqual(20);
        expect(counts["personal-consumer"]!.projection).toBeLessThanOrEqual(21);
        expect(counts["project-bound"]!.projection).toBeLessThanOrEqual(18);
      } finally {
        await counting.$disconnect();
        await prisma.chat.deleteMany({ where: { projectId } });
        await prisma.project.deleteMany({ where: { id: projectId } });
      }
    });
  });

  it("discloses nothing about an Assistant the viewer cannot resolve beyond its owner archiving it", async () => {
    await withProjectionFixture(async ({ assistants, userId }) => {
      await expect(projectionOf(userId, { assistantId: assistants.foreignUnpublished, assistantOverrides: { tools: { mode: "off" } } }))
        .resolves.toEqual({ state: "unavailable" });
      // Still published to the viewer: they learn it is archived, and nothing else.
      await expect(projectionOf(userId, { assistantId: assistants.foreignArchived, assistantOverrides: { tools: { mode: "off" } } }))
        .resolves.toEqual({ reason: "archived", state: "unavailable" });
      await prisma.assistantDefinition.update({ data: { archivedAt: new Date() }, where: { id: assistants.foreignUnpublished } });
      await expect(projectionOf(userId, { assistantId: assistants.foreignUnpublished }))
        .resolves.toEqual({ state: "unavailable" });
    });
  });
});
