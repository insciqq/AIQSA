import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import {
  createAcceptedMemoryStructuredOutputProvider,
  memoryReportedUsage,
  MemoryStructuredOutputProviderError
} from "./structuredClassifier";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../providerRuntime/structuredOutputExecutor", () => ({
  createAcceptedStructuredOutputSnapshotExecutor: () => execute
}));

const snapshot = {
  providerExecutionSnapshot: { model: { defaultParams: {} } }
} as MemorySecretFreeExecutionSnapshot;
const request = {
  maxOutputTokens: 64,
  name: "classify",
  schema: { type: "object" },
  systemPrompt: "Classify the supplied text.",
  userPrompt: "Synthetic text"
};

beforeEach(() => { execute.mockReset(); });

describe("Memory structured classifier usage", () => {
  it("keeps complete reported totals complete when optional breakdowns are absent", () => {
    expect(memoryReportedUsage({ inputTokens: 10, outputTokens: 0, totalTokens: 10 })).toMatchObject({
      completeness: "COMPLETE", inputTokens: 10, outputTokens: 0, totalTokens: 10,
      cachedInputTokens: null, reasoningTokens: null, cacheWriteInputTokens: null
    });
  });

  it.each([false, true])("retains cumulative fields across fragments (failed=%s)", async (failed) => {
    execute.mockImplementation(async (_snapshot, _request, options: {
      onUsage(value: ModelRunUsage): void;
    }) => {
      options.onUsage({ inputTokens: 10, cachedInputTokens: 0 });
      options.onUsage({ outputTokens: 2 });
      options.onUsage({ outputTokens: 3 });
      if (failed) throw new Error("provider_interrupted");
      return { accepted: true };
    });
    const result = createAcceptedMemoryStructuredOutputProvider({} as never)
      .run(snapshot, request, new AbortController().signal);
    const usage = {
      inputTokens: 10, cachedInputTokens: 0, outputTokens: 3, totalTokens: 13,
      completeness: failed ? "partial" : "complete"
    };
    if (failed) {
      await expect(result).rejects.toBeInstanceOf(MemoryStructuredOutputProviderError);
      await expect(result).rejects.toMatchObject({ usage });
    } else {
      await expect(result).resolves.toMatchObject({ output: { accepted: true }, usage });
    }
    expect(execute).toHaveBeenCalledOnce();
  });
});
