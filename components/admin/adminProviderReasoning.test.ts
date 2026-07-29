import { describe, expect, it } from "vitest";
import {
  discoveredReasoningForModels,
  reasoningForChoice
} from "./adminProviderReasoning";

describe("admin compatible-provider reasoning controls", () => {
  it("falls back to the reviewed GPT-5.6 Sol profile when discovery is silent", () => {
    expect(reasoningForChoice("automatic", [{ capabilities: {}, id: "opaque-model" }]))
      .toEqual({
        defaultReasoningEffort: "medium",
        defaultReasoningMode: "standard",
        reasoning: true,
        reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
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
