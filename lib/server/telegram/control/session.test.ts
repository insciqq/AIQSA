import { describe, expect, it, vi } from "vitest";
import type { TelegramBotApi } from "../botApi";
import type { TelegramOutbound } from "../outbound";
import { createTelegramSessionProvider } from "./session";
import type { TelegramEffectiveControl } from "./state";

function control(generation: number, enabled = true): TelegramEffectiveControl {
  return {
    bot: { generation, id: 100000001, token: `100000001:AAFakeTelegramBotTokenForTests_000000${generation}`, username: "aiqsa_test_bot" },
    enabled, groupIds: new Set(), restricted: false, tokenState: "ready", version: generation
  };
}

describe("Telegram bot session", () => {
  it("keeps one client and outbound per token generation and none while the bot is off", async () => {
    let current = control(1);
    const createApi = vi.fn((token: string) => ({ token }) as unknown as TelegramBotApi);
    const createOutbound = vi.fn(() => ({}) as TelegramOutbound);
    const sessions = createTelegramSessionProvider({ control: async () => current, createApi, createOutbound });
    const first = await sessions.current();
    expect(first).toMatchObject({ botId: 100000001, botUsername: "aiqsa_test_bot", generation: 1 });
    expect(await sessions.current()).toBe(first);
    current = control(2);
    const second = await sessions.current();
    expect(second).not.toBe(first);
    expect(second?.generation).toBe(2);
    expect(createApi).toHaveBeenCalledTimes(2);
    expect(createOutbound).toHaveBeenCalledTimes(2);
    current = control(2, false);
    expect(await sessions.current()).toBeNull();
  });
});
