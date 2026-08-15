export const AIQSA_THEME_STORAGE_KEY = "aiqsa.theme";
export const AIQSA_THEME_COOKIE_NAME = "aiqsa.theme";

export type ThemeId = "dark" | "light" | "system";
export type ThemeColorScheme = "dark" | "light";

export type ThemeOption = {
  colorScheme: ThemeColorScheme | "system";
  description: string;
  id: ThemeId;
  name: string;
};

export const DEFAULT_THEME_ID: ThemeId = "system";

export const AIQSA_THEMES: ThemeOption[] = [
  {
    colorScheme: "system",
    description: "Follow this device",
    id: "system",
    name: "System"
  },
  {
    colorScheme: "light",
    description: "Warm paper reading room",
    id: "light",
    name: "Light"
  },
  {
    colorScheme: "dark",
    description: "Warm graphite reading room",
    id: "dark",
    name: "Dark"
  }
];

const THEME_IDS = new Set<ThemeId>(AIQSA_THEMES.map((theme) => theme.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value as ThemeId);
}

export function resolveThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}

function browserPrefersDark(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveThemeColorScheme(
  value: unknown,
  systemPrefersDark = false
): ThemeColorScheme {
  const themeId = resolveThemeId(value);
  if (themeId === "system") return systemPrefersDark ? "dark" : "light";
  return themeId;
}

function persistNormalizedTheme(themeId: ThemeId) {
  window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, themeId);
  document.cookie = `${AIQSA_THEME_COOKIE_NAME}=${themeId}; max-age=31536000; path=/; samesite=lax`;
}

export function storedThemeId(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME_ID;

  const localValue = window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY);
  const serverValue = document.documentElement.dataset.theme;
  const sourceValue = localValue === null ? serverValue : localValue;
  const themeId = resolveThemeId(sourceValue);

  if (localValue !== themeId || serverValue !== themeId) {
    persistNormalizedTheme(themeId);
  }
  return themeId;
}

export function applyThemeId(themeId: ThemeId, root: HTMLElement | null = null) {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!target) return;

  target.dataset.theme = themeId;
  target.dataset.colorScheme = resolveThemeColorScheme(themeId, browserPrefersDark());
}

export function rememberThemeId(themeId: ThemeId) {
  if (typeof window === "undefined") return;
  persistNormalizedTheme(themeId);
}

export function applyAndRememberThemeId(value: unknown): ThemeId {
  const themeId = resolveThemeId(value);
  rememberThemeId(themeId);
  applyThemeId(themeId);
  return themeId;
}
