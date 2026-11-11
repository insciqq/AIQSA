import { describe, expect, it } from "vitest";
import { assertProviderHistoryRequest } from "../../providers/history";
import type { ProviderAttachment } from "../../providers/types";
import { contextItemTokens, measureContext } from "../contextMeasure";
import { projectTranscript, selectTranscript, type TranscriptItem, type TranscriptTarget } from "../transcript";
import { CODEX, charTokens, transcriptBuilder } from "./compaction.testFixtures";
import { APPROVAL_PENDING_TEXT, engineItemRules } from "./items";
import {
  compactableFixedTokens,
  COMPACTION_THRESHOLDS,
  COMPACTION_WORKING_MARGIN,
  compactionCutCurrent,
  compactionRetention,
  findCompactionCut,
  planCompaction,
  turnEndedAfter,
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

  it("keeps a call waiting for approval open in its turn until its real result replaces the placeholder", () => {
    const chat = longChat(4, 2_000);
    chat.user("Create the refund ticket.");
    const name = "mcp_crm_create_ticket_0123456789";
    const callId = chat.call(name, { title: "Refund" });
    chat.result(callId, name, APPROVAL_PENDING_TEXT, "error");
    chat.user("Meanwhile, summarize the margins.", true);
    chat.answer("Margins look fine; the ticket waits for your approval.");
    const callPosition = () => windowPosition(chat.items, chat.items.find((item) => item.kind === "tool_call" && item.callId === callId)!.id);
    const waiting = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })!;
    expect(windowPosition(chat.items, waiting.keepFromId)).toBeLessThanOrEqual(callPosition());
    // The approval ran (its continuation adds no user message): its result replaces the placeholder and the call no
    // longer holds the tail back.
    chat.result(callId, name, "{\"id\":\"T-1001\"}");
    chat.answer("Ticket T-1001 created.");
    const settled = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })!;
    expect(windowPosition(chat.items, settled.keepFromId)).toBeGreaterThan(callPosition());
  });

  it("lets later turns cut past a call its turn left without a result: stopped mid-call, or an approval never given", () => {
    for (const ending of ["stopped", "unapproved"] as const) {
      const chat = longChat(3, 2_000);
      const turn = chat.user("Run the long job.");
      const name = ending === "stopped" ? "run_command" : "mcp_crm_create_ticket_0123456789";
      const callId = chat.call(name, { command: "sleep 600" });
      // Stop or the deadline ends the run before the result; an ignored card keeps its placeholder for good.
      if (ending === "unapproved") chat.result(callId, name, APPROVAL_PENDING_TEXT, "error");
      expect(findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })?.keepFromId)
        .toBe(chat.items.find((item) => item.kind === "tool_call" && item.callId === callId)!.id);
      const later = longChat(6, 2_000).items.map((item) => ({ ...item, id: `later-${item.id}` }) as TranscriptItem);
      const items = [...chat.items, ...later];
      const cut = findCompactionCut({ estimate: charTokens, items, recentTokens: 6_000, target: CODEX })!;
      // A later turn starts the kept tail, the unanswered call is compacted, and the prepared cut stays current.
      expect(cut.keepFromId.startsWith("later-")).toBe(true);
      expect(windowPosition(items, cut.keepFromId)).toBeGreaterThan(windowPosition(items, turn));
      expect(compactionCutCurrent(cut, [...items, { id: "next", kind: "user", text: "next" }], CODEX)).toBe(true);
      expect(turnEndedAfter(items, turn)).toBe(true);
      expect(turnEndedAfter(chat.items, turn)).toBe(false);
    }
  });

  it("never lets a follow-up or run context end the turn of a call still waiting", () => {
    const chat = longChat(3, 2_000);
    chat.user("Run the long job.");
    const callId = chat.call("run_command", { command: "sleep 600" });
    const call = chat.items.at(-1)!.id;
    chat.user("Also tell me when it ends.", true);
    const items: TranscriptItem[] = [...chat.items, { id: "ctx-0", kind: "user", runContext: true, text: "Skills index" },
      { id: "a-1", kind: "assistant_text", text: "Still running." }];
    const cut = findCompactionCut({ estimate: charTokens, items, recentTokens: 1, target: CODEX })!;
    expect(windowPosition(items, cut.keepFromId)).toBeLessThanOrEqual(windowPosition(items, call));
    expect(turnEndedAfter(items, call)).toBe(false);
    expect(callId).toBeTruthy();
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

describe("a turn's input while its request carries attachments", () => {
  const report: ProviderAttachment = { byteSize: 4_000, extractedText: "The report.", fileName: "report.pdf", id: "report", kind: "pdf",
    metadata: {}, mimeType: "application/pdf", status: "ready" };

  /** A chat's first turn: its run context, its input, then `rounds` of `fetch_url`, so only the turn itself can be compacted. */
  function attachedTurn(rounds: number, text = "Compare the attached report with these pages.") {
    const chat = transcriptBuilder();
    chat.items.push({ id: "ctx-turn", kind: "user", runContext: true, text: "It is Monday morning." });
    const input = chat.user(text);
    const round = (index: number) => chat.tool("fetch_url", { url: `https://example.test/${index}` }, `page ${index} ${"p".repeat(4_000)}`);
    for (let index = 1; index <= rounds; index += 1) round(index);
    const target: TranscriptTarget = { ...CODEX, carriedInputId: input };
    return { chat, input, round, target };
  }

  const positionIn = (items: readonly TranscriptItem[], id: string, target: TranscriptTarget) =>
    selectTranscript(items, target).window.findIndex((item) => item.id === id);

  it("keeps the input in the request after the review's reproduction: a cut inside the turn, wherever the kept-tail limit pushes it", () => {
    for (const limits of [{ recentTokens: 6_000 }, { maxKeptTokens: 5_000, recentTokens: 30_000 }]) {
      const { chat, input, target } = attachedTurn(8);
      const cut = findCompactionCut({ estimate: charTokens, items: chat.items, ...limits, target })!;
      expect(positionIn(chat.items, cut.keepFromId, target)).toBeGreaterThan(positionIn(chat.items, input, target));
      chat.compaction({ keepFromId: cut.keepFromId, summary: "Eight pages read so far." });
      const history = projectTranscript(chat.items, target, { currentInputId: input });
      expect(() => assertProviderHistoryRequest({ attachments: [report], history })).not.toThrow();
      // Run context and the input go before the summary, so the request keeps its cached prefix.
      expect(history.slice(0, 3)).toEqual([
        { text: "It is Monday morning.", type: "user" },
        { currentInput: true, text: "Compare the attached report with these pages.", type: "user" },
        { text: expect.stringContaining("Eight pages read so far."), type: "user" }
      ]);
      // The tail follows in its own order and what the compaction covers is gone.
      expect(history[3]).toMatchObject({ type: "tool_call" });
      expect(history.filter((item) => item.type === "tool_call").length).toBeLessThan(8);
    }
  });

  it("counts the carried input as staying, so a plan never expects a compaction to remove it", () => {
    const { chat, input, target } = attachedTurn(8);
    const carried = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 6_000, target })!;
    const plain = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 6_000, target: CODEX })!;
    expect(carried.keepFromId).toBe(plain.keepFromId);
    const inputTokens = contextItemTokens(chat.items.find((item) => item.id === input)!, target, charTokens, "opaque");
    expect(carried.compactedTokens).toBe(plain.compactedTokens - inputTokens);
    expect(carried.keptTokens).toBe(plain.keptTokens + inputTokens);
    // In the kept tail already, it counts once.
    const total = measureContext({ estimate: charTokens, fixedTokens: 0, items: chat.items, target }).tokens;
    const fromInput = total - contextItemTokens(chat.items[0]!, target, charTokens, "opaque");
    const early = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: fromInput, target })!;
    expect(early.keepFromId).toBe(input);
    expect(early.keptTokens + early.compactedTokens).toBe(total);
  });

  it("cuts later every time: the carried input starts no tail, so nothing a compaction covered comes back", () => {
    for (const recentTokens of [1, 5_000, 12_000, 16_000, 20_000, 21_000, 25_000, 30_000, 100_000]) {
      const { chat, input, round, target } = attachedTurn(8, `Compare ${"the report ".repeat(1_000)}`);
      const first = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 6_000, target })!;
      chat.compaction({ keepFromId: first.keepFromId, summary: "First rounds." });
      round(9);
      round(10);
      const before = new Set(selectTranscript(chat.items, target).window.map((item) => item.id));
      const second = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens, target })!;
      expect(second.keepFromId).not.toBe(input);
      expect(second.keepFromId).not.toBe(first.keepFromId);
      expect(compactionCutCurrent(second, chat.items, target)).toBe(true);
      const base = chat.compaction({ keepFromId: second.keepFromId, summary: "More rounds." });
      const after = selectTranscript(chat.items, target).window.map((item) => item.id);
      expect(after.filter((id) => id !== base && !before.has(id))).toEqual([]);
      expect(after.slice(0, 3)).toEqual(["ctx-turn", input, base]);
      expect(projectTranscript(chat.items, target, { currentInputId: input }).filter((item) => item.type === "user" && item.currentInput))
        .toHaveLength(1);
    }
  });

  it("offers no cut that only keeps the tail its base already keeps", () => {
    const { chat, target } = attachedTurn(4);
    const first = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target })!;
    chat.compaction({ keepFromId: first.keepFromId, summary: "Earlier rounds." });
    expect(findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target })).toBeNull();

    // Run context alone stands before the tail just the same.
    const plain = attachedTurn(4);
    const cut = findCompactionCut({ estimate: charTokens, items: plain.chat.items, recentTokens: 1, target: CODEX })!;
    plain.chat.compaction({ keepFromId: cut.keepFromId, summary: "Earlier rounds." });
    expect(findCompactionCut({ estimate: charTokens, items: plain.chat.items, recentTokens: 1, target: CODEX })).toBeNull();
  });

  it("leaves a run without attachments as it was: its input goes with the cut", () => {
    const { chat, input } = attachedTurn(8);
    const cut = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 6_000, target: CODEX })!;
    chat.compaction({ keepFromId: cut.keepFromId, summary: "Eight pages read so far." });
    expect(selectTranscript(chat.items, CODEX).window.map((item) => item.id)).not.toContain(input);
  });

  it("plans with the input staying: a giant one no compaction removes leaves nothing to offer", () => {
    const window = { contextWindow: 120_000, maxOutputTokens: 20_000 };
    const { chat, target } = attachedTurn(8, "x".repeat(90_000));
    const tokens = measureContext({ estimate: charTokens, fixedTokens: 0, items: chat.items, target }).tokens;
    const plan = { background: "idle" as const, estimate: charTokens, items: chat.items, tokens, window };
    // Taken for removed, its bulk would buy a paid compaction that leaves the request as large as it was.
    expect(planCompaction({ ...plan, target: CODEX })).toMatchObject({ kind: "foreground" });
    expect(planCompaction({ ...plan, target })).toMatchObject({ kind: "unavailable", reason: "threshold" });
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

  it("leaves a giant pasted message in place while the request fits, and compacts it, head and tail retained, once it does not", () => {
    const pasted = transcriptBuilder();
    pasted.user("x".repeat(90_000));
    pasted.call("mcp_crm_create_ticket_0123456789", { title: "x" });
    const input = { background: "idle" as const, estimate: charTokens, items: pasted.items, target: CODEX, window };
    // The only cut keeps the pending call alone, less than a quarter of the recent budget.
    expect(planCompaction({ ...input, tokens: measure(pasted.items) })).toMatchObject({ kind: "unavailable", reason: "threshold" });
    expect(planCompaction({ ...input, tokens: 101_000 })).toMatchObject({ kind: "foreground", reason: "threshold" });
    expect(planCompaction({ ...input, overflow: {}, tokens: measure(pasted.items) })).toMatchObject({ kind: "foreground",
      reason: "overflow" });
  });
});

describe("the progress guarantee", () => {
  const window = { contextWindow: 120_000, maxOutputTokens: 20_000 };

  it("offers no cut that frees less than the recent budget, or keeps less than its quarter, while the request fits", () => {
    // usable 100 000: recent budget 15 000, its quarter 3 750, a summary of 4 096 and retained text replacing the span.
    const chat = longChat(4, 4_000);
    chat.user("one more question");
    chat.tool("read_file", { path: "/workspace/project/guide.md" }, "g".repeat(3_000));
    const base = { background: "idle" as const, estimate: charTokens, items: chat.items, target: CODEX, window };
    const tokens = 86_000;
    const free = (plan: ReturnType<typeof planCompaction>) => plan.kind === "foreground" ? tokens - plan.expectedTokens : 0;
    // The window after the cut points holds about 20k: no cut keeps 3 750 and frees 15 000 at once.
    expect(planCompaction({ ...base, tokens })).toMatchObject({ kind: "unavailable", reason: "threshold" });
    // Past the window the same transcript compacts as it always did.
    expect(planCompaction({ ...base, tokens: 101_000 })).toMatchObject({ kind: "foreground", reason: "threshold" });
    // With more behind it, a cut that lands under the threshold frees enough and keeps the newest round whole.
    for (let turn = 5; turn <= 9; turn += 1) chat.tool("read_file", { path: `/workspace/project/f${turn}.txt` }, "r".repeat(4_000));
    const plan = planCompaction({ ...base, items: chat.items, tokens });
    expect(plan).toMatchObject({ kind: "foreground", reason: "threshold" });
    expect(free(plan)).toBeGreaterThanOrEqual(15_000);
    if (plan.kind !== "foreground") return;
    expect(plan.expectedTokens).toBeLessThanOrEqual(72_000);
    expect(plan.cut.keptTokens).toBeGreaterThanOrEqual(3_750);
    const kept = selectTranscript(chat.items, CODEX).window.slice(windowPosition(chat.items, plan.cut.keepFromId));
    expect(kept.some((item) => item.kind === "tool_result" && item.output === "r".repeat(4_000))).toBe(true);
  });

  it("keeps a quarter of the recent budget after the cut: no cut point keeps that much, no cut", () => {
    const chat = longChat(6, 2_000);
    chat.user("Check the small file too.");
    chat.tool("read_file", { path: "/workspace/project/small.txt" }, "s".repeat(500));
    const last = findCompactionCut({ estimate: charTokens, items: chat.items, recentTokens: 1, target: CODEX })!;
    expect(last.keptTokens).toBeLessThan(1_000);
    const floored = findCompactionCut({ estimate: charTokens, items: chat.items, minKeptTokens: 1_000, recentTokens: 1, target: CODEX })!;
    expect(floored.keptTokens).toBeGreaterThanOrEqual(1_000);
    expect(windowPosition(chat.items, floored.keepFromId)).toBeLessThan(windowPosition(chat.items, last.keepFromId));
    // The newest result read stays whole in the kept tail.
    const kept = selectTranscript(chat.items, CODEX).window.slice(windowPosition(chat.items, floored.keepFromId));
    expect(kept.filter((item) => item.kind === "tool_result").map((item) => item.kind === "tool_result" && item.output.length))
      .toContain(500);
    expect(findCompactionCut({ estimate: charTokens, items: chat.items, minKeptTokens: 1_000_000, recentTokens: 1, target: CODEX }))
      .toBeNull();
  });

  describe("on the production figures (psaux, 2026-11-11)", () => {
    // gpt-6-astra: window 700 000, output 65 536, so usable 634 464, background goal 456 814, swap at 539 294.
    const PRODUCTION = { contextWindow: 700_000, maxOutputTokens: 65_536 };
    // Prompt, tools and the text of 19 spreadsheets, about 570k on every request.
    const FIXED = 570_000;

    /**
     * One answer's turn: its input carries the attachments, and each request adds one tool round of `size` tokens. A planned
     * compaction is applied at once. Returns each request's plan and the requests where the result the model read last time
     * was gone.
     */
    function answer(requests: number, size: number, told: boolean) {
      const chat = transcriptBuilder();
      const input = chat.user("Build the summary workbook from the attached spreadsheets.");
      const target: TranscriptTarget = { ...CODEX, carriedInputId: input };
      const plans: ReturnType<typeof planCompaction>[] = [];
      const lost: number[] = [];
      const outputs: string[] = [];
      for (let request = 1; request <= requests; request += 1) {
        const tokens = FIXED + measureContext({ estimate: charTokens, fixedTokens: 0, items: chat.items, target }).tokens;
        const plan = planCompaction({ background: "idle", estimate: charTokens, ...(told ? { irreducibleTokens: FIXED } : {}),
          items: chat.items, target, tokens, window: PRODUCTION });
        plans.push(plan);
        if (plan.kind === "foreground" || plan.kind === "background") {
          chat.compaction({ keepFromId: plan.cut.keepFromId, summary: `Steps 1-${request - 1} done.` });
        }
        const history = projectTranscript(chat.items, target, { currentInputId: input });
        expect(history.filter((item) => item.type === "user" && item.currentInput)).toHaveLength(1);
        // The newest result the previous request carried.
        const seen = outputs.at(-2);
        if (seen !== undefined && !history.some((item) => item.type === "tool_result" && item.output === seen)) lost.push(request);
        outputs.push(`step ${request} ${"r".repeat(size)}`);
        chat.tool("sandbox_exec", { step: request }, outputs.at(-1)!);
      }
      return { lost, plans };
    }

    const compacting = (plans: readonly ReturnType<typeof planCompaction>[]) =>
      plans.flatMap((plan, index) => plan.kind === "foreground" || plan.kind === "background" ? [index + 1] : []);

    it("never compacts a request that fits while the fixed part alone passes the threshold, and keeps what the model read", () => {
      expect(usableContextTokens(PRODUCTION)).toBe(634_464);
      const { lost, plans } = answer(30, 8_000, true);
      // Before the change every request from the third on compacted in the foreground (20 and 23 times in production).
      const compacted = compacting(plans);
      expect(compacted.length).toBeGreaterThan(0);
      expect(compacted.length).toBeLessThanOrEqual(5);
      for (const [index, plan] of plans.entries()) {
        if (compacted.includes(index + 1)) {
          // Only a request past the usable window compacts, and the compaction makes it fit.
          expect(plan).toMatchObject({ kind: "foreground", reason: "threshold" });
          expect(plan.tokens).toBeGreaterThan(plan.usable);
          if (plan.kind === "foreground") expect(plan.expectedTokens).toBeLessThan(plan.usable);
        } else {
          expect(plan).toMatchObject({ kind: "unavailable", reason: "threshold" });
          expect(plan.tokens).toBeLessThanOrEqual(plan.usable);
        }
      }
      // The result read last stays verbatim on every request that fits; only a compaction past the window may fold it.
      expect(lost.every((request) => compacted.includes(request))).toBe(true);
    });

    it("frees at least the recent budget each time even without the fixed part's figure, keeping the newest rounds", () => {
      const { lost, plans } = answer(30, 8_000, false);
      const compacted = compacting(plans);
      expect(compacted.length).toBeGreaterThan(0);
      expect(compacted.length).toBeLessThanOrEqual(8);
      // Never two requests in a row, and every one frees what it promised.
      expect(compacted.every((request, index) => index === 0 || request - compacted[index - 1]! > 1)).toBe(true);
      for (const request of compacted) {
        const plan = plans[request - 1]!;
        expect(plan.kind === "foreground" ? plan.tokens - plan.expectedTokens : 0).toBeGreaterThanOrEqual(20_000);
      }
      expect(lost).toEqual([]);
    });

    it("still compacts a provider overflow, and reports when nothing can make room", () => {
      const { plans } = answer(6, 8_000, true);
      expect(plans.every((plan) => plan.kind === "unavailable")).toBe(true);
      const chat = transcriptBuilder();
      const input = chat.user("Build the summary workbook from the attached spreadsheets.");
      for (let request = 1; request <= 6; request += 1) chat.tool("sandbox_exec", { step: request }, "r".repeat(8_000));
      const target: TranscriptTarget = { ...CODEX, carriedInputId: input };
      const tokens = FIXED + measureContext({ estimate: charTokens, fixedTokens: 0, items: chat.items, target }).tokens;
      const plan = { background: "idle" as const, estimate: charTokens, irreducibleTokens: FIXED, items: chat.items, target, tokens,
        window: PRODUCTION };
      expect(planCompaction({ ...plan, overflow: {} })).toMatchObject({ kind: "foreground", reason: "overflow" });
      // A window the provider states below the fixed part leaves nothing a compaction could do: the run fails visibly.
      expect(planCompaction({ ...plan, overflow: { reportedMaximumTokens: 600_000 } })).toMatchObject({ kind: "unavailable",
        reason: "overflow" });
    });
  });
});

describe("the fixed part admission leaves compaction", () => {
  it("is the background threshold less the working margin of the usable window", () => {
    // 72% of 634 464 is 456 814; the 15% margin is 95 170.
    expect(compactableFixedTokens({ contextWindow: 700_000, maxOutputTokens: 65_536 })).toBe(456_814 - 95_170);
    expect(compactableFixedTokens({ contextWindow: 120_000, maxOutputTokens: 20_000 })).toBe(72_000 - 15_000);
    expect(compactableFixedTokens({ contextWindow: 1_000, maxOutputTokens: 4_000 })).toBe(0);
    expect(COMPACTION_WORKING_MARGIN).toBeLessThan(COMPACTION_THRESHOLDS.background);
  });
});
