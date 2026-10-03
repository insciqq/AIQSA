import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRunUsage } from "../../../domain/modelRunEvents";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";
import { STRUCTURED_OUTPUT_DECODE_REASONS, StructuredOutputDecodeError } from "../../providers/structuredOutput";
import {
  isMemoryOutputDecodeReason,
  MEMORY_OUTPUT_DECODE_REASON_PATTERN,
  MEMORY_OUTPUT_DECODE_REASONS,
  memoryOutputDecodeReason,
  MemoryOutputViolationError
} from "./outputViolation";
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
  version: 4,
  generationBudget: { version: 1, contextWindow: null, maxOutputTokens: 65536, timeoutMs: 300000 },
  providerExecutionSnapshot: { model: { defaultParams: {}, capabilities: {
    reasoning: false, structuredOutput: true, vision: false, pdf: false, nativePdfInput: false, nativeSearch: false
  } } }
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
  it("distinguishes a received malformed output from an unavailable provider", async () => {
    execute.mockImplementation(async (_snapshot, _request, options: { onUsage(value: ModelRunUsage): void }) => {
      options.onUsage({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
      throw new StructuredOutputDecodeError("invalid_json");
    });
    await expect(createAcceptedMemoryStructuredOutputProvider({} as never)
      .run(snapshot, request, new AbortController().signal)).rejects.toMatchObject({
        outputInvalid: true, outputLimitExceeded: false,
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 }
      });
    expect(new MemoryStructuredOutputProviderError(null, null, { cause: new Error("structured_output_invalid") }).outputInvalid).toBe(false);
  });

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

describe("Memory structured output decode reasons", () => {
  it("keeps the closed vocabulary unique, bounded and storable", () => {
    expect(new Set(MEMORY_OUTPUT_DECODE_REASONS).size).toBe(MEMORY_OUTPUT_DECODE_REASONS.length);
    expect(MEMORY_OUTPUT_DECODE_REASONS).toEqual(expect.arrayContaining([...STRUCTURED_OUTPUT_DECODE_REASONS]));
    for (const reason of MEMORY_OUTPUT_DECODE_REASONS) {
      expect(reason).toMatch(MEMORY_OUTPUT_DECODE_REASON_PATTERN);
      expect(isMemoryOutputDecodeReason(reason)).toBe(true);
    }
    for (const value of ["", "Invalid JSON", "role_contract\nprivate", "x".repeat(65), null]) {
      expect(isMemoryOutputDecodeReason(value)).toBe(false);
    }
  });

  it.each(STRUCTURED_OUTPUT_DECODE_REASONS)("carries the transport reason %s only for a received answer", (reason) => {
    expect(new MemoryStructuredOutputProviderError(null, null,
      { cause: new StructuredOutputDecodeError(reason) })).toMatchObject({ decodeReason: reason, outputInvalid: true });
  });

  it("maps every rejection to a closed content-free reason", () => {
    expect(new MemoryStructuredOutputProviderError(null, null, { cause: Object.assign(new Error("bounded"),
      { code: "structured_output_output_limit_exceeded" }) }).decodeReason).toBeNull();
    expect(new MemoryStructuredOutputProviderError(null, null, { cause: new Error("transport") }).decodeReason).toBeNull();
    expect(memoryOutputDecodeReason(new StructuredOutputDecodeError("non_object"))).toBe("non_object");
    expect(memoryOutputDecodeReason(new MemoryOutputViolationError("fixture", "statement_contract_field")))
      .toBe("statement_contract_field");
    expect(memoryOutputDecodeReason(new Error("private rejected answer text"))).toBe("role_contract");
    const forged = new MemoryOutputViolationError("fixture", "private text" as never);
    expect(forged.decodeReason).toBe("role_contract");
    expect(JSON.stringify(forged)).not.toContain("private");
  });
});
