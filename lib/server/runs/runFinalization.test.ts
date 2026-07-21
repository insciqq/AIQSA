import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { RunRepository } from "./runRepositoryContract";
import {
  appendRunEventWithRetry,
  appendStoredRunEvents,
  finalizeRunCompletion,
  usageWithEstimatedCost,
  type RunEventSequence
} from "./runFinalization";

const firstEvent: ModelRunSseEvent = {
  data: {
    modelId: "fake-qsa",
    provider: "fake",
    runId: "run-1",
    status: "streaming"
  },
  type: "run_start"
};

const secondEvent: ModelRunSseEvent = {
  data: {
    assistantMessageId: "assistant-1",
    userMessageId: "user-message-1"
  },
  type: "message_start"
};

const rawUsage: ModelRunUsage = {
  cachedInputTokens: -2,
  cacheWriteInputTokens: 3.8,
  inputTokens: 10.9,
  outputTokens: 5.7,
  reasoningTokens: 2.9,
  totalTokens: 0
};

function eventRepository(input: Readonly<{
  appendRunEvent?: RunRepository["appendRunEvent"];
  nextRunEventSequence?: RunRepository["nextRunEventSequence"];
}> = {}): Pick<RunRepository, "appendRunEvent" | "nextRunEventSequence"> {
  return {
    appendRunEvent: input.appendRunEvent ?? vi.fn(async () => undefined),
    nextRunEventSequence: input.nextRunEventSequence ?? vi.fn(async () => 0)
  };
}

function completionInput(repository: Pick<RunRepository, "completeRun" | "loadModelPricing">) {
  return {
    repository,
    result: {
      finalProviderResponsePreview: {
        id: "provider-response-1"
      },
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
  it("appends at the current sequence and advances it after success", async () => {
    const appendRunEvent = vi.fn(async () => undefined);
    const nextRunEventSequence = vi.fn(async () => 99);
    const repository = eventRepository({ appendRunEvent, nextRunEventSequence });
    const sequence: RunEventSequence = { value: 4 };

    await appendRunEventWithRetry(repository, "run-1", sequence, firstEvent);

    expect(appendRunEvent).toHaveBeenCalledWith("run-1", 4, firstEvent);
    expect(nextRunEventSequence).not.toHaveBeenCalled();
    expect(sequence.value).toBe(5);
  });

  it("reloads a conflicting sequence and retries with the durable next value", async () => {
    const collision = new Error("duplicate sequence");
    const appendRunEvent = vi
      .fn<RunRepository["appendRunEvent"]>()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce(undefined);
    const nextRunEventSequence = vi.fn(async () => 7);
    const repository = eventRepository({ appendRunEvent, nextRunEventSequence });
    const sequence: RunEventSequence = { value: 2 };

    await appendRunEventWithRetry(repository, "run-1", sequence, firstEvent);

    expect(appendRunEvent.mock.calls.map((call) => call[1])).toEqual([2, 7]);
    expect(nextRunEventSequence).toHaveBeenCalledWith("run-1");
    expect(sequence.value).toBe(8);
  });

  it("rethrows immediately when the durable sequence did not advance", async () => {
    const failure = new Error("storage unavailable");
    const appendRunEvent = vi.fn<RunRepository["appendRunEvent"]>(async () => {
      throw failure;
    });
    const nextRunEventSequence = vi.fn(async () => 3);
    const repository = eventRepository({ appendRunEvent, nextRunEventSequence });
    const sequence: RunEventSequence = { value: 3 };

    await expect(appendRunEventWithRetry(repository, "run-1", sequence, firstEvent)).rejects.toBe(failure);

    expect(appendRunEvent).toHaveBeenCalledOnce();
    expect(nextRunEventSequence).toHaveBeenCalledOnce();
    expect(sequence.value).toBe(3);
  });

  it("caps advancing-sequence retries at five append attempts", async () => {
    const failure = new Error("persistent conflict");
    const appendRunEvent = vi.fn<RunRepository["appendRunEvent"]>(async () => {
      throw failure;
    });
    let next = 0;
    const nextRunEventSequence = vi.fn(async () => {
      next += 1;
      return next;
    });
    const repository = eventRepository({ appendRunEvent, nextRunEventSequence });
    const sequence: RunEventSequence = { value: 0 };

    await expect(appendRunEventWithRetry(repository, "run-1", sequence, firstEvent)).rejects.toBe(failure);

    expect(appendRunEvent).toHaveBeenCalledTimes(5);
    expect(nextRunEventSequence).toHaveBeenCalledTimes(5);
    expect(sequence.value).toBe(4);
  });

  it("appends stored events sequentially through the shared retry path", async () => {
    const calls: Array<{ event: ModelRunSseEvent; sequence: number }> = [];
    const repository = eventRepository({
      appendRunEvent: async (_runId, sequence, event) => {
        calls.push({ event, sequence });
      }
    });
    const sequence: RunEventSequence = { value: 11 };

    await appendStoredRunEvents({
      events: [firstEvent, secondEvent],
      repository,
      runId: "run-1",
      sequence
    });

    expect(calls).toEqual([
      { event: firstEvent, sequence: 11 },
      { event: secondEvent, sequence: 12 }
    ]);
    expect(sequence.value).toBe(13);
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
    expect(result).toEqual({ status: "completed", usage });
    expect(completeRun).toHaveBeenCalledWith({
      assistantMessageId: "assistant-1",
      chatId: "chat-1",
      estimatedCostMicros: 49,
      finalProviderResponsePreview: {
        id: "provider-response-1"
      },
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
});
