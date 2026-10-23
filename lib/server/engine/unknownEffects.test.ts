import { describe, expect, it } from "vitest";
import type { TranscriptItem, TranscriptUserItem } from "./transcript";
import { unknownEffectsOf } from "./unknownEffects";

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

  it("counts only the user's own words as the user speaking", () => {
    const items = [create("c1"), result("c1", "unknown"), user("server-continuation")];
    expect(unknownEffectsOf(items, userAuthored).find(call())).toEqual({ userSpokeSince: false });
    const effects = unknownEffectsOf(items, userAuthored);
    effects.userSpoke();
    expect(effects.find(call())).toEqual({ userSpokeSince: true });
  });
});
