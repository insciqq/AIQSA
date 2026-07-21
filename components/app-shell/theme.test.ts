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
    expect(DEFAULT_THEME_ID).toBe("aiqsa");
    expect(AIQSA_THEMES.find((theme) => theme.id === "neutral")).toEqual(
      expect.objectContaining({
        colorScheme: "light",
        description: "Neutral gray and white palette",
        name: "Classic Light"
      })
    );
    expect(AIQSA_THEMES.find((theme) => theme.id === "classic-dark")).toEqual(
      expect.objectContaining({
        colorScheme: "dark",
        description: "Neutral charcoal palette",
        name: "Classic Dark"
      })
    );
    expect(AIQSA_THEMES).toHaveLength(5);
    expect(resolveThemeId("classic-dark")).toBe("classic-dark");
    expect(resolveThemeId("graphite")).toBe("graphite");
    expect(resolveThemeId("neutral")).toBe("neutral");
    expect(resolveThemeId("unknown")).toBe(DEFAULT_THEME_ID);
    expect(resolveThemeColorScheme(DEFAULT_THEME_ID)).toBe("dark");
    expect(resolveThemeColorScheme("classic-dark")).toBe("dark");
    expect(resolveThemeColorScheme("neutral")).toBe("light");
    expect(resolveThemeColorScheme("unknown")).toBe("dark");
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
});
