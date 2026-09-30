import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  ASSISTANT_ROW_KEYS,
  type AssistantRowKey,
  type AssistantRows
} from "../../contracts/assistants";
import type { ModelParameterControls } from "../../contracts/catalog";
import type { ChatAssistantOverrides } from "../../contracts/chats";
import type { ProviderModelCatalogEntry } from "../../domain/catalog";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { resolveChatAssistantRows, type ChatAssistantChainContext } from "../chats/assistantProjection";
import { adoptedChatSetupRows, createPrismaAdoptChatSetup } from "./adoptChatSetup";
import type { AssistantRowAvailableResources, AssistantRowContextDefaults } from "./rowResolution";
import { storedColumnsFromAssistantRows } from "./storedContent";

const parameterControls: ModelParameterControls = {
  background: { defaultValue: false, supported: true },
  maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
  reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
  stream: { defaultValue: false, supported: true },
  temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
};

const defaults: AssistantRowContextDefaults = {
  controlsForModel: () => ({}),
  knowledge: { mode: "none" },
  modelId: "model-default",
  search: { mode: "off" },
  tools: { mode: "auto" }
};

const available: AssistantRowAvailableResources = {
  allMyKnowledge: true,
  knowledgeBaseIds: new Set(["kb-1"]),
  knowledgeSourceIds: new Set(),
  mcpServerIds: new Set(["mcp-1"]),
  modelIds: new Set(["model-a", "model-b", "model-default"]),
  searchOptionIds: new Set(["web-1"]),
  skillIds: new Set(["skill-1"])
};

function context(overrides: Partial<AssistantRowContextDefaults> = {}): ChatAssistantChainContext {
  return {
    available,
    defaults: { ...defaults, ...overrides },
    modelConnections: new Map(),
    modelParameters: (modelId) => available.modelIds.has(modelId)
      ? { baseParams: {}, controls: parameterControls, displayName: modelId, parameterProvider: "openai" }
      : null
  };
}

type RowOverrides = Partial<{ [Key in AssistantRowKey]: Partial<AssistantRows[Key]> }>;

function rows(overrides: RowOverrides = {}): AssistantRows {
  const base: AssistantRows = {
    controls: { policy: "adjustable", value: { reasoningEffort: "high" } },
    knowledge: { policy: "adjustable", value: { mode: "none" } },
    model: { policy: "adjustable", value: { mode: "model", modelId: "model-a" } },
    search: { policy: "adjustable", value: { mode: "all_selected", optionIds: ["web-1"] } },
    skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "auto" } },
    tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-1"] } }
  };
  return Object.fromEntries(ASSISTANT_ROW_KEYS.map((key) => [key, { ...base[key], ...overrides[key] }])) as AssistantRows;
}

function adopt(assistant: AssistantRows, stored: ChatAssistantOverrides, chain = context()) {
  const { resolution } = resolveChatAssistantRows({ assistant, context: chain, stored });
  const adopted = ASSISTANT_ROW_KEYS.filter((key) => resolution.rows[key].provenance === "chat");
  return { adopted, result: adoptedChatSetupRows({ adopted, assistant, defaults: chain.defaults, resolution }) };
}

describe("adopted chat setup rows", () => {
  it("writes only the chat's rows and keeps every policy", () => {
    const assistant = rows();
    const { adopted, result } = adopt(assistant, {
      knowledge: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [] },
      search: { mode: "off" },
      skills: { mode: "off" },
      // Fixed: ignored, never adopted.
      tools: { mode: "off" }
    });
    expect(adopted).toEqual(["search", "knowledge", "skills"]);
    expect(result).toEqual({
      ok: true,
      rows: {
        ...assistant,
        knowledge: { policy: "adjustable", value: { baseIds: ["kb-1"], mode: "explicit", sourceIds: [] } },
        search: { policy: "adjustable", value: { mode: "off" } },
        skills: { policy: "adjustable", value: { links: [{ delivery: "always", skillId: "skill-1" }], mode: "off" } }
      }
    });
  });

  it("keeps the Assistant's controls under the chat's while they apply", () => {
    const { adopted, result } = adopt(rows(), { controls: { temperature: 0.5 } });
    expect(adopted).toEqual(["controls"]);
    expect(result).toMatchObject({ rows: { controls: { value: { reasoningEffort: "high", temperature: 0.5 } } } });
  });

  it("carries a model change with the chat's controls only, as controls belong to the model", () => {
    expect(adopt(rows(), { model: { mode: "model", modelId: "model-b" } }).result).toMatchObject({
      rows: { controls: { policy: "adjustable", value: {} }, model: { value: { mode: "model", modelId: "model-b" } } }
    });
    expect(adopt(rows(), {
      controls: { temperature: 0.3 },
      model: { mode: "model", modelId: "model-b" }
    }).result).toMatchObject({ rows: { controls: { value: { temperature: 0.3 } } } });
  });

  it.each([
    ["tools", { tools: { policy: "adjustable" as const } }, { tools: { mode: "auto" as const } }, { tools: { mode: "auto" as const } },
      { mode: "inherit" }],
    ["tools", { tools: { policy: "adjustable" as const } }, { tools: { mode: "off" as const } }, { tools: { mode: "auto" as const } },
      { mode: "off" }],
    ["knowledge", {}, { knowledge: { mode: "all_my_knowledge" as const } }, { knowledge: { mode: "all_my_knowledge" as const } },
      { mode: "inherit" }]
  ] as const)("adopts a %s mode over the user's own resources as inherit when inherit means it", (key, overrides, stored, chatDefaults, value) => {
    const chain = context(chatDefaults as Partial<AssistantRowContextDefaults>);
    expect(adopt(rows(overrides as RowOverrides), stored as ChatAssistantOverrides, chain).result)
      .toMatchObject({ ok: true, rows: { [key]: { policy: "adjustable", value } } });
  });

  it.each([
    ["tools", { tools: { policy: "adjustable" as const } }, { tools: { mode: "load_all" as const } }, "assistant_mcp_servers_invalid"],
    ["knowledge", {}, { knowledge: { mode: "all_my_knowledge" as const } }, "assistant_knowledge_bases_invalid"]
  ] as const)("refuses a %s value the definition cannot express", (key, overrides, stored, code) => {
    expect(adopt(rows(overrides as RowOverrides), stored as ChatAssistantOverrides).result)
      .toEqual({ code, ok: false, row: key });
  });
});

function catalogData(): CatalogData {
  const model = (modelId: string): ProviderModelCatalogEntry => ({
    adapterKind: "openai_responses_native",
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, streaming: true, toolCalling: true, vision: false },
    contextWindow: 128_000,
    defaultParams: {},
    displayName: modelId,
    inputTokenPriceUsdPerMillion: 0,
    modelId,
    outputTokenPriceUsdPerMillion: 0,
    parameterControls,
    provider: "connection-1",
    providerDisplayName: "OpenAI",
    providerFamily: "openai",
    upstreamModelId: modelId
  });
  return {
    entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
    models: [model("model-a"), model("model-b")],
    searchStrategies: [],
    settings: {
      defaultControlValues: {},
      defaultMcpMode: "auto",
      defaultProviderModelId: "model-a",
      defaultSearchPlan: null,
      showCitations: true,
      showReasoningBlocks: false
    }
  };
}

type FakeState = {
  activeRun?: boolean;
  chat?: { archived: boolean; assistantId: string | null; assistantOverrides: unknown } | null;
  definition?: { archivedAt: Date | null; version: number } | null;
};

function fakeClient(state: FakeState, assistant = rows({ controls: { value: {} } })) {
  const statements: string[] = [];
  const chatUpdate = vi.fn(async () => ({}));
  const definitionUpdate = vi.fn(async () => ({}));
  const columns = storedColumnsFromAssistantRows(assistant);
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("FROM \"AssistantDefinition\"")) {
        statements.push("lock definition");
        return state.definition === null ? [] : [state.definition ?? { archivedAt: null, version: 3 }];
      }
      statements.push("lock chat");
      return state.chat === null ? [] : [state.chat ?? {
        archived: false,
        assistantId: "assistant-1",
        assistantOverrides: { model: { mode: "model", modelId: "model-b" } }
      }];
    },
    assistantDefinition: {
      findUnique: async () => {
        statements.push("rows");
        return columns;
      },
      update: definitionUpdate
    },
    chat: { update: chatUpdate },
    mcpGrant: { findMany: async () => [] },
    modelRun: {
      findFirst: async () => {
        statements.push("active run");
        return state.activeRun ? { id: "run-1" } : null;
      }
    },
    skillDefinition: { findMany: async () => [{ id: "skill-1" }] },
    userGroup: { findMany: async () => [] }
  };
  const client = {
    $transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx)
  } as unknown as PrismaClient;
  return { chatUpdate, client, definitionUpdate, statements };
}

function input(validate: (rows: AssistantRows) => string | null = () => null) {
  return { assistantId: "assistant-1", chatId: "chat-1", expectedVersion: 3, userId: "user-1", validate };
}

describe("adopting a chat setup", () => {
  it("writes the chat's rows, bumps the version once and clears exactly those overrides", async () => {
    const fake = fakeClient({
      chat: {
        archived: false,
        assistantId: "assistant-1",
        // Tools is fixed: its stale override is not adopted and stays for admission to clear.
        assistantOverrides: { model: { mode: "model", modelId: "model-b" }, search: { mode: "off" }, tools: { mode: "off" } }
      }
    });
    const validate = vi.fn(() => null);
    const adopt = createPrismaAdoptChatSetup(fake.client, { loadCatalogData: async () => catalogData() });
    await expect(adopt(input(validate))).resolves.toEqual({ kind: "adopted", rows: ["model", "search"] });

    // Definition locked before the chat.
    expect(fake.statements.slice(0, 2)).toEqual(["lock definition", "lock chat"]);
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({
      model: { policy: "adjustable", value: { mode: "model", modelId: "model-b" } },
      search: { policy: "adjustable", value: { mode: "off" } },
      tools: { policy: "fixed", value: { mode: "exact", serverIds: ["mcp-1"] } }
    }));
    expect(fake.definitionUpdate).toHaveBeenCalledTimes(1);
    expect(fake.definitionUpdate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelPolicy: "adjustable",
        providerModelId: "model-b",
        searchPlan: { mode: "off" },
        toolsPolicy: "fixed",
        version: { increment: 1 }
      }),
      where: { id: "assistant-1" }
    });
    expect(fake.chatUpdate).toHaveBeenCalledWith({
      data: { assistantOverrides: { tools: { mode: "off" } } },
      where: { id: "chat-1" }
    });
  });

  it.each([
    ["an Assistant the caller does not own", { definition: null }, "not_found"],
    ["another user's or a Project chat", { chat: null }, "not_found"],
    ["an archived chat", { chat: { archived: true, assistantId: "assistant-1", assistantOverrides: null } }, "not_found"],
    ["a chat bound to another Assistant", { chat: { archived: false, assistantId: "assistant-2", assistantOverrides: null } }, "not_found"],
    ["a stale version", { definition: { archivedAt: null, version: 2 } }, "version_conflict"],
    ["an archived Assistant", { definition: { archivedAt: new Date(), version: 3 } }, "archived"],
    ["an active run", { activeRun: true }, "active_run"],
    ["a chat with nothing changed", { chat: { archived: false, assistantId: "assistant-1", assistantOverrides: null } }, "unchanged"],
    ["a chat whose only override admission ignores",
      { chat: { archived: false, assistantId: "assistant-1", assistantOverrides: { tools: { mode: "off" } } } }, "unchanged"]
  ] as const)("refuses or skips %s without writing", async (_name, state, kind) => {
    const fake = fakeClient(state as FakeState);
    const adopt = createPrismaAdoptChatSetup(fake.client, { loadCatalogData: async () => catalogData() });
    await expect(adopt(input())).resolves.toEqual({ kind });
    expect(fake.definitionUpdate).not.toHaveBeenCalled();
    expect(fake.chatUpdate).not.toHaveBeenCalled();
  });

  it("refuses rows the ordinary save refuses, writing nothing", async () => {
    const fake = fakeClient({});
    const adopt = createPrismaAdoptChatSetup(fake.client, { loadCatalogData: async () => catalogData() });
    await expect(adopt(input(() => "assistant_model_not_available")))
      .resolves.toEqual({ invalid: "assistant_model_not_available", kind: "invalid" });
    const unexpressible = fakeClient({
      chat: { archived: false, assistantId: "assistant-1", assistantOverrides: { knowledge: { mode: "all_my_knowledge" } } }
    });
    await expect(createPrismaAdoptChatSetup(unexpressible.client, { loadCatalogData: async () => catalogData() })(input()))
      .resolves.toEqual({ error: { code: "assistant_knowledge_bases_invalid", ok: false, row: "knowledge" }, kind: "rows_invalid" });
    for (const client of [fake, unexpressible]) {
      expect(client.definitionUpdate).not.toHaveBeenCalled();
      expect(client.chatUpdate).not.toHaveBeenCalled();
    }
  });

  it("clears overrides equal to the Assistant without touching the definition", async () => {
    const fake = fakeClient({
      chat: { archived: false, assistantId: "assistant-1", assistantOverrides: { skills: { mode: "auto" } } }
    });
    await expect(createPrismaAdoptChatSetup(fake.client, { loadCatalogData: async () => catalogData() })(input()))
      .resolves.toEqual({ kind: "adopted", rows: ["skills"] });
    expect(fake.definitionUpdate).not.toHaveBeenCalled();
    expect(fake.chatUpdate).toHaveBeenCalledWith({ data: { assistantOverrides: Prisma.DbNull }, where: { id: "chat-1" } });
  });
});
