import { describe, expect, it } from "vitest";
import {
  DEFAULT_RERANKER_MODEL_PRESET_ID,
  rerankerModelPresets
} from "./rerankerModels";

describe("reranker model presets", () => {
  it("keeps Qwen3 Reranker 8B as the single code-owned OpenRouter default", () => {
    const defaults = rerankerModelPresets.filter((preset) => preset.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({
      id: DEFAULT_RERANKER_MODEL_PRESET_ID,
      providerFamily: "openrouter",
      upstreamModelId: "qwen/qwen3-reranker-8b"
    });
  });

});
