import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shellFetch } from "./shellApi";
import { useChatPdfRoutePreview } from "./useChatPdfRoutePreview";

vi.mock("./shellApi", () => ({ shellFetch: vi.fn() }));
const target = { projectId: null, providerConnectionId: "connection", providerModelId: "A" };

afterEach(() => { vi.useRealTimers(); vi.mocked(shellFetch).mockReset(); });

describe("server-owned PDF route preview", () => {
  it("ignores an old model response after the selection changes", async () => {
    let settleOld!: (response: Response) => void;
    vi.mocked(shellFetch).mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve; }))
      .mockResolvedValueOnce(Response.json({ version: 1, route: "local_text" }));
    const hook = renderHook(({ model }) => useChatPdfRoutePreview({ ...target, providerModelId: model }), { initialProps: { model: "A" } });
    await act(async () => { hook.rerender({ model: "B" }); });
    expect(hook.result.current).toEqual({ available: true, route: "local_text" });
    await act(async () => { settleOld(Response.json({ version: 1, route: "system_vision" })); });
    expect(hook.result.current).toEqual({ available: true, route: "local_text" });
    hook.unmount();
  });

  it("refreshes policy/evidence for the same target and stops when no PDF is selected", async () => {
    vi.useFakeTimers();
    vi.mocked(shellFetch).mockResolvedValueOnce(Response.json({ version: 1, route: "local_text" }))
      .mockResolvedValueOnce(Response.json({ version: 1, route: "selected_model_vision" }));
    const hook = renderHook(({ enabled }) => useChatPdfRoutePreview(enabled ? target : null), { initialProps: { enabled: true } });
    await act(async () => {});
    expect(hook.result.current).toEqual({ available: true, route: "local_text" });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(hook.result.current).toEqual({ available: true, route: "selected_model_vision" });
    hook.rerender({ enabled: false });
    expect(hook.result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(shellFetch).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("reports a definite missing route and re-evaluates it after the policy changes", async () => {
    vi.useFakeTimers();
    vi.mocked(shellFetch)
      .mockResolvedValueOnce(Response.json({ error: "pdf_processing_configuration_incomplete" }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({ version: 1, route: "system_vision" }));
    const hook = renderHook(() => useChatPdfRoutePreview(target));
    await act(async () => {});
    expect(hook.result.current).toEqual({ available: false, reasonCode: "pdf_processing_configuration_incomplete" });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(hook.result.current).toEqual({ available: true, route: "system_vision" });
    hook.unmount();
  });

  it("treats other refusals and transport failures as unknown, never as unavailable", async () => {
    vi.mocked(shellFetch)
      .mockResolvedValueOnce(Response.json({ error: "model_not_available" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: "invalid_request" }, { status: 422 }))
      .mockRejectedValueOnce(new Error("offline"));
    for (const model of ["A", "B", "C"]) {
      const hook = renderHook(() => useChatPdfRoutePreview({ ...target, providerModelId: model }));
      await act(async () => {});
      expect(hook.result.current).toBeNull();
      hook.unmount();
    }
    expect(shellFetch).toHaveBeenCalledTimes(3);
  });
});
