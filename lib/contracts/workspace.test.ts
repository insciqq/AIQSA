import { describe, expect, it } from "vitest";
import {
  decodeChatWorkspaceState,
  decodeThreadGeneratedFile,
  decodeThreadWorkspaceActivity,
  decodeThreadWorkspaceActivityEntry,
  decodeWorkspacePolicyResponse,
  isWorkspaceErrorCode
} from "./workspace";

describe("workspace browser contracts", () => {
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
  it("decodes exact bounded entries and rejects additive or oversized data", () => {
    const entry = {
      command: { cwd: "project", exitCode: 0, preview: "npm test", stdoutPreview: "ok" },
      durationMs: 1200,
      id: "call:abc123",
      kind: "command",
      phase: "succeeded",
      startedAt: "2026-09-04T10:00:00.000Z"
    };
    expect(decodeThreadWorkspaceActivityEntry(entry)).toEqual(entry);
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
