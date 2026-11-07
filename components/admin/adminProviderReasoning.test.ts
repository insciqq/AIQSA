import { describe, expect, it } from "vitest";
import {
  discoveredReasoningForModels,
  reasoningForChoice
} from "./adminProviderReasoning";

describe("admin compatible-provider reasoning controls", () => {
  it("falls back to the reviewed GPT-5.6 Sol levels, with no reasoning mode, when discovery is silent", () => {
    const expected = {
      defaultReasoningEffort: "medium",
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"]
    };
    expect(reasoningForChoice("automatic", [{ capabilities: {}, id: "opaque-model" }])).toEqual(expected);
    expect(reasoningForChoice("openai_gpt_5_6_sol", [])).toEqual(expected);
  });

  it("keeps the modes an endpoint reports for the administrator to save", () => {
    expect(reasoningForChoice("automatic", [{
      capabilities: {
        reasoning: true,
        reasoningEfforts: ["low", "medium"],
        reasoningModes: ["standard", "pro"]
      },
      id: "model-a"
    }])).toEqual({
      defaultReasoningEffort: "low",
      defaultReasoningMode: "standard",
      reasoning: true,
      reasoningEfforts: ["low", "medium"],
      reasoningModes: ["standard", "pro"]
    });
  });

  it("intersects explicit metadata when several models share one setup", () => {
    expect(discoveredReasoningForModels([
      {
        capabilities: {
          defaultReasoningEffort: "medium",
          defaultReasoningMode: "standard",
          reasoning: true,
          reasoningEfforts: ["low", "medium", "high"],
          reasoningModes: ["standard", "pro"]
        },
        id: "model-a"
      },
      {
        capabilities: {
          defaultReasoningEffort: "high",
          defaultReasoningMode: "standard",
          reasoning: true,
          reasoningEfforts: ["medium", "high", "ultra"],
          reasoningModes: ["standard"]
        },
        id: "model-b"
      }
    ])).toEqual({
      defaultReasoningEffort: "medium",
      defaultReasoningMode: "standard",
      reasoning: true,
      reasoningEfforts: ["medium", "high"],
      reasoningModes: ["standard"]
    });
  });
});
