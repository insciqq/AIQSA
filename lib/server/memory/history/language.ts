export type MemoryTextLanguage = string;

export type MemoryQualificationLanguageBucket =
  | "declared"
  | "mixed"
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
  if (normalized === "mixed") return "mixed";
  return normalized === "und" ? "und" : "declared";
}
