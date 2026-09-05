import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { estimateCostMicros, normalizeTokenUsage, type ModelTokenPricing } from "../../domain/usage";
import type { RunRepository, RunUsageAttribution } from "./runRepositoryContract";
import type { RunOutputArtifactEvent } from "./runOutputEvents";
import type { KnowledgeAnswerContractVersions } from "../knowledge/answerGroundingV5";
import type { KnowledgeAnswerV21ContractVersions } from "../knowledge/answerGroundingV21";
import type { KNOWLEDGE_ANSWER_CONTRIBUTION_CONTRACTS_V1 } from "../knowledge/answerGroundingSnapshotV40";
import type { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 } from "../knowledge/evidenceAnswerSnapshotV1";
import type { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "../knowledge/evidenceAnswerSnapshotV2";

type RunCompletionRepository = Pick<RunRepository, "completeRun" | "loadModelPricing"> &
  Pick<
    RunRepository,
    "groundKnowledgeAnswer" | "groundKnowledgeAnswerV5" | "groundKnowledgeAnswerV21" | "groundKnowledgeEvidenceAnswer"
  >;

export type KnowledgeAnswerFinalizationContracts = KnowledgeAnswerContractVersions |
  KnowledgeAnswerV21ContractVersions | typeof KNOWLEDGE_ANSWER_CONTRIBUTION_CONTRACTS_V1 |
  typeof KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 | typeof KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2;

function isKnowledgeAnswerV21Contracts(
  value: KnowledgeAnswerFinalizationContracts
): value is KnowledgeAnswerV21ContractVersions | typeof KNOWLEDGE_ANSWER_CONTRIBUTION_CONTRACTS_V1 {
  return "coverageAuditorContractVersion" in value &&
    value.draftContractVersion === 21 &&
    (value.coverageAuditorContractVersion === 6 && value.selectorContractVersion === 21 && value.settlementVersion === 6 ||
      value.coverageAuditorContractVersion === 7 && value.selectorContractVersion === 22 && value.settlementVersion === 7);
}

export type RunCompletionFinalizationResult =
  | Readonly<{
      finalText: string;
      status: "completed";
      usage: ModelRunUsage;
    }>
  | Readonly<{
      status: "not_completed";
    }>;

function hasUsablePricing(pricing: ModelTokenPricing | null): pricing is ModelTokenPricing {
  return Boolean(pricing && (pricing.inputTokenPriceMicros > 0 || pricing.outputTokenPriceMicros > 0));
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
  knowledgeAnswerContracts?: KnowledgeAnswerFinalizationContracts;
  knowledgeZeroEvidence?: true;
  outputEvents?: readonly RunOutputArtifactEvent[];
  repository: RunCompletionRepository;
  result: Readonly<{
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
  if (input.knowledgeAnswerContracts && input.knowledgeZeroEvidence) {
    throw new Error("knowledge_answer_finalization_snapshot_invalid");
  }
  let knowledgeFinalization = null;
  if (input.knowledgeZeroEvidence) {
    knowledgeFinalization = null;
  } else if (input.knowledgeAnswerContracts) {
    if ("pipeline" in input.knowledgeAnswerContracts) {
      const contract = input.knowledgeAnswerContracts;
      if (!(contract.pipeline === "evidence_answer_review_v1" && contract.composeVersion === 1 && contract.reviewVersion === 1 ||
        contract.pipeline === "evidence_answer_review_v2" && contract.composeVersion === 2 && contract.reviewVersion === 2) ||
        input.knowledgeAnswerContracts.settlementVersion !== 1 || Object.keys(input.knowledgeAnswerContracts).length !== 4) {
        throw new Error("knowledge_answer_finalization_snapshot_invalid");
      }
      if (!input.repository.groundKnowledgeEvidenceAnswer) throw new Error("knowledge_evidence_answer_finalizer_unavailable");
      knowledgeFinalization = await input.repository.groundKnowledgeEvidenceAnswer({ runId: input.run.runId, userId: input.run.userId });
    } else if (isKnowledgeAnswerV21Contracts(input.knowledgeAnswerContracts)) {
      if (!input.repository.groundKnowledgeAnswerV21) {
        throw new Error("knowledge_answer_v21_finalizer_unavailable");
      }
      knowledgeFinalization = await input.repository.groundKnowledgeAnswerV21({
        runId: input.run.runId,
        userId: input.run.userId
      });
    } else {
      if (!input.repository.groundKnowledgeAnswerV5) {
        throw new Error("knowledge_answer_v5_finalizer_unavailable");
      }
      knowledgeFinalization = await input.repository.groundKnowledgeAnswerV5({
        ...input.knowledgeAnswerContracts,
        runId: input.run.runId,
        userId: input.run.userId
      });
    }
  } else if (input.repository.groundKnowledgeAnswer) {
    knowledgeFinalization = await input.repository.groundKnowledgeAnswer({
      answer: input.result.finalText,
      runId: input.run.runId,
      userId: input.run.userId
    });
  }
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
    finalText: knowledgeFinalization?.grounding.finalText ?? input.result.finalText,
    ...(knowledgeFinalization ? { knowledgeGrounding: knowledgeFinalization } : {}),
    modelId: input.run.modelId,
    provider: input.run.provider,
    providerResponseId: input.result.providerResponseId,
    runId: input.run.runId,
    ...(input.outputEvents ? { outputEvents: [...input.outputEvents] } : {}),
    usage,
    usageAttributions,
    userId: input.run.userId
  });

  return completed
    ? {
        finalText: knowledgeFinalization?.grounding.finalText ?? input.result.finalText,
        status: "completed",
        usage
      }
    : {
        status: "not_completed"
      };
}
