import { describe, expect, it } from "vitest";
import { responsesHistoryFromOutput, type ProviderHistoryItem } from "../providers/history";
import {
  CONTEXT_ITEM_FRAMING_TOKENS as FRAMING,
  contextAnchor,
  measureContext
} from "./contextMeasure";
import { modelResponseItems, type TranscriptItem, type TranscriptOrigin, type TranscriptTarget } from "./transcript";

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
