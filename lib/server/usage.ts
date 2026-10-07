import type { Prisma } from "@prisma/client";
import type { AdminProviderModelClass } from "../contracts/adminProviders";
import { normalizeTokenUsage, usageCostMicros, type ModelTokenPricing, type TokenUsage } from "../domain/usage";
import { modelTokenPricing, modelTokenPricingSelect } from "./providers/modelTokenPricing";

/** Explicit accounting projection: the domain discriminator is not a database column. */
export function storedTokenUsage(value: TokenUsage) {
  const { completeness, ...counts } = normalizeTokenUsage(value);
  return {
    ...counts,
    usageCompleteness: completeness === "complete" ? "COMPLETE" as const
      : completeness === "partial" ? "PARTIAL" as const : "UNAVAILABLE" as const
  };
}

/** What a usage row of one deployment is charged at when its provider reported
 * no cost: the ProviderModel's own class and stored token prices. */
export type ProviderModelCostBasis = Readonly<{
  modelClass: AdminProviderModelClass;
  pricing: ModelTokenPricing;
}>;

/** The cost basis of a stored ProviderModel; null when the row no longer
 * exists. Prices come only from the stored row, never from a request. */
export async function loadProviderModelCostBasis(
  db: Pick<Prisma.TransactionClient, "providerModel">,
  providerModelId: string
): Promise<ProviderModelCostBasis | null> {
  const model = await db.providerModel.findUnique({
    select: { modelClass: true, ...modelTokenPricingSelect },
    where: { id: providerModelId }
  });
  return model ? { modelClass: model.modelClass, pricing: modelTokenPricing(model) } : null;
}

const UNKNOWN_PRICES: ModelTokenPricing = Object.freeze({
  inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null,
  cachedInputTokenPriceUsdPerMillion: null, cacheWriteInputTokenPriceUsdPerMillion: null
});

/**
 * `usageCostMicros` for one call of a deployment: the provider-reported cost,
 * else the deployment's stored prices of its class, else null. A deployment
 * that no longer exists has no prices, only a reported cost.
 */
export function providerModelUsageCostMicros(input: Readonly<{
  basis: ProviderModelCostBasis | null;
  reportedCostUsd: number | null;
  usage: TokenUsage;
}>): number | null {
  return usageCostMicros({
    reportedCostUsd: input.reportedCostUsd,
    usage: input.usage,
    pricing: input.basis?.pricing ?? UNKNOWN_PRICES,
    // Without prices the class selects nothing; any class yields the same null.
    modelClass: input.basis?.modelClass ?? "answer"
  });
}
