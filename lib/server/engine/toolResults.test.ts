import { describe, expect, it, vi } from "vitest";
import {
  executeReadToolResult,
  saveToolResultText,
  TOOL_RESULT_LIMITS,
  toolOutputExcerpt,
  toolResultOutputText,
  type SavedToolResultReader
} from "./toolResults";

const handle = `tor1_${"a".repeat(32)}`;
const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_1", name: "read_tool_result" });

function reader(text: string | null): SavedToolResultReader {
  return { read: vi.fn(async () => text === null ? null : { arguments: { command: "ls" }, text, toolName: "workspace_shell" }) };
}

function json(result: Awaited<ReturnType<typeof executeReadToolResult>>) {
  const part = result.content[0];
  return part?.type === "json" ? part.value as Record<string, unknown> : null;
}

describe("tool result excerpts", () => {
  it("joins a result's parts as the bridges do", () => {
    expect(toolResultOutputText({ content: [{ text: "a", type: "text" }, { type: "json", value: { b: 1 } }] })).toBe("a\n\n{\"b\":1}");
  });

  it("keeps a result within the bound whole, with the handle it was saved under", () => {
    const text = "x".repeat(TOOL_RESULT_LIMITS.inlineChars);
    expect(toolOutputExcerpt(text, null)).toEqual({ handle: null, output: text, truncated: false });
    expect(toolOutputExcerpt(text, { handle })).toEqual({ handle, output: text, truncated: false });
    expect(toolOutputExcerpt(text, { unsavedReason: "storage_unavailable" })).toEqual({ handle: null, output: text, truncated: false });
  });

  it("gives head, tail and the handle of a longer saved result, and says when it could not be saved", () => {
    const text = `${"h".repeat(TOOL_RESULT_LIMITS.headChars)}${"Z".repeat(50_000)}${"t".repeat(TOOL_RESULT_LIMITS.tailChars)}`;
    const saved = toolOutputExcerpt(text, { handle });
    expect(saved.handle).toBe(handle);
    expect(saved.output.startsWith("h".repeat(TOOL_RESULT_LIMITS.headChars))).toBe(true);
    expect(saved.output.endsWith("t".repeat(TOOL_RESULT_LIMITS.tailChars))).toBe(true);
    expect(saved.output).not.toContain("Z");
    expect(saved.output).toContain(`handle "${handle}" and offset ${TOOL_RESULT_LIMITS.headChars}`);
    const unsaved = toolOutputExcerpt(text, { unsavedReason: "saved_results_budget_reached" });
    expect(unsaved.handle).toBeNull();
    expect(unsaved.output).toContain("could not be saved (saved_results_budget_reached)");
  });

  it("saves once through the observation store, and reports why nothing was kept", async () => {
    const store = vi.fn(async () => ({ observation: { handle } }));
    const service = { withReservation: vi.fn(async (_options: unknown, work: (receipt: unknown) => Promise<unknown>) =>
      work({ recordUnretained: vi.fn(), retained: true, store })) };
    await expect(saveToolResultText({ outcome: "complete", producer: { runId: "r", toolCallId: "c", userId: "u" },
      service: service as never, source: "workspace", text: "long" })).resolves.toEqual({ handle });
    expect(store).toHaveBeenCalledWith({ maskable: false, original: "long", outcome: "complete", sourceTruncated: false });
    const busy = { withReservation: vi.fn(async () => { throw Object.assign(new Error("busy"), { code: "tool_observation_busy" }); }) };
    await expect(saveToolResultText({ outcome: "complete", producer: { runId: "r", toolCallId: "c", userId: "u" },
      service: busy as never, source: "mcp", text: "long" })).resolves.toEqual({ unsavedReason: "tool_observation_busy" });
  });
});

describe("read_tool_result", () => {
  const context = (text: string | null) => ({ chatId: "chat", reader: reader(text), userId: "user" });

  it("returns the call's tool and arguments with the requested part and where to continue", async () => {
    const result = await executeReadToolResult(call({ handle, limit: 4, offset: 2 }), context("abcdefghij"));
    expect(result.status).toBe("complete");
    expect(json(result)).toEqual({ arguments: { command: "ls" }, handle, nextOffset: 6, offset: 2, text: "cdef",
      tool: "workspace_shell", totalCharacters: 10 });
  });

  it("names the bound a read violates", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ handle: "nope" }, "handle_invalid"],
      [{ handle, offset: -1 }, "offset_invalid"],
      [{ handle, limit: TOOL_RESULT_LIMITS.readChars + 1 }, "limit_out_of_range"],
      [{ handle, limit: 0 }, "limit_out_of_range"],
      [{ handle, offset: 11 }, "offset_out_of_range"],
      [{ handle, query: "x" }, "arguments_invalid"]
    ];
    for (const [args, code] of cases) {
      const result = await executeReadToolResult(call(args), context("abcdefghij"));
      expect(result.status).toBe("error");
      expect(json(result)?.error).toBe(code);
    }
    expect(json(await executeReadToolResult(call({ handle, offset: 11 }), context("abcdefghij")))?.message)
      .toContain("past the end of this result (10 characters)");
  });

  it("looks only in the same user's chat", async () => {
    const result = await executeReadToolResult(call({ handle }), context(null));
    expect(json(result)?.error).toBe("tool_result_not_found");
  });
});
