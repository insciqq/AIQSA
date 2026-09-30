import { describe, expect, it, vi } from "vitest";
import {
  assistantRowsFromLegacyFields,
  decodeAssistantDetailResponse,
  type AssistantRows
} from "../../contracts/assistants";
import type { ProviderModelCatalogEntry } from "../../domain/catalog";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { CatalogData } from "../catalog/currentUserCatalog";
import type { AdoptChatSetup, AdoptChatSetupResult } from "./adoptChatSetup";
import { createAdoptChatSetupHandler, type AdoptChatSetupHandlerDeps } from "./handlers";
import type { AssistantDetailData } from "./prismaRepository";

const avatar = {
  accents: [1],
  backgroundShape: "circle",
  foregroundShape: "ring",
  kind: "generated",
  paletteId: "ember",
  recipeVersion: 1,
  rotations: [0, 0]
};

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date(Date.now() + 60_000),
    id: "session-1",
    user: { displayName: "Owner", email: "owner@example.test", id: "user-1", role: "user", status: "active" },
    userId: "user-1"
  };
}

function catalogData(): CatalogData {
  const model: ProviderModelCatalogEntry = {
    adapterKind: "openai_responses_native",
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, streaming: true, toolCalling: true, vision: false },
    contextWindow: 128_000,
    defaultParams: {},
    displayName: "Luna",
    inputTokenPriceUsdPerMillion: 0,
    modelId: "model-1",
    outputTokenPriceUsdPerMillion: 0,
    parameterControls: {
      background: { defaultValue: false, supported: true },
      maxOutputTokens: { defaultValue: 4096, maxValue: 128_000 },
      reasoningEffort: { defaultValue: "medium", options: ["low", "medium", "high"], supported: true },
      stream: { defaultValue: false, supported: true },
      temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: true }
    },
    provider: "connection-1",
    providerDisplayName: "OpenAI",
    providerFamily: "openai",
    upstreamModelId: "gpt-test"
  };
  return {
    entitlements: { fullAccess: true, modelKeys: new Set(), providerKeys: new Set(), searchStrategies: new Set() },
    models: [model],
    searchStrategies: [],
    settings: {
      defaultControlValues: {},
      defaultProviderModelId: "model-1",
      defaultSearchPlan: null,
      showCitations: true,
      showReasoningBlocks: false
    }
  };
}

function rows(modelId: string): AssistantRows {
  return assistantRowsFromLegacyFields({
    knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpServerIds: [],
    providerModelId: modelId,
    runControls: {},
    searchPlan: { mode: "all_selected", optionIds: [] },
    skillIds: []
  });
}

function detail(): AssistantDetailData {
  return {
    archived: false,
    audience: { everyone: false, groupNames: [] },
    content: {
      answerRules: null,
      avatar,
      category: null,
      description: "",
      id: "assistant-1",
      knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      mcpServerIds: [],
      name: "HR Helper",
      providerModelId: "model-1",
      rows: rows("model-1"),
      runControls: {},
      searchPlan: { mode: "all_selected", optionIds: [] },
      skillIds: [],
      starterPrompts: [],
      systemPrompt: "Help."
    },
    dependencyAvailability: { knowledge: "ready", skills: true },
    featured: false,
    featuredOrder: null,
    id: "assistant-1",
    installationScope: false,
    memberGroupNames: [],
    owned: true,
    ownerDisplayName: "Owner",
    pinned: false,
    publications: [],
    published: false,
    updatedAt: new Date("2026-09-28T00:00:00.000Z"),
    version: 4
  };
}

function deps(adoptChatSetup: AdoptChatSetup): AdoptChatSetupHandlerDeps {
  return {
    adoptChatSetup,
    loadCatalogData: async () => catalogData(),
    repository: {
      getDetail: vi.fn(async () => detail()),
      loadUserAccessibleMcpServerIds: vi.fn(async () => new Set<string>()),
      loadUserMcpRunPlanView: vi.fn(async () => ({
        isGenerationLive: () => false,
        now: new Date("2026-09-28T00:00:00.000Z"),
        recordsByServerId: new Map()
      }))
    } as unknown as AdoptChatSetupHandlerDeps["repository"],
    resolveAuth: async () => session()
  };
}

function post(body: unknown) {
  return new Request("http://test/api/me/assistants/assistant-1/adopt-chat-setup", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

const params = { params: { assistantId: "assistant-1" } };

function resolving(result: AdoptChatSetupResult<Response>): AdoptChatSetup {
  return vi.fn(async () => result) as unknown as AdoptChatSetup;
}

describe("adopt chat setup handler", () => {
  it("adopts for the owner and answers the updated detail", async () => {
    const adopt = vi.fn(async (input: Parameters<AdoptChatSetup>[0]) => {
      // The ordinary save's catalog check runs on the rows to write.
      expect(input.validate(rows("model-1"))).toBeNull();
      expect(await (input.validate(rows("not-in-catalog")) as Response).json())
        .toEqual({ error: "assistant_model_not_available" });
      return { kind: "adopted" as const, rows: ["model" as const] };
    });
    const response = await createAdoptChatSetupHandler(deps(adopt as unknown as AdoptChatSetup))(
      post({ chatId: " chat-1 ", expectedVersion: 3 }), params);

    expect(response.status).toBe(200);
    expect(decodeAssistantDetailResponse(await response.json())?.assistant).toMatchObject({ id: "assistant-1", version: 4 });
    expect(adopt).toHaveBeenCalledWith(expect.objectContaining({
      assistantId: "assistant-1",
      chatId: "chat-1",
      expectedVersion: 3,
      userId: "user-1"
    }));
  });

  it("answers the unchanged detail when nothing changed for the chat", async () => {
    const response = await createAdoptChatSetupHandler(deps(resolving({ kind: "unchanged" })))(
      post({ chatId: "chat-1", expectedVersion: 3 }), params);
    expect(response.status).toBe(200);
  });

  it.each([
    [{ kind: "not_found" }, 404, { error: "assistant_not_available" }],
    [{ kind: "version_conflict" }, 409, { error: "assistant_version_conflict" }],
    [{ kind: "archived" }, 409, { error: "assistant_archived" }],
    [{ kind: "active_run" }, 409, { error: "active_run_in_progress" }],
    [{ error: { code: "assistant_mcp_servers_invalid", ok: false, row: "tools" }, kind: "rows_invalid" }, 400,
      { error: "assistant_mcp_servers_invalid", row: "tools" }],
    [{ invalid: Response.json({ error: "assistant_search_option_not_available" }, { status: 400 }), kind: "invalid" }, 400,
      { error: "assistant_search_option_not_available" }]
  ] as const)("maps %o to %i", async (result, status, body) => {
    const response = await createAdoptChatSetupHandler(deps(resolving(result as AdoptChatSetupResult<Response>)))(
      post({ chatId: "chat-1", expectedVersion: 3 }), params);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });

  it.each([
    [{ chatId: "chat-1" }, 400, "assistant_draft_invalid"],
    [{ chatId: "chat-1", expectedVersion: 0 }, 400, "assistant_draft_invalid"],
    [{ chatId: 7, expectedVersion: 3 }, 400, "assistant_draft_invalid"],
    [{ chatId: "chat-1", expectedVersion: 3, rows: ["model"] }, 400, "assistant_draft_invalid"],
    [{ chatId: "  ", expectedVersion: 3 }, 404, "assistant_not_available"],
    [{ chatId: "c".repeat(65), expectedVersion: 3 }, 404, "assistant_not_available"]
  ] as const)("refuses the body %o before any read", async (body, status, error) => {
    const adopt = vi.fn();
    const response = await createAdoptChatSetupHandler(deps(adopt as unknown as AdoptChatSetup))(post(body), params);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(adopt).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    const adopt = vi.fn();
    const response = await createAdoptChatSetupHandler({
      ...deps(adopt as unknown as AdoptChatSetup),
      resolveAuth: async () => null
    })(post({ chatId: "chat-1", expectedVersion: 3 }), params);
    expect(response.status).toBe(401);
    expect(adopt).not.toHaveBeenCalled();
  });
});
