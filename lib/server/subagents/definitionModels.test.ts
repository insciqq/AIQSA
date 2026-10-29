// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CatalogWireModel } from "@/lib/contracts/catalog";
import { findSubagentModel, subagentModelOptions, subagentModelRefusal } from "./definitionModels";

function model(modelId: string, patch: Readonly<{ displayName?: string; efforts?: string[]; toolCalling?: boolean }> = {}): CatalogWireModel {
  const efforts = patch.efforts ?? [];
  return {
    capabilities: { background: false, documentInputMode: "none", imageInput: false, nativeWebSearch: false, openRouterPerplexitySearch: false,
      reasoning: efforts.length > 0, streaming: true, text: true, toolCalling: patch.toolCalling ?? true },
    contextWindow: null, defaultParams: {}, displayName: patch.displayName ?? modelId, modelId,
    parameterControls: {
      background: { defaultValue: false, supported: false }, maxOutputTokens: { defaultValue: 1_000 },
      reasoningEffort: { defaultValue: efforts[0] ?? "", options: efforts, supported: efforts.length > 0 },
      stream: { defaultValue: true, supported: true }, temperature: { defaultValue: 1, maxValue: 2, minValue: 0, supported: false }
    },
    provider: "connection-1", providerFamily: "openai", searchStrategyIds: [], upstreamModelId: modelId
  };
}

describe("sub-agent model options", () => {
  const options = subagentModelOptions([model("cheap", { displayName: "Cheap", efforts: ["low", "high"] }), model("plain"),
    model("no-tools", { toolCalling: false }), model("twin-a", { displayName: "Twin" }), model("twin-b", { displayName: "twin" })]);

  it("offers only tool-calling models with the efforts each takes", () => {
    expect(options.map((option) => option.modelId)).toEqual(["cheap", "plain", "twin-a", "twin-b"]);
    expect(options[0]).toEqual({ defaultEffort: "low", displayName: "Cheap", efforts: ["low", "high"], modelId: "cheap" });
    expect(options[1]).toMatchObject({ defaultEffort: null, efforts: [] });
  });

  it("checks a model and effort against them", () => {
    expect(subagentModelRefusal({ effort: "high", modelId: "cheap" }, options)).toBeNull();
    expect(subagentModelRefusal({ effort: null, modelId: "no-tools" }, options)).toEqual({ code: "subagent_model_unavailable", field: "model" });
    expect(subagentModelRefusal({ effort: "low", modelId: "plain" }, options)).toEqual({ code: "subagent_effort_unsupported", field: "effort" });
    expect(subagentModelRefusal({ effort: "high", modelId: null }, options)).toBeNull();
    expect(subagentModelRefusal({ effort: "max", modelId: null }, options)).toEqual({ code: "subagent_effort_unsupported", field: "effort" });
  });

  it("finds a model a call names by id or by an unambiguous name, never by a guess", () => {
    expect(findSubagentModel(options, "cheap")?.modelId).toBe("cheap");
    expect(findSubagentModel(options, " CHEAP ")?.modelId).toBe("cheap");
    expect(findSubagentModel(options, "Twin")).toBeNull();
    expect(findSubagentModel(options, "twin-b")?.modelId).toBe("twin-b");
    expect(findSubagentModel(options, "cheaper")).toBeNull();
  });
});
