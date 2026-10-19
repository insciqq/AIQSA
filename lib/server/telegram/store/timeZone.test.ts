import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaTelegramTimeZoneStore, pickClientTimeZone, TELEGRAM_TIME_ZONE_RUN_WINDOW } from "./timeZone";

describe("Telegram run time zone", () => {
  it("takes the newest zone the browser reported, skipping fallbacks, zones the runtime cannot resolve and foreign shapes", () => {
    expect(pickClientTimeZone([
      null,
      "Europe/Moscow",
      { source: "standard_chat", timeZone: "UTC", timeZoneSource: "utc_fallback" },
      { source: "standard_chat", timeZone: "Mars/Olympus", timeZoneSource: "client" },
      { source: "standard_chat", timeZone: "Europe/Moscow; DROP", timeZoneSource: "client" },
      { source: "assistant_chat", timeZone: "Asia/Tokyo", timeZoneSource: "client" },
      { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" }
    ])).toBe("Asia/Tokyo");
    expect(pickClientTimeZone([{ timeZone: "UTC", timeZoneSource: "utc_fallback" }, undefined])).toBeNull();
    expect(pickClientTimeZone([])).toBeNull();
  });

  it("reads one bounded, owner-scoped page of the user's newest non-scheduled runs", async () => {
    const queryRaw = vi.fn(async () => [
      { baseline: { source: "standard_chat", timeZone: "UTC", timeZoneSource: "utc_fallback" } },
      { baseline: null },
      { baseline: { source: "standard_chat", timeZone: "America/New_York", timeZoneSource: "client" } }
    ]);
    const store = createPrismaTelegramTimeZoneStore({ $queryRaw: queryRaw } as unknown as Pick<PrismaClient, "$queryRaw">);
    await expect(store.latestClientTimeZone("user-1")).resolves.toBe("America/New_York");
    const [query] = queryRaw.mock.calls[0] as unknown as [{ sql: string; values: unknown[] }];
    expect(query.sql).toContain(`"userId" = ? AND "scheduledTaskId" IS NULL`);
    expect(query.sql).toContain(`ORDER BY "createdAt" DESC`);
    expect(query.values).toEqual(["user-1", TELEGRAM_TIME_ZONE_RUN_WINDOW]);
  });
});
