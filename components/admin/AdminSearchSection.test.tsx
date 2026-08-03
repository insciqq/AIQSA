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
      maxOutputTokens: 4_096,
      maxResults: 8,
      maxSearchCallsPerAnswer: 2,
      protocol: "openai_responses_web_search",
      providerModelId: "technical-1",
      queryMaxCharacters: 500,
      reasoningPolicy: "lowest_supported",
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
  providerModels: [{
    connectionDisplayName: "Compatible gateway",
    connectionId: "connection-1",
    displayName: "Search model",
    enabled: true,
    id: "technical-1",
    searchKind: "web_search",
    searchReasoningSupported: true
  }]
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
    expect(screen.queryByRole("button", { name: /Use tested configuration/i })).toBeNull();
    expect(screen.getByTestId("admin-search-section").textContent?.toLowerCase()).not.toMatch(
      /native|provider-neutral|\broute\b|revision|adapter|technical|credential mode|physical/u
    );

    const configurationTab = screen.getByRole("tab", { name: "Configuration" });
    fireEvent.click(configurationTab);
    await waitFor(() => expect(configurationTab).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByText("Saved changes take effect immediately for new runs.")).toBeVisible();
    const timeout = await screen.findByRole("spinbutton", { name: /Search timeout, seconds/ });
    expect(timeout).toHaveValue(300);
    fireEvent.change(timeout, { target: { value: "420" } });
    const advanced = screen.getByText("Advanced Search execution");
    expect(screen.getByLabelText(/^Search model/)).not.toBeVisible();
    fireEvent.click(advanced);
    expect(screen.getByLabelText(/^Search model/)).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: /^Maximum Search output, tokens/ }))
      .toHaveValue(4_096);
    expect(screen.getByRole("spinbutton", {
      name: /^Maximum requests to this source per answer/
    }))
      .toHaveValue(2);
    expect(screen.getByRole("combobox", { name: /^Search reasoning/ }))
      .toHaveValue("lowest_supported");
    fireEvent.change(screen.getByRole("spinbutton", {
      name: /^Maximum Search output, tokens/
    }), { target: { value: "8192" } });
    fireEvent.change(screen.getByRole("spinbutton", {
      name: /^Maximum requests to this source per answer/
    }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Search reasoning/ }), {
      target: { value: "provider_default" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({
        maxOutputTokens: 8_192,
        maxSearchCallsPerAnswer: 3,
        reasoningPolicy: "provider_default",
        timeoutMs: 420_000
      })
    })));
    expect(api.update.mock.calls[0]?.[0]).not.toHaveProperty("executionInputs");
    expect(api.run).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));
    const diagnostics = screen.getByRole("region", { name: "Search diagnostics" });
    expect(diagnostics).toHaveTextContent("Sources found");
    expect(within(diagnostics).getByText("Last live check passed")).toBeVisible();
    expect(within(diagnostics).getByText("Available")).toBeVisible();
    expect(within(diagnostics).getByText("2")).toBeVisible();
    expect(screen.getByText(/result does not change source availability/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Run live check" }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith({
      action: "test",
      confirmed: undefined,
      id: "source-1"
    }));
    expect(await screen.findByText("Live Search check completed.")).toBeVisible();
  });

  it("does not present configuration evidence as a live diagnostic", async () => {
    api.list.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        integrations: [{
          ...catalog.integrations[0],
          draftTestEvidence: {
            checkedAt: "2026-07-29T11:59:00.000Z",
            method: "configuration",
            normalizedSourceCount: 0,
            protocol: "openai_responses_web_search",
            status: "available"
          }
        }]
      }
    });
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search source catalog" });
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Diagnostics" }));

    const diagnostics = screen.getByRole("region", { name: "Search diagnostics" });
    expect(within(diagnostics).getByText("No live check run")).toBeVisible();
    expect(within(diagnostics).getByText("Never")).toBeVisible();
    expect(within(diagnostics).getAllByText("—")).toHaveLength(2);
    expect(diagnostics).not.toHaveTextContent("Last live check passed");
  });

  it("keeps invalid Search execution limits inline and out of save requests", async () => {
    render(<AdminSearchSection active />);

    const index = await screen.findByRole("list", { name: "Search source catalog" });
    fireEvent.click(within(index).getByRole("button", { name: /Company Search/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Configuration" }));
    fireEvent.click(screen.getByText("Advanced Search execution"));

    const save = screen.getByRole("button", { name: "Save changes" });
    const output = screen.getByRole("spinbutton", {
      name: /^Maximum Search output, tokens/
    });
    const requests = screen.getByRole("spinbutton", {
      name: /^Maximum requests to this source per answer/
    });

    fireEvent.change(output, { target: { value: "" } });
    expect((output as HTMLInputElement).value).toBe("");
    expect(output).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a whole number from 1,024 to 32,768.")).toBeVisible();
    expect(save).toBeDisabled();
    expect(api.update).not.toHaveBeenCalled();

    fireEvent.change(output, { target: { value: "32769" } });
    expect(save).toBeDisabled();
    fireEvent.change(output, { target: { value: "8192" } });
    expect(output).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter a whole number from 1,024 to 32,768.")).toBeNull();

    fireEvent.change(requests, { target: { value: "5" } });
    expect(requests).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter a whole number from 1 to 4.")).toBeVisible();
    expect(save).toBeDisabled();
    fireEvent.change(requests, { target: { value: "2" } });
    expect(requests).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByText("Enter a whole number from 1 to 4.")).toBeNull();
    expect(save).toBeEnabled();
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

  it("offers manual Add only for a source not managed by provider setup", async () => {
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
            searchKind: "perplexity_search",
            searchReasoningSupported: false
          },
          {
            connectionDisplayName: "OpenAI",
            connectionId: "connection-openai",
            displayName: "GPT Search",
            enabled: true,
            id: "technical-openai",
            searchKind: "web_search",
            searchReasoningSupported: true
          },
          {
            connectionDisplayName: "Backup gateway",
            connectionId: "connection-openrouter-backup",
            displayName: "Backup Search",
            enabled: true,
            id: "technical-openrouter-backup",
            searchKind: "perplexity_search",
            searchReasoningSupported: false
          }
        ]
      }
    });
    render(<AdminSearchSection active />);

    fireEvent.click(await screen.findByRole("button", { name: "Add source" }));

    expect(screen.getByRole("heading", { name: "Add Search source" })).toBeVisible();
    const addSource = within(screen.getByTestId("admin-search-detail-pane")).getByRole(
      "button",
      { name: "Add source" }
    );
    const selector = screen.getByLabelText(/^Search model/);
    expect(selector).toBeVisible();
    expect(selector).toHaveValue("");
    expect(addSource).toBeDisabled();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    fireEvent.change(selector, { target: { value: "technical-openrouter" } });
    expect(screen.getByLabelText("Name")).toHaveValue("OpenRouter Search");
    expect(screen.getByLabelText("Purpose")).toHaveValue("Web search through OpenRouter.");
    fireEvent.change(selector, { target: { value: "" } });
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Purpose")).toHaveValue("Web search for Research Chat.");
    fireEvent.change(selector, { target: { value: "technical-openrouter-backup" } });
    expect(screen.getByLabelText("Name")).toHaveValue("Backup gateway Search");
    expect(screen.getByLabelText("Purpose")).toHaveValue("Web search through Backup gateway.");
    fireEvent.change(selector, { target: { value: "technical-openrouter" } });
    expect(screen.getByLabelText("Name")).toHaveValue("OpenRouter Search");
    expect(screen.getByLabelText("Purpose")).toHaveValue("Web search through OpenRouter.");
    expect(addSource).toBeEnabled();
    expect(within(selector).queryByRole("option", { name: /GPT Search/ })).toBeNull();
    fireEvent.click(screen.getByText("Advanced Search execution"));
    expect(screen.getAllByLabelText(/^Search model/)).toHaveLength(1);
    expect(screen.queryByRole("combobox", { name: /^Search reasoning/ })).toBeNull();
    expect(screen.getByTestId("admin-search-section").textContent?.toLowerCase()).not.toMatch(
      /native|provider-neutral|\broute\b|revision|adapter|technical|credential mode|physical/u
    );

    const opened = {
      ...catalog.integrations[0],
      configuration: {
        ...catalog.integrations[0]!.configuration!,
        protocol: "openrouter_perplexity_chat" as const,
        providerModelId: "technical-openrouter"
      },
      displayName: "OpenRouter Search",
      id: "source-openrouter",
      kind: "perplexity_search" as const,
      sourceConnectionId: "connection-openrouter",
      strategyId: "openrouter-search"
    };
    api.create.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        integrations: [...catalog.integrations, opened]
      },
      selectedIntegrationId: opened.id
    });
    fireEvent.click(addSource);

    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]?.[0]).not.toHaveProperty("executionInputs");
    expect(await screen.findByRole("heading", { name: "OpenRouter Search" })).toBeVisible();
    expect(screen.getByText("Search source added and ready.")).toBeVisible();
  });

  it("does not offer a duplicate manual source for an OpenAI Search model", async () => {
    api.list.mockResolvedValue({
      ok: true,
      search: {
        ...catalog,
        providerModels: [{
          connectionDisplayName: "OpenAI",
          connectionId: "connection-openai",
          displayName: "GPT Search",
          enabled: true,
          id: "technical-openai",
          searchKind: "web_search",
          searchReasoningSupported: true
        }]
      }
    });

    render(<AdminSearchSection active />);

    await screen.findByRole("list", { name: "Search source catalog" });
    expect(screen.queryByRole("button", { name: "Add source" })).toBeNull();
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

  it("switches the Search model only within the source connection", async () => {
    const providerModels: AdminSearchCatalog["providerModels"] = [
      {
        connectionDisplayName: "Compatible gateway",
        connectionId: "connection-1",
        displayName: "Search model A",
        enabled: true,
        id: "technical-1",
        searchKind: "web_search",
        searchReasoningSupported: true
      },
      {
        connectionDisplayName: "Compatible gateway",
        connectionId: "connection-1",
        displayName: "Search model B",
        enabled: true,
        id: "technical-2",
        searchKind: "web_search",
        searchReasoningSupported: false
      },
      {
        connectionDisplayName: "Other gateway",
        connectionId: "connection-2",
        displayName: "Other Search model",
        enabled: true,
        id: "technical-other",
        searchKind: "web_search",
        searchReasoningSupported: true
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
    fireEvent.click(screen.getByText("Advanced Search execution"));
    const selector = screen.getByRole("combobox", { name: /^Search model/ });
    expect(selector).toBeEnabled();
    expect(within(selector).queryByRole("option", { name: /Other Search model/ })).toBeNull();

    fireEvent.change(selector, { target: { value: "technical-2" } });
    expect(screen.queryByRole("combobox", { name: /^Search reasoning/ })).toBeNull();
    expect(screen.getByText(
      "Search reasoning is not configurable for this model. AIQSA uses the service default."
    )).toBeVisible();
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
