export type TokenUsageCompleteness = "complete" | "partial" | "unavailable";

export const TOKEN_USAGE_FIELDS = [
  "cachedInputTokens", "cacheWriteInputTokens", "inputTokens",
  "outputTokens", "reasoningTokens", "totalTokens"
] as const;
export type TokenUsageField = typeof TOKEN_USAGE_FIELDS[number];

export type TokenUsage = Partial<Record<TokenUsageField, number | null>> & {
  completeness?: TokenUsageCompleteness;
};

/** Null means unreported; zero is a reported count. Completeness covers the
 * input/output/total accounting, while optional breakdowns retain their presence. */
export type NormalizedTokenUsage = Record<TokenUsageField, number | null> & {
  completeness: TokenUsageCompleteness;
};

export type ModelTokenPricing = {
  inputTokenPriceUsdPerMillion: number | null;
  outputTokenPriceUsdPerMillion: number | null;
  cachedInputTokenPriceUsdPerMillion?: number | null;
  cacheWriteInputTokenPriceUsdPerMillion?: number | null;
  reasoningTokenPriceUsdPerMillion?: number | null;
};

export function reportedTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function normalizeTokenUsage(
  usage: Partial<Record<TokenUsageField, unknown>> & { completeness?: unknown }
): NormalizedTokenUsage {
  const fields = Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) =>
    [field, usage.completeness === "unavailable" ? null : reportedTokenCount(usage[field])])) as Record<TokenUsageField, number | null>;
  if (usage.totalTokens === undefined && fields.inputTokens !== null && fields.outputTokens !== null) {
    fields.totalTokens = reportedTokenCount(fields.inputTokens + fields.outputTokens);
  }
  const invalid = TOKEN_USAGE_FIELDS.some((field) => usage[field] != null && reportedTokenCount(usage[field]) === null);
  const completeness = TOKEN_USAGE_FIELDS.every((field) => fields[field] === null) ? "unavailable"
    : !invalid && usage.completeness !== "partial" && fields.inputTokens !== null &&
      fields.outputTokens !== null && fields.totalTokens !== null ? "complete" : "partial";
  return { ...fields, completeness };
}

/** Each input describes a separate physical operation, never another cumulative
 * snapshot of the same operation. Partial sums remain explicitly incomplete. */
export function sumTokenUsage(usages: readonly TokenUsage[]): NormalizedTokenUsage {
  const normalized = usages.map(normalizeTokenUsage);
  let overflow = false;
  const fields = Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) => {
    const known = normalized.flatMap((usage) => usage[field] === null ? [] : [usage[field]]);
    const count = known.length ? reportedTokenCount(known.reduce((sum, value) => sum + value, 0)) : null;
    if (known.length && count === null) overflow = true;
    return [field, count];
  })) as Record<TokenUsageField, number | null>;
  return {
    ...fields,
    completeness: normalized.length === 0 || normalized.every((usage) => usage.completeness === "unavailable") ? "unavailable"
      : !overflow && normalized.every((usage) => usage.completeness === "complete") ? "complete" : "partial"
  };
}

/** Replace cumulative counts within one operation, retaining previously reported
 * fields when a later chunk omits them. Never sum stream snapshots. */
export function mergeTokenUsage(previous: TokenUsage, update: TokenUsage): NormalizedTokenUsage {
  const left = normalizeTokenUsage(previous);
  const right = normalizeTokenUsage(update);
  if (right.completeness === "unavailable") return left;
  const fields: Partial<Record<TokenUsageField, number | null>> = Object.fromEntries(
    TOKEN_USAGE_FIELDS.map((field) => [field, right[field] ?? left[field]]));
  if (right.totalTokens === null &&
    (right.inputTokens !== null || right.outputTokens !== null)) fields.totalTokens = undefined;
  return normalizeTokenUsage({ ...fields,
    ...(update.completeness === "partial" ? { completeness: "partial" } : {}) });
}

/** Strict decoding for durable/public accounting, with an explicit projection. */
export function decodeTokenUsage(value: unknown): NormalizedTokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!TOKEN_USAGE_FIELDS.some((field) => Object.hasOwn(record, field)) && !Object.hasOwn(record, "completeness")) return null;
  if (record.completeness !== undefined && !["complete", "partial", "unavailable"].includes(String(record.completeness))) return null;
  if (TOKEN_USAGE_FIELDS.some((field) => record[field] != null && reportedTokenCount(record[field]) === null)) return null;
  const usage = normalizeTokenUsage(record);
  return record.completeness !== undefined && usage.completeness !== record.completeness ? null : usage;
}

export function sumEstimatedCostMicros(costs: readonly (number | null | undefined)[]): number | null {
  if (!costs.length || costs.some((cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return null;
  const total = costs.reduce<number>((sum, cost) => sum + cost!, 0);
  return Number.isFinite(total) ? total : null;
}

export function subtractTokenUsage(total: TokenUsage, subtrahend: TokenUsage): NormalizedTokenUsage | null {
  const left = normalizeTokenUsage(total);
  const right = normalizeTokenUsage(subtrahend);
  if (TOKEN_USAGE_FIELDS.some((field) => left[field] !== null && right[field] !== null && right[field] > left[field])) return null;
  const fields = Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) =>
    [field, left[field] === null ? null : left[field] - (right[field] ?? 0)])) as Record<TokenUsageField, number | null>;
  return {
    ...fields,
    completeness: TOKEN_USAGE_FIELDS.every((field) => fields[field] === null) ? "unavailable"
      : left.completeness === "complete" && right.completeness === "complete" ? "complete" : "partial"
  };
}

export function estimateCostMicros(usage: TokenUsage, pricing: ModelTokenPricing): number | null {
  const normalized = normalizeTokenUsage(usage);
  if (normalized.completeness !== "complete" || normalized.inputTokens === null || normalized.outputTokens === null) return null;
  const inputPrice = pricing.inputTokenPriceUsdPerMillion;
  const outputPrice = pricing.outputTokenPriceUsdPerMillion;
  if (inputPrice === null || outputPrice === null) return null;
  const cachedPrice = pricing.cachedInputTokenPriceUsdPerMillion ?? inputPrice;
  const cacheWritePrice = pricing.cacheWriteInputTokenPriceUsdPerMillion ?? inputPrice;
  const reasoningPrice = pricing.reasoningTokenPriceUsdPerMillion ?? outputPrice;
  if ([inputPrice, outputPrice, cachedPrice, cacheWritePrice, reasoningPrice]
    .some((price) => !Number.isFinite(price) || price < 0 || price >= 10_000_000_000)) return null;
  if (reasoningPrice !== pricing.outputTokenPriceUsdPerMillion && normalized.reasoningTokens === null) return null;
  const reasoningTokens = Math.min(normalized.reasoningTokens ?? 0, normalized.outputTokens);
  const cachedTokens = normalized.cachedInputTokens ?? 0;
  const cacheWriteTokens = normalized.cacheWriteInputTokens ?? 0;
  const uncachedTokens = Math.max(0, normalized.inputTokens - cachedTokens - cacheWriteTokens);
  // Decimal(18,8) prices use exact integer arithmetic so binary floats cannot
  // turn a half-micro boundary (for example 50 * 0.29) into a downward round.
  const charge = (tokens: number, price: number) => BigInt(tokens) * BigInt(price.toFixed(8).replace(".", ""));
  const scaledCost = charge(uncachedTokens, inputPrice) + charge(cachedTokens, cachedPrice) +
    charge(cacheWriteTokens, cacheWritePrice) + charge(normalized.outputTokens - reasoningTokens, outputPrice) +
    charge(reasoningTokens, reasoningPrice);
  // USD per million tokens is numerically micro-dollars per token.
  const cost = Number((scaledCost + 50_000_000n) / 100_000_000n);
  // Durable cost columns are signed 32-bit integers. Unrepresentable cost is unknown.
  return Number.isSafeInteger(cost) && cost >= 0 && cost <= 2_147_483_647 ? cost : null;
}
