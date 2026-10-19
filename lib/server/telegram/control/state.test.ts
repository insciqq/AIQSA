import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TelegramControlRecord } from "./repository";
import { createTelegramControlCache, effectiveTelegramControl, isTelegramBotActive } from "./state";
import { encryptTelegramBotToken } from "./tokenEnvelope";

const TOKEN = "123456789:AAFakeTokenForTelegramEnvelopeTests_000";
const key = randomBytes(32);

function record(overrides: Partial<TelegramControlRecord> = {}): TelegramControlRecord {
  return {
    botId: null, botUsername: null, enabled: false, groupIds: [], lastFailureAt: null, lastFailureCode: null, lastPollAt: null,
    lastSuccessAt: null, restricted: false, tokenEnvelope: null, tokenGeneration: 0, version: 1, ...overrides
  };
}

function withToken(overrides: Partial<TelegramControlRecord> = {}): TelegramControlRecord {
  return record({
    botId: 123456789, botUsername: "aiqsa_test_bot", tokenEnvelope: encryptTelegramBotToken({ generation: 2, key, token: TOKEN }),
    tokenGeneration: 2, ...overrides
  });
}

describe("effective Telegram control", () => {
  it("is active only while switched on with a readable token", () => {
    expect(effectiveTelegramControl(record(), () => key)).toMatchObject({ bot: null, tokenState: "missing" });
    const off = effectiveTelegramControl(withToken(), () => key);
    expect(off).toMatchObject({ bot: { generation: 2, id: 123456789, token: TOKEN, username: "aiqsa_test_bot" }, tokenState: "ready" });
    expect(isTelegramBotActive(off)).toBe(false);
    expect(isTelegramBotActive(effectiveTelegramControl(withToken({ enabled: true }), () => key))).toBe(true);
    const unreadable = effectiveTelegramControl(withToken({ enabled: true }), () => randomBytes(32));
    expect(unreadable).toMatchObject({ bot: null, tokenState: "unreadable" });
    expect(isTelegramBotActive(unreadable)).toBe(false);
    const missingKey = effectiveTelegramControl(withToken({ enabled: true }), () => { throw new Error("no key"); });
    expect(missingKey.tokenState).toBe("unreadable");
    expect([...effectiveTelegramControl(record({ groupIds: ["g1", "g2"], restricted: true }), () => key).groupIds]).toEqual(["g1", "g2"]);
  });
});

describe("Telegram control cache", () => {
  it("serves one snapshot until a write invalidates it or the TTL ends, and never caches a failed load", async () => {
    let time = 0;
    let loads = 0;
    const load = vi.fn(async () => {
      loads += 1;
      if (loads === 3) throw new Error("database unavailable");
      return effectiveTelegramControl(record({ version: loads }), () => key);
    });
    const cache = createTelegramControlCache({ load, now: () => time, ttlMs: 1_000 });
    expect((await cache.get()).version).toBe(1);
    expect((await cache.get()).version).toBe(1);
    cache.invalidate();
    expect((await cache.get()).version).toBe(2);
    time = 1_000;
    await expect(cache.get()).rejects.toThrow("database unavailable");
    expect((await cache.get()).version).toBe(4);
    expect(load).toHaveBeenCalledTimes(4);
  });
});
