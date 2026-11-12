import { describe, expect, it } from "vitest";
import { discordLimitExceeded, type DiscordLimitUsage } from "./limits";

const freesAt = new Date("2026-11-12T10:00:00.000Z");
const open = (limit: number) => ({ count: 0, freesAt: null, limit });

describe("Discord author and thread limits", () => {
  it("names the first window a question would exceed: author hour, author day, then thread hour", () => {
    const usage: DiscordLimitUsage = { authorDay: open(100), authorHour: open(20), threadHour: open(60) };
    expect(discordLimitExceeded(usage)).toBeNull();
    expect(discordLimitExceeded({ ...usage, threadHour: { count: 60, freesAt, limit: 60 } }))
      .toEqual({ freesAt, kind: "thread", limit: 60, window: "hour" });
    expect(discordLimitExceeded({ ...usage, authorDay: { count: 100, freesAt, limit: 100 }, threadHour: { count: 60, freesAt, limit: 60 } }))
      .toEqual({ freesAt, kind: "author", limit: 100, window: "day" });
    expect(discordLimitExceeded({ ...usage, authorDay: { count: 100, freesAt, limit: 100 }, authorHour: { count: 20, freesAt, limit: 20 } }))
      .toEqual({ freesAt, kind: "author", limit: 20, window: "hour" });
    // A question with no conversation yet starts its thread at zero.
    expect(discordLimitExceeded({ ...usage, threadHour: null })).toBeNull();
  });
});
