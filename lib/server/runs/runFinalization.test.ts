import { describe, expect, it, vi } from "vitest";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import type { RunRepository } from "./runRepositoryContract";
import {
  finalizeRunCompletion,
  usageWithEstimatedCost
} from "./runFinalization";

const rawUsage: ModelRunUsage = {
  cachedInputTokens: -2,
  cacheWriteInputTokens: 3.8,
  inputTokens: 10.9,
  outputTokens: 5.7,
  reasoningTokens: 2.9,
  totalTokens: 0
};

function completionInput(repository: Pick<RunRepository, "completeRun" | "loadModelPricing">) {
  return {
    repository,
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
      cachedInputTokens: 0,
      cacheWriteInputTokens: 3,
      estimatedCostMicros: null,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 2,
      totalTokens: 15
    });
  });

  it("uses configured pricing after normalizing provider usage", async () => {
    const usage = await usageWithEstimatedCost(
      {
        loadModelPricing: async () => ({
          inputTokenPriceMicros: 2,
          outputTokenPriceMicros: 5,
          reasoningTokenPriceMicros: 7
        })
      },
      {
        modelId: "fake-qsa",
        provider: "fake",
        usage: rawUsage
      }
    );

    expect(usage).toEqual({
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
        inputTokenPriceMicros: 2,
        outputTokenPriceMicros: 5,
        reasoningTokenPriceMicros: 7
      })
    };

    const result = await finalizeRunCompletion(completionInput(repository));

    const usage = {
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
          usage: {
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
      draftContractVersion: 5 as const,
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
      selectorContractVersion: 3 as const,
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
        draftContractVersion: 5,
        selectorContractVersion: 3
      },
      result: { ...completionInput(repository).result, finalText: "hidden structured result" }
    });

    expect(result).toMatchObject({ finalText: grounding.finalText, status: "completed" });
    expect(groundKnowledgeAnswer).not.toHaveBeenCalled();
    expect(groundKnowledgeAnswerV5).toHaveBeenCalledWith({
      draftContractVersion: 5,
      runId: "run-1",
      selectorContractVersion: 3,
      userId: "user-1"
    });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({
      finalText: grounding.finalText,
      knowledgeGrounding: { grounding }
    }));
  });
});
