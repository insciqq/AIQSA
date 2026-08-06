export const AIQSA_THEME_STORAGE_KEY = "aiqsa.theme";
export const AIQSA_THEME_COOKIE_NAME = "aiqsa.theme";

export type ThemeId = "aiqsa" | "classic-dark" | "graphite" | "neutral" | "paper" | "verdant";
export type ThemeColorScheme = "dark" | "light";

export type ThemeOption = {
  accentLabel: string;
  colorScheme: ThemeColorScheme;
  description: string;
  id: ThemeId;
  name: string;
};

export const DEFAULT_THEME_ID: ThemeId = "neutral";

export const AIQSA_THEMES: ThemeOption[] = [
  {
    accentLabel: "Teal",
    colorScheme: "dark",
    description: "Warm dark palette",
    id: "aiqsa",
    name: "AIQSA"
  },
  {
    accentLabel: "Blue steel",
    colorScheme: "dark",
    description: "Cool dark palette",
    id: "graphite",
    name: "Graphite"
  },
  {
    accentLabel: "Mint",
    colorScheme: "dark",
    description: "Green-black palette",
    id: "verdant",
    name: "Verdant"
  },
  {
    accentLabel: "Blue",
    colorScheme: "dark",
    description: "Charcoal dark palette",
    id: "classic-dark",
    name: "Classic Dark"
  },
  {
    accentLabel: "Teal",
    colorScheme: "light",
    description: "Quiet neutral light palette",
    id: "neutral",
    name: "Classic Light"
  },
  {
    accentLabel: "Graphite",
    colorScheme: "light",
    description: "Soft monochrome palette",
    id: "paper",
    name: "Paper"
  }
];

const THEME_IDS = new Set<ThemeId>(AIQSA_THEMES.map((theme) => theme.id));

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && THEME_IDS.has(value as ThemeId);
}

export function resolveThemeId(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME_ID;
}

export function resolveThemeOption(value: unknown): ThemeOption {
  const themeId = resolveThemeId(value);
  return AIQSA_THEMES.find((theme) => theme.id === themeId) ?? AIQSA_THEMES[0];
}

export function resolveThemeColorScheme(value: unknown): ThemeColorScheme {
  return resolveThemeOption(value).colorScheme;
}

export function storedThemeId(): ThemeId {
  if (typeof window === "undefined") {
    return DEFAULT_THEME_ID;
  }

  const localThemeId = window.localStorage.getItem(AIQSA_THEME_STORAGE_KEY);
  const serverThemeId = document.documentElement.dataset.theme;

  if (isThemeId(localThemeId)) {
    if (serverThemeId !== localThemeId) {
      document.cookie = `${AIQSA_THEME_COOKIE_NAME}=${localThemeId}; max-age=31536000; path=/; samesite=lax`;
    }
    return localThemeId;
  }

  if (isThemeId(serverThemeId)) {
    if (localThemeId !== null) {
      window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, serverThemeId);
    }
    return serverThemeId;
  }

  return DEFAULT_THEME_ID;
}

export function applyThemeId(themeId: ThemeId, root: HTMLElement | null = null) {
  const target = root ?? (typeof document === "undefined" ? null : document.documentElement);
  if (!target) {
    return;
  }

  target.dataset.theme = themeId;
  target.dataset.colorScheme = resolveThemeColorScheme(themeId);
}

export function rememberThemeId(themeId: ThemeId) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(AIQSA_THEME_STORAGE_KEY, themeId);
  document.cookie = `${AIQSA_THEME_COOKIE_NAME}=${themeId}; max-age=31536000; path=/; samesite=lax`;
}

export function applyAndRememberThemeId(value: unknown): ThemeId {
  const themeId = resolveThemeId(value);

  rememberThemeId(themeId);
  applyThemeId(themeId);

  return themeId;
}
