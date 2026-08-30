import { describe, expect, it } from "vitest";
import {
  DEFAULT_RERANKER_MODEL_PRESET_ID,
  rerankerModelPresets
} from "./rerankerModels";

describe("reranker model presets", () => {
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
