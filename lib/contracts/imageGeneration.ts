/** Image output settings are independent of the conversation model's controls. */
export type ImageProviderProfile = "openai" | "openai_compatible" | "codex_lb" | "gemini" | "openrouter";

export const IMAGE_PARAMETER_NAMES = [
  "size", "quality", "background", "output_format", "output_compression", "input_fidelity",
  "aspect_ratio", "image_size", "mime_type", "thinking_level", "resolution", "seed"
] as const;
export type ImageParameterName = (typeof IMAGE_PARAMETER_NAMES)[number];
export type ImageParameterDefinition =
  | { type: "enum"; values: string[] }
  | { type: "range"; min: number; max: number }
  | { type: "dimensions" };
export type ImageParameterDefinitions = Partial<Record<ImageParameterName, ImageParameterDefinition>>;
export type ImageGenerationParameters = Partial<Record<ImageParameterName, string | number>>;
export type ImageModelConfiguration = {
  profile: ImageProviderProfile;
  /** Bounded catalog hints for routed models, rechecked by Test & Save. */
  parameters?: ImageParameterDefinitions;
};

export const IMAGE_MAX_INPUTS = 8;
export const IMAGE_MAX_PROMPT_CHARACTERS = 16_000;
export const IMAGE_MAX_BYTES = 24 * 1024 * 1024;
export const IMAGE_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 16_777_216;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type GeneratedImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const enumeration = (...values: string[]): ImageParameterDefinition => ({ type: "enum", values });

export function normalizeImageModelConfiguration(value: unknown): ImageModelConfiguration {
  if (!record(value) || !["openai", "openai_compatible", "codex_lb", "gemini", "openrouter"].includes(String(value.profile)) ||
    Object.keys(value).some((key) => key !== "profile" && key !== "parameters")) {
    throw new Error("image_configuration_invalid");
  }
  const profile = value.profile as ImageProviderProfile;
  if (value.parameters === undefined) return { profile };
  if (profile !== "openrouter" || !record(value.parameters) ||
    Object.keys(value.parameters).length > IMAGE_PARAMETER_NAMES.length) throw new Error("image_configuration_invalid");
  const parameters: ImageParameterDefinitions = {};
  for (const [name, definition] of Object.entries(value.parameters)) {
    if (!IMAGE_PARAMETER_NAMES.includes(name as ImageParameterName) || !record(definition)) throw new Error("image_configuration_invalid");
    if (definition.type === "enum" && Array.isArray(definition.values) && definition.values.length > 0 &&
      definition.values.length <= 64 && definition.values.every((v) => typeof v === "string" && v.length > 0 && v.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(v))) {
      parameters[name as ImageParameterName] = enumeration(...new Set(definition.values as string[]));
    } else if (definition.type === "range" && Number.isSafeInteger(definition.min) && Number.isSafeInteger(definition.max) &&
      Number(definition.min) >= 0 && Number(definition.max) <= 2_147_483_647 && Number(definition.min) <= Number(definition.max)) {
      parameters[name as ImageParameterName] = { type: "range", min: Number(definition.min), max: Number(definition.max) };
    } else {
      throw new Error("image_configuration_invalid");
    }
  }
  return { profile, parameters };
}

export function imageParameterDefinitions(image: ImageModelConfiguration, modelId: string): ImageParameterDefinitions {
  if (image.profile === "openrouter") return image.parameters ?? {};
  if (image.profile === "gemini") {
    const modern = modelId.startsWith("gemini-3");
    return {
      aspect_ratio: enumeration("1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"),
      ...(modern ? { image_size: enumeration("1K", "2K", "4K") } : {}),
      mime_type: enumeration("image/png", "image/jpeg"),
      ...(modelId.includes("3.1-flash-image") ? { thinking_level: enumeration("minimal", "high") } : {})
    };
  }
  const secondGeneration = modelId.startsWith("gpt-image-2");
  const sunburst = modelId.startsWith("gpt-image-2.5");
  const gateway = image.profile === "codex_lb";
  return {
    size: secondGeneration ? { type: "dimensions" } : enumeration("auto", "1024x1024", "1536x1024", "1024x1536"),
    quality: sunburst && !gateway ? enumeration("auto", "low", "medium", "high", "xhigh", "max") : enumeration("auto", "low", "medium", "high"),
    output_format: enumeration("png", "jpeg", "webp"),
    output_compression: { type: "range", min: 0, max: 100 },
    background: secondGeneration && (!sunburst || gateway) ? enumeration("auto", "opaque") : enumeration("auto", "opaque", "transparent"),
    ...(!secondGeneration && modelId !== "gpt-image-1-mini" ? { input_fidelity: enumeration("low", "high") } : {})
  };
}

function validDimensions(value: unknown): boolean {
  if (value === "auto") return true;
  if (typeof value !== "string" || !/^\d{3,4}x\d{3,4}$/u.test(value)) return false;
  const [w, h] = value.split("x").map(Number) as [number, number];
  return w % 16 === 0 && h % 16 === 0 && w <= 3840 && h <= 3840 &&
    Math.max(w, h) / Math.min(w, h) <= 3 && w * h >= 655_360 && w * h <= 8_294_400;
}

export function normalizeImageGenerationParameters(
  value: unknown, image: ImageModelConfiguration, modelId: string
): ImageGenerationParameters {
  if (!record(value)) throw new Error("image_parameters_invalid");
  const definitions = imageParameterDefinitions(image, modelId);
  const normalized: ImageGenerationParameters = {};
  for (const [name, entry] of Object.entries(value)) {
    const definition = definitions[name as ImageParameterName];
    if (!definition || (definition.type === "enum" && (typeof entry !== "string" || !definition.values.includes(entry))) ||
      (definition.type === "range" && (!Number.isSafeInteger(entry) || Number(entry) < definition.min || Number(entry) > definition.max)) ||
      (definition.type === "dimensions" && !validDimensions(entry))) throw new Error("image_parameters_invalid");
    normalized[name as ImageParameterName] = entry as string | number;
  }
  if (normalized.background === "transparent" && normalized.output_format === "jpeg") throw new Error("image_parameters_invalid");
  return normalized;
}

/** Opaque attachment handles are the only references accepted from an LLM. */
export type ConversationImageReference = {
  attachmentId: string;
  messageId: string;
  fileName: string;
  origin: "upload" | "generated";
};

export type ThreadGeneratedImage = {
  attachmentId: string;
  fileName: string;
  mimeType: GeneratedImageMimeType;
  byteSize: number;
  width: number;
  height: number;
  sourceAttachmentIds: string[];
};

export function decodeThreadGeneratedImage(value: unknown): ThreadGeneratedImage | null {
  if (!record(value) || typeof value.attachmentId !== "string" || !value.attachmentId || value.attachmentId.length > 128 ||
    typeof value.fileName !== "string" || !value.fileName || value.fileName.length > 256 ||
    !IMAGE_MIME_TYPES.includes(value.mimeType as GeneratedImageMimeType) || !Number.isSafeInteger(value.byteSize) ||
    Number(value.byteSize) < 1 || Number(value.byteSize) > IMAGE_MAX_BYTES || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) ||
    Number(value.width) < 1 || Number(value.height) < 1 || Number(value.width) * Number(value.height) > IMAGE_MAX_PIXELS ||
    !Array.isArray(value.sourceAttachmentIds) || value.sourceAttachmentIds.length > IMAGE_MAX_INPUTS ||
    !value.sourceAttachmentIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128)) return null;
  return { attachmentId: value.attachmentId, fileName: value.fileName, mimeType: value.mimeType as GeneratedImageMimeType,
    byteSize: Number(value.byteSize), width: Number(value.width), height: Number(value.height), sourceAttachmentIds: value.sourceAttachmentIds as string[] };
}
