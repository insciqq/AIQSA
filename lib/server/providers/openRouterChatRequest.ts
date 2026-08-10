import {
  defaultOpenRouterParams,
  normalizeOpenRouterParams,
  type OpenRouterParams
} from "../../domain/providerParams";
import {
  invalidRunParamsError,
  validateSearchRunParams
} from "../../domain/runParams";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { openRouterChatToolBridge } from "../tools/bridges";
import {
  providerAttachmentPreviewFilename,
  providerAttachmentPreviewText,
  providerAttachmentText
} from "./attachmentPayload";
import { conversationPreview, providerPromptCacheKey, textConversationForRequest } from "./context";
import type {
  ProviderAttachment,
  ProviderRunRequest,
  ProviderSearchRequest
} from "./types";
import { providerInstructionsWithPersonalContext } from "./personalContext";

export type OpenRouterMessage = {
  content?: null | string | Record<string, unknown>[];
  name?: string;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export type OpenRouterChatRequestBody = Record<string, unknown> & {
  cache_control?: {
    type: "ephemeral";
  };
  max_completion_tokens: number;
  messages: OpenRouterMessage[];
  metadata: Record<string, string>;
  model: string;
  parallel_tool_calls?: boolean;
  plugins?: unknown[];
  provider: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  session_id: string;
  stream: boolean;
  temperature?: number;
  tool_choice?: "auto" | "none";
  tools?: Record<string, unknown>[];
  verbosity?: string;
};

export type OpenRouterChatRequestOptions = Readonly<{
  maxAttachmentTextChars?: number;
  /** @deprecated Use buildOpenRouterChatRequestPreview for complete preview redaction. */
  redactFiles?: boolean;
  /** @deprecated Use buildOpenRouterChatRequestPreview for complete preview redaction. */
  redactImages?: boolean;
}>;

export type OpenRouterChatRequestPreview = {
  body: OpenRouterChatRequestBody;
  provider: "openrouter";
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

export type OpenRouterPerplexitySearchRequestPreview = {
  body: {
    model: string;
    query_characters: number;
    strategy: string;
    stream: false;
  };
  provider: "openrouter";
  redactions: ["search_query"];
  stage: "tool_search";
};

type PrivateBuildOptions = Omit<OpenRouterChatRequestOptions, "redactFiles" | "redactImages"> & {
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

function pdfDataUrl(attachment: ProviderAttachment, redactFiles: boolean): string {
  if (redactFiles) {
    return "[base64 PDF data omitted]";
  }

  if (!attachment.base64Data) {
    throw new Error(`pdf_attachment_data_unavailable:${attachment.id}`);
  }

  return `data:application/pdf;base64,${attachment.base64Data}`;
}

function pdfContent(
  attachment: ProviderAttachment,
  redactFiles: boolean,
  preview: boolean
): Record<string, unknown> {
  return {
    file: {
      file_data: pdfDataUrl(attachment, redactFiles),
      filename: preview ? providerAttachmentPreviewFilename : attachment.fileName
    },
    type: "file"
  };
}

function imageContent(attachment: ProviderAttachment, redactImages: boolean): Record<string, unknown> {
  if (redactImages) {
    return {
      image_url: {
        url: "[image data url omitted]"
      },
      type: "image_url"
    };
  }

  if (!attachment.dataUrl) {
    throw new Error(`image_attachment_data_unavailable:${attachment.id}`);
  }

  return {
    image_url: {
      url: attachment.dataUrl
    },
    type: "image_url"
  };
}

function buildUserContent(
  request: ProviderRunRequest,
  options: PrivateBuildOptions
): string | Record<string, unknown>[] {
  const maxAttachmentTextChars = options.maxAttachmentTextChars;
  const textParts = [textFromContentBlocks(request.content)].filter((part) => part.trim());
  const contentParts: Record<string, unknown>[] = [];
  let hasImage = false;
  let hasNativePdf = false;

  for (const attachment of request.attachments) {
    if (attachment.kind === "pdf" && request.modelCapabilities.nativePdfInput) {
      hasNativePdf = true;
      continue;
    }

    if (attachment.kind === "pdf" || attachment.kind === "document") {
      const text = options.preview
        ? providerAttachmentPreviewText(attachment)
        : providerAttachmentText(attachment, maxAttachmentTextChars);
      if (text) {
        textParts.push(text);
      }
    }

    if (attachment.kind === "image") {
      hasImage = true;
    }
  }

  if (hasImage || hasNativePdf) {
    contentParts.push({
      text: textParts.join("\n\n") || "",
      type: "text"
    });

    for (const attachment of request.attachments) {
      if (attachment.kind === "pdf" && request.modelCapabilities.nativePdfInput) {
        contentParts.push(pdfContent(attachment, options.redactFiles, options.preview));
      }

      if (attachment.kind === "image") {
        contentParts.push(imageContent(attachment, options.redactImages));
      }
    }

    return contentParts;
  }

  return textParts.join("\n\n") || "";
}

function textContentPart(text: string): Record<string, unknown> {
  return {
    text,
    type: "text"
  };
}

function contentParts(content: string | Record<string, unknown>[]): Record<string, unknown>[] {
  if (typeof content === "string") {
    return [textContentPart(content)];
  }

  return [...content];
}

function mergeOpenRouterContent(
  previous: string | Record<string, unknown>[],
  next: string | Record<string, unknown>[]
): string | Record<string, unknown>[] {
  if (typeof previous === "string" && typeof next === "string") {
    return [previous, next].filter((part) => part.trim()).join("\n\n");
  }

  return [...contentParts(previous), ...contentParts(next)];
}

function mergeAdjacentOpenRouterMessages(messages: OpenRouterMessage[]): OpenRouterMessage[] {
  const merged: OpenRouterMessage[] = [];

  for (const message of messages) {
    const previous = merged.at(-1);
    if (
      previous?.role === message.role &&
      message.role !== "tool" &&
      !previous.tool_calls &&
      !message.tool_calls &&
      previous.content !== null &&
      previous.content !== undefined &&
      message.content !== null &&
      message.content !== undefined
    ) {
      previous.content = mergeOpenRouterContent(previous.content, message.content);
      continue;
    }

    merged.push({
      ...message,
      content: Array.isArray(message.content) ? [...message.content] : message.content,
      role: message.role
    });
  }

  return merged;
}

function providerToolPreviewMessages(messages: unknown[] | undefined): OpenRouterMessage[] {
  return (messages ?? []).flatMap((message): OpenRouterMessage[] => {
    if (!isRecord(message)) {
      return [];
    }

    if (message.role === "tool") {
      return [{
        content: "[tool output omitted]",
        role: "tool",
        ...(typeof message.tool_call_id === "string"
          ? { tool_call_id: message.tool_call_id }
          : {})
      }];
    }

    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return [];
    }

    const toolCalls = message.tool_calls.flatMap((toolCall) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
        return [];
      }
      return [{
        function: {
          ...(typeof toolCall.function.name === "string"
            ? { name: toolCall.function.name }
            : {})
        },
        ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
        ...(typeof toolCall.type === "string" ? { type: toolCall.type } : {})
      }];
    });

    return toolCalls.length > 0
      ? [{ content: null, role: "assistant", tool_calls: toolCalls }]
      : [];
  });
}

function buildMessages(request: ProviderRunRequest, options: PrivateBuildOptions): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [];
  const instructions = combineInstructions(request);
  const conversation = textConversationForRequest(request);

  if (instructions) {
    messages.push({
      content: instructions,
      role: "system"
    });
  }

  conversation.forEach((message, index) => {
    const isLatestUser = index === conversation.length - 1 && message.role === "user";
    messages.push({
      content: isLatestUser ? buildUserContent(request, options) : message.content,
      role: message.role
    });
  });

  if (options.preview) {
    messages.push(...providerToolPreviewMessages(request.providerToolMessages));
  } else {
    for (const message of request.providerToolMessages ?? []) {
      if (isRecord(message) && typeof message.role === "string") {
        messages.push(message as OpenRouterMessage);
      }
    }
  }

  return mergeAdjacentOpenRouterMessages(messages);
}

function buildProviderRouting(params: OpenRouterParams): Record<string, unknown> {
  return {
    ...(params.provider.order.length > 0 ? { order: params.provider.order } : {}),
    ...(params.provider.only.length > 0 ? { only: params.provider.only } : {}),
    allow_fallbacks: params.provider.allowFallbacks,
    data_collection: params.provider.dataCollection,
    require_parameters: params.provider.requireParameters,
    sort: params.provider.sort,
    ...(params.provider.zdr ? { zdr: true } : {})
  };
}

function buildReasoning(params: OpenRouterParams): Record<string, unknown> | undefined {
  const reasoning: Record<string, unknown> = {};

  if (params.reasoning.enabled) {
    reasoning.enabled = true;
    if (!params.verbosity && params.reasoning.effort !== "none") {
      reasoning.effort = params.reasoning.effort;
    }
  }

  if (params.reasoning.exclude) {
    reasoning.exclude = true;
  }

  if (params.reasoning.maxTokens > 0) {
    reasoning.max_tokens = params.reasoning.maxTokens;
  }

  return Object.keys(reasoning).length > 0 ? reasoning : undefined;
}

function supportsOpenRouterPromptCacheControl(modelId: string, params: OpenRouterParams): boolean {
  const normalizedModelId = modelId.toLowerCase();
  const providerOrder = params.provider.order.map((provider) => provider.toLowerCase());

  return normalizedModelId.startsWith("anthropic/") || providerOrder.includes("anthropic");
}

function buildOpenRouterBody(input: {
  chatId: string;
  messages: OpenRouterMessage[];
  metadata: Record<string, string>;
  modelId: string;
  nativePdfInput?: boolean;
  parallelToolCalls?: boolean;
  params: OpenRouterParams;
  stream: boolean;
  toolChoice?: "auto" | "none";
  tools?: Record<string, unknown>[];
}): OpenRouterChatRequestBody {
  const body: OpenRouterChatRequestBody = {
    max_completion_tokens: Math.max(16, input.params.maxTokens),
    messages: input.messages,
    metadata: input.metadata,
    model: input.modelId,
    provider: buildProviderRouting(input.params),
    session_id: providerPromptCacheKey(input.chatId),
    stream: input.stream
  };
  const reasoning = buildReasoning(input.params);

  if (supportsOpenRouterPromptCacheControl(input.modelId, input.params)) {
    body.cache_control = {
      type: "ephemeral"
    };
  }

  if (typeof input.params.temperature === "number") {
    body.temperature = input.params.temperature;
  }

  if (reasoning) {
    body.reasoning = reasoning;
  }

  if (input.params.verbosity) {
    body.verbosity = input.params.verbosity;
  }

  if (input.nativePdfInput) {
    body.plugins = [
      {
        id: "file-parser",
        pdf: {
          engine: "native"
        }
      }
    ];
  }

  if (input.tools && input.tools.length > 0) {
    body.tools = input.tools;
    body.tool_choice = input.toolChoice ?? "auto";
    body.parallel_tool_calls = input.parallelToolCalls === true;
  }

  return body;
}

function buildOpenRouterChatBody(
  request: ProviderRunRequest,
  options: PrivateBuildOptions
): OpenRouterChatRequestBody {
  const params = normalizeOpenRouterParams(request.params);
  const serializedTools = (request.tools ?? []).map((tool) => openRouterChatToolBridge.serializeTool(tool).tool);
  const nativePdfInput =
    request.modelCapabilities.nativePdfInput && request.attachments.some((attachment) => attachment.kind === "pdf");

  return buildOpenRouterBody({
    chatId: request.chatId,
    messages: buildMessages(request, {
      maxAttachmentTextChars: options.maxAttachmentTextChars,
      preview: options.preview,
      redactFiles: options.redactFiles,
      redactImages: options.redactImages
    }),
    metadata: {
      app: "aiqsa",
      search_strategy: request.searchStrategy ?? "search-disabled",
      stage: "answer"
    },
    modelId: request.modelId,
    nativePdfInput,
    parallelToolCalls: request.parallelToolCalls,
    params,
    stream: request.forceNonStreaming ? false : params.stream,
    toolChoice: request.toolChoice,
    tools: serializedTools
  });
}

export function buildOpenRouterChatRequest(
  request: ProviderRunRequest,
  options: OpenRouterChatRequestOptions = {}
): OpenRouterChatRequestBody {
  return buildOpenRouterChatBody(request, {
    maxAttachmentTextChars: options.maxAttachmentTextChars,
    preview: false,
    redactFiles: options.redactFiles ?? false,
    redactImages: options.redactImages ?? false
  });
}

export function buildOpenRouterChatRequestPreview(
  request: ProviderRunRequest,
  options: OpenRouterChatRequestOptions = {}
): OpenRouterChatRequestPreview {
  return {
    body: buildOpenRouterChatBody(request, {
      maxAttachmentTextChars: options.maxAttachmentTextChars,
      preview: true,
      redactFiles: true,
      redactImages: true
    }),
    provider: "openrouter",
    replayedContext: conversationPreview(request),
    redactions: [
      "attachment_extracted_text",
      "attachment_filename",
      "image_data_url",
      "pdf_base64",
      "provider_continuation_opaque_fields"
    ]
  };
}

function searchParamsFromRequest(request: ProviderSearchRequest): OpenRouterParams {
  const policy = request.searchPolicy;
  if (
    policy.provider !== "openrouter" ||
    policy.strategyId !== "perplexity-tool-search" ||
    !request.strategyId.trim()
  ) {
    throw new Error("openrouter_search_policy_invalid");
  }

  const requestControls = validateSearchRunParams(
    request.searchControls,
    policy.controls
  );
  if (!requestControls.ok) {
    throw new Error(invalidRunParamsError);
  }

  const defaults = normalizeOpenRouterParams(policy.defaultParams);
  const defaultControls = validateSearchRunParams(
    {
      maxOutputTokens: defaults.maxTokens,
      ...(typeof defaults.temperature === "number"
        ? { temperature: defaults.temperature }
        : {})
    },
    policy.controls
  );
  if (!defaultControls.ok || !isRecord(policy.defaultParams.provider)) {
    throw new Error("openrouter_search_policy_invalid");
  }

  const controls = requestControls.params ?? {};
  return normalizeOpenRouterParams({
    ...policy.defaultParams,
    maxOutputTokens:
      typeof controls.maxOutputTokens === "number"
        ? controls.maxOutputTokens
        : defaults.maxTokens,
    provider: policy.defaultParams.provider,
    reasoning: isRecord(policy.defaultParams.reasoning)
      ? policy.defaultParams.reasoning
      : defaultOpenRouterParams().reasoning,
    stream: false,
    ...(typeof controls.temperature === "number"
      ? { temperature: controls.temperature }
      : {})
  });
}

function buildSearchText(request: ProviderSearchRequest): string {
  return [
    "Search the web for the user's question and return concise findings with citations.",
    `Question:\n${request.query}`
  ].join("\n\n");
}

export function buildOpenRouterPerplexitySearchRequest(
  request: ProviderSearchRequest
): OpenRouterChatRequestBody {
  return buildOpenRouterBody({
    chatId: request.correlationId,
    messages: [
      {
        content:
          "You are AIQSA's Perplexity search tool executor. Use current sources, keep findings concise, and preserve citations.",
        role: "system"
      },
      {
        content: buildSearchText(request),
        role: "user"
      }
    ],
    metadata: {
      app: "aiqsa",
      stage: "tool_search",
      strategy: request.strategyId
    },
    modelId: request.searchPolicy.modelId,
    params: searchParamsFromRequest(request),
    stream: false
  });
}

export function buildOpenRouterPerplexitySearchRequestPreview(
  request: ProviderSearchRequest
): OpenRouterPerplexitySearchRequestPreview {
  return {
    body: {
      model: request.searchPolicy.modelId,
      query_characters: request.query.length,
      strategy: request.strategyId,
      stream: false
    },
    provider: "openrouter",
    redactions: ["search_query"],
    stage: "tool_search"
  };
}
