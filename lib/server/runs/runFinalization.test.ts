import { describe, expect, it, vi } from "vitest";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1 } from "../knowledge/evidenceAnswerSnapshotV1";
import { KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2 } from "../knowledge/evidenceAnswerSnapshotV2";
import type { RunRepository } from "./runRepositoryContract";
import {
  finalizeRunCompletion,
  groupedUsageAttributions,
  reportedAnswerCost,
  usageAttributionsWithEstimatedCost,
  usageWithEstimatedCost
} from "./runFinalization";

const rawUsage: ModelRunUsage = {
  cachedInputTokens: 0,
  cacheWriteInputTokens: 3,
  inputTokens: 10,
  outputTokens: 5,
  reasoningTokens: 2
};

function completionInput(repository: Pick<RunRepository, "completeRun" | "loadModelPricing" | "publishRunAnswer"> &
  Partial<Pick<RunRepository, "loadProviderModelCostBasis">>) {
  return {
    repository: { loadProviderModelCostBasis: async () => null, ...repository },
    result: {
      finalText: "Final answer",
      providerResponseId: "provider-response-1",
      usage: rawUsage
    },
    run: {
      assistantMessageId: "assistant-1",
      chatId: "chat-1",
      modelId: "fake-qsa",
      provider: "fake",
      runId: "run-1",
      userId: "user-1"
    }
  };
}

describe("run finalization", () => {
  it("publishes the grounded answer before cleanup and settles the same accounting afterwards", async () => {
    const order: string[] = [];
    const grounding = { finalText: "Reviewed answer [K1].", finalAnswerHash: "a".repeat(64),
      originalAnswerHash: "b".repeat(64), receiptHash: "c".repeat(64), sessionId: "session-1",
      outcome: "answered" as const, version: 5 as const };
    const groundKnowledgeAnswer = vi.fn(async () => ({ grounding }));
    const publishRunAnswer = vi.fn(async () => { order.push("publish"); return true; });
    const completeRun = vi.fn<RunRepository["completeRun"]>(async () => { order.push("complete"); return true; });
    const repository = { completeRun, publishRunAnswer, groundKnowledgeAnswer, loadModelPricing: async () => null };
    const result = await finalizeRunCompletion({ ...completionInput(repository), afterAnswerPublished: async (answer) => {
      expect(answer.finalText).toBe(grounding.finalText);
      expect(completeRun).not.toHaveBeenCalled();
      order.push("handoff");
    } });
    expect(result).toMatchObject({ status: "completed", finalText: grounding.finalText });
    expect(order).toEqual(["publish", "handoff", "complete"]);
    expect(publishRunAnswer.mock.calls[0]).toEqual(completeRun.mock.calls[0]);
    expect(groundKnowledgeAnswer).toHaveBeenCalledOnce();
  });

  it("does not announce an answer or settle a run when publication loses to another writer", async () => {
    const completeRun = vi.fn(async () => true);
    const afterAnswerPublished = vi.fn(async () => undefined);
    const repository = { completeRun, publishRunAnswer: vi.fn(async () => false), loadModelPricing: async () => null };
    await expect(finalizeRunCompletion({ ...completionInput(repository), afterAnswerPublished }))
      .resolves.toEqual({ status: "not_completed" });
    expect(afterAnswerPublished).not.toHaveBeenCalled();
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("retains publication when cleanup fails without declaring full completion", async () => {
    const completeRun = vi.fn(async () => true);
    const publishRunAnswer = vi.fn(async () => true);
    const repository = { completeRun, publishRunAnswer, loadModelPricing: async () => null };
    await expect(finalizeRunCompletion({ ...completionInput(repository), afterAnswerPublished: async () => {
      throw new Error("workspace_execution_cleanup_failed");
    } })).rejects.toThrow("workspace_execution_cleanup_failed");
    expect(publishRunAnswer).toHaveBeenCalledOnce();
    expect(completeRun).not.toHaveBeenCalled();
  });

  it.each([KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V1, KNOWLEDGE_EVIDENCE_ANSWER_CONTRACTS_V2])("routes $pipeline to its settled finalizer and rejects altered contracts", async contracts => {
    const completeRun = vi.fn<RunRepository["completeRun"]>(async () => true);
    const grounding = { finalText: "Reviewed answer [K1].", finalAnswerHash: "a".repeat(64),
      originalAnswerHash: "b".repeat(64), receiptHash: "c".repeat(64), sessionId: "session-1", outcome: "answered" as const, version: 5 as const };
    const groundKnowledgeEvidenceAnswer = vi.fn(async () => ({ grounding }));
    const groundKnowledgeAnswerV21 = vi.fn();
    const repository = { completeRun, groundKnowledgeEvidenceAnswer, groundKnowledgeAnswerV21, loadModelPricing: async () => null };
    const input = { ...completionInput(repository), knowledgeAnswerContracts: contracts };
    expect(await finalizeRunCompletion(input)).toMatchObject({ finalText: grounding.finalText, status: "completed" });
    expect(groundKnowledgeEvidenceAnswer).toHaveBeenCalledWith({ runId: "run-1", userId: "user-1" });
    expect(groundKnowledgeAnswerV21).not.toHaveBeenCalled();
    const contractsWithExtraField = { ...contracts, extra: true };
    await expect(finalizeRunCompletion({ ...input, knowledgeAnswerContracts: contractsWithExtraField }))
      .rejects.toThrow("knowledge_answer_finalization_snapshot_invalid");
    await expect(finalizeRunCompletion({ ...input, knowledgeAnswerContracts: {
      ...contracts, reviewVersion: contracts.reviewVersion === 1 ? 2 : 1
    } as typeof contracts })).rejects.toThrow("knowledge_answer_finalization_snapshot_invalid");
    expect(completeRun).toHaveBeenCalledOnce();
  });

  it.each(["publication", "completion", "accounting"] as const)("attributes %s persistence failures without changing reported usage", async stage => {
    const privateError = new Error("PRIVATE header token signed-url");
    const completeRun = vi.fn(async () => { if (stage === "completion") throw privateError; return true; });
    const publishRunAnswer = vi.fn(async () => { if (stage === "publication") throw privateError; return true; });
    const loadModelPricing = vi.fn(async () => { if (stage === "accounting") throw privateError; return null; });
    const afterAnswerPublished = vi.fn(async () => undefined);
    const result = finalizeRunCompletion({ ...completionInput({ completeRun, publishRunAnswer, loadModelPricing }),
      afterAnswerPublished });
    await expect(result).rejects.toMatchObject({ code: stage === "publication" ? "run_result_publication_failed"
      : stage === "accounting" ? "run_usage_persistence_failed" : "run_completion_persistence_failed", stage });
    await expect(result).rejects.not.toThrow("PRIVATE");
    if (stage === "completion") {
      expect(publishRunAnswer).toHaveBeenCalledOnce();
      expect(afterAnswerPublished).toHaveBeenCalledOnce();
      expect(completeRun.mock.calls[0]).toEqual([expect.objectContaining({ usage: expect.objectContaining(rawUsage) })]);
    } else expect(completeRun).not.toHaveBeenCalled();
  });

  it("normalizes usage and records null cost when pricing is unavailable", async () => {
    const loadModelPricing = vi.fn(async () => null);

    const usage = await usageWithEstimatedCost(
      { loadModelPricing },
      {
        modelId: "fake-qsa",
        provider: "fake",
        usage: rawUsage
      }
    );

    expect(loadModelPricing).toHaveBeenCalledWith("fake", "fake-qsa");
    expect(usage).toEqual({
      completeness: "complete",
      cachedInputTokens: 0,
      cacheWriteInputTokens: 3,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15
    });
  });

  it("persists the cached-input cost snapshot at finalization", async () => {
    const completeRun = vi.fn(async () => true);
    const repository = { completeRun, loadModelPricing: async () => ({
      inputTokenPriceUsdPerMillion: 2, cachedInputTokenPriceUsdPerMillion: 0.2, outputTokenPriceUsdPerMillion: 10
    }) };
    const input = completionInput(repository);
    const result = await finalizeRunCompletion({ ...input, result: { ...input.result,
      usage: { inputTokens: 10_000, cachedInputTokens: 8_000, outputTokens: 1_000, totalTokens: 11_000 } } });
    expect(result).toMatchObject({ status: "completed", usage: { estimatedCostMicros: 15_600 } });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({ estimatedCostMicros: 15_600 }));
  });

  it("uses configured pricing after normalizing provider usage", async () => {
    const usage = await usageWithEstimatedCost(
      {
        loadModelPricing: async () => ({
          inputTokenPriceUsdPerMillion: 2,
          outputTokenPriceUsdPerMillion: 5,
          reasoningTokenPriceUsdPerMillion: 7
        })
      },
      {
        modelId: "fake-qsa",
        provider: "fake",
        usage: rawUsage
      }
    );

    expect(usage).toEqual({
      completeness: "complete",
      cachedInputTokens: 0,
      cacheWriteInputTokens: 3,
      estimatedCostMicros: 49,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15
    });
  });

  it("returns completed with the exact normalized usage only when the guarded write wins", async () => {
    const completeRun = vi.fn<RunRepository["completeRun"]>(async () => true);
    const repository = {
      completeRun,
      loadModelPricing: async () => ({
        inputTokenPriceUsdPerMillion: 2,
        outputTokenPriceUsdPerMillion: 5,
        reasoningTokenPriceUsdPerMillion: 7
      })
    };

    const result = await finalizeRunCompletion(completionInput(repository));

    const usage = {
      completeness: "complete",
      cachedInputTokens: 0,
      cacheWriteInputTokens: 3,
      estimatedCostMicros: 49,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15
    };
    expect(result).toEqual({ finalText: "Final answer", status: "completed", usage });
    expect(completeRun).toHaveBeenCalledWith({
      assistantMessageId: "assistant-1",
      chatId: "chat-1",
      estimatedCostMicros: 49,
      finalText: "Final answer",
      modelId: "fake-qsa",
      provider: "fake",
      providerResponseId: "provider-response-1",
      runId: "run-1",
      usage,
      usageAttributions: [
        {
          estimatedCostMicros: 49,
          modelId: "fake-qsa",
          provider: "fake",
          purpose: "chat_answer",
          usage: {
            completeness: "complete",
      cachedInputTokens: 0,
            cacheWriteInputTokens: 3,
            inputTokens: 10,
            outputTokens: 5,
            reasoningTokens: 2,
            totalTokens: 15
          }
        }
      ],
      userId: "user-1"
    });
  });

  it("returns not_completed when another terminal writer already won", async () => {
    const completeRun = vi.fn<RunRepository["completeRun"]>(async () => false);
    const repository = {
      completeRun,
      loadModelPricing: async () => null
    };

    const result = await finalizeRunCompletion(completionInput(repository));

    expect(result).toEqual({ status: "not_completed" });
    expect(completeRun).toHaveBeenCalledOnce();
  });

  it("persists only the structural Knowledge answer settlement", async () => {
    const completeRun = vi.fn<RunRepository["completeRun"]>(async () => true);
    const grounding = {
      finalAnswerHash: "b".repeat(64),
      finalText: "I couldn't find enough support in the selected sources to answer reliably.",
      originalAnswerHash: "a".repeat(64),
      outcome: "insufficient_evidence" as const,
      receiptHash: "c".repeat(64),
      sessionId: "evidence-session-1",
      version: 5 as const
    };
    const groundKnowledgeAnswer = vi.fn(async () => ({ grounding }));
    const repository = {
      completeRun,
      groundKnowledgeAnswer,
      loadModelPricing: async () => null
    };

    const result = await finalizeRunCompletion({
      ...completionInput(repository),
      result: { ...completionInput(repository).result, finalText: "Unsupported [K99]." }
    });

    expect(result).toMatchObject({ finalText: grounding.finalText, status: "completed" });
    expect(groundKnowledgeAnswer).toHaveBeenCalledWith({
      answer: "Unsupported [K99].",
      runId: "run-1",
      userId: "user-1"
    });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({
      finalText: grounding.finalText,
      knowledgeGrounding: expect.objectContaining({ grounding })
    }));
  });

  it("finalizes V5 from the immutable contract snapshot without invoking the legacy answer path", async () => {
    const completeRun = vi.fn<RunRepository["completeRun"]>(async () => true);
    const grounding = {
      contradictedClaimCount: 0,
      draftClaimCount: 1,
      draftContractVersion: 7 as const,
      draftHash: "a".repeat(64),
      draftOperationId: "draft-operation-1",
      durations: { draftMs: 10, selectorMs: 8 },
      evidenceReceiptHash: "b".repeat(64),
      fallbackReason: null,
      finalAnswerHash: "c".repeat(64),
      finalText: "Supported claim. [K1]",
      finalizationMode: "selected_claims" as const,
      groundingStatus: "verified" as const,
      originalAnswerHash: "d".repeat(64),
      outcome: "answered" as const,
      providerRequestIds: { draft: "provider-draft-1", selector: "provider-selector-1" },
      receiptHash: "b".repeat(64),
      requestCoverage: "complete" as const,
      selectorContractVersion: 5 as const,
      selectorHash: "e".repeat(64),
      selectorOperationId: "selector-operation-1",
      sessionId: "evidence-session-1",
      supportedClaimCount: 1,
      unsupportedClaimCount: 0,
      usage: {
        draft: { cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, totalTokens: 15 },
        selector: { cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 8, outputTokens: 4, reasoningTokens: 0, totalTokens: 12 }
      },
      version: 7 as const
    };
    const groundKnowledgeAnswer = vi.fn(async () => null);
    const groundKnowledgeAnswerV5 = vi.fn(async () => ({ grounding }));
    const repository = {
      completeRun,
      groundKnowledgeAnswer,
      groundKnowledgeAnswerV5,
      loadModelPricing: async () => null
    };

    const result = await finalizeRunCompletion({
      ...completionInput(repository),
      knowledgeAnswerContracts: {
        draftContractVersion: 7,
        selectorContractVersion: 5
      },
      result: { ...completionInput(repository).result, finalText: "hidden structured result" }
    });

    expect(result).toMatchObject({ finalText: grounding.finalText, status: "completed" });
    expect(groundKnowledgeAnswer).not.toHaveBeenCalled();
    expect(groundKnowledgeAnswerV5).toHaveBeenCalledWith({
      draftContractVersion: 7,
      runId: "run-1",
      selectorContractVersion: 5,
      userId: "user-1"
    });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({
      finalText: grounding.finalText,
      knowledgeGrounding: { grounding }
    }));
  });

  it("routes the exact V21 Scope contract snapshot only to its finalizer", async () => {
    const completeRun = vi.fn<RunRepository["completeRun"]>(async () => true);
    const grounding = {
      answerBindingFingerprint: "0".repeat(64),
      contracts: {
        coverageAuditorContractVersion: 3 as const,
        draftContractVersion: 21 as const,
        selectorContractVersion: 18 as const,
        settlementVersion: 6 as const
      },
      coverage: {
        coveredDimensionCount: 1,
        missingDimensionCount: 0,
        selectorPayloadHash: "a".repeat(64),
        status: "accepted" as const
      },
      coverageScope: {
        dimensionCount: 1,
        payloadHash: "2".repeat(64),
        status: "accepted" as const
      },
      correctionAttempted: false,
      correctionSucceeded: false,
      contradictedClaimCount: 0,
      draftClaimCount: 1,
      evidenceReceiptHash: "b".repeat(64),
      executionPolicy: {
        auditorReasoningEffort: "high",
        draftReasoningEffort: "low",
        egressDestination: "answer_provider" as const,
        overriddenRoles: ["auditor"] as const,
        providerBindingKey: "answer" as const,
        selectorReasoningEffort: "low",
        supplementReasoningEffort: "low",
        version: 1 as const
      },
      executionPolicyFingerprint: "3".repeat(64),
      fallbackReason: null,
      finalAnswerHash: "c".repeat(64),
      finalText: "Audited supported claim. [K1]",
      finalizationMode: "selected_claims" as const,
      groundingStatus: "verified" as const,
      modelPinFingerprint: "d".repeat(64),
      operations: [],
      originalAnswerHash: "e".repeat(64),
      outcome: "answered" as const,
      providerPinFingerprint: "f".repeat(64),
      receiptHash: "1".repeat(64),
      requestCoverage: "complete" as const,
      scopeRepairAttempted: false,
      scopeRepairSucceeded: false,
      selectorRepairAttempted: false,
      selectorRepairSucceeded: false,
      sessionId: "evidence-session-1",
      supportedClaimCount: 1,
      unsupportedClaimCount: 0,
      version: 19 as const
    };
    const groundKnowledgeAnswerV5 = vi.fn<NonNullable<
      RunRepository["groundKnowledgeAnswerV5"]
    >>();
    const groundKnowledgeAnswerV21 = vi.fn(async () => ({ grounding }));
    const repository = {
      completeRun,
      groundKnowledgeAnswerV5,
      groundKnowledgeAnswerV21,
      loadModelPricing: async () => null
    };

    const result = await finalizeRunCompletion({
      ...completionInput(repository),
      knowledgeAnswerContracts: {
        coverageAuditorContractVersion: 6,
        draftContractVersion: 21,
        selectorContractVersion: 21,
        settlementVersion: 6
      },
      result: { ...completionInput(repository).result, finalText: "hidden operation output" }
    });

    expect(result).toMatchObject({ finalText: grounding.finalText, status: "completed" });
    expect(groundKnowledgeAnswerV5).not.toHaveBeenCalled();
    expect(groundKnowledgeAnswerV21).toHaveBeenCalledWith({
      runId: "run-1",
      userId: "user-1"
    });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({
      finalText: grounding.finalText,
      knowledgeGrounding: { grounding }
    }));
  });
});

describe("web search fees in run attributions", () => {
  const tokens = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
  const pricing = { inputTokenPriceUsdPerMillion: 2, outputTokenPriceUsdPerMillion: 10, webSearchPriceUsdPerThousand: 10 };
  const loadProviderModelCostBasis = vi.fn(async () => null);
  const sonar = { modelId: "perplexity/sonar-pro-search", provider: "openrouter", purpose: "web_search" as const };
  const claude = { modelId: "claude-sonnet-5", provider: "anthropic", purpose: "web_search" as const };

  it("charges an answer's native searches at the answer model's per-search price", async () => {
    const loadModelPricing = vi.fn(async () => pricing);
    const [answer] = await usageAttributionsWithEstimatedCost({ loadModelPricing, loadProviderModelCostBasis }, [{ modelId: "claude-opus-5-5",
      provider: "anthropic", purpose: "chat_answer", usage: { ...tokens, webSearchCount: 2 } }]);
    // Tokens $0.003 plus two searches at one cent each.
    expect(answer).toMatchObject({ estimatedCostMicros: 23_000, purpose: "chat_answer", usage: { webSearchCount: 2 } });
    expect(loadModelPricing).toHaveBeenCalledWith("anthropic", "claude-opus-5-5");
  });

  it("keeps a Search call's settled reported cost and prices the rest from the engine's tokens plus its per-search fee", async () => {
    const loadModelPricing = vi.fn(async () => pricing);
    const attributions = await usageAttributionsWithEstimatedCost({ loadModelPricing, loadProviderModelCostBasis }, [
      { ...sonar, estimatedCostMicros: 14_200, usage: tokens },
      { ...claude, usage: { ...tokens, webSearchCount: 3 } },
      { modelId: "deepseek-v4-pro", provider: "deepseek", purpose: "web_search", usage: { ...tokens, webSearchCount: 1 } },
      // An Agent search attempt names its deployment.
      { ...claude, providerModelId: "claude-deployment", usage: { ...tokens, webSearchCount: 1 } }
    ]);
    expect(attributions.map(({ estimatedCostMicros }) => estimatedCostMicros)).toEqual([14_200, 33_000, 13_000, 13_000]);
    expect(loadModelPricing.mock.calls).toEqual([["anthropic", "claude-sonnet-5"], ["deepseek", "deepseek-v4-pro"],
      ["anthropic", "claude-sonnet-5", "claude-deployment"]]);
    expect(loadProviderModelCostBasis).not.toHaveBeenCalled();
    // A missing per-search price charges tokens only; incomplete usage stays unknown.
    const tokensOnly = await usageAttributionsWithEstimatedCost({ loadModelPricing: async () => ({ ...pricing, webSearchPriceUsdPerThousand: null }),
      loadProviderModelCostBasis }, [{ ...claude, usage: { ...tokens, webSearchCount: 3 } },
      { ...sonar, usage: { inputTokens: 2_000, outputTokens: 200, totalTokens: 2_200, completeness: "partial" } }]);
    expect(tokensOnly.map(({ estimatedCostMicros }) => estimatedCostMicros)).toEqual([3_000, null]);
  });

  it("never re-prices a Search row's settled cost when the run's rows are grouped again", () => {
    const grouped = groupedUsageAttributions([
      { ...sonar, operationCount: 1, estimatedCostMicros: 14_200, usage: tokens },
      { ...sonar, operationCount: 1, estimatedCostMicros: 9_800, usage: tokens },
      { ...sonar, operationCount: 1, usage: { inputTokens: 1, completeness: "partial" } },
      { ...claude, operationCount: 1, usage: { ...tokens, webSearchCount: 2 } },
      { ...claude, operationCount: 1, usage: { ...tokens, webSearchCount: 1 } }
    ]);
    expect(grouped.map(({ estimatedCostMicros, modelId, operationCount, usage }) =>
      [modelId, operationCount, usage.webSearchCount, estimatedCostMicros])).toEqual([
      ["perplexity/sonar-pro-search", 2, undefined, 24_000],
      ["perplexity/sonar-pro-search", 1, undefined, undefined],
      ["claude-sonnet-5", 2, 3, undefined]
    ]);
    // Rows read back after a write (recovery) keep the cost each was written with, and their search count.
    const readBack = [{ ...grouped[0]!, estimatedCostMicros: 24_000 }, { ...grouped[1]!, estimatedCostMicros: null },
      { ...grouped[2]!, estimatedCostMicros: 63_000 }];
    expect(groupedUsageAttributions(readBack)).toEqual(readBack);
  });
});

describe("run usage attribution cost", () => {
  const embedding = { modelId: "qwen/qwen3-embedding-8b", provider: "openrouter",
    providerModelId: "embedding-deployment", purpose: "knowledge_retrieval" as const };
  const reranker = { modelId: "voyageai/rerank-2.5", provider: "openrouter",
    providerModelId: "reranker-deployment", purpose: "knowledge_retrieval" as const };
  const answer = { modelId: "answer", provider: "openai", purpose: "chat_answer" as const };

  it("keeps settled Knowledge costs apart from calls still to price and never merges known into unknown", () => {
    const grouped = groupedUsageAttributions([
      { ...embedding, operationCount: 1, estimatedCostMicros: 3, usage: { inputTokens: 5, totalTokens: 5 } },
      { ...embedding, operationCount: 1, estimatedCostMicros: 4, usage: { inputTokens: 7, totalTokens: 7 } },
      { ...embedding, operationCount: 1, usage: { inputTokens: 2, totalTokens: 2 } },
      { ...embedding, operationCount: 1, estimatedCostMicros: null, usage: { inputTokens: 1, totalTokens: 1 } },
      { ...reranker, operationCount: 1, estimatedCostMicros: 0, usage: { totalTokens: 2 } },
      // Answer rows are priced whenever written: a stored cost never splits or settles them.
      { ...answer, operationCount: 1, estimatedCostMicros: 9, usage: { inputTokens: 1, outputTokens: 1 } },
      { ...answer, operationCount: 1, usage: { inputTokens: 1, outputTokens: 1 } }
    ]);
    expect(grouped.map(({ estimatedCostMicros, modelId, operationCount, usage }) =>
      [modelId, operationCount, usage.inputTokens ?? usage.totalTokens, estimatedCostMicros]))
      .toEqual([
        ["qwen/qwen3-embedding-8b", 2, 12, 7],
        ["qwen/qwen3-embedding-8b", 1, 2, undefined],
        ["qwen/qwen3-embedding-8b", 1, 1, null],
        ["voyageai/rerank-2.5", 1, 2, 0],
        ["answer", 2, 2, undefined]
      ]);
    expect(grouped.every((attribution) => attribution.purpose !== "knowledge_retrieval" ||
      attribution.providerModelId !== undefined)).toBe(true);
    // Regrouping persisted rows with nothing new keeps every row and cost.
    expect(groupedUsageAttributions(grouped)).toEqual(grouped);
    expect(groupedUsageAttributions([
      { ...embedding, estimatedCostMicros: 2_147_483_000, usage: { inputTokens: 1 } },
      { ...embedding, estimatedCostMicros: 1_000, usage: { inputTokens: 1 } }
    ])[0]!.estimatedCostMicros).toBeNull();
  });

  it("keeps a settled Knowledge cost, prices the rest from the deployment's class and answers from token prices", async () => {
    const loadModelPricing = vi.fn(async () => ({ inputTokenPriceUsdPerMillion: 2, outputTokenPriceUsdPerMillion: 10 }));
    const loadProviderModelCostBasis = vi.fn(async (providerModelId: string) => providerModelId === embedding.providerModelId
      ? { modelClass: "embedding" as const, pricing: { inputTokenPriceUsdPerMillion: 0.13, outputTokenPriceUsdPerMillion: null } }
      : null);
    const priced = await usageAttributionsWithEstimatedCost({ loadModelPricing, loadProviderModelCostBasis }, [
      { ...embedding, estimatedCostMicros: 7, usage: { inputTokens: 12 } },
      { ...embedding, usage: { inputTokens: 1_000_000 } },
      // A deployment that no longer exists has no prices.
      { ...reranker, usage: { totalTokens: 2 } },
      { ...answer, usage: { inputTokens: 1_000, outputTokens: 100 } }
    ]);
    expect(priced.map((attribution) => [attribution.providerModelId, attribution.estimatedCostMicros])).toEqual([
      ["embedding-deployment", 7], ["embedding-deployment", 130_000], ["reranker-deployment", null], [undefined, 3_000]
    ]);
    expect(loadProviderModelCostBasis.mock.calls).toEqual([["embedding-deployment"], ["reranker-deployment"]]);
    expect(loadModelPricing).toHaveBeenCalledExactlyOnceWith("openai", "answer");

    const privateError = new Error("PRIVATE connection detail");
    await expect(usageAttributionsWithEstimatedCost({ loadModelPricing, loadProviderModelCostBasis: async () => {
      throw privateError;
    } }, [{ ...embedding, usage: { inputTokens: 1 } }])).rejects.toMatchObject({ stage: "accounting" });
  });
});

describe("reported answer costs", () => {
  const answer = { modelId: "deepseek/deepseek-v4.1-flash", provider: "openrouter", purpose: "chat_answer" as const };
  const tokens = { inputTokens: 1_000, outputTokens: 100, totalTokens: 1_100 };
  const pricing = { inputTokenPriceUsdPerMillion: 2, outputTokenPriceUsdPerMillion: 10 };

  it("settles an answer call at exactly the reported charge, or prices it from tokens without a usable one", () => {
    expect(reportedAnswerCost(0.000123)).toEqual({ costReported: true, estimatedCostMicros: 123 });
    expect(reportedAnswerCost(0.0001302)).toEqual({ costReported: true, estimatedCostMicros: 130 });
    expect(reportedAnswerCost(0.0000005)).toEqual({ costReported: true, estimatedCostMicros: 1 });
    expect(reportedAnswerCost(0)).toEqual({ costReported: true, estimatedCostMicros: 0 });
    for (const unusable of [undefined, -1, Number.NaN, 2_148]) expect(reportedAnswerCost(unusable)).toEqual({});
  });

  it("sums reported calls apart from token-priced ones and keeps them through every regrouping", () => {
    const grouped = groupedUsageAttributions([
      { ...answer, ...reportedAnswerCost(0.000123), operationCount: 1, usage: tokens },
      { ...answer, operationCount: 1, usage: tokens },
      { ...answer, ...reportedAnswerCost(0.000077), operationCount: 1, usage: tokens },
      // A stored cost without a reported charge never settles an answer row.
      { ...answer, estimatedCostMicros: 9, operationCount: 1, usage: tokens }
    ]);
    expect(grouped).toEqual([
      { ...answer, costReported: true, estimatedCostMicros: 200, operationCount: 2, usage: expect.objectContaining({ inputTokens: 2_000 }) },
      { ...answer, operationCount: 2, usage: expect.objectContaining({ inputTokens: 2_000 }) }
    ]);
    expect(groupedUsageAttributions(grouped)).toEqual(grouped);
  });

  it("charges reported calls their reported cost and prices only the rest from token prices", async () => {
    const loadModelPricing = vi.fn(async () => pricing);
    const loadProviderModelCostBasis = vi.fn(async () => null);
    const priced = await usageAttributionsWithEstimatedCost({ loadModelPricing, loadProviderModelCostBasis }, groupedUsageAttributions([
      { ...answer, ...reportedAnswerCost(0.000123), operationCount: 1, usage: tokens },
      { ...answer, operationCount: 1, usage: tokens }
    ]));
    expect(priced.map(({ costReported, estimatedCostMicros }) => [costReported, estimatedCostMicros]))
      .toEqual([[true, 123], [undefined, 3_000]]);
    expect(loadModelPricing).toHaveBeenCalledExactlyOnceWith("openrouter", "deepseek/deepseek-v4.1-flash");
    expect(loadProviderModelCostBasis).not.toHaveBeenCalled();
  });

  it("completes a run at the sum of its reported answer costs", async () => {
    const completeRun = vi.fn(async () => true);
    const loadModelPricing = vi.fn(async () => pricing);
    const input = completionInput({ completeRun, loadModelPricing, publishRunAnswer: vi.fn(async () => true) });
    const result = await finalizeRunCompletion({ ...input, run: { ...input.run, ...answer }, result: { ...input.result,
      usageAttributions: groupedUsageAttributions([
        { ...answer, ...reportedAnswerCost(0.00041), operationCount: 1, usage: tokens },
        { ...answer, ...reportedAnswerCost(0.000013), operationCount: 1, usage: tokens }
      ]) } });
    expect(result).toMatchObject({ status: "completed", usage: { estimatedCostMicros: 423 } });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({ estimatedCostMicros: 423,
      usageAttributions: [expect.objectContaining({ costReported: true, estimatedCostMicros: 423, operationCount: 2 })] }));
    expect(loadModelPricing).not.toHaveBeenCalled();
  });
});
