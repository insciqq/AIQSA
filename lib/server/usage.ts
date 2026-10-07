import { normalizeTokenUsage, type TokenUsage } from "../domain/usage";

/** Explicit accounting projection: the domain discriminator is not a database
 * column, and a reported cost is stored only as the writer's own row cost. */
export function storedTokenUsage(value: TokenUsage) {
  const { completeness, costUsd: _reportedCost, ...counts } = normalizeTokenUsage(value);
  return {
    ...counts,
    usageCompleteness: completeness === "complete" ? "COMPLETE" as const
      : completeness === "partial" ? "PARTIAL" as const : "UNAVAILABLE" as const
  };
}
