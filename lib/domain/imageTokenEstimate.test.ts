import { describe, expect, it } from "vitest";
import { conservativeImageTokens, imageTokenEstimator, imageTokenPolicyFor } from "./imageTokenEstimate";

const uhd = { height: 2160, width: 3840 };

describe("image token policy", () => {
  it("follows the text estimate's provider family key", () => {
    expect(imageTokenPolicyFor({ provider: "anthropic" })).toBe("anthropic_visual_patches");
    expect(imageTokenPolicyFor({ provider: "openai", modelId: "anything" })).toBe("openai_patches_or_tiles");
    expect(imageTokenPolicyFor({ provider: "openai_compatible", modelId: "gpt-5.5" })).toBe("openai_patches_or_tiles");
    for (const input of [{ provider: "openai_compatible", modelId: "visual-model" }, { provider: "openrouter", modelId: "openai/gpt-5.5" },
      { provider: "gemini" }, { provider: "deepseek" }, { provider: "fake" }])
      expect(imageTokenPolicyFor(input)).toBe("conservative_patches");
  });

  it("bounds documented Anthropic counts by the high-resolution visual-token cap plus the margin", () => {
    const estimate = imageTokenEstimator({ provider: "anthropic" });
    // Documented: 1000x1000 = 1296 visual tokens; 3840x2160 is downscaled to 4784.
    expect(estimate({ height: 1000, width: 1000 })).toBe(Math.ceil(1296 * 1.1) + 64);
    expect(estimate(uhd)).toBe(Math.ceil(4784 * 1.1) + 64);
  });

  it("bounds every documented OpenAI method, and a gpt-4o-mini identifier only raises the estimate", () => {
    const estimate = imageTokenEstimator({ provider: "openai", modelId: "gpt-5.5" });
    // 120x68 patches: original-size models 1.2x, capped models at most 6144 patches x 2.46; tiles 85 + 6 x 170.
    expect(estimate(uhd)).toBe(Math.ceil(Math.ceil(6144 * 2.46) * 1.1) + 64);
    // A tiny image is dominated by the tile base, not the patch count.
    expect(estimate({ height: 32, width: 32 })).toBe(Math.ceil(255 * 1.1) + 64);
    const mini = Math.ceil((2833 + 6 * 5667) * 1.1) + 64;
    expect(imageTokenEstimator({ provider: "openai", modelId: "gpt-4o-mini-2024-07-18" })(uhd)).toBe(mini);
    expect(imageTokenEstimator({ provider: "openrouter", modelId: "openai/gpt-4o-mini" })(uhd)).toBe(mini);
  });

  it("keeps the pre-policy formula as the conservative fallback and sizes unknown geometry at 2048 px", () => {
    const estimate = imageTokenEstimator({ provider: "openrouter", modelId: "google/gemini-3-pro" });
    expect(estimate(uhd)).toBe(120 * 68 * 4 + 1024);
    expect(conservativeImageTokens(uhd)).toBe(33_664);
    expect(estimate(null)).toBe(64 * 64 * 4 + 1024);
    expect(estimate({ height: 0, width: Number.NaN })).toBe(estimate(null));
  });
});
