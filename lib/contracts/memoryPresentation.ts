import type { MemoryUiLocale } from "./memory";

/**
 * AIQSA has no interface localization layer yet. Keep Memory presentation
 * deterministic and English-only while persisted locale values remain
 * available for backward-compatible data processing.
 */
export const MEMORY_PRESENTATION_LOCALE = "EN" as const satisfies MemoryUiLocale;

export function memoryPresentationIsRussian(_locale?: unknown): boolean {
  return false;
}
