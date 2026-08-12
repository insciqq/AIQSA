import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { geminiInteractionsToolBridge } from "../tools/bridges";
import {
  providerAttachmentPreviewMediaType,
  providerAttachmentPreviewText,
  providerAttachmentText
} from "./attachmentPayload";
import {
  conversationMessagesForRequest,
  conversationPreview,
  textConversationForRequest
} from "./context";
import { geminiInteractionStepForWire } from "./geminiInteractionsProtocol";
import type { ProviderAttachment, ProviderRunRequest } from "./types";
import { providerInstructionsWithPersonalContext } from "./personalContext";

const DEFAULT_MAX_OUTPUT_TOKENS = 65_536;
const MAX_INT32 = 2_147_483_647;
const imageMimeTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/bmp",
  "image/tiff"
]);
const thinkingLevels = new Set(["minimal", "low", "medium", "high"]);

export type GeminiInteractionStep = Record<string, unknown>;

export type GeminiInteractionsRequestBody = Record<string, unknown> & {
  generation_config: {
    max_output_tokens: number;
    thinking_level?: string;
    thinking_summaries: "none";
    tool_choice?: "any" | "auto" | "none";
  };
  input: GeminiInteractionStep[];
  model: string;
  store: false;
  stream: boolean;
  system_instruction?: string;
  tools?: Record<string, unknown>[];
};

export type GeminiInteractionsRequestOptions = Readonly<{
  maxAttachmentTextChars?: number;
}>;

export type GeminiInteractionsRequestPreview = {
  body: GeminiInteractionsRequestBody;
  provider: "gemini";
  redactions: [
    "attachment_base64",
    "attachment_extracted_text",
    "attachment_filename",
    "attachment_media_type",
    "grounding_suggestions",
    "provider_signatures"
  ];
  replayedContext: {
    id: string;
    role: "assistant" | "user";
    text: string;
  }[];
};

type BuildOptions = GeminiInteractionsRequestOptions & {
  preview: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

function combineSystemInstruction(request: ProviderRunRequest): string | undefined {
  return providerInstructionsWithPersonalContext(request);
}

function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

function imageData(attachment: ProviderAttachment, preview: boolean): string {
  if (preview) {
    return "[base64 image data omitted]";
  }
  if (!attachment.dataUrl) {
    throw new Error(`image_attachment_data_unavailable:${attachment.id}`);
  }

  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]+=*)$/u.exec(attachment.dataUrl);
  if (!match || match[1] !== attachment.mimeType || !validBase64(match[2] ?? "")) {
    throw new Error(`image_attachment_data_invalid:${attachment.id}`);
  }

  return match[2] as string;
}

function imageContent(attachment: ProviderAttachment, preview: boolean): Record<string, unknown> {
  if (!imageMimeTypes.has(attachment.mimeType)) {
    throw new Error(`image_attachment_type_unsupported:${attachment.id}`);
  }

  return {
    data: imageData(attachment, preview),
    mime_type: preview ? providerAttachmentPreviewMediaType : attachment.mimeType,
    type: "image"
  };
}

function pdfContent(attachment: ProviderAttachment, preview: boolean): Record<string, unknown> {
  const data = preview ? "[base64 PDF data omitted]" : attachment.base64Data;
  if (!data) {
    throw new Error(`pdf_attachment_data_unavailable:${attachment.id}`);
  }
  if (!preview && !validBase64(data)) {
    throw new Error(`pdf_attachment_data_invalid:${attachment.id}`);
  }

  return {
    data,
    mime_type: "application/pdf",
    type: "document"
  };
}

function attachmentPlaceholderText(
  content: { blocks?: readonly unknown[] } | undefined,
  preview: boolean
): string {
  const lines = (content?.blocks ?? []).flatMap((value): string[] => {
    if (!isRecord(value) || typeof value.attachmentId !== "string") {
      return [];
    }

    if (value.type === "image") {
      return ["[image attachment]"];
    }

    if (value.type === "file") {
      return preview || typeof value.fileName !== "string" || value.fileName.length === 0
        ? ["[file attachment]"]
        : [`[file attachment: ${value.fileName}]`];
    }

    return ["[attachment]"];
  });

  return lines.join("\n") || "[attachment]";
}

function latestUserContent(
  request: ProviderRunRequest,
  options: BuildOptions
): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  const text = textFromContentBlocks(request.content);

  if (text.trim()) {
    content.push({ text, type: "text" });
  }

  for (const attachment of request.attachments) {
    if (attachment.kind === "image") {
      content.push(imageContent(attachment, options.preview));
      continue;
    }

    if (attachment.kind === "pdf" && request.modelCapabilities.nativePdfInput) {
      content.push(pdfContent(attachment, options.preview));
      continue;
    }

    if (attachment.kind === "pdf" || attachment.kind === "document") {
      const attachmentText = options.preview
        ? providerAttachmentPreviewText(attachment)
        : providerAttachmentText(attachment, options.maxAttachmentTextChars);
      if (attachmentText) {
        content.push({ text: attachmentText, type: "text" });
      }
    }
  }

  if (content.length === 0) {
    content.push({
      text: attachmentPlaceholderText(request.content, options.preview),
      type: "text"
    });
  }

  return content;
}

function textStep(role: "assistant" | "user", text: string): GeminiInteractionStep {
  return {
    content: [{ text, type: "text" }],
    type: role === "assistant" ? "model_output" : "user_input"
  };
}

function stringArray(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) {
    return null;
  }
  if (value.some((item) => !boundedString(item, maxLength))) {
    return null;
  }

  return value as string[];
}

function validTextContent(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "text" || typeof value.text !== "string") {
    return false;
  }
  if (value.annotations === undefined) {
    return true;
  }

  return Array.isArray(value.annotations) && value.annotations.length <= 100 &&
    value.annotations.every((annotation) => isRecord(annotation));
}

function validModelOutput(step: Record<string, unknown>): boolean {
  return Array.isArray(step.content) && step.content.length <= 1_000 &&
    step.content.every(validTextContent);
}

function validFunctionCall(step: Record<string, unknown>): boolean {
  return boundedString(step.id, 512) && boundedString(step.name, 512) && isRecord(step.arguments) &&
    (step.signature === undefined || boundedString(step.signature, 1_000_000));
}

function validFunctionResult(step: Record<string, unknown>): boolean {
  if (!boundedString(step.call_id, 512)) {
    return false;
  }
  if (step.name !== undefined && !boundedString(step.name, 512)) {
    return false;
  }
  if (step.is_error !== undefined && typeof step.is_error !== "boolean") {
    return false;
  }

  return typeof step.result === "string" || isRecord(step.result) ||
    (Array.isArray(step.result) && step.result.length <= 1_000 && step.result.every(validTextContent));
}

function validThought(step: Record<string, unknown>): boolean {
  if (!boundedString(step.signature, 1_000_000)) {
    return false;
  }
  if (step.summary === undefined) {
    return true;
  }

  return Array.isArray(step.summary) && step.summary.length <= 1_000 && step.summary.every(validTextContent);
}

function validGoogleSearchCall(step: Record<string, unknown>): boolean {
  if (!boundedString(step.id, 512)) {
    return false;
  }
  if (step.search_type !== undefined && step.search_type !== "web_search" && step.search_type !== "image_search") {
    return false;
  }
  if (!boundedString(step.signature, 1_000_000)) {
    return false;
  }
  if (step.arguments === undefined) {
    return true;
  }
  if (!isRecord(step.arguments)) {
    return false;
  }

  return step.arguments.queries === undefined || Boolean(stringArray(step.arguments.queries, 100, 2_048));
}

function validGoogleSearchResult(step: Record<string, unknown>): boolean {
  if (!boundedString(step.call_id, 512)) {
    return false;
  }
  if (step.is_error !== undefined && typeof step.is_error !== "boolean") {
    return false;
  }
  if (!boundedString(step.signature, 1_000_000)) {
    return false;
  }
  if (step.result === undefined) {
    return true;
  }

  return Array.isArray(step.result) && step.result.length <= 100 && step.result.every((item) => {
    return isRecord(item) &&
      (item.search_suggestions === undefined || boundedString(item.search_suggestions, 262_144));
  });
}

function validateContinuationStep(step: Record<string, unknown>): void {
  const valid =
    (step.type === "model_output" && validModelOutput(step)) ||
    (step.type === "thought" && validThought(step)) ||
    (step.type === "function_call" && validFunctionCall(step)) ||
    (step.type === "function_result" && validFunctionResult(step)) ||
    (step.type === "google_search_call" && validGoogleSearchCall(step)) ||
    (step.type === "google_search_result" && validGoogleSearchResult(step));

  if (!valid) {
    throw new Error("gemini_interactions_continuation_invalid");
  }
}

function previewStep(value: Record<string, unknown>): Record<string, unknown> {
  const step = { ...value };
  delete step.signature;
  if (step.type === "thought") {
    delete step.summary;
  }
  if (step.type === "google_search_result") {
    delete step.result;
  }
  return step;
}

function flattenContinuationMessages(messages: unknown[] | undefined): Record<string, unknown>[] {
  const flattened: unknown[] = [];
  for (const message of messages ?? []) {
    if (Array.isArray(message)) {
      flattened.push(...message);
    } else {
      flattened.push(message);
    }
  }

  if (flattened.some((message) => !isRecord(message))) {
    throw new Error("gemini_interactions_continuation_invalid");
  }

  return flattened as Record<string, unknown>[];
}

function continuationSteps(
  messages: unknown[] | undefined,
  preview: boolean
): Record<string, unknown>[] {
  return flattenContinuationMessages(messages).map((message) => {
    const wireStep = geminiInteractionStepForWire(message);
    validateContinuationStep(wireStep);
    return preview ? previewStep(wireStep) : wireStep;
  });
}

function reasoningEffort(params: Record<string, unknown>): string | undefined {
  const reasoning = isRecord(params.reasoning) ? params.reasoning : null;
  const effort = reasoning?.effort;
  return typeof effort === "string" && thinkingLevels.has(effort) ? effort : undefined;
}

function maxOutputTokens(params: Record<string, unknown>): number {
  const value = Math.floor(maxOutputTokensFromParams(params) ?? DEFAULT_MAX_OUTPUT_TOKENS);
  if (value <= 0 || value > MAX_INT32) {
    throw new Error("gemini_interactions_max_output_tokens_invalid");
  }
  return value;
}

function usesHostedGoogleSearch(request: ProviderRunRequest): boolean {
  return request.searchPlan
    ? request.searchPlan.options.some((option) =>
        option.adapterKind === "answer_provider_hosted" &&
        option.protocol === "gemini_google_search")
    : request.searchStrategy === "gemini-google-search";
}

function buildGeminiInteractionsBody(
  request: ProviderRunRequest,
  options: BuildOptions
): GeminiInteractionsRequestBody {
  const storedConversationById = new Map(
    conversationMessagesForRequest(request).map((message) => [message.id, message.content])
  );
  const conversation = textConversationForRequest(request);
  let latestUserIndex = -1;
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role === "user") {
      latestUserIndex = index;
      break;
    }
  }
  const input = conversation.map((message, index): GeminiInteractionStep => {
    if (message.role === "user" && index === latestUserIndex) {
      return {
        content: latestUserContent(request, options),
        type: "user_input"
      };
    }
    return textStep(
      message.role,
      message.role === "user" && !message.content.trim()
        ? attachmentPlaceholderText(storedConversationById.get(message.id), options.preview)
        : message.content
    );
  });
  input.push(...continuationSteps(request.providerToolMessages, options.preview));

  const serializedTools = (request.tools ?? []).map((tool) =>
    geminiInteractionsToolBridge.serializeTool(tool).tool
  );
  const hostedTools = usesHostedGoogleSearch(request)
    ? [{ type: "google_search" }]
    : [];
  if (hostedTools.length > 0 && serializedTools.length > 0) {
    throw new Error("gemini_interactions_tool_combination_unsupported");
  }
  const tools: Record<string, unknown>[] = [...hostedTools, ...serializedTools];
  const effort = request.modelCapabilities.reasoning ? reasoningEffort(request.params) : undefined;
  const generationConfig: GeminiInteractionsRequestBody["generation_config"] = {
    max_output_tokens: maxOutputTokens(request.params),
    ...(effort ? { thinking_level: effort } : {}),
    thinking_summaries: "none"
  };
  if (tools.length > 0) {
    generationConfig.tool_choice = request.toolChoice === "required"
      ? "any"
      : request.toolChoice ?? "auto";
  }

  const body: GeminiInteractionsRequestBody = {
    generation_config: generationConfig,
    input,
    model: request.modelId,
    store: false,
    stream: request.forceNonStreaming === true
      ? false
      : typeof request.params.stream === "boolean"
        ? request.params.stream
        : true
  };
  const systemInstruction = combineSystemInstruction(request);
  if (systemInstruction) {
    body.system_instruction = systemInstruction;
  }
  if (tools.length > 0) {
    body.tools = tools;
  }

  return body;
}

export function buildGeminiInteractionsRequest(
  request: ProviderRunRequest,
  options: GeminiInteractionsRequestOptions = {}
): GeminiInteractionsRequestBody {
  return buildGeminiInteractionsBody(request, { ...options, preview: false });
}

export function buildGeminiInteractionsRequestPreview(
  request: ProviderRunRequest,
  options: GeminiInteractionsRequestOptions = {}
): GeminiInteractionsRequestPreview {
  return {
    body: buildGeminiInteractionsBody(request, { ...options, preview: true }),
    provider: "gemini",
    redactions: [
      "attachment_base64",
      "attachment_extracted_text",
      "attachment_filename",
      "attachment_media_type",
      "grounding_suggestions",
      "provider_signatures"
    ],
    replayedContext: conversationPreview(request)
  };
}
