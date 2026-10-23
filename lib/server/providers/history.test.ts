import { describe, expect, it } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { RunTool } from "../tools/types";
import { buildCompatibleResponsesRequest } from "./compatibleResponses";
import { buildGeminiInteractionsRequest, buildGeminiInteractionsRequestPreview } from "./geminiInteractionsRequest";
import {
  chatHistoryFromMessage,
  chatMessagesFromHistory,
  geminiHistoryFromSteps,
  responsesHistoryFromOutput,
  responsesInputFromHistory,
  type ProviderHistoryItem
} from "./history";
import { buildOpenAIResponsesRequest, buildOpenAIResponsesRequestPreview } from "./openaiResponsesRequest";
import { buildOpenRouterChatRequest, buildOpenRouterChatRequestPreview } from "./openRouterChatRequest";
import { streamOpenRouterSseResponse } from "./openRouterChatResponse";
import type { ProviderAttachment, ProviderRunRequest, ProviderRunResult } from "./types";

const tool: RunTool = {
  capability: "mcp",
  description: "Look up one synthetic order.",
  inputSchema: { additionalProperties: false, properties: { order_id: { type: "string" } }, required: ["order_id"], type: "object" },
  name: "lookup_order"
};

const image: ProviderAttachment = {
  byteSize: 3,
  dataUrl: "data:image/png;base64,AAAA",
  extractedText: null,
  fileName: "chart.png",
  id: "attachment-1",
  kind: "image",
  metadata: {},
  mimeType: "image/png",
  status: "ready"
};

function request(history: readonly ProviderHistoryItem[], overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-history",
    content: { blocks: [{ text: "ignored", type: "text" }] },
    history,
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, streaming: true, toolCalling: true, vision: true },
    modelId: "gpt-6-astra",
    params: { background: false, maxOutputTokens: 128, reasoning: { effort: "low" }, store: false, stream: true },
    prompt: { developer: null, system: null },
    provider: "openai_compatible",
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "auto",
    toolMode: "auto",
    tools: [tool],
    ...overrides
  };
}

const responsesTurn: ProviderHistoryItem[] = [
  { text: "Look up A-17", type: "user" },
  { native: { fields: { encrypted_content: "PRIVATE-BLOB", id: "rs_1", summary: [], type: "reasoning" }, format: "openai_responses" },
    type: "reasoning" },
  { arguments: "{\"order_id\":\"A-17\"}", callId: "call_1", name: "lookup_order",
    native: { fields: { id: "fc_1", status: "completed" }, format: "openai_responses" }, type: "tool_call" },
  { callId: "call_1", name: "lookup_order", output: "PRIVATE-OUTPUT", type: "tool_result" },
  { currentInput: true, text: "Which first?", type: "user" }
];

describe("provider history capture", () => {
  it("captures a Responses output in order and leaves hosted tool items out", () => {
    expect(responsesHistoryFromOutput([
      { action: { type: "search" }, id: "ws_1", status: "completed", type: "web_search_call" },
      { encrypted_content: "BLOB", id: "rs_1", summary: [{ text: "Plan", type: "summary_text" }], type: "reasoning" },
      { content: [{ text: "Checking. ", type: "output_text" }, { refusal: "no", type: "refusal" }], id: "msg_1",
        phase: "commentary", role: "assistant", status: "completed", type: "message" },
      { arguments: "{}", call_id: "call_1", id: "fc_1", name: "lookup_order", status: "completed", type: "function_call" },
      { arguments: "{}", call_id: "", name: "lookup_order", type: "function_call" },
      { content: [{ text: "Done.", type: "output_text" }], role: "assistant", type: "message" }
    ])).toEqual([
      { native: { fields: { encrypted_content: "BLOB", id: "rs_1", summary: [{ text: "Plan", type: "summary_text" }], type: "reasoning" },
        format: "openai_responses" }, type: "reasoning" },
      { native: { fields: { phase: "commentary" }, format: "openai_responses" }, text: "Checking. ", type: "assistant_text" },
      { arguments: "{}", callId: "call_1", name: "lookup_order",
        native: { fields: { id: "fc_1", status: "completed" }, format: "openai_responses" }, type: "tool_call" },
      { text: "Done.", type: "assistant_text" }
    ]);
  });

  it("captures a Chat message's reasoning, text and calls", () => {
    expect(chatHistoryFromMessage({
      content: [{ text: "Part one. ", type: "text" }, { text: "Part two.", type: "text" }],
      reasoning: "Thinking.",
      reasoning_details: [{ data: "BLOB", type: "reasoning.encrypted" }],
      role: "assistant",
      tool_calls: [
        { function: { arguments: "{\"order_id\":\"A-17\"}", name: "lookup_order" }, id: "tool_1", type: "function" },
        { function: { arguments: "{}" }, id: "tool_2", type: "function" }
      ]
    })).toEqual([
      { native: { fields: { reasoning: "Thinking.", reasoning_details: [{ data: "BLOB", type: "reasoning.encrypted" }] },
        format: "chat_completions" }, type: "reasoning" },
      { text: "Part one. Part two.", type: "assistant_text" },
      { arguments: "{\"order_id\":\"A-17\"}", callId: "tool_1", name: "lookup_order", type: "tool_call" }
    ]);
    expect(chatHistoryFromMessage({ content: null, role: "assistant" })).toEqual([]);
  });

  it("captures streamed OpenRouter reasoning details as one blob of the response", async () => {
    const encoder = new TextEncoder();
    const frames = [
      { choices: [{ delta: { reasoning_details: [{ format: "google-gemini-v1", index: 0, text: "Think ", type: "reasoning.text" }] } }] },
      { choices: [{ delta: { reasoning_details: [{ format: "google-gemini-v1", index: 0, text: "more", type: "reasoning.text" }] } }] },
      { choices: [{ delta: { reasoning_details: [{ data: "SIGNED", format: "google-gemini-v1", id: "tool_1", index: 0,
        type: "reasoning.encrypted" }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: "{}", name: "lookup_order" }, id: "tool_1", index: 0, type: "function" }] },
        finish_reason: "tool_calls" }], id: "gen-1", usage: { completion_tokens: 9, prompt_tokens: 30, total_tokens: 39 } }
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const stream = streamOpenRouterSseResponse(new Response(body), { modelId: "google/gemini-3.8-flash" });
    let next = await stream.next();
    const events: ModelRunSseEvent[] = [];
    while (!next.done) {
      events.push(next.value);
      next = await stream.next();
    }
    const result: ProviderRunResult = next.value;
    expect(result.history).toEqual([
      { native: { fields: { reasoning_details: [
        { format: "google-gemini-v1", index: 0, text: "Think more", type: "reasoning.text" },
        { data: "SIGNED", format: "google-gemini-v1", id: "tool_1", index: 0, type: "reasoning.encrypted" }
      ] }, format: "chat_completions" }, type: "reasoning" },
      { arguments: "{}", callId: "tool_1", name: "lookup_order", type: "tool_call" }
    ]);
    expect(events.length).toBeGreaterThan(0);
  });

  it("captures Gemini steps with signatures in place and leaves hosted Search out", () => {
    expect(geminiHistoryFromSteps([
      { signature: "SIG-1", type: "thought" },
      { arguments: { queries: ["q"] }, id: "search_1", signature: "SIG-S", type: "google_search_call" },
      { call_id: "search_1", signature: "SIG-R", type: "google_search_result" },
      { content: [{ text: "Let me check.", type: "text" }], type: "model_output" },
      { arguments: { order_id: "A-17" }, id: "call_1", name: "lookup_order", signature: "SIG-2", type: "function_call" },
      { arguments: {}, id: "call_2", name: "lookup_order", type: "function_call" }
    ])).toEqual([
      { native: { fields: { signature: "SIG-1", type: "thought" }, format: "gemini_interactions" }, type: "reasoning" },
      { text: "Let me check.", type: "assistant_text" },
      { arguments: "{\"order_id\":\"A-17\"}", callId: "call_1", name: "lookup_order",
        native: { fields: { signature: "SIG-2" }, format: "gemini_interactions" }, type: "tool_call" },
      { arguments: "{}", callId: "call_2", name: "lookup_order", type: "tool_call" }
    ]);
  });
});

describe("provider history rendering", () => {
  it("renders the current input with this run's attachments only", () => {
    const history: ProviderHistoryItem[] = [{ text: "Earlier", type: "user" }, { currentInput: true, text: "What is on it?", type: "user" }];
    const responses = buildOpenAIResponsesRequest(request(history, { attachmentIds: [image.id], attachments: [image], provider: "openai" }));
    expect(responses.input).toEqual([
      { content: [{ text: "Earlier", type: "input_text" }], role: "user" },
      { content: [
        { text: "What is on it?", type: "input_text" },
        { detail: "auto", image_url: image.dataUrl, type: "input_image" }
      ], role: "user" }
    ]);
    const chat = buildOpenRouterChatRequest(request(history, { attachmentIds: [image.id], attachments: [image],
      modelId: "google/gemini-3.8-flash", params: { maxTokens: 128, stream: true }, provider: "openrouter" }));
    expect(chat.messages.at(-1)).toMatchObject({ content: expect.arrayContaining([{ image_url: { url: image.dataUrl }, type: "image_url" }]),
      role: "user" });
    const gemini = buildGeminiInteractionsRequest(request(history, { attachmentIds: [image.id], attachments: [image],
      modelId: "gemini-3.5-flash-lite", params: { maxOutputTokens: 128, stream: true }, provider: "gemini" }));
    expect(gemini.input.at(-1)).toMatchObject({ content: expect.arrayContaining([{ data: "AAAA", mime_type: "image/png", type: "image" }]),
      type: "user_input" });
  });

  it("closes a Gemini turn that ended after a tool result before the next user input, adding no text", () => {
    const gemini = buildGeminiInteractionsRequest(request([
      { text: "Run ls", type: "user" },
      { arguments: "{\"command\":\"ls\"}", callId: "call_1", name: "shell", type: "tool_call" },
      { callId: "call_1", name: "shell", output: "a.txt", type: "tool_result" },
      { currentInput: true, text: "Which file?", type: "user" }
    ], { modelId: "gemini-3.5-flash-lite", params: { maxOutputTokens: 128, stream: true }, provider: "gemini" }));
    expect(gemini.input.map((step) => step.type)).toEqual(["user_input", "function_call", "function_result", "model_output", "user_input"]);
    expect(gemini.input[3]).toEqual({ content: [], type: "model_output" });
    const answered = buildGeminiInteractionsRequest(request([
      { text: "Run ls", type: "user" },
      { arguments: "{}", callId: "call_1", name: "shell", type: "tool_call" },
      { callId: "call_1", name: "shell", output: "a.txt", type: "tool_result" },
      { text: "There is a.txt.", type: "assistant_text" },
      { currentInput: true, text: "Which file?", type: "user" }
    ], { modelId: "gemini-3.5-flash-lite", params: { maxOutputTokens: 128, stream: true }, provider: "gemini" }));
    expect(answered.input.map((step) => step.type)).toEqual(["user_input", "function_call", "function_result", "model_output", "user_input"]);
    expect(answered.input[3]).toEqual({ content: [{ text: "There is a.txt.", type: "text" }], type: "model_output" });
  });

  it("redacts reasoning, signatures, arguments and tool output in previews", () => {
    const responses = buildOpenAIResponsesRequestPreview(request(responsesTurn, { provider: "openai" }));
    expect(responses.body.input).toEqual([
      { content: [{ text: "Look up A-17", type: "input_text" }], role: "user" },
      { type: "reasoning" },
      { call_id: "call_1", name: "lookup_order", type: "function_call" },
      { call_id: "call_1", output: "[tool output omitted]", type: "function_call_output" },
      { content: [{ text: "Which first?", type: "input_text" }], role: "user" }
    ]);
    expect(responses.replayedContext).toEqual([
      { id: "history-0", role: "user", text: "Look up A-17" },
      { id: "history-4", role: "user", text: "Which first?" }
    ]);
    const chat = buildOpenRouterChatRequestPreview(request([
      { text: "Look up A-17", type: "user" },
      { native: { fields: { reasoning_details: [{ data: "PRIVATE-BLOB" }] }, format: "chat_completions" }, type: "reasoning" },
      { arguments: "{\"order_id\":\"PRIVATE-ARG\"}", callId: "tool_1", name: "lookup_order", type: "tool_call" },
      { callId: "tool_1", name: "lookup_order", output: "PRIVATE-OUTPUT", type: "tool_result" }
    ], { modelId: "google/gemini-3.8-flash", params: { maxTokens: 128, stream: true }, provider: "openrouter" }));
    const gemini = buildGeminiInteractionsRequestPreview(request([
      { text: "Look up A-17", type: "user" },
      { native: { fields: { signature: "PRIVATE-BLOB", type: "thought" }, format: "gemini_interactions" }, type: "reasoning" },
      { arguments: "{\"order_id\":\"PRIVATE-ARG\"}", callId: "call_1", name: "lookup_order",
        native: { fields: { signature: "PRIVATE-BLOB" }, format: "gemini_interactions" }, type: "tool_call" },
      { callId: "call_1", name: "lookup_order", output: "PRIVATE-OUTPUT", type: "tool_result" }
    ], { modelId: "gemini-3.5-flash-lite", params: { maxOutputTokens: 128, stream: true }, provider: "gemini" }));
    for (const preview of [responses, chat, gemini]) {
      expect(JSON.stringify(preview)).not.toMatch(/PRIVATE-(?:BLOB|ARG|OUTPUT)/u);
    }
  });

  it("ends a native compaction request with the compaction trigger, in the request and its preview", () => {
    const compaction = request(responsesTurn.slice(0, 4), { compactionTrigger: true, toolChoice: "none" });
    for (const body of [buildCompatibleResponsesRequest(compaction), buildOpenAIResponsesRequest({ ...compaction, provider: "openai" }),
      buildOpenAIResponsesRequestPreview({ ...compaction, provider: "openai" }).body]) {
      const input = body.input as Record<string, unknown>[];
      expect(input).toHaveLength(5);
      expect(input.at(-1)).toEqual({ type: "compaction_trigger" });
      expect(body).toMatchObject({ tool_choice: "none" });
    }
    expect((buildCompatibleResponsesRequest(request(responsesTurn)).input as Record<string, unknown>[])
      .some((item) => item.type === "compaction_trigger")).toBe(false);
    const { history: _history, ...withoutHistory } = compaction;
    expect(() => buildOpenAIResponsesRequest({ ...withoutHistory, provider: "openai" })).toThrow("provider_compaction_trigger_invalid");
  });

  it("refuses another format's native data, mixed continuation sources and unplaced attachments", () => {
    const geminiThought: ProviderHistoryItem = {
      native: { fields: { signature: "SIG", type: "thought" }, format: "gemini_interactions" }, type: "reasoning"
    };
    expect(() => buildCompatibleResponsesRequest(request([{ text: "Hi", type: "user" }, geminiThought,
      { text: "Hello", type: "assistant_text" }]))).toThrow("provider_history_format_mismatch");
    expect(() => chatMessagesFromHistory([{ native: { fields: { type: "compaction" }, format: "openai_responses" }, type: "compaction" }],
      { currentInput: (text) => text, preview: false })).toThrow("provider_history_format_mismatch");
    expect(() => buildCompatibleResponsesRequest(request(responsesTurn, { providerToolMessages: [{ type: "reasoning" }] })))
      .toThrow("provider_history_request_invalid");
    expect(() => buildOpenAIResponsesRequest(request(responsesTurn, { previousProviderResponseId: "resp_1", provider: "openai" })))
      .toThrow("provider_history_request_invalid");
    expect(() => buildCompatibleResponsesRequest(request([{ text: "Hi", type: "user" }], { attachmentIds: [image.id], attachments: [image] })))
      .toThrow("provider_history_current_input_missing");
    expect(responsesInputFromHistory([{ native: { fields: { encrypted_content: "C", type: "compaction" }, format: "openai_responses" },
      type: "compaction" }], { currentInput: () => [], preview: false })).toEqual([{ encrypted_content: "C", type: "compaction" }]);
  });
});
