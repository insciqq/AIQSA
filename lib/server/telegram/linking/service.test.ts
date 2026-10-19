import { describe, expect, it, vi } from "vitest";
import { decodeTelegramLinkCodeResponse } from "../../../contracts/telegram";
import { hashToken } from "../../auth/token";
import type { TelegramAccessResolver } from "../control/access";
import type { TelegramEffectiveControl } from "../control/state";
import type { TelegramLinkRecord } from "../store/links";
import type { TelegramLinkingRepository, TelegramLinkOutcome } from "./repository";
import { createTelegramLinkingService, telegramLinkCodeRateLimitKey } from "./service";

const USER = "22222222-2222-4222-8222-222222222222";
const SESSION = "33333333-3333-4333-8333-333333333333";
const CODE = "A".repeat(43);
const NOW = new Date("2026-10-19T08:00:00.000Z");
const TARGET = { botId: 100000001, displayName: "Alex", telegramChatId: 200000001, telegramUserId: 200000001, telegramUsername: "alex_example" };

function control(enabled = true): TelegramEffectiveControl {
  return {
    bot: { generation: 1, id: 100000001, token: "100000001:AAFakeTelegramBotTokenForTests_0000000", username: "aiqsa_test_bot" },
    enabled, groupIds: new Set(), restricted: false, tokenState: "ready", version: 1
  };
}

function setup(options: Readonly<{
  enabled?: boolean; allowed?: boolean; limited?: boolean; outcome?: TelegramLinkOutcome; userExists?: boolean;
}> = {}) {
  const repository: TelegramLinkingRepository = {
    consumeCodeAndLink: vi.fn(async () => options.outcome ?? { code: "telegram_link_code_invalid", kind: "refused" } as const),
    createCode: vi.fn(async () => {}),
    unlink: vi.fn(async () => ({ botId: 100000001, telegramChatId: 200000001 })),
    unlinkLink: vi.fn(async () => ({ botId: 100000001, telegramChatId: 200000001 }))
  };
  const access: TelegramAccessResolver = {
    adminUserLink: vi.fn(async () => options.userExists === false ? null : { state: "not_linked" } as const),
    isUserAllowed: vi.fn(async () => options.allowed ?? true),
    resolveTelegramAccess: vi.fn(),
    userStatus: vi.fn(async () => ({ available: true, state: "not_linked" }) as const)
  };
  const check = vi.fn(async () => options.limited ? { allowed: false, retryAfterSeconds: 42.2 } : { allowed: true, retryAfterSeconds: 0 });
  const notifyDisconnected = vi.fn(async () => {});
  const service = createTelegramLinkingService({
    access, control: async () => control(options.enabled ?? true), newCode: () => CODE, notifyDisconnected, now: () => NOW,
    rateLimiter: { check }, repository
  });
  return { access, check, notifyDisconnected, repository, service };
}

describe("Telegram link codes", () => {
  it("returns a deep link with a one-time code, stores only its hash bound to the session and bot, and expires in 10 minutes", async () => {
    const { check, repository, service } = setup();
    const result = await service.createLinkCode({ sessionId: SESSION, userId: USER });
    expect(result).toEqual({
      ok: true,
      value: { deepLink: `https://t.me/aiqsa_test_bot?start=${CODE}`, expiresAt: "2026-10-19T08:10:00.000Z" }
    });
    expect(decodeTelegramLinkCodeResponse(result.ok ? result.value : null)).not.toBeNull();
    expect(check).toHaveBeenCalledWith(telegramLinkCodeRateLimitKey(USER), { maxAttempts: 5 });
    expect(repository.createCode).toHaveBeenCalledWith({
      authSessionId: SESSION, botId: 100000001, codeHash: hashToken(CODE), expiresAt: new Date("2026-10-19T08:10:00.000Z"), now: NOW, userId: USER
    });
    expect(JSON.stringify(vi.mocked(repository.createCode).mock.calls)).not.toContain(CODE);
  });

  it("refuses while the bot is off or closed to the user, and after five codes in ten minutes", async () => {
    for (const options of [{ enabled: false }, { allowed: false }]) {
      const { repository, service } = setup(options);
      await expect(service.createLinkCode({ sessionId: SESSION, userId: USER })).resolves.toEqual({ code: "telegram_access_off", ok: false });
      expect(repository.createCode).not.toHaveBeenCalled();
    }
    const { repository, service } = setup({ limited: true });
    await expect(service.createLinkCode({ sessionId: SESSION, userId: USER }))
      .resolves.toEqual({ code: "telegram_link_code_rate_limited", ok: false, retryAfterSeconds: 43 });
    expect(repository.createCode).not.toHaveBeenCalled();
  });
});

describe("Telegram /start linking", () => {
  it("refuses a malformed code without touching the database", async () => {
    const { repository, service } = setup();
    for (const code of ["short", `${CODE}A`, "A".repeat(42) + "!"]) {
      await expect(service.linkFromStart({ code, target: TARGET })).resolves.toEqual({ code: "telegram_link_code_invalid", kind: "refused" });
    }
    expect(repository.consumeCodeAndLink).not.toHaveBeenCalled();
  });

  it("consumes the code by its hash and tells the replaced Telegram chat it was disconnected", async () => {
    const link = { id: "link-2", userId: USER } as TelegramLinkRecord;
    const { notifyDisconnected, repository, service } = setup({
      outcome: { accountName: "Alex", kind: "linked", link, replaced: { botId: 100000001, telegramChatId: 300000003 } }
    });
    await expect(service.linkFromStart({ code: CODE, target: TARGET })).resolves.toMatchObject({ kind: "linked", link: { id: "link-2" } });
    expect(repository.consumeCodeAndLink).toHaveBeenCalledWith(expect.objectContaining({ codeHash: hashToken(CODE), now: NOW, target: TARGET }));
    expect(notifyDisconnected).toHaveBeenCalledWith({ botId: 100000001, telegramChatId: 300000003 });
  });

  it("passes refusals through and never notifies the chat that just linked", async () => {
    const refused = setup({ outcome: { code: "telegram_account_in_use", kind: "refused" } });
    await expect(refused.service.linkFromStart({ code: CODE, target: TARGET })).resolves.toEqual({ code: "telegram_account_in_use", kind: "refused" });
    expect(refused.notifyDisconnected).not.toHaveBeenCalled();
    const same = setup({
      outcome: { accountName: "Alex", kind: "linked", link: { id: "link-3" } as TelegramLinkRecord, replaced: { botId: 7, telegramChatId: 200000001 } }
    });
    await same.service.linkFromStart({ code: CODE, target: TARGET });
    expect(same.notifyDisconnected).not.toHaveBeenCalled();
  });
});

describe("Telegram unlinking", () => {
  it("removes the user's link, tells its chat, and returns the new status", async () => {
    const { access, notifyDisconnected, repository, service } = setup();
    await expect(service.unlink(USER)).resolves.toEqual({ available: true, state: "not_linked" });
    expect(repository.unlink).toHaveBeenCalledWith(USER);
    expect(notifyDisconnected).toHaveBeenCalledWith({ botId: 100000001, telegramChatId: 200000001 });
    expect(access.userStatus).toHaveBeenCalledWith(USER);
  });

  it("lets an administrator unlink an existing account and answers null for an unknown one", async () => {
    const known = setup();
    await expect(known.service.adminUnlink(USER)).resolves.toEqual({ state: "not_linked" });
    expect(known.repository.unlink).toHaveBeenCalledWith(USER);
    const unknown = setup({ userExists: false });
    await expect(unknown.service.adminUnlink(USER)).resolves.toBeNull();
    expect(unknown.repository.unlink).not.toHaveBeenCalled();
  });

  it("removes only the link a bot button was made for", async () => {
    const { repository, service } = setup();
    await expect(service.unlinkFromBot({ linkId: "link-1", userId: USER })).resolves.toBe(true);
    expect(repository.unlinkLink).toHaveBeenCalledWith({ linkId: "link-1", userId: USER });
  });
});
