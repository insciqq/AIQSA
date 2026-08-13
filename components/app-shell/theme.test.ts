import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIQSA_THEMES,
  AIQSA_THEME_COOKIE_NAME,
  AIQSA_THEME_STORAGE_KEY,
  applyAndRememberThemeId,
  applyThemeId,
  DEFAULT_THEME_ID,
  resolveThemeColorScheme,
  resolveThemeId,
  storedThemeId
} from "./theme";

describe("theme preferences", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.removeItem(AIQSA_THEME_STORAGE_KEY);
    document.cookie = `${AIQSA_THEME_COOKIE_NAME}=; max-age=0; path=/`;
    delete document.documentElement.dataset.colorScheme;
    delete document.documentElement.dataset.theme;
  });

  it("exposes only System, Light, and Dark", () => {
    expect(DEFAULT_THEME_ID).toBe("system");
    expect(AIQSA_THEMES.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "system", name: "System" },
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" }
    ]);
  });

  it.each([
    ["aiqsa", "dark"],
    ["graphite", "dark"],
    ["verdant", "dark"],
    ["classic-dark", "dark"],
    ["neutral", "light"],
    ["paper", "light"],
    ["dark", "dark"],
    ["light", "light"],
    ["system", "system"],
    ["unknown", "system"],
    [undefined, "system"]
  ] as const)("normalizes %s to %s", (value, expected) => {
    expect(resolveThemeId(value)).toBe(expected);
  });

  it("resolves System against the supplied browser preference", () => {
    expect(resolveThemeColorScheme("system")).toBe("light");
    expect(resolveThemeColorScheme("system", true)).toBe("dark");
    expect(resolveThemeColorScheme("dark")).toBe("dark");
    expect(resolveThemeColorScheme("light", true)).toBe("light");
  });

  it("migrates a valid legacy local preference and repairs first-paint storage", () => {
    window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, "classic-dark");
    document.documentElement.dataset.theme = "light";
    document.documentElement.dataset.colorScheme = "light";

    expect(storedThemeId()).toBe("dark");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("dark");
    expect(document.cookie).toContain(`${AIQSA_THEME_COOKIE_NAME}=dark`);
  });

  it("uses the normalized server value when local state is absent", () => {
    document.documentElement.dataset.theme = "paper";
    document.documentElement.dataset.colorScheme = "light";

    expect(storedThemeId()).toBe("light");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("light");
  });

  it("normalizes malformed local state to System idempotently", () => {
    window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, "not-a-theme");
    document.documentElement.dataset.theme = "dark";

    expect(storedThemeId()).toBe("system");
    expect(storedThemeId()).toBe("system");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("system");
  });

  it("stores and applies an explicit selection", () => {
    expect(applyAndRememberThemeId("neutral")).toBe("light");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
  });

  it("applies System using the live media preference without persisting", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true
    } as MediaQueryList)));

    applyThemeId("system");

    expect(document.documentElement.dataset.theme).toBe("system");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBeNull();
  });
});
