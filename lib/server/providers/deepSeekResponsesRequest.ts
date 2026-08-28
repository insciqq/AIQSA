import {
  normalizeDeepSeekResponsesParams,
  type DeepSeekResponsesParams
} from "../../domain/providerParams";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { deepSeekResponsesToolBridge } from "../tools/bridges";
import {
  providerAttachmentPreviewText,
  providerAttachmentText
} from "./attachmentPayload";
import { conversationPreview, textConversationForRequest } from "./context";
import { providerInstructionsWithPersonalContext } from "./personalContext";
import type { ProviderAttachment, ProviderRunRequest } from "./types";

export type DeepSeekResponsesTextContentBlock = Readonly<{
  text: string;
  type: "input_text" | "output_text";
}>;

export type DeepSeekResponsesImageContentBlock = Readonly<{
  detail: "auto" | "original";
  image_url: string;
  type: "input_image";
}>;

export type DeepSeekResponsesContentBlock =
  | DeepSeekResponsesImageContentBlock
  | DeepSeekResponsesTextContentBlock;

export type DeepSeekResponsesInputMessage = Readonly<{
  content: DeepSeekResponsesContentBlock[];
  role: "assistant" | "user";
}>;

export type DeepSeekResponsesRequestBody = Readonly<{
  input: Array<DeepSeekResponsesInputMessage | Record<string, unknown>>;
  instructions?: string;
  max_output_tokens: number;
  model: string;
  reasoning: Readonly<{ effort: string }>;
  stream: boolean;
  temperature?: number;
  tool_choice?: "auto" | "none" | "required";
  tools?: Record<string, unknown>[];
}>;

export type DeepSeekResponsesRequestPreview = Readonly<{
  body: DeepSeekResponsesRequestBody;
  provider: "deepseek";
  redactions: readonly [
    "attachment_extracted_text",
    "image_data_url",
    "selected_skill_instructions",
    "provider_continuation_opaque_fields"
  ];
  replayedContext: Array<Readonly<{
    id: string;
    role: "assistant" | "user";
    text: string;
  }>>;
  stateless: true;
}>;

type BuildOptions = Readonly<{
  maxAttachmentTextChars?: number;
  preview: boolean;
  redactImages: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentTextBlock(
  attachment: ProviderAttachment,
  options: BuildOptions
): DeepSeekResponsesTextContentBlock | null {
  const text = options.preview
    ? providerAttachmentPreviewText(attachment)
    : providerAttachmentText(attachment, options.maxAttachmentTextChars);
  return text ? { text, type: "input_text" } : null;
}

function imageBlock(
  attachment: ProviderAttachment,
  redactImages: boolean
): DeepSeekResponsesImageContentBlock {
  const metadata = isRecord(attachment.metadata) ? attachment.metadata : {};
  const image = isRecord(metadata.image) ? metadata.image : {};
  const detail = image.detail === "original" ? "original" : "auto";
  if (redactImages) {
    return { detail, image_url: "[image data url omitted]", type: "input_image" };
  }
  if (!attachment.dataUrl) {
    throw new Error(`image_attachment_data_unavailable:${attachment.id}`);
  }
  return { detail, image_url: attachment.dataUrl, type: "input_image" };
}

function inputContent(
  request: ProviderRunRequest,
  options: BuildOptions
): DeepSeekResponsesContentBlock[] {
  const content: DeepSeekResponsesContentBlock[] = [];
  const text = textFromContentBlocks(request.content);
  if (text.trim()) content.push({ text, type: "input_text" });

  for (const attachment of request.attachments) {
    if (attachment.kind === "pdf" || attachment.kind === "document") {
      const block = attachmentTextBlock(attachment, options);
      if (block) content.push(block);
    } else if (attachment.kind === "image") {
      content.push(imageBlock(attachment, options.redactImages));
    }
  }

  if (content.length === 0) content.push({ text: "", type: "input_text" });
  return content;
}

function previewContinuationItem(
  message: Record<string, unknown>
): Record<string, unknown> | null {
  if (message.type === "reasoning") return { type: "reasoning" };
  if (message.type === "function_call") {
    return {
      ...(typeof message.call_id === "string" ? { call_id: message.call_id } : {}),
      ...(typeof message.name === "string" ? { name: message.name } : {}),
      type: "function_call"
    };
  }
  if (message.type === "function_call_output") {
    return {
      ...(typeof message.call_id === "string" ? { call_id: message.call_id } : {}),
      output: "[tool output omitted]",
      type: "function_call_output"
    };
  }
  return null;
}

function continuationItems(messages: unknown[] | undefined, preview: boolean) {
  return (messages ?? []).flatMap((message): Record<string, unknown>[] => {
    const values = Array.isArray(message) ? message : [message];
    return values.flatMap((value): Record<string, unknown>[] => {
      if (!isRecord(value)) return [];
      if (!preview) return [value];
      const safe = previewContinuationItem(value);
      return safe ? [safe] : [];
    });
  });
}

function buildBody(
  request: ProviderRunRequest,
  options: BuildOptions
): DeepSeekResponsesRequestBody {
  const params = normalizeDeepSeekResponsesParams(
    request.params as Partial<DeepSeekResponsesParams> & Record<string, unknown>
  );
  const conversation = textConversationForRequest(request, {
    redactSkillContext: options.preview
  });
  const input: Array<DeepSeekResponsesInputMessage | Record<string, unknown>> =
    conversation.map((message, index) => ({
      content: index === conversation.length - 1 && message.role === "user"
        ? inputContent(request, options)
        : [{
            text: message.content,
            type: message.role === "assistant" ? "output_text" as const : "input_text" as const
          }],
      role: message.role
    }));
  input.push(...continuationItems(request.providerToolMessages, options.preview));

  const hostedTools = deepSeekResponsesToolBridge.serializeHostedTools?.(request) ?? [];
  const functionTools = (request.tools ?? []).map(
    (tool) => deepSeekResponsesToolBridge.serializeTool(tool).tool
  );
  const tools = [...hostedTools, ...functionTools];
  const instructions = providerInstructionsWithPersonalContext(request);
  const effort = params.reasoning.effort;
  return {
    input,
    ...(instructions ? { instructions } : {}),
    max_output_tokens: params.maxOutputTokens,
    model: request.modelId || "deepseek-v4-pro",
    reasoning: { effort },
    stream: request.forceNonStreaming === true ? false : params.stream,
    ...(effort === "none" ? { temperature: params.temperature } : {}),
    ...(tools.length > 0
      ? {
          tool_choice: request.toolChoice ?? "auto",
          tools
        }
      : {})
  };
}

export function buildDeepSeekResponsesRequest(
  request: ProviderRunRequest,
  options: Readonly<{ maxAttachmentTextChars?: number }> = {}
): DeepSeekResponsesRequestBody {
  return buildBody(request, {
    ...options,
    preview: false,
    redactImages: false
  });
}

export function buildDeepSeekResponsesRequestPreview(
  request: ProviderRunRequest,
  options: Readonly<{ maxAttachmentTextChars?: number }> = {}
): DeepSeekResponsesRequestPreview {
  return {
    body: buildBody(request, {
      ...options,
      preview: true,
      redactImages: true
    }),
    provider: "deepseek",
    redactions: [
      "attachment_extracted_text",
      "image_data_url",
      "selected_skill_instructions",
      "provider_continuation_opaque_fields"
    ],
    replayedContext: conversationPreview(request),
    stateless: true
  };
}
