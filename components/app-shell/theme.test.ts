import { afterEach, describe, expect, it } from "vitest";
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
    window.localStorage.removeItem(AIQSA_THEME_STORAGE_KEY);
    document.cookie = `${AIQSA_THEME_COOKIE_NAME}=; max-age=0; path=/`;
    delete document.documentElement.dataset.colorScheme;
    delete document.documentElement.dataset.theme;
  });

  it("validates stored theme ids with the default as fallback", () => {
    expect(DEFAULT_THEME_ID).toBe("neutral");
    expect(AIQSA_THEMES.find((theme) => theme.id === "neutral")).toEqual(
      expect.objectContaining({
        accentLabel: "Teal",
        colorScheme: "light",
        description: "Quiet neutral light palette",
        name: "Classic Light"
      })
    );
    expect(AIQSA_THEMES.find((theme) => theme.id === "classic-dark")).toEqual(
      expect.objectContaining({
        colorScheme: "dark",
        description: "Charcoal dark palette",
        name: "Classic Dark"
      })
    );
    expect(AIQSA_THEMES.map((theme) => theme.id)).toEqual([
      "aiqsa",
      "graphite",
      "verdant",
      "classic-dark",
      "neutral",
      "paper"
    ]);
    expect(AIQSA_THEMES.find((theme) => theme.id === "paper")).toEqual(
      expect.objectContaining({
        accentLabel: "Graphite",
        colorScheme: "light",
        description: "Soft monochrome palette",
        name: "Paper"
      })
    );
    expect(resolveThemeId("classic-dark")).toBe("classic-dark");
    expect(resolveThemeId("graphite")).toBe("graphite");
    expect(resolveThemeId("neutral")).toBe("neutral");
    expect(resolveThemeId("paper")).toBe("paper");
    expect(resolveThemeId("unknown")).toBe(DEFAULT_THEME_ID);
    expect(resolveThemeColorScheme(DEFAULT_THEME_ID)).toBe("light");
    expect(resolveThemeColorScheme("classic-dark")).toBe("dark");
    expect(resolveThemeColorScheme("neutral")).toBe("light");
    expect(resolveThemeColorScheme("paper")).toBe("light");
    expect(resolveThemeColorScheme("unknown")).toBe("light");
  });

  it("stores and applies the selected theme locally", () => {
    expect(storedThemeId()).toBe(DEFAULT_THEME_ID);

    const applied = applyAndRememberThemeId("neutral");

    expect(applied).toBe("neutral");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("neutral");
    expect(document.cookie).toContain(`${AIQSA_THEME_COOKIE_NAME}=neutral`);
    expect(document.documentElement.dataset.theme).toBe("neutral");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
  });

  it("falls back to the valid server-rendered theme when local storage is malformed", () => {
    window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, "not-a-theme");
    document.documentElement.dataset.theme = "paper";
    document.documentElement.dataset.colorScheme = "light";

    expect(storedThemeId()).toBe("paper");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("paper");
    expect(document.documentElement.dataset.theme).toBe("paper");
  });

  it("keeps a valid local preference authoritative and repairs a stale first-paint cookie", () => {
    window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, "paper");
    document.documentElement.dataset.theme = "classic-dark";
    document.documentElement.dataset.colorScheme = "dark";

    expect(storedThemeId()).toBe("paper");
    expect(document.cookie).toContain(`${AIQSA_THEME_COOKIE_NAME}=paper`);
  });

  it("persists Classic Dark with its dark browser scheme", () => {
    const applied = applyAndRememberThemeId("classic-dark");

    expect(applied).toBe("classic-dark");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe(
      "classic-dark"
    );
    expect(document.cookie).toContain(
      `${AIQSA_THEME_COOKIE_NAME}=classic-dark`
    );
    expect(document.documentElement.dataset.theme).toBe("classic-dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
  });

  it("can apply a validated theme without writing localStorage", () => {
    applyThemeId("classic-dark");

    expect(document.documentElement.dataset.theme).toBe("classic-dark");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBeNull();
  });

  it("persists Paper as an additional light palette", () => {
    const applied = applyAndRememberThemeId("paper");

    expect(applied).toBe("paper");
    expect(window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY)).toBe("paper");
    expect(document.cookie).toContain(`${AIQSA_THEME_COOKIE_NAME}=paper`);
    expect(document.documentElement.dataset.theme).toBe("paper");
    expect(document.documentElement.dataset.colorScheme).toBe("light");
  });
});
