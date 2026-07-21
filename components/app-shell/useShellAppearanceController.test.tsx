import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AIQSA_DETAILS_MODE_STORAGE_KEY } from "./shellStorage";
import { AIQSA_THEME_COOKIE_NAME, AIQSA_THEME_STORAGE_KEY } from "./theme";
import {
  detailsPinningMediaQuery,
  useShellAppearanceController
} from "./useShellAppearanceController";

function installMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    addEventListener: vi.fn(
      (type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.add(listener);
      }
    ),
    matches: initialMatches,
    media: detailsPinningMediaQuery,
    removeEventListener: vi.fn(
      (type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === "change") listeners.delete(listener);
      }
    )
  };
  const matchMedia = vi.fn(() => media as unknown as MediaQueryList);
  vi.stubGlobal("matchMedia", matchMedia);

  return {
    listenerCount: () => listeners.size,
    matchMedia,
    media,
    setMatches(matches: boolean) {
      media.matches = matches;
      const event = { matches, media: detailsPinningMediaQuery } as MediaQueryListEvent;
      for (const listener of [...listeners]) listener(event);
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.cookie = `${AIQSA_THEME_COOKIE_NAME}=; max-age=0; path=/`;
  delete document.documentElement.dataset.colorScheme;
  delete document.documentElement.dataset.theme;
});

describe("shell appearance controller", () => {
  it("applies the stored theme immediately and restores pinned Details after viewport setup", () => {
    vi.useFakeTimers();
    window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, "neutral");
    window.localStorage.setItem(AIQSA_DETAILS_MODE_STORAGE_KEY, "pinned");
    const viewport = installMatchMedia(true);

    const { result } = renderHook(() => useShellAppearanceController());

    expect(viewport.matchMedia).toHaveBeenCalledWith(detailsPinningMediaQuery);
    expect(result.current.theme.id).toBe("neutral");
    expect(document.documentElement.dataset.theme).toBe("neutral");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
    expect(result.current.details).toMatchObject({
      activeTab: "branch",
      mode: "closed",
      pinningAvailable: false
    });

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(result.current.details).toMatchObject({
      activeTab: "branch",
      mode: "pinned",
      pinningAvailable: true
    });
  });

  it("persists only manual Details changes and applies manual theme changes", () => {
    vi.useFakeTimers();
    installMatchMedia(true);
    const { result } = renderHook(() => useShellAppearanceController());
    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      result.current.details.changeActiveTab("events");
      result.current.details.changeMode((mode) => (mode === "closed" ? "overlay" : mode));
    });

    expect(result.current.details.activeTab).toBe("events");
    expect(result.current.details.mode).toBe("overlay");
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe("closed");

    act(() => {
      result.current.details.changeMode("pinned");
      result.current.theme.change("classic-dark");
    });

    expect(result.current.details.mode).toBe("pinned");
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe("pinned");
    expect(result.current.theme.id).toBe("classic-dark");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("classic-dark");
    expect(document.cookie).toContain(`${AIQSA_THEME_COOKIE_NAME}=classic-dark`);
    expect(document.documentElement.dataset.theme).toBe("classic-dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
  });

  it("downgrades pinned Details on a narrow viewport without erasing the stored preference", () => {
    vi.useFakeTimers();
    window.localStorage.setItem(AIQSA_DETAILS_MODE_STORAGE_KEY, "pinned");
    const viewport = installMatchMedia(true);
    const { result } = renderHook(() => useShellAppearanceController());
    act(() => {
      vi.runOnlyPendingTimers();
    });

    act(() => {
      viewport.setMatches(false);
    });

    expect(result.current.details.mode).toBe("overlay");
    expect(result.current.details.pinningAvailable).toBe(false);
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe("pinned");

    act(() => {
      viewport.setMatches(true);
    });

    expect(result.current.details.mode).toBe("overlay");
    expect(result.current.details.pinningAvailable).toBe(true);
    expect(window.localStorage.getItem(AIQSA_DETAILS_MODE_STORAGE_KEY)).toBe("pinned");
  });

  it("clears deferred initialization and removes the exact viewport listener on cleanup", () => {
    vi.useFakeTimers();
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const viewport = installMatchMedia(true);
    const { unmount } = renderHook(() => useShellAppearanceController());

    expect(viewport.listenerCount()).toBe(1);
    unmount();

    expect(clearTimeout).toHaveBeenCalledTimes(1);
    expect(viewport.media.removeEventListener).toHaveBeenCalledTimes(1);
    expect(viewport.media.removeEventListener.mock.calls[0]?.[0]).toBe("change");
    expect(viewport.media.removeEventListener.mock.calls[0]?.[1]).toBe(
      viewport.media.addEventListener.mock.calls[0]?.[1]
    );
    expect(viewport.listenerCount()).toBe(0);
  });
});
