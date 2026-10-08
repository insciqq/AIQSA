import { validateStaticRaster } from "../uploads/staticRaster";
import {
  IMAGE_MAX_BYTES, IMAGE_MAX_INPUT_BYTES, IMAGE_MAX_INPUTS, IMAGE_MAX_PIXELS, IMAGE_MAX_PROMPT_CHARACTERS,
  IMAGE_MIME_TYPES, normalizeImageGenerationParameters,
  type GeneratedImageMimeType, type ImageGenerationParameters, type ImageFailureDiagnostic
} from "../../contracts/imageGeneration";
import {
  effectiveProviderResponseTimeoutMs, normalizeProviderConnectionConfiguration, normalizeProviderModelConfiguration,
  type ProviderConnectionConfiguration, type ProviderModelConfiguration
} from "./providerConfiguration";
import { createProviderSafeFetch } from "./providerSafeFetch";
import { resolveProviderCredentialSource, type ProviderCredentialSource } from "./providerCredentialSource";
import { isProviderDeadlineExceededError, ProviderResponseTooLargeError, readBoundedResponseText, withTimeoutSignal } from "./network";
import { imageFailureDiagnostic } from "./imageFailure";
import { reportedUsageCostUsd } from "./reportedUsageCost";
import { observeProviderDeadline, observeProviderFetch, observeProviderOperation } from "./providerObservability";
import type { ProviderStreamSafetyIdentity } from "./streamSafetyObservability";
import { ImageInputError } from "../images/inputError";

export type ImageGenerationInput = { bytes: Uint8Array; mimeType: GeneratedImageMimeType };
export type ImageGenerationRequest = {
  prompt: string;
  images?: readonly ImageGenerationInput[];
  parameters?: ImageGenerationParameters;
  signal?: AbortSignal;
};
export type ImageGenerationUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  /** USD this image cost as the provider reported it (`reportedUsageCostUsd`);
   * null when it reported none or a malformed amount. */
  costUsd: number | null;
};
export type ImageGenerationResult = {
  bytes: Uint8Array;
  mimeType: GeneratedImageMimeType;
  width: number;
  height: number;
  usage: ImageGenerationUsage;
};
export type ImageGenerationErrorCode = "image_input_invalid" | "image_parameters_invalid" | "image_response_invalid" |
  "image_response_too_large" | "image_provider_http_error" | "image_provider_request_failed" | "image_request_timed_out" |
  "image_request_cancelled" | "image_output_missing" | "image_generation_refused";
export type ImageFinishReason = "safety" | "blocked" | "other";
export class ImageGenerationError extends Error {
  /** What a completed response the adapter then rejected (no image, an
   * invalid image) reported, so the paid call can be accounted; null when no
   * response reported usage. */
  usage: ImageGenerationUsage | null = null;

  constructor(readonly code: ImageGenerationErrorCode, readonly httpStatus: number | null = null,
    readonly diagnostic?: ImageFailureDiagnostic, readonly finishReason?: ImageFinishReason) {
    super(code);
    this.name = "ImageGenerationError";
  }
}

/** Reference validation preserves the original bytes and never describes input as provider output. */
export async function validateImageReference(bytes: Uint8Array, declaredMime: unknown): Promise<void> {
  try {
    await validateStaticRaster(bytes, {
      maxBytes: IMAGE_MAX_BYTES, maxPixels: IMAGE_MAX_PIXELS, mimeTypes: IMAGE_MIME_TYPES
    }, { declaredMime });
  } catch { throw new ImageInputError("image_reference_unsupported"); }
}

function usageReported(usage: ImageGenerationUsage): boolean {
  return usage.inputTokens !== null || usage.outputTokens !== null || usage.totalTokens !== null || usage.costUsd !== null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647 ? Number(value) : null;

/** Full decoding rejects forged headers, decompression bombs and truncated output before storage. */
export async function validateGeneratedImage(bytes: Uint8Array, declaredMime?: unknown): Promise<{
  mimeType: GeneratedImageMimeType; width: number; height: number;
}> {
  if (!bytes.byteLength || bytes.byteLength > IMAGE_MAX_BYTES) throw new ImageGenerationError("image_response_too_large");
  try {
    return await validateStaticRaster(bytes, {
      maxBytes: IMAGE_MAX_BYTES, maxPixels: IMAGE_MAX_PIXELS, mimeTypes: IMAGE_MIME_TYPES
    }, { declaredMime });
  } catch {
    throw new ImageGenerationError("image_response_invalid");
  }
}

function imageBytes(base64: unknown): Uint8Array {
  if (typeof base64 !== "string" || !base64 || base64.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4 ||
    base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64)) throw new ImageGenerationError("image_response_invalid");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.toString("base64") !== base64) throw new ImageGenerationError("image_response_invalid");
  return bytes;
}

function responseUsage(value: unknown, gemini: boolean): ImageGenerationUsage {
  const usage = record(value) ? value : {};
  return {
    inputTokens: count(gemini ? usage.total_input_tokens : usage.input_tokens ?? usage.prompt_tokens),
    outputTokens: gemini
      ? count(usage.total_output_tokens) === null ? null : count(Number(usage.total_output_tokens) + (count(usage.total_thought_tokens) ?? 0))
      : count(usage.output_tokens ?? usage.completion_tokens),
    totalTokens: count(usage.total_tokens),
    costUsd: reportedUsageCostUsd(usage) ?? null
  };
}

export function imageGenerationEndpoint(connection: ProviderConnectionConfiguration, model: ProviderModelConfiguration, editing: boolean): string {
  const profile = model.image?.profile;
  // The gateway exposes images on the same authenticated origin under /v1.
  const root = profile === "codex_lb" && connection.apiRoot.endsWith("/backend-api/codex")
    ? `${connection.apiRoot.slice(0, -"/backend-api/codex".length)}/v1` : connection.apiRoot;
  return `${root}/${profile === "gemini" ? "interactions" : profile === "openrouter" ? "images" : editing ? "images/edits" : "images/generations"}`;
}

export function createImageGenerationAdapter(input: {
  connection: ProviderConnectionConfiguration;
  model: ProviderModelConfiguration;
  secret: ProviderCredentialSource;
  fetchFn?: typeof fetch;
  /** Server-owned connection/model identity for content-free provider events. */
  observationIdentity?: ProviderStreamSafetyIdentity;
}): { generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> } {
  const connection = normalizeProviderConnectionConfiguration(input.connection);
  const model = normalizeProviderModelConfiguration(input.model);
  if (model.modelClass !== "image" || !model.image) throw new ImageGenerationError("image_input_invalid");
  const imageConfiguration = model.image;
  const fetchFn = observeProviderFetch(input.fetchFn ?? createProviderSafeFetch({ configuration: connection, requestBodyMaxBytes: 96 * 1024 * 1024 }));
  const identity = input.observationIdentity ?? { adapterKind: model.adapterKind };
  return {
    async generate(request) {
      if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > IMAGE_MAX_PROMPT_CHARACTERS ||
        request.prompt.includes("\u0000") || request.images && !Array.isArray(request.images)) throw new ImageInputError("image_input_invalid");
      const images = request.images ?? [];
      if (images.length > IMAGE_MAX_INPUTS || images.reduce((sum, image) => sum + (image.bytes?.byteLength ?? Infinity), 0) > IMAGE_MAX_INPUT_BYTES) {
        throw new ImageInputError("image_input_invalid");
      }
      for (const image of images) await validateImageReference(image.bytes, image.mimeType);
      let parameters: ImageGenerationParameters;
      try {
        parameters = normalizeImageGenerationParameters({ ...model.defaultParams, ...request.parameters }, imageConfiguration, model.upstreamModelId);
      } catch { throw new ImageInputError("image_parameters_invalid"); }
      const gemini = imageConfiguration.profile === "gemini";
      const openrouter = imageConfiguration.profile === "openrouter";
      const headers: Record<string, string> = { accept: "application/json" };
      let body: BodyInit;
      if (gemini) {
        const { thinking_level, ...format } = parameters;
        body = JSON.stringify({
          model: model.upstreamModelId,
          input: [{ type: "text", text: request.prompt }, ...images.map((image) => ({
            type: "image", mime_type: image.mimeType, data: Buffer.from(image.bytes).toString("base64")
          }))],
          response_format: { type: "image", ...format },
          ...(thinking_level ? { generation_config: { thinking_level } } : {}),
          store: false, stream: false
        });
        headers["content-type"] = "application/json";
      } else if (openrouter) {
        const routing = model.openRouterRouting!;
        body = JSON.stringify({
          ...parameters, model: model.upstreamModelId, prompt: request.prompt, n: 1,
          ...(images.length ? { input_references: images.map((image) => ({
            type: "image_url", image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}` }
          })) } : {}),
          provider: { data_collection: "deny", allow_fallbacks: routing.mode === "automatic",
            ...(routing.mode === "only_selected" ? { only: routing.providers, order: routing.providers } : {}) }
        });
        headers["content-type"] = "application/json";
      } else if (images.length) {
        const form = new FormData();
        form.set("model", model.upstreamModelId);
        form.set("prompt", request.prompt);
        form.set("n", "1");
        for (const [key, value] of Object.entries(parameters)) form.set(key, String(value));
        for (const [index, image] of images.entries()) {
          form.append("image[]", new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `reference-${index + 1}.${image.mimeType.split("/")[1]}`);
        }
        body = form;
      } else {
        // input_fidelity config applies only when a reference image is supplied.
        const { input_fidelity: _fidelity, ...generationParameters } = parameters;
        body = JSON.stringify({ ...generationParameters, model: model.upstreamModelId, prompt: request.prompt, n: 1 });
        headers["content-type"] = "application/json";
      }
      const timeoutMs = effectiveProviderResponseTimeoutMs(connection, model);
      observeProviderDeadline({ ...identity, stage: "image", provider_timeout_ms: timeoutMs, effective_timeout_ms: timeoutMs });
      // One provider_operation per paid request: identity, outcome, duration,
      // HTTP status and the closed ImageGenerationError code, never the body.
      return observeProviderOperation(identity, "image", async () => {
        const timeout = withTimeoutSignal(request.signal, timeoutMs);
        try {
          timeout.signal.throwIfAborted();
          if (connection.authenticationMode !== "none") {
            const secret = await resolveProviderCredentialSource(input.secret, "image_provider_request_failed");
            if (gemini) headers["x-goog-api-key"] = secret;
            else headers.authorization = `Bearer ${secret}`;
          }
          // Never replay an ambiguous paid image request after a timeout or network error.
          const response = await fetchFn(imageGenerationEndpoint(connection, model, images.length > 0), {
            body, headers, method: "POST", redirect: "error", signal: timeout.signal
          });
          if (!response.ok) {
            let rejected = "";
            try { rejected = await readBoundedResponseText(response, { maxBytes: 32 * 1024, signal: timeout.signal }); }
            catch (error) { if (!(error instanceof ProviderResponseTooLargeError)) throw error; }
            throw new ImageGenerationError("image_provider_http_error", response.status, imageFailureDiagnostic(rejected, response.status));
          }
          const text = await readBoundedResponseText(response, { maxBytes: 36 * 1024 * 1024, signal: timeout.signal });
          let parsed: unknown;
          try { parsed = JSON.parse(text) as unknown; } catch { throw new ImageGenerationError("image_response_invalid"); }
          if (!record(parsed)) throw new ImageGenerationError("image_response_invalid");
          const usage = responseUsage(parsed.usage, gemini);
          try {
            return { ...await decodedImage(parsed, gemini), usage };
          } catch (error) {
            // The response completed and is paid even though its image is rejected.
            if (error instanceof ImageGenerationError && usageReported(usage)) error.usage = usage;
            throw error;
          }
        } catch (error) {
          if (error instanceof ImageGenerationError) throw error;
          if (request.signal?.aborted) throw new ImageGenerationError("image_request_cancelled");
          if (isProviderDeadlineExceededError(error) || isProviderDeadlineExceededError(timeout.signal.reason)) throw new ImageGenerationError("image_request_timed_out");
          if (error instanceof ProviderResponseTooLargeError) throw new ImageGenerationError("image_response_too_large");
          throw new ImageGenerationError("image_provider_request_failed");
        } finally { timeout.clear(); }
      }, { timeoutMs, signal: request.signal });
    }
  };
}

async function decodedImage(parsed: Record<string, unknown>, gemini: boolean): Promise<{
  bytes: Uint8Array; mimeType: GeneratedImageMimeType; width: number; height: number;
}> {
  let encoded: unknown;
  let mimeType: unknown;
  if (gemini) {
    if (typeof parsed.status !== "string") throw new ImageGenerationError("image_response_invalid");
    if (parsed.status !== "completed") throw geminiImageRefusal(parsed);
    if (!Array.isArray(parsed.steps) || parsed.steps.length > 1000) throw new ImageGenerationError("image_response_invalid");
    const outputs = parsed.steps.flatMap((step: unknown) => record(step) && step.type === "model_output" && Array.isArray(step.content)
      ? step.content.filter((part: unknown) => record(part) && part.type === "image" && part.thought !== true) : []);
    if (!outputs.length) throw geminiImageRefusal(parsed);
    if (outputs.length !== 1 || !record(outputs[0])) throw new ImageGenerationError("image_response_invalid");
    encoded = outputs[0].data;
    mimeType = outputs[0].mime_type;
  } else {
    if (!Array.isArray(parsed.data) || parsed.data.length !== 1 || !record(parsed.data[0])) throw new ImageGenerationError("image_output_missing");
    encoded = parsed.data[0].b64_json;
    mimeType = parsed.data[0].media_type;
  }
  const bytes = imageBytes(encoded);
  const metadata = await validateGeneratedImage(bytes, mimeType);
  return { bytes, ...metadata };
}

function geminiImageRefusal(parsed: Record<string, unknown>): ImageGenerationError {
  const steps = Array.isArray(parsed.steps) ? parsed.steps.slice(0, 1000).filter(record) : [];
  const reasons = [parsed.status, parsed.finish_reason, record(parsed.error) ? parsed.error.code : undefined,
    ...steps.map((step) => step.finish_reason)];
  const safety = reasons.some((reason) => ["SAFETY", "safety", "IMAGE_SAFETY", "content_policy_violation", "safety_violation"].includes(typeof reason === "string" ? reason : ""));
  const blocked = reasons.some((reason) => ["blocked", "BLOCKED", "refused", "PROHIBITED_CONTENT"].includes(typeof reason === "string" ? reason : "")) ||
    steps.some((step) => Array.isArray(step.content) && step.content.some((part: unknown) => record(part) && part.type === "refusal"));
  return new ImageGenerationError("image_generation_refused", null, undefined, safety ? "safety" : blocked ? "blocked" : "other");
}
