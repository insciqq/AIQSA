import { describe, expect, it } from "vitest";
import { subagentCountsPhrase, subagentDetailText, subagentModelText, subagentWaitingKeyV2 } from "./subagentPresentation";

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
    const done = { outcome: "done", state: "done" } as const;
    const running = { outcome: null, state: "running" } as const;
    expect(subagentCountsPhrase(5, [done, done, done, running, running])).toBe("5 sub-agents · 3 done, 2 running");
    expect(subagentCountsPhrase(4, [])).toBe("4 sub-agents");
  });
});

describe("subagentWaitingKeyV2", () => {
  it("keys the sub-agents that wait for the user, in a stable order, and is null when none waits", () => {
    expect(subagentWaitingKeyV2([{ id: "b", state: "waiting" }, { id: "c", state: "running" }, { id: "a", state: "waiting" }]))
      .toBe("a,b");
    expect(subagentWaitingKeyV2([{ id: "c", state: "running" }, { id: "d", state: "done" }])).toBeNull();
    expect(subagentWaitingKeyV2([])).toBeNull();
  });
});
