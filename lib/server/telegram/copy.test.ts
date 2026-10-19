import { describe, expect, it } from "vitest";
import {
  TELEGRAM_BOT_COMMANDS, TELEGRAM_COPY, telegramAgentWorkingText, telegramConnectedText, telegramFilesSummaryText, telegramReasonText,
  telegramWorkActivityText, telegramWorkFailedText, telegramWorkspaceWorkingText
} from "./copy";

describe("Telegram bot copy", () => {
  it("answers every reason the bot itself reports and keeps log- and settings-only reasons silent", () => {
    expect(telegramReasonText("telegram_access_off")).toBe("Telegram access is off for your account. Ask your AIQSA administrator.");
    expect(telegramReasonText("telegram_not_linked")).toBe(TELEGRAM_COPY.notLinked);
    for (const code of ["telegram_link_code_invalid", "telegram_account_in_use", "telegram_unsupported_message", "telegram_file_too_large",
      "telegram_voice_too_long", "telegram_voice_unavailable", "telegram_busy"] as const) expect(telegramReasonText(code)).toBeTruthy();
    for (const code of ["telegram_render_fallback", "telegram_delivery_unknown", "telegram_poll_conflict", "telegram_bot_changed"] as const) {
      expect(telegramReasonText(code)).toBeUndefined();
    }
  });

  it("bounds interpolated names and lists every command in /help", () => {
    expect(telegramConnectedText("  Alex\nSmith ")).toBe("Connected to AIQSA as Alex Smith. Send a message to start a new chat. /help lists commands.");
    expect(telegramConnectedText("x".repeat(500)).length).toBeLessThan(250);
    expect(telegramAgentWorkingText(3 * 60_000, "Running tests")).toBe("Agent is working · 3 min — Running tests");
    expect(telegramAgentWorkingText(10_000)).toBe("Agent is working · 1 min");
    for (const { command } of TELEGRAM_BOT_COMMANDS) expect(TELEGRAM_COPY.help).toContain(`/${command} — `);
  });

  it("words the Workspace status and its steps in one bounded line", () => {
    expect(telegramWorkspaceWorkingText(150_000, "Running npm test")).toBe("Working in Workspace · 3 min — Running npm test");
    expect(telegramWorkFailedText(20_000)).toBe("Failed after 1 min");
    const long = telegramAgentWorkingText(60_000, telegramWorkActivityText({
      command: { preview: `python - <<'PY'\n${"print(1)\n".repeat(100)}PY` }, id: "cmd-1", kind: "command", phase: "running"
    })!);
    expect(long.length).toBeLessThanOrEqual("Agent is working · 1 min — ".length + 200);
    expect(long).not.toContain("\n");
    expect(telegramWorkActivityText({ command: { preview: "npm test" }, id: "c", kind: "command", phase: "failed" })).toBe("npm test failed");
    expect(telegramWorkActivityText({ file: { displayPath: "out/report.md" }, id: "w", kind: "file_write", phase: "succeeded" }))
      .toBe("Wrote out/report.md");
    expect(telegramWorkActivityText({ changes: [{ action: "update", displayPath: "a.ts" }, { action: "add", displayPath: "b.ts" }], count: 2,
      id: "f", kind: "file_change", phase: "running" })).toBe("Editing 2 files");
    expect(telegramWorkActivityText({ id: "m", kind: "mcp_call", mcp: { serverName: "Jira", toolName: "create_issue" }, phase: "running" }))
      .toBe("Calling Jira: create_issue");
    expect(telegramWorkActivityText({ id: "s", kind: "search", phase: "succeeded", search: { query: "tide tables", source: "Web" } }))
      .toBe("Searched tide tables");
    expect(telegramWorkActivityText({ count: 3, id: "o", kind: "outputs_export", phase: "running" })).toBe("Exporting 3 files");
    expect(telegramWorkActivityText({ id: "x", kind: "execution_status", phase: "closed" })).toBeNull();
  });

  it("names the files that stayed in AIQSA and those that could not be sent in one line", () => {
    expect(telegramFilesSummaryText({ failed: 0, left: 0 })).toBeNull();
    expect(telegramFilesSummaryText({ failed: 0, left: 1 })).toBe("1 more file is in AIQSA.");
    expect(telegramFilesSummaryText({ failed: 1, left: 0 })).toBe("1 file couldn't be sent here; it's in AIQSA.");
    expect(telegramFilesSummaryText({ failed: 2, left: 3 })).toBe("3 more files are in AIQSA. 2 files couldn't be sent here.");
  });
});
