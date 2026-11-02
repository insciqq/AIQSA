import { describe, expect, it } from "vitest";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME, RESEARCHER_CONTEXT_CLEARING } from "../../../contracts/research";
import { CALL_SUBAGENT_TOOL_NAME } from "../../../contracts/subagents";
import { anthropicMessagesFromHistory } from "../../providers/anthropicMessagesHistory";
import { chatMessagesFromHistory, responsesInputFromHistory } from "../../providers/history";
import { BROWSER_HANDOFF_TOOL_NAME } from "../../tools/browserHandoff";
import { FETCH_URL_TOOL_NAME } from "../../tools/fetchUrlPlan";
import { LOAD_SKILL_TOOL_NAME } from "../../tools/skill";
import { UPDATE_PLAN_TOOL_NAME } from "../../tools/updatePlan";
import { namespacedWorkspaceToolName } from "../../workspace/toolCatalog";
import { measureContext } from "../contextMeasure";
import { HARNESS_SEARCH_TOOL } from "../prompts/harness";
import { READ_TOOL_RESULT_NAME, toolOutputExcerpt } from "../toolResults";
import { projectTranscript, type TranscriptItem, type TranscriptTarget, type TranscriptToolResultItem } from "../transcript";
import { decodeTranscriptItem, encodeTranscriptItem, TranscriptItemInvalidError } from "../transcriptCodec";
import { CLEARED_RESULT_HEADING, CLEARING_PRODUCT_TOOLS, pageBearingCall, planToolResultClearing } from "./clearing";
import { CODEX, charTokens, handleFor, transcriptBuilder } from "./compaction.testFixtures";
import { buildStateBlock } from "./retained";

/** A low mark above zero, so the planner's "only as many as it takes" shows; the researchers' own policy clears to zero and has its test below. */
const POLICY = Object.freeze({ clearAboveTokens: 60_000, clearAtLeastTokens: 10_000, clearToTokens: 25_000, keepRecentResults: 3 });
const ANTHROPIC: TranscriptTarget = { model: "claude-fable-5", provider: "anthropic-main", reasoningScope: "current_turn" };
const CHAT: TranscriptTarget = { model: "deepseek-v4", provider: "openrouter" };

const page = (index: number, size: number) => `page ${index} ${"p".repeat(size)}`;

/** A researcher's thread: its brief, then `count` page reads of `size` characters, each saved with its handle. */
function researcher(count: number, size: number) {
  const chat = transcriptBuilder();
  chat.user(`Brief: compare mattresses.\n\n# Research method (from the server)\n${"m".repeat(800)}`);
  const pages: string[] = [];
  for (let index = 1; index <= count; index += 1) pages.push(fetched(chat, index, page(index, size)));
  return { chat, pages };
}

/** A fetch_url call and its result saved under the call's handle; returns the call id. */
function fetched(chat: ReturnType<typeof transcriptBuilder>, index: number, output: string): string {
  const callId = chat.call(FETCH_URL_TOOL_NAME, { url: `https://shop.example/item-${index}` });
  chat.items.push({ callId, handle: handleFor(callId), id: chat.nextId(), kind: "tool_result", name: FETCH_URL_TOOL_NAME, outcome: "complete", output });
  return callId;
}

const tokensOf = (items: readonly TranscriptItem[], target: TranscriptTarget = CODEX) =>
  measureContext({ estimate: charTokens, fixedTokens: 0, items, target }).tokens;

let stubIds = 0;

function plan(items: readonly TranscriptItem[], target: TranscriptTarget = CODEX, policy = POLICY) {
  return planToolResultClearing({ estimate: charTokens, items, nextId: () => `stub-${++stubIds}`, policy, target, tokens: tokensOf(items, target) });
}

/** The output each call's result has in a request to `target`. */
function outputs(items: readonly TranscriptItem[], target: TranscriptTarget = CODEX): Map<string, string> {
  return new Map(projectTranscript(items, target).flatMap((item) => item.type === "tool_result" ? [[item.callId, item.output] as const] : []));
}

describe("which results bear pages", () => {
  it("names the product tools exactly as their owners do", () => {
    expect(CLEARING_PRODUCT_TOOLS.fetchUrl).toBe(FETCH_URL_TOOL_NAME);
    expect(CLEARING_PRODUCT_TOOLS.search.source).toBe(HARNESS_SEARCH_TOOL.source);
  });

  it("clears pages, Search results, Workspace and browser output and re-read results, and nothing an agent wrote or was told", () => {
    const bears = (name: string) => pageBearingCall({ arguments: "{}", name });
    for (const name of [FETCH_URL_TOOL_NAME, "search_selected_engines", "search_engine_2", READ_TOOL_RESULT_NAME,
      namespacedWorkspaceToolName("sandbox_exec"), namespacedWorkspaceToolName("sandbox_shell"), namespacedWorkspaceToolName("sandbox_exec_start"),
      namespacedWorkspaceToolName("sandbox_exec_poll"), namespacedWorkspaceToolName("sandbox_fs_read"), "sandbox_exec"]) expect(bears(name), name).toBe(true);
    for (const name of [RECORD_EVIDENCE_TOOL_NAME, CHANGE_RESEARCH_FRAME_TOOL_NAME, CALL_SUBAGENT_TOOL_NAME, LOAD_SKILL_TOOL_NAME, UPDATE_PLAN_TOOL_NAME,
      BROWSER_HANDOFF_TOOL_NAME, namespacedWorkspaceToolName("sandbox_fs_write"), "mcp_jira_get_issue_0123456789", "search_engine_4"]) {
      expect(bears(name), name).toBe(false);
    }
  });
});

describe("clearing old page results", () => {
  it("does nothing up to the high mark", () => {
    const { chat } = researcher(5, 10_000);
    expect(tokensOf(chat.items)).toBeLessThanOrEqual(POLICY.clearAboveTokens);
    expect(plan(chat.items)).toBeNull();
  });

  it("clears the oldest pages first, in one step, down to the low mark, and keeps the newest whole", () => {
    const { chat, pages } = researcher(20, 5_000);
    const before = tokensOf(chat.items);
    expect(before).toBeGreaterThan(POLICY.clearAboveTokens);
    const cleared = plan(chat.items)!;
    const stubs = cleared.items;
    // The oldest ones, in order, and only as many as it takes.
    expect(stubs.map((stub) => stub.callId)).toEqual(pages.slice(0, stubs.length));
    const after = tokensOf([...chat.items, ...stubs]);
    expect(after).toBeLessThanOrEqual(POLICY.clearToTokens);
    expect(tokensOf([...chat.items, ...stubs.slice(0, -1)])).toBeGreaterThan(POLICY.clearToTokens);
    expect(cleared.freedTokens).toBe(before - after);
    expect(stubs.length).toBeLessThanOrEqual(pages.length - POLICY.keepRecentResults);
    // Each stub names the tool, its target, the size and the read that brings it back, and stays a complete result of its call.
    expect(new Set(stubs.map((stub) => stub.id)).size).toBe(stubs.length);
    expect(stubs[0]).toEqual({ callId: pages[0], cleared: true, handle: handleFor(pages[0]!), id: stubs[0]!.id, kind: "tool_result", name: FETCH_URL_TOOL_NAME,
      outcome: "complete", output: `${CLEARED_RESULT_HEADING}5,007 characters of fetch_url url="https://shop.example/item-1". ` +
        `Nothing is lost: call read_tool_result with {"handle":"${handleFor(pages[0]!)}"} to read it again.]` });
    const replayed = outputs([...chat.items, ...stubs]);
    for (const [index, callId] of pages.entries()) {
      expect(replayed.get(callId)).toBe(index < stubs.length ? stubs[index]!.output : page(index + 1, 5_000));
    }
  });

  it("clears every old page in one step with the researchers' zero target, keeps the newest 3 whole, and then waits for the trigger again", () => {
    const policy = RESEARCHER_CONTEXT_CLEARING;
    expect(policy).toMatchObject({ clearAboveTokens: 100_000, clearToTokens: 0, keepRecentResults: 3 });
    expect(plan(researcher(15, 5_000).chat.items, CODEX, policy)).toBeNull();
    const { chat, pages } = researcher(25, 5_000);
    expect(tokensOf(chat.items)).toBeGreaterThan(policy.clearAboveTokens);
    const cleared = plan(chat.items, CODEX, policy)!;
    expect(cleared.items.map((stub) => stub.callId)).toEqual(pages.slice(0, -policy.keepRecentResults));
    const replayed = outputs([...chat.items, ...cleared.items]);
    pages.slice(-policy.keepRecentResults).forEach((callId, index) => expect(replayed.get(callId)).toBe(page(23 + index, 5_000)));
    // Nothing is left to clear until the context passes the trigger again, so the cache misses once per clearing.
    expect(tokensOf([...chat.items, ...cleared.items])).toBeLessThan(policy.clearAboveTokens / 4);
    expect(plan([...chat.items, ...cleared.items], CODEX, policy)).toBeNull();
  });

  it("keeps the newest pages whole even when that leaves the context above the low mark", () => {
    const { chat, pages } = researcher(8, 10_000);
    const stubs = plan(chat.items)!.items;
    expect(stubs.map((stub) => stub.callId)).toEqual(pages.slice(0, 8 - POLICY.keepRecentResults));
    expect(tokensOf([...chat.items, ...stubs])).toBeGreaterThan(POLICY.clearToTokens);
    // Nothing more to clear: the next step clears nothing until a page ages, so the cache is not missed at every step.
    expect(plan([...chat.items, ...stubs])).toBeNull();
  });

  it("waits while what it may clear frees less than a clearing is worth", () => {
    const { chat } = researcher(2, 1_000);
    const big = fetched(chat, 3, page(3, 30_000));
    fetched(chat, 4, page(4, 30_000));
    fetched(chat, 5, page(5, 30_000));
    expect(tokensOf(chat.items)).toBeGreaterThan(POLICY.clearAboveTokens);
    expect(plan(chat.items)).toBeNull();
    // One more page ages the first large one out of the newest, and it is cleared then.
    fetched(chat, 6, page(6, 1_000));
    expect(plan(chat.items)!.items.map((stub) => stub.callId)).toContain(big);
  });

  it("clears a single result larger than the low mark in one step, and keeps one while it is among the newest", () => {
    const old = researcher(0, 0);
    const huge = fetched(old.chat, 1, page(1, 70_000));
    for (let index = 2; index <= 4; index += 1) fetched(old.chat, index, page(index, 1_000));
    const cleared = plan(old.chat.items)!;
    expect(cleared.items.map((stub) => stub.callId)).toEqual([huge]);
    expect(tokensOf([...old.chat.items, ...cleared.items])).toBeLessThanOrEqual(POLICY.clearToTokens);
    expect(cleared.items[0]!.output).toContain("70,007 characters of fetch_url");

    const recent = researcher(4, 1_000);
    fetched(recent.chat, 5, page(5, 70_000));
    expect(tokensOf(recent.chat.items)).toBeGreaterThan(POLICY.clearAboveTokens);
    expect(plan(recent.chat.items)).toBeNull();
  });

  it("counts a Search result as a page and names its whole size, not its excerpt's", () => {
    const { chat } = researcher(0, 0);
    const handle = handleFor("search");
    const search = chat.call("search_selected_engines", { query: "матрас 180x200 латекс" });
    const excerpt = toolOutputExcerpt(`results ${"r".repeat(74_992)}`, { handle });
    chat.items.push({ callId: search, handle, id: chat.nextId(), kind: "tool_result", name: "search_selected_engines", outcome: "complete", output: excerpt.output });
    for (let index = 1; index <= 5; index += 1) fetched(chat, index, page(index, 12_000));
    const stub = plan(chat.items)!.items[0]!;
    expect(stub).toMatchObject({ callId: search, handle });
    expect(stub.output).toContain(`75,000 characters of search_selected_engines query="матрас 180x200 латекс"`);
  });

  it("brings a re-read saved result back with the same read, since it has no handle of its own", () => {
    const { chat } = researcher(0, 0);
    const saved = handleFor("saved");
    const read = chat.call(READ_TOOL_RESULT_NAME, { handle: saved, limit: 24_000, offset: 24_000 });
    chat.result(read, READ_TOOL_RESULT_NAME, JSON.stringify({ handle: saved, nextOffset: 48_000, offset: 24_000, text: "r".repeat(23_800) }));
    for (let index = 1; index <= 5; index += 1) fetched(chat, index, page(index, 12_000));
    const stub = plan(chat.items)!.items[0]!;
    expect(stub.callId).toBe(read);
    expect(stub).not.toHaveProperty("handle");
    expect(stub.output).toContain(`call read_tool_result with {"handle":"${saved}","offset":24000,"limit":24000} to read it again.]`);
  });

  it("never clears what cannot be read back, a failed or unknown result, the agent's own records, or what is already a stub", () => {
    const { chat } = researcher(0, 0);
    const unsaved = chat.tool(FETCH_URL_TOOL_NAME, { url: "https://shop.example/unsaved" }, page(0, 15_000));
    const failed = chat.call(FETCH_URL_TOOL_NAME, { url: "https://shop.example/failed" });
    chat.items.push({ callId: failed, handle: handleFor(failed), id: chat.nextId(), kind: "tool_result", name: FETCH_URL_TOOL_NAME, outcome: "error", output: page(0, 15_000) });
    const kept: string[] = [];
    for (const name of [RECORD_EVIDENCE_TOOL_NAME, CHANGE_RESEARCH_FRAME_TOOL_NAME, CALL_SUBAGENT_TOOL_NAME, LOAD_SKILL_TOOL_NAME]) {
      const callId = chat.call(name, { claim: "x" });
      chat.items.push({ callId, handle: handleFor(callId), id: chat.nextId(), kind: "tool_result", name, outcome: "complete", output: `${name} ${"w".repeat(15_000)}` });
      kept.push(callId);
    }
    const spoken = chat.answer(`I compared them. ${"a".repeat(5_000)}`);
    const pages = Array.from({ length: 6 }, (_, index) => fetched(chat, index + 1, page(index + 1, 9_000)));
    const first = plan(chat.items)!.items;
    expect(first.map((stub) => stub.callId)).toEqual(pages.slice(0, 3));
    for (const callId of [unsaved, failed, ...kept]) expect(first.some((stub) => stub.callId === callId)).toBe(false);
    const texts = new Map(chat.items.map((item) => [item.id, JSON.stringify(item)]));
    chat.items.push(...first);
    // Only results gained a later stub: every item before is as it was, the model's own words included.
    for (const [id, text] of texts) expect(JSON.stringify(chat.items.find((item) => item.id === id))).toBe(text);
    expect(outputs(chat.items).get(kept[0]!)).toContain(RECORD_EVIDENCE_TOOL_NAME);
    expect(projectTranscript(chat.items, CODEX).some((item) => item.type === "assistant_text" && item.text.startsWith("I compared them."))).toBe(true);
    expect(texts.has(spoken)).toBe(true);

    // Later pages: the stubs are not cleared again and do not count among the newest pages.
    const later = Array.from({ length: 4 }, (_, index) => fetched(chat, index + 7, page(index + 7, 9_000)));
    const second = plan(chat.items)!.items;
    expect(second.map((stub) => stub.callId)).toEqual([...pages.slice(3), later[0]]);
  });
});

describe("what replay and every adapter see", () => {
  /** Responses reasoning before each response, and two parallel calls in one response. */
  function withReasoning() {
    const { chat, pages } = researcher(0, 0);
    for (let index = 1; index <= 6; index += 1) {
      chat.reasoning();
      pages.push(fetched(chat, index, page(index, 12_000)));
    }
    chat.reasoning();
    const first = chat.call(FETCH_URL_TOOL_NAME, { url: "https://shop.example/a" });
    const second = chat.call(FETCH_URL_TOOL_NAME, { url: "https://shop.example/b" });
    for (const callId of [first, second]) {
      chat.items.push({ callId, handle: handleFor(callId), id: chat.nextId(), kind: "tool_result", name: FETCH_URL_TOOL_NAME, outcome: "complete", output: page(9, 12_000) });
    }
    return { chat, pages };
  }

  it("changes only the output text of cleared results: every call, its pairing and the reasoning stay, on Responses, Chat Completions and Anthropic", () => {
    const { chat } = withReasoning();
    const stubs = plan(chat.items)!.items;
    expect(stubs.length).toBeGreaterThan(0);
    const cleared = [...chat.items, ...stubs];
    const stubOf = new Map(stubs.map((stub) => [stub.callId, stub.output]));

    for (const target of [CODEX, CHAT, ANTHROPIC]) {
      const before = projectTranscript(chat.items, target);
      const after = projectTranscript(cleared, target);
      // Item for item the same, but for the outputs of the cleared results.
      expect(after.map((item) => item.type)).toEqual(before.map((item) => item.type));
      after.forEach((item, index) => {
        const was = before[index]!;
        if (item.type === "tool_result" && was.type === "tool_result" && stubOf.has(item.callId)) {
          expect({ ...item, output: was.output }).toEqual(was);
          expect(item.output).toBe(stubOf.get(item.callId));
        } else expect(item).toEqual(was);
      });
    }

    const responses = responsesInputFromHistory(projectTranscript(cleared, CODEX), { currentInput: (text) => [{ text, type: "input_text" }], preview: false });
    expect(responses.filter((item) => item.type === "reasoning")).toHaveLength(7);
    const callIds = responses.flatMap((item) => item.type === "function_call" ? [item.call_id] : []);
    expect(responses.flatMap((item) => item.type === "function_call_output" ? [item.call_id] : [])).toEqual(callIds);
    for (const [index, item] of responses.entries()) {
      if (item.type !== "function_call_output") continue;
      // A result follows its own response's calls, before anything else.
      const previous = responses.slice(0, index).reverse().find((entry) => entry.type !== "function_call_output");
      expect(previous?.type).toBe("function_call");
    }

    const messages = chatMessagesFromHistory(projectTranscript(cleared, CHAT), { currentInput: (text) => text, preview: false });
    for (const [index, message] of messages.entries()) {
      if (message.role !== "assistant" || !message.tool_calls) continue;
      const answered = messages.slice(index + 1, index + 1 + message.tool_calls.length);
      expect(answered.map((entry) => entry.role === "tool" ? entry.tool_call_id : null)).toEqual(message.tool_calls.map((call) => call.id));
    }

    // The Anthropic renderer refuses a history whose tool_use blocks are not answered in the next message.
    const anthropic = anthropicMessagesFromHistory(projectTranscript(cleared, ANTHROPIC), { currentInput: (text) => [{ text, type: "text" }],
      preview: false, thinkingPrefix: null, toolsDeclared: true });
    const results = anthropic.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
    expect(results.filter((block) => JSON.stringify(block).includes(CLEARED_RESULT_HEADING.slice(1, 20)))).toHaveLength(stubs.length);
  });

  it("records a stub as a complete result whose row decodes to the same item, so replay renders the same context", () => {
    const { chat } = withReasoning();
    const stubs = plan(chat.items)!.items;
    const live = [...chat.items, ...stubs];
    const replayed = live.map((item) => decodeTranscriptItem({ ...encodeTranscriptItem(item), id: item.id }));
    expect(replayed).toEqual(live);
    for (const target of [CODEX, CHAT, ANTHROPIC]) expect(JSON.stringify(projectTranscript(replayed, target))).toBe(JSON.stringify(projectTranscript(live, target)));
    expect(encodeTranscriptItem(stubs[0]!).body).toMatchObject({ cleared: true, outcome: "complete" });
    const broken = { ...encodeTranscriptItem(stubs[0]!), id: "x" };
    expect(() => decodeTranscriptItem({ ...broken, body: { ...broken.body, outcome: "error" } })).toThrow(TranscriptItemInvalidError);
    expect(() => decodeTranscriptItem({ ...broken, body: { ...broken.body, cleared: false } })).toThrow(TranscriptItemInvalidError);
  });

  it("leaves a compaction's record of the work as the calls returned it: whole size, handle and exit code", () => {
    const { chat, pages } = researcher(0, 0);
    const shell = namespacedWorkspaceToolName("sandbox_exec");
    const command = chat.call(shell, { command: "python3 scrape.py" });
    chat.items.push({ callId: command, handle: handleFor(command), id: chat.nextId(), kind: "tool_result", name: shell, outcome: "complete",
      output: `{"exit_code": 1, "stdout": "${"o".repeat(12_000)}"}` });
    for (let index = 1; index <= 7; index += 1) pages.push(fetched(chat, index, page(index, 10_000)));
    const stubs: readonly TranscriptToolResultItem[] = plan(chat.items)!.items;
    expect(stubs.map((stub) => stub.callId)).toEqual([command, ...pages.slice(0, 4)]);
    const record = buildStateBlock([...chat.items, ...stubs]);
    expect(record).toBe(buildStateBlock(chat.items));
    expect(record).toContain("`python3 scrape.py` → exit 1");
    expect(record).toContain(`- ${handleFor(pages[0]!)}: fetch_url url="https://shop.example/item-1" (10,007 characters)`);
  });
});
