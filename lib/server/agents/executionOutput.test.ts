import { describe, expect, it } from "vitest";
import { AgentExecutionOutput } from "./executionOutput";
import { CodexJsonlDecoder, type CodexEvent } from "./codexProtocol";

describe("private agent output transport", () => {
  it("replays a lost poll without loss, then releases acknowledged bytes", () => {
    const output = new AgentExecutionOutput({ pageBytes: 3, pendingBytes: 6, totalBytes: 100 });
    output.stdout(Buffer.from("abcdef"));
    const first = output.poll(0);
    expect(Buffer.from(first.stdoutBase64, "base64").toString()).toBe("abc");
    expect(output.poll(0)).toEqual(first);
    expect(output.poll(3).nextCursor).toBe(6);
    output.stdout(Buffer.from("ghi"));
    expect(() => output.poll(0)).toThrow("agent_output_cursor_invalid");
    output.end(0);
    expect(output.poll(3)).toMatchObject({ done: false, exitCode: null, nextCursor: 6 });
    expect(output.poll(6)).toMatchObject({ done: true, exitCode: 0, nextCursor: 9 });
    expect(Buffer.from(output.poll(6).stdoutBase64, "base64").toString()).toBe("ghi");
  });

  it("delivers every byte before reporting exit, including split multibyte characters", () => {
    const output = new AgentExecutionOutput({ pageBytes: 1, pendingBytes: 1000, totalBytes: 1000 });
    const source = [
      { type: "thread.started", thread_id: "test-thread" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "i1", type: "agent_message", text: "Готово 🧪" } },
      { type: "turn.completed" }
    ].map((event) => JSON.stringify(event)).join("\n");
    for (const byte of Buffer.from(source)) output.stdout(Uint8Array.of(byte));
    output.stderr(Buffer.from("private upstream error detail"));
    output.end(0);
    const decoder = new CodexJsonlDecoder();
    const events: CodexEvent[] = [];
    let cursor = 0;
    for (;;) {
      const page = output.poll(cursor);
      events.push(...decoder.push(Buffer.from(page.stdoutBase64, "base64")));
      cursor = page.nextCursor;
      if (page.done) {
        events.push(...decoder.finish(page.exitCode));
        break;
      }
    }
    expect(events).toContainEqual({ type: "message", id: "i1", text: "Готово 🧪" });
    expect(events.at(-1)).toEqual({ type: "turn_completed" });
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("rejects cursors that skip unoffered output or rewind acknowledged output", () => {
    const output = new AgentExecutionOutput({ pageBytes: 2, pendingBytes: 10, totalBytes: 100 });
    output.stdout(Buffer.from("abcdef"));
    for (const cursor of [-1, 0.5, NaN, Infinity, 1, 7]) {
      expect(() => output.poll(cursor)).toThrow("agent_output_cursor_invalid");
    }
    output.poll(0);
    expect(() => output.poll(3)).toThrow("agent_output_cursor_invalid");
    output.poll(2);
    expect(() => output.poll(0)).toThrow("agent_output_cursor_invalid");
  });

  it("fails on backlog overflow rather than dropping old bytes", () => {
    const output = new AgentExecutionOutput({ pageBytes: 2, pendingBytes: 3, totalBytes: 100 });
    output.stdout(Buffer.from("abc"));
    output.poll(0);
    expect(() => output.stdout(Buffer.from("d"))).toThrow("agent_output_limit_exceeded");
    expect(() => output.poll(2)).toThrow("agent_output_limit_exceeded");
  });

  it("bounds stderr and total output even when the client acknowledges everything", () => {
    const output = new AgentExecutionOutput({ pageBytes: 5, pendingBytes: 5, totalBytes: 8 });
    output.stdout(Buffer.from("abcde"));
    output.poll(0);
    output.poll(5);
    expect(() => output.stderr(Buffer.from("secret"))).toThrow("agent_output_limit_exceeded");
  });

  it.each([-1, null, 999])("does not turn an unknown process exit (%s) into success", (code) => {
    const output = new AgentExecutionOutput();
    output.end(code);
    expect(output.poll(0)).toMatchObject({ done: true, exitCode: null });
  });
});
