import { geminiInteractionStepForWire } from "./geminiInteractionsProtocol";

/**
 * Provider-neutral conversation history: what the native agent engine sends
 * in `ProviderRunRequest.history` and what an adapter captures from each
 * response in `ProviderRunResult.history`. The engine owns the transcript and
 * decides which items a request carries (`lib/server/engine/transcript.ts`);
 * adapters own the wire formats and only render or capture these items.
 *
 * Provider-native data (reasoning blobs, Gemini thought signatures, Responses
 * item ids, Anthropic thinking blocks) rides on the item that carries it,
 * tagged with its wire format. The engine replays it only to the provider
 * route and model that produced it; a renderer refuses data of another
 * format instead of sending it. Anthropic Messages renders and captures in
 * `anthropicMessagesHistory.ts`.
 */
export type ProviderHistoryFormat = "anthropic_messages" | "chat_completions" | "gemini_interactions" | "openai_responses";

export type ProviderNativeData = Readonly<{
  fields: Readonly<Record<string, unknown>>;
  format: ProviderHistoryFormat;
}>;

export type ProviderHistoryItem =
  /** `currentInput` marks the run's own input: the adapter renders it with
   * the request's attachments and response reminder. */
  | Readonly<{ currentInput?: true; text: string; type: "user" }>
  | Readonly<{ native?: ProviderNativeData; text: string; type: "assistant_text" }>
  | Readonly<{ native: ProviderNativeData; type: "reasoning" }>
  /** `arguments` is the JSON text the model produced. */
  | Readonly<{ arguments: string; callId: string; name: string; native?: ProviderNativeData; type: "tool_call" }>
  | Readonly<{ callId: string; isError?: true; name: string; output: string; type: "tool_result" }>
  | Readonly<{ native: ProviderNativeData; type: "compaction" }>;

export type ProviderHistoryRenderOptions<Content> = Readonly<{
  /** Renders the run's own input with the adapter's attachment rules. */
  currentInput: (text: string) => Content;
  preview: boolean;
}>;

const PREVIEW_TOOL_OUTPUT = "[tool output omitted]";
const PREVIEW_CONTEXT_CHARS = 240;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function native(format: ProviderHistoryFormat, fields: Readonly<Record<string, unknown>>): ProviderNativeData {
  return { fields, format };
}

function nativeFields(data: ProviderNativeData | undefined, format: ProviderHistoryFormat): Readonly<Record<string, unknown>> {
  if (!data) return {};
  if (data.format !== format) throw new Error("provider_history_format_mismatch");
  return data.fields;
}

function argumentsText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function textParts(content: unknown, types: ReadonlySet<string>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => isRecord(part) && typeof part.type === "string" && types.has(part.type) &&
    typeof part.text === "string" ? [part.text] : []).join("");
}

const RESPONSES_TEXT_PARTS = new Set(["output_text"]);
const CHAT_TEXT_PARTS = new Set(["text"]);
const GEMINI_TEXT_PARTS = new Set(["text"]);

/** A request carrying `history` replaces every other conversation source. */
export function assertProviderHistoryRequest(request: Readonly<{
  attachments: readonly unknown[];
  history?: readonly ProviderHistoryItem[];
  previousProviderResponseId?: string;
  providerToolMessages?: readonly unknown[];
}>): readonly ProviderHistoryItem[] {
  const history = request.history;
  if (!history) throw new Error("provider_history_missing");
  if ((request.providerToolMessages?.length ?? 0) > 0 || request.previousProviderResponseId) {
    throw new Error("provider_history_request_invalid");
  }
  if (request.attachments.length > 0 && !history.some((item) => item.type === "user" && item.currentInput)) {
    throw new Error("provider_history_current_input_missing");
  }
  return history;
}

/** Visible turns of the history for request previews, like `conversationPreview`. */
export function providerHistoryPreview(history: readonly ProviderHistoryItem[]) {
  return history.flatMap((item, index) => item.type === "user" || item.type === "assistant_text"
    ? [{
        id: `history-${index}`,
        role: item.type === "user" ? "user" as const : "assistant" as const,
        text: item.text.length > PREVIEW_CONTEXT_CHARS ? `${item.text.slice(0, PREVIEW_CONTEXT_CHARS - 3)}...` : item.text
      }]
    : []);
}

// ---------------------------------------------------------------- Responses

/**
 * A completed Responses output as history, in output order: reasoning items
 * whole, function calls with their item id and status, assistant messages as
 * text (with `phase` when the model set one) and compaction items whole.
 * Hosted tool items (web search) stay out, as they always did between turns:
 * the answer text carries their result.
 */
export function responsesHistoryFromOutput(output: unknown): ProviderHistoryItem[] {
  const items: ProviderHistoryItem[] = [];
  for (const item of Array.isArray(output) ? output : []) {
    if (!isRecord(item)) continue;
    if (item.type === "reasoning") {
      items.push({ native: native("openai_responses", item), type: "reasoning" });
    } else if (item.type === "compaction") {
      items.push({ native: native("openai_responses", item), type: "compaction" });
    } else if (item.type === "function_call") {
      const callId = nonEmptyString(item.call_id) ?? nonEmptyString(item.id);
      const name = nonEmptyString(item.name);
      if (!callId || !name) continue;
      const fields = {
        ...(nonEmptyString(item.id) ? { id: item.id } : {}),
        ...(nonEmptyString(item.status) ? { status: item.status } : {})
      };
      items.push({
        arguments: argumentsText(item.arguments), callId, name,
        ...(Object.keys(fields).length > 0 ? { native: native("openai_responses", fields) } : {}),
        type: "tool_call"
      });
    } else if (item.type === "message" && (item.role === undefined || item.role === "assistant")) {
      const text = textParts(item.content, RESPONSES_TEXT_PARTS);
      if (!text) continue;
      items.push({
        ...(nonEmptyString(item.phase) ? { native: native("openai_responses", { phase: item.phase }) } : {}),
        text,
        type: "assistant_text"
      });
    }
  }
  return items;
}

/** The Responses input item that asks the route to compact everything before
 * it into one opaque `compaction` output item (the native engine's
 * `ProviderRunRequest.compactionTrigger`). */
export const RESPONSES_COMPACTION_TRIGGER = Object.freeze({ type: "compaction_trigger" });

/** Responses `input` items for the history (OpenAI native, compatible Responses, DeepSeek). */
export function responsesInputFromHistory(
  history: readonly ProviderHistoryItem[],
  options: ProviderHistoryRenderOptions<readonly Record<string, unknown>[]>
): Record<string, unknown>[] {
  return history.map((item): Record<string, unknown> => {
    switch (item.type) {
      case "user":
        return {
          content: item.currentInput ? [...options.currentInput(item.text)] : [{ text: item.text, type: "input_text" }],
          role: "user"
        };
      case "assistant_text": {
        const fields = nativeFields(item.native, "openai_responses");
        const content = [{ text: item.text, type: "output_text" }];
        return typeof fields.phase === "string"
          ? { content, phase: fields.phase, role: "assistant", type: "message" }
          : { content, role: "assistant" };
      }
      case "reasoning": {
        const fields = nativeFields(item.native, "openai_responses");
        if (fields.type !== "reasoning") throw new Error("provider_history_item_invalid");
        return options.preview ? { type: "reasoning" } : { ...fields };
      }
      case "tool_call": {
        const fields = nativeFields(item.native, "openai_responses");
        return options.preview
          ? { call_id: item.callId, name: item.name, type: "function_call" }
          : {
              arguments: item.arguments,
              call_id: item.callId,
              ...(typeof fields.id === "string" ? { id: fields.id } : {}),
              name: item.name,
              ...(typeof fields.status === "string" ? { status: fields.status } : {}),
              type: "function_call"
            };
      }
      case "tool_result":
        return {
          call_id: item.callId,
          output: options.preview ? PREVIEW_TOOL_OUTPUT : item.output,
          type: "function_call_output"
        };
      case "compaction": {
        const fields = nativeFields(item.native, "openai_responses");
        if (fields.type !== "compaction") throw new Error("provider_history_item_invalid");
        return options.preview ? { type: "compaction" } : { ...fields };
      }
    }
  });
}

// ---------------------------------------------------------- Chat Completions

/**
 * One Chat Completions assistant message as history: its reasoning
 * (`reasoning_details` and plain `reasoning`, the fields OpenRouter takes
 * back), its text and its tool calls.
 */
export function chatHistoryFromMessage(message: unknown): ProviderHistoryItem[] {
  if (!isRecord(message)) return [];
  const items: ProviderHistoryItem[] = [];
  const reasoning = {
    ...(Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0
      ? { reasoning_details: message.reasoning_details } : {}),
    ...(nonEmptyString(message.reasoning) ? { reasoning: message.reasoning } : {})
  };
  if (Object.keys(reasoning).length > 0) items.push({ native: native("chat_completions", reasoning), type: "reasoning" });
  const text = textParts(message.content, CHAT_TEXT_PARTS);
  if (text) items.push({ text, type: "assistant_text" });
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(toolCall) || !isRecord(toolCall.function)) continue;
    const callId = nonEmptyString(toolCall.id);
    const name = nonEmptyString(toolCall.function.name);
    if (!callId || !name) continue;
    items.push({ arguments: argumentsText(toolCall.function.arguments), callId, name, type: "tool_call" });
  }
  return items;
}

export type ChatHistoryMessage = {
  content: null | string | Record<string, unknown>[];
  name?: string;
  reasoning?: string;
  reasoning_details?: unknown[];
  role: "assistant" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: Record<string, unknown>[];
};

type ChatModelBlock = {
  reasoning: string[];
  reasoningDetails: unknown[];
  text: string[];
  toolCalls: Record<string, unknown>[];
};

function chatBlockMessage(block: ChatModelBlock, preview: boolean): ChatHistoryMessage {
  const reasoning = block.reasoning.join("");
  return {
    content: block.text.length > 0 ? block.text.join("\n\n") : null,
    ...(!preview && reasoning ? { reasoning } : {}),
    ...(!preview && block.reasoningDetails.length > 0 ? { reasoning_details: block.reasoningDetails } : {}),
    role: "assistant",
    ...(block.toolCalls.length > 0 ? { tool_calls: block.toolCalls } : {})
  };
}

/**
 * Chat Completions messages for the history. Consecutive model items (one
 * response) become one assistant message carrying their reasoning, text and
 * tool calls; native compaction has no Chat form.
 */
export function chatMessagesFromHistory(
  history: readonly ProviderHistoryItem[],
  options: ProviderHistoryRenderOptions<string | Record<string, unknown>[]>
): ChatHistoryMessage[] {
  const messages: ChatHistoryMessage[] = [];
  let block: ChatModelBlock | null = null;
  for (const item of history) {
    if (item.type === "assistant_text" || item.type === "reasoning" || item.type === "tool_call") {
      const current: ChatModelBlock = block ?? { reasoning: [], reasoningDetails: [], text: [], toolCalls: [] };
      block = current;
      if (item.type === "assistant_text") {
        nativeFields(item.native, "chat_completions");
        current.text.push(item.text);
      } else if (item.type === "reasoning") {
        const fields = nativeFields(item.native, "chat_completions");
        if (Array.isArray(fields.reasoning_details)) current.reasoningDetails.push(...fields.reasoning_details);
        if (typeof fields.reasoning === "string") current.reasoning.push(fields.reasoning);
      } else {
        nativeFields(item.native, "chat_completions");
        current.toolCalls.push({
          function: options.preview ? { name: item.name } : { arguments: item.arguments, name: item.name },
          id: item.callId,
          type: "function"
        });
      }
      continue;
    }
    if (block) messages.push(chatBlockMessage(block, options.preview));
    block = null;
    if (item.type === "user") {
      messages.push({ content: item.currentInput ? options.currentInput(item.text) : item.text, role: "user" });
    } else if (item.type === "tool_result") {
      messages.push({
        content: options.preview ? PREVIEW_TOOL_OUTPUT : item.output,
        name: item.name,
        role: "tool",
        tool_call_id: item.callId
      });
    } else {
      nativeFields(item.native, "chat_completions");
      throw new Error("provider_history_item_invalid");
    }
  }
  if (block) messages.push(chatBlockMessage(block, options.preview));
  return messages;
}

// ------------------------------------------------------ Gemini Interactions

/**
 * Interaction steps as history, in step order. Thought steps stay whole with
 * their signatures, a function call keeps a signature it carries, and hosted
 * Google Search steps stay out (the answer text carries their result).
 */
export function geminiHistoryFromSteps(steps: readonly Record<string, unknown>[]): ProviderHistoryItem[] {
  const items: ProviderHistoryItem[] = [];
  for (const protectedStep of steps) {
    const step = geminiInteractionStepForWire(protectedStep);
    if (step.type === "thought") {
      items.push({ native: native("gemini_interactions", step), type: "reasoning" });
    } else if (step.type === "function_call") {
      const callId = nonEmptyString(step.id);
      const name = nonEmptyString(step.name);
      if (!callId || !name) continue;
      items.push({
        arguments: argumentsText(step.arguments), callId, name,
        ...(nonEmptyString(step.signature) ? { native: native("gemini_interactions", { signature: step.signature }) } : {}),
        type: "tool_call"
      });
    } else if (step.type === "model_output") {
      const text = textParts(step.content, GEMINI_TEXT_PARTS);
      if (text) items.push({ text, type: "assistant_text" });
    }
  }
  return items;
}

function geminiArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Interaction steps for the history; the adapter validates and previews them.
 * Gemini rejects a function result followed directly by user input (HTTP 400),
 * which a turn that ended after a tool result leaves behind (Stop, a failure,
 * an interrupted run): an empty model output closes that turn, adding no text.
 */
export function geminiStepsFromHistory(
  history: readonly ProviderHistoryItem[],
  options: Pick<ProviderHistoryRenderOptions<Record<string, unknown>[]>, "currentInput">
): Readonly<{ current: boolean; step: Record<string, unknown> }>[] {
  return history.flatMap((item, index) => {
    const step = geminiStep(item, options);
    return item.type === "tool_result" && history[index + 1]?.type === "user"
      ? [step, { current: false, step: { content: [], type: "model_output" } }]
      : [step];
  });
}

function geminiStep(
  item: ProviderHistoryItem,
  options: Pick<ProviderHistoryRenderOptions<Record<string, unknown>[]>, "currentInput">
): Readonly<{ current: boolean; step: Record<string, unknown> }> {
  switch (item.type) {
    case "user":
      return item.currentInput
        ? { current: true, step: { content: options.currentInput(item.text), type: "user_input" } }
        : { current: false, step: { content: [{ text: item.text || "[attachment]", type: "text" }], type: "user_input" } };
    case "assistant_text":
      nativeFields(item.native, "gemini_interactions");
      return { current: false, step: { content: [{ text: item.text, type: "text" }], type: "model_output" } };
    case "reasoning": {
      const fields = nativeFields(item.native, "gemini_interactions");
      if (fields.type !== "thought") throw new Error("provider_history_item_invalid");
      return { current: false, step: { ...fields } };
    }
    case "tool_call": {
      const fields = nativeFields(item.native, "gemini_interactions");
      return {
        current: false,
        step: {
          arguments: geminiArguments(item.arguments),
          id: item.callId,
          name: item.name,
          ...(typeof fields.signature === "string" ? { signature: fields.signature } : {}),
          type: "function_call"
        }
      };
    }
    case "tool_result":
      return {
        current: false,
        step: {
          call_id: item.callId,
          ...(item.isError ? { is_error: true } : {}),
          name: item.name,
          result: [{ text: item.output, type: "text" }],
          type: "function_result"
        }
      };
    case "compaction":
      nativeFields(item.native, "gemini_interactions");
      throw new Error("provider_history_item_invalid");
  }
}
