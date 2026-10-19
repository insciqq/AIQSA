import { describe, expect, it } from "vitest";
import type { TelegramAdminState } from "@/lib/contracts/telegram";
import { telegramAccessDirty, telegramBotStatus, telegramRelativeTime, telegramTokenError } from "./telegramAdminView";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

function state(overrides: Partial<TelegramAdminState> = {}): TelegramAdminState {
  return {
    botUsername: "aiqsa_team_bot",
    enabled: true,
    groupIds: [],
    health: { lastFailureAt: null, lastFailureCode: null, lastPollAt: null, lastSuccessAt: null },
    restricted: false,
    tokenConfigured: true,
    version: 1,
    ...overrides
  };
}

describe("telegramAdminView", () => {
  it("formats the age of a health fact", () => {
    expect(telegramRelativeTime("2026-10-19T11:59:55.000Z", NOW)).toBe("5 s ago");
    expect(telegramRelativeTime("2026-10-19T12:00:03.000Z", NOW)).toBe("0 s ago");
    expect(telegramRelativeTime("2026-10-19T11:57:00.000Z", NOW)).toBe("3 min ago");
    expect(telegramRelativeTime("2026-10-19T09:00:00.000Z", NOW)).toBe("3 h ago");
    expect(telegramRelativeTime("2026-10-10T09:00:00.000Z", NOW)).toMatch(/^on /u);
  });

  it("lets the newest health fact decide the bot status", () => {
    expect(telegramBotStatus(state({ tokenConfigured: false, enabled: false }), NOW).label).toBe("Not set up");
    expect(telegramBotStatus(state({ enabled: false }), NOW).label).toBe("Off");
    expect(telegramBotStatus(state(), NOW).detail).toBe("Polling · waiting for the first update");
    const recovered = state({ health: {
      lastFailureAt: "2026-10-19T11:00:00.000Z", lastFailureCode: "telegram_unreachable",
      lastPollAt: "2026-10-19T11:59:58.000Z", lastSuccessAt: "2026-10-19T11:59:58.000Z"
    } });
    expect(telegramBotStatus(recovered, NOW)).toEqual({ detail: "Polling · last update 2 s ago", label: "On", tone: "ok" });
    const failing = state({ health: {
      lastFailureAt: "2026-10-19T11:59:00.000Z", lastFailureCode: "telegram_token_rejected",
      lastPollAt: "2026-10-19T11:59:00.000Z", lastSuccessAt: "2026-10-19T11:00:00.000Z"
    } });
    expect(telegramBotStatus(failing, NOW)).toMatchObject({ label: "Attention", tone: "critical" });
    expect(telegramBotStatus(failing, NOW).detail).toContain("Telegram rejected the bot token.");
  });

  it("checks a token's shape before it leaves the browser", () => {
    expect(telegramTokenError("")).toBe("Paste the bot token from @BotFather.");
    expect(telegramTokenError("123:short")).toContain("This is not a bot token.");
    expect(telegramTokenError(" 123456789:AAEexampleSecretPart_abcdefghijk ")).toBeNull();
  });

  it("compares the access draft with the stored access", () => {
    const stored = state({ groupIds: ["A1"], restricted: true });
    expect(telegramAccessDirty({ groupIds: ["a1"], restricted: true }, stored)).toBe(false);
    expect(telegramAccessDirty({ groupIds: [], restricted: true }, stored)).toBe(true);
    expect(telegramAccessDirty({ groupIds: ["a1"], restricted: false }, stored)).toBe(true);
    expect(telegramAccessDirty({ groupIds: ["x"], restricted: false }, state())).toBe(false);
  });
});
