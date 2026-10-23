import { describe, expect, it } from "vitest";
import type { TranscriptItem, TranscriptUserItem } from "./transcript";
import { unknownEffectsOf, withRetiredEffects } from "./unknownEffects";

const create = (callId: string, title = "one issue"): TranscriptItem =>
  ({ arguments: JSON.stringify({ title }), callId, id: `call-${callId}`, kind: "tool_call", name: "mcp_jira_create" });
const result = (callId: string, outcome: "complete" | "error" | "unknown"): TranscriptItem =>
  ({ callId, id: `result-${callId}-${outcome}`, kind: "tool_result", name: "mcp_jira_create", outcome, output: "x" });
const user = (id: string): TranscriptUserItem => ({ id, kind: "user", text: "Go on" });
const userAuthored = (item: TranscriptUserItem) => !item.id.startsWith("server-");
const call = (title = "one issue") => ({ arguments: { title }, name: "mcp_jira_create" });

describe("unknown effects on a branch", () => {
  it("keeps an unknown outcome across turns until an equivalent call completes", () => {
    expect(unknownEffectsOf([user("u1"), create("c1"), result("c1", "unknown")], userAuthored).find(call()))
      .toEqual({ userSpokeSince: false });
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown"), user("u2")], userAuthored).find(call()))
      .toEqual({ userSpokeSince: true });
    // A definite error of a later call does not say whether the first one took effect.
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown"), create("c2"), result("c2", "error")], userAuthored)
      .find(call())).not.toBeNull();
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown"), create("c2"), result("c2", "complete")], userAuthored)
      .find(call())).toBeNull();
    expect(unknownEffectsOf([create("c1"), result("c1", "unknown")], userAuthored).find(call("another issue"))).toBeNull();
  });

  it("counts a call a stopped run left without a result, and an approved call's later result", () => {
    expect(unknownEffectsOf([create("c1"), user("u2")], userAuthored).find(call())).toEqual({ userSpokeSince: true });
    expect(unknownEffectsOf([user("u1"), create("c1")], userAuthored).find(call())).toEqual({ userSpokeSince: false });
    // Waiting for approval, then sent by the continuation with an unknown outcome.
    expect(unknownEffectsOf([create("c1"), result("c1", "error"), result("c1", "unknown")], userAuthored).find(call()))
      .toEqual({ userSpokeSince: false });
  });

  it("lets an approved call's own result settle its in-flight record, and keeps it unknown without one", () => {
    const inFlight: TranscriptItem = { callId: "c1", id: "in-flight-c1", inFlight: true, kind: "tool_result", name: "mcp_jira_create",
      outcome: "unknown", output: "x" };
    const approved = [create("c1"), result("c1", "error"), inFlight];
    // Its own definite result settles it, a "not sent" included; an unknown one stays unknown.
    expect(unknownEffectsOf([...approved, result("c1", "error")], userAuthored).find(call())).toBeNull();
    expect(unknownEffectsOf([...approved, result("c1", "complete")], userAuthored).find(call())).toBeNull();
    expect(unknownEffectsOf([...approved, result("c1", "unknown")], userAuthored).find(call())).toEqual({ userSpokeSince: false });
    // Interrupted before its result was recorded: unknown, like any call left without one.
    expect(unknownEffectsOf(approved, userAuthored).find(call())).toEqual({ userSpokeSince: false });
    expect(unknownEffectsOf([...approved, user("u2")], userAuthored).find(call())).toEqual({ userSpokeSince: true });
  });

  it("counts only the user's own words as the user speaking", () => {
    const items = [create("c1"), result("c1", "unknown"), user("server-continuation")];
    expect(unknownEffectsOf(items, userAuthored).find(call())).toEqual({ userSpokeSince: false });
    const effects = unknownEffectsOf(items, userAuthored);
    effects.userSpoke();
    expect(effects.find(call())).toEqual({ userSpokeSince: true });
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
    expect(unknownEffectsOf(items, userAuthored).find(call())).toEqual({ userSpokeSince: true });
    // Only the user's later words count: a turn the server wrote right after the old one leaves it unspoken.
    const last = withRetiredEffects(branch, messages, retired("q2"));
    expect(last.map((item) => item.id).slice(-3)).toEqual(["call-r1", "result-r1-unknown", "msg-current"]);
    expect(unknownEffectsOf(last, (item) => item.id !== "msg-current").find(call())).toEqual({ userSpokeSince: false });
  });

  it("lets a later equivalent call that completed settle it, and keeps it when the old answer stopped without text", () => {
    const settled = withRetiredEffects([...branch.slice(0, 3), create("n1"), result("n1", "complete"), ...branch.slice(3)], messages,
      retired("q1"));
    expect(unknownEffectsOf(settled, userAuthored).find(call())).toBeNull();
    // An answer left out of the context (no text) still places its records after its question.
    const kept = withRetiredEffects(branch.filter((item) => item.id !== "msg-a1"),
      messages.filter((message) => message.id !== "a1"), retired("q1"));
    expect(kept.map((item) => item.id).slice(0, 3)).toEqual(["msg-q1", "call-r1", "result-r1-unknown"]);
    expect(unknownEffectsOf(kept, userAuthored).find(call())).toEqual({ userSpokeSince: true });
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
});
