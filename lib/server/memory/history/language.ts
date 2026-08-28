export type MemoryTextLanguage = string;

export type MemoryQualificationLanguageBucket =
  | "en"
  | "mixed"
  | "other"
  | "ru"
  | "und";

const languageCodePattern = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/**
 * Language metadata is declarative, not inferred from script. Preserve any
 * structurally valid BCP-47 language (for example `es` or `sr-Cyrl`) while
 * reserving `mixed` for explicitly multilingual provider output.
 */
export function normalizeMemoryLanguageCode(value: unknown): MemoryTextLanguage | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 35) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "mixed" || lower === "mul") return "mixed";
  if (lower === "und") return "und";
  if (!languageCodePattern.test(trimmed)) return null;
  try {
    const canonical = Intl.getCanonicalLocales(trimmed)[0];
    return canonical && canonical.length <= 35 ? canonical : null;
  } catch {
    return null;
  }
}

export function detectMemoryTextLanguage(_value: string): "und" {
  // Script detection cannot establish a language. Only model-provided,
  // structurally valid BCP-47 metadata may be more specific.
  return "und";
}

export function memoryQualificationLanguageBucket(
  languageCode: string
): MemoryQualificationLanguageBucket {
  const normalized = normalizeMemoryLanguageCode(languageCode)?.toLowerCase() ?? "und";
  if (normalized === "mixed" || normalized === "mul") return "mixed";
  if (!normalized || normalized === "auto" || normalized === "und") return "und";

  try {
    const language = new Intl.Locale(normalized).language.toLowerCase();
    if (language === "en") return "en";
    if (language === "ru") return "ru";
    if (language === "mul") return "mixed";
    if (language === "und") return "und";
    return "other";
  } catch {
    return "und";
  }
}
