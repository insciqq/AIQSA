import { describe, expect, it } from "vitest";
import {
  decodeDiscordAdminActivity, decodeDiscordAdminCommand, decodeDiscordAdminState, decodeDiscordMonitoringKeyCreated,
  decodeDiscordMonitoringTelemetry, DISCORD_GATEWAY_INTENTS, DISCORD_HEALTH_CODES, DISCORD_REASON_CODES,
  DISCORD_SETUP_CHECK_CODES, discordMessageLink, discordSnowflakeSchema, type DiscordActivityStats, type DiscordAdminActivity,
  type DiscordAdminState
} from "./discord";

const NOW = "2026-11-12T10:00:00.000Z";
const stats: DiscordActivityStats = {
  requests: 3, delivered: 2, failed: 1, interrupted: 0, failuresByCode: [{ code: "discord_busy", count: 1 }],
  latency: { p50Ms: 4000, p95Ms: null }, limitHits: { author: 0, thread: 0, key: 0 }, notFound: 0, ratingsUp: 1, ratingsDown: 0
};
const state: DiscordAdminState = {
  enabled: true,
  tokenConfigured: true,
  bot: { userId: "100000000000000001", username: "AIQSA Test", applicationId: "100000000000000002" },
  guild: { id: "200000000000000001", name: "Example server" },
  channelMode: "only_listed",
  channels: [{ id: "300000000000000001", name: "agent-test" }, { id: "300000000000000002", name: null }],
  dmEnabled: false,
  testAuthorIds: ["400000000000000009"],
  testChannelIds: ["300000000000000001"],
  serviceAccount: { status: "active", userId: "user_1" },
  assistant: { id: "assistant_1", name: "Discord agent" },
  limits: { perAuthorHourly: 20, perAuthorDaily: 100, perThreadHourly: 60, parallelThreads: 16 },
  health: { connected: true, lastConnectedAt: NOW, lastEventAt: NOW, lastFailureAt: null, lastFailureCode: null },
  setup: { ready: true, items: [{ code: "discord_shared_key", status: "warning", action: "open_provider_keys" }] },
  version: 3
};
const activity: DiscordAdminActivity = {
  last24h: stats, last7d: stats,
  rows: [{
    questionMessageId: "500000000000000001", receivedAt: NOW, guildId: "200000000000000001", channelId: "300000000000000001",
    channelName: "agent-test", authorId: "400000000000000001", authorName: "Alice", kind: "answer", state: "delivered",
    code: null, latencyMs: 5200, messageLink: discordMessageLink("200000000000000001", "300000000000000001", "500000000000000001"),
    test: false
  }]
};
const monitoringKey = { id: "key_1", createdAt: NOW, lastUsedAt: null, revokedAt: null };

describe("Discord contract", () => {
  it("names the six gateway intents of the spec", () => {
    expect(DISCORD_GATEWAY_INTENTS).toBe(46593);
  });

  it("keeps the reason codes sorted, unique and covering health and setup codes", () => {
    expect([...DISCORD_REASON_CODES].sort()).toEqual([...DISCORD_REASON_CODES]);
    expect(new Set(DISCORD_REASON_CODES).size).toBe(DISCORD_REASON_CODES.length);
    for (const code of [...DISCORD_HEALTH_CODES, ...DISCORD_SETUP_CHECK_CODES]) expect(DISCORD_REASON_CODES).toContain(code);
  });

  it("accepts snowflakes of 1–20 digits only", () => {
    for (const id of ["1", "12345678901234567890"]) expect(discordSnowflakeSchema.safeParse(id).success).toBe(true);
    for (const id of ["", "123456789012345678901", "12a", " 1", "-1", 1]) expect(discordSnowflakeSchema.safeParse(id).success).toBe(false);
  });

  it("decodes a full admin state and rejects unknown keys and oversized values", () => {
    expect(decodeDiscordAdminState(state)).toEqual(state);
    expect(decodeDiscordAdminState({ ...state, token: "PRIVATE" })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, health: { ...state.health, extra: 1 } })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, testAuthorIds: Array.from({ length: 11 }, (_, index) => String(index + 1)) })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, testChannelIds: ["1", "1"] })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, channels: Array.from({ length: 201 }, (_, index) => ({ id: String(index + 1), name: null })) })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, guild: { id: "1", name: "x".repeat(101) } })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, limits: { ...state.limits, parallelThreads: 65 } })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, health: { ...state.health, lastFailureCode: "telegram_busy" } })).toBeNull();
    // Monitoring keys and activity have their own routes; the bot state carries neither.
    expect(decodeDiscordAdminState({ ...state, monitoringKeys: [] })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, activity })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, setup: { ready: true, items: [{ code: "discord_no_budget", status: "warning", action: null }] } })).toBeNull();
    expect(decodeDiscordAdminState({ ...state, setup: { ready: true, items: [{ code: "discord_monthly_budget", status: "warning", action: "open_usage_limits" }] } }))
      .not.toBeNull();
  });

  it("decodes the activity listing and refuses oversized or foreign links", () => {
    expect(decodeDiscordAdminActivity(activity)).toEqual(activity);
    expect(decodeDiscordAdminActivity({ ...activity, rows: Array(51).fill(activity.rows[0]) })).toBeNull();
    const row = activity.rows[0]!;
    expect(decodeDiscordAdminActivity({ ...activity, rows: [{ ...row, messageLink: "https://example.com/x" }] })).toBeNull();
  });

  it("decodes every admin command with expectedVersion and refuses malformed ones", () => {
    const commands = [
      { action: "test_and_save", token: `${"A".repeat(24)}.${"b".repeat(6)}.${"c".repeat(27)}`, expectedVersion: 1 },
      { action: "set_guild", guildId: "200000000000000001", expectedVersion: 1 },
      { action: "set_channels", channelMode: "all_except", channelIds: ["1", "2"], expectedVersion: 1 },
      { action: "set_direct_messages", dmEnabled: true, expectedVersion: 1 },
      { action: "set_test_access", testAuthorIds: ["9"], testChannelIds: [], expectedVersion: 1 },
      { action: "create_service_account", expectedVersion: 1 },
      { action: "set_assistant", assistantId: "assistant_1", expectedVersion: 1 },
      { action: "set_limits", limits: state.limits, expectedVersion: 1 },
      { action: "enable", expectedVersion: 1 },
      { action: "disable", expectedVersion: 1 }
    ];
    for (const command of commands) expect(decodeDiscordAdminCommand(command), command.action).toEqual(command);
    expect(decodeDiscordAdminCommand({ action: "enable" })).toBeNull();
    expect(decodeDiscordAdminCommand({ action: "enable", expectedVersion: 1, extra: true })).toBeNull();
    expect(decodeDiscordAdminCommand({ action: "test_and_save", token: "Bot abc\r\nX: y", expectedVersion: 1 })).toBeNull();
    expect(decodeDiscordAdminCommand({ action: "set_channels", channelMode: "all", channelIds: [], expectedVersion: 1 })).toBeNull();
    expect(decodeDiscordAdminCommand({ action: "register_commands", expectedVersion: 1 })).toBeNull();
    // Monitoring keys change only through their own route.
    expect(decodeDiscordAdminCommand({ action: "create_monitoring_key", expectedVersion: 1 })).toBeNull();
  });

  it("carries a monitoring secret only in the create response", () => {
    const created = { key: monitoringKey, secret: `aiqsa_dmk_${"a".repeat(43)}` };
    expect(decodeDiscordMonitoringKeyCreated(created)).toEqual(created);
    expect(decodeDiscordMonitoringKeyCreated({ ...created, secret: "short" })).toBeNull();
  });

  it("decodes monitoring telemetry with problem rows and refuses windows over 31 days", () => {
    const telemetry = {
      since: "2026-11-11T10:00:00.000Z", until: NOW, generatedAt: NOW,
      requests: 10, delivered: 8, failed: 1, interrupted: 1, failuresByCode: [{ code: "discord_busy", count: 1 }],
      limitHits: { author: 1, thread: 0, key: 0 }, notFound: 1, ratingsUp: 2, ratingsDown: 1,
      latency: { acked: { p50Ms: 300, p95Ms: 900 }, admitted: { p50Ms: 1000, p95Ms: 2000 }, firstStatus: { p50Ms: 2000, p95Ms: 3000 }, delivered: { p50Ms: 9000, p95Ms: 30000 } },
      mcpByServer: [{ server: "Tracker", calls: 4, errors: 1 }], compactions: 0, subagents: 2,
      problems: [{
        questionMessageId: "500000000000000002", kind: "rated_down", receivedAt: NOW, guildId: null, channelId: "600000000000000001",
        messageLink: discordMessageLink(null, "600000000000000001", "500000000000000002"), chatId: "chat_1", code: null,
        latencyMs: 1200, limitKind: null, test: false
      }]
    };
    expect(decodeDiscordMonitoringTelemetry(telemetry)).toEqual(telemetry);
    expect(decodeDiscordMonitoringTelemetry({ ...telemetry, since: "2026-10-01T10:00:00.000Z" })).toBeNull();
    expect(decodeDiscordMonitoringTelemetry({ ...telemetry, problems: [{ ...telemetry.problems[0], text: "PRIVATE" }] })).toBeNull();
    expect(decodeDiscordMonitoringTelemetry({ ...telemetry, problems: Array(501).fill(telemetry.problems[0]) })).toBeNull();
  });
});
