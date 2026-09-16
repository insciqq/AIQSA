import { describe, expect, it } from "vitest";
import { CodexJsonlDecoder, type CodexEvent } from "./codexProtocol";

const encoder = new TextEncoder();
const start = [
  { type: "thread.started", thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53" },
  { type: "turn.started" }
];
const complete = { type: "turn.completed", usage: { input_tokens: 999, output_tokens: 1 } };
const jsonl = (events: readonly unknown[]) => encoder.encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n");

describe("Codex exec JSONL transport", () => {
  it("reassembles UTF-8 and complete records from arbitrary transport chunks", () => {
    const decoder = new CodexJsonlDecoder();
    const bytes = jsonl([...start, { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Отчёт 🧪 готов" } }, complete]);
    const events: CodexEvent[] = [];
    for (const byte of bytes) events.push(...decoder.push(Uint8Array.of(byte)));
    expect(decoder.finish(0)).toEqual([]);
    expect(events).toEqual([
      { type: "thread_started", threadId: start[0].thread_id },
      { type: "turn_started" },
      { type: "message", id: "item_1", text: "Отчёт 🧪 готов" },
      { type: "turn_completed" }
    ]);
  });

  it("selects private action facts without reasoning, raw arguments, results or guest usage", () => {
    const decoder = new CodexJsonlDecoder();
    const events = decoder.push(jsonl([...start,
      { type: "item.completed", item: { id: "i0", type: "reasoning", text: "private-reasoning" } },
      { type: "item.started", item: { id: "i1", type: "command_execution", command: "secret-command", status: "in_progress" } },
      { type: "item.completed", item: { id: "i1", type: "command_execution", aggregated_output: "secret-output", status: "completed", exit_code: 1 } },
      { type: "item.completed", item: { id: "i2", type: "mcp_tool_call", arguments: { key: "secret-argument" }, result: "private-result", status: "completed" } },
      { type: "item.completed", item: { id: "i3", type: "file_change", changes: [{ path: "private-path", kind: "update" }], status: "completed" } },
      complete
    ]));
    decoder.finish(0);
    expect(events.filter((event) => event.type === "activity")).toEqual([
      { type: "activity", id: "i1", kind: "command", phase: "running", command: "secret-command" },
      { type: "activity", id: "i1", kind: "command", phase: "failed", output: "secret-output", exitCode: 1 },
      { type: "activity", id: "i2", kind: "mcp", phase: "succeeded" },
      { type: "activity", id: "i3", kind: "file_change", phase: "succeeded", changes: [{ path: "private-path", action: "update" }] }
    ]);
    expect(JSON.stringify(events)).not.toMatch(/private-reasoning|secret-argument|private-result|input_tokens|999/u);
  });

  it("publishes completed messages once, rather than repeating partial item snapshots", () => {
    const decoder = new CodexJsonlDecoder();
    const events = decoder.push(jsonl([...start,
      { type: "item.started", item: { id: "i1", type: "agent_message", text: "" } },
      { type: "item.updated", item: { id: "i1", type: "agent_message", text: "Par" } },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "Partial answer" } }, complete
    ]));
    expect(events.filter((event) => event.type === "message")).toEqual([{ type: "message", id: "i1", text: "Partial answer" }]);
    decoder.finish(0);
  });

  it("accepts a terminal record without a final newline and recovers informational errors", () => {
    const decoder = new CodexJsonlDecoder();
    decoder.push(jsonl([...start, { type: "error", message: "private upstream details" }, { type: "future.informational", secret: "hidden" }]));
    decoder.push(encoder.encode(JSON.stringify(complete)));
    expect(decoder.finish(0)).toEqual([{ type: "turn_completed" }]);
  });

  it("accepts real exec setup diagnostics before turn.started without publishing their contents", () => {
    const decoder = new CodexJsonlDecoder();
    const events = decoder.push(jsonl([
      start[0],
      { type: "item.completed", item: { id: "item_0", type: "error", message: "private configuration detail" } },
      start[1], complete
    ]));
    expect(events).toContainEqual({ type: "runtime_error" });
    expect(JSON.stringify(events)).not.toContain("private");
    expect(decoder.finish(0)).toEqual([]);
  });

  it("cannot resume parsing after corruption and later declare the run successful", () => {
    const decoder = new CodexJsonlDecoder();
    expect(() => decoder.push(encoder.encode("not json\n"))).toThrow("agent_protocol_invalid");
    expect(() => decoder.push(jsonl([...start, complete]))).toThrow("agent_protocol_invalid");
    expect(() => decoder.finish(0)).toThrow("agent_protocol_invalid");
  });

  it.each([null, 1, 137])("requires observed zero exit even after turn.completed (exit %s)", (exit) => {
    const decoder = new CodexJsonlDecoder();
    decoder.push(jsonl([...start, complete]));
    expect(() => decoder.finish(exit)).toThrow("agent_process_failed");
  });

  it("rejects missing terminals, failed turns, malformed order and conflicting terminals", () => {
    const incomplete = new CodexJsonlDecoder();
    incomplete.push(jsonl(start));
    expect(() => incomplete.finish(0)).toThrow("agent_protocol_incomplete");
    const failed = new CodexJsonlDecoder();
    failed.push(jsonl([...start, { type: "turn.failed", error: { message: "secret error" } }]));
    expect(() => failed.finish(1)).toThrow("agent_turn_failed");
    expect(() => new CodexJsonlDecoder().push(jsonl([complete]))).toThrow("agent_protocol_invalid");
    expect(() => new CodexJsonlDecoder().push(jsonl([...start, complete, complete]))).toThrow("agent_protocol_invalid");
  });

  it("selects native queries for the masked projection without raw results", () => {
    const decoder = new CodexJsonlDecoder();
    const events = decoder.push(jsonl([...start, { type: "item.completed", item: {
      id: "search_1", type: "web_search", query: "private query", result: "private result"
    } }, complete]));
    expect(events).toContainEqual({ type: "activity", id: "search_1", kind: "search", phase: "succeeded", query: "private query" });
    expect(JSON.stringify(events)).not.toContain("private result");
    decoder.finish(0);
  });

  it.each(["{broken\n", "[]\n", '{"type":"thread.started","thread_id":"../../other"}\n'])
    ("rejects malformed input with a content-free error", (input) => {
      expect(() => new CodexJsonlDecoder().push(encoder.encode(input))).toThrow(/^agent_protocol_invalid$/u);
    });

  it("rejects invalid UTF-8 instead of replacing bytes", () => {
    expect(() => new CodexJsonlDecoder().push(Uint8Array.of(0xff, 10))).toThrow("agent_protocol_invalid");
  });

  it("bounds unterminated lines, cumulative output and record count without truncating", () => {
    const line = new CodexJsonlDecoder({ lineBytes: 8, totalBytes: 1000, records: 10 });
    line.push(encoder.encode("1234"));
    expect(() => line.push(encoder.encode("56789"))).toThrow("agent_output_limit_exceeded");
    const total = new CodexJsonlDecoder({ lineBytes: 1000, totalBytes: 8, records: 10 });
    expect(() => total.push(encoder.encode("         "))).toThrow("agent_output_limit_exceeded");
    const count = new CodexJsonlDecoder({ lineBytes: 1000, totalBytes: 1000, records: 1 });
    expect(() => count.push(jsonl(start))).toThrow("agent_output_limit_exceeded");
  });
});
