import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AIQSA_THEME_COOKIE_NAME, AIQSA_THEME_STORAGE_KEY } from "./theme";
import { useShellAppearanceController } from "./useShellAppearanceController";

function installMatchMedia() {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    matches: query.includes("dark"),
    media: query,
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener)
  } as unknown as MediaQueryList)));
  return listeners;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  document.cookie = `${AIQSA_THEME_COOKIE_NAME}=; max-age=0; path=/`;
  delete document.documentElement.dataset.colorScheme;
  delete document.documentElement.dataset.theme;
});

describe("shell appearance controller", () => {
  it("applies and remembers the selected theme", () => {
    window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, "light");
    installMatchMedia();
    const { result } = renderHook(() => useShellAppearanceController());

    expect(result.current.theme.id).toBe("light");
    act(() => {
      result.current.theme.change("dark");
    });
    expect(Object.keys(result.current)).toEqual(["theme"]);
    expect(result.current.theme.id).toBe("dark");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("dark");
    expect(document.cookie).toContain(`${AIQSA_THEME_COOKIE_NAME}=dark`);
  });

  it("subscribes only while System theme is active", () => {
    const listeners = installMatchMedia();
    window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, "system");
    const { result, unmount } = renderHook(() => useShellAppearanceController());
    expect(listeners.size).toBe(1);
    act(() => result.current.theme.change("light"));
    expect(listeners.size).toBe(0);
    unmount();
  });
});
