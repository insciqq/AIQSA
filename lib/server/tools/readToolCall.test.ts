import { describe, expect, it, vi } from "vitest";
import type { ToolHistoryRecord } from "../runs/toolHistoryRecords";
import { toolCallRef } from "../runs/toolHistoryContract";
import {
  decodeReadToolCallArguments,
  executeReadToolCall,
  READ_TOOL_CALL_LIMITS,
  readToolCallReceipt,
  readToolCallReceiptHash,
  type ToolCallReader
} from "./readToolCall";

const ref = toolCallRef("0f8fad5b-d9cb-469f-a165-70867728950e")!;
const actor = { runId: "run-2", userId: "user-1" };

function record(input: Partial<ToolHistoryRecord> = {}): ToolHistoryRecord {
  return { ref, kind: "mcp", toolName: "mcp_tracker_create_issue_abc", label: "MCP Tracker › create_issue", previousAttempt: false,
    roundIndex: 1, ordinal: 4, outcome: { status: "succeeded", dispatched: true },
    arguments: { state: "available", text: "{\"title\":\"fifth\"}" }, result: { state: "inline", text: "created #5" }, ...input };
}

const reader = (value: ToolHistoryRecord | null): ToolCallReader & { read: ReturnType<typeof vi.fn> } =>
  ({ read: vi.fn(async () => value) });
const call = (args: Record<string, unknown>) => ({ id: "call_9", name: "read_tool_call", arguments: args });
const value = (result: Awaited<ReturnType<typeof executeReadToolCall>>) => (result.content[0] as { value: Record<string, unknown> }).value;

describe("read_tool_call", () => {
  it("returns the saved arguments, outcome and result of exactly the referenced call", async () => {
    const source = reader(record());
    const result = await executeReadToolCall(source, call({ call_ref: ref }), actor);
    expect(source.read).toHaveBeenCalledWith(actor, ref, undefined);
    expect(result.status).toBe("complete");
    expect(value(result)).toMatchObject({ call_ref: ref, tool: { name: "mcp_tracker_create_issue_abc", kind: "mcp" },
      outcome: { status: "succeeded", dispatched: true },
      arguments: { state: "available", fragment: "{\"title\":\"fifth\"}", end_of_data: true, next_offset: null },
      result: { state: "available", fragment: "created #5", end_of_data: true } });
  });

  it("pages long arguments without loss, at character boundaries, until an explicit end", async () => {
    const text = JSON.stringify({ body: "ж".repeat(4000) + "end" });
    const source = reader(record({ arguments: { state: "available", text } }));
    let offset = 0;
    let collected = "";
    for (let pages = 0; pages < 20; pages += 1) {
      const result = value(await executeReadToolCall(source, call({ call_ref: ref, section: "arguments", offset, max_bytes: 1000 }), actor));
      const section = result.arguments as { fragment: string; next_offset: number | null; end_of_data: boolean };
      collected += section.fragment;
      expect(Buffer.byteLength(section.fragment)).toBeLessThanOrEqual(1000);
      if (section.end_of_data) {
        expect(section.next_offset).toBeNull();
        break;
      }
      expect(section.next_offset).toBeGreaterThan(offset);
      offset = section.next_offset!;
    }
    expect(collected).toBe(text);
    // An offset beyond the value is an invalid selector, never an invented end.
    expect(value(await executeReadToolCall(source, call({ call_ref: ref, section: "arguments", offset: 10_000_000 }), actor)))
      .toMatchObject({ code: "tool_call_selector_invalid" });
  });

  it("names a saved original for read_tool_result and keeps withheld or absent data explicit", async () => {
    const saved = value(await executeReadToolCall(reader(record({ result: { state: "saved", handle: `tor1_${"a".repeat(32)}`, preview: "{\"a\":1}" } })),
      call({ call_ref: ref, section: "result" }), actor));
    expect(saved.result).toEqual({ state: "saved_original", reader: "read_tool_result", handle: `tor1_${"a".repeat(32)}`,
      beginning: "{\"a\":1}", beginning_complete: true });
    const withheld = value(await executeReadToolCall(reader(record({ arguments: { state: "withheld", reason: "redaction_unavailable" },
      result: { state: "withheld", reason: "access_unavailable" } })), call({ call_ref: ref }), actor));
    expect(withheld.arguments).toMatchObject({ state: "withheld" });
    expect(withheld.result).toMatchObject({ state: "withheld" });
    expect(JSON.stringify(withheld)).not.toContain("fifth");
  });

  it("refuses unavailable, foreign and malformed references alike, without running anything", async () => {
    const missing = await executeReadToolCall(reader(null), call({ call_ref: ref }), actor);
    expect(missing.status).toBe("error");
    expect(value(missing)).toMatchObject({ code: "tool_call_unavailable" });
    for (const args of [{ call_ref: "tor1_" + "a".repeat(32) }, { call_ref: ref, offset: 5 }, { call_ref: ref, max_bytes: 10 },
      { call_ref: ref, section: "other" }, { call_ref: ref, extra: true }]) {
      const source = reader(record());
      expect(value(await executeReadToolCall(source, call(args), actor))).toMatchObject({ code: "tool_call_selector_invalid" });
      expect(source.read).not.toHaveBeenCalled();
    }
    const failing: ToolCallReader = { read: vi.fn(async () => { throw new Error("connection reset"); }) };
    expect(value(await executeReadToolCall(failing, call({ call_ref: ref }), actor))).toMatchObject({ code: "tool_call_reader_busy" });
  });

  it("shortens a read to its batch's room and defers it below a minimum page", async () => {
    const text = "x".repeat(6000);
    const source = reader(record({ arguments: { state: "available", text } }));
    const spend = vi.fn();
    const limited = await executeReadToolCall(source, call({ call_ref: ref, section: "arguments" }), actor, undefined,
      { fits: result => JSON.stringify(result).length < 3000, spend });
    expect((value(limited).arguments as { fragment: string }).fragment.length).toBeLessThan(3000);
    expect(spend).toHaveBeenCalledOnce();
    const deferred = await executeReadToolCall(source, call({ call_ref: ref, section: "arguments" }), actor, undefined,
      { fits: () => false, spend });
    expect(value(deferred)).toMatchObject({ code: "tool_call_read_deferred" });
    expect(spend).toHaveBeenCalledOnce();
  });

  it("settles a content-free receipt whose hash identifies the output", async () => {
    const read = await executeReadToolCall(reader(record()), call({ call_ref: ref }), actor);
    const receipt = readToolCallReceipt(call({ call_ref: ref }), read);
    expect(JSON.stringify(receipt)).not.toContain("fifth");
    expect(JSON.stringify(receipt)).not.toContain("created #5");
    expect(receipt.content).toEqual([{ type: "json", value: { receipt: expect.objectContaining({ version: 1, call_ref: ref,
      section: "card", offset: 0, max_bytes: READ_TOOL_CALL_LIMITS.pageBytes }) } }]);
    const again = readToolCallReceipt(call({ call_ref: ref }), await executeReadToolCall(reader(record()), call({ call_ref: ref }), actor));
    expect(readToolCallReceiptHash(again)).toBe(readToolCallReceiptHash(receipt));
    const changed = readToolCallReceipt(call({ call_ref: ref }), await executeReadToolCall(reader(record({ result: { state: "inline", text: "created #6" } })),
      call({ call_ref: ref }), actor));
    expect(readToolCallReceiptHash(changed)).not.toBe(readToolCallReceiptHash(receipt));
    expect(decodeReadToolCallArguments({ call_ref: ref })).toEqual({ callRef: ref, section: "card", offset: 0,
      maxBytes: READ_TOOL_CALL_LIMITS.pageBytes });
  });
});
