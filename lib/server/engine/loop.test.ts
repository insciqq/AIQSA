import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { ModelToolCall } from "../tools/types";
import { MAX_CORRECTION_ROUNDS, NO_MORE_TOOLS_OUTPUT, runAgentLoop, type AgentLoopPorts } from "./loop";
import type { ToolBatchOutcome } from "./toolBatch";
import type { TranscriptItem, TranscriptUserItem } from "./transcript";

function response(text: string, calls: readonly ModelToolCall[] = []): ProviderRunResult {
  return { finalProviderResponsePreview: {}, finalText: text, toolCalls: [...calls], usage: {} };
}

function call(id: string, name = "lookup"): ModelToolCall {
  return { arguments: {}, id, name };
}

function harness(responses: readonly ProviderRunResult[], options: Partial<{
  batch: (calls: readonly ModelToolCall[]) => Partial<ToolBatchOutcome>;
  closes: boolean[];
  followups: TranscriptUserItem[][];
  /** Null: no round limit (tool limits off). */
  maxToolRounds: number | null;
  toolTimeLeft: () => boolean;
}> = {}) {
  const items: TranscriptItem[] = [];
  const choices: string[] = [];
  /** Rounds whose request asked for the answer itself. */
  const asked: number[] = [];
  const order: string[] = [];
  let index = 0;
  const closes = [...(options.closes ?? [])];
  const followups = [...(options.followups ?? [])];
  const ports: AgentLoopPorts = {
    append: vi.fn(async (added: readonly TranscriptItem[]) => { order.push("append"); items.push(...added); }),
    appendCalls: vi.fn(async (added: readonly TranscriptItem[]) => { order.push("appendCalls"); items.push(...added); }),
    callModel: vi.fn(async () => responses[Math.min(index++, responses.length - 1)]!),
    closeFollowups: vi.fn(async () => closes.shift() ?? true),
    deliverFollowups: vi.fn(async () => followups.shift() ?? []),
    maxToolRounds: options.maxToolRounds === undefined ? 8 : options.maxToolRounds,
    prepareRequest: vi.fn(async ({ answerNow, round, toolChoice }) => {
      choices.push(toolChoice);
      if (answerNow) asked.push(round);
      return { toolChoice } as ProviderRunRequest;
    }),
    responseItems: (result) => [{ id: `a${index}`, kind: "assistant_text", text: result.finalText }],
    roundEnd: vi.fn(async () => { order.push("roundEnd"); }),
    roundStart: vi.fn(async () => undefined),
    runTools: vi.fn(async (calls: readonly ModelToolCall[]): Promise<ToolBatchOutcome> => ({
      approvals: [], budgetExhausted: false, correctable: 0, executed: calls.length,
      results: calls.map((entry: ModelToolCall) => ({ callId: entry.id, id: `r-${entry.id}`, kind: "tool_result" as const, name: entry.name,
        outcome: "complete" as const, output: "ok" })),
      ...options.batch?.(calls)
    })),
    signal: new AbortController().signal,
    toolTimeLeft: options.toolTimeLeft ?? (() => true)
  };
  return { asked, choices, items, order, ports };
}

function recordingOffers(ports: AgentLoopPorts, offered: boolean[]): AgentLoopPorts["prepareRequest"] {
  return async (input) => {
    offered.push(input.reserved === true);
    return ports.prepareRequest(input);
  };
}

describe("native agent loop", () => {
  it("answers directly in one round", async () => {
    const { items, ports } = harness([response("Hi")]);
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 1 });
    expect(items).toHaveLength(1);
  });

  it("runs tool rounds until a response calls no tool", async () => {
    const { items, ports } = harness([response("", [call("c1")]), response("", [call("c2")]), response("Done")]);
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(items.filter((item) => item.kind === "tool_result").map((item) => item.kind === "tool_result" && item.callId))
      .toEqual(["c1", "c2"]);
  });

  it("ends the turn at an approval point with its follow-ups closed", async () => {
    const { ports } = harness([response("", [call("c1", "create")])], { batch: () => ({ approvals: ["approval-1"], executed: 0 }) });
    await expect(runAgentLoop(ports)).resolves.toEqual({ approvals: ["approval-1"], kind: "approval", rounds: 1 });
    expect(ports.callModel).toHaveBeenCalledTimes(1);
    // The answer is published only with its follow-ups closed at the revision it read.
    expect(ports.closeFollowups).toHaveBeenCalledTimes(1);
  });

  it("goes on past an approval point with a follow-up that arrived, and still reports the approval", async () => {
    const followup: TranscriptUserItem = { followup: true, id: "f1", kind: "user", text: "Also tell me the ETA" };
    const { items, ports } = harness([response("", [call("c1", "create")]), response("Waiting for your approval; ETA is Friday.")], {
      batch: () => ({ approvals: ["approval-1"], executed: 0 }), closes: [false, true], followups: [[followup]]
    });
    await expect(runAgentLoop(ports)).resolves.toEqual({ approvals: ["approval-1"], kind: "approval", rounds: 2 });
    expect(items.map((item) => item.id)).toContain("f1");
  });

  it("takes the response's text before any record of it, and records tool calls before running them", async () => {
    const { order, ports } = harness([response("Checking", [call("c1")]), response("Done")]);
    await runAgentLoop(ports);
    expect(order).toEqual(["roundEnd", "appendCalls", "append", "roundEnd", "append"]);
  });

  it("answers without tools once the call budget is spent, and refuses calls made anyway", async () => {
    const { choices, items, ports } = harness([response("", [call("c1")]), response("Stuck", [call("c2")])],
      { batch: () => ({ budgetExhausted: true }) });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
    expect(choices).toEqual(["auto", "none"]);
    expect(items.find((item) => item.kind === "tool_result" && item.callId === "c2")).toMatchObject({ output: NO_MORE_TOOLS_OUTPUT });
  });

  it("answers without tools after the last tool round or a batch of which nothing ran", async () => {
    const rounds = harness([response("", [call("c1")]), response("", [call("c2")]), response("Done")], { maxToolRounds: 1 });
    await runAgentLoop(rounds.ports);
    // The tool-free round answered only with a call, so it is asked once more for the answer.
    expect(rounds.choices).toEqual(["auto", "none", "none"]);
    expect(rounds.asked).toEqual([3]);
    const stalled = harness([response("", [call("c1")]), response("Done")], { batch: () => ({ executed: 0 }) });
    await runAgentLoop(stalled.ports);
    expect(stalled.choices).toEqual(["auto", "none"]);
  });

  it("keeps tools open for as many rounds as the work takes without a round limit", async () => {
    const working = Array.from({ length: 60 }, (_, index) => response("", [call(`c${index}`)]));
    const { choices, ports } = harness([...working, response("Done")], { maxToolRounds: null });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 61 });
    expect(choices).toEqual(Array<string>(61).fill("auto"));
    expect(ports.runTools).toHaveBeenCalledTimes(60);
  });

  it("ends tool use at the tool time without limits, and the tool-free round answers", async () => {
    let rounds = 0;
    // The model would go on calling tools: the time deadline, not a count, closes them.
    const { asked, choices, items, ports } = harness([response("", [call("c1")]), response("", [call("c2")]),
      response("", [call("c3")]), response("Here is what I found so far.")],
    { maxToolRounds: null, toolTimeLeft: () => ++rounds <= 2 });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 4 });
    expect(choices).toEqual(["auto", "auto", "none", "none"]);
    expect(ports.runTools).toHaveBeenCalledTimes(2);
    // The call of the first tool-free round gets its result without running, and the round is asked for the answer.
    expect(items.find((item) => item.kind === "tool_result" && item.callId === "c3")).toMatchObject({ output: NO_MORE_TOOLS_OUTPUT });
    expect(asked).toEqual([4]);
  });

  it("lets the model correct a call it could not make, a bounded number of times", async () => {
    // An older tool name, a tool find_tools has not loaded yet: its result says how to go on, so tools stay open.
    const unknown = (calls: readonly ModelToolCall[]) =>
      calls.every((entry) => entry.name === "old_name") ? { correctable: calls.length, executed: 0 } : {};
    const corrected = harness([response("", [call("c1", "old_name")]), response("", [call("c2", "find_tools")]), response("Done")],
      { batch: unknown });
    await expect(runAgentLoop(corrected.ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(corrected.choices).toEqual(["auto", "auto", "auto"]);
    expect(corrected.ports.runTools).toHaveBeenCalledTimes(2);

    // Mistakes that keep coming close tools after the bound, and a mixed batch of which nothing ran closes them at once.
    const repeated = harness(Array.from({ length: MAX_CORRECTION_ROUNDS + 1 }, (_, index) => response("", [call(`u${index}`, "old_name")]))
      .concat(response("Done")), { batch: unknown });
    await runAgentLoop(repeated.ports);
    expect(repeated.choices).toEqual([...Array<string>(MAX_CORRECTION_ROUNDS + 1).fill("auto"), "none"]);
    const mixed = harness([response("", [call("c1", "old_name"), call("c2")]), response("Done")],
      { batch: () => ({ correctable: 1, executed: 0 }) });
    await runAgentLoop(mixed.ports);
    expect(mixed.choices).toEqual(["auto", "none"]);
  });

  it("asks a tool-free round that answered only with calls once more, and fails an answer that stays empty", async () => {
    const spent = { batch: () => ({ budgetExhausted: true }) };
    const recovered = harness([response("", [call("c1")]), response("", [call("c2", "find_tools")]), response("Here is what I have")], spent);
    await expect(runAgentLoop(recovered.ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(recovered.choices).toEqual(["auto", "none", "none"]);
    expect(recovered.asked).toEqual([3]);
    expect(recovered.items.find((item) => item.kind === "tool_result" && item.callId === "c2"))
      .toMatchObject({ output: NO_MORE_TOOLS_OUTPUT });

    const empty = harness([response("", [call("c1")]), response("", [call("c2")]), response("", [call("c3")])], spent);
    await expect(runAgentLoop(empty.ports)).resolves.toEqual({ kind: "empty", rounds: 3 });
    expect(empty.ports.callModel).toHaveBeenCalledTimes(3);

    // Text the answer already has is kept: the turn answers with it rather than failing.
    const said = harness([response("Checking your notes.", [call("c1")]), response("", [call("c2")]), response("", [call("c3")])], spent);
    await expect(runAgentLoop(said.ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
  });

  it("treats a tool-free response the adapter stopped for native call markup as calls only (issue #56)", async () => {
    const spent = { batch: () => ({ budgetExhausted: true }) };
    const markup: ProviderRunResult = { ...response(""), synthesisToolCallForbidden: true };
    const recovered = harness([response("", [call("c1")]), markup, response("Here is what I have")], spent);
    await expect(runAgentLoop(recovered.ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(recovered.asked).toEqual([3]);
    const empty = harness([response("", [call("c1")]), markup, markup], spent);
    await expect(runAgentLoop(empty.ports)).resolves.toEqual({ kind: "empty", rounds: 3 });
  });

  it("takes a follow-up delivered between rounds or before the answer closes", async () => {
    const followup: TranscriptUserItem = { followup: true, id: "f1", kind: "user", text: "Also B" };
    const { items, ports } = harness([response("A"), response("A and B")], { closes: [false, true], followups: [[followup]] });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
    expect(items.map((item) => item.id)).toContain("f1");
  });

  describe("an agent's message never empties the answer (operator decision 2026-11-05)", () => {
    const callback: TranscriptUserItem = { callback: true, followup: true, id: "cb", kind: "user", text: "Sub-agent ended" };
    const followup: TranscriptUserItem = { followup: true, id: "f1", kind: "user", text: "Shorter, please" };

    it("keeps the answer an agent's message follows: a round with nothing to add still answers", async () => {
      const { ports } = harness([response("Full answer."), response("")], { closes: [false, true], followups: [[callback]] });
      await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
      expect(ports.deliverFollowups).toHaveBeenCalledWith({ ending: true });
    });

    it("fails an answer the user's follow-up started over when nothing follows it, alone or beside an agent's message", async () => {
      for (const batch of [[followup], [callback, followup]]) {
        const { ports } = harness([response("Draft."), response("")], { closes: [false, true], followups: [batch] });
        await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "empty", rounds: 2 });
      }
      const answered = harness([response("Draft."), response("Final.")], { closes: [false, true], followups: [[followup]] });
      await expect(runAgentLoop(answered.ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
    });

    it("says where it delivers: between tool rounds the turn is not ending", async () => {
      const { ports } = harness([response("Checking.", [call("c1")]), response("")], { followups: [[callback]] });
      await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
      expect(ports.deliverFollowups).toHaveBeenNthCalledWith(1, { ending: false });
    });
  });

  it("keeps closing or delivering until the follow-ups settle, so publication never finds one open", async () => {
    const { ports } = harness([response("A")], { closes: [false, false, false, true] });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 1 });
    expect(ports.closeFollowups).toHaveBeenCalledTimes(4);
    expect(ports.callModel).toHaveBeenCalledTimes(1);
  });

  it("never buys another paid round for a follow-up it could not deliver", async () => {
    const { ports } = harness([response("A")], { closes: [false, false] });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 1 });
    expect(ports.callModel).toHaveBeenCalledTimes(1);
  });
});

describe("the run's reserved report", () => {
  /** A harness whose `report` call is the reserved one, outstanding until a batch runs it. */
  function reservedHarness(responses: readonly ProviderRunResult[], options: Parameters<typeof harness>[1] & Readonly<{
    budgetExhaustedBy?: string; made?: boolean; signal?: AbortSignal; timeLeft?: boolean | (() => boolean);
  }> = {}) {
    let made = options.made ?? false;
    const reservedRounds: number[] = [];
    const run = harness(responses, { ...options, batch: (calls) => {
      if (calls.some((entry) => entry.name === "report")) made = true;
      const spent = options.budgetExhaustedBy !== undefined && calls.some((entry) => entry.id === options.budgetExhaustedBy);
      return { ...(spent ? { budgetExhausted: true } : {}), ...options.batch?.(calls) };
    } });
    const prepare = run.ports.prepareRequest;
    const ports: AgentLoopPorts = {
      ...run.ports,
      prepareRequest: async (input) => {
        if (input.reserved) reservedRounds.push(input.round);
        return prepare(input);
      },
      reservedCall: { name: "report", outstanding: () => !made },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeLeft === undefined ? {} : { toolTimeLeft: typeof options.timeLeft === "function" ? options.timeLeft
        : () => options.timeLeft as boolean })
    };
    return { ...run, ports, reservedRounds };
  }

  it("is offered alone once the call budget is spent, and only its call runs", async () => {
    const { choices, items, ports, reservedRounds } = reservedHarness([
      response("", [call("c1")]), response("", [call("v1", "report"), call("c2")]), response("Done")
    ], { budgetExhaustedBy: "c1" });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(choices).toEqual(["auto", "auto", "none"]);
    expect(reservedRounds).toEqual([2]);
    expect(vi.mocked(ports.runTools).mock.calls.map(([calls]) => calls.map((entry) => entry.id))).toEqual([["c1"], ["v1"]]);
    // The other call of the reserved round gets its result without running.
    expect(items.find((item) => item.kind === "tool_result" && item.callId === "c2")).toMatchObject({ output: NO_MORE_TOOLS_OUTPUT });
  });

  it("is offered after the last tool round too", async () => {
    const { choices, ports, reservedRounds } = reservedHarness([
      response("", [call("c1")]), response("", [call("v1", "report")]), response("Done")
    ], { maxToolRounds: 1 });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(choices).toEqual(["auto", "auto", "none"]);
    expect(reservedRounds).toEqual([2]);
  });

  it("is offered once: a reserved round whose response makes only other calls answers without tools next", async () => {
    const { choices, items, ports, reservedRounds } = reservedHarness([
      response("", [call("c1")]), response("", [call("c2")]), response("Done")
    ], { budgetExhaustedBy: "c1" });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(choices).toEqual(["auto", "auto", "none"]);
    expect(reservedRounds).toEqual([2]);
    expect(ports.runTools).toHaveBeenCalledTimes(1);
    expect(items.find((item) => item.kind === "tool_result" && item.callId === "c2")).toMatchObject({ output: NO_MORE_TOOLS_OUTPUT });
  });

  it("is not offered once made or after a batch without progress while tool time is left", async () => {
    const made = reservedHarness([response("", [call("v1", "report"), call("c1")]), response("Done")], { budgetExhaustedBy: "c1" });
    await runAgentLoop(made.ports);
    expect(made.choices).toEqual(["auto", "none"]);
    expect(made.reservedRounds).toEqual([]);
    const stalled = reservedHarness([response("", [call("c1")]), response("Done")], { batch: () => ({ executed: 0 }) });
    await runAgentLoop(stalled.ports);
    expect(stalled.choices).toEqual(["auto", "none"]);
    expect(stalled.reservedRounds).toEqual([]);
  });

  it("is offered alone once when the tool time ran out, then the turn answers", async () => {
    // Tool time ends after the first round: the reserved round runs inside the answer reserve.
    let rounds = 0;
    const { choices, items, ports, reservedRounds } = reservedHarness([
      response("", [call("c1")]), response("", [call("v1", "report"), call("c2")]), response("Done")
    ], { timeLeft: () => rounds++ === 0 });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 3 });
    expect(choices).toEqual(["auto", "auto", "none"]);
    expect(reservedRounds).toEqual([2]);
    // Only the reserved call runs; the other one gets its result without running.
    expect(vi.mocked(ports.runTools).mock.calls.map(([calls]) => calls.map((entry) => entry.id))).toEqual([["c1"], ["v1"]]);
    expect(items.find((item) => item.kind === "tool_result" && item.callId === "c2")).toMatchObject({ output: NO_MORE_TOOLS_OUTPUT });
    // A reserved round that made only other calls is not offered again.
    const ignored = reservedHarness([response("", [call("c2")]), response("Done")], { timeLeft: false });
    await expect(runAgentLoop(ignored.ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
    expect(ignored.choices).toEqual(["auto", "none"]);
    expect(ignored.reservedRounds).toEqual([1]);
    expect(ignored.ports.runTools).not.toHaveBeenCalled();
  });

  it("is offered by the tool time alone when the turn has no limits", async () => {
    let rounds = 0;
    const working = Array.from({ length: 12 }, (_, index) => response("", [call(`c${index}`)]));
    const { choices, ports, reservedRounds } = reservedHarness([...working, response("", [call("v1", "report")]), response("Done")],
      { maxToolRounds: null, timeLeft: () => ++rounds <= 12 });
    await expect(runAgentLoop(ports)).resolves.toEqual({ kind: "answered", rounds: 14 });
    expect(reservedRounds).toEqual([13]);
    expect(choices).toEqual([...Array<string>(13).fill("auto"), "none"]);
  });

  it("is not offered past the tool time once made", async () => {
    let rounds = 0;
    const made = reservedHarness([response("", [call("v1", "report")]), response("Done")], { timeLeft: () => rounds++ === 0 });
    await expect(runAgentLoop(made.ports)).resolves.toEqual({ kind: "answered", rounds: 2 });
    expect(made.choices).toEqual(["auto", "none"]);
    expect(made.reservedRounds).toEqual([]);
  });

  it("does not outlast the turn's deadline", async () => {
    // The deadline fires during the last tool batch: the run ends there instead of taking the reserved round.
    const deadline = new AbortController();
    const reason = new Error("run time limit");
    let rounds = 0;
    const { ports, reservedRounds } = reservedHarness([response("", [call("c1")]), response("Done")], {
      batch: () => { deadline.abort(reason); return {}; }, signal: deadline.signal, timeLeft: () => rounds++ === 0
    });
    await expect(runAgentLoop(ports)).rejects.toBe(reason);
    expect(ports.callModel).toHaveBeenCalledTimes(1);
    expect(reservedRounds).toEqual([]);
  });

  describe("a held draft", () => {
    const sentBack: TranscriptUserItem = { id: "back", kind: "user", text: "Submit it." };

    it("ends the turn with no further model round once the answer is taken", async () => {
      let taken = false;
      const { ports } = harness([response("", [call("c1")]), response("never")], { batch: () => { taken = true; return {}; } });
      const responseEnded = vi.fn(async () => null);
      await expect(runAgentLoop({ ...ports, draft: { answerTaken: () => taken, responseCompleted: () => undefined, responseEnded } })).resolves.toEqual({ kind: "answered", rounds: 1 });
      expect(ports.callModel).toHaveBeenCalledTimes(1);
      expect(responseEnded).not.toHaveBeenCalled();
    });

    it("gives a taken answer back to a follow-up that arrived, and the turn goes on with it", async () => {
      let taken = true;
      const followup: TranscriptUserItem = { followup: true, id: "f", kind: "user", text: "More." };
      const { items, ports } = harness([response("Done.")], { closes: [false], followups: [[followup]] });
      const deliverFollowups = vi.fn(async () => { taken = false; return [followup]; });
      await expect(runAgentLoop({ ...ports, deliverFollowups, draft: { answerTaken: () => taken, responseCompleted: () => undefined, responseEnded: async () => null } })).resolves.toMatchObject({ kind: "answered" });
      expect(ports.callModel).toHaveBeenCalledTimes(1);
      expect(items[0]).toBe(followup);
    });

    it("sends a response without calls back to the model when the draft says so, then lets the turn end", async () => {
      const { choices, items, ports } = harness([response("A message."), response("A message again.")]);
      const responseEnded = vi.fn().mockResolvedValueOnce(sentBack).mockResolvedValue(null);
      await expect(runAgentLoop({ ...ports, draft: { answerTaken: () => false, responseCompleted: () => undefined, responseEnded } })).resolves.toEqual({ kind: "answered", rounds: 2 });
      expect(responseEnded).toHaveBeenNthCalledWith(1, { round: 1, text: "A message.", toolsClosed: false });
      expect(items.map((item) => item.id)).toContain("back");
      expect(choices).toEqual(["auto", "auto"]);
    });

    it("tells it when tools are closed, and skips a tool-free round when the answer is taken instead", async () => {
      const closed = harness([response("Text.")], { toolTimeLeft: () => false });
      const responseEnded = vi.fn(async () => null);
      await runAgentLoop({ ...closed.ports, draft: { answerTaken: () => false, responseCompleted: () => undefined, responseEnded } });
      expect(responseEnded).toHaveBeenCalledWith({ round: 1, text: "Text.", toolsClosed: true });
      const skipped = harness([response("never")], { toolTimeLeft: () => false });
      await expect(runAgentLoop({ ...skipped.ports, draft: { answerTaken: ({ toolChoice }) => toolChoice === "none", responseCompleted: () => undefined, responseEnded } }))
        .resolves.toEqual({ kind: "answered", rounds: 0 });
      expect(skipped.ports.callModel).not.toHaveBeenCalled();
    });

    it("tells it of a completed response before any record of it is written or any call sent", async () => {
      const { order, ports } = harness([response("", [call("c1")]), response("Done.")]);
      const responseCompleted = vi.fn(() => { order.push("responseCompleted"); });
      await runAgentLoop({ ...ports, draft: { answerTaken: () => false, responseCompleted, responseEnded: async () => null } });
      expect(responseCompleted).toHaveBeenNthCalledWith(1, { calls: [call("c1")], runnable: [call("c1")] });
      expect(order.indexOf("responseCompleted")).toBeLessThan(order.indexOf("appendCalls"));
      expect(order.indexOf("roundEnd")).toBeLessThan(order.indexOf("responseCompleted"));
    });

    it("offers a reserved call once more after a delivered follow-up, only where a draft is held", async () => {
      const followup: TranscriptUserItem = { followup: true, id: "f", kind: "user", text: "More." };
      const reservedRun = (draft: boolean) => {
        const made = harness([response("", [call("c1", "report")]), response("", [call("c2", "report")]), response("Done.")], { closes: [false], followups: [[followup]], toolTimeLeft: () => false });
        const offered: boolean[] = [];
        const prepareRequest = recordingOffers(made.ports, offered);
        return { made, offered, ports: { ...made.ports, prepareRequest, reservedCall: { name: "report", outstanding: () => true },
          ...(draft ? { draft: { answerTaken: () => false, responseCompleted: () => undefined, responseEnded: async () => null } } : {}) } };
      };
      const held = reservedRun(true);
      await runAgentLoop(held.ports);
      expect(held.offered.filter(Boolean).length).toBe(2);
      const plain = reservedRun(false);
      await runAgentLoop(plain.ports);
      expect(plain.offered.filter(Boolean).length).toBe(1);
    });

    it("does not fail as empty when the draft takes the answer after a tool-free response of only calls", async () => {
      const { ports } = harness([response("", [call("c1")]), response("", [call("c2")]), response("", [call("c3")])], { toolTimeLeft: () => false });
      let asks = 0;
      await expect(runAgentLoop({ ...ports, draft: { answerTaken: () => asks++ > 1, responseCompleted: () => undefined, responseEnded: async () => null } })).resolves.toMatchObject({ kind: "answered" });
    });
  });
});
