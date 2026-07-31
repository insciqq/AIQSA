import type { AdminSearchCatalog } from "@/lib/contracts/adminSearch";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminSearchSection } from "./AdminSearchSection";

const api = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  run: vi.fn(),
  update: vi.fn(),
  updatePolicy: vi.fn()
}));

vi.mock("./adminSearchApi", () => ({
  adminSearchErrorMessage: (code: string) => code,
  createAdminSearchIntegration: api.create,
  requestAdminSearchCatalog: api.list,
  runAdminSearchAction: api.run,
  updateAdminSearchIntegration: api.update,
  updateAdminSearchPolicy: api.updatePolicy
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
      timeoutMs: 300_000
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
    readiness: "ready",
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

describe("AdminSearchSection", () => {
  beforeEach(() => {
    api.create.mockReset();
    api.list.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.run.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.update.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.updatePolicy.mockReset().mockResolvedValue({ ok: true, search: catalog });
  });

  it("presents Search as an index/detail task workspace with factual route and diagnostics", async () => {
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search integration catalog" });
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));

    expect(screen.getByRole("heading", { name: "Company Search" })).toBeVisible();
    expect(screen.getByText("User option")).toBeVisible();
    expect(screen.getByText(/Active engine revision 1/)).toBeVisible();
    expect(screen.getByText("Compatible answer models")).toBeVisible();
    expect(screen.getByText("5 min")).toBeVisible();

    const configurationTab = screen.getByRole("tab", { name: "Configuration" });
    fireEvent.click(configurationTab);
    await waitFor(() => expect(configurationTab).toHaveAttribute("aria-selected", "true"));
    const timeout = await screen.findByRole("spinbutton", { name: /Engine timeout, seconds/ });
    expect(timeout).toHaveValue(300);
    fireEvent.change(timeout, { target: { value: "420" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ timeoutMs: 420_000 })
    })));

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

  it("saves a version-fenced organization recommendation without changing grants", async () => {
    render(<AdminSearchSection active />);
    const policy = await screen.findByRole("region", { name: "Recommended Search plan" });
    fireEvent.click(within(policy).getByRole("button", { name: "Company Search" }));
    fireEvent.click(within(policy).getByRole("button", { name: "Save default" }));

    await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith({
      defaultPlan: {
        mode: "all_selected",
        optionIds: ["company-search-12345678"]
      },
      expectedVersion: 1
    }));
    expect(await screen.findByText("Organization Search default saved.")).toBeVisible();
  });

  it("separates enabled state from unavailable runtime dependencies", async () => {
    api.list.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        integrations: [{
          ...catalog.integrations[0],
          ready: false,
          readiness: "provider_model_unavailable"
        }]
      }
    });
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search integration catalog" });
    expect(within(index).getByText("Technical model unavailable")).toBeVisible();
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));
    expect(within(screen.getByTestId("admin-search-detail-pane"))
      .getAllByText("Technical model unavailable").length).toBeGreaterThan(0);
    expect(within(screen.getByTestId("admin-search-detail-pane")).getAllByText("Enabled").length)
      .toBeGreaterThan(0);
  });

  it("lets an administrator remove an unavailable engine from the recommendation", async () => {
    api.list.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        integrations: [{
          ...catalog.integrations[0],
          ready: false,
          readiness: "provider_model_unavailable"
        }],
        policy: {
          ...catalog.policy,
          defaultPlan: {
            mode: "all_selected",
            optionIds: ["company-search-12345678"]
          }
        }
      }
    });
    render(<AdminSearchSection active />);

    const policy = await screen.findByRole("region", { name: "Recommended Search plan" });
    const save = within(policy).getByRole("button", { name: "Save default" });
    expect(save).toBeDisabled();
    fireEvent.click(within(policy).getByRole("button", {
      name: "Remove unavailable Company Search"
    }));
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.updatePolicy).toHaveBeenCalledWith({
      defaultPlan: {
        mode: "all_selected",
        optionIds: []
      },
      expectedVersion: 1
    }));
  });
});
