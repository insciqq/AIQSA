import { describe, expect, it } from "vitest";
import { decodeTranscriptItem, encodeTranscriptItem, TranscriptItemInvalidError } from "./transcriptCodec";
import type { TranscriptItem } from "./transcript";

const origin = { model: "gpt-6-astra", provider: "connection-1" };
/** A Workspace preview's reference: what the transcript keeps of a viewed image, never its pixels. */
const image = { consumerKey: "tool-1", descriptor: { byteSize: 10, checksum: "b".repeat(64), frames: 1, height: 8, id: "a".repeat(64),
  mimeType: "image/png", source: { byteSize: 20, captureId: "c".repeat(32), checksum: "d".repeat(64), height: 16,
    relativePath: "project/code.png", width: 20 }, transform: { resize: { height: 1024, width: 1024 } }, version: 1, width: 10 } } as const;

const items: TranscriptItem[] = [
  { id: "u1", kind: "user", text: "Look up A-17" },
  { followup: true, id: "u2", kind: "user", text: "Also B-42" },
  { id: "a1", kind: "assistant_text", native: { fields: { phase: "commentary" }, format: "openai_responses" }, origin,
    outputTokens: 12, text: "Checking." },
  { id: "a2", kind: "assistant_text", text: "Imported answer" },
  // The first item of a response keeps its request's anchor for the chat's next run.
  { id: "a3", kind: "assistant_text", origin, requestAnchor: { attachmentIds: ["file-1"], baseId: "k1", fixedTokens: 900,
    inputTokens: 4_200 }, text: "Done." },
  { id: "r1", kind: "reasoning", native: { fields: { encrypted_content: "ENC", id: "rs_1", type: "reasoning" }, format: "openai_responses" },
    origin, outputTokens: 40, requestAnchor: { attachmentIds: [], baseId: null, fixedTokens: 900, inputTokens: 3_100 } },
  // An Anthropic thinking block, whole, with what it was produced after.
  { id: "r2", kind: "reasoning", native: { fields: { binding: { prefix: "DIGEST", previous: null },
    block: { signature: "SIG", thinking: "", type: "thinking" } }, format: "anthropic_messages" }, origin: { model: "claude-haiku-5-5",
    provider: "connection-2" } },
  { arguments: "{\"order_id\":\"A-17\"}", callId: "call_1", id: "c1", kind: "tool_call", name: "lookup_order",
    native: { fields: { id: "fc_1" }, format: "openai_responses" }, origin },
  { callId: "call_1", handle: "tor1_0123456789abcdef0123456789abcdef", id: "t1", kind: "tool_result", name: "lookup_order",
    outcome: "complete", output: "{\"status\":\"shipped\"}" },
  { callId: "call_2", id: "t2", kind: "tool_result", name: "lookup_order", outcome: "unknown", output: "No result." },
  // An approved call's record before it is sent again.
  { callId: "call_3", id: "t3", inFlight: true, kind: "tool_result", name: "create_order", outcome: "unknown", output: "In flight." },
  { callId: "call_4", id: "t4", image, kind: "tool_result", name: "view_workspace_image", outcome: "complete", output: "Preview of code.png" },
  { id: "k1", kind: "compaction", origin, summary: "Earlier work." },
  { id: "k2", kind: "compaction", native: { fields: { type: "compaction" }, format: "openai_responses" }, origin },
  // A compaction that keeps a tail, with its retained record and the size its call reported.
  { id: "k3", keepFromId: "u2", kind: "compaction", native: { fields: { encrypted_content: "ENC", type: "compaction" },
    format: "openai_responses" }, origin, outputTokens: 1_400, retained: "## Recorded state\n- a.py: written" },
  { id: "k4", keepFromId: "u2", kind: "compaction", origin, retained: "R", summary: "## Goal\nx" }
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
      // Only an unknown outcome is in flight, and the mark is true or absent.
      { body: { inFlight: true, name: "lookup", outcome: "complete", output: "" }, callId: "call_1", id: "x", kind: "tool_result" },
      { body: { inFlight: false, name: "lookup", outcome: "unknown", output: "" }, callId: "call_1", id: "x", kind: "tool_result" },
      // Only a completed view keeps an image reference, and only one that parses as its evidence.
      { body: { image, name: "lookup", outcome: "complete", output: "" }, callId: "call_1", id: "x", kind: "tool_result" },
      { body: { image, name: "view_workspace_image", outcome: "error", output: "" }, callId: "call_1", id: "x", kind: "tool_result" },
      { body: { image: { ...image, data: "UElYRUxT" }, name: "view_workspace_image", outcome: "complete", output: "" }, callId: "call_1",
        id: "x", kind: "tool_result" },
      { body: { image: { consumerKey: "tool-1", descriptor: { ...image.descriptor, checksum: "not-a-hash" } }, name: "view_workspace_image",
        outcome: "complete", output: "" }, callId: "call_1", id: "x", kind: "tool_result" },
      { body: { native: { fields: {}, format: "other" }, origin }, callId: null, id: "x", kind: "reasoning" },
      { body: { origin }, callId: null, id: "x", kind: "compaction" },
      { body: { keepFromId: "", origin, summary: "s" }, callId: null, id: "x", kind: "compaction" },
      { body: { origin, retained: 3, summary: "s" }, callId: null, id: "x", kind: "compaction" },
      { body: { origin, outputTokens: 1.5, summary: "s" }, callId: null, id: "x", kind: "compaction" },
      { body: { outputTokens: -1, text: "x" }, callId: null, id: "x", kind: "assistant_text" },
      { body: { origin, requestAnchor: { attachmentIds: [], baseId: null, fixedTokens: 1, inputTokens: -1 }, text: "x" }, callId: null,
        id: "x", kind: "assistant_text" },
      { body: { origin, requestAnchor: { attachmentIds: [], fixedTokens: 1, inputTokens: 1 }, text: "x" }, callId: null, id: "x",
        kind: "assistant_text" },
      { body: { origin, requestAnchor: { baseId: null, fixedTokens: 1, inputTokens: 1 }, text: "x" }, callId: null, id: "x",
        kind: "assistant_text" },
      { body: { origin, requestAnchor: { attachmentIds: [""], baseId: null, fixedTokens: 1, inputTokens: 1 }, text: "x" }, callId: null,
        id: "x", kind: "assistant_text" },
      { body: [], callId: null, id: "x", kind: "user" }
    ];
    for (const row of invalid) expect(() => decodeTranscriptItem(row)).toThrow(TranscriptItemInvalidError);
  });

  it("refuses an item too large to store", () => {
    expect(() => encodeTranscriptItem({ id: "u1", kind: "user", text: "x".repeat(8 * 1024 * 1024 + 1) }))
      .toThrow(TranscriptItemInvalidError);
  });
});
