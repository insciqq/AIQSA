import { describe, expect, it } from "vitest";
import {
  SUBAGENT_LIMITS,
  SUBAGENT_TOOL_GROUPS,
  boundSubagentReport,
  decodeSubagentActivityRef,
  decodeSubagentCallResult,
  decodeSubagentToolGroups,
  isActiveSubagentState,
  isSubagentCode,
  isSubagentTurnOnBranch,
  normalizeSubagentName,
  projectSubagentThreadState,
  subagentCallbackNonce,
  subagentCallbackOwed
} from "./subagents";

const ended = {
  approvals: [{ arguments: { id: 7 }, reason: "approval_required", serverName: "Shop", toolName: "shop__order" }],
  files: ["research/amazon.md"],
  kind: "ended",
  model: { effort: "low", id: "gpt-6-luna" },
  name: "shop-amazon",
  outcome: "blocked",
  reason: "needs_approval",
  report: "Found three candidates.",
  state: "done",
  steps: [{ outcome: "complete", summary: "[browser #2 · amazon] open: search results", tool: "Workspace command" },
    { outcome: "unknown", summary: "", tool: "Shop order" }]
};

describe("sub-agent names", () => {
  it("accepts a lowercase slug, normalizing case and spaces, and refuses everything else", () => {
    expect(normalizeSubagentName("  Shop-Amazon ")).toBe("shop-amazon");
    expect(normalizeSubagentName("a")).toBe("a");
    expect(normalizeSubagentName("x".repeat(SUBAGENT_LIMITS.nameCharacters))).toBe("x".repeat(48));
    for (const name of ["", "-lead", "trail_", "two words", "кириллица", "x".repeat(49), "main", 7, null]) {
      expect(normalizeSubagentName(name)).toBeNull();
    }
  });
});

describe("sub-agent states", () => {
  it("counts running and waiting as active and every other state as final", () => {
    expect(["running", "waiting"].every(isActiveSubagentState)).toBe(true);
    expect(["done", "stopped", "failed", "interrupted", "queued"].some(isActiveSubagentState)).toBe(false);
  });

  it("projects a thread from its latest turn on the branch, and hides it with none there", () => {
    expect(projectSubagentThreadState([])).toBeNull();
    expect(projectSubagentThreadState([
      { startedAt: "2026-10-29T10:00:00.000Z", state: "done" },
      { startedAt: new Date("2026-10-29T11:00:00.000Z"), state: "running" },
      { startedAt: "2026-10-29T09:00:00.000Z", state: "failed" }
    ])).toBe("running");
    // Of turns that started together the later row wins; an unreadable time never does.
    expect(projectSubagentThreadState([
      { startedAt: "2026-10-29T10:00:00.000Z", state: "done" },
      { startedAt: "2026-10-29T10:00:00.000Z", state: "interrupted" },
      { startedAt: "not a time", state: "running" }
    ])).toBe("interrupted");
  });

  it("puts a turn on a branch only through its parent run's answer", () => {
    const branch = new Set(["question-1", "answer-1", "question-2", "answer-2"]);
    expect(isSubagentTurnOnBranch("answer-2", branch)).toBe(true);
    // A regenerated sibling answer and a run without an answer are off the branch.
    expect(isSubagentTurnOnBranch("answer-2b", branch)).toBe(false);
    expect(isSubagentTurnOnBranch(null, branch)).toBe(false);
  });

  it("gives each turn's callback follow-up one nonce within the follow-up store's bound", () => {
    const nonce = subagentCallbackNonce("8b5a4f0e-1c2d-4e5f-9a0b-1c2d3e4f5a6b");
    expect(nonce).toBe("subagent-callback:8b5a4f0e-1c2d-4e5f-9a0b-1c2d3e4f5a6b");
    expect(nonce.length).toBeLessThanOrEqual(128);
    expect(subagentCallbackNonce("turn-1")).not.toBe(subagentCallbackNonce("turn-2"));
  });

  it("owes a callback only for an ended background turn nobody received", () => {
    expect(subagentCallbackOwed({ callbackRunId: null, mode: "background", state: "done" })).toBe(true);
    expect(subagentCallbackOwed({ callbackRunId: null, mode: "background", state: "interrupted" })).toBe(true);
    expect(subagentCallbackOwed({ callbackRunId: "run-2", mode: "background", state: "done" })).toBe(false);
    expect(subagentCallbackOwed({ callbackRunId: null, mode: "background", state: "running" })).toBe(false);
    expect(subagentCallbackOwed({ callbackRunId: null, mode: "foreground", state: "done" })).toBe(false);
  });
});

describe("call_subagent results", () => {
  it("decodes an ended turn exactly, with its approvals and steps", () => {
    expect(decodeSubagentCallResult(ended)).toEqual(ended);
    expect(decodeSubagentCallResult({ ...ended, outcome: undefined, reason: "deadline", state: "stopped" }))
      .toEqual({ ...ended, outcome: undefined, reason: "deadline", state: "stopped" });
  });

  it("decodes a background start and a delivered message", () => {
    expect(decodeSubagentCallResult({ continued: false, kind: "started", name: "shop-amazon", state: "running" }))
      .toEqual({ continued: false, kind: "started", name: "shop-amazon", state: "running" });
    expect(decodeSubagentCallResult({ kind: "delivered", name: "shop-amazon", state: "waiting" }))
      .toEqual({ kind: "delivered", name: "shop-amazon", state: "waiting" });
    expect(decodeSubagentCallResult({ kind: "delivered", name: "shop-amazon", state: "done" })).toBeNull();
  });

  it("refuses inconsistent or unbounded results", () => {
    const refused = [
      { ...ended, state: "running" },
      { ...ended, outcome: undefined },
      { ...ended, state: "failed" },
      { ...ended, outcome: "blocked", reason: undefined },
      { ...ended, state: "failed", outcome: undefined, reason: undefined },
      { ...ended, reason: "Not A Code" },
      { ...ended, name: "Shop Amazon" },
      { ...ended, extra: true },
      { ...ended, report: "x".repeat(SUBAGENT_LIMITS.reportCharacters + 1) },
      { ...ended, files: Array.from({ length: SUBAGENT_LIMITS.files + 1 }, (_, index) => `f${index}`) },
      { ...ended, steps: [{ outcome: "maybe", summary: "", tool: "x" }] },
      { ...ended, approvals: [{ ...ended.approvals[0], arguments: { blob: "x".repeat(SUBAGENT_LIMITS.approvalArgumentsCharacters) } }] },
      { ...ended, model: { id: "m" } },
      { continued: "no", kind: "started", name: "a", state: "running" }
    ];
    for (const value of refused) expect(decodeSubagentCallResult(value), JSON.stringify(value).slice(0, 80)).toBeNull();
  });

  it("bounds a report by characters with a mark, never silently", () => {
    expect(boundSubagentReport("short")).toEqual({ report: "short", truncated: false });
    const long = boundSubagentReport("ё".repeat(SUBAGENT_LIMITS.reportCharacters + 5));
    expect(long.truncated).toBe(true);
    expect(Array.from(long.report)).toHaveLength(SUBAGENT_LIMITS.reportCharacters);
    expect(decodeSubagentCallResult({ ...ended, report: long.report, reportTruncated: true })).not.toBeNull();
  });
});

describe("sub-agent vocabularies", () => {
  it("keeps stable codes snake case and bounded", () => {
    expect(["needs_approval", "sign_in_required", "subagent_limit_reached"].every(isSubagentCode)).toBe(true);
    expect(["", "Needs", "with space", "x".repeat(65)].some(isSubagentCode)).toBe(false);
  });

  it("decodes tool groups as distinct known groups in the vocabulary's order", () => {
    expect(decodeSubagentToolGroups(["mcp", "workspace"])).toEqual(["workspace", "mcp"]);
    expect(decodeSubagentToolGroups([])).toEqual([]);
    expect(decodeSubagentToolGroups(Object.values(SUBAGENT_TOOL_GROUPS))).toHaveLength(Object.keys(SUBAGENT_TOOL_GROUPS).length);
    expect(decodeSubagentToolGroups(["workspace", "workspace"])).toBeNull();
    expect(decodeSubagentToolGroups(["secrets_write"])).toBeNull();
    expect(decodeSubagentToolGroups(null)).toBeNull();
  });

  it("decodes the sub-agent reference of an answer's call row", () => {
    const ref = { mode: "background", name: "shop-amazon", threadId: "8b5a4f0e-1c2d-4e5f-9a0b-1c2d3e4f5a6b" };
    expect(decodeSubagentActivityRef(ref)).toEqual(ref);
    expect(decodeSubagentActivityRef({ ...ref, turnId: "turn-1" })).toEqual({ ...ref, turnId: "turn-1" });
    expect(decodeSubagentActivityRef({ ...ref, turnId: "a b" })).toBeNull();
    expect(decodeSubagentActivityRef({ ...ref, mode: "later" })).toBeNull();
    expect(decodeSubagentActivityRef({ ...ref, threadId: "../x" })).toBeNull();
    expect(decodeSubagentActivityRef({ ...ref, brief: "secret" })).toBeNull();
  });
});
