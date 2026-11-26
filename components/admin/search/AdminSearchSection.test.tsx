import { useAdminSearchController } from "./useAdminSearchController";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
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
      protocol: "anthropic_web_search",
      providerModelId: "model-haiku",
      queryMaxCharacters: 500,
      reasoningPolicy: "lowest_supported",
      timeoutMs: 300_000
    },
    configurationActive: true,
    description: "Web search through Anthropic.",
    displayName: "Anthropic Search",
    draftDirty: false,
    draftTestEvidence: {
      checkedAt: NOW,
      method: "provider_search",
      normalizedSourceCount: 3,
      protocol: "anthropic_web_search",
      status: "available"
    },
    draftVersion: 1,
    enabled: true,
    executionModes: ["all_selected", "model_choice"],
    id: "source-anthropic",
    kind: "web_search",
    providerModel: {
      connectionDisplayName: "Anthropic",
      connectionId: "conn-anthropic",
      displayName: "Claude Haiku 5.5",
      id: "model-haiku",
      responseTimeoutSeconds: 240
    },
    ready: true,
    readiness: "ready",
    sourceConnectionId: "conn-anthropic",
    strategyId: "anthropic-search",
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
          protocol: "openai_responses_web_search",
          providerModelId: "model-terra",
          queryMaxCharacters: 500,
          reasoningPolicy: "lowest_supported",
          timeoutMs: 300_000
        },
        description: "Web search with OpenAI.",
        displayName: "OpenAI Search",
        draftTestEvidence: null,
        executionModes: [],
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
    policy: {
      backupOptionId: null,
      defaultPlan: { mode: "all_selected", optionIds: [] },
      engineOptionId: null,
      inAnswerSearch: true,
      // The server resolved no engine for this synthetic installation (search-v2, 2026-11-26).
      resolved: { automatic: true, backupOptionId: null, engineOptionId: null, reason: "search_engine_not_configured" },
      updatedAt: NOW,
      version: 4
    },
    providerModels: [
      {
        connectionDisplayName: "Anthropic",
        connectionId: "conn-anthropic",
        displayName: "Claude Haiku 5.5",
        enabled: true,
        id: "model-haiku",
        responseTimeoutSeconds: 240,
        searchKind: "anthropic_web_search",
        searchReasoningSupported: false
      },
      {
        connectionDisplayName: "OpenRouter EU",
        connectionId: "conn-openrouter-eu",
        displayName: "GPT-6 Luna",
        enabled: true,
        id: "model-luna-eu",
        searchKind: "openrouter_web_search",
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
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.current = catalog();
    window.history.replaceState(null, "", "/admin?section=search");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the real catalog failure and retries a resource URL without claiming it is missing", async () => {
    let failed = true;
    mockFetch(state, () => failed ? Response.json({ error: "search_admin_action_failed" }, { status: 500 }) : null);
    renderSection("source-openai");
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("no longer exists");
    failed = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("OpenAI Search"));
  });

  it("keeps a successful Search policy mutation when an older refresh finishes afterward", async () => {
    const previous = structuredClone(state.current);
    const next = { ...state.current, policy: { ...state.current.policy, version: previous.policy.version + 1 } };
    let finish!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => { finish = resolve; });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ search: previous }))
      .mockReturnValueOnce(delayed)
      .mockResolvedValueOnce(Response.json({ search: next }));
    const { result } = renderHook(() => useAdminSearchController(true, {
      onError: vi.fn(), onNotice: vi.fn()
    }));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    let refreshing!: Promise<void>;
    act(() => { refreshing = result.current.actions.refresh(); });
    await act(async () => {
      await result.current.actions.savePolicy(
        { backupOptionId: null, engineOptionId: null, inAnswerSearch: true },
        previous.policy.version
      );
    });
    await act(async () => { finish(Response.json({ search: previous })); await refreshing; });
    expect(result.current.state.catalog?.policy.version).toBe(previous.policy.version + 1);
  });

  it("shows the engine and the source list on one page with one status word per source", async () => {
    mockFetch(state);
    const { onSelectResource } = renderSection();

    const list = await screen.findByRole("list", { name: "Search sources" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getByTestId("search-source-status").textContent))
      .toEqual(["Working", "Setup needed", "Disabled"]);
    // No source is the engine or the backup yet.
    expect(rows.map((row) => within(row).getByTestId("search-source-role").textContent)).toEqual(["", "", ""]);
    expect(within(rows[2]!).getByRole("link")).toHaveClass("opacity-65");
    expect(within(rows[0]!).getByRole("link")).toHaveAttribute("href", "/admin?section=search&resource=source-anthropic");
    const engine = screen.getByRole("region", { name: "Engine" });
    // The server's resolution in words: no engine in the default order can search, never Off.
    expect(screen.getByTestId("admin-search-engine-resolved")).toHaveTextContent("No engine can search yet.");
    expect(engine).toHaveTextContent(
      "Automatic uses the first working one of: OpenAI web search, OpenRouter with Perplexity, DeepSeek Search API, Gemini Google Search, Anthropic web search."
    );
    // Only a turned-on source that searches for every model can be the engine or the backup.
    expect(within(within(engine).getByLabelText(/^Search engine/)).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Automatic", "Anthropic Search"]);
    expect(within(within(engine).getByLabelText(/^Backup/)).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["None", "Anthropic Search"]);
    expect(within(engine).getByRole("switch", { name: "GPT searches inside its own answer" })).toBeChecked();
    expect(screen.queryByText("Let the model choose")).not.toBeInTheDocument();
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Search");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled());
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-search-section").textContent).not.toMatch(bannedWords);

    fireEvent.click(within(rows[0]!).getByRole("link"));
    expect(onSelectResource).toHaveBeenCalledWith("source-anthropic");
  });

  it("folds archived sources behind one disclosure that still opens their pages", async () => {
    state.current = {
      ...state.current,
      // The service lists archived sources first; the list still puts the active ones on top.
      integrations: [
        source({ archivedAt: NOW, displayName: "DeepSeek (model)", enabled: false, id: "source-old", strategyId: "deepseek-old" }),
        ...state.current.integrations
      ]
    };
    mockFetch(state);
    const { onSelectResource } = renderSection();

    const list = await screen.findByRole("list", { name: "Search sources" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(screen.queryByRole("list", { name: "Archived Search sources" })).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show archived (1)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    const archived = screen.getByRole("list", { name: "Archived Search sources" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Hide archived");
    expect(toggle).toHaveAttribute("aria-controls", archived.id);
    const row = within(archived).getByRole("listitem");
    expect(within(row).getByTestId("search-source-status")).toHaveTextContent("Archived");
    fireEvent.click(within(row).getByRole("link"));
    expect(onSelectResource).toHaveBeenCalledWith("source-old");

    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: "Archived Search sources" })).not.toBeInTheDocument();
  });

  it("says every source is archived instead of showing an empty list", async () => {
    state.current = {
      ...state.current,
      integrations: [source({ archivedAt: NOW, enabled: false })]
    };
    mockFetch(state);
    renderSection();

    expect(await screen.findByText("Every Search source is archived.")).toBeInTheDocument();
    expect(screen.queryByText("No Search sources yet")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Search sources" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show archived (1)" }));
    expect(within(screen.getByRole("list", { name: "Archived Search sources" })).getAllByRole("listitem")).toHaveLength(1);
  });

  it("saves the engine, the backup and the in-answer switch as named fields with the policy version", async () => {
    state.current = {
      ...state.current,
      integrations: [
        ...state.current.integrations,
        source({ displayName: "DeepSeek Search API", id: "source-deepseek", kind: "deepseek_search_api", strategyId: "deepseek-search-api" })
      ]
    };
    const calls = mockFetch(state, ({ body, method, url }) => {
      if (url === "/api/admin/search" && method === "PATCH") {
        state.current = {
          ...state.current,
          policy: {
            backupOptionId: body?.backupOptionId as string | null,
            defaultPlan: { mode: "all_selected", optionIds: ["anthropic-search", "deepseek-search-api"] },
            engineOptionId: body?.engineOptionId as string | null,
            inAnswerSearch: body?.inAnswerSearch as boolean,
            resolved: { automatic: false, backupOptionId: "deepseek-search-api", engineOptionId: "anthropic-search", reason: null },
            updatedAt: NOW,
            version: 5
          }
        };
        return Response.json({ search: state.current });
      }
      return null;
    });
    const { feedback, onMutationCommitted } = renderSection();

    const engine = await screen.findByRole("region", { name: "Engine" });
    // A clean card offers no actions (issue #66).
    expect(within(engine).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(within(engine).queryByRole("button", { name: "Discard" })).not.toBeInTheDocument();
    expect(within(engine).getByText("No unsaved changes")).toBeInTheDocument();
    fireEvent.change(within(engine).getByLabelText(/^Backup/), { target: { value: "anthropic-search" } });
    // The engine cannot be its own backup: choosing it clears the backup.
    fireEvent.change(within(engine).getByLabelText(/^Search engine/), { target: { value: "anthropic-search" } });
    expect(within(engine).getByLabelText(/^Backup/)).toHaveValue("");
    expect(within(within(engine).getByLabelText(/^Backup/)).getByRole("option", { name: "Anthropic Search" })).toBeDisabled();
    fireEvent.change(within(engine).getByLabelText(/^Backup/), { target: { value: "deepseek-search-api" } });
    fireEvent.click(within(engine).getByRole("switch", { name: "GPT searches inside its own answer" }));
    expect(within(engine).getByText("Unsaved changes")).toBeInTheDocument();
    const save = within(engine).getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.click(save);

    await waitFor(() => expect(feedback.reportNotice).toHaveBeenCalledWith("Search engine saved."));
    expect(calls.find(({ method }) => method === "PATCH")?.body).toEqual({
      backupOptionId: "deepseek-search-api",
      engineOptionId: "anthropic-search",
      expectedVersion: 4,
      inAnswerSearch: false
    });
    expect(onMutationCommitted).toHaveBeenCalled();
    const saved = screen.getByRole("region", { name: "Engine" });
    await waitFor(() => expect(within(saved).queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
    expect(screen.getByTestId("admin-search-engine-resolved"))
      .toHaveTextContent("Searching with Anthropic Search, backup DeepSeek Search API.");
    expect(within(saved).getByLabelText(/^Search engine/)).toHaveValue("anthropic-search");
    expect(within(saved).getByRole("switch", { name: "GPT searches inside its own answer" })).not.toBeChecked();
    const list = screen.getByRole("list", { name: "Search sources" });
    expect(within(list).getAllByTestId("search-source-role").map((role) => role.textContent))
      .toEqual(["Engine", "", "", "Backup"]);
    // Save left with the change; the card remounted for the new version holds focus on its status line.
    expect(within(saved).getByText("No unsaved changes")).toHaveFocus();
  });

  it("names a chosen engine that cannot search and asks for another before saving", async () => {
    state.current = {
      ...state.current,
      policy: {
        ...state.current.policy,
        engineOptionId: "openai-native-web-search",
        resolved: { automatic: false, backupOptionId: null, engineOptionId: null, reason: "search_engine_unavailable" }
      }
    };
    mockFetch(state);
    renderSection();

    const engine = await screen.findByRole("region", { name: "Engine" });
    expect(screen.getByTestId("admin-search-engine-resolved"))
      .toHaveTextContent("OpenAI Search cannot search now, and nothing replaces it.");
    expect(within(engine).getByLabelText(/^Search engine/)).toHaveValue("openai-native-web-search");
    expect(within(engine).getByRole("option", { name: "OpenAI Search · unavailable" })).toBeDisabled();
    fireEvent.click(within(engine).getByRole("switch", { name: "GPT searches inside its own answer" }));
    expect(within(engine).getByRole("status")).toHaveTextContent("OpenAI Search can no longer be the engine.");
    expect(within(engine).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(within(engine).getByLabelText(/^Search engine/), { target: { value: "" } });
    expect(within(engine).getByRole("button", { name: "Save" })).toBeEnabled();
    const list = screen.getByRole("list", { name: "Search sources" });
    expect(within(list).getAllByTestId("search-source-role")[1]).toHaveTextContent("Engine");
  });

  it("owns the source page topbar: Enabled switch, Run check with an inline result, and Archive behind one confirmation", async () => {
    const calls = mockFetch(state, ({ body, method, url }) => {
      if (method === "POST" && url === "/api/admin/search/source-anthropic/actions") {
        if (body?.action === "disable" || body?.action === "enable") {
          state.current = {
            ...state.current,
            integrations: state.current.integrations.map((item) => item.id === "source-anthropic"
              ? { ...item, enabled: body.action === "enable" }
              : item)
          };
        }
        if (body?.action === "test") {
          state.current = {
            ...state.current,
            integrations: state.current.integrations.map((item) => item.id === "source-anthropic"
              ? {
                  ...item,
                  draftTestEvidence: {
                    checkedAt: NOW,
                    method: "provider_search",
                    normalizedSourceCount: 0,
                    protocol: "anthropic_web_search",
                    status: "unavailable"
                  }
                }
              : item)
          };
        }
        if (body?.action === "archive") {
          state.current = {
            ...state.current,
            integrations: state.current.integrations.map((item) => item.id === "source-anthropic"
              ? { ...item, archivedAt: NOW, enabled: false }
              : item)
          };
        }
        return Response.json({ search: state.current });
      }
      return null;
    });
    const { confirmations, feedback, onSelectResource } = renderSection("source-anthropic");

    const status = await screen.findByTestId("search-source-page-status");
    expect(status).toHaveTextContent(/^Working · Claude Haiku 5.5 on Anthropic · checked today \d{1,2}:\d{2}$/u);
    await waitFor(() => expect(screen.getByTestId("topbar-title")).toHaveTextContent("Anthropic Search"));
    expect(screen.getByTestId("topbar-title")).toHaveTextContent("Search");
    expect(screen.getByTestId("search-source-check")).toHaveTextContent("working, 3 sources found");
    expect(screen.getByTestId("search-source-page").textContent).not.toMatch(bannedWords);

    fireEvent.click(screen.getByRole("switch", { name: "Anthropic Search enabled" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Anthropic Search enabled" })).not.toBeChecked());
    expect(calls.find(({ body }) => body?.action === "disable")).toBeTruthy();
    expect(feedback.reportNotice).toHaveBeenCalledWith("Search source turned off.");
    expect(screen.getByTestId("search-source-page-status")).toHaveTextContent(/^Disabled ·/u);

    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    await waitFor(() => expect(screen.getByTestId("search-source-check")).toHaveTextContent("no sources found"));
    expect(calls.find(({ body }) => body?.action === "test")?.url).toBe("/api/admin/search/source-anthropic/actions");
    expect(confirmations).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "More actions for Anthropic Search" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({ confirmLabel: "Archive source", title: "Archive “Anthropic Search”?" });
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
      if (method === "POST" && url === "/api/admin/search/source-anthropic/actions" && body?.action === "save_and_check") {
        if (body.displayName === "Broken Search") {
          return Response.json({ error: "search_test_failed" }, { status: 422 });
        }
        state.current = {
          ...state.current,
          integrations: state.current.integrations.map((item) => item.id === "source-anthropic"
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
    const { feedback } = renderSection("source-anthropic");

    fireEvent.click(await screen.findByRole("button", { name: "Configure" }));
    const sheet = await screen.findByRole("dialog", { name: "Configure source" });
    expect(within(sheet).getByRole("button", { name: "Save" })).toBeDisabled();
    // The Search model leads the sheet; a choice is keyed by its Search kind and model.
    expect(within(sheet).getByLabelText(/^Search model/)).toBeVisible();
    expect(within(sheet).getByLabelText(/^Search model/)).toHaveValue("anthropic_web_search:model-haiku");
    expect(within(sheet).queryByLabelText(/^OpenRouter engine/u)).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByText("Advanced Search execution"));
    const output = within(sheet).getByRole("spinbutton", { name: /^Maximum Search output/ });
    expect(within(sheet).queryByRole("spinbutton", { name: /^Maximum requests to this source/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("spinbutton", { name: /^Results per search/ })).not.toBeInTheDocument();
    fireEvent.change(output, { target: { value: "8193" } });
    fireEvent.change(within(sheet).getByRole("spinbutton", { name: /^Generated query limit/ }), { target: { value: "4000" } });
    fireEvent.change(within(sheet).getByRole("spinbutton", { name: /^Search timeout per request/ }), { target: { value: "121" } });
    expect(output).toBeValid();
    fireEvent.change(output, { target: { value: "15" } });
    expect(within(sheet).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(output, { target: { value: "8193" } });
    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Broken Search" } });
    expect(sheet.textContent).not.toMatch(bannedWords);
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    const alert = await within(sheet).findByRole("alert");
    expect(alert).toHaveTextContent("The check found no working source, so nothing was changed.");
    expect(within(sheet).getByLabelText("Name")).toHaveValue("Broken Search");
    expect(output).toHaveValue(8193);
    expect(screen.getByTestId("search-source-page")).toHaveTextContent("Anthropic Search");
    expect(feedback.reportError).not.toHaveBeenCalled();
    expect(feedback.reportNotice).not.toHaveBeenCalled();
    expect(calls.filter(({ body }) => body?.action === "save_and_check")).toHaveLength(1);
    expect(calls.find(({ body }) => body?.action === "save_and_check")?.body).toMatchObject({
      action: "save_and_check",
      displayName: "Broken Search",
      draft: expect.objectContaining({ providerModelId: "model-haiku",
        maxOutputTokens: 8193, queryMaxCharacters: 4000, timeoutMs: 121_000 }),
      expectedDraftVersion: 1
    });

    const savedDraft = calls.find(({ body }) => body?.action === "save_and_check")?.body?.draft;
    expect(Object.keys(savedDraft as object).sort()).toEqual([
      "adapterKind", "credentialMode", "maxOutputTokens", "protocol", "providerModelId",
      "queryMaxCharacters", "reasoningPolicy", "timeoutMs"
    ]);

    fireEvent.change(within(sheet).getByLabelText("Name"), { target: { value: "Anthropic Search EU" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configure source" })).not.toBeInTheDocument());
    expect(feedback.reportNotice).toHaveBeenCalledWith("Search source saved and working.");
    expect(screen.getByTestId("search-source-page")).toHaveTextContent("Anthropic Search EU");
    expect(calls.filter(({ body }) => body?.action === "save_and_check")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    const reopened = await screen.findByRole("dialog", { name: "Configure source" });
    expect(within(reopened).getByLabelText("Name")).toHaveValue("Anthropic Search EU");
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
                displayName: "GPT-6 Luna",
                id: "model-luna-eu"
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
      "OpenRouter EU web search · GPT-6 Luna"
    ]);
    fireEvent.change(model, { target: { value: "openrouter_web_search:model-luna-eu" } });
    expect(within(sheet).getByLabelText("Name")).toHaveValue("OpenRouter EU Web Search");
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add source" })).not.toBeInTheDocument());
    expect(calls.find(({ method }) => method === "POST")?.body).toEqual({
      check: true,
      description: "Web results with source links through OpenRouter EU web search.",
      displayName: "OpenRouter EU Web Search",
      draft: expect.objectContaining({
        adapterKind: "provider_model_client",
        openRouterWebSearch: { engine: "perplexity", mode: null },
        protocol: "openrouter_web_search",
        providerModelId: "model-luna-eu"
      })
    });
    expect(feedback.reportNotice).toHaveBeenCalledWith("Search source added and working.");
    expect(onSelectResource).toHaveBeenCalledWith("source-new");
  });

  it("adds the DeepSeek Search API on a DeepSeek connection with its own name and query bound", async () => {
    const deepSeek = {
      connectionDisplayName: "DeepSeek", connectionId: "conn-deepseek", displayName: "DeepSeek V4 Flash", enabled: true,
      id: "model-flash", responseTimeoutSeconds: 300, searchReasoningSupported: false
    } as const;
    state.current = {
      ...state.current,
      providerModels: [
        ...state.current.providerModels,
        { ...deepSeek, searchKind: "deepseek_search_api" }
      ]
    };
    const calls = mockFetch(state, ({ method, url }) => method === "POST" && url === "/api/admin/search"
      ? Response.json({ error: "search_test_quota_exhausted" }, { status: 422 })
      : null);
    renderSection();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    const sheet = await screen.findByRole("dialog", { name: "Add source" });
    const model = within(sheet).getByLabelText(/^Search model/);
    expect(within(model).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Select a Search-capable model",
      "OpenRouter EU web search · GPT-6 Luna",
      "DeepSeek Search API · key via DeepSeek V4 Flash"
    ]);
    fireEvent.change(model, { target: { value: "deepseek_search_api:model-flash" } });
    expect(within(sheet).getByLabelText("Name")).toHaveValue("DeepSeek Search API");
    expect(within(sheet).queryByText("Advanced Search execution")).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("spinbutton", { name: /^Results per search/ })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("spinbutton", { name: /^Maximum requests to this source/ })).not.toBeInTheDocument();
    expect(within(sheet).getByLabelText("Generated query limit, characters")).toHaveValue(128);
    expect(within(sheet).getByLabelText("Generated query limit, characters")).toHaveAttribute("max", "128");
    expect(within(sheet).getByText(/the model itself is never called/u)).toBeInTheDocument();
    expect(within(sheet).queryByLabelText("Maximum Search output, tokens")).not.toBeInTheDocument();
    expect(sheet.textContent).not.toMatch(bannedWords);
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    expect(await within(sheet).findByRole("alert")).toHaveTextContent("no balance or quota left");
    expect(calls.find(({ method }) => method === "POST")?.body).toEqual({
      check: true,
      description: "Web results with source links from the DeepSeek Search API.",
      displayName: "DeepSeek Search API",
      draft: expect.objectContaining({
        maxOutputTokens: null,
        protocol: "deepseek_search_api",
        providerModelId: "model-flash",
        queryMaxCharacters: 128
      })
    });
  });

  it("configures OpenRouter web search with its engine and mode and keeps them on save", async () => {
    const flash = {
      connectionDisplayName: "OpenRouter", connectionId: "conn-openrouter", displayName: "DeepSeek V4.1 Flash",
      enabled: true, id: "model-flash", responseTimeoutSeconds: 300, searchKind: "openrouter_web_search",
      searchReasoningSupported: false
    } as const;
    const webSource = source({
      configuration: {
        adapterKind: "provider_model_client",
        credentialMode: "provider_model",
        maxOutputTokens: null,
        openRouterWebSearch: { engine: "parallel", mode: "fast" },
        protocol: "openrouter_web_search",
        providerModelId: "model-flash",
        queryMaxCharacters: 1_000,
        reasoningPolicy: "lowest_supported",
        timeoutMs: 120_000
      },
      description: "Web results with source links through OpenRouter web search.",
      displayName: "OpenRouter Web Search",
      id: "source-openrouter-web",
      kind: "web_search",
      providerModel: { connectionDisplayName: "OpenRouter", connectionId: "conn-openrouter", displayName: "DeepSeek V4.1 Flash", id: "model-flash" },
      sourceConnectionId: "conn-openrouter",
      strategyId: "openrouter-web-search"
    });
    state.current = {
      ...state.current,
      integrations: [...state.current.integrations, webSource],
      // The same OpenRouter model may be listed once per Search kind; here only for the web search.
      providerModels: [...state.current.providerModels, flash]
    };
    const calls = mockFetch(state, ({ method, url }) => method === "POST" &&
      url === "/api/admin/search/source-openrouter-web/actions"
      ? Response.json({ search: state.current })
      : null);
    renderSection("source-openrouter-web");

    expect(await screen.findByTestId("search-source-page")).toHaveTextContent("Parallel, Fast");
    fireEvent.click(screen.getByRole("button", { name: "Configure" }));
    const sheet = await screen.findByRole("dialog", { name: "Configure source" });
    const model = within(sheet).getByLabelText(/^Search model/);
    expect(model).toHaveValue("openrouter_web_search:model-flash");
    expect(within(model).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Select a Search-capable model",
      "OpenRouter web search · DeepSeek V4.1 Flash"
    ]);
    expect(within(sheet).getByText(/DeepSeek V4\.1 Flash and GPT-6 Luna passed this check/u)).toBeInTheDocument();
    const engine = within(sheet).getByLabelText(/^OpenRouter engine/u);
    expect(engine).toHaveValue("parallel");
    expect(within(engine).getAllByRole("option").map((option) => option.textContent)).toEqual(["Exa", "Parallel", "Perplexity"]);
    const mode = within(sheet).getByLabelText(/^Engine mode/u);
    expect(within(mode).getAllByRole("option").map((option) => option.textContent))
      .toEqual(["Turbo", "Fast", "Basic", "Advanced"]);
    // The reply limit does not apply to a results-only engine.
    expect(within(sheet).queryByLabelText("Maximum Search output, tokens")).not.toBeInTheDocument();
    expect(within(sheet).queryByText("Advanced Search execution")).not.toBeInTheDocument();
    expect(sheet.textContent).not.toMatch(bannedWords);

    fireEvent.change(mode, { target: { value: "turbo" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find(({ body }) => body?.action === "save_and_check")).toBeTruthy());
    expect(calls.find(({ body }) => body?.action === "save_and_check")?.body?.draft).toEqual({
      ...webSource.configuration,
      openRouterWebSearch: { engine: "parallel", mode: "turbo" }
    });
  });

  it("switches OpenRouter web search to Perplexity, which has no modes", async () => {
    const webSource = source({
      configuration: {
        adapterKind: "provider_model_client",
        credentialMode: "provider_model",
        maxOutputTokens: null,
        openRouterWebSearch: { engine: "exa", mode: "deep" },
        protocol: "openrouter_web_search",
        providerModelId: "model-flash",
        queryMaxCharacters: 1_000,
        reasoningPolicy: "lowest_supported",
        timeoutMs: 120_000
      },
      id: "source-openrouter-web",
      kind: "web_search",
      sourceConnectionId: "conn-openrouter",
      strategyId: "openrouter-web-search"
    });
    state.current = {
      ...state.current,
      integrations: [webSource],
      providerModels: [{
        connectionDisplayName: "OpenRouter", connectionId: "conn-openrouter", displayName: "DeepSeek V4.1 Flash",
        enabled: true, id: "model-flash", searchKind: "openrouter_web_search", searchReasoningSupported: false
      }]
    };
    const calls = mockFetch(state, ({ method }) => method === "POST" ? Response.json({ search: state.current }) : null);
    renderSection("source-openrouter-web");

    fireEvent.click(await screen.findByRole("button", { name: "Configure" }));
    const sheet = await screen.findByRole("dialog", { name: "Configure source" });
    fireEvent.change(within(sheet).getByLabelText(/^OpenRouter engine/u), { target: { value: "perplexity" } });
    expect(within(sheet).queryByLabelText(/^Engine mode/u)).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.find(({ body }) => body?.action === "save_and_check")).toBeTruthy());
    expect(calls.find(({ body }) => body?.action === "save_and_check")?.body?.draft)
      .toMatchObject({ openRouterWebSearch: { engine: "perplexity", mode: null }, protocol: "openrouter_web_search" });
  });

  it("adds OpenRouter web search on an OpenRouter connection that has none yet", async () => {
    state.current = {
      ...state.current,
      providerModels: [...state.current.providerModels, {
        connectionDisplayName: "OpenRouter", connectionId: "conn-openrouter", displayName: "DeepSeek V4.1 Flash",
        enabled: true, id: "model-flash", searchKind: "openrouter_web_search", searchReasoningSupported: false
      }]
    };
    const calls = mockFetch(state, ({ method, url }) => method === "POST" && url === "/api/admin/search"
      ? Response.json({ error: "search_test_failed" }, { status: 422 })
      : null);
    renderSection();

    await waitFor(() => expect(screen.getByRole("button", { name: "Add source" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add source" }));
    const sheet = await screen.findByRole("dialog", { name: "Add source" });
    const model = within(sheet).getByLabelText(/^Search model/);
    expect(within(model).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Select a Search-capable model",
      "OpenRouter EU web search · GPT-6 Luna",
      "OpenRouter web search · DeepSeek V4.1 Flash"
    ]);
    fireEvent.change(model, { target: { value: "openrouter_web_search:model-flash" } });
    expect(within(sheet).getByLabelText("Name")).toHaveValue("OpenRouter Web Search");
    expect(within(sheet).getByLabelText(/^OpenRouter engine/u)).toHaveValue("perplexity");
    fireEvent.click(within(sheet).getByRole("button", { name: "Save" }));

    expect(await within(sheet).findByRole("alert")).toHaveTextContent("The check found no working source");
    expect(calls.find(({ method }) => method === "POST")?.body).toEqual({
      check: true,
      description: "Web results with source links through OpenRouter web search.",
      displayName: "OpenRouter Web Search",
      draft: expect.objectContaining({
        maxOutputTokens: null,
        openRouterWebSearch: { engine: "perplexity", mode: null },
        protocol: "openrouter_web_search",
        providerModelId: "model-flash"
      })
    });
  });
});
