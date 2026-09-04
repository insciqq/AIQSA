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
  workspaceToolIsAllowed
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
