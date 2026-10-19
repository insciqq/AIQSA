import { afterEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  findControl: vi.fn(async (): Promise<unknown> => { throw new Error("database unavailable"); })
}));

vi.mock("../prisma", () => ({
  prisma: {
    telegramBotControl: { findUnique: database.findControl },
    telegramBotGroup: { findMany: vi.fn(async () => []) },
    telegramLink: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ groups: [], scimDeactivatedAt: null, status: "active" })) }
  }
}));

import { getDefaultTelegram, isTelegramAvailableForUser, startDefaultTelegram } from "./defaultTelegram";

afterEach(async () => {
  await getDefaultTelegram().poller.stop();
  delete (globalThis as { __aiqsaTelegram?: unknown }).__aiqsaTelegram;
  delete (globalThis as { __aiqsaTelegramStarted?: unknown }).__aiqsaTelegramStarted;
});

describe("default Telegram wiring", () => {
  it("builds one process-wide set of services and hides the settings block when Telegram cannot be read", async () => {
    expect(getDefaultTelegram()).toBe(getDefaultTelegram());
    await expect(isTelegramAvailableForUser("user-1")).resolves.toBe(false);
  });

  it("shows the block to an active user while the bot is on, and stays idle while it is off", async () => {
    database.findControl.mockResolvedValue({
      botId: null, botUsername: null, createdAt: new Date(), enabled: false, id: "installation", lastFailureAt: null, lastFailureCode: null,
      lastPollAt: null, lastSuccessAt: null, restricted: false, tokenEnvelope: null, tokenGeneration: 0, updateOffset: null, updatedAt: new Date(),
      updatedByUserId: null, version: 1
    });
    await expect(isTelegramAvailableForUser("user-1")).resolves.toBe(false);
    startDefaultTelegram();
    startDefaultTelegram();
    await vi.waitFor(() => expect(getDefaultTelegram().poller.state()).toBe("idle"));
  });
});
