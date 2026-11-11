import { describe, expect, it } from "vitest";
import { SUBAGENT_BLOCKED_REASONS, SUBAGENT_END_REASONS, SUBAGENT_WAIT_REASONS } from "@/lib/contracts/subagents";
import type { SubagentThreadSummary } from "@/lib/contracts/subagentViews";
import { subagentChat, subagentThread } from "@/tests/support/subagentViewFixtures";
import { subagentCountsPhrase, subagentDetailText, subagentMessageLabel, subagentModelText, subagentReasonText, subagentStatePresentation, subagentTreeRows,
  subagentWaitingKeyV2, subagentWorkingPhrase } from "./subagentPresentation";

describe("a sub-agent's row words", () => {
  const row = { currentStep: null, outcome: null, reason: null, state: "running" } as const;

  it("words the server's step, and never invents one", () => {
    expect(subagentDetailText({ ...row, currentStep: { origin: "web_search", toolName: "web_search" } })).toBe("Searching the web…");
    expect(subagentDetailText({ ...row, currentStep: { fetchTarget: "example.com/a", origin: "web_fetch", toolName: "fetch_url" } }))
      .toBe("Reading example.com/a…");
    expect(subagentDetailText({ ...row, currentStep: { fetchTarget: "example.com/a", fetchProxyName: "Personal route",
      origin: "web_fetch", toolName: "fetch_url" } })).toBe("Reading example.com/a via proxy “Personal route”…");
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
    expect(subagentMessageLabel({ createdAt: at, delivery: "accepted", question: true, text: "x", to: "research" })).toBe("Question to research");
    expect(subagentMessageLabel({ createdAt: at, delivery: "accepted", from: "left", question: true, text: "x" })).toBe("Question from left · Sent");
  });
});

describe("a child in the tree", () => {
  const parent = { id: "thread-parent", name: "parent" };
  const chat = (threads: readonly SubagentThreadSummary[]) => subagentChat("chat-1", threads);
  const rows = (threads: readonly SubagentThreadSummary[]) => subagentTreeRows(chat(threads)).map(({ depth, thread }) => [thread.name, depth]);

  it("sits right under its parent, active rows first as ever", () => {
    expect(rows([
      subagentThread("thread-other", "done"),
      subagentThread("thread-left", "done", { parent }),
      subagentThread("thread-parent", "running"),
      subagentThread("thread-right", "running", { parent })
    ])).toEqual([["parent", 0], ["right", 1], ["left", 1], ["other", 0]]);
  });

  it("stands on its own when the list left its parent out, so no row is lost", () => {
    expect(rows([subagentThread("thread-left", "done", { parent })])).toEqual([["left", 0]]);
  });

  it("says what it waits for and how it stopped by its parent's name", () => {
    expect(subagentStatePresentation("waiting", null, SUBAGENT_WAIT_REASONS.answer, "research").label).toBe("Waiting for research");
    expect(subagentStatePresentation("waiting", null, SUBAGENT_WAIT_REASONS.answer).label).toBe("Waiting for the main agent");
    expect(subagentReasonText(SUBAGENT_END_REASONS.parentStopped, "research")).toBe("Stopped with research");
    expect(subagentReasonText(SUBAGENT_END_REASONS.stoppedByAgent, "research")).toBe("Stopped by research");
    expect(subagentReasonText(SUBAGENT_BLOCKED_REASONS.needsAnswer, "research")).toBe("Asked research a question");
    expect(subagentReasonText(SUBAGENT_END_REASONS.stoppedByUser, "research")).toBe("Stopped by you");
    expect(subagentReasonText(SUBAGENT_END_REASONS.parentStopped)).toBe("Stopped with its answer");
    expect(subagentDetailText(subagentThread("thread-left", "stopped", { parent, reason: SUBAGENT_END_REASONS.parentStopped }))).toBe("Stopped with parent");
  });

  it("says why a sub-agent failed on its model provider, and shows no identifier for a code it does not know", () => {
    expect(subagentReasonText("provider_stream_failed")).toBe("The model provider's answer broke off");
    expect(subagentReasonText("provider_request_timed_out")).toBe("The model provider did not answer in time");
    expect(subagentDetailText(subagentThread("thread-left", "failed", { reason: "provider_stream_timeout" })))
      .toBe("The model provider stopped sending its answer");
    expect(subagentReasonText("subagent_failed")).toBeNull();
    expect(subagentDetailText(subagentThread("thread-left", "failed", { reason: "subagent_failed" }))).toBe("Failed");
  });
});
