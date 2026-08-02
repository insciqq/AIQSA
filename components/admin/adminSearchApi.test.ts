import type { AdminSearchCatalog } from "@/lib/contracts/adminSearch";
import { describe, expect, it, vi } from "vitest";
import {
  createAdminSearchIntegration,
  requestAdminSearchCatalog,
  runAdminSearchAction,
  updateAdminSearchIntegration,
  updateAdminSearchPolicy
} from "./adminSearchApi";

const draft = {
  adapterKind: "provider_model_client" as const,
  credentialMode: "provider_model" as const,
  maxResults: 8,
  protocol: "openai_responses_web_search" as const,
  providerModelId: "technical-1",
  queryMaxCharacters: 500,
  timeoutMs: 15_000
};

const search: AdminSearchCatalog = {
  integrations: [{
    archivedAt: null,
    broaderModelSetup: "setup_required",
    configurable: true,
    configuration: draft,
    configurationActive: false,
    description: "Query-only evidence",
    displayName: "Company Search",
    draftDirty: true,
    draftTestEvidence: null,
    draftVersion: 1,
    enabled: false,
    executionModes: ["all_selected", "model_choice"],
    id: "source-1",
    kind: "web_search",
    providerModel: null,
    ready: false,
    readiness: "setup_required",
    sourceConnectionId: "connection-1",
    strategyId: "company-search-12345678",
    system: false
  }],
  policy: {
    defaultPlan: { mode: "all_selected", optionIds: [] },
    updatedAt: "2026-07-29T12:00:00.000Z",
    version: 1
  },
  providerModels: []
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("adminSearchApi", () => {
  it("returns the exact logical source selected by create or reuse", async () => {
    await expect(createAdminSearchIntegration({
      description: "Query-only evidence",
      displayName: "Company Search",
      draft
    }, vi.fn().mockResolvedValue(response({
      search,
      selectedIntegrationId: "source-1"
    })))).resolves.toEqual({
      ok: true,
      search,
      selectedIntegrationId: "source-1"
    });
  });

  it("uses narrow endpoints for catalog, draft, update, and lifecycle actions", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ search }));

    await requestAdminSearchCatalog(fetcher);
    await createAdminSearchIntegration({
      description: "Query-only evidence",
      displayName: "Company Search",
      draft
    }, fetcher);
    await updateAdminSearchPolicy({
      defaultPlan: { mode: "all_selected", optionIds: [] },
      expectedVersion: 1
    }, fetcher);
    await updateAdminSearchIntegration({
      description: "Updated evidence",
      displayName: "Company Search",
      draft,
      expectedDraftVersion: 1,
      id: "integration/1"
    }, fetcher);
    await runAdminSearchAction({ action: "test", id: "integration/1" }, fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/admin/search", {});
    expect(fetcher).toHaveBeenNthCalledWith(2, "/api/admin/search", expect.objectContaining({
      method: "POST"
    }));
    expect(fetcher).toHaveBeenNthCalledWith(3, "/api/admin/search", expect.objectContaining({
      body: JSON.stringify({
        defaultPlan: { mode: "all_selected", optionIds: [] },
        expectedVersion: 1
      }),
      method: "PATCH"
    }));
    expect(fetcher).toHaveBeenNthCalledWith(4, "/api/admin/search/integration%2F1", expect.objectContaining({
      method: "PATCH"
    }));
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "/api/admin/search/integration%2F1/actions",
      expect.objectContaining({ body: JSON.stringify({ action: "test" }), method: "POST" })
    );
  });

  it("rejects malformed success payloads and returns safe server errors", async () => {
    await expect(requestAdminSearchCatalog(
      vi.fn().mockResolvedValue(response({ search: { integrations: [{}], providerModels: [] } }))
    )).resolves.toEqual({ error: "search_catalog_malformed", ok: false });

    await expect(runAdminSearchAction(
      { action: "activate", id: "integration-1" },
      vi.fn().mockResolvedValue(response({ error: "search_activation_evidence_missing" }, 409))
    )).resolves.toEqual({ error: "search_activation_evidence_missing", ok: false });
  });
});
