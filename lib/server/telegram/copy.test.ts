import { describe, expect, it } from "vitest";
import {
  TELEGRAM_BOT_COMMANDS, TELEGRAM_COPY, telegramAgentWorkingText, telegramConnectedText, telegramReasonText
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
});
