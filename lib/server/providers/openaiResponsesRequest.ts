import { normalizeOpenAIResponsesParams, type OpenAIResponsesParams } from "../../domain/providerParams";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { openAIResponsesToolBridge } from "../tools/bridges";
import {
  providerAttachmentPreviewFilename,
  providerAttachmentPreviewText,
  providerAttachmentText
} from "./attachmentPayload";
import { conversationPreview, providerPromptCacheKey, textConversationForRequest } from "./context";
import type { ProviderAttachment, ProviderRunRequest } from "./types";
import { providerInstructionsWithPersonalContext } from "./personalContext";

export type OpenAIResponsesTextContentBlock = {
  text: string;
  type: "input_text" | "output_text";
};

export type OpenAIResponsesImageContentBlock = {
  detail: "auto";
  image_url: string;
  type: "input_image";
};

export type OpenAIResponsesFileContentBlock = {
  file_data: string;
  filename: string;
  type: "input_file";
};

export type OpenAIResponsesContentBlock =
  | OpenAIResponsesFileContentBlock
  | OpenAIResponsesImageContentBlock
  | OpenAIResponsesTextContentBlock;

export type OpenAIResponsesInputMessage = {
  content: OpenAIResponsesContentBlock[];
  role: "assistant" | "user";
};

export type OpenAIResponsesInputItem = OpenAIResponsesInputMessage | Record<string, unknown>;

export type OpenAIResponsesRequestBody = {
  background: boolean;
  include?: ["web_search_call.action.sources"];
  input: OpenAIResponsesInputItem[];
  instructions?: string;
  max_output_tokens: number;
  metadata: {
    app: "aiqsa";
    context: "manual_context_replay" | "provider_context";
  };
  model: string;
  parallel_tool_calls?: boolean;
  previous_response_id?: string;
  prompt_cache_key: string;
  prompt_cache_options?: {
    ttl: "30m";
  };
  prompt_cache_retention?: "24h";
  reasoning?: {
    effort: string;
    mode?: NonNullable<OpenAIResponsesParams["reasoning"]["mode"]>;
    summary?: Exclude<OpenAIResponsesParams["reasoning"]["summary"], "none">;
  };
  store: boolean;
  stream: boolean;
  temperature: number;
  tool_choice?: "auto" | "none" | "required";
  tools?: Record<string, unknown>[];
};

export type OpenAIResponsesRequestOptions = Readonly<{
  maxAttachmentTextChars?: number;
}>;

export type OpenAIResponsesRequestPreview = {
  body: OpenAIResponsesRequestBody;
  provider: "openai";
  redactions: [
    "attachment_extracted_text",
    "attachment_filename",
    "image_data_url",
    "pdf_base64",
    "provider_continuation_opaque_fields"
  ];
  replayedContext: {
    id: string;
    role: "assistant" | "user";
    text: string;
  }[];
};

type PrivateBuildOptions = OpenAIResponsesRequestOptions & {
  preview: boolean;
  redactFiles: boolean;
  redactImages: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function combineInstructions(request: ProviderRunRequest): string | undefined {
  return providerInstructionsWithPersonalContext(request);
}

function attachmentTextBlock(
  attachment: ProviderAttachment,
  maxChars: number | undefined,
  preview: boolean
): OpenAIResponsesTextContentBlock | null {
  const text = preview
    ? providerAttachmentPreviewText(attachment)
    : providerAttachmentText(attachment, maxChars);
  if (!text) {
    return null;
  }

  return {
    text,
    type: "input_text"
  };
}

function pdfFileData(attachment: ProviderAttachment, redactFiles: boolean): string {
  if (redactFiles) {
    return "[base64 PDF data omitted]";
  }

  if (!attachment.base64Data) {
    throw new Error(`pdf_attachment_data_unavailable:${attachment.id}`);
  }

  return `data:application/pdf;base64,${attachment.base64Data}`;
}

function pdfFileBlock(
  attachment: ProviderAttachment,
  redactFiles: boolean,
  preview: boolean
): OpenAIResponsesFileContentBlock {
  return {
    file_data: pdfFileData(attachment, redactFiles),
    filename: preview ? providerAttachmentPreviewFilename : attachment.fileName,
    type: "input_file"
  };
}

function imageBlock(
  attachment: ProviderAttachment,
  redactImages: boolean
): OpenAIResponsesImageContentBlock {
  if (redactImages) {
    return {
      detail: "auto",
      image_url: "[image data url omitted]",
      type: "input_image"
    };
  }

  if (!attachment.dataUrl) {
    throw new Error(`image_attachment_data_unavailable:${attachment.id}`);
  }

  return {
    detail: "auto",
    image_url: attachment.dataUrl,
    type: "input_image"
  };
}

function buildInputContent(
  request: ProviderRunRequest,
  options: PrivateBuildOptions
): OpenAIResponsesContentBlock[] {
  const content: OpenAIResponsesContentBlock[] = [];
  const text = textFromContentBlocks(request.content);

  if (text.trim()) {
    content.push({
      text,
      type: "input_text"
    });
  }

  for (const attachment of request.attachments) {
    if (attachment.kind === "pdf" && request.modelCapabilities.nativePdfInput) {
      content.push(pdfFileBlock(attachment, options.redactFiles, options.preview));
      continue;
    }

    if (attachment.kind === "pdf" || attachment.kind === "document") {
      const block = attachmentTextBlock(
        attachment,
        options.maxAttachmentTextChars,
        options.preview
      );
      if (block) {
        content.push(block);
      }
    }

    if (attachment.kind === "image") {
      content.push(imageBlock(attachment, options.redactImages));
    }
  }

  if (content.length === 0) {
    content.push({
      text: "",
      type: "input_text"
    });
  }

  return content;
}

function providerToolPreviewItem(message: Record<string, unknown>): Record<string, unknown> | null {
  if (message.type === "reasoning") {
    return { type: "reasoning" };
  }

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

function providerToolInputItems(
  messages: unknown[] | undefined,
  preview: boolean
): Record<string, unknown>[] {
  return (messages ?? []).flatMap((message) => {
    if (Array.isArray(message)) {
      return message.flatMap((item) => {
        if (!isRecord(item)) return [];
        if (!preview) return [item];
        const safe = providerToolPreviewItem(item);
        return safe ? [safe] : [];
      });
    }

    if (!isRecord(message)) return [];
    if (!preview) return [message];
    const safe = providerToolPreviewItem(message);
    return safe ? [safe] : [];
  });
}

function buildReasoning(params: OpenAIResponsesParams): OpenAIResponsesRequestBody["reasoning"] {
  return {
    effort: params.reasoning.effort,
    ...(params.reasoning.mode ? { mode: params.reasoning.mode } : {}),
    ...(params.reasoning.effort !== "none" && params.reasoning.summary !== "none"
      ? { summary: params.reasoning.summary }
      : {})
  };
}

function usesGpt56PromptCacheOptions(modelId: string): boolean {
  return modelId === "gpt-5.6" || modelId.startsWith("gpt-5.6-");
}

export function usesHostedOpenAIWebSearch(request: ProviderRunRequest): boolean {
  return request.searchPlan.options.some((option) =>
    option.adapterKind === "answer_provider_hosted" &&
    option.protocol === "openai_responses_web_search");
}

function buildOpenAIResponsesBody(
  request: ProviderRunRequest,
  options: PrivateBuildOptions
): OpenAIResponsesRequestBody {
  const params = normalizeOpenAIResponsesParams(request.params as Partial<OpenAIResponsesParams>);
  const serializedTools = (request.tools ?? []).map((tool) => openAIResponsesToolBridge.serializeTool(tool).tool);
  const hostedSearch = usesHostedOpenAIWebSearch(request);
  const hostedTools = hostedSearch ? [{ type: "web_search" }] : [];
  const tools: Record<string, unknown>[] = [...hostedTools, ...serializedTools];
  const forceForeground = request.forceNonStreaming === true;
  const background = forceForeground ? false : Boolean(params.background);
  const stream = forceForeground ? false : params.stream;
  const instructions = combineInstructions(request);
  const conversation = request.previousProviderResponseId
    ? []
    : textConversationForRequest(request);
  const input: OpenAIResponsesInputItem[] = conversation.map((message, index): OpenAIResponsesInputMessage => ({
    content:
      index === conversation.length - 1 && message.role === "user"
        ? buildInputContent(request, options)
        : [
            {
              text: message.content,
              type: message.role === "assistant" ? "output_text" : "input_text"
            }
          ],
    role: message.role
  }));
  input.push(...providerToolInputItems(request.providerToolMessages, options.preview));
  const model = request.modelId || "gpt-5.5";

  const body: OpenAIResponsesRequestBody = {
    background,
    input,
    max_output_tokens: params.maxOutputTokens,
    metadata: {
      app: "aiqsa",
      context: params.manualContextReplay ? "manual_context_replay" : "provider_context"
    },
    model,
    prompt_cache_key: providerPromptCacheKey(request.chatId),
    ...(usesGpt56PromptCacheOptions(model)
      ? { prompt_cache_options: { ttl: "30m" } }
      : { prompt_cache_retention: "24h" }),
    store: background ? true : params.store,
    stream,
    temperature: params.temperature
  };
  const reasoning = buildReasoning(params);

  if (instructions) {
    body.instructions = instructions;
  }

  if (request.previousProviderResponseId) {
    body.previous_response_id = request.previousProviderResponseId;
  }

  if (reasoning) {
    body.reasoning = reasoning;
  }

  if (hostedSearch) {
    body.include = ["web_search_call.action.sources"];
  }

  if (tools.length > 0) {
    body.tool_choice = request.toolChoice ?? "auto";
    body.tools = tools;
  }

  if (serializedTools.length > 0) {
    body.parallel_tool_calls = request.parallelToolCalls === true;
  }

  return body;
}

export function buildOpenAIResponsesRequest(
  request: ProviderRunRequest,
  options: OpenAIResponsesRequestOptions = {}
): OpenAIResponsesRequestBody {
  return buildOpenAIResponsesBody(request, {
    ...options,
    preview: false,
    redactFiles: false,
    redactImages: false
  });
}

export function buildOpenAIResponsesRequestPreview(
  request: ProviderRunRequest,
  options: OpenAIResponsesRequestOptions = {}
): OpenAIResponsesRequestPreview {
  return {
    body: buildOpenAIResponsesBody(request, {
      ...options,
      preview: true,
      redactFiles: true,
      redactImages: true
    }),
    provider: "openai",
    replayedContext: request.previousProviderResponseId ? [] : conversationPreview(request),
    redactions: [
      "attachment_extracted_text",
      "attachment_filename",
      "image_data_url",
      "pdf_base64",
      "provider_continuation_opaque_fields"
    ]
  };
}
