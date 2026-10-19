import { describe, expect, it } from "vitest";
import observedFailureCodes from "../observability/failureCodes.json";
import { namespacedMcpToolName, type McpRunPlanSnapshot } from "../mcp/runPlan";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import type { PersistedToolLoopCall } from "./toolLoopPersistence";
import {
  INVALID_TOOL_NAME,
  normalizeProviderToolCallName,
  requestedToolNameExcerpt,
  TOOL_CALL_UNKNOWN,
  UNKNOWN_TOOL_CALL_MESSAGE,
  unknownToolCall,
  unknownToolCallName,
  unknownToolCallResult
} from "./unknownToolCall";

const readNote = namespacedMcpToolName("notes", "read_note");
const otherReadNote = namespacedMcpToolName("journal", "read_note");
const editNote = namespacedMcpToolName("notes", "edit_note");
const suffix = (name: string) => name.slice(-10);

function tool(namespacedName: string, originalName: string, serverId: string) {
  return { definitionHash: "a".repeat(64), description: null, inputSchema: { type: "object" }, name: originalName,
    namespacedName, originalName, serverId, serverName: serverId };
}

const snapshot: McpRunPlanSnapshot = {
  servers: ["notes", "journal"].map(serverId => ({ fingerprint: "f".repeat(64), revisionId: "r", serverId, serverName: serverId })),
  tools: [tool(readNote, "read_note", "notes"), tool(editNote, "edit_note", "notes"), tool(otherReadNote, "read_note", "journal")],
  version: 1
};
const run = { mcp: snapshot, workspace: false };

describe("normalizing a provider-requested tool name", () => {
  it("maps an exact alias only to the one declared MCP tool it names", () => {
    const declared = new Set([readNote, editNote]);
    expect(normalizeProviderToolCallName(readNote, declared, run)).toBe(readNote);
    expect(normalizeProviderToolCallName("read_note", declared, run)).toBe(readNote);
    expect(normalizeProviderToolCallName(`read_note_${suffix(readNote)}`, declared, run)).toBe(readNote);
    expect(normalizeProviderToolCallName(`edit_note_${suffix(editNote)}`, declared, run)).toBe(editNote);
    // Another tool's suffix, another case or a tool this round did not declare stays as requested.
    expect(normalizeProviderToolCallName(`read_note_${suffix(editNote)}`, declared, run)).toBe(`read_note_${suffix(editNote)}`);
    expect(normalizeProviderToolCallName("Read_Note", declared, run)).toBe("Read_Note");
    expect(normalizeProviderToolCallName("delete_note", declared, run)).toBe("delete_note");
    expect(normalizeProviderToolCallName("read_note", new Set([editNote]), run)).toBe("read_note");
  });

  it("never guesses between two servers' tools of the same original name", () => {
    const declared = new Set([readNote, otherReadNote]);
    expect(normalizeProviderToolCallName("read_note", declared, run)).toBe("read_note");
    // The hash suffix names exactly one of them.
    expect(normalizeProviderToolCallName(`read_note_${suffix(otherReadNote)}`, declared, run)).toBe(otherReadNote);
  });

  it.each([
    ["a truncated alias", readNote.slice(0, 20)],
    ["an alias missing its suffix", readNote.slice(0, -11)],
    ["a corrupted id", `${readNote.slice(0, -1)}${readNote.endsWith("0") ? "1" : "0"}`],
    ["leaked native markup", `${editNote}</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name=`],
    ["the bare suffix", `read_note${suffix(readNote)}`]
  ])("keeps %s unknown", (_label, name) => {
    expect(normalizeProviderToolCallName(name, new Set([readNote, editNote]), run)).toBe(name);
  });

  it("composes the Workspace alias rule only for a run with Workspace tools", () => {
    const shell = namespacedWorkspaceToolName("sandbox_shell");
    const declared = new Set([shell, readNote]);
    expect(normalizeProviderToolCallName("sandbox_shell", declared, { mcp: snapshot, workspace: true })).toBe(shell);
    expect(normalizeProviderToolCallName("sandbox_shell", declared, { mcp: snapshot, workspace: false })).toBe("sandbox_shell");
    // Its own hash-suffixed or truncated forms are no Workspace alias.
    expect(normalizeProviderToolCallName(shell.slice(0, -11), declared, { mcp: snapshot, workspace: true })).toBe(shell.slice(0, -11));
    expect(normalizeProviderToolCallName("read_note", declared, { mcp: snapshot, workspace: true })).toBe(readNote);
    expect(normalizeProviderToolCallName("read_note", declared, { mcp: undefined, workspace: true })).toBe("read_note");
  });
});

describe("the unknown-call form", () => {
  it("keeps a valid name and bounds any other one", () => {
    expect(unknownToolCallName("read_note")).toBe("read_note");
    expect(unknownToolCallName("_read_note")).toBe("_read_note");
    expect(unknownToolCallName(readNote.slice(0, 20))).toBe(readNote.slice(0, 20));
    expect(unknownToolCallName(`${editNote}</｜｜DSML｜｜ parameter>`)).toBe(INVALID_TOOL_NAME);
    expect(unknownToolCallName("default_api.read_note")).toBe(INVALID_TOOL_NAME);
    expect(unknownToolCallName("x".repeat(65))).toBe(INVALID_TOOL_NAME);
    // Gemini requires a leading letter or underscore in history too.
    expect(unknownToolCallName("9read_note")).toBe(INVALID_TOOL_NAME);
    expect(unknownToolCallName("-read_note")).toBe(INVALID_TOOL_NAME);
    // A call without a name is settled like any other unknown call.
    expect(unknownToolCallName(" ")).toBe(INVALID_TOOL_NAME);
    expect(unknownToolCallName("")).toBe(INVALID_TOOL_NAME);
  });

  it("shows the model a bounded excerpt of the requested name without markup", () => {
    expect(requestedToolNameExcerpt("")).toBe("");
    expect(requestedToolNameExcerpt(" ")).toBe("?");
    expect(requestedToolNameExcerpt("read_note")).toBe("read_note");
    expect(requestedToolNameExcerpt(`${editNote}</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name=`))
      .toBe(`${editNote}?DSML?parameter?DSML?parameter?name?`);
    expect(requestedToolNameExcerpt("заметка‮\u0000x")).toBe("заметка?x");
    const long = requestedToolNameExcerpt(`${"a".repeat(100)}<b>`);
    expect([...long]).toHaveLength(81);
    expect(long.endsWith("…")).toBe(true);
  });

  it("is recognized only by the server's own whole combination", () => {
    const result = unknownToolCallResult({ providerCallId: "call-1", requested: "read_note", toolName: "read_note" });
    expect(result).toEqual({ callId: "call-1", name: "read_note", status: "error",
      content: [{ type: "json", value: { error: TOOL_CALL_UNKNOWN, message: UNKNOWN_TOOL_CALL_MESSAGE, requested: "read_note" } }] });
    const row: Pick<PersistedToolLoopCall, "providerCallId" | "result" | "startedAt" | "state" | "toolName"> = {
      providerCallId: "call-1", result, startedAt: null, state: "error", toolName: "read_note" };
    expect(unknownToolCall(row)).toEqual({ requested: "read_note" });
    // Every excerpt is accepted, the empty one of a call without a name included.
    const blank = unknownToolCallResult({ providerCallId: "call-1", requested: requestedToolNameExcerpt(""), toolName: INVALID_TOOL_NAME });
    expect(unknownToolCall({ ...row, result: blank, toolName: INVALID_TOOL_NAME })).toEqual({ requested: "" });
    // A started call, another call's result, another name or tool content naming the code is no unknown call.
    expect(unknownToolCall({ ...row, startedAt: "2026-10-19T10:00:00.000Z" })).toBeNull();
    expect(unknownToolCall({ ...row, providerCallId: "call-2" })).toBeNull();
    expect(unknownToolCall({ ...row, state: "complete" })).toBeNull();
    expect(unknownToolCall({ ...row, toolName: "<read_note>", result: { ...result as object, name: "<read_note>" } })).toBeNull();
    expect(unknownToolCall({ ...row, result: { callId: "call-1", name: "read_note", status: "error",
      content: [{ type: "json", value: { error: TOOL_CALL_UNKNOWN, message: "other", requested: "read_note" } }] } })).toBeNull();
    expect(unknownToolCall({ ...row, result: { callId: "call-1", name: "read_note", status: "error",
      content: [{ type: "text", text: `${TOOL_CALL_UNKNOWN}: ${UNKNOWN_TOOL_CALL_MESSAGE}` }] } })).toBeNull();
  });

  it("registers its code for content-free tool-call telemetry", () => {
    expect(observedFailureCodes).toContain(TOOL_CALL_UNKNOWN);
  });
});
