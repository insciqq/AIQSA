import { RunSettlementError } from "./settlementFailure";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import {
  normalizeTokenUsage, reportedCostMicros, sumEstimatedCostMicros, sumTokenUsage, usageCostMicros, type ModelTokenPricing
} from "../../domain/usage";
import { providerModelUsageCostMicros } from "../usage";
import type { RunRepository, RunUsageAttribution } from "./runRepositoryContract";
import type { RunOutputArtifactEvent } from "./runOutputEvents";
import { logRunPersistence, settleRunWrite } from "./runObservability";
import type { DbTransactionTiming } from "../observability/transactionTiming";
import type { KnowledgeAnswerContractVersions } from "../knowledge/answerGroundingV5";
import type { KnowledgeAnswerV21ContractVersions } from "../knowledge/answerGroundingV21";
import type { KNOWLEDGE_ANSWER_CONTRIBUTION_CONTRACTS_V1 } from "../knowledge/answerGroundingSnapshotV40";
import type { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 } from "../knowledge/evidenceAnswerSnapshotV1";
import type { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "../knowledge/evidenceAnswerSnapshotV2";

type RunCompletionRepository = Pick<
  RunRepository, "completeRun" | "loadModelPricing" | "loadProviderModelCostBasis" | "publishRunAnswer"
> &
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

const NO_PRICES: ModelTokenPricing = { inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: null };

/**
 * Usage priced from a model's stored answer prices: its tokens, plus each web
 * search its provider reported at the model's per-search price (native search
 * in answers, Search engine calls). The repository prices answer-class rows,
 * which include every Search engine.
 */
export async function usageWithEstimatedCost(
  repository: Pick<RunRepository, "loadModelPricing">,
  input: Readonly<{
    providerModelId?: string;
    modelId: string;
    provider: string;
    usage: ModelRunUsage;
  }>
): Promise<ModelRunUsage> {
  const normalizedUsage = normalizeTokenUsage(input.usage);
  const pricing = input.providerModelId
    ? await repository.loadModelPricing(input.provider, input.modelId, input.providerModelId).catch(error => { throw new RunSettlementError("accounting", error); })
    : await repository.loadModelPricing(input.provider, input.modelId).catch(error => { throw new RunSettlementError("accounting", error); });
  const estimatedCostMicros = usageCostMicros({ reportedCostUsd: null, usage: normalizedUsage, pricing: pricing ?? NO_PRICES, modelClass: "answer" });

  return {
    ...normalizedUsage,
    estimatedCostMicros
  };
}

/**
 * Whether an attribution's cost is settled, so every rewrite keeps it: a
 * Knowledge retrieval or Search engine call with a cost (reported, or recorded
 * by an earlier write of its row), or an answer call whose provider reported
 * its charge (`costReported`). Unsettled calls are priced when their row is
 * written: Knowledge calls from their deployment's class prices (the shared
 * cost rule), Search and answer calls from the model's token prices plus its
 * per-search fee.
 */
export function hasSettledRunUsageCost(attribution: RunUsageAttribution): boolean {
  if (attribution.estimatedCostMicros === undefined) return false;
  return attribution.purpose === "chat_answer" ? attribution.costReported === true
    : attribution.purpose === "knowledge_retrieval" || attribution.purpose === "web_search";
}

/** The cost fields of an answer call whose provider reported its charge; none
 * when it reported no usable amount, so the call is priced from token prices. */
export function reportedAnswerCost(costUsd: number | undefined): Pick<RunUsageAttribution, "costReported" | "estimatedCostMicros"> {
  const micros = costUsd === undefined ? null : reportedCostMicros(costUsd);
  return micros === null ? {} : { costReported: true, estimatedCostMicros: micros };
}

// Durable cost columns are signed 32-bit integers; a larger sum is unknown.
const MAX_COST_MICROS = 2_147_483_647;

/**
 * One attribution per purpose, provider, model and deployment, summing usage
 * and operation counts. Settled costs are kept: calls with a known settled
 * cost, with an unknown one and calls still to be priced group apart, so a
 * settled cost is never lost, merged into an unknown one or priced again.
 */
export function groupedUsageAttributions(attributions: readonly RunUsageAttribution[]): RunUsageAttribution[] {
  const grouped = new Map<string, { attribution: RunUsageAttribution; costs: (number | null)[] | null; usages: ModelRunUsage[] }>();
  for (const attribution of attributions) {
    const settled = hasSettledRunUsageCost(attribution);
    const cost = !settled ? "" : attribution.estimatedCostMicros === null ? "unknown" : "known";
    const key = [attribution.purpose, attribution.provider, attribution.modelId, attribution.providerModelId ?? "", cost].join("\u0000");
    const current = grouped.get(key);
    if (current) {
      current.usages.push(attribution.usage);
      current.costs?.push(attribution.estimatedCostMicros ?? null);
      current.attribution.operationCount = current.attribution.operationCount == null || attribution.operationCount == null
        ? null : current.attribution.operationCount + attribution.operationCount;
      continue;
    }
    grouped.set(key, {
      attribution: {
        ...(attribution.providerModelId ? { providerModelId: attribution.providerModelId } : {}),
        ...(settled && attribution.costReported ? { costReported: true as const } : {}),
        operationCount: attribution.operationCount ?? null,
        modelId: attribution.modelId,
        provider: attribution.provider,
        purpose: attribution.purpose,
        usage: attribution.usage
      },
      costs: settled ? [attribution.estimatedCostMicros ?? null] : null,
      usages: [attribution.usage]
    });
  }
  return [...grouped.values()].map(({ attribution, costs, usages }) => {
    const total = costs ? sumEstimatedCostMicros(costs) : null;
    return {
      ...attribution,
      usage: sumTokenUsage(usages),
      ...(costs ? { estimatedCostMicros: total !== null && total <= MAX_COST_MICROS ? total : null } : {})
    };
  });
}

/** The cost of an unsettled attribution, priced now: a Knowledge call with
 * the shared cost rule from its deployment's stored class prices; a Search or
 * answer call from its model's answer prices and per-search fee. */
async function unsettledUsageCost(
  repository: Pick<RunRepository, "loadModelPricing" | "loadProviderModelCostBasis">,
  attribution: RunUsageAttribution
): Promise<number | null> {
  if (attribution.purpose !== "knowledge_retrieval") {
    return (await usageWithEstimatedCost(repository, {
      ...(attribution.providerModelId ? { providerModelId: attribution.providerModelId } : {}),
      modelId: attribution.modelId,
      provider: attribution.provider,
      usage: attribution.usage
    })).estimatedCostMicros ?? null;
  }
  if (!attribution.providerModelId) return null;
  const basis = await repository.loadProviderModelCostBasis(attribution.providerModelId)
    .catch(error => { throw new RunSettlementError("accounting", error); });
  return providerModelUsageCostMicros({ basis, reportedCostUsd: null, usage: attribution.usage });
}

export async function usageAttributionsWithEstimatedCost(
  repository: Pick<RunRepository, "loadModelPricing" | "loadProviderModelCostBasis">,
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

export async function finalizeRunCompletion(input: Readonly<{
  followupRevision?: number;
  /** Called only after the final, grounded text has been durably published.
   * Full terminal persistence still waits for this obligation to finish. */
  afterAnswerPublished?: (answer: Readonly<{ finalText: string; usage: ModelRunUsage }>) => Promise<void>;
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
      knowledgeFinalization = await input.repository.groundKnowledgeEvidenceAnswer({ runId: input.run.runId, userId: input.run.userId,
        ...(input.followupRevision ? { followupRevision: input.followupRevision } : {}) });
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
            purpose: "chat_answer",
            usage: input.result.usage
          }
        ]
  );
  const attributedCosts = usageAttributions
    .map((attribution) => attribution.estimatedCostMicros);
  const usage = {
    ...normalizeTokenUsage(input.result.usage),
    estimatedCostMicros:
      sumEstimatedCostMicros(attributedCosts)
  };
  const completion: Parameters<RunRepository["completeRun"]>[0] = {
    ...(input.followupRevision !== undefined ? { followupRevision: input.followupRevision } : {}),
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
  };
  if (input.afterAnswerPublished) {
    if (!input.repository.publishRunAnswer) throw new RunSettlementError("publication", undefined);
    if (!(await input.repository.publishRunAnswer(completion).catch(error => { throw new RunSettlementError("publication", error); }))) return { status: "not_completed" };
    await input.afterAnswerPublished({ finalText: completion.finalText, usage });
  }
  let completed: boolean;
  let timing: DbTransactionTiming | undefined;
  try {
    ({ value: completed, timing } = await settleRunWrite(() => input.repository.completeRun(completion)));
  } catch (error) {
    logRunPersistence(input.run.runId, "complete", "unconfirmed", error);
    throw new RunSettlementError("completion", error);
  }
  logRunPersistence(input.run.runId, "complete", completed ? "confirmed" : "not_applied", undefined, timing);

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
