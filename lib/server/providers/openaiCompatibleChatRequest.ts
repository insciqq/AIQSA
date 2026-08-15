import { maxOutputTokensFromParams } from "../../domain/providerParams";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import type { RunTool } from "../tools/types";
import { providerAttachmentPreviewText, providerAttachmentText } from "./attachmentPayload";
import { conversationPreview, textConversationForRequest } from "./context";
import type { ProviderRunRequest } from "./types";
import {
  OPENAI_CHAT_REASONING_REQUEST_MAPPING,
  type ProviderReasoningRequestMapping
} from "../../contracts/providerReasoningRequestMapping";
import { applyProviderReasoningRequestMapping } from "./reasoningRequestMapping";
import { providerInstructionsWithPersonalContext } from "./personalContext";

export type OpenAICompatibleChatMessage = {
  content?: null | string | Record<string, unknown>[];
  name?: string;
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: unknown[];
};

export type OpenAICompatibleChatRequestBody = Record<string, unknown> & {
  max_completion_tokens?: number;
  messages: OpenAICompatibleChatMessage[];
  model: string;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  stream: boolean;
  stream_options?: { include_usage: true };
  temperature?: number;
  tool_choice?: "auto" | "none" | "required";
  tools?: Record<string, unknown>[];
};

export type OpenAICompatibleChatRequestOptions = Readonly<{
  maxAttachmentTextChars?: number;
  reasoningRequestMapping?: ProviderReasoningRequestMapping;
}>;

export type OpenAICompatibleChatRequestPreview = {
  body: OpenAICompatibleChatRequestBody;
  provider: string;
  redactions: [
    "attachment_extracted_text",
    "image_data_url",
    "provider_continuation_opaque_fields"
  ];
  replayedContext: {
    id: string;
    role: "assistant" | "user";
    text: string;
  }[];
};

type PrivateBuildOptions = OpenAICompatibleChatRequestOptions & {
  preview: boolean;
  redactImages: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function combineInstructions(request: ProviderRunRequest): string | undefined {
  return providerInstructionsWithPersonalContext(request);
}

function currentUserContent(
  request: ProviderRunRequest,
  options: PrivateBuildOptions
): string | Record<string, unknown>[] {
  const textParts = [textFromContentBlocks(request.content)].filter((part) => part.trim());
  const images = request.attachments.filter((attachment) => attachment.kind === "image");

  for (const attachment of request.attachments) {
    if (attachment.kind !== "pdf" && attachment.kind !== "document") {
      continue;
    }

    const text = options.preview
      ? providerAttachmentPreviewText(attachment)
      : providerAttachmentText(attachment, options.maxAttachmentTextChars);
    if (text) {
      textParts.push(text);
    }
  }

  if (images.length === 0) {
    return textParts.join("\n\n");
  }

  return [
    {
      text: textParts.join("\n\n"),
      type: "text"
    },
    ...images.map((attachment) => {
      if (!options.redactImages && !attachment.dataUrl) {
        throw new Error(`image_attachment_data_unavailable:${attachment.id}`);
      }

      return {
        image_url: {
          url: options.redactImages ? "[image data url omitted]" : attachment.dataUrl
        },
        type: "image_url"
      };
    })
  ];
}

function providerToolMessages(messages: unknown[] | undefined): OpenAICompatibleChatMessage[] {
  return (messages ?? []).flatMap((message): OpenAICompatibleChatMessage[] => {
    if (!isRecord(message)) {
      return [];
    }

    if (
      message.role !== "assistant" &&
      message.role !== "system" &&
      message.role !== "tool" &&
      message.role !== "user"
    ) {
      return [];
    }

    return [message as OpenAICompatibleChatMessage];
  });
}

function providerToolPreviewMessages(
  messages: unknown[] | undefined
): OpenAICompatibleChatMessage[] {
  return providerToolMessages(messages).flatMap((message): OpenAICompatibleChatMessage[] => {
    if (message.role === "tool") {
      return [{
        content: "[tool output omitted]",
        ...(typeof message.tool_call_id === "string" ? { tool_call_id: message.tool_call_id } : {}),
        role: "tool" as const
      }];
    }

    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
      return [];
    }

    const toolCalls = message.tool_calls.flatMap((toolCall) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) return [];
      return [{
        function: {
          ...(typeof toolCall.function.name === "string" ? { name: toolCall.function.name } : {})
        },
        ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
        type: "function"
      }];
    });
    return toolCalls.length > 0
      ? [{ content: null, role: "assistant" as const, tool_calls: toolCalls }]
      : [];
  });
}

function buildMessages(
  request: ProviderRunRequest,
  options: PrivateBuildOptions
): OpenAICompatibleChatMessage[] {
  const messages: OpenAICompatibleChatMessage[] = [];
  const instructions = combineInstructions(request);
  const conversation = textConversationForRequest(request);

  if (instructions) {
    messages.push({ content: instructions, role: "system" });
  }

  conversation.forEach((message, index) => {
    const isLatestUser = index === conversation.length - 1 && message.role === "user";
    messages.push({
      content: isLatestUser ? currentUserContent(request, options) : message.content,
      role: message.role
    });
  });

  messages.push(...(
    options.preview
      ? providerToolPreviewMessages(request.providerToolMessages)
      : providerToolMessages(request.providerToolMessages)
  ));
  return messages;
}

function serializeTool(tool: RunTool): Record<string, unknown> {
  return {
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.inputSchema,
      ...(tool.strict !== undefined ? { strict: tool.strict } : {})
    },
    type: "function"
  };
}

function buildBody(
  request: ProviderRunRequest,
  options: PrivateBuildOptions
): OpenAICompatibleChatRequestBody {
  const stream = request.forceNonStreaming ? false : request.params.stream === true;
  const body: OpenAICompatibleChatRequestBody = {
    messages: buildMessages(request, options),
    model: request.modelId,
    stream
  };
  const maxCompletionTokens = maxOutputTokensFromParams(request.params);
  const tools = (request.tools ?? []).map(serializeTool);
  const reasoning = isRecord(request.params.reasoning) ? request.params.reasoning : null;

  if (stream && request.modelCapabilities.streamUsage === true) {
    body.stream_options = { include_usage: true };
  }

  if (maxCompletionTokens !== undefined) {
    body.max_completion_tokens = maxCompletionTokens;
  }
  if (typeof request.params.temperature === "number" && Number.isFinite(request.params.temperature)) {
    body.temperature = request.params.temperature;
  }
  if (reasoning && typeof reasoning.effort === "string" && reasoning.effort.trim()) {
    applyProviderReasoningRequestMapping(
      body,
      options.reasoningRequestMapping ?? OPENAI_CHAT_REASONING_REQUEST_MAPPING,
      {
        effort: reasoning.effort,
        mode: typeof reasoning.mode === "string" ? reasoning.mode : undefined
      }
    );
  }
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = request.toolChoice ?? "auto";
    body.parallel_tool_calls = request.parallelToolCalls === true;
  }

  return body;
}

export function buildOpenAICompatibleChatRequest(
  request: ProviderRunRequest,
  options: OpenAICompatibleChatRequestOptions = {}
): OpenAICompatibleChatRequestBody {
  return buildBody(request, {
    ...options,
    preview: false,
    redactImages: false
  });
}

export function buildOpenAICompatibleChatRequestPreview(
  request: ProviderRunRequest,
  options: OpenAICompatibleChatRequestOptions = {}
): OpenAICompatibleChatRequestPreview {
  return {
    body: buildBody(request, { ...options, preview: true, redactImages: true }),
    provider: request.provider,
    redactions: [
      "attachment_extracted_text",
      "image_data_url",
      "provider_continuation_opaque_fields"
    ],
    replayedContext: conversationPreview(request)
  };
}
