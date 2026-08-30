import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProvidersExperience } from "./AdminProvidersExperience";

const api = vi.hoisted(() => ({
  clear: vi.fn(),
  get: vi.fn(),
  submit: vi.fn()
}));

const customApi = vi.hoisted(() => ({
  discover: vi.fn(),
  submit: vi.fn()
}));

const connections = vi.hoisted(() => ({
  mounts: 0,
  props: null as null | {
    active: boolean;
    entryConnectionId?: string | null;
    entryProvider?: "anthropic" | "deepseek" | "gemini" | "openai" | "openrouter" | null;
    onMutationCommitted?(): void | Promise<unknown>;
  }
}));

vi.mock("./adminProviderCustomSetupApi", () => ({
  adminProviderCustomSetupErrorMessage: (error: { code: string }) => error.code,
  discoverAdminProviderCustomModels: customApi.discover,
  submitAdminProviderCustomSetup: customApi.submit
}));

vi.mock("./adminProviderQuickSetupApi", () => ({
  adminProviderQuickSetupErrorMessage: (error: { code: string }) => {
    if (error.code === "provider_credential_test_failed") {
      return "The provider rejected the key or its account catalog could not be reached.";
    }
    return error.code;
  },
  clearAdminProviderQuickSetupAssignment: api.clear,
  getAdminProviderQuickSetup: api.get,
  submitAdminProviderQuickSetup: api.submit
}));

vi.mock("./AdminProvidersSection", async () => {
  const React = await import("react");
  return {
    AdminProvidersSection: (props: typeof connections.props extends infer _Ignored ? {
      active: boolean;
      entryConnectionId?: string | null;
      entryProvider?: "anthropic" | "deepseek" | "gemini" | "openai" | "openrouter" | null;
      onMutationCommitted?(): void | Promise<unknown>;
    } : never) => {
      const [draft, setDraft] = React.useState("");
      React.useEffect(() => {
        connections.mounts += 1;
      }, []);
      connections.props = props;
      return (
        <div data-testid="connections-provider-workspace">
          <span>Connections active: {String(props.active)}</span>
          <span>Entry connection: {props.entryConnectionId ?? "none"}</span>
          <span>Entry provider: {props.entryProvider ?? "none"}</span>
          <label>
            Connection draft
            <input onChange={(event) => setDraft(event.currentTarget.value)} value={draft} />
          </label>
          <button onClick={() => void props.onMutationCommitted?.()} type="button">
            Simulate Connections mutation
          </button>
        </div>
      );
    }
  };
});

function provider(
  id: "anthropic" | "deepseek" | "gemini" | "openai" | "openrouter",
  state: "advanced_required" | "disabled" | "needs_attention" | "not_configured" | "ready" = "not_configured",
  modelName?: string
) {
  const names = {
    anthropic: "Anthropic",
    deepseek: "DeepSeek",
    gemini: "Gemini",
    openai: "OpenAI",
    openrouter: "OpenRouter"
  };
  const models = {
    anthropic: "Claude Opus 5",
    deepseek: "DeepSeek V4 Pro",
    gemini: "Gemini 3.6 Flash",
    openai: "GPT-5.6 Terra",
    openrouter: "Claude Opus 4.8"
  };
  return {
    ...(state === "ready" ? { model: { displayName: modelName ?? models[id] } } : {}),
    provider: id,
    providerDisplayName: names[id],
    quickSetupAssigned: state === "ready",
    state,
    stateToken: `state-${id}`
  };
}

function snapshot(options: {
  anthropic?: Parameters<typeof provider>[1];
  deepseek?: Parameters<typeof provider>[1];
  gemini?: Parameters<typeof provider>[1];
  openai?: Parameters<typeof provider>[1];
  openrouter?: Parameters<typeof provider>[1];
  configuredConnections?: Array<{
    activeModelCount: number;
    displayName: string;
    enabled: boolean;
    family: string;
    id: string;
  }>;
  suggestedProvider?: "anthropic" | "deepseek" | "gemini" | "openai" | "openrouter" | null;
} = {}) {
  return {
    configuredConnections: options.configuredConnections ?? [],
    providers: [
      provider("openai", options.openai),
      provider("anthropic", options.anthropic),
      provider("deepseek", options.deepseek),
      provider("gemini", options.gemini),
      provider("openrouter", options.openrouter)
    ],
    suggestedProvider: options.suggestedProvider ?? null
  };
}

function ready(
  defaultChanged = true,
  searchStatus?: "needs_attention" | "ready",
  defaultCredentialChanged = true
) {
  return {
    checkedAt: "2026-07-26T03:00:00.000Z",
    defaultCredentialChanged,
    defaultChanged,
    model: { displayName: "GPT-5.6 Terra" },
    models: [
      { displayName: "GPT-5.6 Terra" },
      { displayName: "GPT-5.6 Luna" },
      { displayName: "GPT-5.6 Sol" }
    ],
    outcome: "ready" as const,
    provider: "openai" as const,
    providerDisplayName: "OpenAI",
    ...(searchStatus
      ? {
          search: {
            displayName: "OpenAI Search",
            status: searchStatus
          }
        }
      : {})
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("AdminProvidersExperience", () => {
  beforeEach(() => {
    api.clear.mockReset();
    api.get.mockReset();
    api.submit.mockReset();
    customApi.discover.mockReset();
    customApi.submit.mockReset();
    connections.mounts = 0;
    connections.props = null;
    api.get.mockResolvedValue({ data: snapshot(), ok: true });
  });

  it("shows configured connections immediately and opens the exact connection", async () => {
    api.get.mockResolvedValue({
      data: snapshot({
        configuredConnections: [{
          activeModelCount: 8,
          displayName: "codex-lb",
          enabled: true,
          family: "openai_compatible",
          id: "custom-codex-lb"
        }]
      }),
      ok: true
    });
    render(<AdminProvidersExperience active groups={[]} />);

    expect(await screen.findByRole("heading", { name: "Configured connections" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Custom 1 configured/ })).toBeVisible();
    const connection = screen.getByTestId("provider-configured-connection-custom-codex-lb");
    expect(connection).toHaveTextContent("codex-lb");
    expect(connection).toHaveTextContent("8 active models");
    expect(connection).toHaveTextContent("Enabled");
    expect(connections.mounts).toBe(0);

    fireEvent.click(connection);
    expect(await screen.findByText("Entry connection: custom-codex-lb")).toBeVisible();
    expect(connections.props?.entryConnectionId).toBe("custom-codex-lb");
    expect(connections.props?.entryProvider).toBeNull();
  });

  it("disambiguates duplicate configured connections and keeps exact navigation ids", async () => {
    api.get.mockResolvedValue({
      data: snapshot({
        configuredConnections: [
          {
            activeModelCount: 1,
            displayName: "Shared gateway",
            enabled: true,
            family: "openai_compatible",
            id: "custom-gateway-a"
          },
          {
            activeModelCount: 2,
            displayName: " shared   gateway ",
            enabled: true,
            family: "openai_compatible",
            id: "custom-gateway-b"
          }
        ]
      }),
      ok: true
    });
    render(<AdminProvidersExperience active groups={[]} />);

    const connectionActions = await screen.findAllByRole("button", {
      name: /^Open .* · ref [0-9A-Z]{6,} connection ·/u
    });
    expect(connectionActions).toHaveLength(2);
    expect(connectionActions[0]).not.toHaveAccessibleName(
      connectionActions[1]!.getAttribute("aria-label")!
    );

    fireEvent.click(connectionActions[1]!);
    expect(await screen.findByText("Entry connection: custom-gateway-b")).toBeVisible();
    expect(connections.props?.entryConnectionId).toBe("custom-gateway-b");
  });

  it("keeps custom OpenAI-compatible setup separate and deep-links its Ready connection", async () => {
    customApi.discover.mockResolvedValue({
      data: {
        checkedAt: "2026-07-26T09:59:00.000Z",
        modelCount: 2,
        models: [
          { capabilities: {}, id: "vendor/model-1" },
          { capabilities: {}, id: "vendor/model-2" }
        ],
        source: "models_catalog",
        status: "valid"
      },
      ok: true
    });
    customApi.submit.mockResolvedValue({
      data: {
        authenticationMode: "bearer",
        checkedAt: "2026-07-26T10:00:00.000Z",
        connectionDisplayName: "Custom · llm.example.test",
        connectionId: "custom-connection-1",
        defaultChanged: true,
        modelDisplayName: "vendor/model-1",
        models: [
          { modelDisplayName: "vendor/model-1", providerModelId: "custom-model-1" },
          { modelDisplayName: "vendor/model-2", providerModelId: "custom-model-2" }
        ],
        outcome: "ready",
        providerModelId: "custom-model-1",
        search: {
          displayName: "Custom · llm.example.test Search",
          status: "ready"
        }
      },
      ok: true
    });
    const onMutationCommitted = vi.fn();
    render(
      <AdminProvidersExperience
        active
        groups={[]}
        onMutationCommitted={onMutationCommitted}
      />
    );

    await screen.findByText("Choose a provider to continue.");
    expect(screen.getByTestId("provider-workspace-tabs")).toHaveClass(
      "overflow-x-auto",
      "overscroll-x-contain",
      "[scrollbar-width:none]",
      "[&::-webkit-scrollbar]:hidden"
    );
    expect(screen.getByRole("tab", { name: "Quick setup" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Connections" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "System Models" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Run profiles" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Custom OpenAI-compatible" }));
    expect(screen.getByRole("heading", { name: "Connect a custom endpoint" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^API root/), {
      target: { value: "https://llm.example.test/v1" }
    });
    fireEvent.change(screen.getByLabelText(/^API key/), {
      target: { value: "browser-only-key" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    const modelChoice = await screen.findByRole("button", {
      name: "Add models reported by this endpoint (2)"
    });
    fireEvent.click(modelChoice);
    fireEvent.click(screen.getByRole("option", { name: /vendor\/model-1/ }));
    fireEvent.click(screen.getByRole("button", {
      name: "Add models reported by this endpoint (2)"
    }));
    fireEvent.click(screen.getByRole("option", { name: /vendor\/model-2/ }));
    expect(customApi.discover).toHaveBeenCalledWith(expect.objectContaining({
      apiRoot: "https://llm.example.test/v1",
      secret: "browser-only-key"
    }), expect.any(Function), expect.any(AbortSignal));
    fireEvent.click(screen.getByText("Advanced settings"));
    expect(screen.getByRole("combobox", { name: /^Reasoning controls/ }))
      .toHaveValue("automatic");
    expect(screen.getByRole("checkbox", { name: /Streaming usage totals/ }))
      .not.toBeChecked();
    fireEvent.click(screen.getByLabelText("Hosted web search"));
    expect(screen.queryByRole("checkbox", { name: /Streaming usage totals/ }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Image generation (future workflows)"));
    expect(screen.getByLabelText(/^Reasoning effort field/)).toHaveValue("reasoning.effort");
    expect(screen.getByLabelText(/^Reasoning mode field \(optional\)/)).toHaveValue("reasoning.mode");
    fireEvent.change(screen.getByLabelText(/^Reasoning effort field/), {
      target: { value: "effort" }
    });
    fireEvent.change(screen.getByLabelText(/^Reasoning mode field \(optional\)/), {
      target: { value: "mode" }
    });
    expect(screen.getByText(/Image support is recorded now but is not yet runnable/))
      .toBeInTheDocument();
    expect(screen.getByText("https://llm.example.test/v1/responses"))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    const summary = await screen.findByTestId("provider-custom-ready-summary");
    expect(summary).toHaveTextContent("API key saved and verified");
    expect(summary).toHaveTextContent("assigned directly to this administrator");
    expect(summary).toHaveTextContent(
      "Custom · llm.example.test Search: ready for supported models."
    );
    expect(screen.getByRole("link", { name: "Manage Search" }))
      .toHaveAttribute("href", "/admin?section=search");
    expect(customApi.submit).toHaveBeenCalledOnce();
    expect(customApi.submit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      capabilities: expect.objectContaining({
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        nativeImageGeneration: true,
        nativeSearch: true,
        reasoning: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        reasoningModes: ["standard", "pro"]
      }),
      modelIds: ["vendor/model-1", "vendor/model-2"],
      protocol: "responses",
      reasoningRequestMapping: {
        effortPath: "effort",
        modePath: "mode"
      },
      secret: "browser-only-key"
    }));
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Manage connection" }));
    expect(await screen.findByTestId("connections-provider-workspace")).toBeInTheDocument();
    expect(screen.getByText("Entry connection: custom-connection-1")).toBeInTheDocument();
    expect(connections.props?.entryConnectionId).toBe("custom-connection-1");
    expect(connections.props?.entryProvider).toBeNull();
    expect(screen.getByRole("tab", { name: "Connections" })).toHaveAttribute("aria-selected", "true");
  });

  it("starts with no implicit provider and completes one write-only Test & Save request", async () => {
    const reconciliation = deferred<{
      data: ReturnType<typeof snapshot>;
      ok: true;
    }>();
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockReturnValueOnce(reconciliation.promise)
      .mockResolvedValue({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      });
    api.submit.mockResolvedValue({ data: ready(false), ok: true });
    const onMutationCommitted = vi.fn();
    render(
      <AdminProvidersExperience
        active
        groups={[]}
        onMutationCommitted={onMutationCommitted}
      />
    );

    await screen.findByText("Choose a provider to continue.");
    expect(screen.getByRole("button", { name: /Gemini Not configured/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(connections.mounts).toBe(0);
    const openAiChoice = screen.getByRole("button", { name: /OpenAI Not configured/ });
    expect(openAiChoice).toHaveClass("bg-answer-paper", "text-ink");
    expect(within(openAiChoice).getByText("Not configured")).toHaveClass("text-ink-muted");
    fireEvent.click(openAiChoice);
    expect(openAiChoice).toHaveClass("bg-control-selected", "text-ink");
    expect(openAiChoice).not.toHaveClass("bg-proof/10", "text-proof");
    expect(within(openAiChoice).getByText("Not configured")).toHaveClass("text-ink-secondary");
    const key = screen.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    fireEvent.change(key, { target: { value: "browser-only-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    await screen.findByText("Ready to chat");
    expect(api.submit).toHaveBeenCalledOnce();
    expect(api.submit.mock.calls[0]?.[0]).toEqual({
      expectedState: "state-openai",
      provider: "openai",
      secret: "browser-only-key"
    });
    expect(screen.queryByDisplayValue("browser-only-key")).not.toBeInTheDocument();
    expect(screen.getByText("GPT-5.6 Terra")).toBeInTheDocument();
    expect(screen.getByText("This provider is configured and available in chat. Personal and installation default models remain unchanged.")).toBeInTheDocument();
    const summary = screen.getByTestId("provider-quick-ready-summary");
    expect(summary).toHaveTextContent("API key: saved and verified.");
    expect(summary).toHaveTextContent("Prepared model: GPT-5.6 Terra.");
    expect(summary).toHaveTextContent(
      "Available models: GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.6 Sol."
    );
    expect(summary).toHaveTextContent("Access: available to this administrator.");
    expect(summary).toHaveTextContent(
      "Connection default credential: set to this verified key."
    );
    expect(screen.getByText(/Default models: unchanged\./)).toBeInTheDocument();
    expect(summary).not.toHaveTextContent("Run profiles");
    const feedback = screen.getByTestId("provider-quick-feedback");
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveAttribute("aria-live", "polite");
    expect(feedback).toHaveTextContent("OpenAI is ready to chat with GPT-5.6 Terra.");
    expect(screen.getByText("Ready to chat")).not.toHaveAttribute("role");
    expect(screen.queryByRole("link", { name: "Start chatting" })).not.toBeInTheDocument();
    await act(async () => {
      reconciliation.resolve({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      });
      await reconciliation.promise;
    });
    expect(feedback).toHaveTextContent("OpenAI is ready to chat with GPT-5.6 Terra.");
    expect(screen.getByRole("link", { name: "Start chatting" })).toHaveAttribute("href", "/");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    expect(screen.queryByText(/API root|credential version|group assignment|activation counter|diagnostics/i)).not.toBeInTheDocument();
  });

  it.each([
    {
      detail: "ready for supported models",
      message: "OpenAI Search is ready for supported OpenAI, Anthropic, Gemini, and other answer models.",
      status: "ready" as const
    },
    {
      detail: "requires attention; finish setup in Search",
      message: "The provider is ready, but OpenAI Search still needs a successful source check before it can serve broader models.",
      status: "needs_attention" as const
    }
  ])("reports OpenAI Search as $status without obscuring provider readiness", async ({
    detail,
    message,
    status
  }) => {
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValue({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      });
    api.submit.mockResolvedValue({ data: ready(true, status), ok: true });
    render(<AdminProvidersExperience active groups={[]} />);

    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "one-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    expect(await screen.findByText("Ready to chat")).toBeInTheDocument();
    expect(screen.getByTestId("provider-quick-ready-summary")).toHaveTextContent(
      `OpenAI Search: ${detail}.`
    );
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage OpenAI Search" }))
      .toHaveAttribute("href", "/admin?section=search");
    expect(screen.getByRole("link", { name: "Start chatting" })).toHaveAttribute("href", "/");
  });

  it("shows one truthful pending label until the atomic request reaches a terminal result", async () => {
    const pending = deferred<{ data: ReturnType<typeof ready>; ok: true }>();
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValue({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      });
    api.submit.mockReturnValueOnce(pending.promise);
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "one-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    expect(await screen.findByRole("button", { name: "Testing & saving…" })).toBeInTheDocument();
    expect(screen.queryByText(/Testing key|Activating model|Granting access/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("provider-quick-feedback")).toHaveTextContent(
      "Testing and saving OpenAI."
    );

    await act(async () => {
      pending.resolve({ data: ready(), ok: true });
      await pending.promise;
    });
    expect(await screen.findByText("Ready to chat")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Testing & saving…" })).not.toBeInTheDocument();
  });

  it("retains a masked key for model choice, resets candidates after key change, and repeats the check", async () => {
    const finalCheck = deferred<{ data: ReturnType<typeof ready>; ok: true }>();
    const selection = {
      candidates: [
        { candidateId: "p2-o2", displayName: "GPT-5.6 Luna" },
        { candidateId: "p2-o3", displayName: "GPT-5.6 Sol" }
      ],
      checkedAt: "2026-07-26T03:00:00.000Z",
      expectedState: "state-openai",
      outcome: "selection_required" as const,
      policyVersion: 3,
      provider: "openai" as const,
      providerDisplayName: "OpenAI"
    };
    api.submit
      .mockResolvedValueOnce({ data: selection, ok: true })
      .mockResolvedValueOnce({ data: selection, ok: true })
      .mockReturnValueOnce(finalCheck.promise);
    const reconciledSnapshot = snapshot({ openai: "ready", suggestedProvider: "openai" });
    reconciledSnapshot.providers[0] = provider("openai", "ready", "GPT-5.6 Sol");
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValue({ data: reconciledSnapshot, ok: true });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));
    await screen.findByText("GPT-5.6 Sol");
    expect(screen.getByLabelText("API key")).toHaveValue("first-key");

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "changed-key" } });
    expect(screen.queryByText("GPT-5.6 Sol")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));
    await screen.findByText("GPT-5.6 Sol");
    const feedback = screen.getByTestId("provider-quick-feedback");
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveTextContent(
      "OpenAI needs a model choice. Choose one to finish setup."
    );
    expect(screen.getByTestId("provider-quick-model-required")).toHaveTextContent(
      "Choose one to finish setup"
    );
    expect(screen.getByTestId("provider-quick-model-required")).not.toHaveAttribute("role");
    expect(screen.getByTestId("provider-quick-model-required")).not.toHaveAttribute("aria-live");
    expect(screen.getByLabelText("GPT-5.6 Luna")).toHaveFocus();
    fireEvent.click(screen.getByLabelText("GPT-5.6 Sol"));
    expect(feedback).toHaveTextContent(
      "GPT-5.6 Sol selected. Submit again to finish setup."
    );
    fireEvent.click(screen.getByRole("button", { name: "Use selected model & save" }));

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("GPT-5.6 Luna")).toBeDisabled();
    expect(screen.getByLabelText("GPT-5.6 Sol")).toBeDisabled();
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(api.submit.mock.calls[2]?.[0]).toEqual({
      expectedState: "state-openai",
      provider: "openai",
      secret: "changed-key",
      selectedModel: { candidateId: "p2-o3", policyVersion: 3 }
    });
    await act(async () => {
      finalCheck.resolve({
        data: {
          ...ready(),
          model: { displayName: "GPT-5.6 Sol" }
        },
        ok: true
      });
      await finalCheck.promise;
    });
    const summary = await screen.findByTestId("provider-quick-ready-summary");
    expect(summary).toHaveTextContent("Prepared model: GPT-5.6 Sol.");
    expect(summary).not.toHaveTextContent("Run profiles");
  });

  it("keeps replacement blank and the Ready fact visible after a retryable failure", async () => {
    api.get.mockResolvedValue({
      data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
      ok: true
    });
    api.submit.mockResolvedValue({
      error: { code: "provider_credential_test_failed" },
      ok: false
    });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Ready to chat");
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByText("Your current key stays active unless this replacement succeeds.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "retry-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    const visualError = await screen.findByText(
      "The provider rejected the key or its account catalog could not be reached."
    );
    const feedback = screen.getByTestId("provider-quick-feedback");
    const key = screen.getByLabelText("API key");
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveAttribute("aria-live", "polite");
    expect(feedback).toHaveAttribute("data-feedback-tone", "error");
    expect(feedback).toHaveTextContent(
      "OpenAI setup failed. The provider rejected the key or its account catalog could not be reached."
    );
    expect(visualError.closest('[role="alert"]')).toBeNull();
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key).toHaveAttribute("aria-errormessage", visualError.id);
    expect(key.getAttribute("aria-describedby")?.split(/\s+/)).toEqual(
      expect.arrayContaining(["provider-quick-api-key-help", visualError.id])
    );
    expect(screen.getByText("Ready to chat")).toBeInTheDocument();
    expect(key).toHaveValue("retry-key");
    fireEvent.click(screen.getByRole("button", { name: "Cancel replacement" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.queryByText("Choose a model available to this key")).not.toBeInTheDocument();
  });

  it("keeps the key form primary when existing custom configuration is present", async () => {
    api.get.mockResolvedValue({
      data: snapshot({
        anthropic: "advanced_required",
        openrouter: "needs_attention",
        suggestedProvider: "openrouter"
      }),
      ok: true
    });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Setup needs attention");
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Anthropic Custom setup exists/ }));
    expect(screen.getByRole("heading", { name: "Connect Anthropic" })).toBeInTheDocument();
    expect(screen.getByText("Existing team or custom configuration will stay unchanged.")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage Anthropic connection" }));
    expect(await screen.findByTestId("connections-provider-workspace")).toBeInTheDocument();
    expect(connections.props?.entryProvider).toBe("anthropic");
  });

  it("presents a configured disabled provider as Disabled without attention styling", async () => {
    api.get.mockResolvedValue({
      data: snapshot({ openai: "disabled", suggestedProvider: "openai" }),
      ok: true
    });
    render(<AdminProvidersExperience active groups={[]} />);

    expect(await screen.findByText("Provider disabled")).toBeInTheDocument();
    const providerChoice = screen.getByRole("button", { name: /OpenAI Disabled/ });
    expect(providerChoice).toBeInTheDocument();
    expect(within(providerChoice).getByText("Disabled")).toHaveClass(
      "border-trace-strong",
      "bg-control-surface",
      "text-ink"
    );
    expect(screen.getByText(/Existing configuration is paused for new runs/))
      .toBeInTheDocument();
    expect(screen.queryByText("Setup needs attention")).not.toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toBeInTheDocument();
  });

  it("confirms that assignment removal leaves the connection default unchanged", async () => {
    api.get
      .mockResolvedValueOnce({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      })
      .mockResolvedValue({ data: snapshot(), ok: true });
    api.clear.mockResolvedValueOnce({
      data: {
        credentialRetained: true,
        outcome: "assignment_cleared",
        provider: "openai",
        providerDisplayName: "OpenAI"
      },
      ok: true
    });
    render(<AdminProvidersExperience active groups={[]} />);

    await screen.findByText("Ready to chat");
    expect(screen.getByText(/does not change the connection default/i))
      .toBeInTheDocument();
    expect(screen.getByText(/stored credential and all team settings stay unchanged/i))
      .toBeInTheDocument();
    expect(screen.getByText(/credential remains manageable in Connections/i))
      .toBeInTheDocument();
    expect(screen.getByText(/returns to normal team\/default credential resolution/i))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove my key assignment" }));

    const confirmation = await screen.findByTestId(
      "admin-confirm-clear-provider-quick-assignment"
    );
    expect(confirmation).toHaveTextContent("does not change the connection default");
    expect(api.clear).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", {
      name: "Confirm remove key assignment"
    }));

    await waitFor(() => expect(api.clear).toHaveBeenCalledWith({
      expectedState: "state-openai",
      provider: "openai"
    }, expect.any(Function), expect.any(AbortSignal)));
  });

  it("clears Setup secrets, preserves Connections drafts, and refetches Setup on return", async () => {
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValue({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      });
    const onMutationCommitted = vi.fn();
    render(
      <AdminProvidersExperience
        active
        groups={[]}
        onMutationCommitted={onMutationCommitted}
      />
    );
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "must-clear" } });
    expect(connections.mounts).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Manage OpenAI connection" }));

    expect(await screen.findByTestId("connections-provider-workspace")).toBeInTheDocument();
    expect(screen.getByText("Entry provider: openai")).toBeInTheDocument();
    expect(connections.props?.entryProvider).toBe("openai");
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    await waitFor(() => expect(connections.mounts).toBe(1));
    fireEvent.change(screen.getByLabelText("Connection draft"), {
      target: { value: "preserved connection draft" }
    });
    expect(screen.getByLabelText("Connection draft")).toHaveValue("preserved connection draft");

    const refreshesBeforeMutation = api.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Simulate Connections mutation" }));
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    expect(api.get).toHaveBeenCalledTimes(refreshesBeforeMutation);
    fireEvent.click(screen.getByRole("tab", { name: "Quick setup" }));
    await screen.findByText("Ready to chat");
    expect(screen.queryByTestId("connections-provider-workspace")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Connection draft")).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(refreshesBeforeMutation + 1);
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel replacement" }));
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(await screen.findByLabelText("Connection draft")).toHaveValue("");
    await waitFor(() => expect(connections.mounts).toBe(2));
  });

  it("offers Connections directly when the provider catalog is unsupported", async () => {
    api.submit.mockResolvedValue({
      error: { code: "provider_quick_setup_unsupported_catalog" },
      ok: false
    });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "unsupported-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    const manageButton = await screen.findByRole("button", { name: "Manage provider connection" });
    const feedback = screen.getByTestId("provider-quick-feedback");
    const key = screen.getByLabelText("API key");
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveAttribute("data-feedback-tone", "error");
    expect(feedback).toHaveTextContent(
      "OpenAI setup failed. provider_quick_setup_unsupported_catalog"
    );
    expect(key).toHaveAttribute("aria-invalid", "true");
    expect(key).toHaveAttribute("aria-errormessage", "provider-quick-setup-error");
    fireEvent.click(manageButton);
    expect(await screen.findByTestId("connections-provider-workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Quick setup" }));
    expect(await screen.findByLabelText("API key")).toHaveValue("");
  });

  it("keeps global setup failures off the API key while preserving an announced retry", async () => {
    api.submit.mockResolvedValue({ error: { code: "network_error" }, ok: false });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    const key = screen.getByLabelText("API key");
    fireEvent.change(key, { target: { value: "retry-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    const feedback = screen.getByTestId("provider-quick-feedback");
    await waitFor(() => expect(feedback).toHaveAttribute("data-feedback-tone", "error"));
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveTextContent("OpenAI setup failed. network_error");
    expect(key).not.toHaveAttribute("aria-invalid");
    expect(key).not.toHaveAttribute("aria-errormessage");
    expect(key).toHaveAttribute("aria-describedby", "provider-quick-api-key-help");
    expect(key).toHaveValue("retry-key");
    expect(screen.getByRole("button", { name: "Test & Save" })).toBeEnabled();
  });

  it("keeps Ready visible and offers Connections after a raced replacement", async () => {
    api.get.mockResolvedValue({
      data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
      ok: true
    });
    api.submit.mockResolvedValue({
      error: { code: "provider_quick_setup_advanced_required" },
      ok: false
    });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Ready to chat");
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "raced-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    expect(await screen.findByText("provider_quick_setup_advanced_required")).toBeInTheDocument();
    expect(screen.getByText("Ready to chat")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("raced-key");
    expect(screen.getByLabelText("API key")).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Manage provider connection" }));
    expect(await screen.findByTestId("connections-provider-workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Quick setup" }));
    await screen.findByText("Ready to chat");
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
  });

  it("recovers an initial snapshot failure without requiring a selected provider", async () => {
    api.get
      .mockResolvedValueOnce({ error: { code: "network_error" }, ok: false })
      .mockResolvedValueOnce({ data: snapshot(), ok: true });
    render(<AdminProvidersExperience active groups={[]} />);

    expect(await screen.findByText("network_error")).toBeInTheDocument();
    const feedback = screen.getByTestId("provider-quick-feedback");
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveAttribute("data-feedback-tone", "error");
    expect(feedback).toHaveTextContent(
      "Provider status refresh failed. network_error"
    );
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry status refresh" }));
    expect(await screen.findByText("Choose a provider to continue.")).toBeInTheDocument();
    expect(screen.queryByText("network_error")).not.toBeInTheDocument();
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback).toHaveTextContent("Provider status refreshed.");
  });

  it("keeps optimistic Ready locked until failed reconciliation is explicitly retried", async () => {
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValueOnce({ error: { code: "network_error" }, ok: false })
      .mockResolvedValueOnce({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      });
    api.submit.mockResolvedValueOnce({
      data: ready(false, undefined, false),
      ok: true
    });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "one-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    expect(await screen.findByText("The current provider status still needs confirmation before another change.")).toBeInTheDocument();
    expect(screen.getByText("Ready to chat")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Start chatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace API key" })).toBeDisabled();
    expect(screen.getByText(/Connection default credential: already uses this verified key\./))
      .toBeInTheDocument();
    expect(screen.getByText(/Default models: unchanged\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry status refresh" }));
    expect(await screen.findByRole("link", { name: "Start chatting" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: "Replace API key" })).toBeEnabled();
    expect(screen.getByText(/Default models: unchanged\./)).toBeInTheDocument();
  });

  it("activates only the selected lazy task and mounts a fresh Connections projection after a Quick commit", async () => {
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValue({
        data: snapshot({ openai: "ready", suggestedProvider: "openai" }),
        ok: true
      });
    api.submit.mockResolvedValue({ data: ready(), ok: true });
    const onMutationCommitted = vi.fn();
    render(
      <AdminProvidersExperience
        active
        groups={[]}
        onMutationCommitted={onMutationCommitted}
      />
    );
    await screen.findByText("Choose a provider to continue.");
    expect(connections.mounts).toBe(0);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    await screen.findByTestId("connections-provider-workspace");
    expect(connections.props?.active).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "Quick setup" }));
    await screen.findByText("Choose a provider to continue.");
    // Leaving Connections for a setup task unmounts the non-selected
    // projection instead of keeping it mounted-but-inactive.
    expect(screen.queryByTestId("connections-provider-workspace")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not configured/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "one-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    await screen.findByText("Ready to chat");
    expect(screen.queryByTestId("connections-provider-workspace")).not.toBeInTheDocument();
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Manage OpenAI connection" }));
    expect(await screen.findByTestId("connections-provider-workspace")).toBeInTheDocument();
    await waitFor(() => expect(connections.mounts).toBe(2));
    expect(connections.props?.active).toBe(true);
    expect(screen.getByText("Entry provider: openai")).toBeInTheDocument();
  });
});
