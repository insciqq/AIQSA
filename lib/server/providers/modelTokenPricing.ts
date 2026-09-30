import type { ModelTokenPricing } from "../../domain/usage";

type StoredPrice = number | { toNumber(): number } | null;
type StoredPricing = { [Field in keyof ModelTokenPricing]?: StoredPrice };

/** Prisma decimals stay server-side; domain accounting receives explicit numbers/nulls. */
export function modelTokenPricing(model: StoredPricing): ModelTokenPricing {
  const number = (price: StoredPrice | undefined) => price == null ? null
    : typeof price === "number" ? price : price.toNumber();
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
