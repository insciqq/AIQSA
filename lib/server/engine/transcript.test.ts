import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesRequest } from "../providers/anthropicMessages";
import { buildCompatibleResponsesRequest } from "../providers/compatibleResponses";
import { buildDeepSeekResponsesRequest } from "../providers/deepSeekResponsesRequest";
import { buildGeminiInteractionsRequest } from "../providers/geminiInteractionsRequest";
import {
  chatHistoryFromMessage,
  chatMessagesFromHistory,
  geminiHistoryFromSteps,
  responsesHistoryFromOutput,
  type ProviderHistoryItem
} from "../providers/history";
import { buildOpenAICompatibleChatRequest } from "../providers/openaiCompatibleChatRequest";
import { buildOpenAIResponsesRequest } from "../providers/openaiResponsesRequest";
import { buildOpenRouterChatRequest } from "../providers/openRouterChatRequest";
import type { ProviderAttachment, ProviderRunRequest } from "../providers/types";
import type { RunTool } from "../tools/types";
import {
  IMAGE_ANALYZE_NOTE,
  IMAGE_REFERENCE_NOTE,
  IMAGE_VIEW_NOTE,
  modelResponseItems,
  projectTranscript,
  selectTranscript,
  UNRECORDED_TOOL_RESULT,
  type TranscriptItem,
  type TranscriptOrigin,
  type TranscriptTarget
} from "./transcript";

const codex: TranscriptTarget = { model: "gpt-6-astra", provider: "codex-lb" };
const openai: TranscriptTarget = { model: "gpt-6-luna", provider: "openai" };
const openrouter: TranscriptTarget = { model: "google/gemini-3.8-flash", provider: "openrouter" };
const gemini: TranscriptTarget = { model: "gemini-3.5-flash-lite", provider: "gemini" };
const deepseek: TranscriptTarget = { model: "deepseek-flash", provider: "deepseek" };

const lookupOrder: RunTool = {
  capability: "mcp",
  description: "Look up one synthetic order.",
  inputSchema: {
    additionalProperties: false,
    properties: { order_id: { type: "string" } },
    required: ["order_id"],
    type: "object"
  },
  name: "lookup_order"
};

const estimate = (value: unknown) => Math.ceil(String(value).length / 4);

function transcript() {
  let next = 0;
  const items: TranscriptItem[] = [];
  const nextId = () => `i${++next}`;
  return {
    items,
    respond(origin: TranscriptOrigin, history: readonly ProviderHistoryItem[], usage?: { outputTokens: number; reasoningTokens: number }) {
      items.push(...modelResponseItems({ estimate, history, nextId, origin, usage }));
    },
    result(callId: string, output: string, outcome: "complete" | "error" | "unknown" = "complete") {
      items.push({ callId, id: nextId(), kind: "tool_result", name: "lookup_order", outcome, output });
    },
    user(text: string, followup = false) {
      const id = nextId();
      items.push({ ...(followup ? { followup: true as const } : {}), id, kind: "user", text });
      return id;
    }
  };
}

/** Turn 1 on Codex LB with a tool round, turn 2 on Gemini with a tool round, turn 3 pending. */
function mixedTranscript() {
  const chat = transcript();
  chat.user("Look up A-17");
  chat.respond(codex, responsesHistoryFromOutput([
    { encrypted_content: "ENC-CODEX-1", id: "rs_1", summary: [], type: "reasoning" },
    { arguments: "{\"order_id\":\"A-17\"}", call_id: "call_1", id: "fc_1", name: "lookup_order", status: "completed", type: "function_call" }
  ]));
  chat.result("call_1", "{\"status\":\"shipped\"}");
  chat.respond(codex, responsesHistoryFromOutput([
    { encrypted_content: "ENC-CODEX-2", id: "rs_2", summary: [{ text: "Done", type: "summary_text" }], type: "reasoning" },
    { content: [{ annotations: [], text: "A-17 shipped.", type: "output_text" }], id: "msg_2", phase: "final_answer",
      role: "assistant", status: "completed", type: "message" }
  ]));
  chat.user("And B-42?");
  chat.respond(gemini, geminiHistoryFromSteps([
    { signature: "SIG-THOUGHT-1", type: "thought" },
    { arguments: { order_id: "B-42" }, id: "gcall_1", name: "lookup_order", signature: "SIG-CALL-1", type: "function_call" }
  ]));
  chat.result("gcall_1", "{\"status\":\"packing\"}");
  chat.respond(gemini, geminiHistoryFromSteps([
    { signature: "SIG-THOUGHT-2", type: "thought" },
    { content: [{ text: "B-42 is packing.", type: "text" }], type: "model_output" }
  ]));
  const current = chat.user("Which first?");
  return { current, items: chat.items };
}

function request(target: TranscriptTarget, history: readonly ProviderHistoryItem[], overrides: Partial<ProviderRunRequest> = {}): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-spike",
    content: { blocks: [{ text: "Which first?", type: "text" }] },
    history,
    modelCapabilities: {
      nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true,
      reasoningEfforts: ["minimal", "low", "medium", "high"], streaming: true, toolCalling: true, vision: true
    },
    modelId: target.model,
    params: { maxOutputTokens: 256, reasoning: { effort: "low" }, stream: true },
    prompt: { developer: null, system: "Synthetic test." },
    provider: target.provider,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "auto",
    toolMode: "auto",
    tools: [lookupOrder],
    ...overrides
  };
}

const neutralResponsesInput = [
  { content: [{ text: "Look up A-17", type: "input_text" }], role: "user" },
  { arguments: "{\"order_id\":\"A-17\"}", call_id: "call_1", name: "lookup_order", type: "function_call" },
  { call_id: "call_1", output: "{\"status\":\"shipped\"}", type: "function_call_output" },
  { content: [{ text: "A-17 shipped.", type: "output_text" }], role: "assistant" },
  { content: [{ text: "And B-42?", type: "input_text" }], role: "user" },
  { arguments: "{\"order_id\":\"B-42\"}", call_id: "gcall_1", name: "lookup_order", type: "function_call" },
  { call_id: "gcall_1", output: "{\"status\":\"packing\"}", type: "function_call_output" },
  { content: [{ text: "B-42 is packing.", type: "output_text" }], role: "assistant" },
  { content: [{ text: "Which first?", type: "input_text" }], role: "user" }
];

describe("transcript projection", () => {
  it("replays one transcript to Codex LB with its own reasoning and item ids and without Gemini's", () => {
    const { current, items } = mixedTranscript();
    const body = buildCompatibleResponsesRequest(request(codex, projectTranscript(items, codex, { currentInputId: current }), {
      provider: "openai_compatible"
    }));
    expect(body.input).toEqual([
      neutralResponsesInput[0],
      { encrypted_content: "ENC-CODEX-1", id: "rs_1", summary: [], type: "reasoning" },
      { ...neutralResponsesInput[1], id: "fc_1", status: "completed" },
      neutralResponsesInput[2],
      { encrypted_content: "ENC-CODEX-2", id: "rs_2", summary: [{ text: "Done", type: "summary_text" }], type: "reasoning" },
      { content: [{ text: "A-17 shipped.", type: "output_text" }], phase: "final_answer", role: "assistant", type: "message" },
      ...neutralResponsesInput.slice(4)
    ]);
    expect(JSON.stringify(body)).not.toContain("SIG-");
    expect(body).toMatchObject({ store: false, tool_choice: "auto" });
  });

  it("replays the same transcript to Gemini with its thought steps and signatures in place", () => {
    const { current, items } = mixedTranscript();
    const body = buildGeminiInteractionsRequest(request(gemini, projectTranscript(items, gemini, { currentInputId: current })));
    const result = (callId: string, text: string) => ({ call_id: callId, name: "lookup_order", result: [{ text, type: "text" }], type: "function_result" });
    expect(body.input).toEqual([
      { content: [{ text: "Look up A-17", type: "text" }], type: "user_input" },
      { arguments: { order_id: "A-17" }, id: "call_1", name: "lookup_order", type: "function_call" },
      result("call_1", "{\"status\":\"shipped\"}"),
      { content: [{ text: "A-17 shipped.", type: "text" }], type: "model_output" },
      { content: [{ text: "And B-42?", type: "text" }], type: "user_input" },
      { signature: "SIG-THOUGHT-1", type: "thought" },
      { arguments: { order_id: "B-42" }, id: "gcall_1", name: "lookup_order", signature: "SIG-CALL-1", type: "function_call" },
      result("gcall_1", "{\"status\":\"packing\"}"),
      { signature: "SIG-THOUGHT-2", type: "thought" },
      { content: [{ text: "B-42 is packing.", type: "text" }], type: "model_output" },
      { content: [{ text: "Which first?", type: "text" }], type: "user_input" }
    ]);
    expect(JSON.stringify(body)).not.toContain("ENC-CODEX");
  });

  it("replays it neutrally to OpenAI, DeepSeek and OpenRouter, which produced none of it", () => {
    const { current, items } = mixedTranscript();
    const openAIBody = buildOpenAIResponsesRequest(request(openai, projectTranscript(items, openai, { currentInputId: current }), {
      params: { background: false, maxOutputTokens: 256, reasoning: { effort: "low" }, store: false, stream: true },
      provider: "openai"
    }));
    expect(openAIBody.input).toEqual(neutralResponsesInput);
    expect(openAIBody).toMatchObject({ background: false, store: false, stream: true });
    expect(buildDeepSeekResponsesRequest(request(deepseek, projectTranscript(items, deepseek, { currentInputId: current }))).input)
      .toEqual(neutralResponsesInput);

    const chat = buildOpenRouterChatRequest(request(openrouter, projectTranscript(items, openrouter, { currentInputId: current }), {
      params: { maxTokens: 256, reasoning: { effort: "low", enabled: true }, stream: true }, provider: "openrouter"
    }));
    const call = (id: string, orderId: string) => ({ content: null, role: "assistant",
      tool_calls: [{ function: { arguments: `{"order_id":"${orderId}"}`, name: "lookup_order" }, id, type: "function" }] });
    const tool = (id: string, content: string) => ({ content, name: "lookup_order", role: "tool", tool_call_id: id });
    expect(chat.messages).toEqual([
      { content: "Synthetic test.", role: "system" },
      { content: "Look up A-17", role: "user" },
      call("call_1", "A-17"),
      tool("call_1", "{\"status\":\"shipped\"}"),
      { content: "A-17 shipped.", role: "assistant" },
      { content: "And B-42?", role: "user" },
      call("gcall_1", "B-42"),
      tool("gcall_1", "{\"status\":\"packing\"}"),
      { content: "B-42 is packing.", role: "assistant" },
      { content: "Which first?", role: "user" }
    ]);
    expect(JSON.stringify(chat)).not.toMatch(/ENC-CODEX|SIG-/u);
  });

  it("gives OpenRouter back its own reasoning details on the response's one assistant message", () => {
    const chat = transcript();
    chat.user("Look up A-17");
    chat.respond(openrouter, chatHistoryFromMessage({
      content: null,
      reasoning: "Checking.",
      reasoning_details: [{ data: "ENC-OR-1", format: "google-gemini-v1", index: 0, type: "reasoning.encrypted" }],
      role: "assistant",
      tool_calls: [{ function: { arguments: "{\"order_id\":\"A-17\"}", name: "lookup_order" }, id: "tool_1", type: "function" }]
    }));
    chat.result("tool_1", "{\"status\":\"shipped\"}");
    const messages = chatMessagesFromHistory(projectTranscript(chat.items, openrouter), { currentInput: (text) => text, preview: false });
    expect(messages[1]).toEqual({
      content: null,
      reasoning: "Checking.",
      reasoning_details: [{ data: "ENC-OR-1", format: "google-gemini-v1", index: 0, type: "reasoning.encrypted" }],
      role: "assistant",
      tool_calls: [{ function: { arguments: "{\"order_id\":\"A-17\"}", name: "lookup_order" }, id: "tool_1", type: "function" }]
    });
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "tool_1" });
    // A model switch drops the reasoning and keeps the call.
    const switched = chatMessagesFromHistory(projectTranscript(chat.items, { ...openrouter, model: "deepseek/deepseek-v4.1-flash" }),
      { currentInput: (text) => text, preview: false });
    expect(switched[1]).not.toHaveProperty("reasoning_details");
    expect(switched[1]).toMatchObject({ tool_calls: [{ id: "tool_1" }] });
  });

  it("pulls results up to their calls, keeps the latest result of a call, records an unknown outcome for a call without one and drops orphans", () => {
    const chat = transcript();
    chat.user("Look up A-17 and B-42");
    chat.respond(codex, responsesHistoryFromOutput([
      { encrypted_content: "ENC", id: "rs_1", summary: [], type: "reasoning" },
      { arguments: "{}", call_id: "call_a", name: "lookup_order", type: "function_call" },
      { arguments: "{}", call_id: "call_b", name: "lookup_order", type: "function_call" }
    ]));
    chat.result("call_b", "B");
    chat.user("Also C-5", true);
    chat.result("call_a", "Waiting for approval", "error");
    chat.result("call_a", "A");
    chat.result("call_gone", "orphan");
    chat.respond(codex, responsesHistoryFromOutput([
      { arguments: "{}", call_id: "call_c", name: "lookup_order", type: "function_call" }
    ]));

    const projected = projectTranscript(chat.items, codex);
    expect(projected.map((item) => item.type === "tool_call" || item.type === "tool_result"
      ? `${item.type}:${item.callId}${item.type === "tool_result" ? `=${item.output}` : ""}` : item.type)).toEqual([
      "user",
      "reasoning",
      "tool_call:call_a",
      "tool_call:call_b",
      "tool_result:call_a=A",
      "tool_result:call_b=B",
      "user",
      "tool_call:call_c",
      `tool_result:call_c=${UNRECORDED_TOOL_RESULT}`
    ]);
    // Chat Completions keeps every tool message right after its assistant message.
    const messages = chatMessagesFromHistory(projectTranscript(chat.items, openrouter), { currentInput: (text) => text, preview: false });
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "user", "assistant", "tool"]);
  });

  it("leaves out reasoning that no text or call follows", () => {
    const chat = transcript();
    chat.user("Hi");
    chat.respond(codex, responsesHistoryFromOutput([{ encrypted_content: "ENC", id: "rs_1", summary: [], type: "reasoning" }]));
    chat.user("Again");
    expect(projectTranscript(chat.items, codex).map((item) => item.type)).toEqual(["user", "user"]);
  });

  it("starts at the latest compaction the target can use", () => {
    const chat = transcript();
    chat.user("Old question");
    chat.respond(codex, responsesHistoryFromOutput([{ content: [{ text: "Old answer", type: "output_text" }], role: "assistant", type: "message" }]));
    chat.items.push({ id: "c1", kind: "compaction", native: { fields: { encrypted_content: "ENC-COMPACT", id: "cmp_1", type: "compaction" },
      format: "openai_responses" }, origin: codex, summary: "Earlier: one old question." });
    chat.user("New question");
    chat.items.push({ id: "c2", kind: "compaction", native: { fields: { encrypted_content: "ENC-OTHER", type: "compaction" },
      format: "openai_responses" }, origin: openai });

    expect(projectTranscript(chat.items, { ...codex, nativeCompaction: true })).toEqual([
      { native: { fields: { encrypted_content: "ENC-COMPACT", id: "cmp_1", type: "compaction" }, format: "openai_responses" }, type: "compaction" },
      { text: "New question", type: "user" }
    ]);
    expect(projectTranscript(chat.items, gemini)).toEqual([
      { text: "Summary of the earlier conversation:\n\nEarlier: one old question.", type: "user" },
      { text: "New question", type: "user" }
    ]);
    expect(selectTranscript(chat.items, gemini).start).toBe(2);
    // A compaction no target can read leaves the history before it in place.
    const unreadable = chat.items.filter((item) => item.id !== "c1");
    expect(projectTranscript(unreadable, gemini).map((item) => item.type)).toEqual(["user", "assistant_text", "user"]);
  });

  it("replays a compaction's kept tail right after it, then everything appended since", () => {
    const chat = transcript();
    chat.user("Old question");
    chat.respond(codex, responsesHistoryFromOutput([{ content: [{ text: "Old answer", type: "output_text" }], role: "assistant", type: "message" }]));
    const kept = chat.user("Recent question");
    chat.respond(codex, responsesHistoryFromOutput([
      { encrypted_content: "ENC", id: "rs_1", summary: [], type: "reasoning" },
      { arguments: "{}", call_id: "call_1", name: "lookup_order", type: "function_call" }
    ]));
    chat.result("call_1", "R");
    chat.items.push({ id: "c1", keepFromId: kept, kind: "compaction", origin: codex, retained: "Earlier user messages:\n[1] Old question",
      summary: "Earlier: an old question." });
    const newest = chat.user("Newest");

    const summary = { text: "Summary of the earlier conversation:\n\nEarlier: an old question.\n\nEarlier user messages:\n[1] Old question",
      type: "user" };
    const tail = [
      { text: "Recent question", type: "user" },
      { arguments: "{}", callId: "call_1", name: "lookup_order", type: "tool_call" },
      { callId: "call_1", name: "lookup_order", output: "R", type: "tool_result" },
      { text: "Newest", type: "user" }
    ];
    expect(projectTranscript(chat.items, gemini)).toEqual([summary, ...tail]);
    const selection = selectTranscript(chat.items, codex);
    expect(selection.base?.id).toBe("c1");
    expect(selection.start).toBe(6);
    expect(selection.window.map((item) => item.id)).toEqual(["c1", kept, "i4", "i5", "i6", newest]);
    // The same route keeps its reasoning in the tail.
    expect(projectTranscript(chat.items, codex).map((item) => item.type))
      .toEqual(["user", "user", "reasoning", "tool_call", "tool_result", "user"]);

    // A native compaction replays to its own route as the opaque item plus the retained text.
    const native = { fields: { encrypted_content: "ENC-COMPACT", type: "compaction" }, format: "openai_responses" as const };
    chat.items.push({ id: "c2", keepFromId: newest, kind: "compaction", native, origin: codex, retained: "Recorded state" });
    expect(projectTranscript(chat.items, { ...codex, nativeCompaction: true })).toEqual([
      { native, type: "compaction" },
      { text: "Recorded state", type: "user" },
      { text: "Newest", type: "user" }
    ]);
    // Another target cannot read it: replay starts at c1 again, with c2 skipped where it stands.
    expect(projectTranscript(chat.items, gemini)).toEqual([summary, ...tail]);

    // A compaction whose kept tail is gone is not used: replay never drops the tail it promised.
    const misplaced = [...chat.items.filter((item) => item.id !== "c1" && item.id !== "c2"),
      { id: "c3", keepFromId: "missing", kind: "compaction" as const, origin: codex, summary: "S" }];
    expect(projectTranscript(misplaced, gemini).map((item) => item.type))
      .toEqual(["user", "assistant_text", "user", "tool_call", "tool_result", "user"]);
    expect(selectTranscript(misplaced, gemini).base).toBeNull();
  });

  it("keeps the run's own context through a compaction whose kept tail starts after it", () => {
    const chat = transcript();
    chat.user("Old question");
    chat.respond(codex, responsesHistoryFromOutput([{ content: [{ text: "Old answer", type: "output_text" }], role: "assistant", type: "message" }]));
    chat.items.push({ id: "ctx-2", kind: "user", runContext: true, text: "Skills index" });
    chat.user("Current question");
    chat.respond(codex, responsesHistoryFromOutput([{ arguments: "{}", call_id: "call_1", name: "lookup_order", type: "function_call" }]));
    chat.result("call_1", "R");
    const kept = chat.items.length;
    chat.respond(codex, responsesHistoryFromOutput([{ content: [{ text: "Working on it", type: "output_text" }], role: "assistant",
      type: "message" }]));
    // A compaction in the middle of the turn covers the Skills index's place, but not the index, which stays before the
    // summary as it stood before the span the summary covers.
    chat.items.push({ id: "c1", keepFromId: chat.items[kept]!.id, kind: "compaction", origin: codex, summary: "Earlier work." });
    expect(selectTranscript(chat.items, gemini).window.map((item) => item.id)).toEqual(["ctx-2", "c1", chat.items[kept]!.id]);
    expect(projectTranscript(chat.items, gemini)).toEqual([
      { text: "Skills index", type: "user" },
      { text: "Summary of the earlier conversation:\n\nEarlier work.", type: "user" },
      { text: "Working on it", type: "assistant_text" }
    ]);
  });

  describe("the run's input while its request carries attachments", () => {
    const chart: ProviderAttachment = { byteSize: 3, dataUrl: "data:image/png;base64,AAAA", extractedText: null, fileName: "chart.png",
      id: "chart", kind: "image", metadata: {}, mimeType: "image/png", status: "ready" };
    const response = (index: number): readonly ProviderHistoryItem[] =>
      [{ arguments: `{"order_id":"A-${index}"}`, callId: `call_${index}`, name: "lookup_order", type: "tool_call" }];

    /** An earlier turn, the run's context, its input and three tool rounds, compacted up to the last round. */
    function compactedTurn(origin: TranscriptOrigin) {
      const chat = transcript();
      chat.user("Old question");
      chat.respond(origin, [{ text: "Old answer", type: "assistant_text" }]);
      chat.items.push({ id: "ctx-2", kind: "user", runContext: true, text: "Skills index" });
      const input = chat.user("What does the chart say?");
      for (const index of [1, 2, 3]) {
        chat.respond(origin, response(index));
        chat.result(`call_${index}`, `result ${index}`);
      }
      const kept = chat.items.findIndex((item) => item.kind === "tool_call" && item.callId === "call_3");
      chat.items.push({ id: "c1", keepFromId: chat.items[kept]!.id, kind: "compaction", origin, summary: "Two lookups done." });
      return { input, items: chat.items, kept: chat.items[kept]!.id };
    }

    const attached = { attachmentIds: [chart.id], attachments: [chart] };

    it("replays it right after the run's context and before the summary, once, with the kept tail after it", () => {
      const { input, items, kept } = compactedTurn(codex);
      const target = { ...gemini, carriedInputId: input };
      expect(selectTranscript(items, target).window.map((item) => item.id).slice(0, 4)).toEqual(["ctx-2", input, "c1", kept]);
      expect(projectTranscript(items, target, { currentInputId: input })).toEqual([
        { text: "Skills index", type: "user" },
        { currentInput: true, text: "What does the chart say?", type: "user" },
        { text: "Summary of the earlier conversation:\n\nTwo lookups done.", type: "user" },
        { arguments: "{\"order_id\":\"A-3\"}", callId: "call_3", name: "lookup_order", type: "tool_call" },
        { callId: "call_3", name: "lookup_order", output: "result 3", type: "tool_result" }
      ]);
      // Without attachments to carry it for, it goes with the cut, as it always did.
      expect(selectTranscript(items, gemini).window.map((item) => item.id).slice(0, 3)).toEqual(["ctx-2", "c1", kept]);
    });

    it("keeps the request's prefix through a compaction: run context, input and attachments come before every summary", () => {
      const { input, items } = compactedTurn(codex);
      const target = { ...gemini, carriedInputId: input };
      const prefix = (history: readonly ProviderHistoryItem[]) => history.slice(0, 2);
      const first = projectTranscript(items, target, { currentInputId: input });
      // The turn goes on and compacts again: the summary changes, what precedes it does not.
      items.push({ arguments: "{}", callId: "call_4", id: "r4-call", kind: "tool_call", name: "lookup_order", origin: codex },
        { callId: "call_4", id: "r4-result", kind: "tool_result", name: "lookup_order", outcome: "complete", output: "result 4" },
        { id: "c2", keepFromId: "r4-call", kind: "compaction", origin: codex, summary: "Three lookups done." });
      const second = projectTranscript(items, target, { currentInputId: input });
      expect(prefix(second)).toEqual(prefix(first));
      expect(prefix(first)).toEqual([{ text: "Skills index", type: "user" },
        { currentInput: true, text: "What does the chart say?", type: "user" }]);
      expect(second[2]).toEqual({ text: "Summary of the earlier conversation:\n\nThree lookups done.", type: "user" });
      expect(second.slice(3).map((item) => item.type)).toEqual(["tool_call", "tool_result"]);
      // The provider bodies agree: each adapter sends the same bytes up to the end of the input and its attachment.
      const builders: readonly ((history: readonly ProviderHistoryItem[]) => unknown)[] = [
        (history) => buildOpenAIResponsesRequest(request(openai, history, { ...attached,
          params: { background: false, maxOutputTokens: 256, reasoning: { effort: "low" }, store: false, stream: true }, provider: "openai" })),
        (history) => buildGeminiInteractionsRequest(request(gemini, history, attached)),
        (history) => buildAnthropicMessagesRequest(request(openai, history, { ...attached, params: { maxTokens: 256 },
          provider: "anthropic" }))
      ];
      for (const build of builders) {
        const body = (history: readonly ProviderHistoryItem[]) => JSON.stringify(build(history));
        const before = body(first);
        const summaryAt = before.indexOf("Summary of the earlier conversation");
        expect(before.indexOf("AAAA")).toBeGreaterThan(-1);
        expect(summaryAt).toBeGreaterThan(before.indexOf("AAAA"));
        expect(body(second).slice(0, summaryAt)).toBe(before.slice(0, summaryAt));
      }
    });

    it("stays where it stands while the kept tail holds it, and stays too after a route's own compaction, which keeps no tail", () => {
      const chat = compactedTurn(codex);
      const held = chat.items.map((item) => item.id === "c1" ? { ...item, keepFromId: chat.input } as TranscriptItem : item);
      expect(selectTranscript(held, { ...codex, carriedInputId: chat.input }).window.filter((item) => item.id === chat.input)).toHaveLength(1);

      const route = transcript();
      const input = route.user("What does the chart say?");
      route.respond(codex, response(1));
      route.result("call_1", "result 1");
      route.respond(codex, responsesHistoryFromOutput([{ encrypted_content: "ENC", id: "cmp_1", type: "compaction" }]));
      route.respond(codex, [{ text: "Almost there", type: "assistant_text" }]);
      const history = projectTranscript(route.items, { ...codex, carriedInputId: input, nativeCompaction: true }, { currentInputId: input });
      expect(history.map((item) => item.type)).toEqual(["compaction", "user", "assistant_text"]);
      expect(history[1]).toEqual({ currentInput: true, text: "What does the chart say?", type: "user" });
    });

    it("starts the turn for a current-turn target: the turn's reasoning stays, earlier reasoning stays out", () => {
      const anthropic: TranscriptTarget = { model: "claude-haiku-5-5", provider: "anthropic", reasoningScope: "current_turn" };
      const native = (id: string): ProviderHistoryItem => ({ native: { fields: { id }, format: "anthropic_messages" }, type: "reasoning" });
      const chat = transcript();
      chat.user("Old question");
      chat.respond(anthropic, [native("old"), { text: "Old answer", type: "assistant_text" }]);
      const input = chat.user("What does the chart say?");
      chat.respond(anthropic, response(1));
      chat.result("call_1", "result 1");
      chat.respond(anthropic, [native("kept"), { text: "Almost there", type: "assistant_text" }]);
      const kept = chat.items.at(-2)!.id;
      chat.items.push({ id: "c1", keepFromId: kept, kind: "compaction", origin: anthropic, summary: "One lookup done." });
      expect(projectTranscript(chat.items, { ...anthropic, carriedInputId: input }, { currentInputId: input }).map((item) => item.type))
        .toEqual(["user", "user", "reasoning", "assistant_text"]);
    });

    it("renders the attachment on every adapter after a compaction of the turn", () => {
      const history = (target: TranscriptTarget) => {
        const { input, items } = compactedTurn(target);
        return projectTranscript(items, { ...target, carriedInputId: input }, { currentInputId: input });
      };
      const chatParams = { params: { maxTokens: 256, stream: true } };
      const bodies: Readonly<Record<string, unknown>> = {
        anthropic: buildAnthropicMessagesRequest(request(openai, history(openai), { ...attached, params: { maxTokens: 256 },
          provider: "anthropic" })),
        codex: buildCompatibleResponsesRequest(request(codex, history(codex), { ...attached, provider: "openai_compatible" })),
        compatibleChat: buildOpenAICompatibleChatRequest(request(openai, history(openai), { ...attached, ...chatParams,
          provider: "openai_compatible" })),
        deepseek: buildDeepSeekResponsesRequest(request(deepseek, history(deepseek), attached)),
        gemini: buildGeminiInteractionsRequest(request(gemini, history(gemini), attached)),
        openai: buildOpenAIResponsesRequest(request(openai, history(openai), { ...attached,
          params: { background: false, maxOutputTokens: 256, reasoning: { effort: "low" }, store: false, stream: true }, provider: "openai" })),
        openrouter: buildOpenRouterChatRequest(request(openrouter, history(openrouter), { ...attached, ...chatParams, provider: "openrouter" }))
      };
      for (const [adapter, body] of Object.entries(bodies)) {
        const text = JSON.stringify(body);
        expect({ adapter, attached: text.includes("AAAA") }).toEqual({ adapter, attached: true });
        // The kept round follows the input; the two rounds the compaction covered do not.
        expect({ adapter, covered: text.includes("result 1"), kept: text.includes("result 3") }).toEqual({ adapter, covered: false, kept: true });
      }
    });
  });

  it("keeps only the current turn's reasoning for a current-turn target, across follow-ups", () => {
    const chat = transcript();
    chat.user("First");
    chat.respond(deepseek, responsesHistoryFromOutput([
      { content: [{ text: "think one", type: "reasoning_text" }], id: "r1", summary: [], type: "reasoning" },
      { content: [{ text: "One.", type: "output_text" }], role: "assistant", type: "message" }
    ]));
    chat.user("Second");
    chat.respond(deepseek, responsesHistoryFromOutput([
      { content: [{ text: "think two", type: "reasoning_text" }], id: "r2", summary: [], type: "reasoning" },
      { arguments: "{}", call_id: "call_1", name: "lookup_order", type: "function_call" }
    ]));
    chat.user("Meanwhile", true);
    chat.result("call_1", "{}");
    const reasoningIds = (target: TranscriptTarget) => projectTranscript(chat.items, target).flatMap((item) =>
      item.type === "reasoning" ? [item.native.fields.id] : []);
    expect(reasoningIds(deepseek)).toEqual(["r1", "r2"]);
    expect(reasoningIds({ ...deepseek, reasoningScope: "current_turn" })).toEqual(["r2"]);
  });

  it("attributes a response's reported output tokens to its items", () => {
    const items = modelResponseItems({
      estimate,
      history: responsesHistoryFromOutput([
        { encrypted_content: "ENC", id: "rs", summary: [], type: "reasoning" },
        { content: [{ text: "x".repeat(40), type: "output_text" }], role: "assistant", type: "message" },
        { arguments: "y".repeat(36), call_id: "call", name: "abcd", type: "function_call" }
      ]),
      nextId: (() => { let next = 0; return () => `n${++next}`; })(),
      origin: codex,
      requestAnchor: { attachmentIds: [], baseId: null, fixedTokens: 500, inputTokens: 2_000 },
      usage: { outputTokens: 120, reasoningTokens: 80 }
    });
    expect(items.map((item) => "outputTokens" in item ? item.outputTokens : undefined)).toEqual([80, 20, 20]);
    // Only the first item keeps its request's anchor: the items before it are what the request carried.
    expect(items.map((item) => "requestAnchor" in item ? item.requestAnchor?.inputTokens : undefined)).toEqual([2_000, undefined, undefined]);
    expect(items.every((item) => "origin" in item && item.origin?.provider === "codex-lb")).toBe(true);
    const unknown = modelResponseItems({ estimate, history: responsesHistoryFromOutput([
      { encrypted_content: "ENC", id: "rs", summary: [], type: "reasoning" },
      { content: [{ text: "x", type: "output_text" }], role: "assistant", type: "message" }
    ]), nextId: (() => { let next = 0; return () => `u${++next}`; })(), origin: codex,
    usage: { outputTokens: 10, reasoningTokens: null } });
    expect(unknown.some((item) => "outputTokens" in item)).toBe(false);
  });

  it("refuses duplicate item ids and response items a model cannot produce", () => {
    expect(() => selectTranscript([
      { id: "same", kind: "user", text: "a" },
      { id: "same", kind: "user", text: "b" }
    ], codex)).toThrow("transcript_item_id_duplicate");
    expect(() => modelResponseItems({ estimate, history: [{ text: "x", type: "user" }], nextId: () => "x", origin: codex }))
      .toThrow("transcript_response_item_invalid");
  });

  it("carries a result's image only while the run holds its preview, and names how to see it again otherwise", () => {
    const image = { consumerKey: "tool-1", descriptor: { byteSize: 10, checksum: "b".repeat(64), frames: 1, height: 8, id: "a".repeat(64),
      mimeType: "image/png", source: { byteSize: 20, captureId: "c".repeat(32), checksum: "d".repeat(64), height: 16,
        relativePath: "project/code.png", width: 20 }, transform: null, version: 1, width: 10 } } as const;
    const items: TranscriptItem[] = [
      { id: "u1", kind: "user", text: "Read the code on the screenshot." },
      { arguments: "{\"path\":\"/workspace/project/code.png\"}", callId: "call_view", id: "c1", kind: "tool_call",
        name: "view_workspace_image", origin: codex },
      { callId: "call_view", id: "t1", image, kind: "tool_result", name: "view_workspace_image", outcome: "complete",
        output: "Preview of /workspace/project/code.png" }
    ];
    const pixels = { data: "UElYRUxT", mimeType: "image/png" } as const;
    const held = { attached: (item: { image?: unknown }) => item.image === image ? { image: pixels, tokens: 77 } : undefined,
      note: IMAGE_VIEW_NOTE };
    expect(projectTranscript(items, codex, { images: held }).at(-1)).toEqual({ callId: "call_view", images: [pixels],
      name: "view_workspace_image", output: "Preview of /workspace/project/code.png", type: "tool_result" });
    // A sub-agent's thread keeps its notes across runs: a file of its own earlier run was never an export.
    for (const note of [IMAGE_VIEW_NOTE, IMAGE_ANALYZE_NOTE]) expect(note).toMatch(/copy it with `cp` into \/workspace\/project\//u);
    // An earlier run's result, a compaction's span or a released preview: the reference alone, never stored pixels, with how
    // the run sees it again (a compaction calls no tools).
    for (const [images, note] of [[undefined, IMAGE_REFERENCE_NOTE], [{ attached: () => undefined, note: IMAGE_VIEW_NOTE }, IMAGE_VIEW_NOTE],
      [{ attached: () => undefined, note: IMAGE_ANALYZE_NOTE }, IMAGE_ANALYZE_NOTE]] as const) {
      expect(projectTranscript(items, codex, images ? { images } : {}).at(-1)).toEqual({ callId: "call_view", name: "view_workspace_image",
        output: `Preview of /workspace/project/code.png\n\n${note}`, type: "tool_result" });
    }
    expect(JSON.stringify(items)).not.toContain("UElYRUxT");
    const body = buildCompatibleResponsesRequest(request(codex, projectTranscript(items, codex, { images: held })));
    expect((body.input as Record<string, unknown>[]).at(-1)).toEqual({ call_id: "call_view", type: "function_call_output",
      output: [{ text: "Preview of /workspace/project/code.png", type: "input_text" },
        { detail: "auto", image_url: "data:image/png;base64,UElYRUxT", type: "input_image" }] });
  });
});
