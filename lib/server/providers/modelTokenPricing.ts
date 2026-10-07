import type { ModelTokenPricing } from "../../domain/usage";

type StoredPrice = number | { toNumber(): number } | null;
type StoredPricing = { [Field in keyof ModelTokenPricing]?: StoredPrice };

function number(price: StoredPrice | undefined): number | null {
  return price == null ? null : typeof price === "number" ? price : price.toNumber();
}

/** Prisma decimals stay server-side; domain accounting receives explicit numbers/nulls. */
export function modelTokenPricing(model: StoredPricing): ModelTokenPricing {
  return {
    inputTokenPriceUsdPerMillion: number(model.inputTokenPriceUsdPerMillion),
    cachedInputTokenPriceUsdPerMillion: number(model.cachedInputTokenPriceUsdPerMillion),
    cacheWriteInputTokenPriceUsdPerMillion: number(model.cacheWriteInputTokenPriceUsdPerMillion),
    outputTokenPriceUsdPerMillion: number(model.outputTokenPriceUsdPerMillion)
  };
}

export const modelTokenPricingSelect = {
  inputTokenPriceUsdPerMillion: true,
  cachedInputTokenPriceUsdPerMillion: true,
  cacheWriteInputTokenPriceUsdPerMillion: true,
  outputTokenPriceUsdPerMillion: true
} as const;

/** Token prices plus the per-search price, for usage that can report web
 * searches: answers with native search and Search engines. */
export function modelSearchPricing(model: StoredPricing): ModelTokenPricing {
  return { ...modelTokenPricing(model), webSearchPriceUsdPerThousand: number(model.webSearchPriceUsdPerThousand) };
}

export const modelSearchPricingSelect = {
  ...modelTokenPricingSelect,
  webSearchPriceUsdPerThousand: true
} as const;
