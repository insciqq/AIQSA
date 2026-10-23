import { describe, expect, it } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { RunTool } from "../tools/types";
import {
  buildAnthropicMessagesRequest,
  createAnthropicMessagesAdapter,
  type AnthropicMessagesClient,
  type AnthropicStreamEvent
} from "./anthropicMessages";
import { anthropicMessagesFromHistory, type AnthropicHistoryRenderOptions } from "./anthropicMessagesHistory";
import type { ProviderHistoryItem } from "./history";
import type { ProviderAttachment, ProviderRunRequest, ProviderRunResult } from "./types";

/**
 * Anthropic Messages history on the native engine: the documented request
 * rules (alternating roles, a `tool_result` for every `tool_use` first in the
 * next user turn, no empty text, thinking replayed whole and unmodified),
 * and recorded response streams carried through the adapter into neutral
 * history and back into the next request. Content is synthetic.
 */

const lookup: RunTool = {
  capability: "mcp",
  description: "Look up one synthetic order.",
  inputSchema: { additionalProperties: false, properties: { order_id: { type: "string" } }, required: ["order_id"], type: "object" },
  name: "lookup_order"
};
const discovered: RunTool = { ...lookup, description: "Cancel one synthetic order.", name: "cancel_order" };

type Message = { content: Record<string, unknown>[]; role: "assistant" | "user" };
type Body = { messages: Message[]; system?: string; tool_choice?: unknown; tools?: Record<string, unknown>[] };

function request(history: readonly ProviderHistoryItem[], overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-anthropic",
    content: { blocks: [{ text: "ignored", type: "text" }] },
    history,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: true, nativeSearch: false, pdf: true, reasoning: true, streaming: true, toolCalling: true,
      vision: true },
    modelId: "claude-haiku-5-5",
    parallelToolCalls: true,
    params: { maxTokens: 4_096, outputConfig: { effort: "low" }, thinking: { budgetTokens: 0, enabled: true, type: "adaptive" } },
    prompt: { developer: null, system: "You are Claude in AIQSA." },
    provider: "anthropic",
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "auto",
    toolMode: "auto",
    tools: [lookup],
    ...overrides
  };
}

const body = (value: ProviderRunRequest) => buildAnthropicMessagesRequest(value) as Body;

type Block =
  | Readonly<{ signature: string; thinking: string; type: "thinking" }>
  | Readonly<{ data: string; type: "redacted_thinking" }>
  | Readonly<{ text: string; type: "text" }>
  | Readonly<{ id: string; input: Record<string, unknown>; name: string; type: "tool_use" }>;

/** A recorded Messages stream of one response: each block opened, filled by deltas and closed. */
function recorded(blocks: readonly Block[], stopReason: "end_turn" | "tool_use"): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [{ message: { id: "msg_1", model: "claude-haiku-5-5",
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 120, output_tokens: 1 } }, type: "message_start" }];
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      events.push({ content_block: { signature: "", thinking: "", type: "thinking" }, index, type: "content_block_start" },
        { delta: { thinking: block.thinking, type: "thinking_delta" }, index, type: "content_block_delta" },
        { delta: { signature: block.signature, type: "signature_delta" }, index, type: "content_block_delta" });
    } else if (block.type === "redacted_thinking") {
      events.push({ content_block: block, index, type: "content_block_start" });
    } else if (block.type === "text") {
      events.push({ content_block: { text: "", type: "text" }, index, type: "content_block_start" },
        { delta: { text: block.text, type: "text_delta" }, index, type: "content_block_delta" });
    } else {
      events.push({ content_block: { id: block.id, input: {}, name: block.name, type: "tool_use" }, index, type: "content_block_start" },
        { delta: { partial_json: JSON.stringify(block.input), type: "input_json_delta" }, index, type: "content_block_delta" });
    }
    events.push({ index, type: "content_block_stop" });
  });
  events.push({ delta: { stop_reason: stopReason }, type: "message_delta", usage: { output_tokens: 40 } }, { type: "message_stop" });
  return events;
}

/** One request through the adapter: the body it sent and its result. */
async function respond(value: ProviderRunRequest, blocks: readonly Block[], stopReason: "end_turn" | "tool_use") {
  const sent: Record<string, unknown>[] = [];
  const client: AnthropicMessagesClient = {
    async *stream(requestBody) {
      sent.push(JSON.parse(JSON.stringify(requestBody)) as Record<string, unknown>);
      for (const event of recorded(blocks, stopReason)) yield event;
    }
  };
  const stream = createAnthropicMessagesAdapter({ client }).stream(value);
  const events: ModelRunSseEvent[] = [];
  let next = await stream.next();
  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }
  const result: ProviderRunResult = next.value;
  return { body: sent[0] as Body, events, result };
}

const thinking = (thought: string, signature: string): Block => ({ signature, thinking: thought, type: "thinking" });
const call = (id: string, orderId: string): Block => ({ id, input: { order_id: orderId }, name: "lookup_order", type: "tool_use" });
const result = (callId: string, output: string): ProviderHistoryItem => ({ callId, name: "lookup_order", output, type: "tool_result" });
const input = (text: string): ProviderHistoryItem => ({ currentInput: true, text, type: "user" });

function thinkingIn(value: Body): Record<string, unknown>[] {
  return value.messages.flatMap((message) => message.content.filter((block) =>
    block.type === "thinking" || block.type === "redacted_thinking"));
}

function render(history: readonly ProviderHistoryItem[], options: Partial<AnthropicHistoryRenderOptions> = {}) {
  return anthropicMessagesFromHistory(history, { currentInput: (text) => [{ text, type: "text" }], preview: false, thinkingPrefix: null,
    toolsDeclared: true, ...options });
}

describe("Anthropic Messages history rendering", () => {
  it("alternates roles by merging consecutive items of one role and sends no empty text", () => {
    const messages = render([
      { text: "Earlier question", type: "user" },
      { text: "Earlier answer", type: "assistant_text" },
      { text: "", type: "user" },
      { text: "And the price?", type: "user" },
      { text: "  \n", type: "assistant_text" },
      { text: "It costs 3.", type: "assistant_text" },
      input("Thanks")
    ]);
    expect(messages).toEqual([
      { content: [{ text: "Earlier question", type: "text" }], role: "user" },
      { content: [{ text: "Earlier answer", type: "text" }], role: "assistant" },
      { content: [{ text: "[attachment]", type: "text" }, { text: "And the price?", type: "text" }], role: "user" },
      { content: [{ text: "It costs 3.", type: "text" }], role: "assistant" },
      { content: [{ text: "Thanks", type: "text" }], role: "user" }
    ]);
    for (const [index, message] of messages.entries()) {
      if (index > 0) expect(message.role).not.toBe(messages[index - 1]!.role);
      for (const block of message.content) if (block.type === "text") expect(String(block.text).trim()).not.toBe("");
    }
  });

  it("answers every tool_use in the next user turn, results first, errors flagged and empty output left out", () => {
    const messages = render([
      input("Look up A-17 and B-2"),
      { text: "Checking both.", type: "assistant_text" },
      { arguments: "{\"order_id\":\"A-17\"}", callId: "toolu_1", name: "lookup_order", type: "tool_call" },
      { arguments: "{\"order_id\":\"B-2\"}", callId: "toolu_2", name: "lookup_order", type: "tool_call" },
      result("toolu_1", "A-17: shipped"),
      { callId: "toolu_2", isError: true, name: "lookup_order", output: "", type: "tool_result" },
      { text: "Only A-17 matters", type: "user" }
    ]);
    expect(messages).toEqual([
      { content: [{ text: "Look up A-17 and B-2", type: "text" }], role: "user" },
      { content: [{ text: "Checking both.", type: "text" },
        { id: "toolu_1", input: { order_id: "A-17" }, name: "lookup_order", type: "tool_use" },
        { id: "toolu_2", input: { order_id: "B-2" }, name: "lookup_order", type: "tool_use" }], role: "assistant" },
      { content: [{ content: "A-17: shipped", tool_use_id: "toolu_1", type: "tool_result" },
        { is_error: true, tool_use_id: "toolu_2", type: "tool_result" },
        { text: "Only A-17 matters", type: "text" }], role: "user" }
    ]);
  });

  it("continues a turn that ended after a tool result with the next input after the results, adding no text", () => {
    const sent = body(request([
      { text: "Run ls", type: "user" },
      { arguments: "{\"command\":\"ls\"}", callId: "toolu_1", name: "lookup_order", type: "tool_call" },
      result("toolu_1", "a.txt"),
      input("Which file?")
    ]));
    expect(sent.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(sent.messages[2]!.content).toEqual([{ content: "a.txt", tool_use_id: "toolu_1", type: "tool_result" },
      { text: "Which file?", type: "text" }]);
  });

  it("refuses a history whose calls and results do not pair, before anything is sent", () => {
    const toolCall = (callId: string): ProviderHistoryItem =>
      ({ arguments: "{}", callId, name: "lookup_order", type: "tool_call" });
    for (const history of [
      [input("Hi"), toolCall("toolu_1")],
      [input("Hi"), result("toolu_1", "orphan")],
      [input("Hi"), toolCall("toolu_1"), result("toolu_2", "other call")],
      [input("Hi"), toolCall("toolu_1"), toolCall("toolu_2"), result("toolu_1", "only one")],
      [input("Hi"), toolCall("toolu_1"), { text: "text first", type: "user" }, result("toolu_1", "late")]
    ] as ProviderHistoryItem[][]) {
      expect(() => render(history)).toThrow("provider_history_item_invalid");
    }
  });

  it("carries earlier calls and results as text when the request declares no tools", () => {
    const sent = body(request([
      { text: "Look up A-17", type: "user" },
      { arguments: "{\"order_id\":\"A-17\"}", callId: "toolu_1", name: "lookup_order", type: "tool_call" },
      result("toolu_1", "A-17: shipped"),
      { text: "It shipped.", type: "assistant_text" },
      input("Thanks")
    ], { toolChoice: "none", toolMode: "none", tools: [] }));
    expect(sent.tools).toBeUndefined();
    expect(JSON.stringify(sent.messages)).not.toMatch(/tool_use|tool_result/u);
    expect(sent.messages[1]).toEqual({ content: [{ text: "[Tool call lookup_order]\n{\"order_id\":\"A-17\"}", type: "text" }],
      role: "assistant" });
    expect(sent.messages[2]!.content[0]).toEqual({ text: "[Tool result lookup_order]\nA-17: shipped", type: "text" });
  });

  it("maps another provider's call id into Anthropic's alphabet the same way for the call and its result", () => {
    const sent = body(request([
      input("Look up A-17"),
      { arguments: "{}", callId: "call:42/x", name: "lookup_order", type: "tool_call" },
      result("call:42/x", "shipped")
    ]));
    const id = sent.messages[1]!.content[0]!.id;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(sent.messages[2]!.content[0]).toMatchObject({ tool_use_id: id, type: "tool_result" });
  });

  it("renders the run's own input with its PDF and image, and earlier turns as text only", () => {
    const pdf: ProviderAttachment = { base64Data: "JVBERi0xLjQK", byteSize: 12, extractedText: "PDF text", fileName: "brief.pdf",
      id: "pdf-1", kind: "pdf", metadata: {}, mimeType: "application/pdf", status: "ready" };
    const image: ProviderAttachment = { byteSize: 3, dataUrl: "data:image/png;base64,AAAA", extractedText: null, fileName: "chart.png",
      id: "image-1", kind: "image", metadata: {}, mimeType: "image/png", status: "ready" };
    const value = request([{ text: "Earlier", type: "user" }, { text: "Noted.", type: "assistant_text" }, input("What is in them?")],
      { attachmentIds: [pdf.id, image.id], attachments: [pdf, image], prompt: { developer: null, responseReminder: "Answer briefly.",
        system: "You are Claude in AIQSA." } });
    const sent = body(value);
    expect(sent.messages[0]).toEqual({ content: [{ text: "Earlier", type: "text" }], role: "user" });
    expect(sent.messages[2]!.content).toEqual([
      { source: { data: "JVBERi0xLjQK", media_type: "application/pdf", type: "base64" }, type: "document" },
      { text: "What is in them?", type: "text" },
      { source: { data: "AAAA", media_type: "image/png", type: "base64" }, type: "image" },
      { text: "Answer briefly.", type: "text" }
    ]);
    const preview = createAnthropicMessagesAdapter({ client: { stream: async function* () { /* never called */ } } })
      .buildRequestPreview(value) as { body: Body; replayedContext: unknown };
    expect(JSON.stringify(preview)).not.toMatch(/JVBERi0xLjQK|AAAA|Answer briefly/u);
    expect(preview.replayedContext).toEqual([
      { id: "history-0", role: "user", text: "Earlier" },
      { id: "history-1", role: "assistant", text: "Noted." },
      { id: "history-2", role: "user", text: "What is in them?" }
    ]);
    // An approval continuation has no input of its own and so no attachments to place.
    expect(() => body(request([{ text: "Earlier", type: "user" }], { attachmentIds: [image.id], attachments: [image] })))
      .toThrow("provider_history_current_input_missing");
  });

  it("refuses another format's native data and native compaction", () => {
    expect(() => render([input("Hi"), { native: { fields: { encrypted_content: "BLOB", type: "reasoning" }, format: "openai_responses" },
      type: "reasoning" }, { text: "Hello", type: "assistant_text" }])).toThrow("provider_history_format_mismatch");
    expect(() => render([{ native: { fields: { block: { type: "compaction" } }, format: "anthropic_messages" }, type: "compaction" }]))
      .toThrow("provider_history_item_invalid");
    // A thinking block without its signature cannot be taken back.
    expect(() => render([input("Hi"), { native: { fields: { block: { signature: "", thinking: "x", type: "thinking" } },
      format: "anthropic_messages" }, type: "reasoning" }, { text: "Hello", type: "assistant_text" }]))
      .toThrow("provider_history_item_invalid");
  });
});

describe("Anthropic thinking replay", () => {
  it("carries a recorded thinking, text and tool_use stream into history and back into the next request unmodified", async () => {
    const first = request([input("Look up A-17")]);
    const round1 = await respond(first, [thinking("I should look the order up.", "SIG-1"), { text: "Checking.", type: "text" },
      call("toolu_1", "A-17")], "tool_use");
    expect(round1.result.toolCalls).toEqual([expect.objectContaining({ arguments: { order_id: "A-17" }, id: "toolu_1",
      name: "lookup_order" })]);
    expect(round1.result.history).toEqual([
      { native: { fields: { binding: { prefix: expect.any(String), previous: null },
        block: { signature: "SIG-1", thinking: "I should look the order up.", type: "thinking" } }, format: "anthropic_messages" },
      type: "reasoning" },
      { text: "Checking.", type: "assistant_text" },
      { arguments: "{\"order_id\":\"A-17\"}", callId: "toolu_1", name: "lookup_order", type: "tool_call" }
    ]);
    // The signature is private continuation state: no live event carries it.
    expect(JSON.stringify(round1.events)).not.toContain("SIG-1");

    const second = request([...first.history!, ...round1.result.history!, result("toolu_1", "A-17: shipped")]);
    const round2 = await respond(second, [thinking("It shipped.", "SIG-2"), { text: "A-17 shipped.", type: "text" }], "end_turn");
    expect(round2.body.messages).toEqual([
      { content: [{ text: "Look up A-17", type: "text" }], role: "user" },
      { content: [{ signature: "SIG-1", thinking: "I should look the order up.", type: "thinking" },
        { text: "Checking.", type: "text" }, { id: "toolu_1", input: { order_id: "A-17" }, name: "lookup_order", type: "tool_use" }],
      role: "assistant" },
      { content: [{ content: "A-17: shipped", tool_use_id: "toolu_1", type: "tool_result" }], role: "user" }
    ]);
    expect(round2.body.system).toBe(round1.body.system);
    expect(round2.body.tools).toEqual(round1.body.tools);

    // A follow-up in the same turn replays both blocks, in order, as one unbroken run.
    const third = request([...second.history!, ...round2.result.history!, { text: "And B-2?", type: "user" }]);
    expect(thinkingIn(body(third)).map((block) => block.signature)).toEqual(["SIG-1", "SIG-2"]);
  });

  it("drops thinking produced before the tool set grew, keeping what came after", async () => {
    const first = request([input("Cancel A-17")]);
    const round1 = await respond(first, [thinking("Find a cancel tool.", "SIG-1"), call("toolu_1", "A-17")], "tool_use");
    // Discovery added a tool: the next requests declare it, so the earlier block's prefix no longer holds.
    const grown = { tools: [lookup, discovered] };
    const second = request([...first.history!, ...round1.result.history!, result("toolu_1", "found cancel_order")], grown);
    const round2 = await respond(second, [thinking("Now cancel it.", "SIG-2"), call("toolu_2", "A-17")], "tool_use");
    expect(thinkingIn(round2.body)).toEqual([]);
    expect(round2.body.messages[1]!.content).toEqual([{ id: "toolu_1", input: { order_id: "A-17" }, name: "lookup_order",
      type: "tool_use" }]);
    expect(round2.result.history![0]).toMatchObject({ native: { fields: { binding: { previous: null } } } });

    const third = request([...second.history!, ...round2.result.history!, result("toolu_2", "cancelled")], grown);
    expect(thinkingIn(body(third)).map((block) => block.signature)).toEqual(["SIG-2"]);
    // Manual thinking runs on models that check no prefix and need their thinking whole: every block replays.
    const manual = { params: { maxTokens: 4_096, thinking: { budgetTokens: 1_024, enabled: true, type: "enabled" } } };
    expect(thinkingIn(body({ ...third, ...manual })).map((block) => block.signature)).toEqual(["SIG-1", "SIG-2"]);
  });

  it("drops the reserved round's thinking once its instruction is gone, and keeps the blocks before it", async () => {
    const first = request([input("Check the release page")]);
    const round1 = await respond(first, [thinking("Read the page.", "SIG-1"), call("toolu_1", "page")], "tool_use");
    const asked = request([...first.history!, ...round1.result.history!, result("toolu_1", "v2.0 is out"),
      { text: "Report your verdict now.", type: "user" }]);
    const reserved = await respond(asked, [thinking("Report an update.", "SIG-2"), call("toolu_2", "verdict")], "tool_use");
    expect(thinkingIn(reserved.body).map((block) => block.signature)).toEqual(["SIG-1"]);
    const after = request([...first.history!, ...round1.result.history!, result("toolu_1", "v2.0 is out"),
      ...reserved.result.history!, result("toolu_2", "recorded")]);
    expect(thinkingIn(body(after)).map((block) => block.signature)).toEqual(["SIG-1"]);
  });

  it("drops a kept tail's thinking after a compaction summary replaced what came before it", async () => {
    const first = request([{ text: "Old question", type: "user" }, { text: "Old answer", type: "assistant_text" }, input("Look up A-17")]);
    const round1 = await respond(first, [thinking("Look it up.", "SIG-1"), call("toolu_1", "A-17")], "tool_use");
    const compacted = request([{ text: "Summary of the earlier conversation:\n\nOld question answered.", type: "user" },
      input("Look up A-17"), ...round1.result.history!, result("toolu_1", "A-17: shipped")]);
    const sent = body(compacted);
    expect(thinkingIn(sent)).toEqual([]);
    expect(sent.messages[1]!.content).toEqual([{ id: "toolu_1", input: { order_id: "A-17" }, name: "lookup_order", type: "tool_use" }]);
  });

  it("replays redacted thinking whole and never leaves a gap in the replayed run", async () => {
    const first = request([input("Look up A-17")]);
    const round1 = await respond(first, [{ data: "REDACTED-1", type: "redacted_thinking" }, call("toolu_1", "A-17")], "tool_use");
    const second = request([...first.history!, ...round1.result.history!, result("toolu_1", "A-17: shipped")]);
    expect(thinkingIn(body(second))).toEqual([{ data: "REDACTED-1", type: "redacted_thinking" }]);
    const round2 = await respond(second, [thinking("Done.", "SIG-2"), call("toolu_2", "B-2")], "tool_use");
    // A middle block without a valid record ends the run there: the later one stays, the earlier one goes with it.
    const history = [...second.history!, ...round2.result.history!, result("toolu_2", "B-2: open")];
    const tampered = history.map((item) => item.type === "reasoning" && item.native.fields.block &&
      (item.native.fields.block as Record<string, unknown>).type === "redacted_thinking"
      ? { ...item, native: { ...item.native, fields: { ...item.native.fields, binding: { prefix: "changed", previous: null } } } }
      : item);
    expect(thinkingIn(body(request(history))).map((block) => block.type)).toEqual(["redacted_thinking", "thinking"]);
    expect(thinkingIn(body(request(tampered))).map((block) => block.signature)).toEqual(["SIG-2"]);
    // A block whose record is missing never replays.
    const unrecorded = history.map((item) => item.type === "reasoning"
      ? { ...item, native: { ...item.native, fields: { block: item.native.fields.block } } } : item);
    expect(thinkingIn(body(request(unrecorded)))).toEqual([]);
  });

  it("previews thinking, arguments and tool output only as placeholders", async () => {
    const first = request([input("Look up A-17")]);
    const round1 = await respond(first, [thinking("PRIVATE-THOUGHT", "PRIVATE-SIG"), call("toolu_1", "PRIVATE-ARG")], "tool_use");
    const value = request([...first.history!, ...round1.result.history!, result("toolu_1", "PRIVATE-OUTPUT")]);
    const preview = createAnthropicMessagesAdapter({ client: { stream: async function* () { /* never called */ } } })
      .buildRequestPreview(value) as { body: Body };
    expect(JSON.stringify(preview)).not.toMatch(/PRIVATE-(?:THOUGHT|SIG|ARG|OUTPUT)/u);
    expect(preview.body.messages[1]!.content).toEqual([{ type: "thinking" },
      { id: "toolu_1", name: "lookup_order", type: "tool_use" }]);
    expect(preview.body.messages[2]!.content).toEqual([{ content: "[tool output omitted]", tool_use_id: "toolu_1", type: "tool_result" }]);
  });
});
