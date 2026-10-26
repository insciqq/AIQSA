import { describe, expect, it } from "vitest";
import { contextTokenEstimator, estimateContextTokens, tokenEstimateProfileFor } from "../../domain/tokenEstimate";
import { responsesHistoryFromOutput, type ProviderHistoryItem } from "../providers/history";
import {
  CONTEXT_ITEM_FRAMING_TOKENS as FRAMING,
  CONTEXT_MEASURE_CALIBRATION,
  contextAnchor,
  contextItemTokens,
  contextMeasureCalibration,
  measureContext,
  type ContextMeasureCalibration
} from "./contextMeasure";
import { IMAGE_REFERENCE_NOTE, IMAGE_VIEW_NOTE, modelResponseItems, type TranscriptItem, type TranscriptOrigin, type TranscriptTarget } from "./transcript";

const codex: TranscriptTarget = { model: "gpt-6-astra", provider: "codex-lb" };
const deepseek: TranscriptTarget = { model: "deepseek-flash", provider: "deepseek" };

/** One token per character keeps every expected value readable. */
const estimate = (value: unknown) => String(value).length;

function chat() {
  let next = 0;
  const items: TranscriptItem[] = [];
  const nextId = () => `i${++next}`;
  return {
    items,
    respond(origin: TranscriptOrigin, history: readonly ProviderHistoryItem[], usage: { outputTokens: number; reasoningTokens: number }) {
      items.push(...modelResponseItems({ estimate, history, nextId, origin, usage }));
    },
    result(callId: string, output: string) {
      items.push({ callId, id: nextId(), kind: "tool_result", name: "tool", outcome: "complete", output });
    },
    user(text: string) {
      items.push({ id: nextId(), kind: "user", text });
    }
  };
}

const toolRound = (encrypted = "E".repeat(5_000)) => responsesHistoryFromOutput([
  { encrypted_content: encrypted, id: "rs", summary: [], type: "reasoning" },
  { arguments: "{}", call_id: "call_1", name: "tool", type: "function_call" }
]);

describe("anchored context measure", () => {
  it("estimates a request without an anchor from its items and fixed parts, never from encrypted reasoning", () => {
    const conversation = chat();
    conversation.user("hello");
    expect(measureContext({ estimate, fixedTokens: 300, items: conversation.items, target: codex })).toEqual({
      addedItems: 1, addedTokens: 5 + FRAMING.user, anchored: false, removedItems: 0, removedTokens: 0, tokens: 300 + 5 + FRAMING.user
    });
    conversation.respond(codex, toolRound(), { outputTokens: 70, reasoningTokens: 60 });
    conversation.result("call_1", "result");
    const measure = measureContext({ estimate, fixedTokens: 300, items: conversation.items, target: codex });
    // The 5,000-character blob weighs nothing; the call weighs its reported 10 tokens.
    expect(measure.tokens).toBe(300 + 5 + FRAMING.user + 10 + FRAMING.tool_call + 4 + 6 + FRAMING.tool_result);
  });

  it("adds what the anchored request did not carry to the provider's reported input", () => {
    const conversation = chat();
    conversation.user("hello");
    const anchor = contextAnchor({ itemCount: conversation.items.length, target: codex, usage: { inputTokens: 1_000 } });
    conversation.respond(codex, toolRound(), { outputTokens: 70, reasoningTokens: 60 });
    conversation.result("call_1", "result");
    const added = 10 + FRAMING.tool_call + "tool".length + "result".length + FRAMING.tool_result;
    expect(measureContext({ anchor, estimate, fixedTokens: 300, items: conversation.items, target: codex })).toEqual({
      addedItems: 3, addedTokens: added, anchored: true, removedItems: 0, removedTokens: 0, tokens: 1_000 + added
    });
    // The provider-figure policy counts the reasoning tokens the call reported.
    expect(measureContext({ anchor, estimate, fixedTokens: 300, items: conversation.items, reasoning: "reported", target: codex }).tokens)
      .toBe(1_000 + added + 60);
  });

  it("estimates another model's items locally after a switch and anchors on the target's own last call", () => {
    const conversation = chat();
    conversation.user("one");
    conversation.respond(codex, responsesHistoryFromOutput([
      { content: [{ text: "first answer", type: "output_text" }], role: "assistant", type: "message" }
    ]), { outputTokens: 3, reasoningTokens: 0 });
    const anchor = contextAnchor({ itemCount: 1, target: codex, usage: { inputTokens: 500 } });
    conversation.user("two");
    conversation.respond(deepseek, toolRound("D"), { outputTokens: 900, reasoningTokens: 880 });
    conversation.result("call_1", "result");
    conversation.respond(deepseek, responsesHistoryFromOutput([
      { content: [{ text: "second answer", type: "output_text" }], role: "assistant", type: "message" }
    ]), { outputTokens: 400, reasoningTokens: 0 });
    conversation.user("three");

    const measure = measureContext({ anchor, estimate, fixedTokens: 0, items: conversation.items, reasoning: "reported", target: codex });
    // Codex's own answer weighs its reported 3 tokens; DeepSeek's items weigh their text, not its figures,
    // and its reasoning is not sent to Codex at all.
    expect(measure).toMatchObject({ addedItems: 6, anchored: true, removedItems: 0 });
    expect(measure.tokens).toBe(500 +
      (3 + FRAMING.assistant_text) + ("two".length + FRAMING.user) + ("tool".length + "{}".length + FRAMING.tool_call) +
      ("tool".length + "result".length + FRAMING.tool_result) + ("second answer".length + FRAMING.assistant_text) +
      ("three".length + FRAMING.user));
    // An anchor of another route and model is not used.
    expect(measureContext({ anchor, estimate, fixedTokens: 0, items: conversation.items, target: deepseek }).anchored).toBe(false);
  });

  it("subtracts items the request no longer carries", () => {
    const conversation = chat();
    const scoped: TranscriptTarget = { ...deepseek, reasoningScope: "current_turn" };
    conversation.user("one");
    conversation.respond(deepseek, responsesHistoryFromOutput([
      { content: [{ text: "plain reasoning", type: "reasoning_text" }], id: "r1", summary: [], type: "reasoning" },
      { arguments: "{}", call_id: "call_1", name: "tool", type: "function_call" }
    ]), { outputTokens: 50, reasoningTokens: 40 });
    conversation.result("call_1", "result");
    // The anchored request carried the first turn's reasoning: it was the current turn then.
    const anchor = contextAnchor({ itemCount: conversation.items.length, target: deepseek, usage: { inputTokens: 700 } });
    conversation.respond(deepseek, responsesHistoryFromOutput([
      { content: [{ text: "answer", type: "output_text" }], role: "assistant", type: "message" }
    ]), { outputTokens: 6, reasoningTokens: 0 });
    conversation.user("two");
    const measure = measureContext({ anchor, estimate, fixedTokens: 0, items: conversation.items, reasoning: "reported", target: scoped });
    expect(measure).toMatchObject({ addedItems: 2, anchored: true, removedItems: 1, removedTokens: 40 });
    expect(measure.tokens).toBe(700 + (6 + FRAMING.assistant_text) + ("two".length + FRAMING.user) - 40);
  });

  it("weighs a result's image by its estimate while the run's request carries it, else by the note that replaces it", () => {
    const image = { consumerKey: "tool-1", descriptor: { byteSize: 10, checksum: "b".repeat(64), frames: 1, height: 8, id: "a".repeat(64),
      mimeType: "image/png", source: { byteSize: 20, captureId: "c".repeat(32), checksum: "d".repeat(64), height: 16,
        relativePath: "project/code.png", width: 20 }, transform: null, version: 1, width: 10 } } as const;
    const items: TranscriptItem[] = [
      { id: "u1", kind: "user", text: "look" },
      { arguments: "{}", callId: "call_1", id: "c1", kind: "tool_call", name: "view" },
      { callId: "call_1", id: "t1", image, kind: "tool_result", name: "view", outcome: "complete", output: "preview" }
    ];
    const call = "view".length + "{}".length + FRAMING.tool_call;
    const result = "view".length + "preview".length + FRAMING.tool_result;
    const held = { attached: () => ({ image: { data: "UElYRUxT", mimeType: "image/png" as const }, tokens: 1_200 }), note: IMAGE_VIEW_NOTE };
    expect(measureContext({ estimate, fixedTokens: 0, images: held, items, target: codex }).tokens)
      .toBe("look".length + FRAMING.user + call + result + 1_200);
    expect(measureContext({ estimate, fixedTokens: 0, items, target: codex }).tokens)
      .toBe("look".length + FRAMING.user + call + result + estimate(IMAGE_REFERENCE_NOTE));
    expect(measureContext({ estimate, fixedTokens: 0, images: { attached: () => undefined, note: IMAGE_VIEW_NOTE }, items, target: codex })
      .tokens).toBe("look".length + FRAMING.user + call + result + estimate(IMAGE_VIEW_NOTE));
    // A newly viewed image is added on top of the anchor, like any new item.
    const anchor = contextAnchor({ itemCount: 1, target: codex, usage: { inputTokens: 500 } });
    expect(measureContext({ anchor, estimate, fixedTokens: 0, images: held, items, target: codex }).tokens).toBe(500 + call + result + 1_200);
  });

  it("drops the anchor once a compaction changed where replay starts, and without reported input", () => {
    const conversation = chat();
    conversation.user("old");
    const anchor = contextAnchor({ itemCount: 1, target: codex, usage: { inputTokens: 90_000 } });
    conversation.items.push({ id: "c", kind: "compaction", origin: codex, summary: "short" });
    conversation.user("new");
    const measure = measureContext({ anchor, estimate, fixedTokens: 100, items: conversation.items, target: codex });
    expect(measure.anchored).toBe(false);
    expect(measure.tokens).toBeLessThan(1_000);
    expect(contextAnchor({ itemCount: 1, target: codex, usage: { inputTokens: null } })).toBeNull();
  });
});

describe("compaction weights", () => {
  const native = { fields: { encrypted_content: "E".repeat(9_000), type: "compaction" }, format: "openai_responses" as const };

  it("weighs a readable compaction by its summary and retained text", () => {
    const items: TranscriptItem[] = [
      { id: "u1", kind: "user", text: "old" },
      { id: "c1", kind: "compaction", origin: codex, retained: "kept facts", summary: "summary" }
    ];
    const measure = measureContext({ estimate, fixedTokens: 0, items, target: codex });
    const text = "Summary of the earlier conversation:\n\nsummary\n\nkept facts";
    expect(measure.tokens).toBe(text.length + FRAMING.compaction);
  });

  it("weighs a native compaction by its call's reported output plus its retained text, only on its own route", () => {
    const items: TranscriptItem[] = [
      { id: "u1", kind: "user", text: "old" },
      { id: "c1", kind: "compaction", native, origin: codex, outputTokens: 1_400, retained: "kept facts" }
    ];
    const own = { ...codex, nativeCompaction: true };
    expect(measureContext({ estimate, fixedTokens: 0, items, target: own }).tokens)
      .toBe(1_400 + "kept facts".length + FRAMING.user);
    // Without a reported output it weighs only its retained text; another route cannot use it.
    const unreported = items.map((item) => item.kind === "compaction" ? { ...item, outputTokens: undefined } : item);
    expect(measureContext({ estimate, fixedTokens: 0, items: unreported, target: own }).tokens).toBe("kept facts".length + FRAMING.user);
    expect(measureContext({ estimate, fixedTokens: 0, items, target: deepseek }).tokens).toBe("old".length + FRAMING.user);
  });
});

describe("Gemini calibration", () => {
  const gemini: TranscriptTarget = { model: "gemini-3.5-flash-lite", provider: "gemini" };
  const openrouter: TranscriptTarget = { model: "google/gemini-3.8-flash", provider: "openrouter" };

  it("selects the Gemini weights for native Gemini and OpenRouter google/* models only", () => {
    expect(contextMeasureCalibration(tokenEstimateProfileFor({ modelId: gemini.model, provider: "gemini" })))
      .toBe(CONTEXT_MEASURE_CALIBRATION.gemini);
    expect(contextMeasureCalibration(tokenEstimateProfileFor({ modelId: openrouter.model, provider: "openrouter" })))
      .toBe(CONTEXT_MEASURE_CALIBRATION.gemini);
    for (const input of [{ modelId: "gpt-6-astra", provider: "openai_compatible" }, { modelId: "deepseek-flash", provider: "deepseek" },
      { modelId: "openai/gpt-6", provider: "openrouter" }, { modelId: "gpt-6", provider: "fake" }]) {
      expect(contextMeasureCalibration(tokenEstimateProfileFor(input))).toBe(CONTEXT_MEASURE_CALIBRATION.default);
    }
  });

  // Spike 1 (2026-10-23, `scripts/spikes/transcript-replay.ts`): every anchored
  // call whose added items are known exactly, with the input the provider
  // reported before and after them. Calls rebuilt across a model switch carry
  // another model's answer text, which the content-free run did not keep.
  const orders: Readonly<Record<string, Readonly<{ carrier: string; eta_days: number; items: number; status: string }>>> = {
    "A-17": { carrier: "Northwind", eta_days: 3, items: 2, status: "shipped" },
    "B-42": { carrier: "Contoso", eta_days: 1, items: 1, status: "packing" },
    "C-5": { carrier: "Fabrikam", eta_days: 4, items: 3, status: "shipped" },
    "D-8": { carrier: "Northwind", eta_days: 2, items: 1, status: "in transit" },
    "E-3": { carrier: "Contoso", eta_days: 5, items: 4, status: "awaiting pickup" },
    "F-9": { carrier: "Fabrikam", eta_days: 6, items: 2, status: "delayed" }
  };
  const interrupted = "The process stopped while this tool call ran; its outcome is unknown.";
  const next = (orderId: string) => `Now look up order ${orderId} the same way.`;
  const which = "Without calling any tool, which of the two orders arrives first? Answer with its id in one short sentence.";
  type Added = Readonly<{ callOutput: number; orderId: string; unknown?: true }> | Readonly<{ answerOutput: number; user: string }>;
  type SpikeCall = Readonly<{ added: Added; anchor: number; reported: number }>;
  const pair = (orderId: string, callOutput: number, unknown?: true): Added => ({ callOutput, orderId, ...(unknown ? { unknown } : {}) });
  const text = (answerOutput: number, user: string): Added => ({ answerOutput, user });
  const nativeCalls: readonly SpikeCall[] = [
    { added: pair("A-17", 21), anchor: 133, reported: 162 }, { added: text(18, next("B-42")), anchor: 162, reported: 194 },
    { added: pair("B-42", 21), anchor: 194, reported: 223 }, { added: text(16, which), anchor: 223, reported: 263 },
    { added: pair("C-5", 20), anchor: 132, reported: 160 }, { added: pair("D-8", 20), anchor: 189, reported: 217 },
    { added: pair("E-3", 20), anchor: 132, reported: 160 }, { added: text(9, next("F-9")), anchor: 160, reported: 182 },
    { added: pair("F-9", 20, true), anchor: 182, reported: 210 }, { added: pair("F-9", 8), anchor: 210, reported: 238 }
  ];
  const openRouterCalls: readonly SpikeCall[] = [
    { added: pair("A-17", 21), anchor: 107, reported: 155 }, { added: text(8, next("B-42")), anchor: 155, reported: 175 },
    { added: pair("B-42", 21), anchor: 175, reported: 222 }, { added: text(9, which), anchor: 222, reported: 253 },
    { added: pair("C-5", 20), anchor: 106, reported: 153 }, { added: pair("D-8", 20), anchor: 180, reported: 226 },
    { added: pair("E-3", 20), anchor: 106, reported: 153 }, { added: text(9, next("F-9")), anchor: 153, reported: 173 },
    { added: pair("F-9", 20, true), anchor: 173, reported: 208 }
  ];

  function addedItems(added: Added, origin: TranscriptOrigin): TranscriptItem[] {
    if ("user" in added) {
      return [
        { id: "a", kind: "assistant_text", origin, outputTokens: added.answerOutput, text: "answer" },
        { id: "u", kind: "user", text: added.user }
      ];
    }
    const output = added.unknown ? interrupted
      : JSON.stringify({ order_id: added.orderId, ...orders[added.orderId], warehouse: "WH-3", note: "synthetic test record" });
    return [
      { arguments: JSON.stringify({ order_id: added.orderId }), callId: "c", id: "call", kind: "tool_call", name: "lookup_order",
        origin, outputTokens: added.callOutput },
      { callId: "c", id: "result", kind: "tool_result", name: "lookup_order", outcome: added.unknown ? "unknown" : "complete", output }
    ];
  }

  function errors(calls: readonly SpikeCall[], target: TranscriptTarget, weigh: (value: unknown) => number,
    calibration: ContextMeasureCalibration): number[] {
    return calls.map((call) => {
      const tokens = call.anchor + addedItems(call.added, target).reduce((total, item) =>
        total + contextItemTokens(item, target, weigh, "opaque", calibration), 0);
      return (tokens - call.reported) / call.reported;
    });
  }

  const mean = (values: readonly number[]) => values.reduce((left, right) => left + right, 0) / values.length;

  it("stays above every count Gemini reported while cutting the overestimate", () => {
    const geminiEstimate = contextTokenEstimator({ modelId: gemini.model, provider: "gemini" });
    const before = errors(nativeCalls, gemini, geminiEstimate, CONTEXT_MEASURE_CALIBRATION.default);
    const after = errors(nativeCalls, gemini, geminiEstimate, CONTEXT_MEASURE_CALIBRATION.gemini);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...after)).toBeLessThan(Math.max(...before));
    expect(mean(after)).toBeLessThan(mean(before));
    expect(Math.max(...after)).toBeLessThanOrEqual(0.28);
    expect(mean(after)).toBeLessThanOrEqual(0.15);
  });

  it("stays above every count OpenRouter reported for google/* models, which now take the Gemini family", () => {
    const unknownEstimate = (value: unknown) => estimateContextTokens(value, { family: "unknown" });
    const familyEstimate = contextTokenEstimator({ modelId: openrouter.model, provider: "openrouter" });
    const before = errors(openRouterCalls, openrouter, unknownEstimate, CONTEXT_MEASURE_CALIBRATION.default);
    const after = errors(openRouterCalls, openrouter, familyEstimate, CONTEXT_MEASURE_CALIBRATION.gemini);
    expect(Math.min(...after)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...after)).toBeLessThanOrEqual(0.17);
    expect(mean(after)).toBeLessThanOrEqual(0.09);
    expect(mean(after)).toBeLessThan(mean(before) / 2);
  });
});
