import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatWorkspaceState } from "@/lib/contracts/workspace";
import { loadWorkspaceAvailability } from "./workspaceClient";
import {
  useWorkspaceInstallationAvailability,
  WORKSPACE_AVAILABILITY_RETRY_DELAYS_MS
} from "./useWorkspaceInstallationAvailability";

vi.mock("./workspaceClient", () => ({ loadWorkspaceAvailability: vi.fn() }));

const available: ChatWorkspaceState = { available: true, enabled: true, internetEnabled: true, sessionState: null };
const disabled: ChatWorkspaceState = {
  available: false, enabled: false, internetEnabled: null, sessionState: null, unavailableReason: "installation_disabled"
};

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(loadWorkspaceAvailability).mockReset();
  setVisibility("visible");
});

describe("installation Workspace availability", () => {
  it("is unknown until a read succeeds and off only when a successful read reports it", async () => {
    vi.useFakeTimers();
    vi.mocked(loadWorkspaceAvailability)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(disabled);
    const hook = renderHook(() => useWorkspaceInstallationAvailability("account-a"));
    await act(async () => {});

    expect(hook.result.current.resolve()).toBe("unknown");
    expect(hook.result.current.installation).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_AVAILABILITY_RETRY_DELAYS_MS[0]); });

    expect(hook.result.current.resolve()).toBe("off");
    expect(hook.result.current.installation).toEqual(disabled);
    hook.unmount();
  });

  it("keeps the last confirmed value when a later read fails", async () => {
    vi.useFakeTimers();
    vi.mocked(loadWorkspaceAvailability)
      .mockResolvedValueOnce(available)
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const hook = renderHook(() => useWorkspaceInstallationAvailability("account-a"));
    await act(async () => {});
    expect(hook.result.current.resolve()).toBe("available");

    await act(async () => { hook.result.current.read(); });

    expect(hook.result.current.resolve()).toBe("available");
    expect(hook.result.current.installation).toEqual(available);
    hook.unmount();
  });

  it("retries a failed read a bounded number of times with growing delays", async () => {
    vi.useFakeTimers();
    vi.mocked(loadWorkspaceAvailability).mockRejectedValue(new TypeError("Failed to fetch"));
    const hook = renderHook(() => useWorkspaceInstallationAvailability("account-a"));
    await act(async () => {});
    expect(loadWorkspaceAvailability).toHaveBeenCalledTimes(1);

    for (const [index, delay] of WORKSPACE_AVAILABILITY_RETRY_DELAYS_MS.entries()) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
      expect(loadWorkspaceAvailability).toHaveBeenCalledTimes(index + 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(loadWorkspaceAvailability).toHaveBeenCalledTimes(index + 2);
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });

    expect(loadWorkspaceAvailability).toHaveBeenCalledTimes(WORKSPACE_AVAILABILITY_RETRY_DELAYS_MS.length + 1);
    expect(hook.result.current.resolve()).toBe("unknown");
    hook.unmount();
  });

  it("stops retrying while the tab is hidden and after unmount", async () => {
    vi.useFakeTimers();
    vi.mocked(loadWorkspaceAvailability).mockRejectedValue(new TypeError("Failed to fetch"));
    const hidden = renderHook(() => useWorkspaceInstallationAvailability("account-a"));
    await act(async () => {});
    setVisibility("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(loadWorkspaceAvailability).toHaveBeenCalledTimes(1);
    hidden.unmount();

    setVisibility("visible");
    vi.mocked(loadWorkspaceAvailability).mockClear();
    const unmounted = renderHook(() => useWorkspaceInstallationAvailability("account-a"));
    await act(async () => {});
    unmounted.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(loadWorkspaceAvailability).toHaveBeenCalledTimes(1);
  });

  it("lets the latest read win over an older one that settles later", async () => {
    let settleOld!: (value: ChatWorkspaceState) => void;
    vi.mocked(loadWorkspaceAvailability)
      .mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve; }))
      .mockResolvedValueOnce(available);
    const hook = renderHook(() => useWorkspaceInstallationAvailability("account-a"));
    await act(async () => { hook.result.current.read(); });
    expect(hook.result.current.resolve()).toBe("available");

    await act(async () => { settleOld(disabled); });

    expect(hook.result.current.resolve()).toBe("available");
    hook.unmount();
  });
});
