import { textFromContentBlocks, type ModelRunSseEvent, type ModelRunUsage } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import {
  defaultAnthropicMessagesParams,
  maxOutputTokensFromParams,
  type AnthropicEffort,
  type AnthropicMessagesParams
} from "../../domain/providerParams";
import { anthropicMessagesToolBridge } from "../tools/bridges";
import { conversationPreview, textConversationForRequest } from "./context";
import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  providerStreamIdleTimeoutMs,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import { providerAttachmentText } from "./attachmentPayload";
import { parseSseStream } from "./sse";
import type { ProviderAdapter, ProviderAttachment, ProviderRunRequest, ProviderRunResult } from "./types";

export type AnthropicStreamEvent = Record<string, unknown>;

export type AnthropicMessagesClient = {
  stream(body: Record<string, unknown>, options?: { signal?: AbortSignal }): AsyncGenerator<AnthropicStreamEvent>;
};

export type AnthropicMessagesAdapterOptions = {
  client: AnthropicMessagesClient;
  maxAttachmentTextChars?: number;
};

type BuildOptions = {
  maxAttachmentTextChars?: number;
  redactFiles: boolean;
  redactImages: boolean;
};

type AnthropicRequestMessage = {
  content: Record<string, unknown>[];
  role: "assistant" | "user";
};

type AnthropicContentBlockAccumulator = {
  block: Record<string, unknown>;
  inputJson: string;
};

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function anthropicEffort(value: unknown, fallback: AnthropicEffort): AnthropicEffort {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeAnthropicMessagesParams(params: Record<string, unknown>): AnthropicMessagesParams {
  const defaults = defaultAnthropicMessagesParams();
  const thinking = objectValue(params.thinking);
  const outputConfig = objectValue(params.outputConfig) ?? objectValue(params.output_config);

  return {
    maxTokens: maxOutputTokensFromParams(params) ?? defaults.maxTokens,
    temperature: typeof params.temperature === "number" ? params.temperature : defaults.temperature,
    thinking: {
      budgetTokens: numberValue(thinking?.budgetTokens) || defaults.thinking.budgetTokens,
      enabled: typeof thinking?.enabled === "boolean" ? thinking.enabled : defaults.thinking.enabled,
      type: thinking?.type === "enabled" || thinking?.type === "adaptive" ? thinking.type : defaults.thinking.type
    },
    outputConfig: {
      effort: anthropicEffort(outputConfig?.effort, defaults.outputConfig.effort)
    }
  };
}

function combineSystem(request: ProviderRunRequest): string | undefined {
  const parts = [
    request.prompt.system,
    request.prompt.developer ? `Developer instructions:\n${request.prompt.developer}` : null
  ].filter((part): part is string => Boolean(part?.trim()));

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function attachmentTextBlock(attachment: ProviderAttachment, maxChars: number): Record<string, unknown> | null {
  const text = providerAttachmentText(attachment, maxChars);
  if (!text) {
    return null;
  }

  return {
    text,
    type: "text"
  };
}

function pdfDocumentData(attachment: ProviderAttachment, redactFiles: boolean): string {
  if (redactFiles) {
    return "[base64 PDF data omitted]";
  }

  if (!attachment.base64Data) {
    throw new Error(`pdf_attachment_data_unavailable:${attachment.id}`);
  }

  return attachment.base64Data;
}

function pdfDocumentBlock(attachment: ProviderAttachment, redactFiles: boolean): Record<string, unknown> {
  return {
    source: {
      data: pdfDocumentData(attachment, redactFiles),
      media_type: "application/pdf",
      type: "base64"
    },
    type: "document"
  };
}

function imageSource(attachment: ProviderAttachment, redactImages: boolean): Record<string, unknown> {
  if (redactImages) {
    return {
      data: "[base64 image data omitted]",
      media_type: attachment.mimeType,
      type: "base64"
    };
  }

  if (!attachment.dataUrl) {
    throw new Error(`image_attachment_data_unavailable:${attachment.id}`);
  }

  const [, data = ""] = attachment.dataUrl.split(",", 2);

  return {
    data,
    media_type: attachment.mimeType,
    type: "base64"
  };
}

function buildUserContent(request: ProviderRunRequest, options: BuildOptions): Record<string, unknown>[] {
  const content: Record<string, unknown>[] = [];
  const text = textFromContentBlocks(request.content);

  for (const attachment of request.attachments) {
    if (attachment.kind === "pdf" && request.modelCapabilities.nativePdfInput) {
      content.push(pdfDocumentBlock(attachment, options.redactFiles));
    }
  }

  if (text.trim()) {
    content.push({
      text,
      type: "text"
    });
  }

  for (const attachment of request.attachments) {
    if (attachment.kind === "pdf" && request.modelCapabilities.nativePdfInput) {
      continue;
    }

    if (attachment.kind === "pdf" || attachment.kind === "document") {
      const block = attachmentTextBlock(attachment, options.maxAttachmentTextChars ?? 20000);
      if (block) {
        content.push(block);
      }
    }

    if (attachment.kind === "image") {
      content.push({
        source: imageSource(attachment, options.redactImages),
        type: "image"
      });
    }
  }

  if (content.length === 0) {
    content.push({
      text: "",
      type: "text"
    });
  }

  return content;
}

function textContentBlock(text: string): Record<string, unknown> {
  return {
    text,
    type: "text"
  };
}

function mergeAdjacentAnthropicMessages(messages: AnthropicRequestMessage[]): AnthropicRequestMessage[] {
  const merged: AnthropicRequestMessage[] = [];

  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role === message.role) {
      previous.content = [...previous.content, ...message.content];
      continue;
    }

    merged.push({
      content: [...message.content],
      role: message.role
    });
  }

  return merged;
}

function anthropicProviderToolMessages(messages: unknown[] | undefined): AnthropicRequestMessage[] {
  return (messages ?? []).flatMap((message): AnthropicRequestMessage[] => {
    const record = objectValue(message);
    if (!record || (record.role !== "assistant" && record.role !== "user")) {
      return [];
    }

    const content = Array.isArray(record.content)
      ? record.content.flatMap((value) => {
          const block = objectValue(value);
          return block ? [block] : [];
        })
      : [];
    if (content.length === 0) {
      return [];
    }

    return [
      {
        content,
        role: record.role
      }
    ];
  });
}

function buildThinking(params: AnthropicMessagesParams): Record<string, unknown> | undefined {
  if (!params.thinking.enabled) {
    return undefined;
  }

  if (params.thinking.type === "adaptive") {
    return {
      type: "adaptive"
    };
  }

  if (params.thinking.budgetTokens <= 0) {
    return undefined;
  }

  if (params.thinking.budgetTokens >= params.maxTokens) {
    throw new Error("anthropic_thinking_budget_must_be_less_than_max_tokens");
  }

  return {
    budget_tokens: params.thinking.budgetTokens,
    display: "summarized",
    type: "enabled"
  };
}

export function buildAnthropicMessagesRequest(
  request: ProviderRunRequest,
  options: Partial<BuildOptions> = {}
): Record<string, unknown> {
  const params = normalizeAnthropicMessagesParams(request.params);
  const conversation = textConversationForRequest(request);
  const messages = mergeAdjacentAnthropicMessages(
    [
      ...conversation.map((message, index) => ({
        content:
          index === conversation.length - 1 && message.role === "user"
            ? buildUserContent(request, {
                maxAttachmentTextChars: options.maxAttachmentTextChars,
                redactFiles: options.redactFiles ?? false,
                redactImages: options.redactImages ?? false
              })
            : [textContentBlock(message.content)],
        role: message.role
      })),
      ...anthropicProviderToolMessages(request.providerToolMessages)
    ]
  );
  const tools = (request.tools ?? []).map((tool) => anthropicMessagesToolBridge.serializeTool(tool).tool);
  const body: Record<string, unknown> = {
    max_tokens: params.maxTokens,
    messages,
    model: request.modelId || "claude-opus-4-8",
    stream: true
  };
  const system = combineSystem(request);
  const thinking = buildThinking(params);
  const hasExplicitTemperature = typeof request.params.temperature === "number";

  if (system) {
    body.system = system;
  }

  if (thinking) {
    body.thinking = thinking;
  } else if (hasExplicitTemperature) {
    body.temperature = params.temperature;
  }

  body.output_config = {
    effort: params.outputConfig.effort
  };

  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = {
      type: request.toolChoice ?? "auto",
      ...(request.toolChoice !== "none" && request.parallelToolCalls !== true
        ? { disable_parallel_tool_use: true }
        : {})
    };
  }

  return body;
}

function eventType(event: AnthropicStreamEvent): string {
  return stringValue(event.type) ?? "";
}

function usageFromAnthropic(usage: unknown, previous: ModelRunUsage): ModelRunUsage {
  const usageRecord = objectValue(usage);

  if (!usageRecord) {
    return previous;
  }

  const tokenValue = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  const uncachedInputTokens =
    tokenValue(usageRecord.input_tokens) ?? tokenValue(usageRecord.uncached_input_tokens);
  const cachedInputTokens =
    tokenValue(usageRecord.cache_read_input_tokens) ?? previous.cachedInputTokens ?? 0;
  const cacheWriteInputTokens =
    tokenValue(usageRecord.cache_creation_input_tokens) ?? previous.cacheWriteInputTokens ?? 0;
  const hasInputUsage =
    uncachedInputTokens !== undefined ||
    tokenValue(usageRecord.cache_read_input_tokens) !== undefined ||
    tokenValue(usageRecord.cache_creation_input_tokens) !== undefined;
  const inputTokens = hasInputUsage
    ? (uncachedInputTokens ?? 0) + cachedInputTokens + cacheWriteInputTokens
    : previous.inputTokens;
  const outputTokens = tokenValue(usageRecord.output_tokens) ?? previous.outputTokens;
  const outputTokenDetails = objectValue(usageRecord.output_tokens_details);
  const reasoningTokens =
    tokenValue(outputTokenDetails?.thinking_tokens) ??
    tokenValue(usageRecord.reasoning_output_tokens) ??
    tokenValue(usageRecord.thinking_output_tokens) ??
    previous.reasoningTokens;
  const totalTokens = tokenValue(usageRecord.total_tokens);

  return normalizeTokenUsage({
    cachedInputTokens,
    cacheWriteInputTokens,
    inputTokens,
    outputTokens,
    reasoningTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {})
  });
}

function messageIdFromStart(event: AnthropicStreamEvent): string | undefined {
  return stringValue(objectValue(event.message)?.id);
}

function contentBlockIndex(event: AnthropicStreamEvent): number | null {
  return typeof event.index === "number" && Number.isInteger(event.index) && event.index >= 0
    ? event.index
    : null;
}

function appendStringField(block: Record<string, unknown>, field: string, value: string): void {
  block[field] = `${stringValue(block[field]) ?? ""}${value}`;
}

function finalizeAnthropicToolInput(accumulator: AnthropicContentBlockAccumulator): void {
  if (!accumulator.inputJson) {
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(accumulator.inputJson) as unknown;
  } catch {
    throw new Error("anthropic_tool_input_invalid");
  }

  if (!objectValue(input)) {
    throw new Error("anthropic_tool_input_invalid");
  }
  accumulator.block.input = input;
}

function responsePreview(input: {
  finalText: string;
  messageId?: string;
  model?: string;
  stopReason?: string;
  usage: ModelRunUsage;
}): Record<string, unknown> {
  return {
    id: input.messageId,
    model: input.model,
    provider: "anthropic",
    stopReason: input.stopReason,
    text: input.finalText,
    usage: {
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
      reasoning_tokens: input.usage.reasoningTokens
    }
  };
}

export function createAnthropicMessagesAdapter(options: AnthropicMessagesAdapterOptions): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      return {
        body: buildAnthropicMessagesRequest(request, {
          maxAttachmentTextChars: options.maxAttachmentTextChars,
          redactFiles: true,
          redactImages: true
        }),
        provider: "anthropic",
        replayedContext: conversationPreview(request),
        redactions: ["image_base64", "pdf_base64"]
      };
    },
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const body = buildAnthropicMessagesRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars,
        redactFiles: false,
        redactImages: false
      });
      let finalText = "";
      let messageId: string | undefined;
      let messageStarted = false;
      let model: string | undefined;
      let stopReason: string | undefined;
      let terminalSeen = false;
      const contentBlocks = new Map<number, AnthropicContentBlockAccumulator>();
      const openContentBlocks = new Set<number>();
      let usage: ModelRunUsage = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0
      };

      yield {
        data: {
          artifactType: "summary",
          payload: {
            provider: "anthropic",
            stream: true
          }
        },
        type: "artifact"
      };

      for await (const event of options.client.stream(body, { signal: runOptions.signal })) {
        const type = eventType(event);

        if (type === "message_start") {
          messageStarted = true;
          const message = objectValue(event.message);
          messageId = messageIdFromStart(event);
          model = stringValue(message?.model);
          usage = usageFromAnthropic(message?.usage, usage);

          yield {
            data: {
              artifactType: "summary",
              payload: {
                messageId,
                model,
                provider: "anthropic",
                status: "message_start"
              }
            },
            type: "artifact"
          };
          if (objectValue(message?.usage)) {
            yield {
              data: usage,
              type: "usage"
            };
          }
          continue;
        }

        if (type === "content_block_start") {
          const index = contentBlockIndex(event);
          const contentBlock = objectValue(event.content_block);
          if (index === null || !contentBlock) {
            throw new Error("anthropic_stream_truncated");
          }

          const block = { ...contentBlock };
          contentBlocks.set(index, {
            block,
            inputJson: ""
          });
          openContentBlocks.add(index);

          if (block.type === "text" && typeof block.text === "string" && block.text) {
            finalText += block.text;
            yield {
              data: {
                delta: block.text
              },
              type: "token"
            };
          }
          continue;
        }

        if (type === "content_block_delta") {
          const delta = objectValue(event.delta);
          const index = contentBlockIndex(event);
          const accumulator = index === null ? undefined : contentBlocks.get(index);

          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            finalText += delta.text;
            if (accumulator) {
              appendStringField(accumulator.block, "text", delta.text);
            }
            yield {
              data: {
                delta: delta.text
              },
              type: "token"
            };
          }

          if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
            if (accumulator) {
              appendStringField(accumulator.block, "thinking", delta.thinking);
            }
            yield {
              data: {
                artifactType: "reasoning",
                payload: {
                  delta: delta.thinking
                }
              },
              type: "artifact"
            };
          }

          if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
            if (!accumulator || accumulator.block.type !== "tool_use") {
              throw new Error("anthropic_stream_truncated");
            }
            accumulator.inputJson += delta.partial_json;
          }

          if (delta?.type === "signature_delta" && typeof delta.signature === "string" && accumulator) {
            appendStringField(accumulator.block, "signature", delta.signature);
          }
          continue;
        }

        if (type === "content_block_stop") {
          const index = contentBlockIndex(event);
          if (index === null) {
            throw new Error("anthropic_stream_truncated");
          }
          const accumulator = contentBlocks.get(index);
          if (!accumulator || !openContentBlocks.delete(index)) {
            throw new Error("anthropic_stream_truncated");
          }
          if (accumulator.block.type === "tool_use") {
            finalizeAnthropicToolInput(accumulator);
          }
          continue;
        }

        if (type === "message_delta") {
          const delta = objectValue(event.delta);
          stopReason = stringValue(delta?.stop_reason) ?? stopReason;
          usage = usageFromAnthropic(event.usage, usage);
          if (objectValue(event.usage)) {
            yield {
              data: usage,
              type: "usage"
            };
          }
          continue;
        }

        if (type === "message_stop") {
          if (!messageStarted || openContentBlocks.size > 0) {
            throw new Error("anthropic_stream_truncated");
          }

          terminalSeen = true;
          break;
        }

        if (type === "error") {
          throw new Error("anthropic_stream_error");
        }
      }

      if (!terminalSeen) {
        throw new Error("anthropic_stream_truncated");
      }

      const assistantContent = [...contentBlocks.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, value]) => value.block);
      const providerToolCallMessage = {
        content: assistantContent,
        role: "assistant"
      };
      const toolCalls = anthropicMessagesToolBridge.parseToolCalls(providerToolCallMessage);

      return {
        finalProviderResponsePreview: responsePreview({
          finalText,
          messageId,
          model,
          stopReason,
          usage
        }),
        finalText,
        ...(toolCalls.length > 0 ? { providerToolCallMessage } : {}),
        providerResponseId: messageId,
        toolCalls,
        usage
      };
    }
  };
}

async function throwAnthropicHttpError(response: Response, signal: AbortSignal): Promise<never> {
  try {
    await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
  }

  throw new Error(providerHttpErrorMessage("Anthropic", response.status));
}

export function createFetchAnthropicMessagesClient(input: {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  version?: string;
}): AnthropicMessagesClient {
  const baseUrl = input.baseUrl?.trim() || "https://api.anthropic.com/v1";
  const fetchFn = input.fetchFn ?? fetch;

  return {
    async *stream(body, options) {
      const timeout = withTimeoutSignal(options?.signal);
      try {
        const response = await fetchFn(`${baseUrl}/messages`, {
          body: JSON.stringify(body),
          headers: {
            "anthropic-version": input.version ?? "2023-06-01",
            "content-type": "application/json",
            "x-api-key": input.apiKey
          },
          method: "POST",
          signal: timeout.signal
        });

        if (!response.ok) {
          return await throwAnthropicHttpError(response, timeout.signal);
        }

        timeout.clear();
        if (!response.body) {
          throw new Error("anthropic_stream_body_missing");
        }

        for await (const event of parseSseStream(response.body, {
          idleTimeoutMs: providerStreamIdleTimeoutMs(),
          signal: options?.signal
        })) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data) as unknown;
          } catch {
            throw new Error("anthropic_stream_truncated");
          }
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            yield parsed as AnthropicStreamEvent;
          }
        }
      } finally {
        timeout.clear();
      }
    }
  };
}
