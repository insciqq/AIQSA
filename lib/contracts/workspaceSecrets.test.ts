import { describe, expect, it } from "vitest";
import {
  decodeWorkspaceBrowserAutosaveReport, decodeWorkspaceSecretList, formatWorkspaceSecretLimit, workspaceBrowserAutosaveMessage,
  workspaceSecretErrorMessage, WORKSPACE_BROWSER_SESSION_LIMIT_TEXT, WORKSPACE_BROWSER_SESSION_MAX_BYTES,
  WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES, WORKSPACE_SECRET_VALUE_MAX_BYTES, type WorkspaceSecretSummary
} from "./workspaceSecrets";

const summary: WorkspaceSecretSummary = {
  id: "10000000-0000-4000-8000-000000000001", versionId: "10000000-0000-4000-8000-000000000002", kind: "text",
  name: "Access", description: "", byteSize: 32, updatedAt: "2026-09-27T00:00:00.000Z", envNames: [], originalName: null, sshProtected: false
};
const browser: WorkspaceSecretSummary = { ...summary, id: "10000000-0000-4000-8000-000000000003", kind: "browser_session",
  name: "shop.example", originalName: "shop.example.json", browserSession: { autoSaved: true } };

describe("Workspace secret wire contract", () => {
  it("bounds byteSize per kind so one large browser session does not reject the whole list", () => {
    const large = [summary, { ...browser, byteSize: WORKSPACE_BROWSER_SESSION_MAX_BYTES }];
    expect(decodeWorkspaceSecretList(large)).toEqual(large);
    expect(decodeWorkspaceSecretList([{ ...browser, byteSize: WORKSPACE_BROWSER_SESSION_MAX_BYTES + 1 }])).toBeNull();
    expect(decodeWorkspaceSecretList([{ ...summary, byteSize: WORKSPACE_SECRET_VALUE_MAX_BYTES }])).not.toBeNull();
    expect(decodeWorkspaceSecretList([{ ...summary, byteSize: WORKSPACE_SECRET_VALUE_MAX_BYTES + 1 }])).toBeNull();
  });

  it("states the per-state and aggregate browser limits in every limit message", () => {
    expect(formatWorkspaceSecretLimit(512 * 1024)).toBe("512 KiB");
    expect(formatWorkspaceSecretLimit(WORKSPACE_BROWSER_SESSION_MAX_BYTES)).toBe("8 MiB");
    expect(formatWorkspaceSecretLimit(WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES)).toBe("64 MiB");
    expect(WORKSPACE_BROWSER_SESSION_LIMIT_TEXT).toContain("8 MiB");
    expect(WORKSPACE_BROWSER_SESSION_LIMIT_TEXT).toContain("64 MiB");
    expect(workspaceSecretErrorMessage("workspace_secret_limit")).toContain(WORKSPACE_BROWSER_SESSION_LIMIT_TEXT);
    expect(workspaceSecretErrorMessage("workspace_secret_limit")).toContain("Each file can be up to 512 KiB.");
    expect(workspaceSecretErrorMessage("workspace_browser_session_invalid")).toContain("up to 8 MiB");
  });

  it("decodes only content-free autosave reports and treats anything else as absent", () => {
    const report = { saved: 1, unchanged: 0, skipped: { browser_session_too_large: 1 } };
    expect(decodeWorkspaceBrowserAutosaveReport(report)).toEqual(report);
    expect(decodeWorkspaceBrowserAutosaveReport({ ...report, failure: "browser_session_save_failed" })).not.toBeNull();
    for (const invalid of [null, [], { ...report, fileName: "shop.example.json" }, { ...report, skipped: { cookie: 1 } },
      { ...report, saved: -1 }, { ...report, failure: "private diagnostic" }, { saved: 1, unchanged: 0 }]) {
      expect(decodeWorkspaceBrowserAutosaveReport(invalid)).toBeNull();
    }
  });

  it("describes skipped and failed autosaves exactly without claiming success", () => {
    const quiet = workspaceBrowserAutosaveMessage({ saved: 2, unchanged: 1, skipped: {} });
    expect(quiet).toEqual({ attention: false, text: "Last browser autosave: 2 saved, 1 unchanged." });
    expect(workspaceBrowserAutosaveMessage({ saved: 0, unchanged: 0, skipped: { browser_session_stale: 1 } }).attention).toBe(false);
    const skipped = workspaceBrowserAutosaveMessage({ saved: 0, unchanged: 1, skipped: { browser_session_too_large: 1, browser_session_total_limit: 2 } });
    expect(skipped.attention).toBe(true);
    expect(skipped.text).toContain("1 session larger than 8 MiB skipped; any previously saved version was kept.");
    expect(skipped.text).toContain("2 sessions skipped because saved sessions would exceed 64 MiB in total");
    const failed = workspaceBrowserAutosaveMessage({ saved: 1, unchanged: 0, skipped: {}, failure: "browser_session_save_failed" });
    expect(failed.attention).toBe(true);
    expect(failed.text).toContain("did not finish");
  });
});
