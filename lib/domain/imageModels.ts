import type { ImageModelConfiguration, ImageProviderProfile } from "../contracts/imageGeneration";

export function imageModelConfiguration(upstreamModelId: string, image: ImageModelConfiguration) {
  return {
    adapterKind: image.profile === "gemini" ? "gemini_images_native" as const :
      image.profile === "openrouter" ? "openrouter_images" as const :
      image.profile === "openai" ? "openai_images_native" as const : "openai_images_compatible" as const,
    answerSelectable: false,
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false,
      imageGeneration: true, imageEditing: true },
    defaultParams: {},
    image,
    modelClass: "image" as const,
    ...(image.profile === "openrouter" ? { openRouterRouting: { mode: "automatic" as const, providers: [] as [] } } : {}),
    upstreamModelId
  };
}

/** Reviewed candidates still require exact-key catalog and capability checks. */
export function initialImageModels(family: string): readonly { id: string; name: string; profile: ImageProviderProfile }[] {
  if (family === "openai") return [{ id: "gpt-image-2", name: "GPT Image 2", profile: "openai" }];
  if (family === "gemini") return [
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", profile: "gemini" },
    { id: "gemini-3.1-flash-lite-image", name: "Gemini 3.1 Flash Lite Image", profile: "gemini" },
    { id: "gemini-3-pro-image", name: "Gemini 3 Pro Image", profile: "gemini" },
    { id: "gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", profile: "gemini" }
  ];
  if (family === "openrouter") return [
    { id: "google/gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", profile: "openrouter" },
    { id: "google/gemini-3.1-flash-lite-image", name: "Gemini 3.1 Flash Lite Image", profile: "openrouter" },
    { id: "google/gemini-3-pro-image", name: "Gemini 3 Pro Image", profile: "openrouter" },
    { id: "google/gemini-2.5-flash-image", name: "Gemini 2.5 Flash Image", profile: "openrouter" },
    { id: "openai/gpt-image-2.5-sunburst", name: "GPT Image 2.5 Sunburst", profile: "openrouter" },
    { id: "openai/gpt-image-2.5-flare", name: "GPT Image 2.5 Flare", profile: "openrouter" }
  ];
  return [];
}
