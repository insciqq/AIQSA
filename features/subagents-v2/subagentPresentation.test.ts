import { describe, expect, it } from "vitest";
import { subagentCountsPhrase, subagentDetailText, subagentMessageLabel, subagentModelText, subagentStatePresentation, subagentWaitingKeyV2,
  subagentWorkingPhrase } from "./subagentPresentation";

describe("a sub-agent's row words", () => {
  const row = { currentStep: null, outcome: null, reason: null, state: "running" } as const;

  it("words the server's step, and never invents one", () => {
    expect(subagentDetailText({ ...row, currentStep: { origin: "web_search", toolName: "web_search" } })).toBe("Searching the web…");
    expect(subagentDetailText({ ...row, currentStep: { fetchTarget: "example.com/a", origin: "web_fetch", toolName: "fetch_url" } }))
      .toBe("Reading example.com/a…");
    expect(subagentDetailText({ ...row, currentStep: { origin: "mcp", serverName: "Jira", toolName: "find_issue" } })).toBe("Using Jira: find issue…");
    expect(subagentDetailText(row)).toBe("Working…");
  });

  it("says how it ended, by its reason when that says more", () => {
    expect(subagentDetailText({ ...row, state: "waiting" })).toBe("Waiting for you");
    expect(subagentDetailText({ ...row, outcome: "partial", state: "done" })).toBe("Partly done");
    expect(subagentDetailText({ ...row, outcome: "blocked", reason: "sign_in_required", state: "done" })).not.toBe("sign_in_required");
    expect(subagentDetailText({ ...row, reason: "unknown_code", state: "failed" })).toBe("Failed");
  });

  it("names the model and effort that ran, and nothing for an older row", () => {
    expect(subagentModelText({ displayName: "GPT-6 Luna", effort: "high" })).toBe("GPT-6 Luna · high");
    expect(subagentModelText({ displayName: "GPT-6 Luna", effort: null })).toBe("GPT-6 Luna");
    expect(subagentModelText(null)).toBeNull();
  });

  it("counts states truthfully and claims none it does not know", () => {
    const done = { outcome: "done", reason: null, state: "done" } as const;
    const running = { outcome: null, reason: null, state: "running" } as const;
    expect(subagentCountsPhrase(5, [done, done, done, running, running])).toBe("5 sub-agents · 3 done, 2 running");
    expect(subagentCountsPhrase(4, [])).toBe("4 sub-agents");
  });
});

describe("subagentWaitingKeyV2", () => {
  it("keys the sub-agents that wait for the user, in a stable order, and is null when none waits", () => {
    expect(subagentWaitingKeyV2([{ id: "b", reason: null, state: "waiting" }, { id: "c", reason: null, state: "running" }, { id: "a", reason: null, state: "waiting" }]))
      .toBe("a,b");
    expect(subagentWaitingKeyV2([{ id: "c", reason: null, state: "running" }, { id: "d", reason: null, state: "done" }])).toBeNull();
    expect(subagentWaitingKeyV2([])).toBeNull();
  });

  it("leaves out a sub-agent waiting for the main agent: nothing opens for the user", () => {
    expect(subagentWaitingKeyV2([{ id: "a", reason: "waiting_for_answer", state: "waiting" }])).toBeNull();
  });
});

describe("a sub-agent waiting for the main agent", () => {
  const asking = { reason: "waiting_for_answer", state: "waiting" } as const;

  it("reads in plain words and asks nothing of the user", () => {
    expect(subagentStatePresentation("waiting", null, "waiting_for_answer")).toEqual({ icon: "bot", label: "Waiting for the main agent", tone: "neutral" });
    expect(subagentStatePresentation("waiting")).toMatchObject({ label: "Waiting for you", tone: "warn" });
    expect(subagentDetailText({ currentStep: null, outcome: null, ...asking })).toBe("Waiting for the main agent");
  });

  it("counts apart from what waits for the user", () => {
    expect(subagentWorkingPhrase([asking])).toBe("1 sub-agent waiting for the main agent");
    expect(subagentWorkingPhrase([{ reason: null, state: "running" }, { reason: null, state: "waiting" }, asking]))
      .toBe("1 sub-agent working · 1 waiting for you · 1 waiting for the main agent");
    expect(subagentCountsPhrase(2, [{ outcome: "done", reason: null, state: "done" }, { outcome: null, ...asking }]))
      .toBe("2 sub-agents · 1 done, 1 waiting for the main agent");
  });
});

describe("a message row of a thread", () => {
  const at = "2026-10-31T10:00:00.000Z";

  it("names who wrote it or who it went to, and how far it got", () => {
    expect(subagentMessageLabel({ createdAt: at, delivery: "delivered", text: "x" })).toBe("Message from the main agent · Read by the sub-agent");
    expect(subagentMessageLabel({ createdAt: at, delivery: "accepted", from: "scout", text: "x" })).toBe("Message from scout · Sent");
    expect(subagentMessageLabel({ createdAt: at, delivery: "undelivered", from: "scout", text: "x" })).toBe("Message from scout · Not delivered");
    expect(subagentMessageLabel({ createdAt: at, delivery: "accepted", text: "x", to: "scout" })).toBe("Message to scout");
    expect(subagentMessageLabel({ createdAt: at, delivery: "accepted", question: true, text: "x", to: "main" })).toBe("Question to the main agent");
  });
});
