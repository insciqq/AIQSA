// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CatalogWireModel } from "@/lib/contracts/catalog";
import { subagentModelLabel } from "@/lib/contracts/subagentDefinitions";
import { findSubagentModel, subagentModelOptions, subagentModelRefusal } from "./definitionModels";

function model(modelId: string, patch: Readonly<{ displayName?: string; efforts?: string[]; provider?: string; toolCalling?: boolean }> = {}): CatalogWireModel {
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
    provider: patch.provider ?? "connection-1", providerFamily: "openai", searchStrategyIds: [], upstreamModelId: modelId
  };
}

describe("sub-agent model options", () => {
  const labels = new Map([["connection-1", "Codex LB"], ["connection-2", "OpenRouter"]]);
  const options = subagentModelOptions([model("cheap", { displayName: "Cheap", efforts: ["low", "high"] }), model("plain"),
    model("no-tools", { toolCalling: false }), model("twin-a", { displayName: "Twin" }),
    model("twin-b", { displayName: "twin", provider: "connection-2" })], labels);

  it("offers only tool-calling models with the efforts each takes", () => {
    expect(options.map((option) => option.modelId)).toEqual(["cheap", "plain", "twin-a", "twin-b"]);
    expect(options[0]).toEqual({ connectionName: "Codex LB", defaultEffort: "low", displayName: "Cheap", efforts: ["low", "high"],
      modelId: "cheap" });
    expect(options.map(subagentModelLabel)).toEqual(["Cheap · Codex LB", "plain · Codex LB", "Twin · Codex LB", "twin · OpenRouter"]);
    expect(options[1]).toMatchObject({ defaultEffort: null, efforts: [] });
  });

  it("checks a model and effort against them", () => {
    expect(subagentModelRefusal({ effort: "high", modelId: "cheap" }, options)).toBeNull();
    expect(subagentModelRefusal({ effort: null, modelId: "no-tools" }, options)).toEqual({ code: "subagent_model_unavailable", field: "model" });
    expect(subagentModelRefusal({ effort: "low", modelId: "plain" }, options)).toEqual({ code: "subagent_effort_unsupported", field: "effort" });
    expect(subagentModelRefusal({ effort: "high", modelId: null }, options)).toBeNull();
    expect(subagentModelRefusal({ effort: "max", modelId: null }, options)).toEqual({ code: "subagent_effort_unsupported", field: "effort" });
  });

  const found = (reference: string) => {
    const match = findSubagentModel(options, reference);
    return match.kind === "found" ? match.option.modelId : match.kind;
  };

  it("finds a model a call names by id, an unambiguous name or its labelled name, never by a guess", () => {
    expect(found("cheap")).toBe("cheap");
    expect(found(" CHEAP ")).toBe("cheap");
    expect(found("twin-b")).toBe("twin-b");
    expect(found("cheaper")).toBe("none");
    expect(found("   ")).toBe("none");
    // The labelled name, as the lists show it, case- and whitespace-insensitively.
    expect(found("Twin · Codex LB")).toBe("twin-a");
    expect(found("twin·openrouter")).toBe("twin-b");
    expect(found("TWIN  ·  OPENROUTER")).toBe("twin-b");
    expect(found("Twin · Elsewhere")).toBe("none");
  });

  it("refuses a bare name two connections share, listing both with their connections", () => {
    const match = findSubagentModel(options, "Twin");
    expect(match.kind).toBe("ambiguous");
    expect(match.kind === "ambiguous" ? match.candidates.map((option) => [option.modelId, subagentModelLabel(option)]) : [])
      .toEqual([["twin-a", "Twin · Codex LB"], ["twin-b", "twin · OpenRouter"]]);
  });
});
