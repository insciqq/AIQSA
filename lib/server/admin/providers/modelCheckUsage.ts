import type { PrismaClient } from "@prisma/client";
import type { AdminProviderModelClass } from "../../../contracts/adminProviders";
import { usageCostMicros, type ModelTokenPricing, type TokenUsage } from "../../../domain/usage";
import { logEvent } from "../../observability";
import { databaseFailureCode } from "../../observability/databaseFailure";
import { modelTokenPricing, modelTokenPricingSelect } from "../../providers/modelTokenPricing";
import { storedTokenUsage } from "../../usage";

/** What one answered provider call of a model check reported. */
export type ModelCheckProviderCall = Readonly<{
  usage: TokenUsage;
  /** USD the provider reported for exactly this call, or null. */
  reportedCostUsd: number | null;
}>;

export type ModelCheckUsageRecord = ModelCheckProviderCall & Readonly<{
  /** The acting administrator; model checks have no chat, run or project. */
  userId: string;
  provider: string;
  /** The upstream model the call executed. */
  modelId: string;
  /** The checked deployment row; a never-saved draft has no row. */
  providerModelId: string;
  modelClass: AdminProviderModelClass;
}>;

export type ModelCheckUsageWriter = (record: ModelCheckUsageRecord) => Promise<void>;

export type ModelCheckUsageRecorder = Readonly<{
  /** Called once per answered provider call. Never throws and never fails the probe. */
  record(call: ModelCheckProviderCall): void;
  /** Resolves when every write started so far has finished or been logged as lost. */
  settled(): Promise<void>;
}>;

const NO_PRICES: ModelTokenPricing = {
  inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null,
  cachedInputTokenPriceUsdPerMillion: null, cacheWriteInputTokenPriceUsdPerMillion: null
};

/**
 * One `model_check` usage row per call, charged to the administrator. Cost
 * follows the shared rule: the provider-reported cost, else the checked row's
 * stored prices of its class; an unsaved draft has no prices.
 */
export function createPrismaModelCheckUsageWriter(prisma: Pick<PrismaClient, "providerModel" | "usageEvent">): ModelCheckUsageWriter {
  return async (record) => {
    const model = await prisma.providerModel.findUnique({ where: { id: record.providerModelId },
      select: { id: true, ...modelTokenPricingSelect } });
    await prisma.usageEvent.create({ data: {
      userId: record.userId, purpose: "model_check", provider: record.provider, modelId: record.modelId,
      providerModelId: model?.id ?? null, ...storedTokenUsage(record.usage),
      estimatedCostMicros: usageCostMicros({ reportedCostUsd: record.reportedCostUsd, usage: record.usage,
        pricing: model ? modelTokenPricing(model) : NO_PRICES, modelClass: record.modelClass })
    } });
  };
}

/**
 * Binds one check's identity to the writer. Without a writer or an acting
 * administrator (startup adoption probes) calls stay unaccounted. A lost write
 * is logged content-free and never repeated, so no call is charged twice.
 */
export function createModelCheckUsageRecorder(
  writer: ModelCheckUsageWriter | undefined,
  identity: Omit<ModelCheckUsageRecord, keyof ModelCheckProviderCall | "userId"> & Readonly<{ userId?: string }>
): ModelCheckUsageRecorder | null {
  const userId = identity.userId;
  if (!writer || !userId) return null;
  const pending = new Set<Promise<void>>();
  return {
    record(call) {
      const write = Promise.resolve()
        .then(() => writer({ ...identity, userId, usage: call.usage, reportedCostUsd: call.reportedCostUsd }))
        .catch((error: unknown) => {
          logEvent("job_persistence", { subsystem: "admin", stage: "settle", outcome: "unconfirmed",
            prisma_code: databaseFailureCode(error) });
        })
        .finally(() => { pending.delete(write); });
      pending.add(write);
    },
    async settled() {
      while (pending.size) await Promise.all([...pending]);
    }
  };
}
