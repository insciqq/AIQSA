import { textFromContentBlocks, type ModelRunSseEvent, type ModelRunUsage } from "../../domain/modelRunEvents";
import {
  defaultAnthropicMessagesParams,
  maxOutputTokensFromParams,
  type AnthropicEffort,
  type AnthropicMessagesParams
} from "../../domain/providerParams";
import { anthropicMessagesToolBridge } from "../tools/bridges";
import {
  assertBoundedStructuredTextLength,
  BoundedTextAccumulator
} from "./boundedText";
import { conversationPreview, textConversationForRequest } from "./context";
import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  resolveProviderStreamLimits,
  withTimeoutSignal,
  type ProviderStreamLimits
} from "./network";
import {
  providerAttachmentPreviewMediaType,
  providerAttachmentPreviewText,
  providerAttachmentText
} from "./attachmentPayload";
import { parseSseStream } from "./sse";
import {
  addAnthropicMessageUsage,
  addAnthropicWebSearchUsage,
  ANTHROPIC_WEB_SEARCH_REPLAY_MAX_CHARACTERS,
  inspectAnthropicWebSearchContent,
  updateAnthropicMessageUsage,
  updateAnthropicWebSearchUsage,
  type AnthropicMessagesSearchClient,
  type AnthropicWebSearchUsage
} from "./anthropicMessagesSearch";
import {
  attachProviderStreamSafetySnapshot,
  ProviderStreamDeadlineExceededError,
  ProviderStreamTooLargeError,
  providerStreamSafetySnapshot,
  type ProviderStreamSafetySnapshot
} from "./streamSafety";
import type { ProviderAdapter, ProviderAttachment, ProviderRunRequest, ProviderRunResult } from "./types";

export type AnthropicStreamEvent = Record<string, unknown>;

export type AnthropicMessagesClient = {
  stream(
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal; streamLimits?: ProviderStreamLimits }
  ): AsyncGenerator<AnthropicStreamEvent>;
};

export type AnthropicMessagesAdapterOptions = {
  client: AnthropicMessagesClient;
  maxAttachmentTextChars?: number;
  streamLimits?: Partial<ProviderStreamLimits>;
};

type BuildOptions = {
  maxAttachmentTextChars?: number;
  preview: boolean;
  redactFiles: boolean;
  redactImages: boolean;
};

type AnthropicRequestMessage = {
  content: Record<string, unknown>[];
  role: "assistant" | "user";
};

type AnthropicContentBlockAccumulator = {
  block: Record<string, unknown>;
  citationCharacters: number;
  citations: Record<string, unknown>[] | null;
  inputJson: BoundedTextAccumulator;
  signature: BoundedTextAccumulator | null;
  text: BoundedTextAccumulator | null;
  thinking: BoundedTextAccumulator | null;
};

const MAX_ANTHROPIC_CONTENT_BLOCKS = 256;
const MAX_ANTHROPIC_TOOL_CALLS = 16;
const MAX_ANTHROPIC_SEARCH_CITATIONS = 100;
const MAX_ANTHROPIC_PAUSE_CONTINUATIONS = 3;
const MAX_ANTHROPIC_TOOL_ID_LENGTH = 512;
const MAX_ANTHROPIC_TOOL_NAME_LENGTH = 512;
const anthropicContentBlockTypes = new Set([
  "redacted_thinking",
  "server_tool_use",
  "text",
  "thinking",
  "tool_use",
  "web_search_tool_result"
]);
const anthropicContentDeltaTypes = new Set([
  "citations_delta",
  "input_json_delta",
  "signature_delta",
  "text_delta",
  "thinking_delta"
]);

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

function attachmentTextBlock(
  attachment: ProviderAttachment,
  maxChars: number,
  preview: boolean
): Record<string, unknown> | null {
  const text = preview
    ? providerAttachmentPreviewText(attachment)
    : providerAttachmentText(attachment, maxChars);
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

function imageSource(
  attachment: ProviderAttachment,
  redactImages: boolean,
  preview: boolean
): Record<string, unknown> {
  if (redactImages) {
    return {
      data: "[base64 image data omitted]",
      media_type: preview ? providerAttachmentPreviewMediaType : attachment.mimeType,
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
      const block = attachmentTextBlock(
        attachment,
        options.maxAttachmentTextChars ?? 20000,
        options.preview
      );
      if (block) {
        content.push(block);
      }
    }

    if (attachment.kind === "image") {
      content.push({
        source: imageSource(attachment, options.redactImages, options.preview),
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
                preview: options.preview ?? false,
                redactFiles: options.redactFiles ?? false,
                redactImages: options.redactImages ?? false
              })
            : [textContentBlock(message.content)],
        role: message.role
      })),
      ...anthropicProviderToolMessages(request.providerToolMessages)
    ]
  );
  const clientTools = (request.tools ?? []).map((tool) =>
    anthropicMessagesToolBridge.serializeTool(tool).tool);
  const hostedTools = anthropicMessagesToolBridge.serializeHostedTools?.(request) ?? [];
  if (
    hostedTools.length > 0 &&
    (clientTools.length > 0 || (request.providerToolMessages?.length ?? 0) > 0)
  ) {
    throw new Error("anthropic_hosted_search_client_tools_unsupported");
  }
  const tools = [...hostedTools, ...clientTools];
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
  }

  if (clientTools.length > 0) {
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
  return updateAnthropicMessageUsage(previous, usage);
}

function messageIdFromStart(event: AnthropicStreamEvent): string | undefined {
  return stringValue(objectValue(event.message)?.id);
}

function contentBlockIndex(event: AnthropicStreamEvent): number | null {
  return typeof event.index === "number" && Number.isInteger(event.index) && event.index >= 0
    ? event.index
    : null;
}

function appendAnthropicBlockField(
  accumulator: AnthropicContentBlockAccumulator,
  field: "signature" | "text" | "thinking",
  value: string,
  maxOutputChars: number,
  snapshot: ProviderStreamSafetySnapshot | null
): void {
  let target = accumulator[field];
  if (!target) {
    target = new BoundedTextAccumulator({
      initialValue: stringValue(accumulator.block[field]) ?? "",
      maxChars: maxOutputChars,
      retainedTextKind: field === "text" ? "visible_output" : field,
      snapshot
    });
    accumulator[field] = target;
  }
  target.append(value, snapshot);
}

function finalizeAnthropicBlockFields(accumulator: AnthropicContentBlockAccumulator): void {
  for (const field of ["signature", "text", "thinking"] as const) {
    const value = accumulator[field];
    if (value) {
      accumulator.block[field] = value.value();
    }
  }
}

function finalizeAnthropicToolInput(accumulator: AnthropicContentBlockAccumulator): void {
  if (accumulator.inputJson.length === 0) {
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(accumulator.inputJson.value()) as unknown;
  } catch {
    throw new Error("anthropic_tool_input_invalid");
  }

  if (!objectValue(input)) {
    throw new Error("anthropic_tool_input_invalid");
  }
  accumulator.block.input = input;
}

function responsePreview(input: {
  continuationCount?: number;
  finalText: string;
  messageId?: string;
  model?: string;
  stopReason?: string;
  usage: ModelRunUsage;
  webSearchUsage?: AnthropicWebSearchUsage;
}): Record<string, unknown> {
  return {
    ...(typeof input.continuationCount === "number"
      ? { continuationCount: input.continuationCount }
      : {}),
    id: input.messageId,
    model: input.model,
    provider: "anthropic",
    stopReason: input.stopReason,
    text: input.finalText,
    usage: {
      input_tokens: input.usage.inputTokens,
      output_tokens: input.usage.outputTokens,
      reasoning_tokens: input.usage.reasoningTokens
    },
    ...(input.webSearchUsage?.present
      ? { webSearchRequests: input.webSearchUsage.requests }
      : {})
  };
}

function hostedAnthropicSearchBody(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.some((tool) =>
    objectValue(tool)?.type === "web_search_20250305");
}

function anthropicContinuationBody(
  body: Record<string, unknown>,
  assistantContent: Record<string, unknown>[]
): Record<string, unknown> {
  if (!Array.isArray(body.messages)) {
    throw new Error("anthropic_search_continuation_invalid");
  }
  return {
    ...body,
    messages: [
      ...body.messages,
      { content: assistantContent, role: "assistant" }
    ]
  };
}

function remainingAnthropicStreamLimits(
  limits: ProviderStreamLimits,
  startedAt: number,
  consumedBytes: number
): ProviderStreamLimits {
  const durationMs = Date.now() - startedAt;
  const remainingDurationMs = limits.maxDurationMs - durationMs;
  if (remainingDurationMs <= 0) {
    throw new ProviderStreamDeadlineExceededError({
      maxDurationMs: limits.maxDurationMs,
      observedDurationMs: durationMs,
      snapshot: { durationMs, totalStreamBytes: 0 }
    });
  }
  const remainingBytes = limits.maxBytes - consumedBytes;
  if (remainingBytes <= 0) {
    throw new ProviderStreamTooLargeError({
      maxBytes: limits.maxBytes,
      observedBytes: consumedBytes,
      snapshot: { durationMs, totalStreamBytes: consumedBytes }
    });
  }
  return {
    ...limits,
    maxBytes: remainingBytes,
    maxDurationMs: remainingDurationMs,
    maxEventBytes: Math.min(limits.maxEventBytes, remainingBytes)
  };
}

function normalizedArtifactIdentity(event: ModelRunSseEvent): string {
  if (event.type === "artifact") {
    const payload = objectValue(event.data.payload);
    if (event.data.artifactType === "search" && payload) {
      const id = stringValue(payload.id);
      const status = stringValue(payload.status);
      if (id) return `search:${id}:${status ?? "unknown"}`;
      if (payload.outputIndex === Number.MAX_SAFE_INTEGER) return "search:truncated";
    }
    if (event.data.artifactType === "citation" && payload) {
      const url = stringValue(payload.url);
      const rank = typeof payload.index === "number" ? payload.index : "unknown";
      if (url) return `citation:${url}:${rank}`;
    }
  }
  return JSON.stringify(event);
}

function assertAnthropicNonHostedTerminal(
  stopReason: string | undefined,
  toolCallCount: number
): void {
  if (stopReason === undefined) {
    if (toolCallCount === 0) return;
    throw new Error("anthropic_message_terminal_invalid");
  }

  switch (stopReason) {
    case "end_turn":
    case "max_tokens":
    case "stop_sequence":
      if (toolCallCount === 0) return;
      throw new Error("anthropic_message_terminal_invalid");
    case "tool_use":
      if (toolCallCount > 0) return;
      throw new Error("anthropic_message_tool_use");
    case "pause_turn":
      throw new Error("anthropic_pause_turn_unexpected");
    case "model_context_window_exceeded":
    case "refusal":
      throw new Error(`anthropic_message_${stopReason}`);
    default:
      throw new Error("anthropic_message_terminal_invalid");
  }
}

export function createAnthropicMessagesAdapter(options: AnthropicMessagesAdapterOptions): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      return {
        body: buildAnthropicMessagesRequest(request, {
          maxAttachmentTextChars: options.maxAttachmentTextChars,
          preview: true,
          redactFiles: true,
          redactImages: true
        }),
        provider: "anthropic",
        replayedContext: conversationPreview(request),
        redactions: [
          "attachment_extracted_text",
          "attachment_media_type",
          "image_base64",
          "pdf_base64"
        ]
      };
    },
    async *stream(request, runOptions = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const streamLimits = resolveProviderStreamLimits(options.streamLimits);
      let body = buildAnthropicMessagesRequest(request, {
        maxAttachmentTextChars: options.maxAttachmentTextChars,
        preview: false,
        redactFiles: false,
        redactImages: false
      });
      const hostedSearch = hostedAnthropicSearchBody(body);
      const finalText = new BoundedTextAccumulator({
        maxChars: streamLimits.maxOutputChars,
        retainedTextKind: "visible_output"
      });
      const thinkingText = new BoundedTextAccumulator({
        maxChars: streamLimits.maxOutputChars,
        retainedTextKind: "thinking"
      });
      const allAssistantContent: Record<string, unknown>[] = [];
      const emittedSearchArtifacts = new Set<string>();
      let messageId: string | undefined;
      let model: string | undefined;
      let stopReason: string | undefined;
      let continuationCount = 0;
      let usage: ModelRunUsage = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0
      };
      let webSearchUsage: AnthropicWebSearchUsage = {
        present: false,
        requests: 0
      };
      const streamStartedAt = Date.now();
      let streamBytesUsed = 0;

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

      while (true) {
        let messageStarted = false;
        let terminalSeen = false;
        let attemptMessageId: string | undefined;
        let attemptModel: string | undefined;
        let attemptStopReason: string | undefined;
        let attemptUsage: ModelRunUsage = {
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0
        };
        let attemptWebSearchUsage: AnthropicWebSearchUsage = {
          present: false,
          requests: 0
        };
        const contentBlocks = new Map<number, AnthropicContentBlockAccumulator>();
        const openContentBlocks = new Set<number>();
        let toolUseBlockCount = 0;
        let attemptStreamBytes = 0;

        for await (const event of options.client.stream(body, {
          signal: runOptions.signal,
          streamLimits: remainingAnthropicStreamLimits(
            streamLimits,
            streamStartedAt,
            streamBytesUsed
          )
        })) {
          const snapshot = providerStreamSafetySnapshot(event);
          attemptStreamBytes = Math.max(
            attemptStreamBytes,
            snapshot?.totalStreamBytes ?? 0
          );
          const type = eventType(event);

          if (type === "ping") continue;

          if (type === "message_start") {
            if (messageStarted) throw new Error("anthropic_stream_truncated");
            messageStarted = true;
            const message = objectValue(event.message);
            attemptMessageId = messageIdFromStart(event);
            attemptModel = stringValue(message?.model);
            attemptUsage = usageFromAnthropic(message?.usage, attemptUsage);
            if (hostedSearch) {
              attemptWebSearchUsage = updateAnthropicWebSearchUsage(
                attemptWebSearchUsage,
                message?.usage
              );
            }

            yield {
              data: {
                artifactType: "summary",
                payload: {
                  attempt: continuationCount + 1,
                  messageId: attemptMessageId,
                  model: attemptModel,
                  provider: "anthropic",
                  status: "message_start"
                }
              },
              type: "artifact"
            };
            if (objectValue(message?.usage)) {
              yield {
                data: addAnthropicMessageUsage(usage, attemptUsage),
                type: "usage"
              };
            }
            continue;
          }

          if (type === "content_block_start") {
            if (!messageStarted) throw new Error("anthropic_stream_truncated");
            const index = contentBlockIndex(event);
            const contentBlock = objectValue(event.content_block);
            if (index === null || !contentBlock) {
              throw new Error("anthropic_stream_truncated");
            }
            if (contentBlocks.has(index) || contentBlocks.size >= MAX_ANTHROPIC_CONTENT_BLOCKS) {
              throw new Error("anthropic_stream_content_block_limit_exceeded");
            }

            const block = { ...contentBlock };
            if (
              typeof block.type !== "string" ||
              !anthropicContentBlockTypes.has(block.type)
            ) {
              throw new Error("anthropic_stream_content_block_unsupported");
            }
            if (
              (block.type === "server_tool_use" ||
                block.type === "web_search_tool_result") &&
              !hostedSearch
            ) {
              throw new Error("anthropic_server_tool_unexpected");
            }
            if (block.type === "tool_use" && hostedSearch) {
              throw new Error("anthropic_hosted_search_client_tools_unsupported");
            }
            if (block.type === "tool_use" || block.type === "server_tool_use") {
              if (
                typeof block.id !== "string" ||
                !block.id ||
                block.id.length > MAX_ANTHROPIC_TOOL_ID_LENGTH ||
                typeof block.name !== "string" ||
                !block.name ||
                block.name.length > MAX_ANTHROPIC_TOOL_NAME_LENGTH
              ) {
                throw new Error("anthropic_stream_tool_call_invalid");
              }
              toolUseBlockCount += 1;
              if (toolUseBlockCount > MAX_ANTHROPIC_TOOL_CALLS) {
                throw new Error("anthropic_stream_tool_call_limit_exceeded");
              }
              assertBoundedStructuredTextLength({
                maxChars: streamLimits.maxOutputChars,
                retainedTextKind: "tool_arguments",
                snapshot,
                value: block.input
              });
            }
            if (block.type === "web_search_tool_result") {
              assertBoundedStructuredTextLength({
                maxChars: ANTHROPIC_WEB_SEARCH_REPLAY_MAX_CHARACTERS,
                retainedTextKind: "citations",
                snapshot,
                value: block
              });
            }
            if (block.type === "redacted_thinking") {
              assertBoundedStructuredTextLength({
                maxChars: streamLimits.maxOutputChars,
                retainedTextKind: "reasoning",
                snapshot,
                value: block
              });
            }
            let citations: Record<string, unknown>[] | null = null;
            let citationCharacters = 0;
            if (block.citations !== undefined) {
              if (
                block.type !== "text" ||
                !Array.isArray(block.citations) ||
                block.citations.length > MAX_ANTHROPIC_SEARCH_CITATIONS ||
                block.citations.some((citation) => !objectValue(citation))
              ) {
                throw new Error("anthropic_stream_citation_invalid");
              }
              citations = block.citations as Record<string, unknown>[];
              citationCharacters = assertBoundedStructuredTextLength({
                maxChars: ANTHROPIC_WEB_SEARCH_REPLAY_MAX_CHARACTERS,
                retainedTextKind: "citations",
                snapshot,
                value: citations
              });
              block.citations = citations;
            }
            const accumulator: AnthropicContentBlockAccumulator = {
              block,
              citationCharacters,
              citations,
              inputJson: new BoundedTextAccumulator({
                maxChars: streamLimits.maxOutputChars,
                retainedTextKind: "tool_arguments"
              }),
              signature: typeof block.signature === "string"
                ? new BoundedTextAccumulator({
                    initialValue: block.signature,
                    maxChars: streamLimits.maxOutputChars,
                    retainedTextKind: "signature",
                    snapshot
                  })
                : null,
              text: typeof block.text === "string"
                ? new BoundedTextAccumulator({
                    initialValue: block.text,
                    maxChars: streamLimits.maxOutputChars,
                    retainedTextKind: "visible_output",
                    snapshot
                  })
                : null,
              thinking: typeof block.thinking === "string"
                ? new BoundedTextAccumulator({
                    initialValue: block.thinking,
                    maxChars: streamLimits.maxOutputChars,
                    retainedTextKind: "thinking",
                    snapshot
                  })
                : null
            };
            contentBlocks.set(index, accumulator);
            openContentBlocks.add(index);

            if (block.type === "text" && typeof block.text === "string" && block.text) {
              finalText.append(block.text, snapshot);
              yield { data: { delta: block.text }, type: "token" };
            }
            if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
              thinkingText.append(block.thinking, snapshot);
            }
            continue;
          }

          if (type === "content_block_delta") {
            if (!messageStarted) throw new Error("anthropic_stream_truncated");
            const delta = objectValue(event.delta);
            const index = contentBlockIndex(event);
            const accumulator = index === null ? undefined : contentBlocks.get(index);
            const accumulatorOpen = index !== null && openContentBlocks.has(index);
            if (
              !delta ||
              typeof delta.type !== "string" ||
              !anthropicContentDeltaTypes.has(delta.type)
            ) {
              throw new Error("anthropic_stream_content_delta_unsupported");
            }
            if (delta.type === "text_delta" && typeof delta.text !== "string") {
              throw new Error("anthropic_stream_truncated");
            }
            if (delta.type === "thinking_delta" && typeof delta.thinking !== "string") {
              throw new Error("anthropic_stream_truncated");
            }
            if (delta.type === "input_json_delta" && typeof delta.partial_json !== "string") {
              throw new Error("anthropic_stream_truncated");
            }
            if (
              delta.type === "signature_delta" &&
              (typeof delta.signature !== "string" || !accumulator)
            ) {
              throw new Error("anthropic_stream_truncated");
            }
            if (delta.type === "citations_delta" && !objectValue(delta.citation)) {
              throw new Error("anthropic_stream_citation_invalid");
            }
            if (!accumulator || !accumulatorOpen) {
              throw new Error("anthropic_stream_truncated");
            }
            if (delta.type === "text_delta" && accumulator.block.type !== "text") {
              throw new Error("anthropic_stream_truncated");
            }
            if (
              (delta.type === "thinking_delta" || delta.type === "signature_delta") &&
              accumulator.block.type !== "thinking"
            ) {
              throw new Error("anthropic_stream_truncated");
            }

            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              finalText.append(delta.text, snapshot);
              if (accumulator) {
                appendAnthropicBlockField(
                  accumulator,
                  "text",
                  delta.text,
                  streamLimits.maxOutputChars,
                  snapshot
                );
              }
              yield { data: { delta: delta.text }, type: "token" };
            }

            if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
              thinkingText.append(delta.thinking, snapshot);
              if (accumulator) {
                appendAnthropicBlockField(
                  accumulator,
                  "thinking",
                  delta.thinking,
                  streamLimits.maxOutputChars,
                  snapshot
                );
              }
              yield {
                data: {
                  artifactType: "reasoning",
                  payload: { delta: delta.thinking }
                },
                type: "artifact"
              };
            }

            if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
              if (
                !accumulator ||
                (accumulator.block.type !== "tool_use" &&
                  accumulator.block.type !== "server_tool_use")
              ) {
                throw new Error("anthropic_stream_truncated");
              }
              accumulator.inputJson.append(delta.partial_json, snapshot);
            }

            if (delta?.type === "citations_delta") {
              const citation = objectValue(delta.citation);
              if (
                !accumulator ||
                accumulator.block.type !== "text" ||
                !citation ||
                (accumulator.citations?.length ?? 0) >= MAX_ANTHROPIC_SEARCH_CITATIONS
              ) {
                throw new Error("anthropic_stream_citation_invalid");
              }
              accumulator.citationCharacters = assertBoundedStructuredTextLength({
                currentChars: accumulator.citationCharacters,
                maxChars: ANTHROPIC_WEB_SEARCH_REPLAY_MAX_CHARACTERS,
                retainedTextKind: "citations",
                snapshot,
                value: citation
              });
              accumulator.citations ??= [];
              accumulator.citations.push(citation);
              accumulator.block.citations = accumulator.citations;
            }

            if (delta?.type === "signature_delta" && typeof delta.signature === "string" && accumulator) {
              appendAnthropicBlockField(
                accumulator,
                "signature",
                delta.signature,
                streamLimits.maxOutputChars,
                snapshot
              );
            }
            continue;
          }

          if (type === "content_block_stop") {
            if (!messageStarted) throw new Error("anthropic_stream_truncated");
            const index = contentBlockIndex(event);
            if (index === null) throw new Error("anthropic_stream_truncated");
            const accumulator = contentBlocks.get(index);
            if (!accumulator || !openContentBlocks.delete(index)) {
              throw new Error("anthropic_stream_truncated");
            }
            finalizeAnthropicBlockFields(accumulator);
            if (
              accumulator.block.type === "tool_use" ||
              accumulator.block.type === "server_tool_use"
            ) {
              finalizeAnthropicToolInput(accumulator);
            }
            continue;
          }

          if (type === "message_delta") {
            if (!messageStarted || openContentBlocks.size > 0) {
              throw new Error("anthropic_stream_truncated");
            }
            const delta = objectValue(event.delta);
            attemptStopReason = stringValue(delta?.stop_reason) ?? attemptStopReason;
            attemptUsage = usageFromAnthropic(event.usage, attemptUsage);
            if (hostedSearch) {
              attemptWebSearchUsage = updateAnthropicWebSearchUsage(
                attemptWebSearchUsage,
                event.usage
              );
            }
            if (objectValue(event.usage)) {
              yield {
                data: addAnthropicMessageUsage(usage, attemptUsage),
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

          if (type === "error") throw new Error("anthropic_stream_error");
          throw new Error("anthropic_stream_event_unsupported");
        }

        if (!terminalSeen) throw new Error("anthropic_stream_truncated");
        streamBytesUsed += attemptStreamBytes;

        const assistantContent = [...contentBlocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => value.block);
        const providerToolCallMessage = { content: assistantContent, role: "assistant" };
        const toolCalls = anthropicMessagesToolBridge.parseToolCalls(providerToolCallMessage);
        usage = addAnthropicMessageUsage(usage, attemptUsage);
        if (hostedSearch) {
          webSearchUsage = addAnthropicWebSearchUsage(
            webSearchUsage,
            attemptWebSearchUsage
          );
          if (toolCalls.length > 0) {
            throw new Error("anthropic_hosted_search_client_tools_unsupported");
          }
          allAssistantContent.push(...assistantContent);
          const inspection = inspectAnthropicWebSearchContent(allAssistantContent, {
            allowUnmatchedCalls: attemptStopReason === "pause_turn",
            webSearchUsage
          });
          for (const artifact of inspection.artifacts) {
            const identity = normalizedArtifactIdentity(artifact);
            if (!emittedSearchArtifacts.has(identity)) {
              emittedSearchArtifacts.add(identity);
              yield artifact;
            }
          }
          if (inspection.embeddedErrorCode) {
            throw new Error(inspection.embeddedErrorCode);
          }
          if (attemptStopReason === "pause_turn") {
            if (continuationCount >= MAX_ANTHROPIC_PAUSE_CONTINUATIONS) {
              throw new Error("anthropic_search_pause_limit_exceeded");
            }
            body = anthropicContinuationBody(body, assistantContent);
            continuationCount += 1;
            continue;
          }
          if (attemptStopReason !== "end_turn") {
            throw new Error(
              attemptStopReason
                ? `anthropic_message_${attemptStopReason}`
                : "anthropic_search_terminal_invalid"
            );
          }
          if (inspection.operationCount === 0) {
            throw new Error("anthropic_search_operation_missing");
          }
          if (inspection.sources.length === 0) {
            throw new Error("anthropic_search_sources_missing");
          }
        } else {
          assertAnthropicNonHostedTerminal(attemptStopReason, toolCalls.length);
        }

        messageId = attemptMessageId ?? messageId;
        model = attemptModel ?? model;
        stopReason = attemptStopReason;
        const rawFinalText = finalText.value();
        return {
          finalProviderResponsePreview: responsePreview({
            ...(hostedSearch ? { continuationCount, webSearchUsage } : {}),
            finalText: rawFinalText,
            messageId,
            model,
            stopReason,
            usage
          }),
          finalText: rawFinalText,
          ...(!hostedSearch && toolCalls.length > 0 ? { providerToolCallMessage } : {}),
          providerResponseId: messageId,
          toolCalls: hostedSearch ? [] : toolCalls,
          usage
        };
      }
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
}): AnthropicMessagesClient & AnthropicMessagesSearchClient {
  const baseUrl = input.baseUrl?.trim() || "https://api.anthropic.com/v1";
  const fetchFn = input.fetchFn ?? fetch;

  return {
    async createMessage(body, options) {
      const timeout = withTimeoutSignal(options?.signal, options?.timeoutMs);
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
        const text = await readBoundedResponseText(response, { signal: timeout.signal });
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) as unknown : null;
        } catch {
          throw new Error("anthropic_response_invalid_json");
        }
        const parsedObject = objectValue(parsed);
        if (!parsedObject) {
          throw new Error("anthropic_response_not_object");
        }
        return parsedObject;
      } finally {
        timeout.clear();
      }
    },
    async *stream(body, options) {
      const streamLimits = resolveProviderStreamLimits(options?.streamLimits);
      const deadline = withTimeoutSignal(options?.signal, streamLimits.maxDurationMs);
      const requestTimeout = withTimeoutSignal(deadline.signal);
      try {
        const response = await fetchFn(`${baseUrl}/messages`, {
          body: JSON.stringify(body),
          headers: {
            "anthropic-version": input.version ?? "2023-06-01",
            "content-type": "application/json",
            "x-api-key": input.apiKey
          },
          method: "POST",
          signal: requestTimeout.signal
        });

        if (!response.ok) {
          return await throwAnthropicHttpError(response, requestTimeout.signal);
        }

        requestTimeout.clear();
        if (!response.body) {
          throw new Error("anthropic_stream_body_missing");
        }

        for await (const event of parseSseStream(response.body, {
          idleTimeoutMs: streamLimits.idleTimeoutMs,
          maxBytes: streamLimits.maxBytes,
          maxDurationMs: streamLimits.maxDurationMs,
          maxEventBytes: streamLimits.maxEventBytes,
          signal: deadline.signal
        })) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data) as unknown;
          } catch {
            throw new Error("anthropic_stream_truncated");
          }
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            const parsedEvent = parsed as AnthropicStreamEvent;
            const snapshot = providerStreamSafetySnapshot(event);
            yield snapshot
              ? attachProviderStreamSafetySnapshot(parsedEvent, snapshot)
              : parsedEvent;
          }
        }
      } finally {
        requestTimeout.clear();
        deadline.clear();
      }
    }
  };
}
