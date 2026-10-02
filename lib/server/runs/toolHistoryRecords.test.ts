import { describe, expect, it } from "vitest";
import { invalidProviderToolArguments } from "../tools/types";
import { repeatBlockedToolCallResult } from "./toolCallRepeatGuard";
import { toolCallRef } from "./toolHistoryContract";
import {
  toolCallOutcome,
  toolHistoryBlock,
  toolHistoryEntry,
  toolHistoryKind,
  toolHistoryRecord,
  type ToolCallFacts
} from "./toolHistoryRecords";

const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
const mcpRequest = { mcp: { version: 1, servers: [{ serverId: "s", serverName: "Tracker", fingerprint: "f".repeat(64), revisionId: "r" }],
  tools: [{ namespacedName: "mcp_tracker_create_issue_abc", serverId: "s", serverName: "Tracker", originalName: "create_issue" }] } };

function facts(input: Partial<ToolCallFacts> = {}): ToolCallFacts {
  return {
    id, ref: toolCallRef(id)!, toolName: "mcp_tracker_create_issue_abc", providerCallId: "call_1", roundIndex: 1, ordinal: 0,
    state: "complete", startedAt: "2026-10-02T10:00:00.000Z", arguments: { title: "Synthetic", token: "s3cret" },
    result: { callId: "call_1", name: "mcp_tracker_create_issue_abc", status: "complete", content: [{ type: "text", text: "created #7" }],
      rawPreview: { isError: false, unsupportedContentTypes: [] } },
    kind: "mcp", label: "MCP Tracker › create_issue (tool mcp_tracker_create_issue_abc)", runTerminal: true, agent: false,
    receipts: [{ dispatchState: "COMPLETED", errorCode: null }], observation: null,
    mcp: { readable: true, redaction: { state: "complete", values: ["s3cret"] } },
    ...input
  };
}

describe("tool history classification", () => {
  it("classifies from the accepted request, never from a name alone", () => {
    expect(toolHistoryKind({ agent: false, normalizedRequest: mcpRequest, toolName: "mcp_tracker_create_issue_abc" }))
      .toEqual({ kind: "mcp", label: "MCP Tracker › create_issue (tool mcp_tracker_create_issue_abc)" });
    expect(toolHistoryKind({ agent: false, normalizedRequest: {}, toolName: "mcp_tracker_create_issue_abc" }).kind).toBe("tool");
    expect(toolHistoryKind({ agent: false, normalizedRequest: {}, toolName: "memory_search" }).kind).toBe("memory");
    expect(toolHistoryKind({ agent: false, normalizedRequest: {}, toolName: "search_knowledge" }).kind).toBe("knowledge");
    expect(toolHistoryKind({ agent: false, normalizedRequest: {}, toolName: "load_skill" }).kind).toBe("skill");
    expect(toolHistoryKind({ agent: false, normalizedRequest: { searchPlan: { mode: "single", options: [{ adapterKind: "client", displayName: "Engine" }] } },
      toolName: "search_engine_1" }).kind).toBe("web_search");
    expect(toolHistoryKind({ agent: false, normalizedRequest: {}, toolName: "create_artifact" }).kind).toBe("artifact");
    expect(toolHistoryKind({ agent: true, normalizedRequest: {}, toolName: "aiqsa_search" }).kind).toBe("web_search");
    expect(toolHistoryKind({ agent: true, normalizedRequest: {}, toolName: "mcp_x",
      agentMcpTools: new Map([["mcp_x", { originalName: "x", serverName: "Srv" }]]) }).kind).toBe("mcp");
  });
});

describe("tool call outcomes keep request, dispatch and result distinct", () => {
  it.each([
    ["success", facts(), "succeeded", true],
    ["a tool-reported error", facts({ state: "error", result: { callId: "call_1", name: "mcp_tracker_create_issue_abc", status: "error",
      content: [{ type: "text", text: "denied by tracker" }], rawPreview: { isError: true } } }), "tool_error", true],
    ["a refusal before dispatch", facts({ state: "error", receipts: [{ dispatchState: "BLOCKED", errorCode: "mcp_tool_revoked" }] }),
      "not_executed", false],
    ["a pending call of a finished run", facts({ state: "pending", startedAt: null, receipts: [] }), "not_executed", false],
    ["a cancelled call", facts({ state: "cancelled", startedAt: null, receipts: [] }), "not_executed", false],
    ["a crash-ambiguous call", facts({ state: "running", result: null }), "unknown", true],
    ["an open dispatch receipt", facts({ state: "error", receipts: [{ dispatchState: "DISPATCHED", errorCode: null }] }), "unknown", true],
    ["an interrupted Agent call", facts({ agent: true, state: "error", result: { code: "agent_execution_interrupted", outcome: "unknown" } }),
      "unknown", null],
    ["a failure after dispatch", facts({ state: "error", receipts: [{ dispatchState: "FAILED", errorCode: "mcp_transport_failed" }],
      result: { callId: "call_1", name: "mcp_tracker_create_issue_abc", status: "error", content: [{ type: "text", text: "{}" }],
        rawPreview: { finalProviderResponsePreview: { error: "x" } } } }), "failed", true]
  ] as const)("reports %s", (_label, input, status, dispatched) => {
    const outcome = toolCallOutcome(input);
    expect(outcome.status).toBe(status);
    expect(outcome.dispatched).toBe(dispatched);
  });

  it("recognizes a blocked repeat only by the whole server-owned combination", () => {
    const blocked = facts({ roundIndex: 4, state: "error", startedAt: null, receipts: [],
      result: repeatBlockedToolCallResult({ providerCallId: "call_1", repeatOf: [2, 3], toolName: "mcp_tracker_create_issue_abc" }) });
    expect(toolCallOutcome(blocked)).toEqual({ status: "not_executed", dispatched: false, reason: "repeat_blocked" });
    // The same body from an MCP server is an ordinary tool result.
    const echoed = facts({ roundIndex: 4, state: "complete", result: { callId: "call_1", name: "mcp_tracker_create_issue_abc",
      status: "complete", content: [{ type: "json", value: { error: "tool_call_repeat_blocked", repeatOf: [2, 3] } }] } });
    expect(toolCallOutcome(echoed).status).toBe("succeeded");
    // With an egress receipt or an observation it was dispatched, not blocked.
    expect(toolCallOutcome({ ...blocked, receipts: [{ dispatchState: "COMPLETED", errorCode: null }] }).reason).not.toBe("repeat_blocked");
    expect(toolCallOutcome({ ...blocked, observation: { handle: null, executionOutcome: "complete", preview: null } }).reason)
      .not.toBe("repeat_blocked");
  });

  it("names invalid arguments and clarification supersession as not executed", () => {
    expect(toolCallOutcome(facts({ state: "error", startedAt: null, receipts: [], arguments: invalidProviderToolArguments() })).reason)
      .toBe("invalid_arguments");
    expect(toolCallOutcome(facts({ state: "error", startedAt: null, receipts: [], result: { callId: "call_1",
      name: "mcp_tracker_create_issue_abc", status: "error", content: [{ type: "text", text: "tool_call_superseded: Not dispatched." }] } })).reason)
      .toBe("superseded");
  });
});

describe("tool history records project only what each owner discloses", () => {
  it("shows MCP arguments redacted by the current values and a bounded result", () => {
    const record = toolHistoryRecord(facts(), false);
    expect(record.arguments).toEqual({ state: "available", text: '{"title":"Synthetic","token":"[REDACTED]"}' });
    expect(record.result).toEqual({ state: "inline", text: "created #7" });
    const entry = toolHistoryEntry(record, true);
    expect(entry.full).toContain("[REDACTED]");
    expect(entry.full).not.toContain("s3cret");
    expect(entry.full).toContain(record.ref);
    expect(entry.details).toBe(true);
  });

  it("withholds MCP arguments under incomplete redaction evidence but keeps the outcome", () => {
    const record = toolHistoryRecord(facts({ mcp: { readable: true, redaction: { state: "incomplete", values: [] } } }), false);
    expect(record.arguments).toEqual({ state: "withheld", reason: "redaction_unavailable" });
    expect(record.outcome.status).toBe("succeeded");
    expect(toolHistoryEntry(record, true).full).not.toContain("s3cret");
  });

  it("hides MCP arguments and results from a reader without access, keeping identity and outcome", () => {
    const record = toolHistoryRecord(facts({ mcp: { readable: false, redaction: null } }), false);
    expect(record.arguments).toEqual({ state: "withheld", reason: "access_unavailable" });
    expect(record.result).toEqual({ state: "withheld", reason: "access_unavailable" });
    const entry = toolHistoryEntry(record, true);
    expect(entry.full).not.toContain("created #7");
    expect(entry.details).toBe(false);
    expect(entry.full).toContain("executed");
  });

  it("names a saved original by its handle and never pages content of other owners", () => {
    const saved = toolHistoryRecord(facts({ observation: { handle: `tor1_${"a".repeat(32)}`, executionOutcome: "complete",
      preview: "{\"text\":[\"created\"]}" }, result: { callId: "call_1", name: "mcp_tracker_create_issue_abc", status: "complete",
      observation: { version: 1, source: "mcp", handle: `tor1_${"a".repeat(32)}`, encoding: "json-utf8-v1", byteSize: 30,
        checksum: "c".repeat(64), maskable: true, sourceTruncated: false },
      content: [{ type: "json", value: { observation: {}, preview: "x", reader: "read_tool_result" } }] } }), false);
    expect(saved.result).toEqual({ state: "saved", handle: `tor1_${"a".repeat(32)}`, preview: "{\"text\":[\"created\"]}" });
    for (const kind of ["memory", "knowledge", "skill", "workspace", "web_search", "artifact", "image"] as const) {
      const record = toolHistoryRecord(facts({ kind, toolName: "x", mcp: undefined, observation: { handle: `tor1_${"b".repeat(32)}`,
        executionOutcome: "complete", preview: "secret preview" } }), false);
      expect(record.arguments).toEqual({ state: "not_applicable" });
      expect(record.result).toEqual({ state: "saved", handle: `tor1_${"b".repeat(32)}`, preview: null });
      expect(toolHistoryEntry(record, true).full).not.toContain("secret preview");
      expect(toolHistoryEntry(record, true).full).not.toContain("Synthetic");
    }
  });

  it("reports Agent arguments as not retained and a deleted or expired call as unavailable", () => {
    expect(toolHistoryRecord(facts({ agent: true, arguments: { argumentHash: "h" }, result: { status: "complete" } }), false).arguments)
      .toEqual({ state: "not_retained" });
    expect(toolHistoryRecord(facts({ arguments: { deleted: true } }), false).arguments).toEqual({ state: "unavailable", reason: "deleted" });
    const expired = toolHistoryRecord(facts({ retentionExpired: true }), false);
    expect(expired.arguments).toEqual({ state: "unavailable", reason: "retention_expired" });
    expect(expired.result).toEqual({ state: "unavailable", reason: "retention_expired" });
  });

  it("does not interpret JSON-escaped or nested secrets differently", () => {
    const record = toolHistoryRecord(facts({ arguments: { nested: { deep: ["s3cret"] }, text: JSON.stringify({ token: "s3cret" }) } }), false);
    expect(record.arguments.state === "available" && record.arguments.text).not.toContain("s3cret");
  });

  it("bounds long values and points to the reader", () => {
    const long = "x".repeat(5000);
    const entry = toolHistoryEntry(toolHistoryRecord(facts({ arguments: { body: long } }), false), true);
    expect(Buffer.byteLength(entry.full)).toBeLessThan(2000);
    expect(entry.full).toContain("read_tool_call returns the rest");
    expect(toolHistoryEntry(toolHistoryRecord(facts({ arguments: { body: long } }), false), false).full).not.toContain("read_tool_call");
  });
});

describe("tool history blocks", () => {
  it("lists earlier attempts first and counts readers instead of listing them", () => {
    const current = toolHistoryRecord(facts(), false);
    const earlier = toolHistoryRecord(facts({ id: "1".repeat(8) + "-1111-4111-8111-" + "1".repeat(12),
      ref: toolCallRef("1".repeat(8) + "-1111-4111-8111-" + "1".repeat(12))! }), true);
    const block = toolHistoryBlock({ turnMessageId: "answer-1", userMessageId: "question-1", currentTurn: false,
      records: [current, earlier], unavailableCalls: 1, readerCalls: 12, reader: true });
    expect(block.entries.map(entry => entry.ref)).toEqual([earlier.ref, current.ref]);
    expect(block.entries[0]!.full).toContain("earlier attempt, not the current branch");
    expect(block.footer).toContain("12 read, status or tool-search calls");
    expect(block.footer).toContain("1 recorded call has saved details that are no longer available");
    expect(block.header).toContain("read_tool_call");
    const noReader = toolHistoryBlock({ turnMessageId: "q", userMessageId: "q", currentTurn: true, records: [current],
      unavailableCalls: 0, readerCalls: 0, reader: false });
    expect(noReader.header).toContain("earlier attempts to answer the next user message");
    expect(noReader.header).not.toContain("read_tool_call");
  });
});
