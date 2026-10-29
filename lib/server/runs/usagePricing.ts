import { normalizeTokenUsage, reportedCostMicros, usageCostMicros, type ModelTokenPricing } from "../../domain/usage";
import { isChatModelUsagePurpose } from "../../domain/usagePurpose";
import { providerModelUsageCostMicros } from "../usage";
import type { RunRepository, RunUsageAttribution } from "./runRepositoryContract";

const NO_PRICES: ModelTokenPricing = { inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null };

type PricingRepository = Pick<RunRepository, "loadModelPricing" | "loadProviderModelCostBasis">;

/**
 * Whether an attribution's cost is settled, so pricing keeps it: a Knowledge
 * retrieval or Search engine call with a cost (reported, or recorded by an
 * earlier write of its row), or an answer or sub-agent call whose provider
 * reported its charge (`costReported`).
 */
function hasSettledRunUsageCost(attribution: RunUsageAttribution): boolean {
  if (attribution.estimatedCostMicros === undefined) return false;
  return (isChatModelUsagePurpose(attribution.purpose) || attribution.purpose === "mcp_guard") ? attribution.costReported === true
    : attribution.purpose === "knowledge_retrieval" || attribution.purpose === "web_search";
}

/** The cost fields of an answer call whose provider reported its charge; none
 * when it reported no usable amount, so the call is priced from token prices. */
export function reportedAnswerCost(costUsd: number | undefined): Pick<RunUsageAttribution, "costReported" | "estimatedCostMicros"> {
  const micros = costUsd === undefined ? null : reportedCostMicros(costUsd);
  return micros === null ? {} : { costReported: true, estimatedCostMicros: micros };
}

/**
 * The cost of an unsettled attribution, priced now: a Knowledge call with the
 * shared cost rule from its deployment's stored class prices; a Search or
 * answer call from its model's answer prices, which include the per-search fee
 * of every web search its provider reported.
 */
async function unsettledUsageCost(repository: PricingRepository, attribution: RunUsageAttribution): Promise<number | null> {
  if (attribution.purpose !== "knowledge_retrieval") {
    const pricing = attribution.providerModelId
      ? await repository.loadModelPricing(attribution.provider, attribution.modelId, attribution.providerModelId)
      : await repository.loadModelPricing(attribution.provider, attribution.modelId);
    return usageCostMicros({ modelClass: "answer", pricing: pricing ?? NO_PRICES, reportedCostUsd: null,
      usage: normalizeTokenUsage(attribution.usage) }) ?? null;
  }
  if (!attribution.providerModelId) return null;
  const basis = await repository.loadProviderModelCostBasis(attribution.providerModelId);
  return providerModelUsageCostMicros({ basis, reportedCostUsd: null, usage: attribution.usage });
}

/** Each attribution with its cost: settled costs are kept, every other one is priced now. */
export async function usageAttributionsWithEstimatedCost(
  repository: PricingRepository,
  attributions: readonly RunUsageAttribution[]
): Promise<RunUsageAttribution[]> {
  return Promise.all(
    attributions.map(async (attribution) => {
      const settled = hasSettledRunUsageCost(attribution);
      return {
        ...(attribution.operationCount !== undefined ? { operationCount: attribution.operationCount } : {}),
        ...(settled && attribution.costReported ? { costReported: true as const } : {}),
        estimatedCostMicros: settled ? attribution.estimatedCostMicros ?? null : await unsettledUsageCost(repository, attribution),
        modelId: attribution.modelId,
        ...(attribution.providerModelId ? { providerModelId: attribution.providerModelId } : {}),
        provider: attribution.provider,
        purpose: attribution.purpose,
        usage: normalizeTokenUsage(attribution.usage)
      };
    })
  );
}
