import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminProviderQuickSetupController } from "./useAdminProviderQuickSetupController";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  submit: vi.fn()
}));

vi.mock("./adminProviderQuickSetupApi", () => ({
  adminProviderQuickSetupErrorMessage: (error: { code: string }) => error.code,
  getAdminProviderQuickSetup: api.get,
  submitAdminProviderQuickSetup: api.submit
}));

function snapshot(stateToken = "state-openai") {
  return {
    providers: [
      {
        provider: "openai" as const,
        providerDisplayName: "OpenAI",
        state: "not_configured" as const,
        stateToken
      },
      {
        provider: "anthropic" as const,
        providerDisplayName: "Anthropic",
        state: "not_configured" as const,
        stateToken: "state-anthropic"
      },
      {
        provider: "openrouter" as const,
        providerDisplayName: "OpenRouter",
        state: "not_configured" as const,
        stateToken: "state-openrouter"
      }
    ],
    suggestedProvider: null
  };
}

function readySnapshot(stateToken = "state-openai-ready") {
  return {
    ...snapshot(stateToken),
    providers: snapshot(stateToken).providers.map((provider) => provider.provider === "openai"
      ? {
          ...provider,
          model: { displayName: "GPT-5.6 Terra" },
          state: "ready" as const
        }
      : provider),
    suggestedProvider: "openai" as const
  };
}

function readyResult(options: {
  defaultChanged?: boolean;
  profilesFilled?: ("balanced" | "deep" | "fast")[];
} = {}) {
  return {
    checkedAt: "2026-07-26T03:00:00.000Z",
    defaultChanged: options.defaultChanged ?? true,
    model: { displayName: "GPT-5.6 Terra" },
    outcome: "ready" as const,
    profilesFilled: options.profilesFilled ?? [],
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

describe("useAdminProviderQuickSetupController", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.submit.mockReset();
    api.get.mockResolvedValue({ data: snapshot(), ok: true });
  });

  it("drops stale model selection, keeps the browser key, and retries with the refreshed fence", async () => {
    api.get
      .mockResolvedValueOnce({ data: snapshot("state-old"), ok: true })
      .mockResolvedValueOnce({ data: snapshot("state-new"), ok: true })
      .mockResolvedValue({ data: snapshot("state-new"), ok: true });
    api.submit
      .mockResolvedValueOnce({
        data: {
          candidates: [{ candidateId: "p1-o2", displayName: "GPT-5.6 Luna" }],
          checkedAt: "2026-07-26T03:00:00.000Z",
          expectedState: "state-old",
          outcome: "selection_required",
          policyVersion: 1,
          provider: "openai",
          providerDisplayName: "OpenAI"
        },
        ok: true
      })
      .mockResolvedValueOnce({ error: { code: "provider_draft_stale" }, ok: false })
      .mockResolvedValueOnce({
        data: {
          checkedAt: "2026-07-26T03:01:00.000Z",
          defaultChanged: true,
          model: { displayName: "GPT-5.6 Luna" },
          outcome: "ready",
          profilesFilled: [],
          provider: "openai",
          providerDisplayName: "OpenAI"
        },
        ok: true
      });

    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("browser-only-key");
    });
    await act(async () => {
      await result.current.actions.submit();
    });
    act(() => result.current.actions.chooseModel("p1-o2"));
    await act(async () => {
      await result.current.actions.submit();
    });

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(result.current.state.secret).toBe("browser-only-key");
    expect(result.current.state.selection).toBeNull();
    expect(result.current.state.selectedCandidateId).toBeNull();

    await act(async () => {
      await result.current.actions.submit();
    });
    expect(api.submit.mock.calls[2]?.[0]).toEqual({
      expectedState: "state-new",
      provider: "openai",
      secret: "browser-only-key"
    });
  });

  it("keeps provider choice and form immutable while an atomic POST is pending", async () => {
    const pending = deferred<{ error: { code: string }; ok: false }>();
    api.submit.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("openai-key");
    });
    let request!: Promise<boolean>;
    act(() => {
      request = result.current.actions.submit();
    });
    await waitFor(() => expect(result.current.state.submitting).toBe(true));

    act(() => result.current.actions.selectProvider("anthropic"));
    act(() => result.current.actions.changeSecret("mutated-key"));
    pending.resolve({ error: { code: "provider_credential_test_failed" }, ok: false });
    await act(async () => request);

    expect(result.current.state.selectedProviderId).toBe("openai");
    expect(result.current.state.secret).toBe("openai-key");
    expect(result.current.state.readyResult).toBeNull();
    expect(result.current.state.submitting).toBe(false);
  });

  it("blocks duplicate submission while one atomic request is pending", async () => {
    const pending = deferred<{ error: { code: string }; ok: false }>();
    api.submit.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("one-key");
    });
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.actions.submit();
      second = result.current.actions.submit();
    });
    await expect(second).resolves.toBe(false);
    expect(api.submit).toHaveBeenCalledOnce();
    pending.resolve({ error: { code: "provider_credential_test_failed" }, ok: false });
    await act(async () => first);
    expect(result.current.state.secret).toBe("one-key");
  });

  it("keeps snapshot GET and submit POST cancellation domains independent", async () => {
    const pendingGet = deferred<{ data: ReturnType<typeof snapshot>; ok: true }>();
    const pendingPost = deferred<{ error: { code: string }; ok: false }>();
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockReturnValueOnce(pendingGet.promise);
    api.submit.mockReturnValueOnce(pendingPost.promise);
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("one-key");
    });
    let submitRequest!: Promise<boolean>;
    let snapshotRequest!: Promise<boolean>;
    act(() => {
      submitRequest = result.current.actions.submit();
      snapshotRequest = result.current.actions.refresh();
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const postSignal = api.submit.mock.calls[0]?.[2] as AbortSignal;
    const getSignal = api.get.mock.calls[1]?.[1] as AbortSignal;
    expect(postSignal).not.toBe(getSignal);
    expect(postSignal.aborted).toBe(false);
    expect(getSignal.aborted).toBe(false);

    act(() => {
      result.current.actions.selectProvider("anthropic");
      result.current.actions.changeSecret("must-not-replace-pending-form");
    });
    expect(getSignal.aborted).toBe(false);
    expect(postSignal.aborted).toBe(false);
    expect(result.current.state.selectedProviderId).toBe("openai");
    expect(result.current.state.secret).toBe("one-key");

    pendingGet.resolve({ data: snapshot("state-refreshed"), ok: true });
    await act(async () => snapshotRequest);
    expect(result.current.state.submitting).toBe(true);
    expect(postSignal.aborted).toBe(false);
    pendingPost.resolve({ error: { code: "provider_credential_test_failed" }, ok: false });
    await act(async () => submitRequest);
    expect(result.current.state.secret).toBe("one-key");
  });

  it("settles a POST invalidated by a concurrent authoritative Ready snapshot", async () => {
    const pendingGet = deferred<{ data: ReturnType<typeof readySnapshot>; ok: true }>();
    const pendingPost = deferred<{ error: { code: string }; ok: false }>();
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockReturnValueOnce(pendingGet.promise);
    api.submit.mockReturnValueOnce(pendingPost.promise);
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("one-key");
    });
    let submitRequest!: Promise<boolean>;
    let snapshotRequest!: Promise<boolean>;
    act(() => {
      submitRequest = result.current.actions.submit();
      snapshotRequest = result.current.actions.refresh();
    });
    await waitFor(() => expect(result.current.state.submitting).toBe(true));
    const postSignal = api.submit.mock.calls[0]?.[2] as AbortSignal;

    pendingGet.resolve({ data: readySnapshot(), ok: true });
    await act(async () => snapshotRequest);
    expect(postSignal.aborted).toBe(false);
    expect(result.current.state.secret).toBe("");
    expect(result.current.state.selectedProvider?.state).toBe("ready");
    expect(result.current.state.submitting).toBe(true);

    pendingPost.resolve({ error: { code: "provider_credential_test_failed" }, ok: false });
    await act(async () => submitRequest);
    expect(result.current.state.submitting).toBe(false);
    expect(result.current.state.error).toBeNull();
  });

  it("keeps mandatory reconciliation alive, blocks replacement, and offers a real retry", async () => {
    const firstReconciliation = deferred<{ error: { code: string }; ok: false }>();
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockReturnValueOnce(firstReconciliation.promise)
      .mockResolvedValueOnce({ data: readySnapshot(), ok: true });
    api.submit.mockResolvedValueOnce({
      data: readyResult({ defaultChanged: false, profilesFilled: ["balanced", "fast"] }),
      ok: true
    });
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("one-key");
    });
    await act(async () => {
      await result.current.actions.submit();
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    const reconciliationSignal = api.get.mock.calls[1]?.[1] as AbortSignal;
    expect(result.current.state.reconciliationRequired).toBe(true);
    expect(result.current.state.formLocked).toBe(true);
    act(() => {
      result.current.actions.beginReplacement();
      result.current.actions.changeSecret("must-not-return");
      result.current.actions.selectProvider("anthropic");
    });
    expect(reconciliationSignal.aborted).toBe(false);
    expect(result.current.state.replacing).toBe(false);
    expect(result.current.state.secret).toBe("");
    expect(result.current.state.selectedProviderId).toBe("openai");

    firstReconciliation.resolve({ error: { code: "network_error" }, ok: false });
    await act(async () => firstReconciliation.promise);
    await waitFor(() => expect(result.current.state.loading).toBe(false));
    expect(result.current.state.reconciliationRequired).toBe(true);
    expect(result.current.state.refreshError).toBe("network_error");
    expect(result.current.state.readyResult?.model.displayName).toBe("GPT-5.6 Terra");
    expect(result.current.state.readyConfirmation).toMatchObject({
      defaultChanged: false,
      profilesFilled: ["balanced", "fast"]
    });
    act(() => result.current.actions.beginReplacement());
    expect(result.current.state.replacing).toBe(false);

    await act(async () => {
      await result.current.actions.refresh();
    });
    expect(result.current.state.reconciliationRequired).toBe(false);
    expect(result.current.state.refreshError).toBeNull();
    expect(result.current.state.readyResult).toBeNull();
    expect(result.current.state.selectedProvider?.state).toBe("ready");
    expect(result.current.state.secret).toBe("");
    expect(result.current.state.selection).toBeNull();
    expect(result.current.state.replacing).toBe(false);
    expect(result.current.state.readyConfirmation).toMatchObject({
      defaultChanged: false,
      profilesFilled: ["balanced", "fast"]
    });
  });

  it("clears an invalid model choice, ignores radio changes during POST, and retains the key", async () => {
    const selection = {
      candidates: [
        { candidateId: "p1-o2", displayName: "GPT-5.6 Luna" },
        { candidateId: "p1-o3", displayName: "GPT-5.6 Sol" }
      ],
      checkedAt: "2026-07-26T03:00:00.000Z",
      expectedState: "state-selection",
      outcome: "selection_required" as const,
      policyVersion: 1,
      provider: "openai" as const,
      providerDisplayName: "OpenAI"
    };
    const pending = deferred<{ error: { code: string }; ok: false }>();
    api.submit
      .mockResolvedValueOnce({ data: selection, ok: true })
      .mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("browser-key");
    });
    await act(async () => {
      await result.current.actions.submit();
    });
    act(() => result.current.actions.chooseModel("p1-o2"));
    let request!: Promise<boolean>;
    act(() => {
      request = result.current.actions.submit();
    });
    await waitFor(() => expect(result.current.state.submitting).toBe(true));
    act(() => result.current.actions.chooseModel("p1-o3"));
    expect(result.current.state.selectedCandidateId).toBe("p1-o2");
    expect(api.submit.mock.calls[1]?.[0]).toMatchObject({
      selectedModel: { candidateId: "p1-o2", policyVersion: 1 }
    });

    pending.resolve({ error: { code: "provider_quick_setup_selection_invalid" }, ok: false });
    await act(async () => request);
    expect(result.current.state.secret).toBe("browser-key");
    expect(result.current.state.selection).toBeNull();
    expect(result.current.state.selectedCandidateId).toBeNull();
    expect(result.current.state.errorCode).toBe("provider_quick_setup_selection_invalid");
  });

  it("clears a replacement form when a successful GET reports Ready", async () => {
    const pendingRefresh = deferred<{ data: ReturnType<typeof readySnapshot>; ok: true }>();
    api.get
      .mockResolvedValueOnce({ data: readySnapshot(), ok: true })
      .mockReturnValueOnce(pendingRefresh.promise);
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.selectedProvider?.state).toBe("ready"));
    act(() => {
      result.current.actions.beginReplacement();
      result.current.actions.changeSecret("replacement-key");
    });
    expect(result.current.state.replacing).toBe(true);
    let request!: Promise<boolean>;
    act(() => {
      request = result.current.actions.refresh();
    });
    await waitFor(() => expect(result.current.state.loading).toBe(true));
    pendingRefresh.resolve({ data: readySnapshot("state-new"), ok: true });
    await act(async () => request);

    expect(result.current.state.secret).toBe("");
    expect(result.current.state.selection).toBeNull();
    expect(result.current.state.selectedCandidateId).toBeNull();
    expect(result.current.state.replacing).toBe(false);
  });

  it("lets a successful server refresh invalidate an optimistic Ready result", async () => {
    api.get
      .mockResolvedValueOnce({ data: snapshot(), ok: true })
      .mockResolvedValueOnce({
        data: {
          ...snapshot("state-advanced"),
          providers: snapshot("state-advanced").providers.map((provider) =>
            provider.provider === "openai"
              ? { ...provider, state: "advanced_required" as const }
              : provider
          )
        },
        ok: true
      });
    api.submit.mockResolvedValueOnce({
      data: {
        checkedAt: "2026-07-26T03:00:00.000Z",
        defaultChanged: true,
        model: { displayName: "GPT-5.6 Terra" },
        outcome: "ready",
        profilesFilled: [],
        provider: "openai",
        providerDisplayName: "OpenAI"
      },
      ok: true
    });
    const { result } = renderHook(() => useAdminProviderQuickSetupController(true));
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("one-key");
    });
    await act(async () => {
      await result.current.actions.submit();
    });

    await waitFor(() => expect(result.current.state.selectedProvider?.state).toBe(
      "advanced_required"
    ));
    expect(result.current.state.readyResult).toBeNull();
    expect(result.current.state.readyConfirmation).toBeNull();
  });

  it("loads the initial projection after the Strict Mode effect probe", async () => {
    const { result } = renderHook(
      () => useAdminProviderQuickSetupController(true),
      { wrapper: StrictMode }
    );

    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    expect(api.get).toHaveBeenCalledOnce();
    expect(result.current.state.snapshot?.providers[0]?.stateToken).toBe("state-openai");
  });

  it("clears and aborts browser-only form state when the Quick surface becomes inactive", async () => {
    const pending = deferred<{
      data: {
        checkedAt: string;
        defaultChanged: boolean;
        model: { displayName: string };
        outcome: "ready";
        profilesFilled: never[];
        provider: "openai";
        providerDisplayName: string;
      };
      ok: true;
    }>();
    api.submit.mockReturnValueOnce(pending.promise);
    const onMutationCommitted = vi.fn();
    const { rerender, result } = renderHook(
      ({ active }) => useAdminProviderQuickSetupController(active, { onMutationCommitted }),
      { initialProps: { active: true } }
    );
    await waitFor(() => expect(result.current.state.loaded).toBe(true));
    act(() => {
      result.current.actions.selectProvider("openai");
      result.current.actions.changeSecret("browser-only-key");
    });
    act(() => {
      void result.current.actions.submit();
    });
    await waitFor(() => expect(result.current.state.submitting).toBe(true));
    const signal = api.submit.mock.calls[0]?.[2] as AbortSignal;

    rerender({ active: false });
    await waitFor(() => expect(signal.aborted).toBe(true));
    await waitFor(() => expect(result.current.state.secret).toBe(""));
    expect(result.current.state.selection).toBeNull();
    expect(result.current.state.replacing).toBe(false);
    expect(result.current.state.submitting).toBe(false);

    pending.resolve({
      data: {
        checkedAt: "2026-07-26T03:00:00.000Z",
        defaultChanged: true,
        model: { displayName: "GPT-5.6 Terra" },
        outcome: "ready",
        profilesFilled: [],
        provider: "openai",
        providerDisplayName: "OpenAI"
      },
      ok: true
    });
    await act(async () => pending.promise);
    expect(result.current.state.readyResult).toBeNull();
    expect(onMutationCommitted).not.toHaveBeenCalled();
  });
});
