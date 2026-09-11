import { normalizeTokenUsage, type TokenUsage } from "../domain/usage";

/** Explicit accounting projection: the domain discriminator is not a database column. */
export function storedTokenUsage(value: TokenUsage) {
  const { completeness, ...counts } = normalizeTokenUsage(value);
  return {
    ...counts,
    usageCompleteness: completeness === "complete" ? "COMPLETE" as const
      : completeness === "partial" ? "PARTIAL" as const : "UNAVAILABLE" as const
  };
}
