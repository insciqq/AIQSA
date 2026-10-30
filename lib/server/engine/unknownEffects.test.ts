import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem, TranscriptToolCallItem, TranscriptToolResultItem, TranscriptUserItem } from "./transcript";
import { createAgentUnknownEffects, createUnknownEffects, unknownEffectsOf, withHiddenRunEffects, withRetiredEffects } from "./unknownEffects";

const recordedAt = new Date("2026-10-29T12:00:00Z");
const create = (callId: string, title = "one issue"): TranscriptToolCallItem =>
  ({ arguments: JSON.stringify({ title }), callId, id: `call-${callId}`, kind: "tool_call", recordedAt, name: "mcp_jira_create" });
const result = (callId: string, outcome: "complete" | "error" | "unknown"): TranscriptToolResultItem =>
  ({ callId, id: `result-${callId}-${outcome}`, kind: "tool_result", recordedAt, name: "mcp_jira_create", outcome, output: "x" });
const later = new Date(recordedAt.getTime() + 60_000);
const user = (id: string): TranscriptUserItem => ({ id, kind: "user", text: "Go on" });
const userAuthored = (item: TranscriptUserItem) => !item.id.startsWith("server-");
const call = (title = "one issue") => ({ arguments: { title }, name: "mcp_jira_create" });

describe("unknown effects on a branch", () => {
  it("fences a lost result at its call record and a continuation at its newer in-flight record", () => {
    const continuedAt = new Date(recordedAt.getTime() + 1_000);
    const lostAt = new Date(continuedAt.getTime() + 1_000);
    const inFlight: TranscriptToolResultItem = { ...result("c1", "unknown"), inFlight: true, recordedAt: continuedAt };
    expect(unknownEffectsOf([create("c1"), user("u2")], userAuthored).find(call())?.after).toEqual(recordedAt);
    const continued = [create("c1"), result("c1", "error"), inFlight];
    expect(unknownEffectsOf([...continued, user("u2")], userAuthored).find(call()))
      .toEqual({ after: continuedAt, userSpokeSince: true });
    expect(unknownEffectsOf([...continued, { ...result("c1", "unknown"), recordedAt: lostAt }], userAuthored)
      .find(call())?.after).toEqual(lostAt);
  });

  it("keeps the newest fence across uncertain attempts and later definite failures", () => {
    const effects = createUnknownEffects();
    const latest = new Date(recordedAt.getTime() + 1_000);
    effects.record(call(), "unknown", latest);
    effects.record(call(), "unknown", recordedAt);
    effects.record(call(), "error");
    effects.userSpoke();
    expect(effects.find(call())).toEqual({ after: latest, userSpokeSince: true });
  });

  it("fails toward a new decision when the uncertain attempt has no trusted timestamp", () => {
    vi.useFakeTimers();
    try {
      const now = new Date(recordedAt.getTime() + 60_000);
      vi.setSystemTime(now);
      const withoutTime = { ...create("c1"), recordedAt: undefined };
      expect(unknownEffectsOf([withoutTime, user("u2")], userAuthored).find(call()))
        .toEqual({ after: now, userSpokeSince: true });
    } finally { vi.useRealTimers(); }
  });

  it("keeps an unknown outcome across turns until an equivalent call completes", () => {
    expect(unknownEffectsOf([user("u1"), create("c1"), result("c1", "unknown")], userAuthored).find(call()))
      .toEqual({ after: recordedAt, userSpokeSince: false });
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown"), user("u2")], userAuthored).find(call()))
      .toEqual({ after: recordedAt, userSpokeSince: true });
    // A definite error of a later call does not say whether the first one took effect.
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown"), create("c2"), result("c2", "error")], userAuthored)
      .find(call())).not.toBeNull();
    // A later completion settles it; one at the same moment does not (ties keep the fence).
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown"), create("c2"), { ...result("c2", "complete"), recordedAt: later }],
      userAuthored).find(call())).toBeNull();
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown"), create("c2"), result("c2", "complete")], userAuthored)
      .find(call())).not.toBeNull();
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown")], userAuthored).find(call("another issue"))).toBeNull();
  });

  it("counts a call a stopped run left without a result, and an approved call's later result", () => {
    expect(unknownEffectsOf([create("c1"), user("u2")], userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: true });
    expect(unknownEffectsOf([user("u1"), create("c1")], userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: false });
    // Waiting for approval, then sent by the continuation with an unknown outcome.
    expect(unknownEffectsOf([create("c1"), result("c1", "error"), result("c1", "unknown")], userAuthored).find(call()))
      .toEqual({ after: recordedAt, userSpokeSince: false });
  });

  it("lets an approved call's own result settle its in-flight record, and keeps it unknown without one", () => {
    const inFlight: TranscriptItem = { callId: "c1", id: "in-flight-c1", inFlight: true, kind: "tool_result", recordedAt, name: "mcp_jira_create",
      outcome: "unknown", output: "x" };
    const approved = [create("c1"), result("c1", "error"), inFlight];
    // Its own definite result settles it, a "not sent" included; an unknown one stays unknown.
    expect(unknownEffectsOf([...approved, result("c1", "error")], userAuthored).find(call())).toBeNull();
    expect(unknownEffectsOf([...approved, result("c1", "complete")], userAuthored).find(call())).toBeNull();
    expect(unknownEffectsOf([...approved, result("c1", "unknown")], userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: false });
    // Interrupted before its result was recorded: unknown, like any call left without one.
    expect(unknownEffectsOf(approved, userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: false });
    expect(unknownEffectsOf([...approved, user("u2")], userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: true });
  });

  it("counts only the user's own words as the user speaking", () => {
    const items = [create("c1"), result("c1", "unknown"), user("server-continuation")];
    expect(unknownEffectsOf(items, userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: false });
    const effects = unknownEffectsOf(items, userAuthored);
    effects.userSpoke();
    expect(effects.find(call())).toEqual({ after: recordedAt, userSpokeSince: true });
  });
});

// Regression (codex review): an old-core write reached its server, then the upgrade retired its run with the outcome
// unknown; the native conversation carries that answer as text alone, so the guard must still find the effect.
describe("unknown effects the old core left on a branch", () => {
  const say = (id: string, role: "assistant" | "user") => ({ id, role });
  const messages = [say("q1", "user"), say("a1", "assistant"), say("q2", "user"), say("a2", "assistant"), say("current", "user")];
  const question = (id: string): TranscriptItem => ({ id: `msg-${id}`, kind: "user", text: "x" });
  const answer = (id: string): TranscriptItem => ({ id: `msg-${id}`, kind: "assistant_text", text: "x" });
  const branch = [question("q1"), answer("a1"), question("q2"), answer("a2"), question("current")];
  const retired = (userMessageId: string) => [{ items: [create("r1"), result("r1", "unknown")], userMessageId }];

  it("finds an old answer's unknown write, which its text alone hides", () => {
    expect(unknownEffectsOf(branch, userAuthored).find(call())).toBeNull();
    const items = withRetiredEffects(branch, messages, retired("q1"));
    // Its records follow the old turn and come before the branch's next question.
    expect(items.map((item) => item.id)).toEqual(["msg-q1", "msg-a1", "call-r1", "result-r1-unknown", "msg-q2", "msg-a2",
      "msg-current"]);
    expect(unknownEffectsOf(items, userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: true });
    // Only the user's later words count: a turn the server wrote right after the old one leaves it unspoken.
    const last = withRetiredEffects(branch, messages, retired("q2"));
    expect(last.map((item) => item.id).slice(-3)).toEqual(["call-r1", "result-r1-unknown", "msg-current"]);
    expect(unknownEffectsOf(last, (item) => item.id !== "msg-current").find(call())).toEqual({ after: recordedAt, userSpokeSince: false });
  });

  it("lets a later equivalent call that completed settle it, and keeps it when the old answer stopped without text", () => {
    const settled = withRetiredEffects([...branch.slice(0, 3), create("n1"), { ...result("n1", "complete"), recordedAt: later },
      ...branch.slice(3)], messages,
      retired("q1"));
    expect(unknownEffectsOf(settled, userAuthored).find(call())).toBeNull();
    // An answer left out of the context (no text) still places its records after its question.
    const kept = withRetiredEffects(branch.filter((item) => item.id !== "msg-a1"),
      messages.filter((message) => message.id !== "a1"), retired("q1"));
    expect(kept.map((item) => item.id).slice(0, 3)).toEqual(["msg-q1", "call-r1", "result-r1-unknown"]);
    expect(unknownEffectsOf(kept, userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: true });
  });

  it("puts a run whose question left the branch first, passes follow-ups, and adds nothing without old runs", () => {
    expect(withRetiredEffects(branch, messages, retired("gone")).slice(0, 2).map((item) => item.id))
      .toEqual(["call-r1", "result-r1-unknown"]);
    expect(withRetiredEffects(branch, messages, [])).toEqual(branch);
    // A follow-up into the old answer is not a turn of its own: the records still go before the next real question.
    const withFollowup = withRetiredEffects([branch[0]!, question("f1"), ...branch.slice(1)],
      [messages[0]!, { contextTurnId: "q1", id: "f1", role: "user" }, ...messages.slice(1)], retired("q1"));
    expect(withFollowup.map((item) => item.id).slice(0, 5)).toEqual(["msg-q1", "msg-f1", "msg-a1", "call-r1", "result-r1-unknown"]);
  });

  it("puts a hidden review step's calls, never its text, before the turn that followed it", () => {
    const step = [{ id: "critique", kind: "assistant_text", text: "x" } as TranscriptItem, create("s1")];
    const items = withHiddenRunEffects(branch, [{ beforeItemId: "msg-current", items: step }]);
    expect(items.map((item) => item.id).slice(-2)).toEqual(["call-s1", "msg-current"]);
    // Cut off before the user's words: unknown, and spoken since.
    expect(unknownEffectsOf(items, userAuthored).find(call())).toEqual({ after: recordedAt, userSpokeSince: true });
    // A turn the conversation does not hold puts them last, unspoken.
    expect(withHiddenRunEffects(branch, [{ beforeItemId: "msg-gone", items: step }]).map((item) => item.id).at(-1)).toBe("call-s1");
    expect(withHiddenRunEffects(branch, [])).toEqual(branch);
  });
});

describe("a run's agent fences (integrator decision 2026-10-30)", () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, 0, ms));

  it("delayed persistence must preserve uncertainty: another agent's completion never settles an unknown effect", () => {
    const fences = createAgentUnknownEffects();
    // The main agent completed the write at 1000, but its batch persisted the success at 3000.
    unknownEffectsOf([{ ...create("m1"), recordedAt: at(1000) }, { ...result("m1", "complete"), recordedAt: at(3000) }], () => false,
      fences.agent("main"));
    // A sub-agent's equivalent write, sent at 1500, lost its response at 2000.
    unknownEffectsOf([{ ...create("t1"), recordedAt: at(1500) }, { ...result("t1", "unknown"), recordedAt: at(2000) }], () => false,
      fences.agent("thread-1"));
    expect(fences.agent("main").find(call())).toEqual({ after: at(2000), userSpokeSince: false });
    // Fed the other way round, the same.
    const reversed = createAgentUnknownEffects();
    unknownEffectsOf([{ ...create("t1"), recordedAt: at(1500) }, { ...result("t1", "unknown"), recordedAt: at(2000) }], () => false,
      reversed.agent("thread-1"));
    unknownEffectsOf([{ ...create("m1"), recordedAt: at(1000) }, { ...result("m1", "complete"), recordedAt: at(3000) }], () => false,
      reversed.agent("main"));
    expect(reversed.agent("thread-2").find(call())).toEqual({ after: at(2000), userSpokeSince: false });
  });

  it("unordered ties must preserve uncertainty", () => {
    const fence = createUnknownEffects();
    fence.record(call(), "unknown", at(500));
    fence.record(call(), "complete", at(500));
    expect(fence.find(call())).toEqual({ after: at(500), userSpokeSince: false });
  });

  it("lets an agent's own later completion settle its own unknown effect, and the user speaking reach every fence", () => {
    const fences = createAgentUnknownEffects();
    const thread = fences.agent("thread-1");
    thread.record(call(), "unknown", at(100));
    fences.agent("main").record(call("other"), "unknown", at(100));
    fences.agent("main").userSpoke();
    expect(thread.find(call())).toEqual({ after: at(100), userSpokeSince: true });
    expect(thread.find(call("other"))).toEqual({ after: at(100), userSpokeSince: true });
    thread.record(call(), "complete", at(200));
    expect(fences.agent("main").find(call())).toBeNull();
  });
});
