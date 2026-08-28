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
      version: 6 as const
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
});
