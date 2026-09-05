import { describe, expect, it } from "vitest";
import {
  WORKSPACE_INBOX_INDEX_PATH,
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  WORKSPACE_PROJECT_DIRECTORY,
  isSafeWorkspaceRelativePath,
  safeWorkspaceBasename,
  workspaceAttachmentPath,
  workspaceMessageManifestPath,
  workspaceRunOutputDirectory,
  workspaceSandboxName,
  workspaceToolIsAllowed,
  decodeWorkspaceInboxIndexAttachments,
  isRetryableWorkspaceExportErrorCode,
  isWorkspaceRuntimeExecSessionId
} from "./workspace";

describe("workspace domain", () => {
  it("owns stable sandbox and guest paths without accepting path-like ids", () => {
    expect(workspaceSandboxName("0199aabc-12ef-7abc-8abc-0123456789ab"))
      .toBe("aiqsa-ws-0199aabc-12ef-7abc-8abc-0123456789ab");
    expect(workspaceMessageManifestPath("msg_123"))
      .toBe("/workspace/inbox/messages/msg_123/manifest.json");
    expect(workspaceRunOutputDirectory("run_123"))
      .toBe("/workspace/output/run_123");
    expect(() => workspaceRunOutputDirectory("../run")).toThrow("workspace_run_id_invalid");
    expect(WORKSPACE_INBOX_INDEX_PATH).toBe("/workspace/inbox/index.json");
    expect(WORKSPACE_PROJECT_DIRECTORY).toBe("/workspace/project");
  });

  it("builds a bounded physical attachment name while preserving unicode", () => {
    expect(workspaceAttachmentPath({
      attachmentId: "att_456",
      messageId: "msg_123",
      originalName: " Отчёт Q3/../финал.xlsx "
    })).toBe("/workspace/inbox/messages/msg_123/att_456--Отчёт-Q3-..-финал.xlsx");
    expect(safeWorkspaceBasename("\0/\\\r\n")).toBe("file");
    expect(new TextEncoder().encode(safeWorkspaceBasename(`${"я".repeat(200)}.txt`)).byteLength)
      .toBeLessThanOrEqual(160);
  });

  it("rejects output path escape, platform separators, controls, and excess length", () => {
    expect(isSafeWorkspaceRelativePath("reports/final.pdf")).toBe(true);
    expect(isSafeWorkspaceRelativePath(".hidden/cache.json")).toBe(true);
    for (const invalid of ["/etc/passwd", "../secret", "a/../b", "a\\b", "a//b", "a\0b"]) {
      expect(isSafeWorkspaceRelativePath(invalid)).toBe(false);
    }
    expect(isSafeWorkspaceRelativePath("a".repeat(513))).toBe(false);
  });

  it("exposes only the pinned execution and filesystem tool surface", () => {
    expect(WORKSPACE_MCP_TOOL_ALLOWLIST).toHaveLength(16);
    expect(workspaceToolIsAllowed("sandbox_shell")).toBe(true);
    expect(workspaceToolIsAllowed("sandbox_fs_copy_to_host")).toBe(false);
    expect(workspaceToolIsAllowed("sandbox_remove")).toBe(false);
  });
});

describe("workspace inbox index decoding", () => {
  const entry = {
    attachmentId: "att_1",
    byteSize: 12,
    checksum: "a".repeat(64),
    sandboxPath: "/workspace/inbox/messages/msg_1/att_1--data.bin"
  };

  it("accepts the exact bounded shape and rejects everything else", () => {
    expect(decodeWorkspaceInboxIndexAttachments({ attachments: [entry], manifests: [], version: 1 }))
      .toEqual([entry]);
    expect(decodeWorkspaceInboxIndexAttachments({ attachments: [], version: 1 })).toEqual([]);
    expect(decodeWorkspaceInboxIndexAttachments({ attachments: [entry], version: 2 })).toBeNull();
    expect(decodeWorkspaceInboxIndexAttachments({ attachments: [entry, entry], version: 1 })).toBeNull();
    expect(decodeWorkspaceInboxIndexAttachments({
      attachments: [{ ...entry, sandboxPath: "/workspace/project/data.bin" }],
      version: 1
    })).toBeNull();
    expect(decodeWorkspaceInboxIndexAttachments({
      attachments: [{ ...entry, sandboxPath: "/workspace/inbox/messages/../etc/passwd" }],
      version: 1
    })).toBeNull();
    expect(decodeWorkspaceInboxIndexAttachments({
      attachments: [{ ...entry, byteSize: 0 }],
      version: 1
    })).toBeNull();
    expect(decodeWorkspaceInboxIndexAttachments({
      attachments: [{ ...entry, checksum: "not-a-hash" }],
      version: 1
    })).toBeNull();
    expect(decodeWorkspaceInboxIndexAttachments("[]")).toBeNull();
  });

  it("classifies export errors and runtime execution ids", () => {
    expect(isRetryableWorkspaceExportErrorCode(null)).toBe(true);
    expect(isRetryableWorkspaceExportErrorCode("workspace_output_export_failed")).toBe(true);
    expect(isRetryableWorkspaceExportErrorCode("workspace_output_limit_exceeded")).toBe(false);
    expect(isRetryableWorkspaceExportErrorCode("workspace_session_lost")).toBe(false);
    expect(isWorkspaceRuntimeExecSessionId("exec-abc_123")).toBe(true);
    expect(isWorkspaceRuntimeExecSessionId("")).toBe(false);
    expect(isWorkspaceRuntimeExecSessionId("bad\u0000id")).toBe(false);
    expect(isWorkspaceRuntimeExecSessionId("x".repeat(257))).toBe(false);
  });
});
