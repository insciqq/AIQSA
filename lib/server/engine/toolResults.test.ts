import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../uploads/storage";
import { describe, expect, it, vi } from "vitest";
import {
  createSavedToolResultReader,
  executeReadToolResult,
  saveToolResultText,
  TOOL_RESULT_LIMITS,
  toolModelOutput,
  toolOutputExcerpt,
  toolResultOutputText,
  type SavedToolResultReader
} from "./toolResults";
import { resultLength } from "./compaction/retained";
import { quoteIsIn } from "../research/quoteCheck";
import { proseFindings, searchEngine, searchResult, threeEngineResult } from "../search/toolResult.testFixtures";
import type { ToolExecutionResult } from "../tools/types";

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
    // An MCP result goes with the accepted source the store rechecks before it publishes (issue #50).
    const sourceBinding = { fingerprint: "f".repeat(64), originalName: "get_issue", revisionId: "rev", serverId: "jira",
      source: "mcp", version: 1 } as const;
    await saveToolResultText({ outcome: "complete", producer: { runId: "r", toolCallId: "c", userId: "u" },
      service: service as never, source: "mcp", sourceBinding, text: "long" });
    expect(service.withReservation).toHaveBeenLastCalledWith(expect.objectContaining({ source: "mcp", sourceBinding }), expect.any(Function));
    const busy = { withReservation: vi.fn(async () => { throw Object.assign(new Error("busy"), { code: "tool_observation_busy" }); }) };
    await expect(saveToolResultText({ outcome: "complete", producer: { runId: "r", toolCallId: "c", userId: "u" },
      service: busy as never, source: "mcp", text: "long" })).resolves.toEqual({ unsavedReason: "tool_observation_busy" });
  });
});

describe("the model's view of a result", () => {
  const textOf = (result: ToolExecutionResult) => toolResultOutputText(result);
  const view = (result: ToolExecutionResult, saved: Parameters<typeof toolOutputExcerpt>[1] = { handle }) =>
    toolModelOutput(result, textOf(result), toolOutputExcerpt(textOf(result), saved));

  it("gives a long merged search result a fair share of each engine, names the handle, and keeps the whole length readable", () => {
    const result = threeEngineResult();
    const text = textOf(result);
    const output = view(result);
    expect(output).not.toBe(toolOutputExcerpt(text, { handle }).output);
    for (const name of ["OpenAI", "Perplexity", "DeepSeek"]) expect(output).toContain(`Search source "${name}":\n`);
    expect(output).toMatch(new RegExp(`\\[\\d+ of ${text.length} characters omitted here: each search source keeps a share`, "u"));
    expect(output.endsWith(`call read_tool_result with handle "${handle}" and the offset a note names, or 0 (limit up to ` +
      `${TOOL_RESULT_LIMITS.readChars}), to read it.]`)).toBe(true);
    expect(output.length).toBeLessThan(TOOL_RESULT_LIMITS.headChars + TOOL_RESULT_LIMITS.tailChars + 1_500);
    // A compaction stub and summary name the whole result's length, not the view's.
    expect(resultLength(output)).toBe(text.length);
    expect(view(threeEngineResult())).toBe(output);
  });

  it("lets a quote from the visible part check against the saved text", () => {
    const result = threeEngineResult();
    const output = view(result);
    const entry = /\[6\] DeepSeek source 6 — shop-6\.example\nEntry 6 says model M-6 costs 1006 EUR\./u.exec(output)![0];
    expect(quoteIsIn("Entry 6 says model M-6 costs 1006 EUR.", textOf(result))).toBe(true);
    expect(textOf(result)).toContain(entry);
    const perplexity = /Perplexity paragraph 18 reports finding 18 with care \[6\]\./u.exec(output)![0];
    expect(quoteIsIn(perplexity, textOf(result))).toBe(true);
  });

  it("passes a short result whole and keeps head and tail for a single engine, an unsaved result and any other tool", () => {
    const short = searchResult([
      searchEngine({ count: 2, displayName: "A", findings: proseFindings("A", 2_000, 2), host: "a.example", optionId: "a" }),
      searchEngine({ count: 2, displayName: "B", findings: proseFindings("B", 2_000, 2), host: "b.example", optionId: "b" })
    ]);
    expect(view(short)).toBe(textOf(short));
    const single = searchResult([searchEngine({ count: 4, displayName: "A", findings: proseFindings("A", 40_000, 4), host: "a.example",
      optionId: "a" })]);
    expect(view(single)).toBe(toolOutputExcerpt(textOf(single), { handle }).output);
    const merged = threeEngineResult();
    const unsaved = { unsavedReason: "saved_results_budget_reached" };
    expect(view(merged, unsaved)).toBe(toolOutputExcerpt(textOf(merged), unsaved).output);
    const other: ToolExecutionResult = { callId: "c", content: [{ text: textOf(merged), type: "text" }], name: "workspace_shell", status: "complete" };
    expect(view(other)).toBe(toolOutputExcerpt(textOf(merged), { handle }).output);
  });
});

describe("read_tool_result", () => {
  const context = (text: string | null) => ({ chatId: "chat", reader: reader(text), userId: "user" });

  // Review finding: a default read of a long result was itself cut into an excerpt and saved again.
  it("returns a read that fits whole and names where to continue", async () => {
    const saved = "line of \"quoted\" text\n".repeat(4_000);
    let offset: number | null = TOOL_RESULT_LIMITS.headChars;
    let read = "";
    for (let step = 0; step < 10 && offset !== null; step += 1) {
      const result = await executeReadToolResult(call({ handle, offset }), context(saved));
      const output = toolResultOutputText(result);
      expect(output.length).toBeLessThanOrEqual(TOOL_RESULT_LIMITS.inlineChars);
      expect(toolOutputExcerpt(output, { handle }).truncated).toBe(false);
      const value = json(result) as { nextOffset: number | null; text: string };
      read += value.text;
      offset = value.nextOffset;
    }
    expect(read).toBe(saved.slice(TOOL_RESULT_LIMITS.headChars));
  });

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


it("does not carry a saved-result handle into Continue in new chat", async () => {
  const findFirst = vi.fn(async ({ where }: { where: { modelRun: { chatId: string; userId: string } } }) =>
    where.modelRun.chatId === "original" && where.modelRun.userId === "owner" ? {
      byteSize: 32, checksum: "a".repeat(64), formatVersion: 1, inlineText: JSON.stringify("Original result"), maskable: false,
      sourceKind: "workspace", sourceTruncated: false, state: "READY", storageKey: null, storageMode: "INLINE",
      toolCall: { arguments: {}, toolName: "read_chat_file" }
    } : null);
  const reader = createSavedToolResultReader({ prisma: { toolObservation: { findFirst } } as unknown as PrismaClient,
    storage: {} as unknown as StorageAdapter });
  expect(json(await executeReadToolResult(call({ handle }), { reader, chatId: "original", userId: "owner" }))?.text).toBe("Original result");
  expect(json(await executeReadToolResult(call({ handle }), { reader, chatId: "continued", userId: "owner" }))?.error).toBe("tool_result_not_found");
  expect(json(await executeReadToolResult(call({ handle }), { reader, chatId: "original", userId: "other" }))?.error).toBe("tool_result_not_found");
});
