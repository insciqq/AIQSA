import { describe, expect, it } from "vitest";
import {
  decodeChatWorkspaceState,
  decodeThreadGeneratedFile,
  decodeThreadWorkspaceActivity,
  decodeThreadWorkspaceActivityEntry,
  decodeWorkspacePolicyResponse,
  decodeWorkspaceRuntimeHealth,
  isWorkspaceErrorCode
} from "./workspace";

describe("workspace browser contracts", () => {
  it("decodes explicit Agent capability without treating absent or malformed values as ready", () => {
    const state = { available: true, enabled: true, internetEnabled: true, sessionState: "ready" };
    expect(decodeChatWorkspaceState({ ...state, agentAvailable: true })?.agentAvailable).toBe(true);
    expect(decodeChatWorkspaceState({ ...state, agentAvailable: false })?.agentAvailable).toBe(false);
    expect(decodeChatWorkspaceState(state)?.agentAvailable).toBeUndefined();
    expect(decodeChatWorkspaceState({ ...state, agentAvailable: "true" })).toBeNull();
    expect(decodeWorkspaceRuntimeHealth({ state: "ready", agentReady: true, secret: "hidden" }))
      .toEqual({ state: "ready", agentReady: true });
    expect(decodeWorkspaceRuntimeHealth({ state: "ready", agentReady: "true" })).toBeNull();
  });

  it("decodes the bounded chat projection without leaking additive runtime data", () => {
    expect(decodeChatWorkspaceState({
      available: true,
      enabled: true,
      internetEnabled: true,
      runtimeSandboxId: "must-not-leak",
      sessionState: "ready"
    })).toEqual({
      available: true,
      enabled: true,
      internetEnabled: true,
      sessionState: "ready"
    });
    expect(decodeChatWorkspaceState({
      available: false,
      enabled: false,
      internetEnabled: null,
      sessionState: null,
      unavailableReason: "runtime_unavailable"
    })).not.toBeNull();
    expect(decodeChatWorkspaceState({
      available: true,
      enabled: false,
      internetEnabled: null,
      sessionState: null,
      unavailableReason: "runtime_unavailable"
    })).toBeNull();
  });

  it("decodes only client-safe generated file metadata", () => {
    expect(decodeThreadGeneratedFile({
      attachmentId: "attachment-1",
      byteSize: 42,
      checksum: "private",
      fileName: "result.bin",
      mimeType: "application/octet-stream",
      relativePath: "nested/result.bin",
      storageKey: "private"
    })).toEqual({
      attachmentId: "attachment-1",
      byteSize: 42,
      fileName: "result.bin",
      mimeType: "application/octet-stream",
      relativePath: "nested/result.bin"
    });
    expect(decodeThreadGeneratedFile({
      attachmentId: "attachment-1",
      byteSize: -1,
      fileName: "bad.bin",
      mimeType: "application/octet-stream",
      relativePath: "bad.bin"
    })).toBeNull();
  });

  it("recognizes only stable workspace error codes", () => {
    expect(isWorkspaceErrorCode("workspace_tool_timeout")).toBe(true);
    expect(isWorkspaceErrorCode("raw_microsandbox_failure")).toBe(false);
  });

  it("decodes the client-safe administrator policy projection", () => {
    expect(decodeWorkspacePolicyResponse({
      workspace: {
        enabled: true,
        internetEnabled: false,
        runtime: {
          imageReady: true,
          mcpVersion: "0.6.16",
          runtimeVersion: "0.6.16",
          state: "ready",
          token: "must-not-leak",
          virtualizationReady: true
        },
        version: 4
      }
    })).toEqual({
      enabled: true,
      internetEnabled: false,
      runtime: {
        imageReady: true,
        mcpVersion: "0.6.16",
        runtimeVersion: "0.6.16",
        state: "ready",
        virtualizationReady: true
      },
      version: 4
    });
    expect(decodeWorkspacePolicyResponse({
      workspace: { enabled: true, internetEnabled: true, runtime: { state: "broken" }, version: 1 }
    })).toBeNull();
  });
});

describe("workspace activity contract", () => {
  it("admits only the reviewed facts of Agent actions", () => {
    const base = { id: "agent:fixture", phase: "succeeded" };
    const entries = [
      { ...base, kind: "file_change", changes: [{ action: "add", displayPath: "project/中文.py" }] },
      { ...base, kind: "mcp_call", mcp: { serverName: "Issues", toolName: "Get issue" } },
      { ...base, kind: "search", search: { query: "bounded query", source: "Web" } },
      { ...base, kind: "agent_note", text: "A visible note." },
      { ...base, kind: "plan", items: [{ completed: false, text: "Run the tests" }] },
      { ...base, kind: "elided", count: 3, failedCount: 1, hasLifecycle: true, throughSequence: 20 }
    ];
    for (const entry of entries) {
      expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
      expect(decodeThreadWorkspaceActivityEntry({ ...entry, arguments: { private: true } })).toBeNull();
      expect(decodeThreadWorkspaceActivityEntry({ ...entry, result: "private" })).toBeNull();
    }
    expect(decodeThreadWorkspaceActivityEntry({ ...entries[1], mcp: { toolName: "Tool", rawToolId: "private" } })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...base, kind: "command", text: "unrelated" })).toBeNull();
  });

  it("enforces byte, text, collection and elision bounds at the wire boundary", () => {
    const base = { id: "agent:fixture", phase: "succeeded" };
    expect(decodeThreadWorkspaceActivityEntry({ ...base, kind: "agent_note", text: "🙂".repeat(512) })).not.toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...base, kind: "agent_note", text: "🙂".repeat(513) })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...base, kind: "search", search: { query: "q".repeat(201), source: "Web" } })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...base, kind: "plan", items: Array.from({ length: 51 }, () => ({ text: "Read", completed: false })) })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...base, kind: "file_change", changes: Array.from({ length: 65 }, () => ({ action: "update", displayPath: "file" })) })).toBeNull();
    const elided = { ...base, kind: "elided", count: 3, failedCount: 1, hasLifecycle: false, throughSequence: 20 };
    expect(decodeThreadWorkspaceActivityEntry({ ...elided, failedCount: 4 })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...elided, throughSequence: -1 })).toBeNull();
    expect(decodeThreadWorkspaceActivity({ entries: [elided] })).toBeNull();
    expect(decodeThreadWorkspaceActivity({ entries: [elided], truncated: true })).not.toBeNull();
    expect(decodeThreadWorkspaceActivity({ entries: [elided, { ...elided, id: "other" }], truncated: true })).toBeNull();
    expect(decodeThreadWorkspaceActivity({ entries: Array.from({ length: 513 }, () => ({ ...base, kind: "workspace_start" })) })).toBeNull();
  });

  it("decodes exact bounded entries and rejects additive or oversized data", () => {
    const entry = {
      command: { cwd: "project", exitCode: 0, preview: "npm test", stdoutPreview: "ok" },
      durationMs: 1200,
      id: "call:abc123",
      kind: "command",
      phase: "succeeded",
      sequence: 3,
      startedAt: "2026-09-04T10:00:00.000Z",
      updateId: "update:abc123"
    };
    expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
    for (const sequence of [-1, 0.1, NaN, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      expect(decodeThreadWorkspaceActivityEntry({ ...entry, sequence })).toBeNull();
    }
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, updateId: "raw id!" })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, firstSequence: 4 })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, command: { ...entry.command, outputSequence: 4 } })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, runOutcome: "cancelled" })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, phase: "cancelled", runOutcome: "cancelled" })).not.toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, runtimeSandboxId: "leak" })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, command: { ...entry.command, arguments: {} } })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, kind: "sandbox_exec" })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({
      ...entry,
      command: { ...entry.command, stdoutPreview: "x".repeat(8 * 1_024 + 1) }
    })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({ ...entry, errorCode: "raw_failure" })).toBeNull();
    expect(decodeThreadWorkspaceActivityEntry({
      file: { byteSize: 12, displayPath: "project/a.txt" },
      id: "call:def",
      kind: "file_write",
      phase: "succeeded"
    })).not.toBeNull();
    expect(decodeThreadWorkspaceActivity({
      entries: [entry],
      outputStatus: { errorCode: "workspace_output_export_failed", state: "retrying" }
    })).toEqual({
      entries: [entry],
      outputStatus: { errorCode: "workspace_output_export_failed", state: "retrying" }
    });
    expect(decodeThreadWorkspaceActivity({ entries: [entry], outputStatus: { state: "unknown" } })).toBeNull();
    expect(decodeThreadWorkspaceActivity({ entries: "nope" })).toBeNull();
  });
});
