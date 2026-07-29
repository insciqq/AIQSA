import type { AdminSearchCatalog } from "@/lib/contracts/adminSearch";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSearchSection } from "./AdminSearchSection";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  run: vi.fn(),
  update: vi.fn()
}));

vi.mock("./adminSearchApi", () => ({
  adminSearchErrorMessage: (code: string) => code,
  createAdminSearchIntegration: api.create,
  requestAdminSearchCatalog: api.list,
  runAdminSearchAction: api.run,
  updateAdminSearchIntegration: api.update
}));

const catalog: AdminSearchCatalog = {
  integrations: [{
    activeRevision: { activatedAt: "2026-07-29T12:00:00.000Z", id: "revision-1", revisionNumber: 1 },
    adapterKind: "provider_model_client",
    archivedAt: null,
    credentialMode: "provider_model",
    description: "Query-only web evidence",
    displayName: "Company Search",
    draft: {
      adapterKind: "provider_model_client",
      credentialMode: "provider_model",
      maxResults: 8,
      protocol: "openai_responses_web_search",
      providerModelId: "technical-1",
      queryMaxCharacters: 500,
      timeoutMs: 15_000
    },
    draftDirty: false,
    draftTestEvidence: {
      checkedAt: "2026-07-29T11:59:00.000Z",
      method: "provider_search",
      normalizedSourceCount: 2,
      protocol: "openai_responses_web_search",
      status: "available"
    },
    draftVersion: 1,
    enabled: true,
    executionModes: ["all_selected", "model_choice"],
    id: "integration-1",
    providerModel: {
      connectionDisplayName: "Compatible gateway",
      displayName: "Search model",
      id: "technical-1",
      upstreamModelId: "opaque-search-model"
    },
    ready: true,
    strategyId: "company-search-12345678",
    system: false
  }],
  providerModels: []
};

describe("AdminSearchSection", () => {
  beforeEach(() => {
    api.create.mockReset();
    api.list.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.run.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.update.mockReset().mockResolvedValue({ ok: true, search: catalog });
  });

  it("presents Search as an index/detail task workspace with factual route and diagnostics", async () => {
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search integration catalog" });
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));

    expect(screen.getByRole("heading", { name: "Company Search" })).toBeVisible();
    expect(screen.getByText("User option")).toBeVisible();
    expect(screen.getByText(/Active engine revision 1/)).toBeVisible();
    expect(screen.getByText("Compatible answer models")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(screen.getByRole("region", { name: "Search diagnostics" })).toHaveTextContent(
      "Normalized sources"
    );
    fireEvent.click(screen.getByRole("button", { name: "Test draft" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith({
      action: "test",
      confirmed: undefined,
      id: "integration-1"
    }));
    expect(await screen.findByText("Search draft tested.")).toBeVisible();
  });
});
