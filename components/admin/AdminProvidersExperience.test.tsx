import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminProvidersExperience } from "./AdminProvidersExperience";

const api = vi.hoisted(() => ({
  clear: vi.fn(),
  get: vi.fn(),
  submit: vi.fn()
}));

const advanced = vi.hoisted(() => ({
  mounts: 0,
  props: null as null | {
    active: boolean;
    advancedEntryProvider?: "anthropic" | "gemini" | "openai" | "openrouter" | null;
    onBackToQuickSetup(): void;
    onMutationCommitted?(): void | Promise<unknown>;
  }
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
    AdminProvidersSection: (props: typeof advanced.props extends infer _Ignored ? {
      active: boolean;
      advancedEntryProvider?: "anthropic" | "gemini" | "openai" | "openrouter" | null;
      onBackToQuickSetup(): void;
      onMutationCommitted?(): void | Promise<unknown>;
    } : never) => {
      const [draft, setDraft] = React.useState("");
      React.useEffect(() => {
        advanced.mounts += 1;
      }, []);
      advanced.props = props;
      return (
        <div data-testid="advanced-provider-workspace">
          <span>Advanced active: {String(props.active)}</span>
          <span>Entry provider: {props.advancedEntryProvider ?? "none"}</span>
          <label>
            Advanced draft
            <input onChange={(event) => setDraft(event.currentTarget.value)} value={draft} />
          </label>
          <button onClick={() => void props.onMutationCommitted?.()} type="button">
            Simulate Advanced mutation
          </button>
          <button onClick={props.onBackToQuickSetup} type="button">
            Back to quick setup
          </button>
        </div>
      );
    }
  };
});

function provider(
  id: "anthropic" | "gemini" | "openai" | "openrouter",
  state: "advanced_required" | "needs_attention" | "not_configured" | "ready" = "not_configured",
  modelName?: string
) {
  const names = {
    anthropic: "Anthropic",
    gemini: "Gemini",
    openai: "OpenAI",
    openrouter: "OpenRouter"
  };
  const models = {
    anthropic: "Claude Opus 5",
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
  gemini?: Parameters<typeof provider>[1];
  openai?: Parameters<typeof provider>[1];
  openrouter?: Parameters<typeof provider>[1];
  suggestedProvider?: "anthropic" | "gemini" | "openai" | "openrouter" | null;
} = {}) {
  return {
    providers: [
      provider("openai", options.openai),
      provider("anthropic", options.anthropic),
      provider("gemini", options.gemini),
      provider("openrouter", options.openrouter)
    ],
    suggestedProvider: options.suggestedProvider ?? null
  };
}

function ready(defaultChanged = true) {
  return {
    checkedAt: "2026-07-26T03:00:00.000Z",
    defaultChanged,
    model: { displayName: "GPT-5.6 Terra" },
    models: [
      { displayName: "GPT-5.6 Terra" },
      { displayName: "GPT-5.6 Luna" },
      { displayName: "GPT-5.6 Sol" }
    ],
    outcome: "ready" as const,
    profilesFilled: ["balanced"],
    provider: "openai" as const,
    providerDisplayName: "OpenAI"
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
    advanced.mounts = 0;
    advanced.props = null;
    api.get.mockResolvedValue({ data: snapshot(), ok: true });
  });

  it("starts with no implicit provider and completes one write-only Test & Save request", async () => {
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
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
    expect(screen.getByRole("button", { name: /Gemini Not connected/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(advanced.mounts).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not connected/ }));
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
    expect(screen.getByText("Available in chat. Your existing default model remained unchanged.")).toBeInTheDocument();
    const receipt = screen.getByTestId("provider-quick-ready-receipt");
    expect(receipt).toHaveTextContent("API key: saved and verified.");
    expect(receipt).toHaveTextContent("Default model: GPT-5.6 Terra.");
    expect(receipt).toHaveTextContent(
      "Available models: GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.6 Sol."
    );
    expect(receipt).toHaveTextContent("Access: available to this administrator.");
    expect(screen.getByText("Default selection: unchanged.")).toBeInTheDocument();
    expect(screen.getByText("Run profiles filled: Balanced.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start chatting" })).toHaveAttribute("href", "/");
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    expect(screen.queryByText(/API root|credential version|group assignment|activation counter|diagnostics/i)).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not connected/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "one-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    expect(await screen.findByRole("button", { name: "Testing & saving…" })).toBeInTheDocument();
    expect(screen.queryByText(/Testing key|Activating model|Granting access/i)).not.toBeInTheDocument();

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
      policyVersion: 2,
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
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not connected/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "first-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));
    await screen.findByText("GPT-5.6 Sol");
    expect(screen.getByLabelText("API key")).toHaveValue("first-key");

    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "changed-key" } });
    expect(screen.queryByText("GPT-5.6 Sol")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));
    await screen.findByText("GPT-5.6 Sol");
    fireEvent.click(screen.getByLabelText("GPT-5.6 Sol"));
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("GPT-5.6 Luna")).toBeDisabled();
    expect(screen.getByLabelText("GPT-5.6 Sol")).toBeDisabled();
    expect(screen.getByLabelText("API key")).toBeDisabled();
    expect(api.submit.mock.calls[2]?.[0]).toEqual({
      expectedState: "state-openai",
      provider: "openai",
      secret: "changed-key",
      selectedModel: { candidateId: "p2-o3", policyVersion: 2 }
    });
    await act(async () => {
      finalCheck.resolve({
        data: {
          ...ready(),
          model: { displayName: "GPT-5.6 Sol" },
          profilesFilled: ["deep"]
        },
        ok: true
      });
      await finalCheck.promise;
    });
    const receipt = await screen.findByTestId("provider-quick-ready-receipt");
    expect(receipt).toHaveTextContent("Default model: GPT-5.6 Sol.");
    expect(receipt).toHaveTextContent("Run profiles filled: Deep.");
    expect(receipt).not.toHaveTextContent("Balanced");
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

    await screen.findByText("The provider rejected the key or its account catalog could not be reached.");
    expect(screen.getByText("Ready to chat")).toBeInTheDocument();
    expect(screen.getByLabelText("API key")).toHaveValue("retry-key");
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
    fireEvent.click(screen.getByRole("button", { name: "Advanced configuration" }));
    expect(await screen.findByTestId("advanced-provider-workspace")).toBeInTheDocument();
  });

  it("confirms a truthful Quick assignment removal without promising fallback access", async () => {
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
    expect(screen.getByText(/model access may stop unless an applicable team or default credential/i))
      .toBeInTheDocument();
    expect(screen.getByText(/stored credential and all team settings stay unchanged/i))
      .toBeInTheDocument();
    expect(screen.getByText(/credential remains manageable in Advanced configuration/i))
      .toBeInTheDocument();
    expect(screen.queryByText(/fall back to the applicable/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove my key assignment" }));

    const confirmation = await screen.findByTestId(
      "admin-confirm-clear-provider-quick-assignment"
    );
    expect(confirmation).toHaveTextContent("Model access may stop");
    expect(api.clear).not.toHaveBeenCalled();
    fireEvent.click(within(confirmation).getByRole("button", {
      name: "Confirm remove key assignment"
    }));

    await waitFor(() => expect(api.clear).toHaveBeenCalledWith({
      expectedState: "state-openai",
      provider: "openai"
    }, expect.any(Function), expect.any(AbortSignal)));
  });

  it("unmounts Advanced with its drafts and refetches Quick only on return", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not connected/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "must-clear" } });
    expect(advanced.mounts).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Advanced configuration" }));

    expect(await screen.findByTestId("advanced-provider-workspace")).toBeInTheDocument();
    expect(screen.getByText("Entry provider: openai")).toBeInTheDocument();
    expect(advanced.props?.advancedEntryProvider).toBe("openai");
    expect(advanced.props?.onBackToQuickSetup).toEqual(expect.any(Function));
    expect(screen.getAllByRole("button", { name: "Back to quick setup" })).toHaveLength(1);
    await waitFor(() => expect(advanced.mounts).toBe(1));
    fireEvent.change(screen.getByLabelText("Advanced draft"), { target: { value: "preserved draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to quick setup" }));
    await screen.findByText("Ready to chat");
    expect(screen.queryByTestId("advanced-provider-workspace")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Advanced draft")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace API key" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel replacement" }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced configuration" }));
    expect(await screen.findByLabelText("Advanced draft")).toHaveValue("");
    await waitFor(() => expect(advanced.mounts).toBe(2));

    const refreshesBeforeMutation = api.get.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Simulate Advanced mutation" }));
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    expect(api.get).toHaveBeenCalledTimes(refreshesBeforeMutation);
    fireEvent.click(screen.getByRole("button", { name: "Back to quick setup" }));
    expect(await screen.findByText("Ready to chat")).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(refreshesBeforeMutation + 1);
  });

  it("offers Advanced directly when the provider catalog is unsupported", async () => {
    api.submit.mockResolvedValue({
      error: { code: "provider_quick_setup_unsupported_catalog" },
      ok: false
    });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not connected/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "unsupported-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    const advancedButton = await screen.findByRole("button", { name: "Open Advanced configuration" });
    fireEvent.click(advancedButton);
    expect(await screen.findByTestId("advanced-provider-workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to quick setup" }));
    expect(await screen.findByLabelText("API key")).toHaveValue("");
  });

  it("keeps Ready visible and offers Advanced after a raced replacement", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Open Advanced configuration" }));
    expect(await screen.findByTestId("advanced-provider-workspace")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to quick setup" }));
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
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry status refresh" }));
    expect(await screen.findByText("Choose a provider to continue.")).toBeInTheDocument();
    expect(screen.queryByText("network_error")).not.toBeInTheDocument();
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
      data: { ...ready(false), profilesFilled: ["balanced", "fast"] },
      ok: true
    });
    render(<AdminProvidersExperience active groups={[]} />);
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not connected/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "one-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    expect(await screen.findByText("The current provider status still needs confirmation before another change.")).toBeInTheDocument();
    expect(screen.getByText("Ready to chat")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Start chatting" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace API key" })).toBeDisabled();
    expect(screen.getByText("Default selection: unchanged.")).toBeInTheDocument();
    expect(screen.getByText("Run profiles filled: Balanced, Fast.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry status refresh" }));
    expect(await screen.findByRole("link", { name: "Start chatting" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: "Replace API key" })).toBeEnabled();
    expect(screen.getByText("Default selection: unchanged.")).toBeInTheDocument();
    expect(screen.getByText("Run profiles filled: Balanced, Fast.")).toBeInTheDocument();
  });

  it("mounts a fresh Advanced projection after a Quick commit", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Advanced configuration" }));
    await screen.findByTestId("advanced-provider-workspace");
    fireEvent.click(screen.getByRole("button", { name: "Back to quick setup" }));
    await screen.findByText("Choose a provider to continue.");
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Not connected/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "one-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & Save" }));

    await screen.findByText("Ready to chat");
    expect(screen.queryByTestId("advanced-provider-workspace")).not.toBeInTheDocument();
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Advanced configuration" }));
    expect(await screen.findByTestId("advanced-provider-workspace")).toBeInTheDocument();
    await waitFor(() => expect(advanced.mounts).toBe(2));
    expect(screen.getByText("Entry provider: openai")).toBeInTheDocument();
  });
});
