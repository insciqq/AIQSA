import { describe, expect, it } from "vitest";
import { providerModelTemplateIds } from "./providerTemplates";
import {
  DEFAULT_RERANKER_MODEL_PRESET_ID,
  rerankerModelPresets
} from "./rerankerModels";

describe("reranker model presets", () => {
  it("keeps every code-owned provider model identity unique", () => {
    const ids = Object.values(providerModelTemplateIds);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps Voyage Rerank 2.5 as the single code-owned OpenRouter default", () => {
    const defaults = rerankerModelPresets.filter((preset) => preset.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      id: DEFAULT_RERANKER_MODEL_PRESET_ID,
      providerFamily: "openrouter",
      upstreamModelId: "voyageai/rerank-2.5"
    });
  });
});
