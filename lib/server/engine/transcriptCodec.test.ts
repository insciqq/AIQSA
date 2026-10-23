import { describe, expect, it } from "vitest";
import { decodeTranscriptItem, encodeTranscriptItem, TranscriptItemInvalidError } from "./transcriptCodec";
import type { TranscriptItem } from "./transcript";

const origin = { model: "gpt-6-astra", provider: "connection-1" };

const items: TranscriptItem[] = [
  { id: "u1", kind: "user", text: "Look up A-17" },
  { followup: true, id: "u2", kind: "user", text: "Also B-42" },
  { id: "a1", kind: "assistant_text", native: { fields: { phase: "commentary" }, format: "openai_responses" }, origin,
    outputTokens: 12, text: "Checking." },
  { id: "a2", kind: "assistant_text", text: "Imported answer" },
  { id: "r1", kind: "reasoning", native: { fields: { encrypted_content: "ENC", id: "rs_1", type: "reasoning" }, format: "openai_responses" },
    origin, outputTokens: 40 },
  { arguments: "{\"order_id\":\"A-17\"}", callId: "call_1", id: "c1", kind: "tool_call", name: "lookup_order",
    native: { fields: { id: "fc_1" }, format: "openai_responses" }, origin },
  { callId: "call_1", handle: "tor1_0123456789abcdef0123456789abcdef", id: "t1", kind: "tool_result", name: "lookup_order",
    outcome: "complete", output: "{\"status\":\"shipped\"}" },
  { callId: "call_2", id: "t2", kind: "tool_result", name: "lookup_order", outcome: "unknown", output: "No result." },
  { id: "k1", kind: "compaction", origin, summary: "Earlier work." },
  { id: "k2", kind: "compaction", native: { fields: { type: "compaction" }, format: "openai_responses" }, origin }
];

describe("transcript codec", () => {
  it("round-trips every item kind through its row form", () => {
    for (const item of items) {
      const row = encodeTranscriptItem(item);
      expect(row.kind).toBe(item.kind);
      expect(row.callId).toBe(item.kind === "tool_call" || item.kind === "tool_result" ? item.callId : null);
      expect(decodeTranscriptItem({ ...row, id: item.id })).toEqual(item);
    }
  });

  it("refuses rows of another shape instead of skipping them", () => {
    const invalid = [
      { body: { text: "x" }, callId: null, id: "x", kind: "unknown_kind" },
      { body: { text: 7 }, callId: null, id: "x", kind: "user" },
      { body: { text: "x", followup: false }, callId: null, id: "x", kind: "user" },
      { body: { text: "x" }, callId: "call_1", id: "x", kind: "user" },
      { body: { arguments: "{}", name: "lookup" }, callId: null, id: "x", kind: "tool_call" },
      { body: { name: "lookup", outcome: "maybe", output: "" }, callId: "call_1", id: "x", kind: "tool_result" },
      { body: { native: { fields: {}, format: "other" }, origin }, callId: null, id: "x", kind: "reasoning" },
      { body: { origin }, callId: null, id: "x", kind: "compaction" },
      { body: { outputTokens: -1, text: "x" }, callId: null, id: "x", kind: "assistant_text" },
      { body: [], callId: null, id: "x", kind: "user" }
    ];
    for (const row of invalid) expect(() => decodeTranscriptItem(row)).toThrow(TranscriptItemInvalidError);
  });

  it("refuses an item too large to store", () => {
    expect(() => encodeTranscriptItem({ id: "u1", kind: "user", text: "x".repeat(8 * 1024 * 1024 + 1) }))
      .toThrow(TranscriptItemInvalidError);
  });
});
