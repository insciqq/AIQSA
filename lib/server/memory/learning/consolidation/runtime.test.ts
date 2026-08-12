import { describe, expect, it } from "vitest";
import type { ProviderRunResult } from "../../../providers/types";
import {
  memoryFactDecisionOutputKind,
  memoryFactDecisionToolChoice
} from "./runtime";

function result(
  overrides: Partial<ProviderRunResult> = {}
): ProviderRunResult {
  return {
    finalProviderResponsePreview: { output: [] },
    finalText: "",
    usage: {
      cachedInputTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2
    },
    ...overrides
  };
}

describe("Memory fact decision runtime diagnostics", () => {
  it("requires the verifier tool while preserving the consolidator control", () => {
    expect(memoryFactDecisionToolChoice("VERIFY")).toBe("required");
    expect(memoryFactDecisionToolChoice("CONSOLIDATE")).toBe("auto");
  });

  it("classifies provider output structure without retaining provider content", () => {
    expect(memoryFactDecisionOutputKind(result())).toBe("no_output_items");
    expect(memoryFactDecisionOutputKind(result({
      finalProviderResponsePreview: { output: [{ type: "reasoning" }] }
    }))).toBe("reasoning_only");
    expect(memoryFactDecisionOutputKind(result({
      finalProviderResponsePreview: {
        output: [{ type: "reasoning" }, { type: "message" }]
      }
    }))).toBe("message_without_text");
    expect(memoryFactDecisionOutputKind(result({
      finalProviderResponsePreview: { output: [{ type: "unknown" }] }
    }))).toBe("other_nontext");
    expect(memoryFactDecisionOutputKind(result({ finalText: "answer" }))).toBe(
      "text_only"
    );
    expect(memoryFactDecisionOutputKind(result({
      toolCalls: [{ arguments: {}, id: "call-1", name: "tool" }]
    }))).toBe("tool_calls_only");
    expect(memoryFactDecisionOutputKind(result({
      finalText: "answer",
      toolCalls: [{ arguments: {}, id: "call-1", name: "tool" }]
    }))).toBe("text_and_tool_calls");
  });
});
