import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESEARCH_TIME_MS } from "../../contracts/research";
import { MAIN_AGENT_NAME, type SubagentAgentEntry } from "../../contracts/subagents";
import { createResearchClock, RESEARCHERS_CLOSED, RESEARCHERS_FINISH } from "./clock";
import { NOOP_RESEARCH_PORTS, type ResearchRunScope } from "./ports";

const agent = (name: string, state: SubagentAgentEntry["state"]): SubagentAgentEntry => ({ mode: "foreground", name, parent: MAIN_AGENT_NAME, state, steps: [] });

function scope(agents: readonly SubagentAgentEntry[] = [], extra: Partial<ResearchRunScope> = {}) {
  const extendTurn = vi.fn<(endsAt: number) => void>();
  const send = vi.fn(async (_message: Readonly<{ to: string }>) => ({ kind: "delivered" as const }));
  const run: ResearchRunScope = { branchRunIds: [], chatId: "chat", extendTurn, mailbox: { agents: async () => ({ agents }), send }, now: () => Date.now(), researchRunId: "run-1",
    runId: "run-1", sources: { opened: async () => [] }, userFollowups: async () => [], userId: "user", userMessage: "", ...extra };
  return { extendTurn, run, send };
}

const time = RESEARCH_TIME_MS;
const justBefore = (ms: number) => ms - 1;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a run's research clock", () => {
  it("is an ordinary turn before the release: no refusal, the turn's own gates, and no extension", () => {
    const { extendTurn, run } = scope();
    const clock = createResearchClock(run);
    vi.advanceTimersByTime(time.stopRunningResearchers);
    expect(clock.phase()).toBe("scoping");
    expect(clock.researcherRefusal()).toBeNull();
    expect(clock.gatesEndAt(1_234)).toBe(1_234);
    expect(extendTurn).not.toHaveBeenCalled();
  });

  it("walks the phases from the release, each at its minute", () => {
    vi.advanceTimersByTime(7 * 60_000);
    const clock = createResearchClock(scope().run);
    clock.planReleased();
    const releasedAt = Date.now();
    const at = (ms: number) => { vi.setSystemTime(releasedAt + ms); return clock.phase(); };
    expect(at(0)).toBe("researching");
    expect(at(justBefore(time.stopStartingResearchers))).toBe("researching");
    expect(at(time.stopStartingResearchers)).toBe("winding_down");
    expect(at(time.stopRunningResearchers)).toBe("reporting");
    expect(at(time.notes)).toBe("notes");
    expect(at(time.hardEnd)).toBe("ended");
  });

  it("moves the turn to the hard end from the release, and only the first release counts: a model may start twice", () => {
    const { extendTurn, run } = scope();
    const clock = createResearchClock(run);
    clock.planReleased();
    const releasedAt = Date.now();
    vi.advanceTimersByTime(60_000);
    clock.planReleased();
    expect(extendTurn).toHaveBeenCalledExactlyOnceWith(releasedAt + time.hardEnd);
    expect(clock.gatesEndAt(0)).toBe(releasedAt + time.notes);
  });

  it("refuses a researcher from minute 60 with a reason the model can read", () => {
    const clock = createResearchClock(scope().run);
    clock.planReleased();
    vi.advanceTimersByTime(justBefore(time.stopStartingResearchers));
    expect(clock.researcherRefusal()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(clock.researcherRefusal()).toBe(RESEARCHERS_CLOSED);
  });

  it("tells running researchers to finish at minute 60 and no others, once", async () => {
    const { run, send } = scope([agent("alpha", "running"), agent("beta", "done"), agent("gamma", "waiting")]);
    const clock = createResearchClock(run);
    clock.planReleased();
    await vi.advanceTimersByTimeAsync(justBefore(time.stopStartingResearchers));
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send.mock.calls.map(([message]) => message.to)).toEqual(["alpha", "gamma"]);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ chatId: "chat", from: MAIN_AGENT_NAME, parentRunId: "run-1", text: RESEARCHERS_FINISH, userId: "user" }));
    await vi.advanceTimersByTimeAsync(time.hardEnd);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("goes on without a mailbox, and a mailbox that fails costs the warning, not the stop at minute 70", async () => {
    const quiet = createResearchClock(scope([], { mailbox: undefined }).run);
    quiet.planReleased();
    await vi.advanceTimersByTimeAsync(time.stopStartingResearchers);
    const failing = createResearchClock(scope([], { mailbox: { agents: async () => { throw new Error("unavailable"); }, send: vi.fn() } }).run);
    failing.planReleased();
    await vi.advanceTimersByTimeAsync(time.stopStartingResearchers);
    const signal = failing.researcherSignal(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(time.stopRunningResearchers - time.stopStartingResearchers);
    expect(signal.aborted).toBe(true);
  });

  it("ends a researcher at its own limit, however much research time is left", () => {
    const clock = createResearchClock(scope().run);
    clock.planReleased();
    const signal = clock.researcherSignal(new AbortController().signal);
    vi.advanceTimersByTime(justBefore(time.researcherTurn));
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it("gives a researcher started late less than its limit: minute 70 ends it", () => {
    const clock = createResearchClock(scope().run);
    clock.planReleased();
    vi.advanceTimersByTime(justBefore(time.stopStartingResearchers));
    const signal = clock.researcherSignal(new AbortController().signal);
    vi.advanceTimersByTime(time.stopRunningResearchers - time.stopStartingResearchers);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
  });

  it("carries a researcher that started before the release in its batch: its limit runs from its start, and minute 70 still ends one", () => {
    const clock = createResearchClock(scope().run);
    const signal = clock.researcherSignal(new AbortController().signal);
    vi.advanceTimersByTime(60_000);
    clock.planReleased();
    vi.advanceTimersByTime(time.researcherTurn - 60_000);
    expect(signal.aborted).toBe(true);
    const late = clock.researcherSignal(new AbortController().signal);
    vi.advanceTimersByTime(time.researcherTurn - 1);
    expect(late.aborted).toBe(false);
    vi.advanceTimersByTime(time.stopRunningResearchers - 2 * time.researcherTurn + 2);
    expect(late.aborted).toBe(true);
  });

  it("follows Stop at once with Stop's own reason", () => {
    const stop = new AbortController();
    const clock = createResearchClock(scope().run);
    clock.planReleased();
    const signal = clock.researcherSignal(stop.signal);
    stop.abort(new Error("stopped"));
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).message).toBe("stopped");
  });

  it("lets a researcher's limit go with the signal it hangs on, so no timer outlives the call", () => {
    const clock = createResearchClock(scope().run);
    const pending = vi.getTimerCount();
    const call = new AbortController();
    clock.researcherSignal(call.signal);
    expect(vi.getTimerCount()).toBe(pending + 1);
    call.abort();
    expect(vi.getTimerCount()).toBe(pending);
  });

  it("differs from the no-op in everything a run asks of it", () => {
    const clock = createResearchClock(scope().run);
    clock.planReleased();
    vi.advanceTimersByTime(time.stopStartingResearchers);
    expect(clock.phase()).not.toBe(NOOP_RESEARCH_PORTS.time.phase());
    expect(clock.researcherRefusal()).not.toBe(NOOP_RESEARCH_PORTS.time.researcherRefusal());
    const signal = new AbortController().signal;
    expect(clock.researcherSignal(signal)).not.toBe(signal);
  });
});
