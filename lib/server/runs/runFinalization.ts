import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import { estimateCostMicros, normalizeTokenUsage, type ModelTokenPricing } from "../../domain/usage";
import type { RunRepository, RunUsageAttribution } from "./runRepositoryContract";

type RunEventRepository = Pick<RunRepository, "appendRunEvent" | "nextRunEventSequence">;
type RunCompletionRepository = Pick<RunRepository, "completeRun" | "loadModelPricing">;

export type RunEventSequence = {
  value: number;
};

export type RunCompletionFinalizationResult =
  | Readonly<{
      status: "completed";
      usage: ModelRunUsage;
    }>
  | Readonly<{
      status: "not_completed";
    }>;

function hasUsablePricing(pricing: ModelTokenPricing | null): pricing is ModelTokenPricing {
  return Boolean(pricing && (pricing.inputTokenPriceMicros > 0 || pricing.outputTokenPriceMicros > 0));
}

export async function appendRunEventWithRetry(
  repository: RunEventRepository,
  runId: string,
  sequence: RunEventSequence,
  event: ModelRunSseEvent
): Promise<void> {
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      await repository.appendRunEvent(runId, sequence.value, event);
      sequence.value += 1;
      return;
    } catch (error) {
      const nextSequence = await repository.nextRunEventSequence(runId);
      if (nextSequence === sequence.value || attempt === maxAttempts - 1) {
        throw error;
      }

      sequence.value = nextSequence;
    }
  }
}

export async function appendStoredRunEvents(input: Readonly<{
  events: readonly ModelRunSseEvent[];
  repository: RunEventRepository;
  runId: string;
  sequence: RunEventSequence;
}>): Promise<void> {
  for (const event of input.events) {
    await appendRunEventWithRetry(input.repository, input.runId, input.sequence, event);
  }
}

export async function usageWithEstimatedCost(
  repository: Pick<RunRepository, "loadModelPricing">,
  input: Readonly<{
    modelId: string;
    provider: string;
    usage: ModelRunUsage;
  }>
): Promise<ModelRunUsage> {
  const normalizedUsage = normalizeTokenUsage(input.usage);
  const pricing = await repository.loadModelPricing(input.provider, input.modelId);
  const estimatedCostMicros = hasUsablePricing(pricing) ? estimateCostMicros(normalizedUsage, pricing) : null;

  return {
    ...normalizedUsage,
    estimatedCostMicros
  };
}

export async function usageAttributionsWithEstimatedCost(
  repository: Pick<RunRepository, "loadModelPricing">,
  attributions: readonly RunUsageAttribution[]
): Promise<RunUsageAttribution[]> {
  return Promise.all(
    attributions.map(async (attribution) => ({
      estimatedCostMicros: (
        await usageWithEstimatedCost(repository, {
          modelId: attribution.modelId,
          provider: attribution.provider,
          usage: attribution.usage
        })
      ).estimatedCostMicros,
      modelId: attribution.modelId,
      provider: attribution.provider,
      usage: normalizeTokenUsage(attribution.usage)
    }))
  );
}

export async function finalizeRunCompletion(input: Readonly<{
  eventsBeforeTerminal?: readonly ModelRunSseEvent[];
  repository: RunCompletionRepository;
  result: Readonly<{
    finalProviderResponsePreview: Record<string, unknown>;
    finalText: string;
    providerResponseId?: string;
    usage: ModelRunUsage;
    usageAttributions?: RunUsageAttribution[];
  }>;
  run: Readonly<{
    assistantMessageId: string;
    chatId: string;
    modelId: string;
    provider: string;
    runId: string;
    userId: string;
  }>;
}>): Promise<RunCompletionFinalizationResult> {
  const usageAttributions = await usageAttributionsWithEstimatedCost(
    input.repository,
    input.result.usageAttributions?.length
      ? input.result.usageAttributions
      : [
          {
            modelId: input.run.modelId,
            provider: input.run.provider,
            usage: input.result.usage
          }
        ]
  );
  const attributedCosts = usageAttributions
    .map((attribution) => attribution.estimatedCostMicros)
    .filter((value): value is number => typeof value === "number");
  const usage = {
    ...normalizeTokenUsage(input.result.usage),
    estimatedCostMicros:
      attributedCosts.length > 0 ? attributedCosts.reduce((total, value) => total + value, 0) : null
  };
  const completed = await input.repository.completeRun({
    assistantMessageId: input.run.assistantMessageId,
    chatId: input.run.chatId,
    estimatedCostMicros: usage.estimatedCostMicros ?? null,
    finalProviderResponsePreview: input.result.finalProviderResponsePreview,
    finalText: input.result.finalText,
    modelId: input.run.modelId,
    provider: input.run.provider,
    providerResponseId: input.result.providerResponseId,
    runId: input.run.runId,
    ...(input.eventsBeforeTerminal ? { eventsBeforeTerminal: [...input.eventsBeforeTerminal] } : {}),
    usage,
    usageAttributions,
    userId: input.run.userId
  });

  return completed
    ? {
        status: "completed",
        usage
      }
    : {
        status: "not_completed"
      };
}
