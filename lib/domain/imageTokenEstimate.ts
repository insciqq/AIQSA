import { tokenEstimateProfileFor } from "./tokenEstimate";

/**
 * Upper-bound input tokens of one image, from a declared policy per provider
 * family. The key is the family `tokenEstimateProfileFor` selects, so text and
 * image estimates of one request follow the same admitted provider and model.
 *
 * Primary documentation read 2026-09-27 (targeted usage measurements are
 * recorded with the task; a model name is never capability evidence):
 * - Anthropic (platform.claude.com, build-with-claude/vision): one visual token
 *   per 28 px patch, `ceil(w/28) * ceil(h/28)`; larger images are downscaled to
 *   at most 4784 visual tokens (Claude 4.7 and later, 2576 px long edge) or
 *   1568 (other models). A 3840x2160 image costs at most 4784.
 * - OpenAI (developers.openai.com, guides/images-vision): patch models count
 *   `ceil(w/32) * ceil(h/32)` patches times a multiplier. Models whose `auto`
 *   detail keeps the original size (at most 30,000 patches) use 1.2; capped
 *   models use at most 6144 patches and multipliers up to 2.46. Tile models
 *   fit 2048 px, scale the short side to 768 px and cost 85 + 170 per 512 px
 *   tile (smaller bases for gpt-5/o-series); gpt-4o-mini costs 2833 + 5667 per
 *   tile. The request adapter sends `detail: "auto"`.
 * - Gemini 3 defaults to 1120 tokens per image (2240 at ultra_high); Gemini 2
 *   tiles 768 px crops at 258 tokens. Gemini, DeepSeek, OpenRouter, other
 *   compatible endpoints and unknown families keep the conservative fallback
 *   until a policy is declared for them.
 */
export type ImageTokenPolicy = "anthropic_visual_patches" | "conservative_patches" | "openai_patches_or_tiles";

export type ImageDimensions = Readonly<{ height: number; width: number }>;

export const IMAGE_TOKEN_ESTIMATE = Object.freeze({
  /** Documented counts are raised by 10% (resize rounding and documentation
   * lag) plus a fixed per-image allowance for framing tokens. */
  documentedMargin: 1.1,
  documentedOverhead: 64,
  /** Assumed geometry of an image without recorded dimensions: the largest
   * size an OpenAI high-detail request keeps. */
  unknownDimension: 2048
});

/** OpenAI documents a tile rate for gpt-4o-mini far above every other model.
 * A matching identifier can only raise an estimate, on any route. */
const GPT_4O_MINI_MODEL_ID = /(?:^|\/)gpt-4o-mini(?:$|[-.:])/iu;

function patches(width: number, height: number, size: number): number {
  return Math.ceil(width / size) * Math.ceil(height / size);
}

/** The pre-policy estimate: four tokens per 32 px patch plus 1024 per image.
 * It exceeds every documented per-image count except gpt-4o-mini's. */
export function conservativeImageTokens(image: ImageDimensions): number {
  return patches(image.width, image.height, 32) * 4 + 1024;
}

function openAiTileTokens(image: ImageDimensions, base: number, tile: number): number {
  const fit = Math.min(1, 2048 / Math.max(image.width, image.height));
  const short = Math.min(1, 768 / (Math.min(image.width, image.height) * fit));
  const scale = fit * short;
  return base + tile * patches(Math.floor(image.width * scale), Math.floor(image.height * scale), 512);
}

function openAiTokens(image: ImageDimensions): number {
  const count = patches(image.width, image.height, 32);
  return Math.max(openAiTileTokens(image, 85, 170), Math.ceil(count * 1.2), Math.ceil(Math.min(count, 6144) * 2.46));
}

function anthropicTokens(image: ImageDimensions): number {
  return Math.min(patches(image.width, image.height, 28), 4784);
}

function documented(tokens: number): number {
  return Math.ceil(tokens * IMAGE_TOKEN_ESTIMATE.documentedMargin) + IMAGE_TOKEN_ESTIMATE.documentedOverhead;
}

export function imageTokenPolicyFor(input: Readonly<{ modelId?: string | null; provider: string }>): ImageTokenPolicy {
  switch (tokenEstimateProfileFor(input)?.family) {
    case "anthropic":
      return "anthropic_visual_patches";
    case "openai":
      return "openai_patches_or_tiles";
    default:
      return "conservative_patches";
  }
}

function validDimensions(image: ImageDimensions | null | undefined): ImageDimensions {
  return image && Number.isFinite(image.width) && Number.isFinite(image.height) && image.width > 0 && image.height > 0
    ? image : { height: IMAGE_TOKEN_ESTIMATE.unknownDimension, width: IMAGE_TOKEN_ESTIMATE.unknownDimension };
}

/** Input tokens of one image for an admitted provider family and model. */
export type ImageTokenEstimate = (image: ImageDimensions | null | undefined) => number;

export function imageTokenEstimator(input: Readonly<{ modelId?: string | null; provider: string }>): ImageTokenEstimate {
  const policy = imageTokenPolicyFor(input);
  const mini = GPT_4O_MINI_MODEL_ID.test(input.modelId?.trim() ?? "");
  return (value) => {
    const image = validDimensions(value);
    const tokens = policy === "anthropic_visual_patches" ? documented(anthropicTokens(image)) :
      policy === "openai_patches_or_tiles" ? documented(openAiTokens(image)) : conservativeImageTokens(image);
    return mini ? Math.max(tokens, documented(openAiTileTokens(image, 2833, 5667))) : tokens;
  };
}
