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

/** Only one candidate per family is checked during initial setup. */
export function initialImageModel(family: string): { id: string; name: string; profile: ImageProviderProfile } | null {
  if (family === "openai") return { id: "gpt-image-2", name: "GPT Image 2", profile: "openai" };
  if (family === "gemini") return { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", profile: "gemini" };
  if (family === "openrouter") return { id: "google/gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image", profile: "openrouter" };
  return null;
}
