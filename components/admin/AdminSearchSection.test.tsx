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
    archivedAt: null,
    broaderModelSetup: "ready",
    configurable: true,
    configuration: {
      adapterKind: "provider_model_client",
      credentialMode: "provider_model",
      maxResults: 8,
      protocol: "openai_responses_web_search",
      providerModelId: "technical-1",
      queryMaxCharacters: 500,
      timeoutMs: 300_000
    },
    configurationActive: true,
    description: "Query-only web evidence",
    displayName: "Company Search",
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
    id: "source-1",
    kind: "web_search",
    providerModel: {
      connectionDisplayName: "Compatible gateway",
      connectionId: "connection-1",
      displayName: "Search model",
      id: "technical-1"
    },
    ready: true,
    readiness: "ready",
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

describe("AdminSearchSection", () => {
  beforeEach(() => {
    api.create.mockReset();
    api.list.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.run.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.update.mockReset().mockResolvedValue({ ok: true, search: catalog });
    api.updatePolicy.mockReset().mockResolvedValue({ ok: true, search: catalog });
  });

  it("presents one friendly Search source with configuration and diagnostics", async () => {
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search source catalog" });
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));

    expect(screen.getByRole("heading", { name: "Company Search" })).toBeVisible();
    expect(screen.getByText("One Search source")).toBeVisible();
    expect(screen.getByText("Compatible answer models")).toBeVisible();
    expect(screen.getByText("5 min")).toBeVisible();
    expect(screen.getByTestId("admin-search-section").textContent?.toLowerCase()).not.toMatch(
      /native|provider-neutral|\broute\b|revision|adapter|technical|credential mode|physical/u
    );

    const configurationTab = screen.getByRole("tab", { name: "Configuration" });
    fireEvent.click(configurationTab);
    await waitFor(() => expect(configurationTab).toHaveAttribute("aria-selected", "true"));
    const timeout = await screen.findByRole("spinbutton", { name: /Search timeout, seconds/ });
    expect(timeout).toHaveValue(300);
    fireEvent.change(timeout, { target: { value: "420" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ timeoutMs: 420_000 })
    })));

    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    expect(screen.getByRole("region", { name: "Search diagnostics" })).toHaveTextContent("Sources found");
    fireEvent.click(screen.getByRole("button", { name: "Test configuration" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith({
      action: "test",
      confirmed: undefined,
      id: "source-1"
    }));
    expect(await screen.findByText("Search configuration tested.")).toBeVisible();
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

  it("creates one Search source from a friendly provider-model choice", async () => {
    api.list.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        providerModels: [
          {
            connectionDisplayName: "OpenRouter",
            connectionId: "connection-openrouter",
            displayName: "Perplexity Search",
            enabled: true,
            id: "technical-openrouter",
            searchKind: "perplexity_search"
          },
          {
            connectionDisplayName: "OpenAI",
            connectionId: "connection-openai",
            displayName: "GPT Search",
            enabled: true,
            id: "technical-openai",
            searchKind: "web_search"
          }
        ]
      }
    });
    render(<AdminSearchSection active />);

    fireEvent.click(await screen.findByRole("button", { name: "Add source" }));

    expect(screen.getByRole("heading", { name: "Add Search source" })).toBeVisible();
    expect(screen.getByLabelText("Name")).toHaveValue("OpenAI Search");
    expect(screen.getByLabelText("Purpose")).toHaveValue("Web search through OpenAI.");
    expect(screen.getByLabelText(/Search provider and model/)).toHaveValue("technical-openai");
    expect(screen.getByTestId("admin-search-section").textContent?.toLowerCase()).not.toMatch(
      /native|provider-neutral|\broute\b|revision|adapter|technical|credential mode|physical/u
    );

    const opened = {
      ...catalog.integrations[0],
      configuration: {
        ...catalog.integrations[0]!.configuration!,
        providerModelId: "technical-openai"
      },
      displayName: "OpenAI Search",
      id: "source-openai",
      sourceConnectionId: "connection-openai",
      strategyId: "openai-native-web-search"
    };
    api.create.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        integrations: [...catalog.integrations, opened]
      },
      selectedIntegrationId: opened.id
    });
    fireEvent.click(within(screen.getByTestId("admin-search-detail-pane")).getByRole(
      "button",
      { name: "Add source" }
    ));

    expect(await screen.findByRole("heading", { name: "OpenAI Search" })).toBeVisible();
    expect(screen.getByText("Search source opened.")).toBeVisible();
  });

  it("keeps a ready source usable while broader answer-model setup is incomplete", async () => {
    api.list.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        integrations: [{
          ...catalog.integrations[0],
          broaderModelSetup: "setup_required",
          configurationActive: false
        }]
      }
    });
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search source catalog" });
    expect(within(index).getByText("Ready")).toBeVisible();
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));
    expect(screen.getByText("Works now; support for more answer models needs setup")).toBeVisible();
    expect(within(screen.getByTestId("admin-search-detail-pane")).getAllByText("Enabled").length)
      .toBeGreaterThan(0);
  });

  it("switches the technical model only within the source connection", async () => {
    const providerModels: AdminSearchCatalog["providerModels"] = [
      {
        connectionDisplayName: "Compatible gateway",
        connectionId: "connection-1",
        displayName: "Search model A",
        enabled: true,
        id: "technical-1",
        searchKind: "web_search"
      },
      {
        connectionDisplayName: "Compatible gateway",
        connectionId: "connection-1",
        displayName: "Search model B",
        enabled: true,
        id: "technical-2",
        searchKind: "web_search"
      },
      {
        connectionDisplayName: "Other gateway",
        connectionId: "connection-2",
        displayName: "Other Search model",
        enabled: true,
        id: "technical-other",
        searchKind: "web_search"
      }
    ];
    api.list.mockResolvedValue({
      ok: true,
      search: { ...catalog, providerModels }
    });
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search source catalog" });
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    const selector = screen.getByRole("combobox", { name: /Search provider and model/ });
    expect(selector).toBeEnabled();
    expect(within(selector).queryByRole("option", { name: /Other Search model/ })).toBeNull();

    fireEvent.change(selector, { target: { value: "technical-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.update).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ providerModelId: "technical-2" }),
      id: "source-1"
    })));
  });

  it("lets an administrator remove an unavailable source from the recommendation", async () => {
    api.list.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        integrations: [{
          ...catalog.integrations[0],
          ready: false,
          readiness: "source_unavailable"
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

  it("requires an in-product confirmation before archiving a Search source", async () => {
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search source catalog" });
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    expect(api.run).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("dialog", {
      name: "Archive Search source Company Search"
    });
    expect(confirmation).toHaveTextContent(
      "Company Search will be unavailable for future runs. Existing run history remains available."
    );

    fireEvent.click(within(confirmation).getByRole("button", { name: "Confirm archive source" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith({
      action: "archive",
      confirmed: true,
      id: "source-1"
    }));
  });
});
