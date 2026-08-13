import { describe, expect, it, vi } from "vitest";
import { decodeComposerConfigResponse } from "../../contracts/composerConfig";
import { defaultProviderModels, defaultSearchStrategies } from "../../domain/catalog";
import type { AuthenticatedSession } from "../auth/requestAuth";
import type { CatalogData } from "../catalog/currentUserCatalog";
import { createComposerConfigHandler, type ComposerConfigHandlerDeps } from "./handlers";

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-13T12:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Viewer",
      email: "viewer@example.test",
      id: "user-1",
      role: "user",
      status: "active"
    },
    userId: "user-1"
  };
}

function catalogData(): CatalogData {
  const model = defaultProviderModels[0]!;
  return {
    entitlements: {
      fullAccess: true,
      modelKeys: new Set(),
      providerKeys: new Set(),
      searchStrategies: new Set()
    },
    models: [model],
    searchStrategies: defaultSearchStrategies,
    settings: {
      defaultControlValues: {},
      defaultModelId: model.modelId,
      defaultProvider: model.provider,
      defaultProviderModelId: model.modelId,
      defaultSearchPlan: null,
      defaultSearchStrategyId: "search-disabled",
      showCitations: true,
      showReasoningBlocks: false,
      showToolActivity: true
    }
  };
}

function deps(auth: AuthenticatedSession | null = session()): ComposerConfigHandlerDeps {
  return {
    listAssistants: vi.fn(async () => []),
    listKnowledgeBases: vi.fn(async () => [{
      archived: false,
      description: "Visible base",
      id: "base-1",
      name: "Docs",
      owned: true
    }]),
    listMcpServers: vi.fn(async () => [{
      description: "Visible server",
      enabled: true,
      id: "server-1",
      knownToolCount: 2,
      name: "office-compute",
      readiness: "ready" as const
    }]),
    loadCatalogData: vi.fn(async () => catalogData()),
    resolveAuth: vi.fn(async () => auth),
    resolveRunAttachmentLimits: () => ({
      maxCount: 7,
      maxEncodedBytes: 11_000,
      maxMaterializedBytes: 9_000,
      readConcurrency: 2
    })
  };
}

describe("composer-config handler", () => {
  it("authenticates once and composes filtered projections in parallel", async () => {
    const input = deps();
    const response = await createComposerConfigHandler(input)(
      new Request("http://app.local/api/me/composer-config")
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(decodeComposerConfigResponse(body)).toMatchObject({
      catalog: { attachmentLimits: { maxCount: 7 } },
      knowledgeBases: [{ id: "base-1" }],
      mcpServers: [{ id: "server-1", readiness: "ready" }]
    });
    expect(input.listAssistants).toHaveBeenCalledWith("user-1", expect.any(Object));
    expect(input.listKnowledgeBases).toHaveBeenCalledWith("user-1");
    expect(input.listMcpServers).toHaveBeenCalledWith("user-1");
    expect(Object.keys(body.composerConfig)).toEqual([
      "assistants",
      "catalog",
      "knowledgeBases",
      "mcpServers"
    ]);
    expect(body.composerConfig.mcpServers[0]).not.toHaveProperty("accountLabel");
    expect(body.composerConfig.mcpServers[0]).not.toHaveProperty("tools");
  });

  it("does no projection work for an anonymous request", async () => {
    const input = deps(null);
    const response = await createComposerConfigHandler(input)(
      new Request("http://app.local/api/me/composer-config")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(input.loadCatalogData).not.toHaveBeenCalled();
    expect(input.listAssistants).not.toHaveBeenCalled();
  });

  it("rejects caller configuration before reading any projection", async () => {
    const input = deps();
    const response = await createComposerConfigHandler(input)(
      new Request("http://app.local/api/me/composer-config?include=hidden")
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_query" });
    expect(input.loadCatalogData).not.toHaveBeenCalled();
    expect(input.listAssistants).not.toHaveBeenCalled();
  });

  it("does not reveal projection state when the authenticated catalog owner is absent", async () => {
    const input = { ...deps(), loadCatalogData: vi.fn(async () => null) };
    const response = await createComposerConfigHandler(input)(
      new Request("http://app.local/api/me/composer-config")
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "user_not_found" });
    expect(input.listKnowledgeBases).not.toHaveBeenCalled();
    expect(input.listMcpServers).not.toHaveBeenCalled();
  });
});
