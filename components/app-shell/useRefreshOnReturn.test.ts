import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRefreshOnReturn } from "./useRefreshOnReturn";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}

describe("useRefreshOnReturn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T10:00:00.000Z"));
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("reads again on focus or visibility at most once per interval, never while hidden", () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useRefreshOnReturn(refresh, 30_000));

    // Mounting counts as a read: an immediate return does not read again.
    window.dispatchEvent(new Event("focus"));
    expect(refresh).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-10-20T10:00:31.000Z"));
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledOnce();

    vi.setSystemTime(new Date("2026-10-20T10:01:10.000Z"));
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledOnce();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(2);

    unmount();
    vi.setSystemTime(new Date("2026-10-20T10:05:00.000Z"));
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
