import { describe, expect, it } from "vitest";
import {
  DISCORD_LIMIT_DEFAULTS,
  DISCORD_SETUP_CHECK_CODES,
  discordAdminStateSchema,
  type DiscordAdminState,
  type DiscordSetupItem
} from "@/lib/contracts/discord";
import {
  discordBotStatus,
  discordChannelGroups,
  discordChannelsDirty,
  discordLimitsDirty,
  discordLimitsDraft,
  discordSetupItemView,
  discordTokenError,
  formatDiscordLatency,
  orderedSetupItems,
  parseDiscordIds,
  parseDiscordLimits
} from "./discordAdminView";

const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function state(overrides: Partial<DiscordAdminState> = {}): DiscordAdminState {
  return discordAdminStateSchema.parse({
    assistant: null,
    bot: { applicationId: "100000000000000001", userId: "100000000000000002", username: "fixture_bot" },
    channelMode: "only_listed",
    channels: [],
    dmEnabled: false,
    enabled: true,
    guild: { id: "100000000000000010", name: "Fixture server" },
    health: { connected: true, lastConnectedAt: ago(60_000), lastEventAt: ago(5_000), lastFailureAt: null, lastFailureCode: null },
    limits: DISCORD_LIMIT_DEFAULTS,
    serviceAccount: { status: "active", userId: "svc_fixture" },
    setup: { items: DISCORD_SETUP_CHECK_CODES.map((code) => ({ action: null, code, status: "ok" })), ready: true },
    testAuthorIds: [],
    testChannelIds: [],
    tokenConfigured: true,
    version: 3,
    ...overrides
  });
}

describe("discordBotStatus", () => {
  it("reads Connected with the age of the last event", () => {
    expect(discordBotStatus(state(), NOW)).toEqual({ action: null, detail: "Last event 5 s ago", label: "Connected", tone: "ok" });
  });

  it("names the disconnect reason, its age and the token action for a rejected token", () => {
    const status = discordBotStatus(state({
      health: { connected: false, lastConnectedAt: null, lastEventAt: null, lastFailureAt: ago(180_000), lastFailureCode: "discord_token_rejected" }
    }), NOW);
    expect(status).toMatchObject({ action: "enter_token", label: "Disconnected", tone: "critical" });
    expect(status.detail).toBe("Discord rejected the bot token. Reset the token in the Discord Developer Portal and use Test & Save. Since 3 min ago.");
  });

  it("keeps the session-limit wait without an action and falls back to a plain disconnect", () => {
    expect(discordBotStatus(state({
      health: { connected: false, lastConnectedAt: null, lastEventAt: null, lastFailureAt: ago(1_000), lastFailureCode: "discord_session_limit" }
    }), NOW).action).toBeNull();
    expect(discordBotStatus(state({
      health: { connected: false, lastConnectedAt: null, lastEventAt: null, lastFailureAt: null, lastFailureCode: null }
    }), NOW).detail).toBe("AIQSA lost its connection to Discord and is reconnecting.");
  });

  it("separates not set up, off and a broken setup on a connected bot", () => {
    expect(discordBotStatus(state({ bot: null, enabled: false, tokenConfigured: false }), NOW)).toMatchObject({ action: "enter_token", label: "Not set up" });
    expect(discordBotStatus(state({ enabled: false }), NOW)).toMatchObject({ action: null, label: "Off" });
    const broken = { items: [{ action: "open_assistant", code: "discord_search_disabled", status: "blocking" }] as DiscordSetupItem[], ready: false };
    expect(discordBotStatus(state({ enabled: false, setup: broken }), NOW)).toMatchObject({ action: "review_setup", label: "Off" });
    expect(discordBotStatus(state({ setup: broken }), NOW)).toMatchObject({ action: "review_setup", label: "Attention", tone: "warning" });
  });
});

describe("setup items", () => {
  it("orders blockers, then warnings, then passed items and offers an action only for problems", () => {
    const items: DiscordSetupItem[] = [
      { action: null, code: "discord_token_missing", status: "ok" },
      { action: "open_provider_keys", code: "discord_shared_key", status: "warning" },
      { action: "select_guild", code: "discord_guild_missing", status: "blocking" }
    ];
    expect(orderedSetupItems(items).map((item) => item.code)).toEqual(["discord_guild_missing", "discord_shared_key", "discord_token_missing"]);
    expect(discordSetupItemView(items[1]!)).toEqual({
      actionLabel: "Open Providers",
      reason: "Discord runs use the shared key. Assign the service account or its group its own key on the provider connection.",
      title: "Model key"
    });
    expect(discordSetupItemView({ action: "enter_token", code: "discord_token_missing", status: "ok" }).actionLabel).toBeNull();
  });

  it("has a title and both texts for every setup code", () => {
    for (const code of DISCORD_SETUP_CHECK_CODES) {
      const ok = discordSetupItemView({ action: null, code, status: "ok" });
      const blocking = discordSetupItemView({ action: null, code, status: "blocking" });
      expect(ok.title).not.toBe("");
      expect(ok.reason).not.toBe(blocking.reason);
    }
  });
});

describe("drafts", () => {
  it("checks the token shape locally", () => {
    expect(discordTokenError(" ")).toBe("Paste the bot token from the Discord Developer Portal.");
    expect(discordTokenError("123:abc")).toMatch(/^This is not a bot token/u);
    expect(discordTokenError("MTAwMDAwMDAwMDAwMDAwMDAx.GaBcDe.abcdefghijklmnopqrstuvwxyz0123")).toBeNull();
  });

  it("parses limits within the contract's bounds and keeps the daily limit above the hourly one", () => {
    const draft = discordLimitsDraft(DISCORD_LIMIT_DEFAULTS);
    expect(parseDiscordLimits(draft)).toEqual({ limits: DISCORD_LIMIT_DEFAULTS, ok: true });
    expect(parseDiscordLimits({ ...draft, perAuthorHourly: "1.5" })).toMatchObject({ field: "perAuthorHourly", ok: false });
    expect(parseDiscordLimits({ ...draft, parallelThreads: "65" })).toEqual({ field: "parallelThreads", message: "Enter a number from 1 to 64.", ok: false });
    expect(parseDiscordLimits({ ...draft, perThreadHourly: "0" })).toMatchObject({ field: "perThreadHourly", ok: false });
    expect(parseDiscordLimits({ ...draft, perAuthorDaily: "5" })).toMatchObject({ field: "perAuthorDaily", ok: false });
    expect(discordLimitsDirty({ ...draft, perAuthorHourly: " 20 " }, DISCORD_LIMIT_DEFAULTS)).toBe(false);
    expect(discordLimitsDirty({ ...draft, perAuthorHourly: "21" }, DISCORD_LIMIT_DEFAULTS)).toBe(true);
  });

  it("parses test ids by line, comma or space, collapses duplicates and enforces ten", () => {
    expect(parseDiscordIds("1, 2\n2 3")).toEqual({ ids: ["1", "2", "3"], ok: true });
    expect(parseDiscordIds("")).toEqual({ ids: [], ok: true });
    expect(parseDiscordIds("12a")).toMatchObject({ ok: false });
    expect(parseDiscordIds(Array.from({ length: 11 }, (_, index) => String(index + 1)).join(","))).toEqual({ message: "Enter at most 10 ids.", ok: false });
  });

  it("compares channel drafts by mode and set", () => {
    const stored = state({ channelMode: "only_listed", channels: [{ id: "1", name: "a" }, { id: "2", name: null }] });
    expect(discordChannelsDirty({ channelIds: ["2", "1"], mode: "only_listed" }, stored)).toBe(false);
    expect(discordChannelsDirty({ channelIds: ["1", "2"], mode: "all_except" }, stored)).toBe(true);
    expect(discordChannelsDirty({ channelIds: ["1"], mode: "only_listed" }, stored)).toBe(true);
  });
});

describe("discordChannelGroups", () => {
  const options = [
    { id: "10", kind: "category" as const, name: "Text", parentId: null },
    { id: "11", kind: "text" as const, name: "general", parentId: "10" },
    { id: "12", kind: "forum" as const, name: "questions", parentId: "10" },
    { id: "20", kind: "text" as const, name: "welcome", parentId: null }
  ];

  it("puts uncategorized channels first, groups the rest under their category and drops categories as choices", () => {
    expect(discordChannelGroups(options, "")).toEqual([
      { channels: [{ id: "20", kind: "text", name: "welcome" }], id: null, name: null },
      { channels: [{ id: "11", kind: "text", name: "general" }, { id: "12", kind: "forum", name: "questions" }], id: "10", name: "Text" }
    ]);
  });

  it("filters by name, ignoring a leading #", () => {
    expect(discordChannelGroups(options, "#QUEST").flatMap((group) => group.channels.map((channel) => channel.id))).toEqual(["12"]);
  });
});

describe("formatDiscordLatency", () => {
  it("formats milliseconds, seconds and minutes", () => {
    expect(formatDiscordLatency(null)).toBe("—");
    expect(formatDiscordLatency(850)).toBe("850 ms");
    expect(formatDiscordLatency(8_400)).toBe("8.4 s");
    expect(formatDiscordLatency(41_000)).toBe("41 s");
    expect(formatDiscordLatency(125_000)).toBe("2 min 5 s");
  });
});
