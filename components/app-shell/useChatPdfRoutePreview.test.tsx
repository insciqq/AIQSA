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
    expect(hook.result.current).toBe("local_text");
    await act(async () => { settleOld(Response.json({ version: 1, route: "system_vision" })); });
    expect(hook.result.current).toBe("local_text");
    hook.unmount();
  });

  it("refreshes policy/evidence for the same target and stops when no PDF is selected", async () => {
    vi.useFakeTimers();
    vi.mocked(shellFetch).mockResolvedValueOnce(Response.json({ version: 1, route: "local_text" }))
      .mockResolvedValueOnce(Response.json({ version: 1, route: "selected_model_vision" }));
    const hook = renderHook(({ enabled }) => useChatPdfRoutePreview(enabled ? target : null), { initialProps: { enabled: true } });
    await act(async () => {});
    expect(hook.result.current).toBe("local_text");
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(hook.result.current).toBe("selected_model_vision");
    hook.rerender({ enabled: false });
    expect(hook.result.current).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(shellFetch).toHaveBeenCalledTimes(2);
    hook.unmount();
  });
});
