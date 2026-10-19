import { describe, expect, it, vi } from "vitest";
import { TELEGRAM_CALLBACK_DATA_PATTERN } from "../../../contracts/telegram";
import {
  createPrismaTelegramCallbackStore, newTelegramCallbackId, normalizeTelegramCallbackPayload, TelegramCallbackPayloadError
} from "./callbacks";

const NOW = new Date("2026-10-19T08:00:00.000Z");
const LINK = { botId: 100000001n, telegramChatId: 200000001n, telegramUserId: 200000001n, userId: "user-1" };

function row(overrides: Record<string, unknown> = {}) {
  return {
    consumedAt: null, createdAt: NOW, expiresAt: new Date(NOW.getTime() + 60_000), id: "A".repeat(22), kind: "select_chat", link: LINK,
    linkId: "link-1", payload: { chatId: "chat-1" }, ...overrides
  };
}

function store(found: unknown) {
  const delegate = {
    createMany: vi.fn(async () => ({ count: 1 })),
    findUnique: vi.fn(async () => found),
    updateMany: vi.fn(async () => ({ count: 1 }))
  };
  return { delegate, store: createPrismaTelegramCallbackStore({ telegramCallback: delegate } as never, { newId: () => "C".repeat(22) }) };
}

const press = { botId: 100000001, data: `c:${"A".repeat(22)}`, now: NOW, telegramChatId: 200000001, telegramUserId: 200000001 };

describe("Telegram button rows", () => {
  it("names each button by 128 random bits that fit Telegram's callback data", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newTelegramCallbackId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(`c:${id}`).toMatch(TELEGRAM_CALLBACK_DATA_PATTERN);
  });

  it("stores identifiers-only payloads with a bounded lifetime", async () => {
    const { delegate, store: callbacks } = store(null);
    const data = await callbacks.create({
      buttons: [{ kind: "select_chat", payload: { chatId: "chat-1" } }, { kind: "toggle_search", ttlMs: 30 * 24 * 3_600_000 }],
      linkId: "link-1", now: NOW
    });
    expect(data).toEqual([`c:${"C".repeat(22)}`, `c:${"C".repeat(22)}`]);
    expect(delegate.createMany).toHaveBeenCalledWith({
      data: [
        { createdAt: NOW, expiresAt: new Date(NOW.getTime() + 24 * 3_600_000), id: "C".repeat(22), kind: "select_chat", linkId: "link-1", payload: { chatId: "chat-1" } },
        { createdAt: NOW, expiresAt: new Date(NOW.getTime() + 7 * 24 * 3_600_000), id: "C".repeat(22), kind: "toggle_search", linkId: "link-1", payload: {} }
      ]
    });
    for (const payload of [{ text: "x".repeat(257) }, { "bad key": 1 }, { nested: { a: 1 } }, { amount: 1.5 },
      Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`k${index}`, index]))]) {
      expect(() => normalizeTelegramCallbackPayload(payload as never)).toThrow(TelegramCallbackPayloadError);
    }
  });

  it("resolves a press only from the link's own bot, account and chat, before expiry and first use", async () => {
    await expect(store(row()).store.resolve(press)).resolves.toEqual({
      callback: { expiresAt: row().expiresAt, id: "A".repeat(22), kind: "select_chat", linkId: "link-1", payload: { chatId: "chat-1" }, userId: "user-1" },
      ok: true
    });
    const forged = store(row());
    for (const data of [undefined, "approve:42", `c:${"A".repeat(21)}`, `c:${"A".repeat(21)}!`]) {
      await expect(forged.store.resolve({ ...press, data })).resolves.toEqual({ ok: false, reason: "invalid" });
    }
    expect(forged.delegate.findUnique).not.toHaveBeenCalled();
    await expect(store(null).store.resolve(press)).resolves.toEqual({ ok: false, reason: "unknown" });
    for (const change of [{ botId: 5 }, { telegramUserId: 300000003 }, { telegramChatId: 300000003 }]) {
      await expect(store(row()).store.resolve({ ...press, ...change })).resolves.toEqual({ ok: false, reason: "foreign" });
    }
    await expect(store(row({ expiresAt: NOW })).store.resolve(press)).resolves.toEqual({ ok: false, reason: "expired" });
    await expect(store(row({ consumedAt: NOW })).store.resolve(press)).resolves.toEqual({ ok: false, reason: "consumed" });
  });

  it("consumes a single-use button with one conditional update", async () => {
    const { delegate, store: callbacks } = store(null);
    await expect(callbacks.consume({ id: "A".repeat(22), now: NOW })).resolves.toBe(true);
    expect(delegate.updateMany).toHaveBeenCalledWith({
      data: { consumedAt: NOW }, where: { consumedAt: null, expiresAt: { gt: NOW }, id: "A".repeat(22) }
    });
    delegate.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(callbacks.consume({ id: "A".repeat(22), now: NOW })).resolves.toBe(false);
  });
});
