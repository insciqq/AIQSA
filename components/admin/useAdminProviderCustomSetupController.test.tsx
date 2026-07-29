import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAdminProviderCustomSetupController } from "./useAdminProviderCustomSetupController";

const api = vi.hoisted(() => ({ discover: vi.fn(), submit: vi.fn() }));

vi.mock("./adminProviderCustomSetupApi", () => ({
  adminProviderCustomSetupErrorMessage: (error: { code: string }) => error.code,
  discoverAdminProviderCustomModels: api.discover,
  submitAdminProviderCustomSetup: api.submit
}));

const ready = {
  authenticationMode: "bearer" as const,
  checkedAt: "2026-07-26T10:00:00.000Z",
  connectionDisplayName: "Custom provider",
  connectionId: "connection-1",
  defaultChanged: true,
  modelDisplayName: "Model 1",
  models: [{ modelDisplayName: "Model 1", providerModelId: "model-1" }],
  outcome: "ready" as const,
  providerModelId: "model-1"
};

function fillRequired(
  result: ReturnType<typeof renderHook<
    ReturnType<typeof useAdminProviderCustomSetupController>,
    unknown
  >>["result"],
  overrides: Record<string, unknown> = {}
) {
  act(() => result.current.actions.update({
    apiRoot: "https://llm.example.test/v1",
    modelId: "vendor/model-1",
    secret: "browser-only-key",
    ...overrides
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("useAdminProviderCustomSetupController", () => {
  beforeEach(() => {
    api.discover.mockReset();
    api.submit.mockReset();
  });

  it("submits one explicit bearer setup and clears the write-only key on Ready", async () => {
    api.submit.mockResolvedValue({ data: ready, ok: true });
    const onMutationCommitted = vi.fn();
    const { result } = renderHook(() => useAdminProviderCustomSetupController(true, {
      onMutationCommitted
    }));
    fillRequired(result);

    await act(async () => {
      await result.current.actions.submit();
    });

    expect(api.submit).toHaveBeenCalledOnce();
    expect(api.submit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      allowPrivateNetwork: false,
      apiRoot: "https://llm.example.test/v1",
      authenticationMode: "bearer",
      confirmPaidRequest: true,
      modelId: "vendor/model-1",
      secret: "browser-only-key"
    }));
    expect(api.submit.mock.calls[0]?.[0].capabilities).toMatchObject({
      contextWindow: 8_192,
      defaultMaxOutputTokens: 1_024,
      streaming: true,
      toolCalling: false
    });
    expect(result.current.state.form.secret).toBe("");
    expect(result.current.state.ready).toEqual(ready);
    await waitFor(() => expect(onMutationCommitted).toHaveBeenCalledOnce());
  });

  it("uses explicit none only for an allowed private HTTP endpoint", async () => {
    api.submit.mockResolvedValue({
      data: { ...ready, authenticationMode: "none" as const },
      ok: true
    });
    const { result } = renderHook(() => useAdminProviderCustomSetupController(true));
    fillRequired(result, {
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      modelId: "local-model",
      secret: ""
    });

    await act(async () => {
      await result.current.actions.submit();
    });

    expect(api.submit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      allowPrivateNetwork: true,
      apiRoot: "http://127.0.0.1:11434/v1",
      authenticationMode: "none",
      modelId: "local-model"
    }));
    expect(api.submit.mock.calls[0]?.[0]).not.toHaveProperty("secret");
  });

  it("submits every explicitly selected discovered model in selection order", async () => {
    api.discover.mockResolvedValue({
      data: {
        checkedAt: "2026-07-26T10:00:00.000Z",
        modelCount: 2,
        models: [
          { capabilities: {}, id: "vendor/a" },
          { capabilities: {}, id: "vendor/b" }
        ],
        source: "models_catalog",
        status: "valid"
      },
      ok: true
    });
    api.submit.mockResolvedValue({
      data: {
        ...ready,
        models: [
          { modelDisplayName: "vendor/b", providerModelId: "model-b" },
          { modelDisplayName: "vendor/a", providerModelId: "model-a" }
        ]
      },
      ok: true
    });
    const { result } = renderHook(() => useAdminProviderCustomSetupController(true));
    act(() => result.current.actions.update({
      apiRoot: "https://llm.example.test/v1",
      secret: "browser-only-key"
    }));

    await act(async () => {
      await result.current.actions.discoverModels();
    });
    act(() => {
      result.current.actions.selectDiscoveredModel("vendor/b");
      result.current.actions.selectDiscoveredModel("vendor/a");
    });
    await act(async () => {
      await result.current.actions.submit();
    });

    expect(api.submit.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      capabilities: expect.objectContaining({
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        reasoning: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        reasoningModes: ["standard", "pro"]
      }),
      modelIds: ["vendor/b", "vendor/a"]
    }));
    expect(api.submit.mock.calls[0]?.[0]).not.toHaveProperty("modelId");
  });

  it("blocks keyless public setup before any request", async () => {
    const { result } = renderHook(() => useAdminProviderCustomSetupController(true));
    fillRequired(result, { secret: "" });

    await act(async () => {
      await expect(result.current.actions.submit()).resolves.toBe(false);
    });

    expect(api.submit).not.toHaveBeenCalled();
    expect(result.current.state.errorCode).toBe("provider_configuration_invalid");
  });

  it("locks the form, rejects duplicate submits, and retains the key after failure", async () => {
    const pending = deferred<{ error: { code: string }; ok: false }>();
    api.submit.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useAdminProviderCustomSetupController(true));
    fillRequired(result);
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.actions.submit();
      second = result.current.actions.submit();
    });
    await waitFor(() => expect(result.current.state.formLocked).toBe(true));
    act(() => result.current.actions.update({ secret: "must-not-replace" }));

    await expect(second).resolves.toBe(false);
    expect(api.submit).toHaveBeenCalledOnce();
    pending.resolve({ error: { code: "provider_custom_setup_test_failed" }, ok: false });
    await act(async () => first);
    expect(result.current.state.form.secret).toBe("browser-only-key");
    expect(result.current.state.errorCode).toBe("provider_custom_setup_test_failed");
  });

  it("cancels and clears sensitive draft state when the surface becomes inactive", async () => {
    const pending = deferred<{ error: { code: string }; ok: false }>();
    api.submit.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ active }) => useAdminProviderCustomSetupController(active),
      { initialProps: { active: true } }
    );
    fillRequired(result);
    act(() => {
      void result.current.actions.submit();
    });
    await waitFor(() => expect(result.current.state.submitting).toBe(true));
    const signal = api.submit.mock.calls[0]?.[2] as AbortSignal;

    rerender({ active: false });
    await waitFor(() => expect(result.current.state.form.secret).toBe(""));
    expect(signal.aborted).toBe(true);
    expect(result.current.state.ready).toBeNull();
    pending.resolve({ error: { code: "request_aborted" }, ok: false });
  });
});
