import { modelClassPriceFields, type AdminModelPriceField } from "../contracts/adminProviderModelPrices";
import type { AdminProviderModelClass } from "../contracts/adminProviders";

export type TokenUsageCompleteness = "complete" | "partial" | "unavailable";

export const TOKEN_USAGE_FIELDS = [
  "cachedInputTokens", "cacheWriteInputTokens", "inputTokens",
  "outputTokens", "reasoningTokens", "totalTokens"
] as const;
export type TokenUsageField = typeof TOKEN_USAGE_FIELDS[number];

export type TokenUsage = Partial<Record<TokenUsageField, number | null>> & {
  completeness?: TokenUsageCompleteness;
  /** Billed web searches the provider reported for this usage, counted the way
   * it bills them: OpenAI and DeepSeek search calls, Anthropic
   * `web_search_requests`, Gemini search queries. Null or absent when none. */
  webSearchCount?: number | null;
};

/** Null means unreported; zero is a reported count. Completeness covers the
 * input/output/total accounting, while optional breakdowns retain their presence.
 * The provider-reported web search count is present only when positive and
 * never affects completeness. */
export type NormalizedTokenUsage = Record<TokenUsageField, number | null> & {
  completeness: TokenUsageCompleteness;
  /** A positive reported count; absent otherwise. */
  webSearchCount?: number;
};

export type ModelTokenPricing = {
  inputTokenPriceUsdPerMillion: number | null;
  outputTokenPriceUsdPerMillion: number | null;
  cachedInputTokenPriceUsdPerMillion?: number | null;
  cacheWriteInputTokenPriceUsdPerMillion?: number | null;
  reasoningTokenPriceUsdPerMillion?: number | null;
  /** USD per 1,000 web searches the provider reports, charged on top of tokens;
   * null or absent adds no search fee. */
  webSearchPriceUsdPerThousand?: number | null;
};

export function reportedTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function reportedSearchCount(value: unknown): number | null {
  const count = reportedTokenCount(value);
  return count !== null && count > 0 ? count : null;
}

/** The optional provider-reported search count, present only when positive. */
function searchCount(webSearchCount: number | null): Pick<NormalizedTokenUsage, "webSearchCount"> {
  return webSearchCount !== null ? { webSearchCount } : {};
}

export function normalizeTokenUsage(
  usage: Partial<Record<TokenUsageField, unknown>> & { completeness?: unknown; webSearchCount?: unknown }
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
  return { ...fields, completeness, ...searchCount(reportedSearchCount(usage.webSearchCount)) };
}

/** Each input describes a separate physical operation, never another cumulative
 * snapshot of the same operation. Partial sums remain explicitly incomplete.
 * Web search counts add up. */
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
      : !overflow && normalized.every((usage) => usage.completeness === "complete") ? "complete" : "partial",
    ...searchCount(reportedSearchCount(normalized.reduce((sum, usage) => sum + (usage.webSearchCount ?? 0), 0)))
  };
}

/** Replace cumulative counts within one operation, retaining previously reported
 * fields when a later chunk omits them. Never sum stream snapshots. */
export function mergeTokenUsage(previous: TokenUsage, update: TokenUsage): NormalizedTokenUsage {
  const left = normalizeTokenUsage(previous);
  const right = normalizeTokenUsage(update);
  const extras = searchCount(right.webSearchCount ?? left.webSearchCount ?? null);
  if (right.completeness === "unavailable") return { ...left, ...extras };
  const fields: Partial<Record<TokenUsageField, number | null>> = Object.fromEntries(
    TOKEN_USAGE_FIELDS.map((field) => [field, right[field] ?? left[field]]));
  if (right.totalTokens === null &&
    (right.inputTokens !== null || right.outputTokens !== null)) fields.totalTokens = undefined;
  return normalizeTokenUsage({ ...fields, ...extras,
    ...(update.completeness === "partial" ? { completeness: "partial" } : {}) });
}

/** Strict decoding for durable/public accounting, with an explicit projection. */
export function decodeTokenUsage(value: unknown): NormalizedTokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!TOKEN_USAGE_FIELDS.some((field) => Object.hasOwn(record, field)) && !Object.hasOwn(record, "completeness")) return null;
  if (record.completeness !== undefined && !["complete", "partial", "unavailable"].includes(String(record.completeness))) return null;
  if (TOKEN_USAGE_FIELDS.some((field) => record[field] != null && reportedTokenCount(record[field]) === null)) return null;
  if (record.webSearchCount != null && reportedTokenCount(record.webSearchCount) === null) return null;
  const usage = normalizeTokenUsage(record);
  return record.completeness !== undefined && usage.completeness !== record.completeness ? null : usage;
}

export function sumEstimatedCostMicros(costs: readonly (number | null | undefined)[]): number | null {
  if (!costs.length || costs.some((cost) => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0)) return null;
  const total = costs.reduce<number>((sum, cost) => sum + cost!, 0);
  return Number.isFinite(total) ? total : null;
}

/** Web search counts subtract exactly like tokens. */
export function subtractTokenUsage(total: TokenUsage, subtrahend: TokenUsage): NormalizedTokenUsage | null {
  const left = normalizeTokenUsage(total);
  const right = normalizeTokenUsage(subtrahend);
  if (TOKEN_USAGE_FIELDS.some((field) => left[field] !== null && right[field] !== null && right[field] > left[field])) return null;
  const searches = (left.webSearchCount ?? 0) - (right.webSearchCount ?? 0);
  if (searches < 0) return null;
  const fields = Object.fromEntries(TOKEN_USAGE_FIELDS.map((field) =>
    [field, left[field] === null ? null : left[field] - (right[field] ?? 0)])) as Record<TokenUsageField, number | null>;
  return {
    ...fields,
    completeness: TOKEN_USAGE_FIELDS.every((field) => fields[field] === null) ? "unavailable"
      : left.completeness === "complete" && right.completeness === "complete" ? "complete" : "partial",
    ...searchCount(reportedSearchCount(searches))
  };
}

// Durable cost columns are signed 32-bit integers. Unrepresentable cost is unknown.
const MAX_COST_MICROS = 2_147_483_647n;

function validPrice(price: number): boolean {
  return Number.isFinite(price) && price >= 0 && price < 10_000_000_000;
}

// Decimal(18,8) prices use exact integer arithmetic so binary floats cannot
// turn a half-micro boundary (for example 50 * 0.29) into a downward round.
function charge(tokens: number, price: number): bigint {
  return BigInt(tokens) * BigInt(price.toFixed(8).replace(".", ""));
}

function chargedMicros(scaledCost: bigint): number | null {
  // USD per million tokens is numerically micro-dollars per token.
  const micros = (scaledCost + 50_000_000n) / 100_000_000n;
  return micros <= MAX_COST_MICROS ? Number(micros) : null;
}

// USD per thousand searches is numerically a thousandth of the micro-dollars per search.
function searchCharge(searches: number, pricePerThousand: number): bigint {
  return BigInt(searches) * 1_000n * BigInt(pricePerThousand.toFixed(8).replace(".", ""));
}

/**
 * Token cost plus the provider-reported web searches times the per-search
 * price. A missing per-search price adds no fee; an invalid one, like any
 * invalid price, leaves the cost unknown.
 */
export function estimateCostMicros(usage: TokenUsage, pricing: ModelTokenPricing): number | null {
  const normalized = normalizeTokenUsage(usage);
  if (normalized.completeness !== "complete" || normalized.inputTokens === null || normalized.outputTokens === null) return null;
  const inputPrice = pricing.inputTokenPriceUsdPerMillion;
  const outputPrice = pricing.outputTokenPriceUsdPerMillion;
  if (inputPrice === null || outputPrice === null) return null;
  const cachedPrice = pricing.cachedInputTokenPriceUsdPerMillion ?? inputPrice;
  const cacheWritePrice = pricing.cacheWriteInputTokenPriceUsdPerMillion ?? inputPrice;
  const reasoningPrice = pricing.reasoningTokenPriceUsdPerMillion ?? outputPrice;
  const searchPrice = pricing.webSearchPriceUsdPerThousand ?? 0;
  if (![inputPrice, outputPrice, cachedPrice, cacheWritePrice, reasoningPrice, searchPrice].every(validPrice)) return null;
  if (reasoningPrice !== pricing.outputTokenPriceUsdPerMillion && normalized.reasoningTokens === null) return null;
  const reasoningTokens = Math.min(normalized.reasoningTokens ?? 0, normalized.outputTokens);
  const cachedTokens = normalized.cachedInputTokens ?? 0;
  const cacheWriteTokens = normalized.cacheWriteInputTokens ?? 0;
  const uncachedTokens = Math.max(0, normalized.inputTokens - cachedTokens - cacheWriteTokens);
  return chargedMicros(charge(uncachedTokens, inputPrice) + charge(cachedTokens, cachedPrice) +
    charge(cacheWriteTokens, cacheWritePrice) + charge(normalized.outputTokens - reasoningTokens, outputPrice) +
    charge(reasoningTokens, reasoningPrice) + searchCharge(normalized.webSearchCount ?? 0, searchPrice));
}

/** Exact half-up micro-dollars of a reported USD amount, read as the shortest
 * decimal that round-trips the number (the provider's own JSON text); null
 * when the amount is invalid or unrepresentable. Rule 1 of
 * {@link usageCostMicros}, for writers that price unreported usage later:
 * Memory settlement and a run's attribution rows. */
export function reportedCostMicros(usd: number): number | null {
  // Also excludes NaN and Infinity; 2148 USD is beyond the int32 column.
  if (!(usd >= 0 && usd < 2_148)) return null;
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/u.exec(String(usd));
  if (!match) return null;
  const [, whole, fraction = "", exponent = "0"] = match;
  const digits = BigInt(whole! + fraction);
  const shift = Number(exponent) - fraction.length + 6;
  const divisor = 10n ** BigInt(Math.max(0, -shift));
  const micros = shift >= 0 ? digits * 10n ** BigInt(shift) : (digits * 2n + divisor) / (divisor * 2n);
  return micros <= MAX_COST_MICROS ? Number(micros) : null;
}

export type UsageCostInput = Readonly<{
  /** USD the provider reported for exactly this call (for example OpenRouter
   * `usage.cost`), or null when it reported none. */
  reportedCostUsd: number | null;
  /** The call's provider-reported token usage and web search count. */
  usage: TokenUsage;
  /** The deployment's configured prices; any of them may be null (unknown). */
  pricing: ModelTokenPricing;
  /** The deployment's model class: it selects the prices that apply. */
  modelClass: AdminProviderModelClass;
}>;

/**
 * The cost of one usage row in whole micro-dollars, or null when unknown; a
 * known cost always fits the int32 cost column. Pure: the one cost rule usage
 * writers apply to the rows they write.
 *
 * 1. A provider-reported cost wins over configured prices: exact half-up
 *    micro-dollars, so a sub-micro amount is a known zero. A negative,
 *    non-finite or unrepresentable amount is unknown and is never replaced by
 *    an estimate. Writers whose rows keep token prices (answers) pass null.
 * 2. Otherwise the configured prices of the class (`modelClassPriceFields`):
 *    answer, decision and image usage needs complete input and output counts
 *    and both prices, charging cached input as input where the class or the
 *    model has no cache price; answer usage also pays each web search its
 *    provider reported at the per-search price, and nothing without one;
 *    embedding and reranker usage costs its input tokens, else its total
 *    tokens, times the input price and needs no output.
 * 3. Otherwise null.
 */
export function usageCostMicros({ reportedCostUsd, usage, pricing, modelClass }: UsageCostInput): number | null {
  if (reportedCostUsd !== null) return reportedCostMicros(reportedCostUsd);
  const fields = modelClassPriceFields(modelClass);
  const price = (field: AdminModelPriceField) => fields.includes(field) ? pricing[field] ?? null : null;
  if (fields.includes("outputTokenPriceUsdPerMillion")) {
    return estimateCostMicros(usage, { ...pricing,
      cachedInputTokenPriceUsdPerMillion: price("cachedInputTokenPriceUsdPerMillion"),
      cacheWriteInputTokenPriceUsdPerMillion: price("cacheWriteInputTokenPriceUsdPerMillion"),
      webSearchPriceUsdPerThousand: price("webSearchPriceUsdPerThousand") });
  }
  const inputPrice = price("inputTokenPriceUsdPerMillion");
  const normalized = normalizeTokenUsage(usage);
  const tokens = normalized.inputTokens ?? normalized.totalTokens;
  return tokens === null || inputPrice === null || !validPrice(inputPrice) ? null : chargedMicros(charge(tokens, inputPrice));
}
