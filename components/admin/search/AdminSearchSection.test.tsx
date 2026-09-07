import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { AdminSectionTopbarProvider, type AdminShellTopbar } from "@/components/admin/AdminShell";
import type { AdminConfirmationRequest } from "@/components/admin/useAdminConfirmationController";
import type { AdminSearchCatalog, AdminSearchIntegration } from "@/lib/contracts/adminSearch";
import { AdminSearchSection } from "./AdminSearchSection";

const NOW = "2026-09-07T12:51:00.000Z";
const bannedWords = /\bdraft\b|revision|pending|probe|evidence|adapter|fingerprint|\bversion\b|native|\broute\b|technical|credential mode|physical/iu;

function source(overrides: Partial<AdminSearchIntegration> = {}): AdminSearchIntegration {
  return {
    archivedAt: null,
    broaderModelSetup: "ready",
    configurable: true,
    configuration: {
      adapterKind: "provider_model_client",
      credentialMode: "provider_model",
      maxOutputTokens: 4_096,
      maxResults: 8,
      maxSearchCallsPerAnswer: 2,
      protocol: "openrouter_perplexity_chat",
      providerModelId: "model-sonar",
      queryMaxCharacters: 500,
      reasoningPolicy: "lowest_supported",
      timeoutMs: 300_000
    },
    configurationActive: true,
    description: "Web search through OpenRouter.",
    displayName: "Perplexity Search",
    draftDirty: false,
    draftTestEvidence: {
      checkedAt: NOW,
      method: "provider_search",
      normalizedSourceCount: 3,
      protocol: "openrouter_perplexity_chat",
      status: "available"
    },
    draftVersion: 1,
    enabled: true,
    executionModes: ["all_selected", "model_choice"],
    id: "source-perplexity",
    kind: "perplexity_search",
    providerModel: {
      connectionDisplayName: "OpenRouter",
      connectionId: "conn-openrouter",
      displayName: "Sonar",
      id: "model-sonar",
      responseTimeoutSeconds: 240
    },
    ready: true,
    readiness: "ready",
    sourceConnectionId: "conn-openrouter",
    strategyId: "perplexity-search",
    system: false,
    ...overrides
  };
}

function catalog(): AdminSearchCatalog {
  return {
    integrations: [
      source(),
      source({
        broaderModelSetup: "setup_required",
        configuration: {
          adapterKind: "provider_model_client",
          credentialMode: "provider_model",
          maxOutputTokens: 4_096,
          maxResults: 8,
          maxSearchCallsPerAnswer: 2,
          protocol: "openai_responses_web_search",
          providerModelId: "model-terra",
          queryMaxCharacters: 500,
          reasoningPolicy: "lowest_supported",
          timeoutMs: 300_000
        },
        description: "Web search with OpenAI.",
        displayName: "OpenAI Search",
        draftTestEvidence: null,
        id: "source-openai",
        kind: "web_search",
        providerModel: {
          connectionDisplayName: "OpenAI",
          connectionId: "conn-openai",
          displayName: "GPT-5.6 Terra",
          id: "model-terra"
        },
        ready: false,
        readiness: "setup_required",
        sourceConnectionId: "conn-openai",
        strategyId: "openai-native-web-search",
        system: true
      }),
      source({
        broaderModelSetup: "not_applicable",
        configurable: false,
        configuration: null,
        description: "Google Search inside Gemini answers.",
        displayName: "Gemini Search",
        draftTestEvidence: null,
        enabled: false,
        id: "source-gemini",
        kind: "gemini_google_search",
        providerModel: null,
        sourceConnectionId: "conn-gemini",
        strategyId: "gemini-google-search",
        system: true
      })
    ],
    policy: { defaultPlan: { mode: "all_selected", optionIds: [] }, updatedAt: NOW, version: 4 },
    providerModels: [
      {
        connectionDisplayName: "OpenRouter",
        connectionId: "conn-openrouter",
        displayName: "Sonar",
        enabled: true,
        id: "model-sonar",
        responseTimeoutSeconds: 240,
        searchKind: "perplexity_search",
        searchReasoningSupported: false
      },
      {
        connectionDisplayName: "OpenRouter EU",
        connectionId: "conn-openrouter-eu",
        displayName: "Sonar Pro",
        enabled: true,
        id: "model-sonar-eu",
        searchKind: "perplexity_search",
        searchReasoningSupported: false
      },
      {
        connectionDisplayName: "OpenAI",
        connectionId: "conn-openai",
        displayName: "GPT-5.6 Terra",
        enabled: true,
        id: "model-terra",
        searchKind: "web_search",
        searchReasoningSupported: true
      }
    ]
  };
}

type Call = { body: Record<string, unknown> | null; method: string; url: string };
type Router = (input: Call) => Response | null | undefined;

function mockFetch(state: { current: AdminSearchCatalog }, router: Router = () => null) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({ body, method, url });
    const routed = router({ body, method, url });
    if (routed) return routed;
    if (url === "/api/admin/search" && method === "GET") {
      return Response.json({ search: state.current });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  });
  return calls;
}

function TopbarHarness({ children }: Readonly<{ children: ReactNode }>) {
  const [topbar, setTopbar] = useState<AdminShellTopbar | null>(null);
  return (
    <AdminSectionTopbarProvider value={setTopbar}>
      <div data-testid="topbar">
        <h1 data-testid="topbar-title">{topbar?.title}</h1>
        <div data-testid="topbar-actions">{topbar?.actions}</div>
      </div>
      {children}
    </AdminSectionTopbarProvider>
  );
}

function renderSection(resource: string | null = null) {
  const confirmations: AdminConfirmationRequest[] = [];
  const feedback = { reportError: vi.fn(), reportNotice: vi.fn() };
  const onSelectResource = vi.fn();
  const onMutationCommitted = vi.fn();
  const view = render(
    <TopbarHarness>
      <AdminSearchSection
        active
        feedback={feedback}
        onMutationCommitted={onMutationCommitted}
        onSelectResource={onSelectResource}
        requestConfirmation={(config) => { confirmations.push(config); }}
        resource={resource}
      />
    </TopbarHarness>
  );
  return { confirmations, feedback, onMutationCommitted, onSelectResource, view };
}

describe("AdminSearchSection", () => {
  const state = { current: catalog() };

  beforeEach(() => {
    state.current = catalog();
    window.history.replaceState(null, "", "/admin?section=search");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the plan and the source list on one page with one status word per source", async () => {
    mockFetch(state);
    const { onSelectResource } = renderSection();

    const list = await screen.findByRole("list", { name: "Search sources" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getByTestId("search-source-status").textContent))
      .toEqual(["Working", "Setup needed", "Disabled"]);
    expect(rows[0]).toHaveTextContent("All chat models");
    expect(rows[1]).toHaveTextContent("No Search model yet");
    expect(rows[2]).toHaveTextContent("Gemini models");
    expect(within(rows[2]!).getByRole("link")).toHaveClass("opacity-65");
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute("href", "/admin?section=search&resource=source-perplexity");
    expect(screen.getByRole("region", { name: "Recommended Search plan" })).toHaveTextContent("never grants access");
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Search");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled());
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-search-section").textContent).not.toMatch(bannedWords);

    fireEvent.click(within(rows[0]!).getByRole("link"));
    expect(onSelectResource).toHaveBeenCalledWith("source-perplexity");
  });

  it("saves the recommended plan with the current policy version and reports it once", async () => {
    const calls = mockFetch(state, ({ body, method, url }) => {
      if (url === "/api/admin/search" && method === "PATCH") {
        state.current = {
          ...state.current,
          policy: {
            defaultPlan: body?.defaultPlan as AdminSearchCatalog["policy"]["defaultPlan"],
            updatedAt: NOW,
            version: 5
          }
        };
        return Response.json({ search: state.current });
      }
      return null;
    });
    const { feedback, onMutationCommitted } = renderSection();

    const plan = await screen.findByRole("region", { name: "Recommended Search plan" });
    expect(within(plan).queryByRole("button", { name: "OpenAI Search" })).not.toBeInTheDocument();
    expect(within(plan).getByRole("button", { name: "Save default" })).toBeDisabled();
    fireEvent.click(within(plan).getByRole("button", { name: "Perplexity Search" }));
    expect(within(plan).getByRole("button", { name: "Perplexity Search" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(plan).getByRole("button", { name: "Save default" }));

    await waitFor(() => expect(feedback.reportNotice).toHaveBeenCalledWith("Organization Search default saved."));
    expect(calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      defaultPlan: { mode: "all_selected", optionIds: ["perplexity-search"] },
      expectedVersion: 4
    });
    expect(onMutationCommitted).toHaveBeenCalled();
    await waitFor(() => expect(within(plan).getByRole("button", { name: "Save default" })).toBeDisabled());
    expect(within(plan).getByRole("button", { name: "Perplexity Search" })).toHaveAttribute("aria-pressed", "true");
  });

  it("owns the source page topbar: Enabled switch, Run check with an inline result, and Archive behind one confirmation", async () => {
    const calls = mockFetch(state, ({ body, method, url }) => {
      if (method === "POST" && url === "/api/admin/search/source-perplexity/actions") {
        if (body?.action === "disable" || body?.action === "enable") {
          state.current = {
            ...state.current,
            integrations: state.current.integrations.map((item) => item.id === "source-perplexity"
              ? { ...item, enabled: body.action === "enable" }
              : item)
          };
        }
        if (body?.action === "test") {
          state.current = {
            ...state.current,
            integrations: state.current.integrations.map((item) => item.id === "source-perplexity"
              ? {
                  ...item,
                  draftTestEvidence: {
                    checkedAt: NOW,
                    method: "provider_search",
                    normalizedSourceCount: 0,
                    protocol: "openrouter_perplexity_chat",
                    status: "unavailable"
                  }
                }
              : item)
          };
        }
        if (body?.action === "archive") {
          state.current = {
            ...state.current,
            integrations: state.current.integrations.map((item) => item.id === "source-perplexity"
              ? { ...item, archivedAt: NOW, enabled: false }
              : item)
          };
        }
        return Response.json({ search: state.current });
      }
      return null;
    });
    const { confirmations, feedback, onSelectResource } = renderSection("source-perplexity");

    const status = await screen.findByTestId("search-source-page-status");
    expect(status).toHaveTextContent(/^Working · Sonar on OpenRouter · checked today \d{1,2}:\d{2}$/u);
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("Perplexity Search"));
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Search");
    expect(screen.getByTestId("search-source-check")).toHaveTextContent("working, 3 sources found");
    expect(screen.getByTestId("search-source-page").textContent).not.toMatch(bannedWords);

    fireEvent.click(screen.getByRole("switch", { name: "Perplexity Search enabled" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Perplexity Search enabled" })).not.toBeChecked());
    expect(calls.find(({ body }) => body?.action === "disable")).toBeTruthy();
    expect(feedback.reportNotice).toHaveBeenCalledWith("Search source turned off.");
    expect(screen.getByTestId("search-source-page-status")).toHaveTextContent(/^Disabled ·/u);

    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    await waitFor(() => expect(screen.getByTestId("search-source-check")).toHaveTextContent("no sources found"));
    expect(calls.find(({ body }) => body?.action === "test")?.url).toBe("/api/admin/search/source-perplexity/actions");
    expect(confirmations).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "More actions for Perplexity Search" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ confirmLabel: "Archive source", title: "Archive “Perplexity Search”?" });
    expect(confirmations[0]!.body).toMatch(/hidden from new chats/u);
    expect(calls.some(({ body }) => body?.action === "archive")).toBe(false);
    await act(async () => { await confirmations[0]!.onConfirm(); });
    expect(calls.find(({ body }) => body?.action === "archive")?.body).toEqual({ action: "archive", confirmed: true });
    expect(feedback.reportNotice).toHaveBeenCalledWith("Search source archived.");
    expect(onSelectResource).toHaveBeenCalledWith(null);
  });

  it("hides Archive for a built-in source and explains a source that no longer exists", async () => {
    mockFetch(state);
    const { view } = renderSection("source-openai");

    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("OpenAI Search"));
    expect(screen.getByRole("switch", { name: "OpenAI Search enabled" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("search-source-page-status")).toHaveTextContent(/^Setup needed · GPT-5.6 Terra on OpenAI · not checked yet$/u);

    view.rerender(
      <TopbarHarness>
        <AdminSearchSection
          active
          feedback={{ reportError: vi.fn(), reportNotice: vi.fn() }}
          onSelectResource={vi.fn()}
          requestConfirmation={vi.fn()}
          resource="source-missing"
        />
      </TopbarHarness>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("This Search source no longer exists.");
  });

  it("configures a source with one Save that saves and checks, keeps the fields and the previous configuration when the check fails", async () => {
    const calls = mockFetch(state, ({ body, method, url }) => {
      if (method === "POST" && url === "/api/admin/search/source-perplexity/actions" && body?.action === "save_and_check") {
        if (body.displayName === "Broken Search") {
          return Response.json({ error: "search_test_failed" }, { status: 422 });
        }
        state.current = {
          ...state.current,
          integrations: state.current.integrations.map((item) => item.id === "source-perplexity"
            ? {
                ...item,
                description: String(body.description),
                displayName: String(body.displayName),
                draftVersion: item.draftVersion + 1
              }
            : item)
        };
        return Response.json({ search: state.current });
      }
      return null;
    });
    const { feedback } = renderSection("source-perplexity");

    fireEvent.click(await screen.findByRole("button", { name: "Configure" }));
    const sheet = await screen.findByRole("dialog", { name: "Configure source" });
    expect(within(sheet).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(sheet).getByLabelText(/^Search model/)).not.toBeVisible();
    fireEvent.click(within(sheet).getByText("Advanced Search execution"));
    expect(within(sheet).getByLabelText(/^Search model/)).toBeVisible();
    expect(within(sheet).getByLabelText(/^Search model/)).toHaveValue("model-sonar");
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Broken Search" } });
    fireEvent.change(within(sheet).getByRole("spinbutton", { name: /^Results per search/ }), { target: { value: "12" } });
    expect(sheet.textContent).not.toMatch(bannedWords);
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    const alert = await within(sheet).findByRole("alert");
    expect(alert).toHaveTextContent("The check found no working source, so nothing was changed.");
    expect(within(sheet).getByLabelText("Name")).toHaveValue("Broken Search");
    expect(within(sheet).getByRole("spinbutton", { name: /^Results per search/ })).toHaveValue(12);
    expect(screen.getByTestId("search-source-page")).toHaveTextContent("Perplexity Search");
    expect(feedback.reportError).not.toHaveBeenCalled();
    expect(feedback.reportNotice).not.toHaveBeenCalled();
    expect(calls.filter(({ body }) => body?.action === "save_and_check")).toHaveLength(1);
    expect(calls.find(({ body }) => body?.action === "save_and_check")?.body).toMatchObject({
      action: "save_and_check",
      displayName: "Broken Search",
      draft: expect.objectContaining({ maxResults: 12, providerModelId: "model-sonar" }),
      expectedDraftVersion: 1
    });

    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Perplexity Search EU" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure source" })).not.toBeInTheDocument());
    expect(feedback.reportNotice).toHaveBeenCalledWith("Search source saved and working.");
    expect(screen.getByTestId("search-source-page")).toHaveTextContent("Perplexity Search EU");
    expect(calls.filter(({ body }) => body?.action === "save_and_check")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    const reopened = await screen.findByRole("dialog", { name: "Configure source" });
    expect(within(reopened).getByLabelText("Name")).toHaveValue("Perplexity Search EU");
    fireEvent.change(within(reopened).getByLabelText("Name"), { target: { value: "Renamed" } });
    fireEvent.keyDown(reopened, { key: "Escape" });
    const discard = await screen.findByRole("dialog", { name: "Discard unsaved source settings" });
    fireEvent.click(within(discard).getByRole("button", { name: "Confirm discard changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("adds a manual source through a sheet whose Save creates and checks it in one request", async () => {
    const calls = mockFetch(state, ({ body, method, url }) => {
      if (method === "POST" && url === "/api/admin/search") {
        state.current = {
          ...state.current,
          integrations: [
            ...state.current.integrations,
            source({
              displayName: String(body?.displayName),
              id: "source-new",
              providerModel: {
                connectionDisplayName: "OpenRouter EU",
                connectionId: "conn-openrouter-eu",
                displayName: "Sonar Pro",
                id: "model-sonar-eu"
              },
              sourceConnectionId: "conn-openrouter-eu",
              strategyId: "openrouter-eu-search"
            })
          ]
        };
        return Response.json({ search: state.current, selectedIntegrationId: "source-new" }, { status: 201 });
      }
      return null;
    });
    const { feedback, onSelectResource } = renderSection();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    const sheet = await screen.findByRole("dialog", { name: "Add source" });
    expect(within(sheet).getByRole("button", { name: "Save" })).toBeDisabled();
    const model = within(sheet).getByLabelText(/^Search model/);
    expect(within(model).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Select a Search-capable model",
      "OpenRouter EU · Sonar Pro"
    ]);
    fireEvent.change(model, { target: { value: "model-sonar-eu" } });
    expect(within(sheet).getByLabelText("Name")).toHaveValue("OpenRouter EU Search");
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add source" })).not.toBeInTheDocument());
    expect(calls.find(({ method }) => method === "POST")?.body).toEqual({
      check: true,
      description: "Web search through OpenRouter EU.",
      displayName: "OpenRouter EU Search",
      draft: expect.objectContaining({
        adapterKind: "provider_model_client",
        protocol: "openrouter_perplexity_chat",
        providerModelId: "model-sonar-eu"
      })
    });
    expect(feedback.reportNotice).toHaveBeenCalledWith("Search source added and working.");
    expect(onSelectResource).toHaveBeenCalledWith("source-new");
  });
});
