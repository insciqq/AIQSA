import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DISCORD_LIMIT_DEFAULTS } from "../../../contracts/discord";
import type { DiscordControlRecord } from "./repository";
import { createDiscordControlCache, effectiveDiscordControl, isDiscordBotActive } from "./state";
import { decryptDiscordBotToken, DiscordTokenEnvelopeError, encryptDiscordBotToken } from "./tokenEnvelope";

const TOKEN = "MTAwMDAwMDAwMDAwMDAwMDAx.FAKE00.fake-discord-bot-token-for-tests-0000";

function record(overrides: Partial<DiscordControlRecord> = {}): DiscordControlRecord {
  return {
    applicationId: "1000000000000000002", assistantId: null, botRoleId: null, botUserId: "1000000000000000001", botUsername: "aiqsa-test",
    channelIds: ["1000000000000000010"], channelMode: "only_listed", dmEnabled: false, enabled: true, enabledAt: new Date(), guildId: null,
    guildName: null, identifyAt: [], lastConnectedAt: null, lastEventAt: null, lastFailureAt: null, lastFailureCode: null,
    limits: DISCORD_LIMIT_DEFAULTS, serviceUserId: null, session: null, testAuthorIds: [], testChannelIds: [], tokenEnvelope: null,
    tokenGeneration: 0, version: 1, ...overrides
  };
}

describe("Discord bot token envelope and effective control", () => {
  it("opens a token only under its own key and generation", () => {
    const key = randomBytes(32);
    const envelope = encryptDiscordBotToken({ generation: 3, key, token: TOKEN });
    expect(envelope).not.toContain(TOKEN);
    expect(decryptDiscordBotToken({ envelope, generation: 3, key })).toBe(TOKEN);
    expect(() => decryptDiscordBotToken({ envelope, generation: 4, key })).toThrow(DiscordTokenEnvelopeError);
    expect(() => decryptDiscordBotToken({ envelope, generation: 3, key: randomBytes(32) })).toThrow(DiscordTokenEnvelopeError);
    expect(() => encryptDiscordBotToken({ generation: 1, key, token: "Bot not-a-token" })).toThrow(DiscordTokenEnvelopeError);
  });

  it("is active only with a readable token while on, and resumes only a session of the current token", () => {
    const key = randomBytes(32);
    expect(effectiveDiscordControl(record(), () => key)).toMatchObject({ bot: null, tokenState: "missing" });
    const stored = record({ tokenEnvelope: encryptDiscordBotToken({ generation: 2, key, token: TOKEN }), tokenGeneration: 2 });
    const session = { resumeGatewayUrl: "wss://gateway-test.discord.gg/?v=10&encoding=json", seq: 7, sessionId: "abc" };
    const current = effectiveDiscordControl({ ...stored, session: { ...session, generation: 2 } }, () => key);
    expect(isDiscordBotActive(current)).toBe(true);
    expect(current).toMatchObject({ bot: { generation: 2, token: TOKEN, userId: "1000000000000000001" }, session, tokenState: "ready" });
    expect(current.channelIds.has("1000000000000000010")).toBe(true);
    expect(effectiveDiscordControl({ ...stored, session: { ...session, generation: 1 } }, () => key).session).toBeNull();
    const unreadable = effectiveDiscordControl(stored, () => randomBytes(32));
    expect(unreadable).toMatchObject({ bot: null, tokenState: "unreadable" });
    expect(isDiscordBotActive(unreadable)).toBe(false);
    expect(isDiscordBotActive(effectiveDiscordControl({ ...stored, enabled: false }, () => key))).toBe(false);
  });

  it("serves one snapshot for 30 seconds, drops it on invalidate and never keeps a failed load", async () => {
    let at = 0;
    const load = vi.fn(async () => effectiveDiscordControl(record(), () => randomBytes(32)));
    const cache = createDiscordControlCache({ load, now: () => at });
    await cache.get();
    at = 29_999;
    await cache.get();
    expect(load).toHaveBeenCalledTimes(1);
    cache.invalidate();
    await cache.get();
    expect(load).toHaveBeenCalledTimes(2);
    load.mockRejectedValueOnce(new Error("db"));
    at = 60_000;
    await expect(cache.get()).rejects.toThrow("db");
    await cache.get();
    expect(load).toHaveBeenCalledTimes(4);
  });
});
