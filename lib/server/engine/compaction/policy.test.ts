import { describe, expect, it } from "vitest";
import { measureContext } from "../contextMeasure";
import { selectTranscript, type TranscriptItem } from "../transcript";
import { CODEX, charTokens, transcriptBuilder } from "./compaction.testFixtures";
import { APPROVAL_PENDING_TEXT, engineItemRules } from "./items";
import {
  COMPACTION_THRESHOLDS,
  compactionCutCurrent,
  compactionRetention,
  findCompactionCut,
  planCompaction,
  usableContextTokens,
  type CompactionPlanInput
} from "./policy";

const measure = (items: readonly TranscriptItem[]) => measureContext({ estimate: charTokens, fixedTokens: 0, items, target: CODEX }).tokens;

/** `turns` user turns of about `size` tokens each: question, tool round, answer. */
function longChat(turns: number, size: number) {
  const chat = transcriptBuilder();
  for (let turn = 1; turn <= turns; turn += 1) {
    chat.user(`question ${turn} ${"q".repeat(size / 4)}`);
    chat.reasoning();
    chat.tool("read_file", { path: `/workspace/project/f${turn}.txt` }, "r".repeat(size / 2));
    chat.answer(`answer ${turn} ${"a".repeat(size / 4)}`);
  }
  return chat;
}

function windowPosition(items: readonly TranscriptItem[], id: string): number {
  return selectTranscript(items, CODEX).window.findIndex((item) => item.id === id);
}

describe("usable window and retention", () => {
  it("reserves the output and scales retention down for small windows", () => {
    expect(usableContextTokens({ contextWindow: 272_000, maxOutputTokens: 32_000 })).toBe(240_000);
    expect(usableContextTokens({ contextWindow: 1_000, maxOutputTokens: 4_000 })).toBe(0);
    expect(usableContextTokens({ contextWindow: Number.NaN, maxOutputTokens: 0 })).toBe(0);
    expect(compactionRetention(240_000)).toEqual({
      recentTokens: 20_000, skillTokens: 12_000, stateTokens: 3_000, summaryTokens: 4_096, userMessageTokens: 20_000
    });
    expect(compactionRetention(40_000)).toEqual({
      recentTokens: 6_000, skillTokens: 6_000, stateTokens: 3_000, summaryTokens: 4_096, userMessageTokens: 6_000
    });
  });
});

describe("compaction cut", () => {
  it("keeps at least the recent tokens, cutting at the latest user message or response start that does", () => {
    const chat = longChat(10, 4_000);
    const cut = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 9_000, target: CODEX })!;
    expect(cut.keptTokens).toBeGreaterThanOrEqual(9_000);
    expect(cut.keptTokens + cut.compactedTokens).toBe(measure(chat.items));
    const window = selectTranscript(chat.items, CODEX).window;
    const position = windowPosition(chat.items, cut.keepFromId);
    const kept = window[position]!;
    expect(kept.kind === "user" || ["reasoning", "assistant_text", "tool_call"].includes(kept.kind) &&
      !["reasoning", "assistant_text", "tool_call"].includes(window[position - 1]!.kind)).toBe(true);
    // The next cut point would keep less than asked.
    const smaller = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: cut.keptTokens + 1, target: CODEX })!;
    expect(windowPosition(chat.items, smaller.keepFromId)).toBeLessThan(position);
    expect(cut).toMatchObject({ baseId: null, compactedItems: position, keptItems: window.length - position });
  });

  it("never separates a call from its result, even across a follow-up that arrived between them", () => {
    const chat = transcriptBuilder();
    chat.user("start");
    const callId = chat.call("run_tests", { command: "pytest" });
    const followup = chat.user("also lint it", true);
    chat.result(callId, "run_tests", "ok");
    const answer = chat.answer("done");
    chat.user("next");
    for (const recentTokens of [1, 10, 20, 40, 60, 10_000]) {
      const cut = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens, target: CODEX });
      expect(cut?.keepFromId).not.toBe(followup);
      expect(cut?.keepFromId).not.toBe("i4");
    }
    // Weights: start 9, call 33 with its result 19 pulled up, follow-up 16, done 8, next 8.
    expect(findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 20, target: CODEX })?.keepFromId).toBe("i2");
    expect(findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 10, target: CODEX })?.keepFromId).toBe(answer);
    expect(findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })?.keepFromId).toBe("i6");
    // A window smaller than the budget is cut at its latest point: the most a compaction can remove.
    expect(findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 10_000, target: CODEX })?.keepFromId).toBe("i6");
  });

  it("keeps a call that still waits for approval or its result in the tail", () => {
    const chat = longChat(4, 2_000);
    const pending = chat.call("mcp_crm_create_ticket_0123456789", { title: "Refund" });
    chat.user("meanwhile, another question", true);
    chat.answer("waiting for your approval");
    const cut = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })!;
    const window = selectTranscript(chat.items, CODEX).window;
    expect(windowPosition(chat.items, cut.keepFromId)).toBeLessThanOrEqual(window.findIndex((item) => item.kind === "tool_call" &&
      item.callId === pending));
  });

  it("keeps a call waiting for approval open until its real result replaces the placeholder", () => {
    const chat = longChat(4, 2_000);
    chat.user("Create the refund ticket.");
    const name = "mcp_crm_create_ticket_0123456789";
    const callId = chat.call(name, { title: "Refund" });
    chat.result(callId, name, APPROVAL_PENDING_TEXT, "error");
    chat.user("Meanwhile, summarize the margins.");
    chat.answer("Margins look fine.");
    const callPosition = () => windowPosition(chat.items, chat.items.find((item) => item.kind === "tool_call" && item.callId === callId)!.id);
    const waiting = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })!;
    expect(windowPosition(chat.items, waiting.keepFromId)).toBeLessThanOrEqual(callPosition());
    // The approval ran: its result replaces the placeholder and the call no longer holds the tail back.
    chat.result(callId, name, "{\"id\":\"T-1001\"}");
    chat.answer("Ticket T-1001 created.");
    const settled = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })!;
    expect(windowPosition(chat.items, settled.keepFromId)).toBeGreaterThan(callPosition());
  });

  it("never starts the kept tail at run context or at an input later runs drop", () => {
    const chat = longChat(4, 2_000);
    const items: TranscriptItem[] = [...chat.items, { id: "ctx-0", kind: "user", text: "Skills index" },
      { id: "m-9", kind: "user", text: "Current question" }, { id: "a-9", kind: "assistant_text", text: "Current answer" }];
    const rules = engineItemRules("m-9");
    const cut = findCompactionCut({ estimate: charTokens, items, recentTokens: 1, rules, target: CODEX })!;
    expect(cut.keepFromId).toBe("a-9");
    expect(findCompactionCut({ estimate: charTokens, items, recentTokens: 1, target: CODEX })!.keepFromId).toBe("a-9");
    expect(findCompactionCut({ estimate: charTokens, items: items.slice(0, -1), recentTokens: 1, rules, target: CODEX })!.keepFromId)
      .not.toMatch(/^(?:ctx-0|m-9)$/u);
    expect(compactionCutCurrent({ baseId: null, keepFromId: "m-9" }, items, CODEX, rules)).toBe(false);
  });

  it("cuts inside the base compaction's kept tail and counts the base as compacted", () => {
    const chat = longChat(4, 2_000);
    const keep = chat.items.find((item) => item.kind === "user" && item.text.startsWith("question 3"))!.id;
    chat.compaction({ keepFromId: keep, retained: "R".repeat(100), summary: "S".repeat(400) });
    const cut = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 2_500, target: CODEX })!;
    expect(cut.baseId).toBe("i21");
    const window = selectTranscript(chat.items, CODEX).window;
    expect(window.map((item) => item.id)).toEqual(["i21", keep, ...chat.items.slice(11, 20).map((item) => item.id)]);
    const position = windowPosition(chat.items, cut.keepFromId);
    expect(position).toBeGreaterThan(1);
    expect(cut.compactedItems).toBe(position - 1);
    expect(cut.compactedTokens).toBeGreaterThan(400);
  });

  it("moves past an oversized response when a later cut point exists, and finds none without one", () => {
    const chat = transcriptBuilder();
    chat.user("old question");
    chat.answer("old answer");
    chat.user("analyse the dump");
    chat.tool("read_file", { path: "/dump" }, "d".repeat(50_000));
    const answer = chat.answer("the dump is fine");
    const uncapped = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1_000, target: CODEX })!;
    expect(uncapped.keptTokens).toBeGreaterThan(50_000);
    expect(findCompactionCut({ estimate: charTokens, items: chat.items, maxKeptTokens: 10_000, recentTokens: 1_000, target: CODEX })?.keepFromId)
      .toBe(answer);

    // Cutting at a pending call keeps it, so that cut is valid; a lone message offers none.
    const pending = transcriptBuilder();
    pending.user("only question");
    const call = pending.call("mcp_crm_create_ticket_0123456789", { title: "x" });
    expect(findCompactionCut({ estimate: charTokens, items: pending.items, recentTokens: 1, target: CODEX })?.keepFromId)
      .toBe(pending.items.find((item) => item.kind === "tool_call" && item.callId === call)?.id);
    const lone = transcriptBuilder();
    lone.user("only question");
    expect(findCompactionCut({ estimate: charTokens, items: lone.items, recentTokens: 1, target: CODEX })).toBeNull();
    lone.compaction({ summary: "S" });
    lone.user("after the summary");
    expect(findCompactionCut({ estimate: charTokens, items: lone.items, recentTokens: 1, target: CODEX })).toBeNull();
  });

  it("knows a prepared cut is stale once replay starts elsewhere", () => {
    const chat = longChat(6, 2_000);
    const cut = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 3_000, target: CODEX })!;
    chat.user("one more");
    expect(compactionCutCurrent(cut, chat.items, CODEX)).toBe(true);
    chat.compaction({ keepFromId: cut.keepFromId, summary: "S" });
    expect(compactionCutCurrent(cut, chat.items, CODEX)).toBe(false);
    expect(compactionCutCurrent({ ...cut, keepFromId: "missing" }, chat.items.slice(0, -1), CODEX)).toBe(false);
  });
});

describe("compaction plan", () => {
  const window = { contextWindow: 120_000, maxOutputTokens: 20_000 };
  const chat = longChat(18, 4_000);
  const tokens = measure(chat.items);
  const plan = (overrides: Partial<CompactionPlanInput>) => planCompaction({
    background: "idle", estimate: charTokens, items: chat.items, target: CODEX, tokens, window, ...overrides
  });

  it("does nothing below the background threshold", () => {
    expect(plan({ tokens: 71_000 })).toMatchObject({ kind: "none", share: 0.71, usable: 100_000 });
  });

  it("starts a background compaction at the background threshold that lands below it", () => {
    expect(tokens).toBeGreaterThan(72_000);
    expect(tokens).toBeLessThan(85_000);
    const result = plan({});
    expect(result.kind).toBe("background");
    if (result.kind !== "background") return;
    expect(result.cut.keptTokens).toBeGreaterThanOrEqual(15_000);
    expect(result.expectedTokens).toBeLessThanOrEqual(COMPACTION_THRESHOLDS.background * 100_000);
    // While one runs, or after one failed this turn, nothing new starts below the swap threshold.
    expect(plan({ background: "running", tokens: 80_000 }).kind).toBe("none");
    expect(plan({ background: "failed", tokens: 80_000 }).kind).toBe("none");
  });

  it("swaps a ready compaction in, waits for a running one at the swap threshold, and compacts in the foreground otherwise", () => {
    expect(plan({ background: "ready", tokens: 10 }).kind).toBe("swap");
    expect(plan({ background: "running", tokens: 86_000 })).toMatchObject({ kind: "wait", reason: "threshold" });
    expect(plan({ background: "idle", tokens: 86_000 })).toMatchObject({ kind: "foreground", reason: "threshold" });
    expect(plan({ background: "failed", tokens: 120_000 })).toMatchObject({ kind: "foreground", reason: "threshold" });
  });

  it("compacts in the foreground on a provider overflow, within the window the provider reported", () => {
    const result = plan({ overflow: { reportedMaximumTokens: 90_000 }, tokens: 60_000 });
    expect(result).toMatchObject({ kind: "foreground", reason: "overflow", usable: 70_000 });
    expect(plan({ background: "running", overflow: {}, tokens: 60_000 })).toMatchObject({ kind: "wait", reason: "overflow" });
  });

  it("reports when no compaction can make room", () => {
    const lone = transcriptBuilder();
    lone.user("x".repeat(90_000));
    const input = { background: "idle" as const, estimate: charTokens, items: lone.items, target: CODEX, window };
    expect(planCompaction({ ...input, tokens: 90_000 })).toMatchObject({ kind: "unavailable", reason: "threshold" });
    expect(planCompaction({ ...input, overflow: {}, tokens: 90_000 })).toMatchObject({ kind: "unavailable", reason: "overflow" });
    expect(planCompaction({ ...input, tokens: 75_000 }).kind).toBe("none");
  });

  it("compacts a giant pasted message, whose head and tail the retained messages keep", () => {
    const pasted = transcriptBuilder();
    pasted.user("x".repeat(90_000));
    pasted.call("mcp_crm_create_ticket_0123456789", { title: "x" });
    const result = planCompaction({ background: "idle", estimate: charTokens, items: pasted.items, target: CODEX,
      tokens: measure(pasted.items), window });
    expect(result).toMatchObject({ kind: "foreground", reason: "threshold" });
  });
});
