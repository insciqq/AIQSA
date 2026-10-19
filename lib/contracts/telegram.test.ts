import { describe, expect, it } from "vitest";
import {
  decodeTelegramAdminCommand, decodeTelegramAdminState, decodeTelegramAdminUserLink, decodeTelegramLinkCodeResponse,
  decodeTelegramUserStatus, TELEGRAM_CALLBACK_DATA_PATTERN, TELEGRAM_REASON_CODES
} from "./telegram";

const GROUP = "8a4f2a8e-5a8b-4c55-9c1e-0d4a1f6f9b10";
const AT = "2026-10-19T08:00:00.000Z";
const state = {
  enabled: true, restricted: true, groupIds: [GROUP], tokenConfigured: true, botUsername: "aiqsa_test_bot", version: 3,
  health: { lastPollAt: AT, lastSuccessAt: AT, lastFailureAt: null, lastFailureCode: null }
};

describe("Telegram contract", () => {
  it("decodes the administrator state and refuses unknown keys, tokens and oversized values", () => {
    expect(decodeTelegramAdminState(state)).toEqual(state);
    expect(decodeTelegramAdminState({ ...state, botUsername: null, tokenConfigured: false })).not.toBeNull();
    expect(decodeTelegramAdminState({ ...state, token: "123:abc" })).toBeNull();
    expect(decodeTelegramAdminState({ ...state, health: { ...state.health, url: "x" } })).toBeNull();
    expect(decodeTelegramAdminState({ ...state, groupIds: Array.from({ length: 201 }, () => GROUP) })).toBeNull();
    expect(decodeTelegramAdminState({ ...state, groupIds: [GROUP, GROUP.toUpperCase()] })).toBeNull();
    expect(decodeTelegramAdminState({ ...state, botUsername: "x".repeat(33) })).toBeNull();
    expect(decodeTelegramAdminState({ ...state, version: 0 })).toBeNull();
    expect(decodeTelegramAdminState({ ...state, health: { ...state.health, lastFailureCode: "telegram_token_rejected" } })).not.toBeNull();
    expect(decodeTelegramAdminState({ ...state, health: { ...state.health, lastFailureCode: "PRIVATE" } })).toBeNull();
  });

  it("decodes each administrator command with its expected version", () => {
    const token = `123456789:${"A".repeat(35)}`;
    expect(decodeTelegramAdminCommand({ action: "test_and_save", token, expectedVersion: 1 })).toEqual({ action: "test_and_save", token, expectedVersion: 1 });
    expect(decodeTelegramAdminCommand({ action: "enable", expectedVersion: 2 })).not.toBeNull();
    expect(decodeTelegramAdminCommand({ action: "disable", expectedVersion: 2 })).not.toBeNull();
    expect(decodeTelegramAdminCommand({ action: "set_access", restricted: false, groupIds: [], expectedVersion: 2 })).not.toBeNull();
    for (const invalid of [
      { action: "enable" },
      { action: "enable", expectedVersion: 2, token },
      { action: "test_and_save", token: "123/../getMe", expectedVersion: 1 },
      { action: "test_and_save", token: `${token}${"A".repeat(200)}`, expectedVersion: 1 },
      { action: "set_access", restricted: true, groupIds: ["not-a-group"], expectedVersion: 1 },
      { action: "delete", expectedVersion: 1 }
    ]) expect(decodeTelegramAdminCommand(invalid)).toBeNull();
  });

  it("decodes the user status, link code and the administrator's view of a link", () => {
    expect(decodeTelegramUserStatus({ available: true, state: "not_linked" })).toEqual({ available: true, state: "not_linked" });
    expect(decodeTelegramUserStatus({ available: true, state: "linked", telegramUsername: "alex_user", linkedAt: AT })).not.toBeNull();
    expect(decodeTelegramUserStatus({ available: true, state: "access_off", reasonCode: "telegram_access_off" })).not.toBeNull();
    expect(decodeTelegramUserStatus({ available: true, state: "linked", telegramUserId: 42 })).toBeNull();
    expect(decodeTelegramUserStatus({ available: true, state: "paused" })).toBeNull();

    const deepLink = `https://t.me/aiqsa_test_bot?start=${"a".repeat(43)}`;
    expect(decodeTelegramLinkCodeResponse({ deepLink, expiresAt: AT })).toEqual({ deepLink, expiresAt: AT });
    for (const link of [`http://t.me/aiqsa_test_bot?start=abc`, `https://evil.example/aiqsa_test_bot?start=abc`,
      `https://t.me/aiqsa_test_bot?start=${"a".repeat(65)}`, `https://t.me/aiqsa_test_bot?start=a&x=1`]) {
      expect(decodeTelegramLinkCodeResponse({ deepLink: link, expiresAt: AT })).toBeNull();
    }
    expect(decodeTelegramLinkCodeResponse({ deepLink, expiresAt: AT, code: "x" })).toBeNull();

    expect(decodeTelegramAdminUserLink({ state: "linked", telegramUsername: "alex_user", displayName: "Alex", linkedAt: AT, lastSeenAt: AT }))
      .not.toBeNull();
    expect(decodeTelegramAdminUserLink({ state: "linked", displayName: "x".repeat(129) })).toBeNull();
    expect(decodeTelegramAdminUserLink({ state: "linked", telegramChatId: 1 })).toBeNull();
  });

  it("keeps callback data within Telegram's 64 bytes", () => {
    expect(TELEGRAM_CALLBACK_DATA_PATTERN.test(`c:${"A".repeat(22)}`)).toBe(true);
    expect(TELEGRAM_CALLBACK_DATA_PATTERN.test(`c:${"A".repeat(23)}`)).toBe(false);
    expect(TELEGRAM_CALLBACK_DATA_PATTERN.test("approve:42")).toBe(false);
    expect(new Set(TELEGRAM_REASON_CODES).size).toBe(TELEGRAM_REASON_CODES.length);
  });
});
